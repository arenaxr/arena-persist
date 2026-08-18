/**
 * @fileoverview Deleting a persisted object and everything parented beneath it.
 *
 * Deleting a persisted object must also remove all of its descendants, at any
 * depth, in that order: the root first, then a bounded breadth-first walk down
 * the parent links, then a sweep for template debris the walk cannot reach. The
 * walk hands control back to the event loop between batches, so a deep or hostile
 * parent tree cannot turn a single MQTT delete into a denial of service against
 * the persist service.
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
 * Builds the callback that drops one object's in-memory keys as it is deleted.
 *
 * Both collections are pruned, not just persists. An expirations entry left
 * behind outlives its object: when its old TTL deadline arrives, publishExpires
 * publishes a delete for an id that is already gone and deletes that key from
 * persists, which silently un-persists a live object if one has since been
 * created with the same id in the same scene.
 *
 * @param {Set<string>} persists - Keys of all persisted objects, as namespace|sceneId|object_id.
 * @param {Map<string, Object>} expirations - Pending TTL deadlines, keyed the same way.
 * @param {Object} scope - Scene that the ids being forgotten belong to.
 * @param {string} scope.namespace - namespace of the scene.
 * @param {string} scope.sceneId - sceneId of the scene.
 * @return {function(string): void} Callback that prunes one object_id from both collections.
 */
const buildForget = (persists, expirations, {namespace, sceneId}) => (objectId) => {
    const key = `${namespace}|${sceneId}|${objectId}`;
    persists.delete(key);
    expirations.delete(key);
};

/**
 * Deletes every descendant of an object, breadth-first, one query per level.
 *
 * The walk starts from an object that has already been deleted itself, collects
 * the ids of its children, deletes them in batches, then repeats with those ids
 * as the next frontier. Ids already seen are never revisited, so cycles in the
 * parent pointers terminate rather than looping.
 *
 * Each level is queried with an explicit limit taken from the remaining node
 * budget, so no single level can be materialized in full before a cap applies.
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
 * @param {function(Array<string>, number): Promise<Array<string>>} handlers.findChildIds - Resolves
 *     at most limit object_ids of objects whose parent is one of the given ids.
 * @param {function(Array<string>): Promise<void>} handlers.deleteIds - Deletes the given ids.
 * @param {function(string): void} handlers.forget - Drops one id from the in-memory
 *     collections, so no stale key survives the delete.
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
        // Ask for no more than the budget still left, plus one sentinel row that
        // reveals a level too large to finish. Fetching a level in full and
        // truncating it afterwards would let one object with a huge number of
        // children cost unbounded transfer, memory and event loop time first.
        const remaining = maxNodes - deleted.length;
        const childIds = await findChildIds(frontier, remaining + 1);
        levels += 1;
        if (childIds.length > remaining) {
            capped = 'nodes';
        }
        const nextFrontier = [];
        await asyncForEach(childIds.slice(0, remaining), async (childId) => {
            if (!visited.has(childId)) {
                visited.add(childId);
                nextFrontier.push(childId);
            }
        });
        if (!nextFrontier.length) {
            break;
        }
        for (let i = 0; i < nextFrontier.length; i += batchSize) {
            const batch = nextFrontier.slice(i, i + batchSize);
            await deleteIds(batch);
            await asyncForEach(batch, async (childId) => {
                forget(childId);
                deleted.push(childId);
            });
            // Yielding is what keeps a large cascade from blocking the MQTT handler,
            // and it is also the one race accepted here: a message serviced during
            // the yield can reparent a descendant this walk has not visited yet. If
            // it is moved out of the subtree the next query no longer finds it, so
            // both the document and its persists key survive until an ancestor is
            // deleted again or the hourly persists refresh runs. A reconciliation
            // pass re-querying the already-visited ids was considered and rejected:
            // it costs a query over the whole visited set, anything it found would
            // reopen the same window one level deeper, and a reparent after its own
            // query is still missed. Closing the window means serializing the
            // message handler per scene, a larger change than this fix.
            await yieldToEventLoop();
        }
        if (capped) {
            break;
        }
        frontier = nextFrontier;
    }
    if (capped) {
        const reason = capped === 'depth' ?
            `depth of ${maxDepth} levels` :
            `count of ${maxNodes} descendants`;
        // A subtree that happens to end exactly at maxDepth is fully deleted even
        // though the walk stopped, because the level that would have proved it empty
        // is never queried. The node cap, in contrast, is only ever reached by a
        // level that really did hold more objects than the budget allowed.
        const remainder = capped === 'depth' ?
            'any deeper descendants are left orphaned' :
            'the remaining descendants are left orphaned';
        warn(`Cascading delete of ${objectId} in ${namespace}/${sceneId} stopped at the maximum ` +
            `${reason}: ${deleted.length} descendants deleted, ${remainder}`);
    }
    return {deleted, levels, capped};
};

/**
 * Deletes template-instance objects whose parent chain is already broken.
 *
 * The walk above follows parent links, so it can never reach an object whose
 * parent document is already gone. Every object loadTemplate clones is named with
 * its template container's id as a prefix, so for a container id a single
 * anchored, index-usable query on the parent field collects exactly that debris.
 * The matching ids are fetched and then deleted by id, rather than deleted by the
 * prefix in one step, because the ids are what lets each removed object also be
 * dropped from the in-memory collections.
 *
 * @param {Object} target - Identity of the object that was deleted, as for the walk.
 * @param {string} target.objectId - object_id of the deleted object.
 * @param {string} target.namespace - namespace of the deleted object.
 * @param {string} target.sceneId - sceneId of the deleted object.
 * @param {Object} handlers - Injected side effects, all scoped to the target scene.
 * @param {function(string, number): Promise<Array<string>>} handlers.findOrphanIds - Resolves
 *     at most limit object_ids of objects whose parent starts with the given prefix.
 * @param {function(Array<string>): Promise<void>} handlers.deleteIds - Deletes the given ids.
 * @param {function(string): void} handlers.forget - Drops one id from the in-memory collections.
 * @param {function(string): void} [handlers.warn] - Warning sink, defaults to console.warn.
 * @param {function(...*): void} [handlers.logError] - Error sink, defaults to console.log.
 * @param {Object} bounds - Work this sweep is allowed to do.
 * @param {number} bounds.budget - Maximum objects to remove.
 * @param {number} bounds.batchSize - Objects per batch between event loop yields.
 * @return {Promise<Array<string>>} Ids swept, in the order they were removed.
 */
const sweepTemplateOrphans = async (target, handlers, {budget, batchSize}) => {
    const {objectId, namespace, sceneId} = target;
    const {findOrphanIds, deleteIds, forget, warn = console.warn, logError = console.log} = handlers;
    const swept = [];
    // Only a template container id, which carries exactly one '::' pair, has
    // objects named after it; for any other id the query would match nothing.
    if (objectId.split('::').length - 1 !== 1 || budget <= 0) {
        return swept;
    }
    try {
        let orphanIds = await findOrphanIds(`${objectId}::`, budget + 1);
        let capped = false;
        if (orphanIds.length > budget) {
            orphanIds = orphanIds.slice(0, budget);
            capped = true;
        }
        for (let i = 0; i < orphanIds.length; i += batchSize) {
            const batch = orphanIds.slice(i, i + batchSize);
            await deleteIds(batch);
            await asyncForEach(batch, async (orphanId) => {
                forget(orphanId);
                swept.push(orphanId);
            });
            await yieldToEventLoop();
        }
        if (capped) {
            warn(`Sweep of template orphans under ${objectId} in ${namespace}/${sceneId} stopped at ` +
                `the remaining budget of ${budget} objects: more orphans may remain`);
        }
    } catch (err) {
        logError('Error deleting template container orphans of:', objectId, err);
    }
    return swept;
};

/**
 * Deletes a persisted object, everything beneath it, and all of their in-memory keys.
 *
 * The root goes first and the rest of the work only happens once that delete has
 * resolved: if the root cannot be removed it is still there, and stripping the
 * subtree from under a live parent is worse than a delete that did not happen. Its
 * in-memory keys are kept in that case too, so a retried delete still gets through
 * the caller's persists check.
 *
 * @param {Object} target - Identity of the object to delete.
 * @param {string} target.objectId - object_id of the object to delete.
 * @param {string} target.namespace - namespace of the object.
 * @param {string} target.sceneId - sceneId of the object.
 * @param {Object} handlers - Injected side effects, all scoped to the target scene.
 * @param {function(): Promise<void>} handlers.deleteRoot - Deletes the target object itself.
 *     Deleting an object that is not there is not a failure and must not reject.
 * @param {function(Array<string>, number): Promise<Array<string>>} handlers.findChildIds - As
 *     for cascadeDeleteDescendants.
 * @param {function(string, number): Promise<Array<string>>} handlers.findOrphanIds - As for
 *     sweepTemplateOrphans.
 * @param {function(Array<string>): Promise<void>} handlers.deleteIds - Deletes the given ids.
 * @param {function(string): void} handlers.forget - Drops one id from the in-memory collections.
 * @param {function(string): void} [handlers.warn] - Warning sink, defaults to console.warn.
 * @param {function(...*): void} [handlers.logError] - Error sink, defaults to console.log.
 * @param {Object} [limits] - Cap overrides, as for cascadeDeleteDescendants.
 * @param {number} [limits.maxNodes] - Maximum objects to remove below the root.
 * @param {number} [limits.maxDepth] - Maximum levels to walk.
 * @param {number} [limits.batchSize] - Objects per batch between event loop yields.
 * @return {Promise<{rootDeleted: boolean, deleted: Array<string>, levels: number,
 *     capped: ?string, orphans: Array<string>}>} Whether the root was deleted, and what
 *     the walk and the orphan sweep removed below it.
 */
const deleteObjectAndDescendants = async (target, handlers, limits = {}) => {
    const {objectId} = target;
    const {deleteRoot, forget, logError = console.log} = handlers;
    const {maxNodes = MAX_CASCADE_NODES, batchSize = CASCADE_BATCH_SIZE} = limits;
    try {
        await deleteRoot();
    } catch (err) {
        logError('Error deleting object, its descendants are left in place:', objectId, err);
        return {rootDeleted: false, deleted: [], levels: 0, capped: null, orphans: []};
    }
    let walk = {deleted: [], levels: 0, capped: null};
    try {
        walk = await cascadeDeleteDescendants(target, handlers, limits);
    } catch (err) {
        logError('Error deleting descendants of:', objectId, err);
    }
    const orphans = await sweepTemplateOrphans(target, handlers, {
        budget: maxNodes - walk.deleted.length,
        batchSize,
    });
    forget(objectId);
    return Object.assign({rootDeleted: true, orphans}, walk);
};

module.exports = {
    CASCADE_BATCH_SIZE,
    MAX_CASCADE_DEPTH,
    MAX_CASCADE_NODES,
    buildForget,
    cascadeDeleteDescendants,
    deleteObjectAndDescendants,
};
