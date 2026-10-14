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
    buildForget,
    cascadeDeleteDescendants,
    deleteObjectAndDescendants,
} = require('../cascade');

const TARGET = {objectId: 'root', namespace: 'public', sceneId: 'lobby'};
const TEMPLATE_TARGET = {objectId: 'public|store::shelf', namespace: 'public', sceneId: 'lobby'};

/**
 * Builds injected handlers backed by an in-memory tree, recording every call.
 *
 * findChildIds honours the limit it is given, exactly as a limited MongoDB query
 * would, so the recorded row counts show how much a level actually transferred.
 * @param {Object<string, Array<string>>} tree - Map of parent object_id to child object_ids.
 * @param {Object} [store] - The rest of the fake database.
 * @param {Array<string>} [store.orphans] - object_ids whose parent matches the swept prefix.
 * @return {{handlers: Object, calls: Object}} Handlers to pass to the walk, and the calls they
 *     recorded: queried frontiers, query limits, returned row counts, orphan sweep queries,
 *     root deletes, delete batches, forgotten ids, ids forgotten with their persists key
 *     retained, warnings and logged errors.
 */
const fakeStore = (tree, {orphans = []} = {}) => {
    const calls = {
        queries: [],
        limits: [],
        returned: [],
        orphanQueries: [],
        rootDeletes: 0,
        batches: [],
        forgotten: [],
        retained: [],
        warnings: [],
        errors: [],
    };
    const handlers = {
        deleteRoot: async () => {
            calls.rootDeletes += 1;
        },
        findChildIds: async (parentIds, limit) => {
            calls.queries.push([...parentIds]);
            calls.limits.push(limit);
            const found = parentIds.reduce((acc, parentId) => acc.concat(tree[parentId] || []), []);
            const rows = found.slice(0, limit);
            calls.returned.push(rows.length);
            return rows;
        },
        findOrphanIds: async (parentPrefix, limit) => {
            calls.orphanQueries.push([parentPrefix, limit]);
            return orphans.slice(0, limit);
        },
        deleteIds: async (objectIds) => {
            calls.batches.push([...objectIds]);
        },
        forget: (objectId, {retainPersist = false} = {}) => {
            calls.forgotten.push(objectId);
            if (retainPersist) {
                calls.retained.push(objectId);
            }
        },
        warn: (message) => {
            calls.warnings.push(message);
        },
        logError: (...args) => {
            calls.errors.push(args.map((arg) => (arg instanceof Error ? arg.message : String(arg))).join(' '));
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

        // Markers that re-arm themselves, so one lands on every event-loop turn for as long as
        // the walk runs. Every handler here resolves on a microtask, so a walk that never yields
        // drains to completion in one macrotask and no marker appears between any two deletes.
        // Asserting a marker in *each* gap is what pins the yield to every batch: a single marker
        // anywhere before the last delete is also satisfied by yielding once per level, or once
        // per walk.
        //
        // One marker of each macrotask kind, because neither alone covers both yield primitives.
        // A setTimeout(0) marker on its own cannot see an immediate yield: Node clamps it to
        // ~1 ms, and the whole fake walk now finishes in microseconds, so it is not due yet when
        // the loop passes through its timers phase. It used to be due only because the yield
        // itself cost about a millisecond, which is why the marker this replaced was measuring
        // the yield's latency rather than its yielding, and flaked. An immediate marker on its own cannot see
        // a timer yield either: the timers phase precedes the check phase in every loop
        // iteration, so the next batch is always already recorded by the time the marker runs.
        // Either primitive satisfies the union of the two.
        let marking = true;
        const mark = (schedule) => {
            const tick = () => {
                events.push('mark');
                if (marking) {
                    schedule(tick);
                }
            };
            schedule(tick);
        };
        mark(setImmediate);
        mark((fn) => setTimeout(fn, 0));
        try {
            await cascadeDeleteDescendants(TARGET, recording, {batchSize: 1});
        } finally {
            marking = false;
        }

        assert.strictEqual(events[0], 'delete:a');
        const gap = (from, to) => events.slice(events.indexOf(from) + 1, events.indexOf(to));
        assert.ok(gap('delete:a', 'delete:b').includes('mark'),
            `expected an event-loop turn between the first two batches, got ${events.join(' ')}`);
        assert.ok(gap('delete:b', 'delete:c').includes('mark'),
            `expected an event-loop turn between the second and third batches, got ${events.join(' ')}`);
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

    describe('bounded level queries', () => {
        it('asks each level for no more than the remaining budget, plus one sentinel row', async () => {
            const {handlers, calls} = fakeStore({root: ['a', 'b'], a: ['a1']});

            await cascadeDeleteDescendants(TARGET, handlers, {maxNodes: 10});

            // 10 left, then 8 after a and b, then 7 after a1; one extra row each time.
            assert.deepStrictEqual(calls.limits, [11, 9, 8]);
        });

        it('limits by the default node cap when no override is given', async () => {
            const {handlers, calls} = fakeStore({root: ['a']});
            await cascadeDeleteDescendants(TARGET, handlers);
            assert.deepStrictEqual(calls.limits, [MAX_CASCADE_NODES + 1, MAX_CASCADE_NODES]);
        });

        it('never transfers a whole oversized level before the node cap applies', async () => {
            const many = Array.from({length: 5000}, (unused, i) => `c${i}`);
            const {handlers, calls} = fakeStore({root: many});

            const result = await cascadeDeleteDescendants(TARGET, handlers, {maxNodes: 10, batchSize: 4});

            assert.deepStrictEqual(calls.limits, [11], 'the query itself must carry the budget');
            assert.deepStrictEqual(calls.returned, [11], 'only the budget plus a sentinel may be fetched');
            assert.strictEqual(result.capped, 'nodes');
            assert.strictEqual(result.deleted.length, 10);
            assert.deepStrictEqual(calls.forgotten, result.deleted);
            assert.strictEqual(calls.warnings.length, 1);
        });

        it('deletes an oversized level up to the cap and queries no further level', async () => {
            const many = Array.from({length: 300}, (unused, i) => `c${i}`);
            const tree = {root: many};
            many.forEach((id) => {
                tree[id] = [`${id}g`];
            });
            const {handlers, calls} = fakeStore(tree);

            const result = await cascadeDeleteDescendants(TARGET, handlers, {maxNodes: 5});

            assert.deepStrictEqual(result.deleted, ['c0', 'c1', 'c2', 'c3', 'c4']);
            assert.deepStrictEqual(calls.queries, [['root']]);
        });
    });

    describe('cap reporting', () => {
        it('reports the depth cap as a possibility, since the subtree may have ended there', async () => {
            const {handlers, calls} = fakeStore(chain(2));

            const result = await cascadeDeleteDescendants(TARGET, handlers, {maxDepth: 2});

            // The whole subtree really was deleted: the level that would have proved
            // it empty is simply never queried, so the warning must not claim orphans.
            assert.strictEqual(result.capped, 'depth');
            assert.deepStrictEqual(result.deleted, ['n1', 'n2']);
            assert.strictEqual(calls.warnings.length, 1);
            assert.match(calls.warnings[0], /any deeper descendants are left orphaned/);
            assert.doesNotMatch(calls.warnings[0], /the remaining descendants/);
        });

        it('reports the node cap as a fact, since the level really did hold more', async () => {
            const tree = {root: ['a', 'b'], a: ['a1', 'a2'], b: ['b1', 'b2']};
            const {handlers, calls} = fakeStore(tree);

            const result = await cascadeDeleteDescendants(TARGET, handlers, {maxNodes: 3});

            assert.strictEqual(result.capped, 'nodes');
            assert.match(calls.warnings[0], /the remaining descendants are left orphaned/);
            assert.doesNotMatch(calls.warnings[0], /any deeper descendants/);
        });
    });
});

describe('buildForget', () => {
    const scope = {namespace: 'public', sceneId: 'lobby'};

    it('prunes both the persists key and the expirations entry', () => {
        const persists = new Set(['public|lobby|a', 'public|lobby|keep']);
        const expirations = new Map([['public|lobby|a', {}], ['public|lobby|keep', {}]]);

        buildForget(persists, expirations, scope)('a');

        assert.ok(!persists.has('public|lobby|a'));
        assert.ok(!expirations.has('public|lobby|a'),
            'a surviving expiration fires a delete for a dead id, and un-persists a recreated one');
        assert.ok(persists.has('public|lobby|keep'));
        assert.ok(expirations.has('public|lobby|keep'));
    });

    it('keeps the persists key but still drops the TTL entry when asked to retain it', () => {
        const persists = new Set(['public|lobby|a']);
        const expirations = new Map([['public|lobby|a', {}]]);

        buildForget(persists, expirations, scope)('a', {retainPersist: true});

        assert.deepStrictEqual([...persists], ['public|lobby|a'],
            'the key is what readmits a retried delete for an unfinished cascade');
        assert.strictEqual(expirations.size, 0,
            'the document is gone, so its TTL entry must not outlive it either way');
    });

    it('only touches the given scene', () => {
        const persists = new Set(['public|lobby|a', 'public|other|a']);
        const expirations = new Map([['public|lobby|a', {}], ['public|other|a', {}]]);

        buildForget(persists, expirations, scope)('a');

        assert.deepStrictEqual([...persists], ['public|other|a']);
        assert.deepStrictEqual([...expirations.keys()], ['public|other|a']);
    });

    it('leaves nothing behind for a descendant that had a TTL of its own', async () => {
        const persists = new Set(['public|lobby|root', 'public|lobby|a', 'public|lobby|a1']);
        const expirations = new Map([
            ['public|lobby|root', {object_id: 'root'}],
            ['public|lobby|a1', {object_id: 'a1'}],
        ]);
        const {handlers} = fakeStore({root: ['a'], a: ['a1']});

        await cascadeDeleteDescendants(TARGET, Object.assign({}, handlers, {
            forget: buildForget(persists, expirations, scope),
        }));

        assert.deepStrictEqual([...persists], ['public|lobby|root'], 'the caller forgets the root itself');
        assert.deepStrictEqual([...expirations.keys()], ['public|lobby|root']);
    });
});

describe('deleteObjectAndDescendants', () => {
    const scope = {namespace: 'public', sceneId: 'lobby'};

    it('deletes the root first, then the subtree, then forgets the root', async () => {
        const {handlers, calls} = fakeStore({root: ['a'], a: ['a1']});

        const result = await deleteObjectAndDescendants(TARGET, handlers);

        assert.strictEqual(result.rootDeleted, true);
        assert.strictEqual(calls.rootDeletes, 1);
        assert.deepStrictEqual(result.deleted, ['a', 'a1']);
        assert.deepStrictEqual(calls.forgotten, ['a', 'a1', 'root']);
        assert.deepStrictEqual(calls.retained, [], 'nothing is left to retry, so no key is kept');
        assert.strictEqual(result.complete, true);
        assert.deepStrictEqual(calls.errors, []);
    });

    it('leaves the subtree and every in-memory key alone when the root delete fails', async () => {
        const persists = new Set(['public|lobby|root', 'public|lobby|a', 'public|lobby|a1']);
        const expirations = new Map([['public|lobby|root', {object_id: 'root'}]]);
        const {handlers, calls} = fakeStore({root: ['a'], a: ['a1']});
        const failing = Object.assign({}, handlers, {
            deleteRoot: async () => {
                throw new Error('connection lost');
            },
            forget: buildForget(persists, expirations, scope),
        });

        const result = await deleteObjectAndDescendants(TARGET, failing);

        assert.strictEqual(result.rootDeleted, false);
        assert.strictEqual(result.complete, false);
        assert.deepStrictEqual(result.deleted, []);
        assert.deepStrictEqual(result.orphans, []);
        assert.deepStrictEqual(calls.queries, [], 'no descendant may be queried');
        assert.deepStrictEqual(calls.batches, [], 'no descendant may be deleted');
        assert.strictEqual(persists.size, 3, 'the keys must survive so a retried delete still gets through');
        assert.strictEqual(expirations.size, 1);
        assert.strictEqual(calls.errors.length, 1);
        assert.match(calls.errors[0], /connection lost/);
    });

    it('still cascades when the root was simply not there, which is not a failure', async () => {
        // A delete of a missing document resolves with nothing deleted, so the
        // subtree and the in-memory keys must still be cleaned up.
        const {handlers, calls} = fakeStore({root: ['a']});

        const result = await deleteObjectAndDescendants(TARGET, handlers);

        assert.strictEqual(result.rootDeleted, true);
        assert.deepStrictEqual(result.deleted, ['a']);
        assert.deepStrictEqual(calls.forgotten, ['a', 'root']);
        assert.deepStrictEqual(calls.errors, []);
    });

    it('keeps the root persists key when the walk fails, since a retry is the way back in', async () => {
        // The caller admits a delete only while the key is in persists, so dropping it
        // here would permanently block the one direct way to reach the descendants the
        // failed walk left behind.
        const persists = new Set(['public|lobby|root', 'public|lobby|a']);
        const expirations = new Map([['public|lobby|root', {object_id: 'root'}]]);
        const {handlers, calls} = fakeStore({root: ['a']});
        const broken = Object.assign({}, handlers, {
            findChildIds: async () => {
                throw new Error('query failed');
            },
            forget: buildForget(persists, expirations, scope),
        });

        const result = await deleteObjectAndDescendants(TARGET, broken);

        assert.strictEqual(result.rootDeleted, true);
        assert.strictEqual(result.complete, false, 'the descendants were not all removed');
        assert.deepStrictEqual(result.deleted, []);
        assert.ok(persists.has('public|lobby|root'), 'the key must survive so a retried delete gets through');
        assert.strictEqual(expirations.size, 0, 'the root document is gone, so its TTL entry goes too');
        assert.strictEqual(calls.errors.length, 1);
        assert.match(calls.errors[0], /query failed/);
        assert.strictEqual(calls.warnings.length, 1);
        assert.match(calls.warnings[0], /did not finish/);
    });

    it('lets a retried delete finish the cascade the failed one left behind', async () => {
        const persists = new Set(['public|lobby|root', 'public|lobby|a']);
        const expirations = new Map();
        const {handlers, calls} = fakeStore({root: ['a']});
        const forget = buildForget(persists, expirations, scope);
        let failNextQuery = true;
        const flaky = Object.assign({}, handlers, {
            findChildIds: async (parentIds, limit) => {
                if (failNextQuery) {
                    failNextQuery = false;
                    throw new Error('query failed');
                }
                return handlers.findChildIds(parentIds, limit);
            },
            forget: (objectId, options) => {
                handlers.forget(objectId, options);
                forget(objectId, options);
            },
        });

        await deleteObjectAndDescendants(TARGET, flaky);
        // The caller's gate, which the retained key is there to satisfy.
        assert.ok(persists.has('public|lobby|root'));
        const retry = await deleteObjectAndDescendants(TARGET, flaky);

        assert.strictEqual(retry.complete, true);
        assert.deepStrictEqual(retry.deleted, ['a'], 'the descendant the first attempt missed');
        assert.strictEqual(persists.size, 0, 'only a finished cascade drops the root key');
        assert.deepStrictEqual(calls.retained, ['root'], 'the retry forgot the root outright');
        assert.deepStrictEqual(calls.forgotten, ['root', 'a', 'root']);
    });

    describe('broken-chain template sweep', () => {
        const orphans = ['public|store::shelf::box', 'public|store::shelf::box::lid'];

        it('deletes the swept orphans by id, so each one can also be forgotten', async () => {
            const {handlers, calls} = fakeStore({}, {orphans});

            const result = await deleteObjectAndDescendants(TEMPLATE_TARGET, handlers);

            assert.deepStrictEqual(calls.orphanQueries, [['public|store::shelf::', MAX_CASCADE_NODES + 1]]);
            assert.deepStrictEqual(result.orphans, orphans);
            assert.deepStrictEqual(calls.batches, [orphans]);
            assert.deepStrictEqual(calls.forgotten, orphans.concat(['public|store::shelf']));
        });

        it('prunes every swept orphan from persists and expirations', async () => {
            const keys = orphans.map((id) => `public|lobby|${id}`);
            const persists = new Set(['public|lobby|public|store::shelf', ...keys]);
            const expirations = new Map(orphans.map((id) => [`public|lobby|${id}`, {object_id: id}]));
            const {handlers} = fakeStore({}, {orphans});

            await deleteObjectAndDescendants(TEMPLATE_TARGET, Object.assign({}, handlers, {
                forget: buildForget(persists, expirations, scope),
            }));

            assert.strictEqual(persists.size, 0, 'the broken-chain orphans are exactly the stale keys');
            assert.strictEqual(expirations.size, 0);
        });

        it('does not sweep, or warn, for an id that is not a template container', async () => {
            const {handlers, calls} = fakeStore({}, {orphans});
            const result = await deleteObjectAndDescendants(TARGET, handlers);
            assert.deepStrictEqual(calls.orphanQueries, []);
            assert.deepStrictEqual(result.orphans, []);
            assert.deepStrictEqual(calls.warnings, [], 'no orphans are possible, so there is nothing to report');
        });

        it('bounds the sweep by the budget the walk left over', async () => {
            const {handlers, calls} = fakeStore({'public|store::shelf': ['c1', 'c2']}, {orphans});

            await deleteObjectAndDescendants(TEMPLATE_TARGET, handlers, {maxNodes: 6});

            assert.deepStrictEqual(calls.orphanQueries, [['public|store::shelf::', 5]]);
        });

        it('stops sweeping and warns when the remaining budget runs out', async () => {
            const {handlers, calls} = fakeStore({}, {orphans});

            const result = await deleteObjectAndDescendants(TEMPLATE_TARGET, handlers, {maxNodes: 1});

            assert.deepStrictEqual(result.orphans, [orphans[0]]);
            assert.strictEqual(calls.warnings.length, 1);
            assert.match(calls.warnings[0], /template orphans under public\|store::shelf/);
            assert.match(calls.warnings[0], /more orphans may remain/);
        });

        it('reports the sweep it had to skip when the walk spent the whole budget', async () => {
            // The walk here ends the subtree of its own accord, so it reports no cap;
            // without this warning the orphans it had no budget left to sweep would be
            // the one kind of leftover a caller is never told about.
            const {handlers, calls} = fakeStore({'public|store::shelf': ['c1', 'c2']}, {orphans});

            const result = await deleteObjectAndDescendants(TEMPLATE_TARGET, handlers, {maxNodes: 2});

            assert.deepStrictEqual(calls.orphanQueries, [], 'there is no budget left to query with');
            assert.strictEqual(result.capped, null, 'the walk itself reached the end of the subtree');
            assert.strictEqual(calls.warnings.length, 1);
            assert.match(calls.warnings[0], /was skipped/);
            assert.match(calls.warnings[0], /any orphans may remain/);
        });

        it('does not hand the sweep the budget a failed walk already spent', async () => {
            // A walk that fails after a successful batch really did delete those ids, so
            // forgetting them would let one request spend the node cap twice over.
            const {handlers, calls} = fakeStore({'public|store::shelf': ['c1', 'c2'], 'c1': ['g1']}, {orphans});
            let queries = 0;
            const failing = Object.assign({}, handlers, {
                findChildIds: async (parentIds, limit) => {
                    queries += 1;
                    if (queries > 1) {
                        throw new Error('query failed mid-walk');
                    }
                    return handlers.findChildIds(parentIds, limit);
                },
            });

            const result = await deleteObjectAndDescendants(TEMPLATE_TARGET, failing, {maxNodes: 6});

            assert.deepStrictEqual(result.deleted, ['c1', 'c2'], 'the ids it did delete are still reported');
            assert.strictEqual(result.complete, false);
            assert.deepStrictEqual(calls.orphanQueries, [['public|store::shelf::', 5]],
                'the sweep gets the 4 nodes left of the budget plus a sentinel, not a fresh 6');
        });

        it('keeps the root persists key when the sweep fails, since a retry is the way back in', async () => {
            const persists = new Set(['public|lobby|public|store::shelf']);
            const expirations = new Map([['public|lobby|public|store::shelf', {}]]);
            const {handlers, calls} = fakeStore({}, {orphans});
            const broken = Object.assign({}, handlers, {
                findOrphanIds: async () => {
                    throw new Error('regex query failed');
                },
                forget: buildForget(persists, expirations, scope),
            });

            const result = await deleteObjectAndDescendants(TEMPLATE_TARGET, broken);

            assert.strictEqual(result.complete, false, 'the broken-chain orphans are still down there');
            assert.ok(persists.has('public|lobby|public|store::shelf'),
                'the key must survive so a retried delete gets through');
            assert.strictEqual(expirations.size, 0);
            assert.strictEqual(calls.warnings.length, 1);
            assert.match(calls.warnings[0], /did not finish/);
        });

        it('reports the sweep as failed without losing the rest of the delete', async () => {
            const {handlers, calls} = fakeStore({}, {orphans});
            const broken = Object.assign({}, handlers, {
                findOrphanIds: async () => {
                    throw new Error('regex query failed');
                },
            });

            const result = await deleteObjectAndDescendants(TEMPLATE_TARGET, broken);

            assert.strictEqual(result.rootDeleted, true);
            assert.deepStrictEqual(result.orphans, []);
            assert.deepStrictEqual(calls.forgotten, ['public|store::shelf']);
            assert.deepStrictEqual(calls.retained, ['public|store::shelf']);
            assert.strictEqual(calls.errors.length, 1);
            assert.match(calls.errors[0], /regex query failed/);
        });

        it('deletes the swept orphans in batches, yielding between them', async () => {
            const many = Array.from({length: 5}, (unused, i) => `public|store::shelf::o${i}`);
            const {handlers, calls} = fakeStore({}, {orphans: many});

            await deleteObjectAndDescendants(TEMPLATE_TARGET, handlers, {batchSize: 2});

            assert.deepStrictEqual(calls.batches, [many.slice(0, 2), many.slice(2, 4), many.slice(4)]);
        });
    });
});
