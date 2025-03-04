#!/usr/bin/env node
'use strict';

const config = require('./config.json');
const fs = require('fs');
const mongoose = require('mongoose');
const mqtt = require('async-mqtt');
const {clearIntervalAsync, setIntervalAsync} = require('set-interval-async/dynamic');
const jose = require('jose');

const {runExpress} = require('./express_server');
const {asyncForEach, asyncMapForEach, filterNulls, flatten} = require('./utils');
const {TOPICS} = require('./topics');

let jwk;
if (config.jwt_public_keyfile) {
    // TODO: Does alg need to be parameterized?
    jose.importSPKI(fs.readFileSync(config.jwt_public_keyfile, 'utf8'), 'RS256')
        .then((key) => {
            jwk = key;
        })
        .catch(() => {
            console.error(`Error loading public key: ${config.jwt_public_keyfile}`);
            process.exit();
        });
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
let persists = new Set();
let expirations;
let expireTimer;
let persistUpdateTimeout;

/**
 * Force refresh of the persists set every hour
 * @return {Promise<void>}
 */
async function updatePersists() {
    if (persistUpdateTimeout) {
        clearTimeout(persistUpdateTimeout);
    }
    persists = new Set((await ArenaObject.find({}, {
        'object_id': 1,
        'namespace': 1,
        'sceneId': 1,
        '_id': 0,
    })).map((o) => `${o.namespace}|${o.sceneId}|${o.object_id}`));
    persistUpdateTimeout = setTimeout(updatePersists, 60 * 60 * 1000);
}

mongoose.connect(config.mongodb.uri).then(async () => {
    console.log('Connected to Mongodb');
    await updatePersists();
    await runMQTT();
    await runExpress({
        ArenaObject,
        mqttClient,
        jwk,
        mongooseConnection: mongoose.connection,
        loadTemplate,
        persists,
    });
}).catch((err) => {
    console.log('Mongodb Connection Error: ', err);
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
        // Resync
        persists = new Set((await ArenaObject.find({}, {
            'object_id': 1,
            'namespace': 1,
            'sceneId': 1,
            '_id': 0,
        })).map((o) => `${o.namespace}|${o.sceneId}|${o.object_id}`));
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
            try {
                await ArenaObject.findOneAndUpdate({
                    object_id: arenaObj.object_id,
                    namespace: arenaObj.namespace,
                    sceneId: arenaObj.sceneId,
                }, insertObj, {
                    upsert: true,
                    runValidators: true,
                });
            } catch (err) {
                console.log('Error creating object: ', arenaObj.object_id, err);
            }
            if (arenaObj.expireAt) {
                expirations.set(
                    `${arenaObj.namespace}|${arenaObj.sceneId}|${arenaObj.object_id}`,
                    arenaObj);
            }
            persists.add(
                `${arenaObj.namespace}|${arenaObj.sceneId}|${arenaObj.object_id}`);
        }
        break;
    case 'update':
        if (msgJSON.persist && msgJSON.persist !== false) {
            if (persists.has(
                `${arenaObj.namespace}|${arenaObj.sceneId}|${arenaObj.object_id}`)) {
                if (msgJSON.overwrite) {
                    try {
                        await ArenaObject.findOneAndReplace(
                            {
                                object_id: arenaObj.object_id,
                                namespace: arenaObj.namespace,
                                sceneId: arenaObj.sceneId,
                            },
                            insertObj,
                        );
                    } catch (err) {
                        console.log('Does not exist to update:', arenaObj.object_id);
                    }
                } else {
                    const [sets, unSets] = filterNulls(
                        flatten({attributes: insertObj.attributes}));
                    try {
                        await ArenaObject.findOneAndUpdate(
                            {
                                object_id: arenaObj.object_id,
                                namespace: arenaObj.namespace,
                                sceneId: arenaObj.sceneId,
                            },
                            {$set: sets, $unset: unSets},
                        );
                    } catch (err) {
                        console.log('Does not exist:', arenaObj.object_id);
                    }
                }
                if (arenaObj.expireAt) {
                    expirations.set(
                        `${arenaObj.namespace}|${arenaObj.sceneId}|${arenaObj.object_id}`,
                        arenaObj,
                    );
                }
            }
        }
        break;
    case 'delete':
        if (persists.has(
            `${arenaObj.namespace}|${arenaObj.sceneId}|${arenaObj.object_id}`)) {
            try {
                await ArenaObject.deleteOne({
                    object_id: arenaObj.object_id,
                    namespace: arenaObj.namespace,
                    sceneId: arenaObj.sceneId,
                });
                await ArenaObject.deleteMany({
                    'attributes.parent': arenaObj.object_id,
                    'namespace': arenaObj.namespace,
                    'sceneId': arenaObj.sceneId,
                });
            } catch (err) {
                console.log('Does not exist or already deleted:', arenaObj.object_id);
            }
            if (expirations.has(
                `${arenaObj.namespace}|${arenaObj.sceneId}|${arenaObj.object_id}`)) {
                expirations.delete(
                    `${arenaObj.namespace}|${arenaObj.sceneId}|${arenaObj.object_id}`);
            }
            if (arenaObj.object_id.split('::').length - 1 === 1) { // Template container ID, 1 pair of '::'
                const r = RegExp('^' + arenaObj.object_id + '::');
                try {
                    await ArenaObject.deleteMany({
                        'attributes.parent': r,
                        'namespace': arenaObj.namespace,
                        'sceneId': arenaObj.sceneId,
                    });
                } catch (err) {
                    console.log('Error deleting template container for:', arenaObj.object_id);
                }
            }
            persists.delete(
                `${arenaObj.namespace}|${arenaObj.sceneId}|${arenaObj.object_id}`);
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
    const opts = {
        ttl: a.ttl,
        persist: a.persist,
        pose: {
            position: a.position,
            rotation: a.rotation,
        },
    };
    if (a.templateNamespace && a.templateSceneId) { // make sure template isn't empty
        if (await ArenaObject.countDocuments({
            namespace: a.templateNamespace,
            sceneId: a.templateSceneId,
        }) === 0) {
            return;
        }
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
        a.templateNamespace,
        a.templateSceneId,
        arenaObj.realm,
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
 * @param {Object} [opts.attributes] - data payload Template container
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
            position: {x: 0, y: 0, z: 0},
            rotation: {x: 0, y: 0, z: 0},
            object_type: 'templateContainer',
        },
    };
    const options = Object.assign(defaultOpts, opts);
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
            persists.delete(key);
            await ArenaObject.deleteMany({
                'attributes.parent': obj.object_id,
                'namespace': obj.namespace,
                'sceneId': obj.sceneId,
            });
        }
    });
};
