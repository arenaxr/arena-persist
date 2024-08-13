const MQTTPattern = require('mqtt-pattern');
const jose = require('jose');

const express = require('express');
const cookieParser = require('cookie-parser');
const {TOPICS} = require('./topics');

// TODO: Does any of this need to be parameterized?
const VERIFY_OPTIONS = {
    algorithms: ['RS256'],
    // audience: 'arena',
    // issuer: 'arena-account',
};

/**
 * Starts express server
 * @param {object} ArenaObject - mongoose schema
 * @param {object} mqttClient - async-mqtt client
 * @param {object} jwk - JWK from config
 * @param {object} mongooseConnection - mongoose.connection
 * @param {function} loadTemplate - function to clone templates
 */
exports.runExpress = async ({
    ArenaObject,
    mqttClient,
    jwk,
    mongooseConnection,
    loadTemplate,
}) => {
    const app = express();

    // Set and remove headers
    app.disable('x-powered-by');

    let checkJWTSubs = (req, res, next) => {
        next();
    };

    let checkJWTPubs = checkJWTSubs;

    app.use((req, res, next) => {
        if (!mqttClient.connected) {
            res.status(503);
            res.json('Disconnected from MQTT');
            return next('Disconnected from MQTT');
        }
        next();
    });

    const tokenError = (res) => {
        res.status(401);
        res.json('Error validating mqtt permissions');
    };

    const tokenSubError = (res) => {
        res.status(401);
        res.json('You have not been granted read access');
    };

    const tokenPubError = (res) => {
        res.status(401);
        res.json('You have not been granted write access');
    };

    const matchJWT = (topic, rights) => {
        const len = rights.length;
        let valid = false;
        for (let i = 0; i < len; i++) {
            if (MQTTPattern.matches(rights[i], topic)) {
                valid = true;
                break;
            }
        }
        return valid;
    };

    if (jwk) {
        app.use(cookieParser());
        app.use(async (req, res, next) => {
            if (req.originalUrl === '/persist/health') {
                return next();
            }
            const token = req.cookies.mqtt_token;
            if (!token) {
                return tokenError(res);
            }
            jose.jwtVerify(token, jwk, VERIFY_OPTIONS)
                .then((verifiedToken) => {
                    req.jwtPayload = verifiedToken.payload;
                    next();
                })
                .catch(() => tokenError(res));
        });
        checkJWTSubs = (req, res, next) => {
            const {sceneId, namespace} = req.params;
            // This specific PUBLISH topic matches for objects
            const topic = TOPICS.PUBLISH.SCENE_OBJECTS.formatStr({
                nameSpace: namespace,
                sceneName: sceneId,
                objectId: '+',
            });
            if (!matchJWT(topic, req.jwtPayload.subs)) {
                return tokenSubError(res);
            }
            next();
        };
        checkJWTPubs = (req, res, next) => {
            const {sceneId, namespace} = req.params;
            const topic = TOPICS.PUBLISH.SCENE_OBJECTS.formatStr({
                nameSpace: namespace,
                sceneName: sceneId,
                objectId: '+',
            });
            if (!matchJWT(topic, req.jwtPayload.publ)) {
                return tokenPubError(res);
            }
            next();
        };
    }

    app.use(express.json());

    app.get('/persist/!allscenes', (req, res) => {
        const globalTopic = TOPICS.PUBLISH.SCENE_OBJECTS.formatStr({
            nameSpace: '+',
            sceneName: '+',
            objectId: '+',
        });
        if (jwk && !matchJWT(globalTopic, req.jwtPayload.subs)) { // Must have sub-all rights
            return tokenSubError(res);
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
        ]).exec().then((scenes) => {
            return res.json(
                scenes.map((s) => s._id.namespace + '/' + s._id.sceneId));
        });
    });

    app.get('/persist/:namespace/!allscenes', (req, res) => {
        const {namespace} = req.params;
        const namespaceTopic = TOPICS.PUBLISH.SCENE_OBJECTS.formatStr({
            nameSpace: namespace,
            sceneName: '+',
            objectId: '+', // arbitrary object
        });
        if (jwk && !matchJWT(namespaceTopic, req.jwtPayload.subs)) { // Must have sub-all public rights
            return tokenSubError(res);
        }
        ArenaObject.aggregate([
            {
                $match: {
                    namespace,
                },
            },
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
                    '_id.sceneId': 1,
                },
            },
        ]).exec().then((scenes) => {
            return res.json(scenes.map((s) => `${namespace}/${s._id.sceneId}`));
        });
    });

    app.post('/persist/:namespace/:sceneId', checkJWTPubs, async (req, res) => {
        try {
            const {
                namespace: targetNamespace,
                sceneId: targetSceneId,
            } = req.params;
            const {
                action,
                namespace: sourceNamespace,
                sceneId: sourceSceneId,
                allowNonEmptyTarget = false,
            } = req.body;
            if (action === 'clone') {
                if (!sourceNamespace || !sourceSceneId) {
                    res.status(400);
                    return res.json('No namespace or sceneId specified');
                }
                const srcTopic = TOPICS.PUBLISH.SCENE_OBJECTS.formatStr({
                    nameSpace: sourceNamespace,
                    sceneName: sourceSceneId,
                    objectId: '+',
                });
                if (!matchJWT(srcTopic, req.jwtPayload.subs)) {
                    return tokenSubError(res);
                }
                const sourceObjectCount = await ArenaObject.countDocuments(
                    {namespace: sourceNamespace, sceneId: sourceSceneId});
                if (sourceObjectCount === 0) {
                    res.status(404);
                    return res.json('The source scene is empty!');
                }
                if (!allowNonEmptyTarget) {
                    const targetObjectCount = await ArenaObject.countDocuments(
                        {namespace: targetNamespace, sceneId: targetSceneId});
                    if (targetObjectCount !== 0) {
                        res.status(409);
                        return res.json('The target scene is not empty!');
                    }
                }
                await loadTemplate(
                    'clone',
                    'realm',
                    sourceNamespace,
                    sourceSceneId,
                    targetNamespace,
                    targetSceneId,
                    {noPrefix: true, persist: true, noParent: true},
                );
                return res.json(
                    {result: 'success', objectsCloned: sourceObjectCount});
            } else {
                res.status(400);
                return res.json('No valid action.');
            }
        } catch (err) {
            res.status(500);
            res.json();
            console.log(err);
        }
    });

    app.get('/persist/:namespace/:sceneId', checkJWTSubs, (req, res) => {
        const now = new Date();
        const query = {
            sceneId: req.params.sceneId,
            namespace: req.params.namespace,
            expireAt: {$not: {$lt: now}},
        };
        if (req.query.type) {
            query.type = req.query.type;
        }
        ArenaObject.find(query,
            {_id: 0, realm: 0, namespace: 0, sceneId: 0, __v: 0}).
            sort('attributes.parent').
            then((records) => {
                res.json(records);
            });
    });

    app.delete('/persist/:namespace/:sceneId', checkJWTPubs, (req, res) => {
        const query = {
            sceneId: req.params.sceneId,
            namespace: req.params.namespace,
        };
        ArenaObject.deleteMany(query).then((result) => {
            res.json({result: 'success', deletedCount: result.deletedCount});
        });
    });

    app.get('/persist/:namespace/:sceneId/:objectId', checkJWTSubs,
        (req, res) => {
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

    app.get('/persist/health', (req, res) => {
        if (mongooseConnection?.readyState === 1 && mqttClient?.connected) {
            res.json({result: 'success'});
        } else {
            res.status(500);
            res.json({
                result: 'failure',
                database: (mongooseConnection?.readyState === 1) ?
                    'connected' :
                    'disconnected',
                mqtt: mqttClient?.connected ? 'connected' : 'disconnected',
            });
        }
    });

    app.listen(8884);
};
