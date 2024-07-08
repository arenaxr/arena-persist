/**
 * @fileoverview Topic names for ARENA pubsub messages.
 *
 * Open source software under the terms in /LICENSE
 * Copyright (c) 2024 ARENAXR. All rights reserved.
 * @date 2024
 */

import config from 'config.json';

/**
 * ARENA pubsub topic variables
 * - nameSpace - namespace of the scene
 * - sceneName - name of the scene
 * - userName - name of the user per arena-auth (e.g. jdoe)
 * - idTag - username prefixed with a uuid (e.g. 1448081341_jdoe)
 * - camName - idTag prefixed with camera_ (e.g. camera_1448081341_jdoe)
 */

const REALM = config.mqtt.topic_realm;

/* eslint-disable key-spacing */
// prettier-ignore
const TOPICS = Object.freeze({
    SUBSCRIBE: {
        NETWORK:               '$NETWORK',
        CHAT_PUBLIC:           `${REALM}/c/{nameSpace}/o/#`,
        CHAT_PRIVATE:          `${REALM}/c/{nameSpace}/p/{idTag}/#`,
        DEVICE:                `${REALM}/d/{userName}/#`, // All client placeholder
        PROC_REG:              `${REALM}/proc/reg`,
        PROC_CTL:              `${REALM}/proc/control/{uuid}/#`,
        PROC_DBG:              `${REALM}/proc/debug/{uuid}`,
        SCENE_PUBLIC:          `${REALM}/s/{nameSpace}/{sceneName}/+/+`,
        SCENE_PRIVATE:         `${REALM}/s/{nameSpace}/{sceneName}/+/+/{camName}/#`,
    },
    PUBLISH: {
        NETWORK_LATENCY:       '$NETWORK/latency',
        CHAT_PUBLIC:           `${REALM}/c/{nameSpace}/o/{idTag}`,
        CHAT_PRIVATE:          `${REALM}/c/{nameSpace}/p/{toUid}/{idTag}`,
        DEVICE:                `${REALM}/d/{nameSpace}/{sceneName}/{idTag}`,
        PROC_REG:              `${REALM}/proc/reg`,
        PROC_CTL:              `${REALM}/proc/control`,
        PROC_DBG:              `${REALM}/proc/debug/{uuid}`,
        SCENE_PRESENCE:        `${REALM}/s/{nameSpace}/{sceneName}/x/{idTag}`,
        SCENE_USER:            `${REALM}/s/{nameSpace}/{sceneName}/u/{userObj}`,
        SCENE_USER_PRIVATE:    `${REALM}/s/{nameSpace}/{sceneName}/u/{userObj}/{toUid}`, // Need to add face_ privs
        SCENE_OBJECTS:         `${REALM}/s/{nameSpace}/{sceneName}/o/{objectId}`, // All client placeholder
        SCENE_OBJECTS_PRIVATE: `${REALM}/s/{nameSpace}/{sceneName}/o/{objectId}/{toUid}`,
        SCENE_RENDER:          `${REALM}/s/{nameSpace}/{sceneName}/r/{camName}`,
        SCENE_RENDER_PRIVATE:  `${REALM}/s/{nameSpace}/{sceneName}/r/{camName}/-`, // To avoid unpriv sub
        SCENE_ENV:             `${REALM}/s/{nameSpace}/{sceneName}/e/{camName}`,
        SCENE_ENV_PRIVATE:     `${REALM}/s/{nameSpace}/{sceneName}/e/{camName}/-`, // To avoid unpriv sub
        SCENE_PROGRAM:         `${REALM}/s/{nameSpace}/{sceneName}/p/{camName}`,
        SCENE_PROGRAM_PRIVATE: `${REALM}/s/{nameSpace}/{sceneName}/p/{camName}/{toUid}`,
        SCENE_DEBUG:           `${REALM}/s/{nameSpace}/{sceneName}/d/{camName}/-`, // To avoid unpriv sub
    },
});

export default TOPICS;
