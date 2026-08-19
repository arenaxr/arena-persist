#!/usr/bin/env node
'use strict';

const config = require('./config.json');
const fs = require('fs');
const mongoose = require('mongoose');
const mqtt = require('async-mqtt');
const {clearIntervalAsync, setIntervalAsync} = require('set-interval-async/dynamic');

const {runExpress} = require('./express_server');
const {buildForget, deleteObjectAndDescendants} = require('./cascade');
const {asyncForEach, asyncMapForEach, escapeRegExp, filterNulls, flatten} = require('./utils');
const {TOPICS} = require('./topics');

let jwk;
let jose;

async function loadJose() {
    jose = await import('jose');
    if (config.jwt_public_keyfile) {
        // TODO: Does alg need to be parameterized?
        try {
            jwk = await jose.importSPKI(fs.readFileSync(config.jwt_public_keyfile, 'utf8'), 'RS256');
        } catch (e) {
            console.error(`Error loading public key: ${config.jwt_public_keyfile}`);
            process.exit();
        }
    }
}

const arenaSchema = new mongoose.Schema({
    object_id: {type: String, required: true, index: true},
    type: {type: String, required: true, index: true},
    attributes: {type: Object, required: true, default: {}},
    expireAt: {type: Date, expires: 0},
    realm: {type: String, required: true, index: true},
    namespace: {type: String, required: true, index: true, default: 'public'},
    sceneId: {type: String, required: true, index: true},
    private: {type: Boolean},
    program_id: {type: String},
}, {
    timestamps: true,
    minimize: false, // Try to enforce attributes being valid object for $set and $unset
});
arenaSchema.index({'attributes.parent': 1}, {sparse: true});

const ArenaObject = mongoose.model('ArenaObject', arenaSchema);

let mqttClient;
let mqttClientOptions;
// One set for the life of the process. express_server.js and cascade.js are handed this
// object and keep their own reference to it, so it is refilled in place on every resync
// rather than replaced: rebinding it here would leave them working on an abandoned copy.
const persists = new Set();
// Every key added or removed while a resync query was in flight, mapped to whether it was still
// persisted after the last of those changes. That query's result predates all of them, so
// refilling from it alone would undo every one: a create would be dropped, and a delete would be
// reversed. resyncPersists() replays this over the refill. Emptied when a resync window opens.
const persistsChangedDuringResync = new Map();
let resyncsInFlight = 0;
let expirations;
let expireTimer;
let persistUpdateTimeout;

/**
 * Records a key in the persists set, keeping it through a resync that is already in flight.
 * @param {string} key - namespace|sceneId|object_id of the object that is now persisted.
 */
function rememberPersist(key) {
    persists.add(key);
    if (resyncsInFlight > 0) {
        persistsChangedDuringResync.set(key, true);
    }
}

/**
 * Drops a key from the persists set, keeping it dropped through a resync already in flight.
 *
 * This is the only sanctioned way to remove a key, and every removal site goes through it: the
 * expiry pass below, cascade.js's forget (which is handed this rather than the set itself), and
 * express_server.js's scene-delete prune (which is handed it as forgetPersist). A site that
 * called persists.delete directly would have its removal undone by the next refill, leaving a
 * key behind for a document that is already gone.
 * @param {string} key - namespace|sceneId|object_id of the object that is no longer persisted.
 */
function forgetPersist(key) {
    persists.delete(key);
    if (resyncsInFlight > 0) {
        persistsChangedDuringResync.set(key, false);
    }
}

/**
 * The persists set as cascade.js should mutate it. buildForget only ever deletes from the
 * collection it is handed, and a delete has to be recorded against an in-flight resync, so it is
 * given this rather than the set itself.
 */
const persistsRemovals = {delete: forgetPersist};

/**
 * Refills the persists set from the database, keeping the same set object.
 *
 * Two things are guaranteed:
 *
 * - No handler observes the set empty or half-filled. Every key is read before anything is
 *   dropped, and the clear-and-refill that follows runs to completion in a single turn with no
 *   await in it, so a handler scheduled around it sees either the whole previous contents or the
 *   whole refreshed ones. Nothing may be awaited between the clear and the end of the refill.
 * - A change made while the query was in flight wins over what that query returned, in either
 *   direction. The result predates the change, so refilling from it alone would undo it: a key
 *   the handler had just persisted would be dropped, leaving the object invisible to the handler
 *   until the next refresh — an hour of its updates discarded and a delete for it ignored — and a
 *   key a delete had just removed would come back, letting later messages past the guard and on to
 *   a document that is already gone. Both are avoided by replaying those changes over the refill,
 *   which is why rememberPersist and forgetPersist are the only ways the set is mutated.
 * @return {Promise<void>}
 */
async function resyncPersists() {
    if (resyncsInFlight === 0) {
        // Start of a fresh window. Anything left from an earlier one, including from a resync
        // whose query was rejected, already agrees with persists and must not be replayed again:
        // a key removed since that window closed would be resurrected by replaying its create.
        persistsChangedDuringResync.clear();
    }
    resyncsInFlight++;
    let keys;
    try {
        keys = (await ArenaObject.find({}, {
            'object_id': 1,
            'namespace': 1,
            'sceneId': 1,
            '_id': 0,
        })).map((o) => `${o.namespace}|${o.sceneId}|${o.object_id}`);
    } finally {
        resyncsInFlight--;
    }
    persists.clear();
    for (const key of keys) {
        persists.add(key);
    }
    for (const [key, stillPersisted] of persistsChangedDuringResync) {
        if (stillPersisted) {
            persists.add(key);
        } else {
            persists.delete(key);
        }
    }
}

/**
 * Reads the persisted keys for the first time and starts the hourly refresh.
 *
 * Unlike the refresh below, this does not swallow a failure. An empty persists set is not a
 * degraded service, it is a silently wrong one: every update for an object that already exists
 * fails the guard and is discarded, and every delete for one is ignored, with nothing logged per
 * message and no client told. Serving that for up to an hour is worse than not starting, so the
 * rejection is left to end startup.
 * @return {Promise<void>}
 */
async function startPersists() {
    await resyncPersists();
    persistUpdateTimeout = setTimeout(updatePersists, 60 * 60 * 1000);
}

/**
 * Force refresh of the persists set every hour
 *
 * A failure here is swallowed, unlike the first read at startup: by this point the set holds the
 * previous refresh's keys rather than nothing, so carrying on with slightly stale contents and
 * trying again in an hour costs less than ending a running service. The reschedule is in a
 * finally because this runs as a bare setTimeout callback: a rejection escaping it would be an
 * unhandled rejection that ends the process, and a reschedule reached only on success would let
 * one failed query stop every later refresh.
 * @return {Promise<void>}
 */
async function updatePersists() {
    if (persistUpdateTimeout) {
        clearTimeout(persistUpdateTimeout);
    }
    try {
        await resyncPersists();
    } catch (err) {
        console.log('Error refreshing persists: ', err);
    } finally {
        persistUpdateTimeout = setTimeout(updatePersists, 60 * 60 * 1000);
    }
}

mongoose.connect(config.mongodb.uri).then(async () => {
    console.log('Connected to Mongodb');
    await loadJose();
    await startPersists();
    await runMQTT();
    await runExpress({
        ArenaObject,
        mqttClient,
        jwk,
        mongooseConnection: mongoose.connection,
        loadTemplate,
        persists,
        forgetPersist,
        jose,
    });
}).catch((err) => {
    // Exit, rather than log and carry on. Nothing in the chain above is optional, and mongoose
    // keeps handles of its own open, so a process left alive here would hang forever with no MQTT
    // subscription and no REST server while looking to its supervisor like a service that started.
    // Exiting non-zero is what gets it restarted, and what makes the failure visible at all.
    console.error('Fatal error starting the persistence service: ', err);
    process.exit(1);
});

/**
 * Initializes MQTT connection and setts event handlers
 */
async function runMQTT() {
    mqttClientOptions = {
        clientId: 'arena_persist' + config.mqtt.topic_realm + '_' + Math.floor(Math.random() * 100),
        clean: false, // Receive QoS 1+ messages (object delete) always
        qos: 1,
        will: {
            topic: config.mqtt.statusTopic,
            payload: 'Persistence service disconnected: ' + config.mqtt.topic_realm,
        },
    };
    if (jwk) {
        mqttClientOptions.username = config.jwt_service_user;
        mqttClientOptions.password = config.jwt_service_token;
        try {
            const claims = jose.decodeJwt(config.jwt_service_token);
            if (claims.exp) {
                const now = Math.floor(Date.now() / 1000);
                if (claims.exp < now) {
                    console.error('--------------------------------------------------------------------------------');
                    console.error('CRITICAL ERROR: The MQTT service token (config.json->`jwt_service_token`) has EXPIRED.');
                    console.error(`Expiration Time: ${new Date(claims.exp * 1000).toLocaleString()}`);
                    console.error(`Current Time:    ${new Date().toLocaleString()}`);
                    console.error('MQTT connection will likely fail with "Access Denied".');
                    console.error('Please create new service tokens with `init-config.sh` script.');
                    console.error('--------------------------------------------------------------------------------');
                }
            }
        } catch (err) {
            console.error('Warning: Failed to decode jwt_service_token for expiration check:', err.message);
        }
    }
    mqttClient = await mqtt.connectAsync(config.mqtt.uri, mqttClientOptions);
    console.log('Connected to MQTT');
    mqttClient.on('offline', async () => {
        if (expireTimer) {
            await clearIntervalAsync(expireTimer);
        }
        console.log('offline, timer off');
    });
    mqttClient.on('reconnect', async () => {
        console.log('reconnect');
        // Resync. A rejection must not escape: this is a bare async event handler, so it would
        // be an unhandled rejection that ends the process, and the expiry pass below still has
        // to be restarted whether or not the keys could be read back.
        try {
            await resyncPersists();
        } catch (err) {
            console.log('Error resyncing persists on reconnect: ', err);
        }
        if (expireTimer) {
            await clearIntervalAsync(expireTimer);
        }
        expireTimer = setIntervalAsync(publishExpires, 1000);
    });
    mqttClient.on('connect', () => {
        console.log('connect');
    });
    mqttClient.on('disconnect', async () => {
        if (expireTimer) {
            await clearIntervalAsync(expireTimer);
        }
        console.log('disconnect');
    });
    mqttClient.on('error', (err) => {
        console.log('error');
        console.log(err);
    });
    try {
        await mqttClient.subscribe(TOPICS.PUBLISH.SCENE_OBJECTS.formatStr({
            nameSpace: '+',
            sceneName: '+',
            userClient: '+',
            objectId: '+',
        }), {
            qos: 1,
        }).then(async () => {
            expirations = new Map();
            if (expireTimer) {
                await clearIntervalAsync(expireTimer);
            }
            expireTimer = setIntervalAsync(publishExpires, 1000);
            await mqttClient.publish(config.mqtt.statusTopic,
                'Persistence service connected: ' + config.mqtt.topic_realm);
        });
        mqttClient.on('message', arenaMsgHandler);
    } catch (e) {
        console.log(e.stack);
    }
}

/**
 * Key an object is remembered under, in both persists and expirations.
 * @param {object} arenaObj - Object following the ArenaObject schema.
 * @return {string} namespace|sceneId|object_id
 */
function objKey(arenaObj) {
    return `${arenaObj.namespace}|${arenaObj.sceneId}|${arenaObj.object_id}`;
}

/**
 * Records an object as persisted, and tracks it for expiry when it has one.
 *
 * Called with whatever the database actually holds, and only ever from outside the try
 * that wraps a write: a throw from here would otherwise be caught by that write's catch
 * and reported as a failed write, leaving a stored object unremembered.
 *
 * The key goes in through rememberPersist rather than persists.add so that a key recovered
 * here is also recorded against a resync that is already in flight. Otherwise the refill
 * would replay a query result that predates this create and drop the key again, which is
 * the case this read-back exists to close.
 * @param {object} arenaObj - Object following the ArenaObject schema, as stored.
 */
function rememberPersisted(arenaObj) {
    if (arenaObj.expireAt) {
        expirations.set(objKey(arenaObj), arenaObj);
    }
    rememberPersist(objKey(arenaObj));
}

/**
 * Reads back the stored document of an object whose write rejected.
 *
 * A rejected write has not necessarily been rolled back: a lost acknowledgement, or a
 * write concern that could not be met after the write applied, both reject while leaving
 * the document in place. Bookkeeping keyed off the rejection alone would then be missing
 * an object that is really there, and every later update and delete for it would be
 * dropped by the persists checks until the hourly refresh puts the key back.
 *
 * Nothing is thrown from here. The connection that just failed a write very often fails
 * this read too, and that must not replace the original failure or escape the handler;
 * a null answer only means the object is left to the hourly refresh.
 * @param {object} arenaObj - The object whose write rejected.
 * @return {Promise<object|null>} The stored document, or null if there is none to be read.
 */
async function findStoredObject(arenaObj) {
    try {
        return await ArenaObject.findOne({
            object_id: arenaObj.object_id,
            namespace: arenaObj.namespace,
            sceneId: arenaObj.sceneId,
        });
    } catch (err) {
        console.log('Could not read back object after failed write: ', arenaObj.object_id, err);
        return null;
    }
}

/**
 * Handles incoming mqtt messages to update persist
 * @param {string} topic
 * @param {string} message
 * @return {Promise<void>}
 */
async function arenaMsgHandler(topic, message) {
    const topicSplit = topic.split('/');
    /*
    Topic tokens by forward slash:
    - 0: realm
    - 1: type [s, n, r, topology, flows]
    - 2: namespace
    - 3: sceneId
    - 4: sceneMsg type
    - 5: object_id
    - 6: toUid (not relevant for persist)
    */
    let msgJSON;
    let arenaObj;
    const now = new Date();
    try {
        msgJSON = JSON.parse(message.toString());

        // Verify topicObjId is same as json payload id
        const topicObjId = topicSplit[TOPICS.TOKENS.UUID];
        if (msgJSON.object_id !== topicObjId) {
            return;
        }

        arenaObj = new ArenaObject({
            object_id: msgJSON.object_id,
            attributes: msgJSON.data,
            expireAt: undefined,
            type: msgJSON.type,
            realm: topicSplit[TOPICS.TOKENS.REALM],
            namespace: topicSplit[TOPICS.TOKENS.NAMESPACE],
            sceneId: topicSplit[TOPICS.TOKENS.SCENENAME],
        });
        if (msgJSON.ttl) {
            if (msgJSON.persist && msgJSON.persist !== false) {
                arenaObj.expireAt = new Date(now.getTime() + (msgJSON.ttl * 1000));
            }
        }
    } catch (e) {
        return;
    }
    const insertObj = arenaObj.toObject();
    delete insertObj._id;
    switch (msgJSON.action) {
    case 'create':
        if (msgJSON.persist === true) {
            // The object to remember as persisted, if any: the one just written, or - when the
            // write rejected but the document turns out to be stored anyway - the document that
            // is stored. Bookkeeping runs after the try, never inside it, and never removes a
            // key or an expiry the object already had: a create can fail for an object that is
            // genuinely persisted, and dropping its key would start discarding valid updates
            // for it.
            let stored = null;
            try {
                await ArenaObject.findOneAndUpdate({
                    object_id: arenaObj.object_id,
                    namespace: arenaObj.namespace,
                    sceneId: arenaObj.sceneId,
                }, insertObj, {
                    upsert: true,
                    runValidators: true,
                });
                stored = arenaObj;
            } catch (err) {
                // Logged and not rethrown, as before: this handler is called by the MQTT
                // client with no caller to catch anything.
                console.log('Error creating object: ', arenaObj.object_id, err);
                stored = await findStoredObject(arenaObj);
            }
            if (stored) {
                rememberPersisted(stored);
            }
        }
        break;
    case 'update':
        if (msgJSON.persist && msgJSON.persist !== false) {
            if (persists.has(
                `${arenaObj.namespace}|${arenaObj.sceneId}|${arenaObj.object_id}`)) {
                // Whether the database holds the document this message's deadline would apply
                // to. Both calls below resolve to the matched document, or to null when the
                // filter matched nothing - a no-match does not reject - so the result decides
                // this rather than the mere absence of a rejection. A persists key can outlive
                // its document, which is the stale-key state this branch exists to narrow, and
                // for such a key the write matches nothing while resolving perfectly well.
                let written = false;
                if (msgJSON.overwrite) {
                    try {
                        const replaced = await ArenaObject.findOneAndReplace(
                            {
                                object_id: arenaObj.object_id,
                                namespace: arenaObj.namespace,
                                sceneId: arenaObj.sceneId,
                            },
                            insertObj,
                        );
                        written = replaced !== null && replaced !== undefined;
                        if (!written) {
                            console.log('Does not exist to update:', arenaObj.object_id);
                        }
                    } catch (err) {
                        console.log('Error overwriting object: ', arenaObj.object_id, err);
                    }
                } else {
                    const [sets, unSets] = filterNulls(
                        flatten({attributes: insertObj.attributes}));
                    try {
                        const updated = await ArenaObject.findOneAndUpdate(
                            {
                                object_id: arenaObj.object_id,
                                namespace: arenaObj.namespace,
                                sceneId: arenaObj.sceneId,
                            },
                            {$set: sets, $unset: unSets},
                        );
                        written = updated !== null && updated !== undefined;
                        if (!written) {
                            console.log('Does not exist:', arenaObj.object_id);
                        }
                    } catch (err) {
                        console.log('Error updating object: ', arenaObj.object_id, err);
                    }
                }
                if (arenaObj.expireAt) {
                    if (written) {
                        expirations.set(
                            `${arenaObj.namespace}|${arenaObj.sceneId}|${arenaObj.object_id}`,
                            arenaObj,
                        );
                    } else {
                        // The write either rejected or matched nothing, so this message's
                        // deadline is not known to be the stored one. Tracking it anyway is
                        // worse than not tracking it: the expiry pass would publish a delete
                        // for an object the database still has, sweep its children, and drop
                        // its persists key, leaving a parent no client can see and no message
                        // can reach until the hourly refresh. What the database does hold is
                        // still worth following, in case the write landed and only its
                        // acknowledgement was lost, or the key is stale and there is nothing
                        // there to expire at all.
                        const stored = await findStoredObject(arenaObj);
                        if (stored && stored.expireAt) {
                            expirations.set(objKey(stored), stored);
                        }
                    }
                }
            }
        }
        break;
    case 'delete':
        if (persists.has(
            `${arenaObj.namespace}|${arenaObj.sceneId}|${arenaObj.object_id}`)) {
            await deletePersistedObject(arenaObj);
        }
        break;
    case 'loadTemplate':
        await handleLoadTemplate(arenaObj);
        break;
    case 'getPersist':
        await handleGetPersist(arenaObj, topic);
        break;
    default:
        // pass
    }
}

/**
 * Removes a persisted object, every descendant of it at any depth, and the
 * in-memory keys of all of them.
 *
 * Only the database work is done here: clients drop objects orphaned by a deleted
 * parent themselves, so no delete is published for the descendants. The ordering,
 * the bounded walk and the broken-chain sweep all live in cascade.js; this function
 * is only the MongoDB and in-memory-collection adapter for them.
 *
 * If any part of that fails, this object's persists key is deliberately left in
 * place even though its document is gone, so that a repeated delete gets past the
 * caller's persists check and can finish removing what is still below it.
 * @param {object} arenaObj - The object to delete, following ArenaObject schema
 * @return {Promise<void>}
 */
async function deletePersistedObject(arenaObj) {
    const scope = {namespace: arenaObj.namespace, sceneId: arenaObj.sceneId};
    await deleteObjectAndDescendants({
        objectId: arenaObj.object_id,
        namespace: arenaObj.namespace,
        sceneId: arenaObj.sceneId,
    }, {
        deleteRoot: async () => {
            await ArenaObject.deleteOne({
                object_id: arenaObj.object_id,
                namespace: scope.namespace,
                sceneId: scope.sceneId,
            });
        },
        findChildIds: async (parentIds, limit) => {
            const children = await ArenaObject.find({
                'attributes.parent': {$in: parentIds},
                'namespace': scope.namespace,
                'sceneId': scope.sceneId,
            }, {object_id: 1, _id: 0}, {limit});
            return children.map((child) => child.object_id);
        },
        findOrphanIds: async (parentPrefix, limit) => {
            // Anchored, and with the prefix escaped: object ids carry '|' and '.',
            // which an unescaped prefix would turn into alternation and wildcards.
            const anchored = RegExp('^' + escapeRegExp(parentPrefix));
            const orphans = await ArenaObject.find({
                'attributes.parent': anchored,
                'namespace': scope.namespace,
                'sceneId': scope.sceneId,
            }, {object_id: 1, _id: 0}, {limit});
            return orphans.map((orphan) => orphan.object_id);
        },
        deleteIds: async (objectIds) => {
            await ArenaObject.deleteMany({
                'object_id': {$in: objectIds},
                'namespace': scope.namespace,
                'sceneId': scope.sceneId,
            });
        },
        forget: buildForget(persistsRemovals, expirations, scope),
    });
}

/**
 * @param {object} arenaObj
 * @param {string} topic
 */
async function handleGetPersist(arenaObj, topic) {
    const now = new Date();
    const query = {
        sceneId: arenaObj.sceneId,
        namespace: arenaObj.namespace,
        expireAt: {$not: {$lt: now}},
    };
    if (arenaObj.attributes.type) {
        query.type = arenaObj.attributes.type;
    }
    ArenaObject.find(query,
        {_id: 0, realm: 0, namespace: 0, sceneId: 0, __v: 0}).
        then((records) => {
            mqttClient.publish(topic, JSON.stringify({
                action: 'returnPersist',
                object_id: arenaObj.object_id,
                data: records,
            }));
        });
}

/**
 * Handles loadTemplate requests from MQTT
 * @param {object} arenaObj - Following ArenaObject schema
 */
async function handleLoadTemplate(arenaObj) {
    const a = arenaObj.attributes;
    // Both halves of the template's address are required. A request missing either one used to
    // fall past the emptiness check below and reach loadTemplate, where mongoose drops the
    // undefined key from the filter, so the lookup widened to every object sharing the half that
    // was given - or, with both missing, to the whole collection - and cloned all of it into the
    // requesting scene. Refuse the request instead of guessing what it meant.
    if (!a.templateNamespace || !a.templateSceneId) {
        console.log('Ignoring loadTemplate request without both a template namespace and scene',
            arenaObj.namespace, arenaObj.sceneId, arenaObj.object_id);
        return;
    }
    const opts = {
        ttl: a.ttl,
        persist: a.persist,
        pose: {
            position: a.position,
            rotation: a.rotation,
        },
    };
    // Make sure the template isn't empty
    if (await ArenaObject.countDocuments({
        namespace: a.templateNamespace,
        sceneId: a.templateSceneId,
    }) === 0) {
        return;
    }
    if (a.instanceId) { // Make sure this instance does not exist in target
        if (await ArenaObject.countDocuments({
            namespace: arenaObj.namespace,
            sceneId: arenaObj.sceneId,
            object_id: `${a.templateNamespace}|${a.templateSceneId}::${a.instanceId}`,
        }) > 0) {
            return;
        }
    }
    await loadTemplate(
        a.instanceId,
        arenaObj.realm,
        a.templateNamespace,
        a.templateSceneId,
        arenaObj.namespace,
        arenaObj.sceneId,
        opts,
    );
}

/**
 * Creates an arena object with given paramters
 * @param {string} object_id - id of object
 * @param {string} type - generally "object" or "scene-options"
 * @param {string} realm - MQTT topic realm
 * @param {string} namespace - namespace of sceneId
 * @param {string} sceneId - sceneId of object
 * @param {Object} attributes - data payload of message
 * @param {boolean} [persist] - Whether to persist this object
 * @param {Number} [ttl] - ttl in seconds
 */
const createArenaObj = async (
    // eslint-disable-next-line camelcase
    object_id, type, realm, namespace, sceneId, attributes, persist, ttl) => {
    let expireAt;
    const msg = {
        // eslint-disable-next-line camelcase
        object_id: object_id,
        action: 'create',
        type: type,
        data: attributes,
    };
    if (persist || ttl) {
        msg.persist = true;
    }
    if (ttl) {
        msg.ttl = ttl;
        expireAt = new Date(new Date().getTime() + (ttl * 1000));
    }
    const arenaObj = new ArenaObject({
        // eslint-disable-next-line camelcase
        object_id: object_id,
        type: type,
        attributes: attributes,
        expireAt: expireAt,
        realm: realm,
        namespace: namespace,
        sceneId: sceneId,
    }).toObject();
    try {
        await ArenaObject.findOneAndUpdate({
            namespace: namespace,
            // eslint-disable-next-line camelcase
            object_id: object_id,
            sceneId: sceneId,
        }, arenaObj, {
            upsert: true,
        });
    } catch (err) {
        console.log('Error creating arena object', object_id, err);
    }
    await mqttClient.publish(TOPICS.PUBLISH.SCENE_OBJECTS.formatStr({
        nameSpace: namespace,
        sceneName: sceneId,
        userClient: mqttClientOptions.clientId,
        // eslint-disable-next-line camelcase
        objectId: object_id,
    }), JSON.stringify(msg));
};

/** Pose the Template container falls back to for anything the request does not usably ask for. */
const CONTAINER_POSE_DEFAULTS = {
    position: {x: 0, y: 0, z: 0},
    rotation: {x: 0, y: 0, z: 0},
};

/**
 * Picks the axes of a requested pose component that can actually place an object.
 * `attributes` is Mixed in the schema and createArenaObj runs no validators, so a component that
 * is not an {x, y, z} object of finite numbers would otherwise reach both Mongo and the broker.
 * @param {*} component - Whatever the request offered for this component.
 * @param {string} name - Component name, for the log.
 * @return {Object} The usable axes of component, empty if it offered none.
 */
const poseAxes = (component, name) => {
    if (component === undefined || component === null) {
        return {};
    }
    if (typeof component !== 'object' || Array.isArray(component)) {
        console.log(`Ignoring template container ${name}, not an {x, y, z} object`,
            JSON.stringify(component));
        return {};
    }
    const axes = {};
    for (const axis of ['x', 'y', 'z']) {
        if (Number.isFinite(component[axis])) {
            axes[axis] = component[axis];
        } else if (component[axis] !== undefined) {
            console.log(`Ignoring template container ${name}.${axis}, not a finite number`,
                JSON.stringify(component[axis]));
        }
    }
    return axes;
};

/**
 * Loads a template-scene and instantiates all objects from it in into a
 * target scene, first inside a templateContainer parent, then with each
 * object_id prefixed with the template and instance strings.
 * @param {string} instanceId - id of instance
 * @param {string} realm - MQTT topic realm
 * @param {string} templateNamespace - namespace of template
 * @param {string} templateSceneId - sceneId of template
 * @param {string} targetNamespace - namespace of sceneId to insert new objs into
 * @param {string} targetSceneId - sceneId of object to insert new objs into
 * @param {Object} [opts] - various options to apply to Template container
 * @param {boolean} [opts.noPrefix] - Do not prefix source to created objectIds
 * @param {boolean}[opts.noParent] - Do not wrap all cloned objects in a parent container
 * @param {Number} [opts.ttl] - Duration TTL (seconds) of Template container
 * @param {boolean} [opts.persist] - Whether to persist *all* templated objects
 * @param {Object} [opts.attributes] - data payload Template container. Its `position` and
 *     `rotation` are overridden only when opts.pose is supplied; a call that names no pose keeps
 *     whatever pose these attributes carry, as it always has.
 *     Ignored entirely when opts.noParent is set, since then there is no container to place.
 * @param {Object} [opts.pose] - Where to place the Template container, outranking any `position`
 *     or `rotation` in opts.attributes. Each of the axes it names must be a finite number;
 *     anything else keeps the default for that axis. Omit it to leave opts.attributes alone.
 * @param {Object} [opts.pose.position] - position of the Template container
 * @param {Object} [opts.pose.rotation] - rotation of the Template container
 */
const loadTemplate = async (
    instanceId,
    realm,
    templateNamespace,
    templateSceneId,
    targetNamespace,
    targetSceneId,
    opts,
) => {
    const templateObjs = await ArenaObject.find(
        {namespace: templateNamespace, sceneId: templateSceneId});
    const defaultOpts = {
        noPrefix: false,
        noParent: false,
        ttl: undefined,
        persist: false,
        attributes: {
            ...CONTAINER_POSE_DEFAULTS,
            object_type: 'templateContainer',
        },
    };
    const options = Object.assign(defaultOpts, opts);
    // A requested pose places the container one axis at a time over CONTAINER_POSE_DEFAULTS, so a
    // request naming only position.x, or only a position and no rotation, keeps the default for
    // every axis it leaves out - and so does one naming an axis, or a whole component, that could
    // not place anything. A pose that is supplied therefore always leaves the container carrying a
    // full numeric position and rotation.
    // A pose that is not supplied at all leaves options.attributes untouched, so a caller placing
    // the container through opts.attributes still gets the pose it asked for. Only the absence
    // yields: an empty pose object is a request to be placed, and lands on the defaults. The MQTT
    // handler always sends a pose, so an MQTT request with no position or rotation still ends up
    // at the origin, exactly where it was before the pose was wired through at all.
    const pose = options.pose;
    if (pose !== undefined && pose !== null) {
        options.attributes = {
            ...options.attributes,
            position: {...CONTAINER_POSE_DEFAULTS.position, ...poseAxes(pose.position, 'position')},
            rotation: {...CONTAINER_POSE_DEFAULTS.rotation, ...poseAxes(pose.rotation, 'rotation')},
        };
    }
    const templatePrefix = `${templateNamespace}|${templateSceneId}::${instanceId}`;
    // Create template container, always
    if (!options.noParent) {
        await createArenaObj(templatePrefix, 'object', realm, targetNamespace,
            targetSceneId,
            options.attributes, options.persist, options.ttl);
    }
    const objectsPrefix = options.noPrefix ? '' : `${templatePrefix}::`;
    // Create all objects
    await asyncForEach(templateObjs, async (obj) => {
        // Assign parent
        if (obj.attributes.parent) {
            // Name with prefix
            obj.attributes.parent = objectsPrefix + obj.attributes.parent;
        } else if (!options.noParent) {
            // Or child of template container
            obj.attributes.parent = templatePrefix;
        }
        await createArenaObj(
            objectsPrefix + obj.object_id,
            obj.type,
            realm,
            targetNamespace,
            targetSceneId,
            obj.attributes,
            options.persist,
            obj.attributes.ttl,
        );
    });
};

const publishExpires = async () => {
    const now = new Date();
    await asyncMapForEach(expirations, async (obj, key) => {
        if (obj.expireAt < now) {
            const msg = {
                object_id: obj.object_id,
                action: 'delete',
            };
            await mqttClient.publish(TOPICS.PUBLISH.SCENE_OBJECTS.formatStr({
                nameSpace: obj.namespace,
                sceneName: obj.sceneId,
                userClient: mqttClientOptions.clientId,
                // eslint-disable-next-line camelcase
                objectId: obj.object_id,
            }), JSON.stringify(msg));
            expirations.delete(key);
            forgetPersist(key);
            await ArenaObject.deleteMany({
                'attributes.parent': obj.object_id,
                'namespace': obj.namespace,
                'sceneId': obj.sceneId,
            });
        }
    });
};
