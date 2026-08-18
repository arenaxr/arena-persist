/**
 * @fileoverview Unit tests for the MQTT message handling, TTL bookkeeping and template
 * instantiation in server.js.
 *
 * server.js exports nothing and connects to MongoDB and MQTT as it loads, so it is driven here
 * exactly the way the outside world drives it, with the outside world replaced:
 *
 * - mongoose.connect is made to resolve only once the test is ready, and the model's query methods
 *   are replaced with recorders. The schema, the documents and their casting are the real ones.
 * - async-mqtt hands back a fake client, so the message handler the service registers on it can be
 *   invoked directly and every publish is recorded.
 * - set-interval-async hands back the publishExpires callback instead of scheduling it, so expiry
 *   is stepped by hand rather than waited for.
 * - ./express_server records the collaborators it is called with, which is how the tests get hold
 *   of the service's loadTemplate function and its live persists set.
 *
 * No port is bound, no socket is opened, no database is contacted and no wall-clock waiting
 * happens. console output from the service is collected rather than printed.
 *
 * server.js can only be loaded once per process, so the harness is built once and every test
 * resets the recorders it uses. The connection-event tests come last, because they deliberately
 * exercise state that outlives them.
 *
 * Open source software under the terms in /LICENSE
 * Copyright (c) 2026 ARENAXR. All rights reserved.
 */

const assert = require('node:assert/strict');
const {describe, it} = require('node:test');

const mongoose = require('mongoose');
require('../utils'); // installs String.prototype.formatStr, used by the TOPICS table
const {TOPICS} = require('../topics');

/** Scene the tests work in, and the topic tokens that name it. */
const NAMESPACE = 'public';
const SCENE = 'lobby';
const REALM = 'realm';
const CLIENT = 'jdoe_1448081341_web';

/**
 * Installs a module into the require cache so later requires of it get these exports.
 * @param {string} request - Module specifier, resolved from this file.
 * @param {*} exports - Value to hand out as the module's exports.
 */
const stubModule = (request, exports) => {
    const filename = require.resolve(request);
    require.cache[filename] = {id: filename, filename, loaded: true, exports, children: [], paths: []};
};

/**
 * A thenable that also answers the query-builder calls chained onto find().
 * @param {*} rows - Value the query resolves to.
 * @return {Promise} Promise carrying sort() and exec() passthroughs.
 */
const fakeQuery = (rows) => {
    const query = Promise.resolve(rows);
    query.sort = () => query;
    query.exec = () => query;
    return query;
};

/** Recorded model queries, and the canned answers the next ones return. */
const db = {
    calls: [],
    findRows: [],
    counts: [],
    failures: {},
    reset() {
        db.calls.length = 0;
        db.findRows.length = 0;
        db.counts.length = 0;
        db.failures = {};
    },
    /**
     * Arguments of every recorded call of one model method, in call order.
     * @param {string} method - Model method name.
     * @return {Array<Array>} One entry per call.
     */
    of(method) {
        return db.calls.filter(([name]) => name === method).map(([, args]) => args);
    },
};

/**
 * Replaces the model's query methods with recorders reading from the db fixture.
 * @param {Object} ArenaObject - The mongoose model registered by server.js.
 */
const recordQueries = (ArenaObject) => {
    /**
     * Records one call and fails it if the fixture asked for a failure.
     * @param {string} name - Model method name.
     * @param {Array} args - Call arguments.
     */
    const record = (name, args) => {
        db.calls.push([name, args]);
        if (db.failures[name]) {
            throw db.failures[name];
        }
    };
    ArenaObject.find = (...args) => {
        record('find', args);
        return fakeQuery(db.findRows.length ? db.findRows.shift() : []);
    };
    ArenaObject.countDocuments = async (...args) => {
        record('countDocuments', args);
        return db.counts.length ? db.counts.shift() : 0;
    };
    for (const name of ['findOneAndUpdate', 'findOneAndReplace', 'deleteOne', 'deleteMany']) {
        ArenaObject[name] = async (...args) => {
            record(name, args);
            return {acknowledged: true, deletedCount: 0};
        };
    }
};

/** console output produced by the service, collected instead of printed. */
const logs = {log: [], warn: []};

/**
 * Loads server.js against fakes and returns everything it handed to its collaborators.
 * @return {Promise<Object>} The message handler, publishExpires, the live persists set, the
 *     service's loadTemplate, the fake MQTT client and its recorded publishes.
 */
const startServer = async () => {
    let releaseConnect;
    mongoose.connect = () => new Promise((resolve) => {
        releaseConnect = () => resolve(mongoose);
    });

    const published = [];
    const events = {};
    const mqttClient = {
        connected: true,
        on: (event, handler) => {
            events[event] = handler;
        },
        subscribe: async () => ({}),
        publish: async (topic, payload) => {
            published.push({topic, payload});
        },
    };
    let clientOptions;
    stubModule('async-mqtt', {
        connectAsync: async (uri, options) => {
            clientOptions = options;
            return mqttClient;
        },
    });

    const intervals = [];
    const cleared = [];
    stubModule('set-interval-async/dynamic', {
        setIntervalAsync: (fn, ms) => {
            const timer = {fn, ms, id: intervals.length};
            intervals.push(timer);
            return timer;
        },
        clearIntervalAsync: async (timer) => {
            cleared.push(timer);
        },
    });

    let injected;
    stubModule('../express_server', {
        runExpress: async (collaborators) => {
            injected = collaborators;
        },
    });

    console.log = (...args) => logs.log.push(args.join(' '));
    console.warn = (...args) => logs.warn.push(args.join(' '));

    // The hourly persists refresh would otherwise hold the process open for an hour; every other
    // timer, including the event loop yields inside the cascading delete, stays real.
    const realSetTimeout = global.setTimeout;
    global.setTimeout = (fn, ms, ...rest) => {
        if (ms === 60 * 60 * 1000) {
            const idle = realSetTimeout(() => {}, 1);
            idle.unref();
            return idle;
        }
        return realSetTimeout(fn, ms, ...rest);
    };

    require('../server');
    const ArenaObject = mongoose.model('ArenaObject');
    recordQueries(ArenaObject);
    releaseConnect();
    for (let turn = 0; turn < 20; turn++) {
        await new Promise((resolve) => setImmediate(resolve));
    }
    global.setTimeout = realSetTimeout;

    assert.ok(injected, 'the service should have started its express server');
    assert.equal(intervals.length, 1, 'the service should have scheduled exactly one expiry timer');
    return {
        ArenaObject,
        clientOptions,
        cleared,
        events,
        intervals,
        loadTemplate: injected.loadTemplate,
        mqttClient,
        persists: injected.persists,
        publishExpires: intervals[0].fn,
        published,
        onMessage: events.message,
    };
};

let harnessPromise;

/**
 * Returns the loaded service, resetting the recorders so each test starts clean.
 * @return {Promise<Object>} The harness from startServer.
 */
const service = async () => {
    if (!harnessPromise) {
        harnessPromise = startServer();
    }
    const harness = await harnessPromise;
    db.reset();
    harness.published.length = 0;
    harness.persists.clear();
    logs.log.length = 0;
    logs.warn.length = 0;
    return harness;
};

/**
 * Renders the scene-objects topic a client publishes an object on.
 * @param {string} objectId - object_id of the object the message is about.
 * @param {Object} [scene] - namespace, sceneId and userClient overrides.
 * @return {string} The rendered topic.
 */
const objectTopic = (objectId, {namespace = NAMESPACE, sceneId = SCENE, userClient = CLIENT} = {}) =>
    TOPICS.PUBLISH.SCENE_OBJECTS.formatStr({nameSpace: namespace, sceneName: sceneId, userClient, objectId});

/**
 * Delivers one MQTT message to the service, as the broker would.
 * @param {Object} harness - The harness from service().
 * @param {string} topic - Topic to deliver on.
 * @param {*} payload - Object to send as JSON, or a string/Buffer to send verbatim.
 * @return {Promise<void>} Settles once the service has finished handling the message.
 */
const deliver = async (harness, topic, payload) => {
    const body = typeof payload === 'string' || Buffer.isBuffer(payload) ? payload : JSON.stringify(payload);
    await harness.onMessage(topic, Buffer.from(body));
};

/**
 * Builds the key an object is remembered under, in both persists and expirations.
 * @param {string} objectId - object_id of the object.
 * @param {string} [namespace] - Namespace of its scene.
 * @param {string} [sceneId] - Its scene.
 * @return {string} The key.
 */
const key = (objectId, namespace = NAMESPACE, sceneId = SCENE) => `${namespace}|${sceneId}|${objectId}`;

describe('arenaMsgHandler message validation', () => {
    const ignored = [
        {
            name: 'the payload object_id disagrees with the topic',
            topic: objectTopic('box-1'),
            payload: {object_id: 'box-2', action: 'create', type: 'object', persist: true, data: {}},
        },
        {
            name: 'the payload has no object_id',
            topic: objectTopic('box-1'),
            payload: {action: 'create', type: 'object', persist: true, data: {}},
        },
        {
            name: 'the payload is not valid JSON',
            topic: objectTopic('box-1'),
            payload: '{"object_id": "box-1", ',
        },
        {
            name: 'the payload is empty',
            topic: objectTopic('box-1'),
            payload: '',
        },
        {
            name: 'the payload is JSON null',
            topic: objectTopic('box-1'),
            payload: 'null',
        },
        {
            name: 'the payload is a bare JSON number',
            topic: objectTopic('box-1'),
            payload: '7',
        },
        {
            name: 'the topic is too short to carry an object id',
            topic: `${REALM}/s/${NAMESPACE}/${SCENE}/o/${CLIENT}`,
            payload: {object_id: 'box-1', action: 'create', type: 'object', persist: true, data: {}},
        },
        {
            name: 'the action is one the service does not handle',
            topic: objectTopic('box-1'),
            payload: {object_id: 'box-1', action: 'clientEvent', type: 'object', persist: true, data: {}},
        },
        {
            name: 'there is no action at all',
            topic: objectTopic('box-1'),
            payload: {object_id: 'box-1', type: 'object', persist: true, data: {}},
        },
    ];
    for (const {name, topic, payload} of ignored) {
        it(`ignores a message where ${name}`, async () => {
            const harness = await service();
            await deliver(harness, topic, payload);
            assert.deepEqual(db.calls, [], 'no query should have been run');
            assert.deepEqual(harness.published, [], 'nothing should have been published');
            assert.deepEqual([...harness.persists], [], 'nothing should have been remembered');
        });
    }

    it('takes the realm, namespace and scene from the topic, not from the payload', async () => {
        const harness = await service();
        await deliver(harness, objectTopic('box-1'), {
            object_id: 'box-1',
            action: 'create',
            type: 'object',
            persist: true,
            realm: 'spoofed-realm',
            namespace: 'spoofed-namespace',
            sceneId: 'spoofed-scene',
            data: {position: {x: 1, y: 2, z: 3}},
        });
        const [filter, doc] = db.of('findOneAndUpdate')[0];
        assert.deepEqual(filter, {object_id: 'box-1', namespace: NAMESPACE, sceneId: SCENE});
        assert.equal(doc.realm, REALM);
        assert.equal(doc.namespace, NAMESPACE);
        assert.equal(doc.sceneId, SCENE);
        assert.deepEqual([...harness.persists], [key('box-1')]);
    });

    it('handles a message addressed to one user, where the topic carries a trailing recipient', async () => {
        const harness = await service();
        await deliver(harness, `${objectTopic('box-1')}/asmith_1448081342`, {
            object_id: 'box-1', action: 'create', type: 'object', persist: true, data: {},
        });
        assert.equal(db.of('findOneAndUpdate').length, 1);
        assert.deepEqual([...harness.persists], [key('box-1')]);
    });
});

describe('arenaMsgHandler create', () => {
    /**
     * A minimal box create message.
     * @param {Object} [overrides] - Fields to add or replace.
     * @return {Object} The message payload.
     */
    const box = (overrides = {}) => ({
        object_id: 'box-1',
        action: 'create',
        type: 'object',
        data: {object_type: 'box', position: {x: 0, y: 1.6, z: -2}},
        ...overrides,
    });

    it('upserts a persisted object with validators on, and remembers its key', async () => {
        const harness = await service();
        await deliver(harness, objectTopic('box-1'), box({persist: true}));
        const [filter, doc, options] = db.of('findOneAndUpdate')[0];
        assert.deepEqual(filter, {object_id: 'box-1', namespace: NAMESPACE, sceneId: SCENE});
        assert.deepEqual(doc.attributes, {object_type: 'box', position: {x: 0, y: 1.6, z: -2}});
        assert.equal(doc.type, 'object');
        assert.equal(doc.expireAt, undefined, 'no ttl means no expiry');
        assert.equal('_id' in doc, false, 'the generated document id is never written');
        assert.deepEqual(options, {upsert: true, runValidators: true});
        assert.deepEqual([...harness.persists], [key('box-1')]);
    });

    const notPersisted = [
        {name: 'persist is absent', payload: box()},
        {name: 'persist is false', payload: box({persist: false})},
        {name: 'persist is the string "true"', payload: box({persist: 'true'})},
        {name: 'persist is 1 rather than true', payload: box({persist: 1})},
        {name: 'only a ttl is given', payload: box({ttl: 30})},
    ];
    for (const {name, payload} of notPersisted) {
        it(`writes nothing when ${name}`, async () => {
            const harness = await service();
            await deliver(harness, objectTopic('box-1'), payload);
            assert.deepEqual(db.calls, []);
            assert.deepEqual([...harness.persists], []);
        });
    }

    it('sets expireAt one ttl from now for a persisted object with a ttl', async () => {
        const harness = await service();
        const before = Date.now();
        await deliver(harness, objectTopic('box-1'), box({persist: true, ttl: 30}));
        const after = Date.now();
        const [, doc] = db.of('findOneAndUpdate')[0];
        assert.ok(doc.expireAt instanceof Date);
        assert.ok(doc.expireAt.getTime() >= before + 30000, 'expiry is at least one ttl away');
        assert.ok(doc.expireAt.getTime() <= after + 30000, 'and no further');
    });

    it('tracks a ttl object for expiry, and leaves an object without one untracked', async () => {
        const harness = await service();
        await deliver(harness, objectTopic('ephemeral'), box({object_id: 'ephemeral', persist: true, ttl: -1}));
        await deliver(harness, objectTopic('forever'), box({object_id: 'forever', persist: true}));
        assert.deepEqual([...harness.persists].sort(), [key('ephemeral'), key('forever')]);
        await harness.publishExpires();
        const expired = harness.published.map(({payload}) => JSON.parse(payload).object_id);
        assert.deepEqual(expired, ['ephemeral'], 'only the object whose deadline passed is expired');
    });

    // Characterization, not endorsement: the in-memory key is added after the upsert, outside its
    // try block, so an object whose write failed is still remembered as persisted. A later update
    // for it then passes the persists check and is applied to a document that does not exist.
    it('still remembers the key when the upsert itself fails', async () => {
        const harness = await service();
        db.failures.findOneAndUpdate = new Error('not primary');
        await deliver(harness, objectTopic('box-1'), box({persist: true}));
        assert.deepEqual([...harness.persists], [key('box-1')]);
        assert.equal(logs.log.filter((line) => line.startsWith('Error creating object')).length, 1);
    });
});

describe('arenaMsgHandler update', () => {
    /**
     * An update to a box's colour, with one attribute cleared.
     * @param {Object} [overrides] - Fields to add or replace.
     * @return {Object} The message payload.
     */
    const update = (overrides = {}) => ({
        object_id: 'box-1',
        action: 'update',
        type: 'object',
        persist: true,
        data: {material: {color: '#ff0000'}, clickable: null},
        ...overrides,
    });

    it('ignores an update for an object it does not know to be persisted', async () => {
        const harness = await service();
        await deliver(harness, objectTopic('box-1'), update());
        assert.deepEqual(db.calls, [], 'an unknown object is never written');
    });

    it('applies a partial update as dotted $set with nulls turned into $unset', async () => {
        const harness = await service();
        harness.persists.add(key('box-1'));
        await deliver(harness, objectTopic('box-1'), update());
        const [filter, mutation] = db.of('findOneAndUpdate')[0];
        assert.deepEqual(filter, {object_id: 'box-1', namespace: NAMESPACE, sceneId: SCENE});
        assert.deepEqual(mutation, {
            $set: {'attributes.material.color': '#ff0000'},
            $unset: {'attributes.clickable': ''},
        });
        assert.equal(db.of('findOneAndReplace').length, 0);
    });

    it('replaces the whole document when the message asks to overwrite', async () => {
        const harness = await service();
        harness.persists.add(key('box-1'));
        await deliver(harness, objectTopic('box-1'), update({overwrite: true}));
        const [filter, doc] = db.of('findOneAndReplace')[0];
        assert.deepEqual(filter, {object_id: 'box-1', namespace: NAMESPACE, sceneId: SCENE});
        assert.deepEqual(doc.attributes, {material: {color: '#ff0000'}, clickable: null});
        assert.equal('_id' in doc, false);
        assert.equal(db.of('findOneAndUpdate').length, 0);
    });

    it('writes nothing when the update is not marked to persist', async () => {
        const harness = await service();
        harness.persists.add(key('box-1'));
        await deliver(harness, objectTopic('box-1'), update({persist: false}));
        assert.deepEqual(db.calls, []);
    });

    it('accepts any truthy persist flag on an update, unlike create', async () => {
        const harness = await service();
        harness.persists.add(key('box-1'));
        await deliver(harness, objectTopic('box-1'), update({persist: 'yes'}));
        assert.equal(db.of('findOneAndUpdate').length, 1);
    });

    it('starts tracking expiry when an update introduces a ttl', async () => {
        const harness = await service();
        harness.persists.add(key('later'));
        await deliver(harness, objectTopic('later'), update({object_id: 'later', ttl: -1}));
        await harness.publishExpires();
        assert.deepEqual(harness.published.map(({payload}) => JSON.parse(payload)), [
            {object_id: 'later', action: 'delete'},
        ]);
    });

    it('keeps the update in the scene the topic names', async () => {
        const harness = await service();
        harness.persists.add(key('box-1', 'private', 'office'));
        await deliver(harness, objectTopic('box-1', {namespace: 'private', sceneId: 'office'}), update());
        const [filter] = db.of('findOneAndUpdate')[0];
        assert.deepEqual(filter, {object_id: 'box-1', namespace: 'private', sceneId: 'office'});
    });
});

describe('arenaMsgHandler delete', () => {
    /**
     * A delete message for one object.
     * @param {string} objectId - object_id to delete.
     * @return {Object} The message payload.
     */
    const remove = (objectId) => ({object_id: objectId, action: 'delete', type: 'object', data: {}});

    it('ignores a delete for an object it does not know to be persisted', async () => {
        const harness = await service();
        await deliver(harness, objectTopic('box-1'), remove('box-1'));
        assert.deepEqual(db.calls, []);
    });

    it('deletes the object itself first, scoped to its scene', async () => {
        const harness = await service();
        harness.persists.add(key('box-1'));
        await deliver(harness, objectTopic('box-1'), remove('box-1'));
        assert.deepEqual(db.of('deleteOne')[0], [{object_id: 'box-1', namespace: NAMESPACE, sceneId: SCENE}]);
        assert.equal(db.calls[0][0], 'deleteOne', 'the root delete comes before any other query');
        assert.deepEqual([...harness.persists], [], 'and its key is forgotten');
    });

    it('deletes the descendants it finds, and forgets all of their keys', async () => {
        const harness = await service();
        for (const id of ['parent', 'child-1', 'child-2', 'grandchild', 'unrelated']) {
            harness.persists.add(key(id));
        }
        db.findRows.push([{object_id: 'child-1'}, {object_id: 'child-2'}]);
        db.findRows.push([{object_id: 'grandchild'}]);
        await deliver(harness, objectTopic('parent'), remove('parent'));
        const [firstLevel, projection, options] = db.of('find')[0];
        assert.deepEqual(firstLevel['attributes.parent'], {$in: ['parent']});
        assert.equal(firstLevel.namespace, NAMESPACE);
        assert.equal(firstLevel.sceneId, SCENE);
        assert.deepEqual(projection, {object_id: 1, _id: 0}, 'only the ids are transferred');
        assert.ok(options.limit > 0, 'and the query is bounded');
        assert.deepEqual(db.of('find')[1][0]['attributes.parent'], {$in: ['child-1', 'child-2']});
        const deleted = db.of('deleteMany').map(([filter]) => filter['object_id'].$in);
        assert.deepEqual(deleted, [['child-1', 'child-2'], ['grandchild']]);
        assert.deepEqual([...harness.persists], [key('unrelated')]);
    });

    it('sweeps template debris under a container id with an anchored, escaped prefix query', async () => {
        const harness = await service();
        const container = 'public|store::shelf';
        harness.persists.add(key(container));
        db.findRows.push([]); // no children by parent link
        db.findRows.push([{object_id: `${container}::box-1`}]);
        await deliver(harness, objectTopic(container), remove(container));
        const sweep = db.of('find')[1][0]['attributes.parent'];
        assert.ok(sweep instanceof RegExp);
        assert.equal(sweep.source, '^public\\|store::shelf::',
            'the | in the id is escaped, so the prefix cannot read as alternation');
        assert.deepEqual(db.of('deleteMany')[0][0]['object_id'].$in, [`${container}::box-1`]);
    });

    it('leaves the descendants alone when the object itself could not be deleted', async () => {
        const harness = await service();
        harness.persists.add(key('box-1'));
        db.failures.deleteOne = new Error('not primary');
        await deliver(harness, objectTopic('box-1'), remove('box-1'));
        assert.deepEqual(db.of('find'), [], 'no walk is attempted');
        assert.deepEqual([...harness.persists], [key('box-1')], 'and the key is kept so a retry gets through');
    });

    it('publishes nothing itself, since clients drop orphaned children on their own', async () => {
        const harness = await service();
        harness.persists.add(key('box-1'));
        await deliver(harness, objectTopic('box-1'), remove('box-1'));
        assert.deepEqual(harness.published, []);
    });
});

describe('arenaMsgHandler getPersist', () => {
    it('answers on the requesting topic with the live objects of the scene', async () => {
        const harness = await service();
        const rows = [{object_id: 'box-1'}, {object_id: 'box-2'}];
        db.findRows.push(rows);
        const topic = objectTopic('req-1');
        await deliver(harness, topic, {object_id: 'req-1', action: 'getPersist', type: 'object', data: {}});
        const [query, projection] = db.of('find')[0];
        assert.equal(query.namespace, NAMESPACE);
        assert.equal(query.sceneId, SCENE);
        assert.ok(query.expireAt.$not.$lt instanceof Date, 'expired objects are excluded');
        assert.equal(query.type, undefined);
        assert.deepEqual(projection, {_id: 0, realm: 0, namespace: 0, sceneId: 0, __v: 0});
        assert.equal(harness.published.length, 1);
        assert.equal(harness.published[0].topic, topic, 'the answer goes back on the topic it was asked on');
        assert.deepEqual(JSON.parse(harness.published[0].payload), {
            action: 'returnPersist',
            object_id: 'req-1',
            data: rows,
        });
    });

    it('filters by the type asked for in the request payload', async () => {
        const harness = await service();
        await deliver(harness, objectTopic('req-1'), {
            object_id: 'req-1', action: 'getPersist', type: 'object', data: {type: 'scene-options'},
        });
        assert.equal(db.of('find')[0][0].type, 'scene-options');
    });

    it('writes nothing to the database', async () => {
        const harness = await service();
        await deliver(harness, objectTopic('req-1'), {
            object_id: 'req-1', action: 'getPersist', type: 'object', data: {},
        });
        assert.deepEqual(db.calls.map(([name]) => name), ['find']);
    });
});

describe('publishExpires', () => {
    /**
     * Registers one object with a ttl and hands back the key it is tracked under.
     * @param {Object} harness - The harness from service().
     * @param {string} objectId - Object to create.
     * @param {number} ttl - Lifetime in seconds; negative values are already expired.
     * @param {Object} [scene] - namespace and sceneId overrides.
     * @return {Promise<void>} Settles once the create has been handled.
     */
    const createWithTtl = async (harness, objectId, ttl, scene = {}) => {
        await deliver(harness, objectTopic(objectId, scene), {
            object_id: objectId, action: 'create', type: 'object', persist: true, ttl, data: {},
        });
    };

    /**
     * Runs the expiry pass once and clears what it recorded, so a test starts from a drained map.
     * The expirations map is module state that outlives a single test.
     * @param {Object} harness - The harness from service().
     * @return {Promise<void>} Settles once the drain is done.
     */
    const drain = async (harness) => {
        await harness.publishExpires();
        db.reset();
        harness.published.length = 0;
        harness.persists.clear();
    };

    it('publishes a delete for an expired object on its own scene topic', async () => {
        const harness = await service();
        await drain(harness);
        await createWithTtl(harness, 'expired-1', -1);
        db.reset();
        harness.published.length = 0;
        await harness.publishExpires();
        assert.equal(harness.published.length, 1);
        assert.equal(harness.published[0].topic, TOPICS.PUBLISH.SCENE_OBJECTS.formatStr({
            nameSpace: NAMESPACE,
            sceneName: SCENE,
            userClient: harness.clientOptions.clientId,
            objectId: 'expired-1',
        }), 'the delete is published as the service client, not as the object owner');
        assert.deepEqual(JSON.parse(harness.published[0].payload), {object_id: 'expired-1', action: 'delete'});
        assert.deepEqual([...harness.persists], [], 'and the object is no longer persisted');
    });

    it('leaves an object whose deadline has not arrived alone, and expires it later', async () => {
        const harness = await service();
        await drain(harness);
        await createWithTtl(harness, 'pending-1', 3600);
        db.reset();
        harness.published.length = 0;
        await harness.publishExpires();
        assert.deepEqual(harness.published, []);
        assert.deepEqual(db.calls, [], 'and nothing is deleted');
        assert.deepEqual([...harness.persists], [key('pending-1')], 'it stays persisted');
    });

    it('expires each object once, however often the pass runs', async () => {
        const harness = await service();
        await drain(harness);
        await createWithTtl(harness, 'expired-2', -1);
        db.reset();
        harness.published.length = 0;
        await harness.publishExpires();
        await harness.publishExpires();
        assert.equal(harness.published.length, 1);
    });

    it('expires objects in every scene it tracks', async () => {
        const harness = await service();
        await drain(harness);
        await createWithTtl(harness, 'a', -1);
        await createWithTtl(harness, 'b', -1, {namespace: 'private', sceneId: 'office'});
        db.reset();
        harness.published.length = 0;
        await harness.publishExpires();
        assert.deepEqual(harness.published.map(({topic}) => topic.split('/').slice(2, 4).join('/')).sort(),
            ['private/office', 'public/lobby']);
    });

    // Characterization, not endorsement: expiry deletes only the objects whose parent is the
    // expired object, one level down, so a grandchild of an expired object is left in the database
    // as an orphan. The cascading delete used for an explicit delete message is not used here.
    // Pinned as current behaviour; fixing it is a separate change.
    it('deletes only the direct children of an expired object, one level down', async () => {
        const harness = await service();
        await drain(harness);
        await createWithTtl(harness, 'expired-parent', -1);
        db.reset();
        harness.published.length = 0;
        await harness.publishExpires();
        assert.deepEqual(db.calls.map(([name]) => name), ['deleteMany'], 'a single unbounded query, no walk');
        assert.deepEqual(db.of('deleteMany')[0], [{
            'attributes.parent': 'expired-parent',
            'namespace': NAMESPACE,
            'sceneId': SCENE,
        }]);
    });
});

describe('loadTemplate', () => {
    // Deliberately not the target namespace below: the template namespace and the target namespace
    // are two different positional arguments, and a fixture using one value for both cannot tell
    // them apart.
    const TEMPLATE_NS = 'templates';
    const TEMPLATE_SCENE = 'store';
    const INSTANCE = 'shelf';
    const PREFIX = `${TEMPLATE_NS}|${TEMPLATE_SCENE}::${INSTANCE}`;

    /**
     * A template object as it comes back from the database.
     * @param {string} objectId - object_id of the template object.
     * @param {Object} [attributes] - Its attributes.
     * @return {Object} The row, with the type every ARENA object carries.
     */
    const templateObj = (objectId, attributes = {}) => ({object_id: objectId, type: 'object', attributes});

    /**
     * Instantiates a template and returns what was written and published.
     * @param {Object} harness - The harness from service().
     * @param {Array<Object>} rows - Template objects the source scene holds.
     * @param {Object} [opts] - loadTemplate options.
     * @return {Promise<Object>} The created documents in order, and the published messages.
     */
    const instantiate = async (harness, rows, opts = {}) => {
        db.findRows.push(rows);
        await harness.loadTemplate(INSTANCE, REALM, TEMPLATE_NS, TEMPLATE_SCENE, 'public', 'atrium', opts);
        return {
            created: db.of('findOneAndUpdate').map(([, doc]) => doc),
            filters: db.of('findOneAndUpdate').map(([filter]) => filter),
            messages: harness.published.map(({topic, payload}) => ({topic, message: JSON.parse(payload)})),
        };
    };

    it('reads the template from the source scene', async () => {
        const harness = await service();
        await instantiate(harness, []);
        assert.deepEqual(db.of('find')[0], [{namespace: TEMPLATE_NS, sceneId: TEMPLATE_SCENE}]);
    });

    it('creates a container first, then every object prefixed and parented beneath it', async () => {
        const harness = await service();
        const {created, filters} = await instantiate(harness, [
            templateObj('shelf-1'),
            templateObj('can-1', {parent: 'shelf-1'}),
        ]);
        assert.deepEqual(created.map((doc) => doc.object_id), [
            PREFIX,
            `${PREFIX}::shelf-1`,
            `${PREFIX}::can-1`,
        ]);
        assert.equal(created[0].attributes.object_type, 'templateContainer');
        assert.equal(created[1].attributes.parent, PREFIX, 'a rootless template object hangs off the container');
        assert.equal(created[2].attributes.parent, `${PREFIX}::shelf-1`, 'and an existing parent is remapped');
        for (const filter of filters) {
            assert.equal(filter.namespace, 'public');
            assert.equal(filter.sceneId, 'atrium', 'everything lands in the target scene');
        }
    });

    it('writes the objects into the target scene while reading them from the template scene',
        async () => {
            const harness = await service();
            const {created} = await instantiate(harness, [templateObj('shelf-1')]);
            for (const doc of created) {
                assert.equal(doc.namespace, 'public');
                assert.equal(doc.sceneId, 'atrium');
                assert.equal(doc.realm, REALM);
            }
        });

    it('announces every created object as a create on its own topic', async () => {
        const harness = await service();
        const {messages} = await instantiate(harness, [templateObj('shelf-1')]);
        assert.deepEqual(messages.map(({message}) => message.action), ['create', 'create']);
        assert.equal(messages[1].topic, TOPICS.PUBLISH.SCENE_OBJECTS.formatStr({
            nameSpace: 'public',
            sceneName: 'atrium',
            userClient: harness.clientOptions.clientId,
            objectId: `${PREFIX}::shelf-1`,
        }));
        assert.deepEqual(messages[1].message.data, {parent: PREFIX});
    });

    it('clones a scene verbatim when told to skip the prefix and the container', async () => {
        const harness = await service();
        const {created, messages} = await instantiate(harness, [
            templateObj('shelf-1'),
            templateObj('can-1', {parent: 'shelf-1'}),
        ], {noPrefix: true, persist: true, noParent: true});
        assert.deepEqual(created.map((doc) => doc.object_id), ['shelf-1', 'can-1'],
            'no container, and the original ids are kept');
        assert.equal(created[0].attributes.parent, undefined, 'a rootless object stays rootless');
        assert.equal(created[1].attributes.parent, 'shelf-1', 'and a parent link is left as it was');
        assert.ok(messages.every(({message}) => message.persist === true), 'every clone is persisted');
    });

    it('marks the created objects as persisted only when asked to', async () => {
        const harness = await service();
        const transient = await instantiate(harness, [templateObj('shelf-1')]);
        assert.ok(transient.messages.every(({message}) => message.persist === undefined));
        db.reset();
        harness.published.length = 0;
        const kept = await instantiate(harness, [templateObj('shelf-2')], {persist: true});
        assert.ok(kept.messages.every(({message}) => message.persist === true));
    });

    it('gives the container the ttl it was asked for, and each object its own', async () => {
        const harness = await service();
        const before = Date.now();
        const {created, messages} = await instantiate(harness, [
            templateObj('balloon', {ttl: 60}),
            templateObj('shelf-1'),
        ], {ttl: 30});
        assert.ok(created[0].expireAt.getTime() >= before + 30000, 'the container expires with the instance');
        assert.ok(created[1].expireAt.getTime() >= before + 60000, 'and a template object keeps its own ttl');
        assert.equal(created[2].expireAt, undefined, 'an object without a ttl never expires');
        assert.deepEqual(messages.map(({message}) => message.ttl), [30, 60, undefined]);
        assert.ok(messages.slice(0, 2).every(({message}) => message.persist === true),
            'a ttl object is persisted so the expiry pass can find it again');
    });

    it('upserts each object by id and scene, so re-instantiating a template is idempotent', async () => {
        const harness = await service();
        const {filters} = await instantiate(harness, [templateObj('shelf-1')]);
        assert.deepEqual(filters[1], {namespace: 'public', object_id: `${PREFIX}::shelf-1`, sceneId: 'atrium'});
        assert.deepEqual(db.of('findOneAndUpdate')[1][2], {upsert: true});
    });
});

describe('arenaMsgHandler loadTemplate', () => {
    // templateNamespace is deliberately not NAMESPACE, the namespace the request itself arrives
    // in: the two are separate arguments to loadTemplate and a fixture reusing one value for both
    // cannot catch them being swapped.
    const TEMPLATE_NS = 'templates';
    const PREFIX = `${TEMPLATE_NS}|store::shelf`;

    /**
     * A loadTemplate request as a client sends it.
     * @param {Object} [attributes] - Request attributes to add or replace.
     * @return {Object} The message payload.
     */
    const request = (attributes) => ({
        object_id: 'req-1',
        action: 'loadTemplate',
        type: 'object',
        data: {
            templateNamespace: TEMPLATE_NS,
            templateSceneId: 'store',
            instanceId: 'shelf',
            ...attributes,
        },
    });

    it('does nothing when the template scene is empty', async () => {
        const harness = await service();
        db.counts.push(0);
        await deliver(harness, objectTopic('req-1'), request());
        assert.deepEqual(db.calls.map(([name]) => name), ['countDocuments'], 'no objects are read or written');
        assert.deepEqual(harness.published, []);
    });

    it('does nothing when that instance of the template already exists in the target scene', async () => {
        const harness = await service();
        db.counts.push(3); // template is not empty
        db.counts.push(1); // but the instance is already there
        await deliver(harness, objectTopic('req-1'), request());
        assert.deepEqual(db.of('countDocuments')[1], [{
            namespace: NAMESPACE,
            sceneId: SCENE,
            object_id: PREFIX,
        }]);
        assert.equal(db.of('findOneAndUpdate').length, 0);
    });

    it('instantiates the template into the scene the request came from', async () => {
        const harness = await service();
        db.counts.push(3);
        db.counts.push(0);
        db.findRows.push([{object_id: 'shelf-1', type: 'object', attributes: {}}]);
        await deliver(harness, objectTopic('req-1'), request({position: {x: 1, y: 0, z: 0}, ttl: 30}));
        const created = db.of('findOneAndUpdate').map(([, doc]) => doc);
        assert.equal(created.length, 2, 'a container and the one template object');
        for (const doc of created) {
            assert.equal(doc.namespace, NAMESPACE, 'the instance lands in the requesting scene');
            assert.equal(doc.sceneId, SCENE);
        }
        assert.equal(created[1].attributes.parent, created[0].object_id,
            'and the template object hangs off the container');
    });

    it('places the container at the position and rotation requested, and only the container',
        async () => {
            const harness = await service();
            db.counts.push(3);
            db.counts.push(0);
            db.findRows.push([
                {object_id: 'shelf-1', type: 'object', attributes: {}},
                {object_id: 'can-1', type: 'object', attributes: {position: {x: 9, y: 9, z: 9}}},
            ]);
            await deliver(harness, objectTopic('req-1'), request({
                position: {x: 1, y: 2, z: 3},
                rotation: {x: 0, y: 90, z: 0},
            }));
            const [container, child, posedChild] = db.of('findOneAndUpdate').map(([, doc]) => doc);
            assert.deepEqual(container.attributes, {
                position: {x: 1, y: 2, z: 3},
                rotation: {x: 0, y: 90, z: 0},
                object_type: 'templateContainer',
            });
            // The pose places the container; the children are positioned relative to it, so a pose
            // pushed onto them as well would move each one twice.
            assert.deepEqual(child.attributes, {parent: PREFIX},
                'a child of the container gains nothing but its parent link');
            assert.deepEqual(posedChild.attributes, {position: {x: 9, y: 9, z: 9}, parent: PREFIX},
                'and a child with a position of its own keeps it');
        });

    /**
     * Instantiates a template with one requested pose and returns the container's attributes.
     * @param {Object} harness - The harness from service().
     * @param {Object} [attributes] - Request attributes carrying the pose.
     * @return {Promise<Object>} The attributes the container was created with.
     */
    const containerFor = async (harness, attributes) => {
        db.reset();
        harness.published.length = 0;
        logs.log.length = 0;
        db.counts.push(3);
        db.counts.push(0);
        db.findRows.push([]);
        await deliver(harness, objectTopic('req-1'), request(attributes));
        return db.of('findOneAndUpdate')[0][1].attributes;
    };

    it('falls back to the default pose for whatever the request leaves out', async () => {
        const harness = await service();
        assert.deepEqual(await containerFor(harness), {
            position: {x: 0, y: 0, z: 0},
            rotation: {x: 0, y: 0, z: 0},
            object_type: 'templateContainer',
        }, 'a request with no pose at all leaves the container at the origin');
        assert.deepEqual(await containerFor(harness, {position: {x: 1, y: 2, z: 3}}), {
            position: {x: 1, y: 2, z: 3},
            rotation: {x: 0, y: 0, z: 0},
            object_type: 'templateContainer',
        }, 'and a request with only a position keeps the default rotation');
    });

    it('fills in the axes a partial pose leaves out, rather than dropping the default', async () => {
        const harness = await service();
        assert.deepEqual((await containerFor(harness, {position: {}})).position, {x: 0, y: 0, z: 0},
            'an empty position is the origin, not a container with nowhere to be');
        assert.deepEqual((await containerFor(harness, {position: {x: 1}})).position, {x: 1, y: 0, z: 0},
            'and one named axis keeps the default for the two it does not name');
        assert.deepEqual((await containerFor(harness, {rotation: {y: 90}})).rotation, {x: 0, y: 90, z: 0},
            'the same holds for rotation');
        assert.deepEqual((await containerFor(harness, {position: {x: 1}})).rotation, {x: 0, y: 0, z: 0},
            'and a partial position still leaves the rotation alone');
    });

    it('ignores a pose component it cannot place an object with, and says so', async () => {
        const harness = await service();
        const origin = {x: 0, y: 0, z: 0};
        // attributes is Mixed in the schema and createArenaObj runs no validators, so without this
        // any of these would reach both Mongo and the broker verbatim.
        for (const position of ['nope', 42, true, [1, 2, 3], {x: 'a', y: 'b', z: 'c'},
            {x: NaN, y: 0, z: 0}, {x: Infinity, y: 0, z: 0}, {x: null, y: 0, z: 0},
            {x: {y: 1}, y: 0, z: 0}]) {
            const attributes = await containerFor(harness, {position});
            assert.deepEqual(attributes.position, origin,
                `${JSON.stringify(position)} leaves the container at the origin`);
            assert.ok(logs.log.some((line) => line.includes('Ignoring template container position')),
                `${JSON.stringify(position)} is logged rather than silently dropped`);
        }
        assert.deepEqual((await containerFor(harness, {position: {x: 1, y: 'two', z: 3}})).position,
            {x: 1, y: 0, z: 3}, 'a single unusable axis costs only that axis');
        assert.deepEqual((await containerFor(harness, {position: null})).position, origin,
            'and an explicit null is just an absent position, so it is not worth a log');
        assert.deepEqual(logs.log.filter((line) => line.includes('Ignoring template container')), []);
    });

    it('reads the template from the namespace and scene the request names, and names the instance from them',
        async () => {
            const harness = await service();
            db.counts.push(3);
            db.counts.push(0);
            db.findRows.push([{object_id: 'shelf-1', type: 'object', attributes: {}}]);
            await deliver(harness, objectTopic('req-1'), request());
            assert.deepEqual(db.of('find')[0], [{namespace: TEMPLATE_NS, sceneId: 'store'}],
                'the template namespace and scene id are used as they were given, not the target ones');
            const [, container] = db.of('findOneAndUpdate')[0];
            assert.equal(container.realm, REALM, 'the objects are stamped with the requesting realm');
            for (const [filter] of db.of('findOneAndUpdate')) {
                assert.equal(filter.namespace, NAMESPACE, 'while the writes go to the target namespace');
                assert.equal(filter.sceneId, SCENE);
            }
            assert.deepEqual(db.of('findOneAndUpdate').map(([, doc]) => doc.object_id),
                [PREFIX, `${PREFIX}::shelf-1`],
                'and every created id carries the template and instance prefix');
        });

    it('refuses to instantiate the same template into the same scene twice', async () => {
        const harness = await service();
        db.counts.push(3); // the template is not empty
        db.counts.push(0); // and nothing of this instance is in the target scene yet
        db.findRows.push([{object_id: 'shelf-1', type: 'object', attributes: {}}]);
        await deliver(harness, objectTopic('req-1'), request());
        const [, container] = db.of('findOneAndUpdate')[0];
        db.reset();
        harness.published.length = 0;
        db.counts.push(3); // the template is still there
        db.counts.push(1); // and so is the instance the first request created
        await deliver(harness, objectTopic('req-1'), request());
        assert.deepEqual(db.of('countDocuments')[1], [{
            namespace: NAMESPACE,
            sceneId: SCENE,
            object_id: container.object_id,
        }], 'the guard looks for exactly the container id the first instantiation created');
        assert.equal(db.of('findOneAndUpdate').length, 0, 'so the second request writes nothing');
        assert.deepEqual(harness.published, [], 'and announces nothing');
    });

    // Both halves of the template's address are required. Until the emptiness check was made to
    // require both, a request naming only one fell straight through to loadTemplate, where mongoose
    // drops the undefined key from the filter: the lookup widened to every object sharing the half
    // that was given - or, with neither given, to the whole collection - and every one of them was
    // cloned into the requesting scene and announced on the broker.
    for (const [description, missing] of [
        ['no template namespace', {templateNamespace: undefined}],
        ['no template scene', {templateSceneId: undefined}],
        ['neither a template namespace nor a template scene',
            {templateNamespace: undefined, templateSceneId: undefined}],
        ['an empty template namespace', {templateNamespace: ''}],
        ['an empty template scene', {templateSceneId: ''}],
    ]) {
        it(`refuses a request naming ${description}, without reading anything`, async () => {
            const harness = await service();
            // Enough canned answers that the request would sail through every guard if it got
            // that far, and a template object waiting to be cloned if it reached the lookup.
            db.counts.push(3);
            db.counts.push(0);
            db.findRows.push([{object_id: 'shelf-1', type: 'object', attributes: {}}]);
            await deliver(harness, objectTopic('req-1'), request(missing));
            assert.deepEqual(db.calls, [], 'nothing is counted, nothing is read and nothing is written');
            assert.deepEqual(harness.published, [], 'and nothing is announced');
            assert.ok(logs.log.some((line) => line.includes('Ignoring loadTemplate request')),
                'the request is logged rather than dropped in silence');
        });
    }
});

// Kept last: these handlers replace module state that later tests would otherwise inherit.
describe('MQTT connection events', () => {
    it('stops the expiry pass while the broker is offline, and again on a clean disconnect', async () => {
        const harness = await service();
        const clearedBefore = harness.cleared.length;
        await harness.events.offline();
        assert.equal(harness.cleared.length, clearedBefore + 1);
        await harness.events.disconnect();
        assert.equal(harness.cleared.length, clearedBefore + 2);
    });

    it('logs a broker error rather than letting it escape', async () => {
        const harness = await service();
        harness.events.error(new Error('ECONNRESET'));
        assert.ok(logs.log.includes('error'));
    });

    it('restarts the expiry pass on reconnect, after resyncing what is persisted', async () => {
        const harness = await service();
        const timersBefore = harness.intervals.length;
        db.findRows.push([{namespace: 'public', sceneId: 'lobby', object_id: 'from-db'}]);
        await harness.events.reconnect();
        assert.deepEqual(db.of('find')[0], [{}, {'object_id': 1, 'namespace': 1, 'sceneId': 1, '_id': 0}]);
        assert.equal(harness.intervals.length, timersBefore + 1, 'a fresh expiry timer is scheduled');
        assert.equal(harness.intervals[harness.intervals.length - 1].ms, 1000);
    });

    // Characterization, not endorsement: the resync replaces the persists set rather than
    // refilling it, so the set that was handed to the express server on startup is no longer the
    // one the message handler uses. Pinned so the aliasing is visible; fixing it is a separate
    // change.
    it('leaves the set the express server holds behind when it resyncs', async () => {
        const harness = await service();
        db.findRows.push([]);
        await harness.events.reconnect();
        await deliver(harness, objectTopic('after-reconnect'), {
            object_id: 'after-reconnect', action: 'create', type: 'object', persist: true, data: {},
        });
        assert.equal(db.of('findOneAndUpdate').length, 1, 'the object is still written');
        assert.deepEqual([...harness.persists], [],
            'but the set the express server prunes on scene delete never learns about it');
    });
});
