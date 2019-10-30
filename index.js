const config = require('./config.json');
const mongoose = require('mongoose');
const mqtt = require('async-mqtt');


mongoose.connect(config.mongodb.uri, {useNewUrlParser: true, useFindAndModify: false, useCreateIndex: true });
const db = mongoose.connection;
db.on('error', console.error.bind(console, 'Mongodb connection error:'));
db.once('open', () => {
    console.log("Connected to Mongodb");
    runMQTT();
});

const arenaSchema = new mongoose.Schema({
    object_id:  { type: String, index: true, unique: true },
    attributes: Map,
    createdAt: Date,
    lastUpdated: Date,
    realm:  { type: String, index: true },
    scene:  { type: String, index: true },
});

const ArenaObject = mongoose.model('ArenaObject', arenaSchema);

async function runMQTT() {
    const mqttClient = await mqtt.connectAsync(config.mqtt.uri);
    const SCENE_TOPICS = config.mqtt.topic_realm + "/s/#";
    console.log("Connected to MQTT");
    try {
        await mqttClient.subscribe(SCENE_TOPICS).then(() => {
            mqttClient.publish(config.mqtt.statusTopic, 'Persistence service connected: ' + config.mqtt.topic_realm);
        });
        mqttClient.on('message', async (topic, message) => {
            let topicSplit = topic.split("/");
            /*
            Topic tokens by forward slash:
            - 0: realm
            - 1: type [s, n, r, topology, flows]
            - 2: scene_id
            */
            try {
                let msgJSON = JSON.parse(message.toString())
            } catch(e) {
                return;
            }
            let arenaObj = new ArenaObject({
                object_id: msgJSON.object_id,
                attributes: msgJSON.data,
                last_updated: msgJSON.timestamp,
                realm: topicSplit[0],
                scene: topicSplit[2]
            });
            // TODO : add schema for pubsub message with catch on invalid format
            switch (msgJSON.action) {
                case "create":
                    await ArenaObject.find({ object_id: arenaObj.object_id }, (err, res)=>{
                        if (res.length === 0) {
                            arenaObj.createdAt = arenaObj.last_updated;
                            arenaObj.save();
                        } else {
                            console.log("Already exists")
                        }
                    });
                    break;
                case "update":
                    let currentObj = await ArenaObject.findOne({ object_id: arenaObj.object_id });
                    let dataUpdate = {};
                    if (msgJSON.type === "overwrite") {
                        dataUpdate = arenaObj.attributes;
                    } else {
                        dataUpdate = new Map([...currentObj.attributes, ...arenaObj.attributes])
                    }
                    await ArenaObject.findOneAndUpdate(
                        { object_id: arenaObj.object_id },
                        { attributes: dataUpdate, last_updated: arenaObj.timestamp},
                        {},
                        (err, res) => {
                            if (err) {
                                console.log("Doesn't exist!");
                            }
                        }
                    );
                    break;
                case "delete":
                    await ArenaObject.deleteOne({ object_id: arenaObj.object_id }, (err, res) => {
                        if (err) {
                            console.log("Doesn't exist or Already deleted")
                        }
                    });
                    break;
                default:
                    //pass
            }
        });
    } catch(e) {
        console.log(e.stack);
    }
}

