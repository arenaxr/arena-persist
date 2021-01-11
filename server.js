#!/usr/bin/env node
'use strict';

const config = require('./config.json');
const fs = require('fs');
const mongoose = require('mongoose');
const mqtt = require('async-mqtt');
const {setIntervalAsync} = require('set-interval-async/dynamic');
const {clearIntervalAsync} = require('set-interval-async');
const {JWT, JWK} = require('jose');
const MQTTPattern = require('mqtt-pattern');

const express = require('express');
const cookieParser = require('cookie-parser');

let jwk;
if (config.jwt_public_keyfile) {
    try {
        jwk = JWK.asKey(fs.readFileSync(config.jwt_public_keyfile));
    } catch (err) {
        console.error(`Error loading public key: ${config.jwt_public_keyfile}`);
        process.exit();
    }
}

const arenaSchema = new mongoose.Schema({
    object_id: {type: String, required: true, index: true},
    type: {type: String, required: true, index: true},
    attributes: Object,
    expireAt: {type: Date, expires: 0},
    realm: {type: String, required: true, index: true},
    namespace: {type: String, required: true, index: true, default: 'public'},
    sceneId: {type: String, required: true, index: true},
}, {
    timestamps: true,
});

const ArenaObject = mongoose.model('ArenaObject', arenaSchema);
mongoose.connection.collections.arenaobjects.createIndex({'attributes.parent': 1}, {sparse: true});

let mqttClient;
let persists = new Set();
let expirations;
let expireTimer;

mongoose.connect(config.mongodb.uri, {
    useNewUrlParser: true,
    useFindAndModify: false,
    useCreateIndex: true,
    useUnifiedTopology: true,
}).then(async () => {
    console.log('Connected to Mongodb');
    persists = new Set((await ArenaObject.find({}, {
        'object_id': 1,
        'namespace': 1,
        'sceneId': 1,
        '_id': 0,
    })).map((o) => `${o.namespace}|${o.sceneId}|${o.object_id}`));
    await runMQTT();
    runExpress();
}, (err) => {
    console.log('Mongodb Connection Error: ', err);
});

/**
* Initializes MQTT connection and setts event handlers
 */
async function runMQTT() {
    const connectOpts = {
        clientId: 'arena_persist' + config.mqtt.topic_realm + '_' + Math.floor(Math.random() * 100),
        clean: false, // Receive QoS 1+ messages (object delete) always
        qos: 1,
        will: {
            topic: config.mqtt.statusTopic,
            payload: 'Persistence service disconnected: ' + config.mqtt.topic_realm,
        },
    };
    if (jwk) {
        connectOpts.username = config.jwt_service_user;
        connectOpts.password = config.jwt_service_token;
    }
    mqttClient = await mqtt.connectAsync(config.mqtt.uri, connectOpts);
    const SCENE_TOPIC_BASE = config.mqtt.topic_realm + '/s/#';
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
        await mqttClient.subscribe(SCENE_TOPIC_BASE, {
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
        mqttClient.on('message', async (topic, message) => {
            const topicSplit = topic.split('/');
            /*
            Topic tokens by forward slash:
            - 0: realm
            - 1: type [s, n, r, topology, flows]
            - 2: namespace
            - 3: sceneId
            */
            let msgJSON;
            let arenaObj;
            const now = new Date();
            let isTemplateMsg = false;
            try {
                msgJSON = JSON.parse(message.toString());
                arenaObj = new ArenaObject({
                    object_id: msgJSON.object_id,
                    attributes: msgJSON.data,
                    expireAt: undefined,
                    type: msgJSON.type,
                    realm: topicSplit[0],
                    namespace: topicSplit[2],
                    sceneId: topicSplit[3],
                });
                if (arenaObj.sceneId[0] === '@') {
                    isTemplateMsg = true;
                }
                if (msgJSON.ttl) {
                    // Don't expire template scene objects on save
                    if (!isTemplateMsg && msgJSON.persist && msgJSON.persist !== false) {
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
                    await ArenaObject.findOneAndUpdate({
                        object_id: arenaObj.object_id,
                        namespace: arenaObj.namespace,
                        sceneId: arenaObj.sceneId,
                    }, insertObj, {
                        upsert: true,
                        runValidators: true,
                    });
                    if (arenaObj.expireAt) {
                        expirations.set(`${arenaObj.namespace}|${arenaObj.sceneId}|${arenaObj.object_id}`, arenaObj);
                    }
                    persists.add( `${arenaObj.namespace}|${arenaObj.sceneId}|${arenaObj.object_id}`);
                }
                break;
            case 'update':
                if (msgJSON.persist && msgJSON.persist !== false) {
                    if (persists.has(`${arenaObj.namespace}|${arenaObj.sceneId}|${arenaObj.object_id}`)) {
                        if (msgJSON.overwrite) {
                            await ArenaObject.findOneAndReplace(
                                {
                                    object_id: arenaObj.object_id,
                                    namespace: arenaObj.namespace,
                                    sceneId: arenaObj.sceneId,
                                },
                                insertObj,
                                {},
                                (err) => {
                                    if (err) {
                                        console.log('Does not exist:', arenaObj.object_id);
                                    }
                                },
                            );
                        } else {
                            const [sets, unSets] = filterNulls(flatten( {attributes: insertObj.attributes}));
                            await ArenaObject.findOneAndUpdate(
                                {
                                    object_id: arenaObj.object_id,
                                    namespace: arenaObj.namespace,
                                    sceneId: arenaObj.sceneId,
                                },
                                {$set: sets, $unset: unSets},
                                {},
                                (err) => {
                                    if (err) {
                                        console.log('Does not exist:', arenaObj.object_id);
                                    }
                                },
                            );
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
                if (persists.has( `${arenaObj.namespace}|${arenaObj.sceneId}|${arenaObj.object_id}`)) {
                    await ArenaObject.deleteOne({
                        object_id: arenaObj.object_id,
                        namespace: arenaObj.namespace,
                        sceneId: arenaObj.sceneId,
                    }, (err) => {
                        if (err) {
                            console.log( 'Does not exist or already deleted:', arenaObj.object_id);
                        }
                    });
                    await ArenaObject.deleteMany({
                        'attributes.parent': arenaObj.object_id,
                        'namespace': arenaObj.namespace,
                        'sceneId': arenaObj.sceneId,
                    });
                    if (expirations.has( `${arenaObj.namespace}|${arenaObj.sceneId}|${arenaObj.object_id}`)) {
                        expirations.delete( `${arenaObj.namespace}|${arenaObj.sceneId}|${arenaObj.object_id}`);
                    }
                    if (arenaObj.object_id.split('::').length - 1 === 1) { // Template container ID, 1 pair of '::'
                        const r = RegExp('^' + arenaObj.object_id + '::');
                        await ArenaObject.deleteMany({
                            'attributes.parent': r,
                            'namespace': arenaObj.namespace,
                            'sceneId': arenaObj.sceneId,
                        });
                    }
                    persists.delete( `${arenaObj.namespace}|${arenaObj.sceneId}|${arenaObj.object_id}`);
                }
                break;
            case 'loadTemplate':
                const a = arenaObj.attributes;
                const opts = {
                    ttl: a.ttl,
                    persist: a.persist,
                    pose: {
                        position: a.position,
                        rotation: a.rotation,
                    },
                };
                if (a.templateId) { // make sure template isn't empty exists
                    if (await ArenaObject.countDocuments( {
                        namespace: arenaObj.namespace,
                        sceneId: '@' + a.templateId,
                    }) === 0) {
                        return;
                    }
                }
                if (a.instanceId) {
                    if (await ArenaObject.countDocuments({
                        namespace: arenaObj.namespace,
                        sceneId: arenaObj.sceneId,
                        object_id: a.templateId + '::' + a.instanceId,
                    }) > 0) {
                        return;
                    }
                }
                await loadTemplate(
                    a.instanceId,
                    a.templateId,
                    arenaObj.realm,
                    arenaObj.namespace,
                    arenaObj.sceneId,
                    opts,
                );
                break;
            default:
                // pass
            }
        });
    } catch (e) {
        console.log(e.stack);
    }
}

/**
 * Creates an arena object with given paramters
 * @param {string} object_id - id of object
 * @param {string} realm - MQTT topic realm
 * @param {string} namespace - namespace of sceneId
 * @param {string} sceneId - sceneId of object
 * @param {Object} attributes - data payload of message
 * @param {boolean} [persist] - Whether to persist this object
 * @param {Number} [ttl] - ttl in seconds
*/
// eslint-disable-next-line camelcase
const createArenaObj = async (object_id, realm, namespace, sceneId, attributes, persist, ttl) => {
    const topic = `realm/s/${namespace}/${sceneId}`;
    let expireAt;
    const msg = {
        object_id: object_id,
        action: 'create',
        type: 'object',
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
        object_id: object_id,
        type: 'object',
        attributes: attributes,
        expireAt: expireAt,
        realm: realm,
        namespace: namespace,
        sceneId: sceneId,
    }).toObject;
    await ArenaObject.findOneAndUpdate({
        namespace: namespace,
        object_id: object_id,
        sceneId: sceneId,
    }, arenaObj, {
        upsert: true,
    });
    await mqttClient.publish(topic, JSON.stringify(msg));
};

/**
 * Loads a template-scene and instantiates all objects from it in into a
 * target scene, first inside a templateContainer parent, then with each
 * object_id prefixed with the template and instance strings.
 * @param {string} instanceId - id of instance
 * @param {string} templateId - id of template
 * @param {string} realm - MQTT topic realm
 * @param {string} targetNamespace - namespace of sceneId to insert new objs into
 * @param {string} targetSceneId - sceneId of object to insert new objs into
 * @param {Object} opts - various options to apply to Template container
 * @param {Number} opts.ttl - Duration TTL (seconds) of Template container
 * @param {boolean} opts.persist - Whether to persist *all* templated objects
 * @param {attributes} opts.attributes - data payload Template container
 */
const loadTemplate = async (instanceId, templateId, realm, targetNamespace, targetSceneId, opts) => {
    const sceneObjs = await ArenaObject.find({namespace: targetNamespace, sceneId: '@' + templateId});
    const defaultOpts = {
        ttl: undefined,
        persist: false,
        attributes: {
            position: {x: 0, y: 0, z: 0},
            rotation: {x: 0, y: 0, z: 0, w: 0},
            object_type: 'templateContainer',
        },
    };
    const options = Object.assign(defaultOpts, opts);
    const prefix = templateId + '::' + instanceId;
    await createArenaObj(prefix, realm, targetNamespace, targetSceneId, options.pose, options.persist, options.ttl);
    await asyncForEach(sceneObjs, async (obj) => {
        if (obj.attributes.parent) {
            obj.attributes.parent = prefix + '::' + obj.attributes.parent;
        } else {
            obj.attributes.parent = prefix;
        }
        await createArenaObj(
            prefix + '::' + obj.object_id,
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
            const topic = `${obj.realm}/s/${obj.namespace}/${obj.sceneId}`;
            const msg = {
                object_id: obj.object_id,
                action: 'delete',
            };
            await mqttClient.publish(topic, JSON.stringify(msg));
            expirations.delete(key);
            persists.delete(key);
            await ArenaObject.deleteMany( {
                'attributes.parent': obj.object_id,
                'namespace': obj.namespace,
                'sceneId': obj.sceneId,
            });
        }
    });
};


/**
 * Performs forEach callback on an array in async manner.
 * @param {Array} array - Array or array-like object over which to iterate.
 * @param {function} callback - The function to call, wait await, for every element.
 */
async function asyncForEach(array, callback) {
    for (let index = 0; index < array.length; index++) {
        await callback(array[index], index, array);
    }
}

/**
 * Performs map callback on an array in async manner.
 * @param {Array} m - Array or array-like object over which to iterate.
 * @param {function} callback - The function to call, wait await, for every element.
 */
async function asyncMapForEach(m, callback) {
    for (const e of m.entries()) {
        await callback(e[1], e[0]);
    }
}

const isPlainObj = (o) => Boolean(
    o && o.constructor && o.constructor.prototype && o.constructor.prototype.hasOwnProperty('isPrototypeOf'),
);

const flatten = (obj, keys = []) => {
    return Object.keys(obj).reduce((acc, key) => {
        return Object.assign(acc, isPlainObj(obj[key]) ? flatten(obj[key], keys.concat(key)) : {
            [keys.concat(key).join('.')]: obj[key],
        });
    }, {});
};

const filterNulls = (obj) => {
    const sets = {};
    const unSets = {};
    for (const key in obj) {
        if (obj.hasOwnProperty(key)) {
            if (obj[key] === null) {
                unSets[key] = '';
            } else {
                sets[key] = obj[key];
            }
        }
    }
    return [sets, unSets];
};

const runExpress = () => {
    const app = express();

    // Set and remove headers
    app.disable('x-powered-by');

    let checkJWT = (req, res, next) => {
        next();
    };

    app.use((req, res, next) => {
        if (!mqttClient.connected) {
            res.status(503);
            res.send('Disconnected from MQTT');
            return next('Disconnected from MQTT');
        }
        next();
    });

    const tokenError = (res) => {
        res.status(401);
        res.send('Error validating mqtt permissions');
    };

    if (jwk) {
        app.use(cookieParser());
        app.use(async (req, res, next) => {
            const token = req.cookies.mqtt_token;
            if (!token) {
                return tokenError(res);
            }
            try {
                req.jwtPayload = JWT.verify(token, jwk);
                next();
            } catch (err) {
                return tokenError(res);
            }
        });
        checkJWT = (req, res, next) => {
            const sceneId = req.params.sceneId;
            const namespace = req.params.namespace;
            let valid = false;
            const len = req.jwtPayload.subs.length;
            for (let i = 0; i < len; i++) {
                if (MQTTPattern.matches(req.jwtPayload.subs[i], `realm/s/${namespace}/${sceneId}`)) {
                    valid = true;
                    break;
                }
            }
            if (!valid) {
                return tokenError(res);
            }
            next();
        };
    }

    app.get('/persist/!allscenes', (req, res) => {
        if (jwk && !req.jwtPayload.subs.includes('realm/s/#')) { // Must have sub-all rights
            return tokenError(res);
        }
        ArenaObject.aggregate([
            {
                $group: {
                    _id: {
                        namespace: '$namespace',
                        sceneId: '$sceneId',
                    },
                },
            },
            {
                $sort: {
                    '_id.namespace': 1,
                    '_id.sceneId': 1,
                },
            },
        ]).exec((err, scenes) => {
            return res.json(scenes.map((s) => s._id.namespace + '/' + s._id.sceneId));
        });
    });
    app.get('/persist/:namespace/:sceneId', checkJWT, (req, res) => {
        const now = new Date();
        const query = {sceneId: req.params.sceneId, namespace: req.params.namespace, expireAt: {$not: {$lt: now}}};
        if (req.query.type) {
            query.type = req.query.type;
        }
        ArenaObject.find(query, {_id: 0, realm: 0, namespace: 0, sceneId: 0, __v: 0}). then((records) => {
            res.json(records);
        });
    });
    app.get('/persist/:namespace/:sceneId/:objectId', checkJWT, (req, res) => {
        const now = new Date();
        ArenaObject.find({
            namespace: req.params.namespace,
            sceneId: req.params.sceneId,
            object_id: req.params.objectId,
            expireAt: {$not: {$lt: now}},
        }, {_id: 0, realm: 0, namespace: 0, sceneId: 0, __v: 0},
        ).then((msgs) => {
            res.json(msgs);
        });
    });

    app.listen(8884);
};
