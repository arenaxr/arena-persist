#!/usr/bin/env node
'use strict';

const config = require('./config.json');
const mongoose = require('mongoose');
const mqtt = require('async-mqtt');
const express = require('express');

mongoose.connect(config.mongodb.uri, {
    useNewUrlParser: true,
    useFindAndModify: false,
    useCreateIndex: true,
    useUnifiedTopology: true
}).then(async () => {
    console.log('Connected to Mongodb');
    await runMQTT();
    runExpress();
}, err => {
    console.log('Mongodb Connection Error: ', err);
});

const arenaSchema = new mongoose.Schema({
    object_id: {type: String, index: true, unique: true},
    attributes: Map,
    lastUpdated: Date,
    expireAt: { type: Date, expires: 0 },
    realm: {type: String, index: true},
    sceneId: {type: String, index: true},
});

const ArenaObject = mongoose.model('ArenaObject', arenaSchema);

let mqttClient;
let expirations;
let expireTimer;

async function runMQTT() {
     mqttClient = await mqtt.connectAsync(config.mqtt.uri, {
        clientId: 'arena_persist_' + config.mqtt.topic_realm,
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
                    lastUpdated: now,
                    expireAt: expireAt,
                    realm: topicSplit[0],
                    sceneId: topicSplit[2]
                });
            } catch(e) {
                return;
            }
            switch (msgJSON.action) {
                case 'create':
                    if (msgJSON.persist === true) {
                        ArenaObject.findOneAndUpdate({object_id: arenaObj.object_id}, arenaObj.toObject(), {
                            upsert: true,
                            runValidators: true
                        });
                        if (expireAt) {
                            expirations.set(arenaObj.object_id, arenaObj);
                        }
                    }
                    break;
                case 'update':
                    if (msgJSON.type === 'overwrite') {
                        ArenaObject.findOneAndReplace(
                            {object_id: arenaObj.object_id},
                            arenaObj.toJSON(),
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
                            {attributes: arenaObj.attributes, lastUpdated: now},
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
                    break;
                case 'delete':
                    ArenaObject.deleteOne({object_id: arenaObj.object_id}, (err) => {
                        if (err) {
                            console.log('Does not exist or already deleted:', arenaObj.object_id);
                        }
                    });
                    if (expirations.has(arenaObj.object_id)) {
                        expirations.delete(arenaObj.object_id);
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
        }
    });
};


const runExpress = () => {
    const app = express();
    app.get('/:sceneId', (req, res) => {
        ArenaObject.find({sceneId: req.params.sceneId}, {_id: 0, realm: 0, sceneId: 0, __v: 0}).then(msgs => {
            res.json(msgs);
        });
    });
    app.listen(8884);
};
