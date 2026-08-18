/**
 * @fileoverview Unit tests for the bounded descendant walk exported by cascade.js.
 *
 * The walk takes all of its database access as injected callbacks, so the trees
 * below are plain in-memory parent maps and no MongoDB is needed.
 *
 * Open source software under the terms in /LICENSE
 * Copyright (c) 2026 ARENAXR. All rights reserved.
 */

const assert = require('node:assert/strict');
const {describe, it} = require('node:test');

const {
    CASCADE_BATCH_SIZE,
    MAX_CASCADE_DEPTH,
    MAX_CASCADE_NODES,
    cascadeDeleteDescendants,
} = require('../cascade');

const TARGET = {objectId: 'root', namespace: 'public', sceneId: 'lobby'};

/**
 * Builds injected handlers backed by an in-memory tree, recording every call.
 * @param {Object<string, Array<string>>} tree - Map of parent object_id to child object_ids.
 * @return {{handlers: Object, calls: Object}} Handlers to pass to the walk, and the calls
 *     they recorded: queried frontiers, delete batches, forgotten ids, and warnings.
 */
const fakeStore = (tree) => {
    const calls = {queries: [], batches: [], forgotten: [], warnings: []};
    const handlers = {
        findChildIds: async (parentIds) => {
            calls.queries.push([...parentIds]);
            return parentIds.reduce((found, parentId) => found.concat(tree[parentId] || []), []);
        },
        deleteIds: async (objectIds) => {
            calls.batches.push([...objectIds]);
        },
        forget: (objectId) => {
            calls.forgotten.push(objectId);
        },
        warn: (message) => {
            calls.warnings.push(message);
        },
    };
    return {handlers, calls};
};

/**
 * Builds a single chain of the given length below the walk target.
 * @param {number} length - Number of descendants in the chain.
 * @return {Object<string, Array<string>>} Tree usable by fakeStore.
 */
const chain = (length) => {
    const tree = {};
    let parent = TARGET.objectId;
    for (let i = 1; i <= length; i++) {
        tree[parent] = [`n${i}`];
        parent = `n${i}`;
    }
    return tree;
};

describe('cascadeDeleteDescendants', () => {
    const cases = [
        {
            name: 'deletes nothing for an object with no children, using a single query',
            tree: {},
            deleted: [],
            levels: 1,
            queries: [['root']],
        },
        {
            name: 'deletes a single level of children',
            tree: {root: ['a', 'b']},
            deleted: ['a', 'b'],
            levels: 2,
            queries: [['root'], ['a', 'b']],
        },
        {
            name: 'deletes grandchildren, which the old single-level delete orphaned',
            tree: {root: ['a'], a: ['a1']},
            deleted: ['a', 'a1'],
            levels: 3,
            queries: [['root'], ['a'], ['a1']],
        },
        {
            name: 'deletes a multi-level tree breadth-first, one query per level',
            tree: {
                root: ['a', 'b'],
                a: ['a1', 'a2'],
                b: ['b1'],
                a2: ['a2x'],
            },
            deleted: ['a', 'b', 'a1', 'a2', 'b1', 'a2x'],
            levels: 4,
            queries: [['root'], ['a', 'b'], ['a1', 'a2', 'b1'], ['a2x']],
        },
        {
            name: 'deletes a deep chain level by level',
            tree: chain(5),
            deleted: ['n1', 'n2', 'n3', 'n4', 'n5'],
            levels: 6,
            queries: [['root'], ['n1'], ['n2'], ['n3'], ['n4'], ['n5']],
        },
        {
            name: 'leaves objects outside the target subtree alone',
            tree: {root: ['a'], elsewhere: ['e1']},
            deleted: ['a'],
            levels: 2,
            queries: [['root'], ['a']],
        },
        {
            name: 'deletes a whole template instance subtree',
            tree: {
                'public|store::shelf': ['public|store::shelf::box'],
                'public|store::shelf::box': ['public|store::shelf::box::lid'],
            },
            target: {objectId: 'public|store::shelf', namespace: 'public', sceneId: 'lobby'},
            deleted: ['public|store::shelf::box', 'public|store::shelf::box::lid'],
            levels: 3,
            queries: [
                ['public|store::shelf'],
                ['public|store::shelf::box'],
                ['public|store::shelf::box::lid'],
            ],
        },
    ];

    cases.forEach(({name, tree, target, deleted, levels, queries}) => {
        it(name, async () => {
            const {handlers, calls} = fakeStore(tree);
            const result = await cascadeDeleteDescendants(target || TARGET, handlers);
            assert.deepStrictEqual(result.deleted, deleted);
            assert.strictEqual(result.levels, levels);
            assert.strictEqual(result.capped, null);
            assert.deepStrictEqual(calls.queries, queries);
            assert.deepStrictEqual(calls.warnings, []);
        });
    });

    it('deletes and forgets every descendant exactly once', async () => {
        const tree = {root: ['a', 'b'], a: ['a1'], b: ['b1'], a1: ['a1x']};
        const {handlers, calls} = fakeStore(tree);

        const {deleted} = await cascadeDeleteDescendants(TARGET, handlers);

        const flatBatches = calls.batches.flat();
        assert.deepStrictEqual(flatBatches, deleted);
        assert.deepStrictEqual(calls.forgotten, deleted);
        assert.strictEqual(new Set(deleted).size, deleted.length);
        assert.ok(!deleted.includes(TARGET.objectId), 'the target itself is deleted by the caller');
    });

    it('never queries or deletes for an object with no children beyond the first query', async () => {
        const {handlers, calls} = fakeStore({});
        const result = await cascadeDeleteDescendants(TARGET, handlers);
        assert.deepStrictEqual(calls.queries, [['root']]);
        assert.deepStrictEqual(calls.batches, []);
        assert.deepStrictEqual(calls.forgotten, []);
        assert.strictEqual(result.capped, null);
    });

    it('deletes in batches of the configured size', async () => {
        const {handlers, calls} = fakeStore({root: ['a', 'b', 'c', 'd', 'e']});
        await cascadeDeleteDescendants(TARGET, handlers, {batchSize: 2});
        assert.deepStrictEqual(calls.batches, [['a', 'b'], ['c', 'd'], ['e']]);
    });

    it('yields to the event loop between batches', async () => {
        const events = [];
        const {handlers} = fakeStore({root: ['a', 'b', 'c']});
        const recording = Object.assign({}, handlers, {
            deleteIds: async (objectIds) => {
                events.push(`delete:${objectIds.join(',')}`);
            },
        });

        // Queued before the walk starts: a walk that never yields would run to
        // completion first and push this timer's marker last.
        setTimeout(() => events.push('timer'), 0);
        await cascadeDeleteDescendants(TARGET, recording, {batchSize: 1});

        assert.strictEqual(events[0], 'delete:a');
        assert.ok(events.indexOf('timer') < events.indexOf('delete:c'),
            `expected the pending timer to run mid-walk, got ${events.join(' ')}`);
    });

    describe('caps', () => {
        it('stops at the descendant count cap and warns', async () => {
            const tree = {root: ['a', 'b'], a: ['a1', 'a2'], b: ['b1', 'b2']};
            const {handlers, calls} = fakeStore(tree);

            const result = await cascadeDeleteDescendants(TARGET, handlers, {maxNodes: 3});

            assert.strictEqual(result.capped, 'nodes');
            assert.deepStrictEqual(result.deleted, ['a', 'b', 'a1']);
            assert.deepStrictEqual(calls.forgotten, ['a', 'b', 'a1']);
            // Level 2 was queried, then truncated; no further level is queried.
            assert.deepStrictEqual(calls.queries, [['root'], ['a', 'b']]);
            assert.strictEqual(calls.warnings.length, 1);
            assert.match(calls.warnings[0], /maximum count of 3 descendants/);
            assert.match(calls.warnings[0], /root/);
            assert.match(calls.warnings[0], /public\/lobby/);
            assert.match(calls.warnings[0], /3 descendants deleted/);
        });

        it('stops at the depth cap and warns', async () => {
            const {handlers, calls} = fakeStore(chain(10));

            const result = await cascadeDeleteDescendants(TARGET, handlers, {maxDepth: 3});

            assert.strictEqual(result.capped, 'depth');
            assert.strictEqual(result.levels, 3);
            assert.deepStrictEqual(result.deleted, ['n1', 'n2', 'n3']);
            assert.deepStrictEqual(calls.forgotten, ['n1', 'n2', 'n3']);
            assert.deepStrictEqual(calls.queries, [['root'], ['n1'], ['n2']]);
            assert.strictEqual(calls.warnings.length, 1);
            assert.match(calls.warnings[0], /maximum depth of 3 levels/);
            assert.match(calls.warnings[0], /root/);
            assert.match(calls.warnings[0], /public\/lobby/);
        });

        it('resolves rather than throwing when a cap is hit', async () => {
            const {handlers} = fakeStore(chain(4));
            const result = await cascadeDeleteDescendants(TARGET, handlers,
                {maxDepth: 1, warn: () => {}});
            assert.strictEqual(result.capped, 'depth');
        });

        it('warns through console.warn when no sink is injected', async () => {
            const {handlers} = fakeStore(chain(4));
            delete handlers.warn;
            const original = console.warn;
            const warnings = [];
            console.warn = (message) => warnings.push(message);
            try {
                await cascadeDeleteDescendants(TARGET, handlers, {maxDepth: 2});
            } finally {
                console.warn = original;
            }
            assert.strictEqual(warnings.length, 1);
            assert.match(warnings[0], /maximum depth of 2 levels/);
        });

        it('exposes sane default caps', () => {
            assert.strictEqual(MAX_CASCADE_NODES, 10000);
            assert.strictEqual(MAX_CASCADE_DEPTH, 64);
            assert.strictEqual(CASCADE_BATCH_SIZE, 100);
        });

        it('walks a plausible scene subtree well within the default caps', async () => {
            const tree = {root: []};
            for (let i = 0; i < 50; i++) {
                tree.root.push(`c${i}`);
                tree[`c${i}`] = [`c${i}g0`, `c${i}g1`];
            }
            const {handlers, calls} = fakeStore(tree);
            const result = await cascadeDeleteDescendants(TARGET, handlers);
            assert.strictEqual(result.capped, null);
            assert.strictEqual(result.deleted.length, 150);
            assert.strictEqual(result.levels, 3);
            assert.deepStrictEqual(calls.warnings, []);
        });
    });

    describe('cycles', () => {
        const cycles = [
            {
                name: 'terminates when a descendant points back at the deleted object',
                tree: {root: ['a'], a: ['root']},
                deleted: ['a'],
                levels: 2,
            },
            {
                name: 'terminates on a cycle between two descendants',
                tree: {root: ['a'], a: ['b'], b: ['a']},
                deleted: ['a', 'b'],
                levels: 3,
            },
            {
                name: 'terminates on an object that is its own parent',
                tree: {root: ['a'], a: ['a']},
                deleted: ['a'],
                levels: 2,
            },
            {
                name: 'terminates on a longer cycle and still deletes the branch off it',
                tree: {root: ['a'], a: ['b'], b: ['c'], c: ['a', 'd']},
                deleted: ['a', 'b', 'c', 'd'],
                levels: 5,
            },
            {
                name: 'deletes a diamond, where two parents share a child, only once',
                tree: {root: ['a', 'b'], a: ['shared'], b: ['shared']},
                deleted: ['a', 'b', 'shared'],
                levels: 3,
            },
        ];

        cycles.forEach(({name, tree, deleted, levels}) => {
            it(name, async () => {
                const {handlers, calls} = fakeStore(tree);
                const result = await cascadeDeleteDescendants(TARGET, handlers);
                assert.deepStrictEqual(result.deleted, deleted);
                assert.strictEqual(result.levels, levels);
                // The visited set, not the depth cap, is what ends the walk.
                assert.strictEqual(result.capped, null);
                assert.ok(result.levels < MAX_CASCADE_DEPTH);
                assert.deepStrictEqual(calls.forgotten, deleted);
                assert.deepStrictEqual(calls.warnings, []);
            });
        });

        it('terminates a cycle far tighter than the depth cap allows', async () => {
            // A ring of 5 that would spin forever without the visited set.
            const ring = {root: ['r0'], r0: ['r1'], r1: ['r2'], r2: ['r3'], r3: ['r4'], r4: ['r0']};
            const {handlers, calls} = fakeStore(ring);
            const result = await cascadeDeleteDescendants(TARGET, handlers);
            assert.deepStrictEqual(result.deleted, ['r0', 'r1', 'r2', 'r3', 'r4']);
            assert.strictEqual(result.capped, null);
            assert.strictEqual(calls.queries.length, 6);
        });
    });
});
