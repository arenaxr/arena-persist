/**
 * @fileoverview Unit tests for MQTT topic construction: the TOPICS table combined with formatStr.
 *
 * CONTRIBUTING.md forbids hardcoding topic strings anywhere in the service, so these tests pin the
 * exact strings the TOPICS table renders, and pin the TOKENS indices against those strings.
 *
 * Open source software under the terms in /LICENSE
 * Copyright (c) 2026 ARENAXR. All rights reserved.
 */

const assert = require('node:assert/strict');
const {describe, it} = require('node:test');
const MQTTPattern = require('mqtt-pattern');

// utils.js installs String.prototype.formatStr as a side effect; topics.js does not require it.
require('../utils');
const config = require('../config.json');
const {TOPICS} = require('../topics');

/** Every placeholder used anywhere in the TOPICS table, so a rendered topic has no leftovers. */
const VARS = Object.freeze({
    nameSpace: 'namespace1',
    sceneName: 'scene1',
    userClient: 'jdoe_1448081341_web',
    idTag: 'jdoe_1448081341',
    userObj: 'camera_jdoe_1448081341',
    objectId: 'box-1',
    toUid: 'asmith_1448081342',
    deviceName: 'sensor1',
    rtUuid: 'rt-uuid-1',
    uuid: 'proc-uuid-1',
});

describe('TOPICS table', () => {
    it('draws its realm prefix from config.json, which is committed and needs no env setup', () => {
        assert.strictEqual(config.mqtt.topic_realm, 'realm');
    });

    it('is frozen at the top level', () => {
        assert.ok(Object.isFrozen(TOPICS));
    });

    it('exposes contiguous, unique token indices', () => {
        const indices = Object.values(TOPICS.TOKENS);
        assert.deepStrictEqual(indices, [0, 1, 2, 3, 4, 5, 6, 7]);
        assert.strictEqual(new Set(indices).size, indices.length);
    });

    it('exposes single-character scene message types', () => {
        assert.deepStrictEqual(TOPICS.SCENE_MSGTYPES, {
            PRESENCE: 'x',
            CHAT: 'c',
            USER: 'u',
            OBJECTS: 'o',
            RENDER: 'r',
            ENV: 'e',
            PROGRAM: 'p',
            DEBUG: 'd',
        });
    });
});

describe('TOPICS.PUBLISH rendering', () => {
    const cases = [
        ['NETWORK_LATENCY', '$NETWORK/latency'],
        ['DEVICE', 'realm/d/namespace1/sensor1/jdoe_1448081341'],
        ['RT_RUNTIME', 'realm/g/namespace1/p/rt-uuid-1'],
        ['RT_MODULES', 'realm/s/namespace1/scene1/p/jdoe_1448081341_web/jdoe_1448081341'],
        ['PROC_DBG', 'realm/proc/debug/proc-uuid-1'],
        ['SCENE_PRESENCE', 'realm/s/namespace1/scene1/x/jdoe_1448081341_web/jdoe_1448081341'],
        [
            'SCENE_PRESENCE_PRIVATE',
            'realm/s/namespace1/scene1/x/jdoe_1448081341_web/jdoe_1448081341/asmith_1448081342',
        ],
        ['SCENE_CHAT', 'realm/s/namespace1/scene1/c/jdoe_1448081341_web/jdoe_1448081341'],
        ['SCENE_CHAT_PRIVATE', 'realm/s/namespace1/scene1/c/jdoe_1448081341_web/jdoe_1448081341/asmith_1448081342'],
        ['SCENE_USER', 'realm/s/namespace1/scene1/u/jdoe_1448081341_web/camera_jdoe_1448081341'],
        [
            'SCENE_USER_PRIVATE',
            'realm/s/namespace1/scene1/u/jdoe_1448081341_web/camera_jdoe_1448081341/asmith_1448081342',
        ],
        ['SCENE_OBJECTS', 'realm/s/namespace1/scene1/o/jdoe_1448081341_web/box-1'],
        ['SCENE_OBJECTS_PRIVATE', 'realm/s/namespace1/scene1/o/jdoe_1448081341_web/box-1/asmith_1448081342'],
        ['SCENE_RENDER', 'realm/s/namespace1/scene1/r/jdoe_1448081341_web/jdoe_1448081341'],
        ['SCENE_RENDER_PRIVATE', 'realm/s/namespace1/scene1/r/jdoe_1448081341_web/jdoe_1448081341/-'],
        ['SCENE_ENV', 'realm/s/namespace1/scene1/e/jdoe_1448081341_web/jdoe_1448081341'],
        ['SCENE_ENV_PRIVATE', 'realm/s/namespace1/scene1/e/jdoe_1448081341_web/jdoe_1448081341/-'],
        ['SCENE_PROGRAM', 'realm/s/namespace1/scene1/p/jdoe_1448081341_web/jdoe_1448081341'],
        ['SCENE_PROGRAM_PRIVATE', 'realm/s/namespace1/scene1/p/jdoe_1448081341_web/jdoe_1448081341/asmith_1448081342'],
        ['SCENE_DEBUG', 'realm/s/namespace1/scene1/d/jdoe_1448081341_web/jdoe_1448081341/-'],
    ];

    cases.forEach(([key, expected]) => {
        it(`renders ${key} to ${expected}`, () => {
            assert.strictEqual(TOPICS.PUBLISH[key].formatStr(VARS), expected);
        });
    });

    it('covers every PUBLISH entry', () => {
        assert.deepStrictEqual(cases.map(([key]) => key).sort(), Object.keys(TOPICS.PUBLISH).sort());
    });
});

describe('TOPICS.SUBSCRIBE rendering', () => {
    const cases = [
        ['NETWORK', '$NETWORK'],
        ['DEVICE', 'realm/d/namespace1/sensor1/#'],
        ['RT_RUNTIME', 'realm/g/namespace1/p/rt-uuid-1'],
        ['RT_MODULES', 'realm/s/namespace1/scene1/p/+/+'],
        ['SCENE_PUBLIC', 'realm/s/namespace1/scene1/+/+/+'],
        ['SCENE_PRIVATE', 'realm/s/namespace1/scene1/+/+/+/jdoe_1448081341/#'],
        ['SCENE_RENDER_PUBLIC', 'realm/s/namespace1/scene1/r/+/-'],
        ['SCENE_RENDER_PRIVATE', 'realm/s/namespace1/scene1/r/+/-/jdoe_1448081341/#'],
    ];

    cases.forEach(([key, expected]) => {
        it(`renders ${key} to ${expected}`, () => {
            assert.strictEqual(TOPICS.SUBSCRIBE[key].formatStr(VARS), expected);
        });
    });

    it('covers every SUBSCRIBE entry', () => {
        assert.deepStrictEqual(cases.map(([key]) => key).sort(), Object.keys(TOPICS.SUBSCRIBE).sort());
    });
});

describe('TOPICS placeholder coverage', () => {
    ['PUBLISH', 'SUBSCRIBE'].forEach((group) => {
        Object.entries(TOPICS[group]).forEach(([key, template]) => {
            it(`${group}.${key} has no placeholder outside the known variable set`, () => {
                assert.strictEqual(
                    template.formatStr(VARS).match(/\{[^}]+\}/g),
                    null,
                    `unrendered placeholder in ${group}.${key}; add the variable to VARS`,
                );
            });
        });
    });
});

describe('TOPICS.TOKENS indices align with rendered scene topics', () => {
    const {TOKENS, SCENE_MSGTYPES} = TOPICS;

    it('locates each token of a scene-objects publish topic', () => {
        const parts = TOPICS.PUBLISH.SCENE_OBJECTS.formatStr(VARS).split('/');
        assert.strictEqual(parts.length, 7);
        assert.strictEqual(parts[TOKENS.REALM], 'realm');
        assert.strictEqual(parts[TOKENS.TYPE], 's');
        assert.strictEqual(parts[TOKENS.NAMESPACE], VARS.nameSpace);
        assert.strictEqual(parts[TOKENS.SCENENAME], VARS.sceneName);
        assert.strictEqual(parts[TOKENS.SCENE_MSGTYPE], SCENE_MSGTYPES.OBJECTS);
        assert.strictEqual(parts[TOKENS.USER_CLIENT], VARS.userClient);
        // server.js reads the persisted object id out of this slot.
        assert.strictEqual(parts[TOKENS.UUID], VARS.objectId);
    });

    it('locates the recipient token of a private scene-objects topic', () => {
        const parts = TOPICS.PUBLISH.SCENE_OBJECTS_PRIVATE.formatStr(VARS).split('/');
        assert.strictEqual(parts.length, 8);
        assert.strictEqual(parts[TOKENS.UUID], VARS.objectId);
        assert.strictEqual(parts[TOKENS.TO_UID], VARS.toUid);
    });

    const msgTypeCases = [
        ['SCENE_PRESENCE', 'PRESENCE'],
        ['SCENE_CHAT', 'CHAT'],
        ['SCENE_USER', 'USER'],
        ['SCENE_OBJECTS', 'OBJECTS'],
        ['SCENE_RENDER', 'RENDER'],
        ['SCENE_ENV', 'ENV'],
        ['SCENE_PROGRAM', 'PROGRAM'],
        ['SCENE_DEBUG', 'DEBUG'],
    ];

    msgTypeCases.forEach(([topicKey, msgTypeKey]) => {
        it(`${topicKey} carries SCENE_MSGTYPES.${msgTypeKey} in the message-type slot`, () => {
            const parts = TOPICS.PUBLISH[topicKey].formatStr(VARS).split('/');
            assert.strictEqual(parts[TOKENS.SCENE_MSGTYPE], SCENE_MSGTYPES[msgTypeKey]);
        });
    });
});

describe('TOPICS wildcard rendering', () => {
    const allWild = {nameSpace: '+', sceneName: '+', userClient: '+', objectId: '+'};

    it('renders the service-wide scene-objects subscription used at MQTT connect', () => {
        assert.strictEqual(TOPICS.PUBLISH.SCENE_OBJECTS.formatStr(allWild), 'realm/s/+/+/o/+/+');
    });

    it('renders a per-scene wildcard topic for JWT rights checks', () => {
        const topic = TOPICS.PUBLISH.SCENE_OBJECTS.formatStr({
            nameSpace: 'namespace1',
            sceneName: 'scene1',
            userClient: '+',
            objectId: '+',
        });
        assert.strictEqual(topic, 'realm/s/namespace1/scene1/o/+/+');
    });

    it('leaves unsupplied placeholders intact so partial rendering is visible', () => {
        assert.strictEqual(
            TOPICS.PUBLISH.SCENE_OBJECTS.formatStr({nameSpace: 'namespace1', sceneName: 'scene1'}),
            'realm/s/namespace1/scene1/o/{userClient}/{objectId}',
        );
    });

    it('produces wildcard topics that mqtt-pattern matches against concrete scene topics', () => {
        const pattern = TOPICS.PUBLISH.SCENE_OBJECTS.formatStr(allWild);
        assert.ok(MQTTPattern.matches(pattern, TOPICS.PUBLISH.SCENE_OBJECTS.formatStr(VARS)));
        // A single-level '+' must not swallow the extra recipient token of a private topic.
        assert.ok(!MQTTPattern.matches(pattern, TOPICS.PUBLISH.SCENE_OBJECTS_PRIVATE.formatStr(VARS)));
    });
});
