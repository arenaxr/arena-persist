#!/usr/bin/env node
'use strict';

const config = require('./config.json');
const mongoose = require('mongoose');
const mqtt = require('async-mqtt');
const express = require('express');

const arenaSchema = new mongoose.Schema({
    object_id: {type: String, index: true, unique: true},
    attributes: Object,
    expireAt: { type: Date, expires: 0 },
    realm: {type: String, index: true},
    sceneId: {type: String, index: true},
},{
    timestamps: true
});

const ArenaObject = mongoose.model('ArenaObject', arenaSchema);

let mqttClient;
let persists = new Set();
let expirations;
let expireTimer;

mongoose.connect(config.mongodb.uri, {
    useNewUrlParser: true,
    useFindAndModify: false,
    useCreateIndex: true,
    useUnifiedTopology: true
}).then(async () => {
    console.log('Connected to Mongodb');
    persists = new Set((await ArenaObject.find({}, {'object_id': 1, '_id': 0})).map(o => o.object_id));
    await runMQTT();
    runExpress();
}, err => {
    console.log('Mongodb Connection Error: ', err);
});


async function runMQTT() {
     mqttClient = await mqtt.connectAsync(config.mqtt.uri, {
        clientId: 'arena_persist' + config.mqtt.topic_realm + '_' + Math.floor(Math.random() * 100),
        clean: false, // Receive QoS 1+ messages (object delete) always
        qos: 1,
        will: {
            topic: config.mqtt.statusTopic,
            payload: 'Persistence service disconnected: ' + config.mqtt.topic_realm
        }
    });
    const SCENE_TOPICS = config.mqtt.topic_realm + '/s/#';
    console.log('Connected to MQTT');
    mqttClient.on('offline', () => {
        clearInterval(expireTimer);
        console.log('offline, timer off');
    });
    mqttClient.on('reconnect', () => {
        console.log('reconnect');
    });
    mqttClient.on('connect', () => {
        console.log('connect');
    });
    mqttClient.on('disconnect', () => {
        console.log('disconnect');
    });
    mqttClient.on('error', (err) => {
        console.log('error');
        console.log(err);
    });
    try {
        await mqttClient.subscribe(SCENE_TOPICS, {
            qos: 1
        }).then(() => {
            mqttClient.publish(config.mqtt.statusTopic, 'Persistence service connected: ' + config.mqtt.topic_realm);
            expirations = new Map();
            clearInterval(expireTimer);
            expireTimer = setInterval(publishExpires, 1000);
        });
        mqttClient.on('message', async (topic, message) => {
            let topicSplit = topic.split('/');
            /*
            Topic tokens by forward slash:
            - 0: realm
            - 1: type [s, n, r, topology, flows]
            - 2: scene_id
            */
            let msgJSON;
            let arenaObj;
            let now = new Date();
            let expireAt;
            try {
                msgJSON = JSON.parse(message.toString());
                if (msgJSON.ttl) {
                    expireAt = new Date(now.getTime() + (msgJSON.ttl * 1000));
                    msgJSON.persist = true;
                }
                arenaObj = new ArenaObject({
                    object_id: msgJSON.object_id,
                    attributes: msgJSON.data,
                    expireAt: expireAt,
                    realm: topicSplit[0],
                    sceneId: topicSplit[2]
                });
            } catch(e) {
                return;
            }
            let insertObj = arenaObj.toObject();
            delete insertObj._id;
            switch (msgJSON.action) {
                case 'create':
                    if (msgJSON.persist === true) {
                        await ArenaObject.findOneAndUpdate({object_id: arenaObj.object_id}, insertObj, {
                            upsert: true,
                            runValidators: true
                        });
                        if (expireAt) {
                            expirations.set(arenaObj.object_id, arenaObj);
                        }
                        persists.add(arenaObj.object_id);
                    }
                    break;
                case 'update':
                    if (persists.has(arenaObj.object_id)) {
                        if (msgJSON.type === 'overwrite') {
                            ArenaObject.findOneAndReplace(
                                {object_id: insertObj.object_id},
                                insertObj,
                                {},
                                (err) => {
                                    if (err) {
                                        console.log('Does not exist:', arenaObj.object_id);
                                    }
                                }
                            );
                        } else {
                            ArenaObject.findOneAndUpdate(
                                {object_id: arenaObj.object_id},
                                {$set: flatten({attributes: insertObj.attributes})},
                                {},
                                (err) => {
                                    if (err) {
                                        console.log('Does not exist:', arenaObj.object_id);
                                    }
                                }
                            );
                        }
                        if (expireAt) {
                            expirations.set(arenaObj.object_id, arenaObj);
                        }
                    }
                    break;
                case 'delete':
                    if (persists.has(arenaObj.object_id)) {
                        ArenaObject.deleteOne({object_id: arenaObj.object_id}, (err) => {
                            if (err) {
                                console.log('Does not exist or already deleted:', arenaObj.object_id);
                            }
                        });
                        if (expirations.has(arenaObj.object_id)) {
                            expirations.delete(arenaObj.object_id);
                        }
                        persists.delete(arenaObj.object_id);
                    }
                    break;
                default:
                    //pass
            }
        });
    } catch (e) {
        console.log(e.stack);
    }
}

const publishExpires = () => {
    let now = new Date();
    expirations.forEach((obj, key) => {
        if (obj.expireAt < now) {
            let topic = obj.realm + '/s/' + obj.sceneId;
            let msg = {
                object_id: obj.object_id,
                action: 'delete'
            };
            mqttClient.publish(topic, JSON.stringify(msg));
            expirations.delete(key);
            persists.delete(key);
        }
    });
};


let isPlainObj = (o) => Boolean(
    o && o.constructor && o.constructor.prototype && o.constructor.prototype.hasOwnProperty('isPrototypeOf')
);

let flatten = (obj, keys = []) => {
    return Object.keys(obj).reduce((acc, key) => {
        return Object.assign(acc, isPlainObj(obj[key]) ? flatten(obj[key], keys.concat(key)) : {
            [keys.concat(key).join('.')]: obj[key]
        });
    }, {});
};


const runExpress = () => {
    const app = express();
    app.get('/persist/:sceneId', (req, res) => {
        ArenaObject.find({sceneId: req.params.sceneId}, {_id: 0, realm: 0, sceneId: 0, __v: 0}).then(msgs => {
            res.json(msgs);
        });
    });
    app.listen(8884);
};
