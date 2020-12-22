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
        'sceneId': 1,
        '_id': 0,
    })).map((o) => `${o.sceneId}|${o.object_id}`));
    await runMQTT();
    runExpress();
}, (err) => {
    console.log('Mongodb Connection Error: ', err);
});

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
    const SCENE_TOPICS = config.mqtt.topic_realm + '/s/#';
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
            'sceneId': 1,
            '_id': 0,
        })).map((o) => `${o.sceneId}|${o.object_id}`));
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
        await mqttClient.subscribe(SCENE_TOPICS, {
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
            - 2: scene_id
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
                    sceneId: topicSplit[2],
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
                        sceneId: arenaObj.sceneId,
                    }, insertObj, {
                        upsert: true,
                        runValidators: true,
                    });
                    if (arenaObj.expireAt) {
                        expirations.set(`${arenaObj.sceneId}|${arenaObj.object_id}`, arenaObj);
                    }
                    persists.add( `${arenaObj.sceneId}|${arenaObj.object_id}`);
                }
                break;
            case 'update':
                if (msgJSON.persist && msgJSON.persist !== false) {
                    if (persists.has(`${arenaObj.sceneId}|${arenaObj.object_id}`)) {
                        if (msgJSON.overwrite) {
                            await ArenaObject.findOneAndReplace(
                                {
                                    object_id: arenaObj.object_id,
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
                            expirations.set( `${arenaObj.sceneId}|${arenaObj.object_id}`, arenaObj);
                        }
                    }
                }
                break;
            case 'delete':
                if (persists.has( `${arenaObj.sceneId}|${arenaObj.object_id}`)) {
                    await ArenaObject.deleteOne({
                        object_id: arenaObj.object_id,
                        sceneId: arenaObj.sceneId,
                    }, (err) => {
                        if (err) {
                            console.log( 'Does not exist or already deleted:', arenaObj.object_id);
                        }
                    });
                    await ArenaObject.deleteMany({
                        'attributes.parent': arenaObj.object_id,
                        'sceneId': arenaObj.sceneId,
                    });
                    if (expirations.has( `${arenaObj.sceneId}|${arenaObj.object_id}`)) {
                        expirations.delete( `${arenaObj.sceneId}|${arenaObj.object_id}`);
                    }
                    if (arenaObj.object_id.split('::').length - 1 === 1) { // Template container ID, 1 pair of '::'
                        const r = RegExp('^' + arenaObj.object_id + '::');
                        await ArenaObject.deleteMany({'attributes.parent': r, 'sceneId': arenaObj.sceneId});
                    }
                    persists.delete( `${arenaObj.sceneId}|${arenaObj.object_id}`);
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
                    if (await ArenaObject.countDocuments( {sceneId: '@' + a.templateId}) === 0) {
                        return;
                    }
                }
                if (a.instanceId) {
                    if (await ArenaObject.countDocuments({
                        sceneId: arenaObj.sceneId,
                        object_id: a.templateId + '::' + a.instanceId,
                    }) > 0) {
                        return;
                    }
                }
                await loadTemplate(a.instanceId, a.templateId, arenaObj.realm, arenaObj.sceneId, opts);
                break;
            default:
                // pass
            }
        });
    } catch (e) {
        console.log(e.stack);
    }
}

const createArenaObj = async (object_id, realm, sceneId, attributes, persist, ttl) => {
    const topic = realm + '/s/' + sceneId;
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
        sceneId: sceneId,
    }).toObject;
    await ArenaObject.findOneAndUpdate({object_id: object_id, sceneId: sceneId}, arenaObj, {
        upsert: true,
    });
    await mqttClient.publish(topic, JSON.stringify(msg));
};

const loadTemplate = async (instanceId, templateId, realm, targetSceneId, opts) => {
    const sceneObjs = await ArenaObject.find({sceneId: '@' + templateId});
    const default_opts = {
        ttl: undefined,
        persist: false,
        attributes: {
            position: {x: 0, y: 0, z: 0},
            rotation: {x: 0, y: 0, z: 0, w: 0},
            object_type: 'templateContainer',
        },
    };
    const options = Object.assign(default_opts, opts);
    const prefix = templateId + '::' + instanceId;
    await createArenaObj(prefix, realm, targetSceneId, options.pose, options.persist, options.ttl);
    await asyncForEach(sceneObjs, async (obj) => {
        if (obj.attributes.parent) {
            obj.attributes.parent = prefix + '::' + obj.attributes.parent;
        } else {
            obj.attributes.parent = prefix;
        }
        await createArenaObj(prefix + '::' + obj.object_id, realm, targetSceneId, obj.attributes,
            options.persist, obj.attributes.ttl);
    });
};

const publishExpires = async () => {
    const now = new Date();
    await asyncMapForEach(expirations, async (obj, key) => {
        if (obj.expireAt < now) {
            const topic = obj.realm + '/s/' + obj.sceneId;
            const msg = {
                object_id: obj.object_id,
                action: 'delete',
            };
            await mqttClient.publish(topic, JSON.stringify(msg));
            expirations.delete(key);
            persists.delete(key);
            await ArenaObject.deleteMany( {'attributes.parent': obj.object_id, 'sceneId': obj.sceneId});
        }
    });
};

async function asyncForEach(array, callback) {
    for (let index = 0; index < array.length; index++) {
        await callback(array[index], index, array);
    }
}

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
        if (obj[key] === null) {
            unSets[key] = '';
        } else {
            sets[key] = obj[key];
        }
    }
    return [sets, unSets];
};

const runExpress = () => {
    const app = express();

    // Set and remove headers
    app.disable('x-powered-by');

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
        app.param('sceneId', (req, res, next, sceneId) => {
            let valid = false;
            const len = req.jwtPayload.subs.length;
            for (let i = 0; i < len; i++) {
                if (MQTTPattern.matches(req.jwtPayload.subs[i], `realm/s/${sceneId}`)) {
                    valid = true;
                    break;
                }
            }
            if (!valid) {
                return tokenError(res);
            }
            next();
        });
    }
    app.get('/persist/!allscenes', (req, res) => {
        if (jwk && !req.jwtPayload.subs.includes('realm/s/#')) { // Must have sub-all rights
            return tokenError(res);
        }
        ArenaObject.distinct('sceneId', (err, sceneIds) => {
            sceneIds.sort();
            res.json(sceneIds);
        });
    });
    app.get('/persist/:sceneId', (req, res) => {
        const now = new Date();
        const query = {sceneId: req.params.sceneId, expireAt: {$not: {$lt: now}}};
        if (req.query.type) {
            query.type = req.query.type;
        }
        ArenaObject.find(query, {_id: 0, realm: 0, sceneId: 0, __v: 0}). then((records) => {
            res.json(records);
        });
    });
    app.get('/persist/:sceneId/:objectId', (req, res) => {
        const now = new Date();
        ArenaObject.find({
            sceneId: req.params.sceneId,
            object_id: req.params.objectId,
            expireAt: {$not: {$lt: now}},
        }, {_id: 0, realm: 0, sceneId: 0, __v: 0},
        ).then((msgs) => {
            res.json(msgs);
        });
    });
    app.listen(8884);
};
