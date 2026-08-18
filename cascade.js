/**
 * @fileoverview Bounded, breadth-first cascading delete of an object's descendants.
 *
 * Deleting a persisted object must also remove everything parented beneath it,
 * at any depth. The walk here is deliberately bounded and hands control back to
 * the event loop between batches, so a deep or hostile parent tree cannot turn a
 * single MQTT delete into a denial of service against the persist service.
 *
 * Only the deleted object itself is announced over MQTT, by the caller; clients
 * drop orphaned descendants on their own, so no per-descendant delete is
 * published here.
 *
 * All database work is injected by the caller, which keeps the traversal itself
 * testable without a live MongoDB.
 *
 * Open source software under the terms in /LICENSE
 * Copyright (c) 2026 ARENAXR. All rights reserved.
 */
'use strict';

const {asyncForEach} = require('./utils');

/**
 * Maximum number of descendants a single cascading delete will remove. Entire
 * ARENA scenes are typically well under a thousand objects, so this ceiling is
 * only ever reached by a pathological or hostile parent tree, where it bounds the
 * database work one incoming message can cause.
 */
const MAX_CASCADE_NODES = 10000;

/**
 * Maximum number of levels below the deleted object that will be walked. Real
 * scene graphs nest a handful of levels deep, a few more with nested templates,
 * so this is a generous ceiling that still guarantees termination.
 */
const MAX_CASCADE_DEPTH = 64;

/**
 * Number of descendants deleted per batch. The walk yields to the event loop
 * after every batch, so this trades the number of yields against the size of
 * each uninterrupted unit of work.
 */
const CASCADE_BATCH_SIZE = 100;

/**
 * Yields to the event loop so pending MQTT messages and timers can be serviced.
 * @return {Promise<void>} Promise that settles on a later tick.
 */
const yieldToEventLoop = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * Deletes every descendant of an object, breadth-first, one query per level.
 *
 * The walk starts from an object that has already been deleted itself, collects
 * the ids of its children, deletes them in batches, then repeats with those ids
 * as the next frontier. Ids already seen are never revisited, so cycles in the
 * parent pointers terminate rather than looping.
 *
 * Caps are never fatal: on reaching one the walk stops, logs a warning naming the
 * object, the scene and the cap, and returns what it managed to do. The remaining
 * descendants are left behind as orphans, which is the accepted outcome.
 *
 * @param {Object} target - Identity of the object whose descendants are removed.
 * @param {string} target.objectId - object_id of the already-deleted root object.
 * @param {string} target.namespace - namespace of the root object.
 * @param {string} target.sceneId - sceneId of the root object.
 * @param {Object} handlers - Injected side effects, all scoped to the target scene.
 * @param {function(Array<string>): Promise<Array<string>>} handlers.findChildIds - Resolves
 *     the object_ids of every object whose parent is one of the given ids.
 * @param {function(Array<string>): Promise<void>} handlers.deleteIds - Deletes the given ids.
 * @param {function(string): void} handlers.forget - Drops one id from the in-memory
 *     persists set, so no stale key survives the delete.
 * @param {function(string): void} [handlers.warn] - Warning sink, defaults to console.warn.
 * @param {Object} [limits] - Cap overrides, defaulted from the module constants.
 * @param {number} [limits.maxNodes] - Maximum descendants to process.
 * @param {number} [limits.maxDepth] - Maximum levels to walk.
 * @param {number} [limits.batchSize] - Descendants per batch between event loop yields.
 * @return {Promise<{deleted: Array<string>, levels: number, capped: ?string}>} Ids deleted
 *     in the order they were processed, levels walked, and which cap stopped the walk
 *     ('nodes', 'depth', or null when the whole subtree was removed).
 */
const cascadeDeleteDescendants = async (target, handlers, limits = {}) => {
    const {objectId, namespace, sceneId} = target;
    const {findChildIds, deleteIds, forget, warn = console.warn} = handlers;
    const {
        maxNodes = MAX_CASCADE_NODES,
        maxDepth = MAX_CASCADE_DEPTH,
        batchSize = CASCADE_BATCH_SIZE,
    } = limits;
    const visited = new Set([objectId]); // Also guards an object parented to itself
    const deleted = [];
    let frontier = [objectId];
    let levels = 0;
    let capped = null;
    while (frontier.length) {
        if (levels >= maxDepth) {
            capped = 'depth';
            break;
        }
        const childIds = await findChildIds(frontier);
        levels += 1;
        const nextFrontier = [];
        await asyncForEach(childIds, async (childId) => {
            if (!visited.has(childId)) {
                visited.add(childId);
                nextFrontier.push(childId);
            }
        });
        if (!nextFrontier.length) {
            break;
        }
        let level = nextFrontier;
        if (deleted.length + level.length > maxNodes) {
            level = level.slice(0, Math.max(maxNodes - deleted.length, 0));
            capped = 'nodes';
        }
        for (let i = 0; i < level.length; i += batchSize) {
            const batch = level.slice(i, i + batchSize);
            await deleteIds(batch);
            await asyncForEach(batch, async (childId) => {
                forget(childId);
                deleted.push(childId);
            });
            await yieldToEventLoop();
        }
        if (capped) {
            break;
        }
        frontier = level;
    }
    if (capped) {
        const reason = capped === 'depth' ?
            `depth of ${maxDepth} levels` :
            `count of ${maxNodes} descendants`;
        warn(`Cascading delete of ${objectId} in ${namespace}/${sceneId} stopped at the maximum ` +
            `${reason}: ${deleted.length} descendants deleted, deeper descendants left orphaned`);
    }
    return {deleted, levels, capped};
};

module.exports = {
    CASCADE_BATCH_SIZE,
    MAX_CASCADE_DEPTH,
    MAX_CASCADE_NODES,
    cascadeDeleteDescendants,
};
