/**
 * @fileoverview Unit test for what server.js does when its startup fails.
 *
 * server.js runs its startup once as it loads and can only be loaded once per process, so this is
 * a file of its own: `node --test` gives each test file its own process, which is what lets the
 * failing start be driven here while test/server_mqtt.test.js drives the successful one.
 *
 * The fakes are the same in kind as that file's — a mongoose.connect the test releases, a
 * recorded ./express_server, a recorded async-mqtt — with the first keys query made to reject and
 * process.exit recorded rather than taken.
 *
 * Open source software under the terms in /LICENSE
 * Copyright (c) 2026 ARENAXR. All rights reserved.
 */

const assert = require('node:assert/strict');
const {describe, it} = require('node:test');

const mongoose = require('mongoose');

/**
 * Installs a module into the require cache so later requires of it get these exports.
 * @param {string} request - Module specifier, resolved from this file.
 * @param {*} exports - Value to hand out as the module's exports.
 */
const stubModule = (request, exports) => {
    const filename = require.resolve(request);
    require.cache[filename] = {id: filename, filename, loaded: true, exports, children: [], paths: []};
};

describe('startup with an unreadable persists set', () => {
    it('exits non-zero instead of serving with an empty set', async () => {
        let releaseConnect;
        mongoose.connect = () => new Promise((resolve) => {
            releaseConnect = () => resolve(mongoose);
        });

        const mqttConnects = [];
        stubModule('async-mqtt', {
            connectAsync: async (...args) => {
                mqttConnects.push(args);
                return {on: () => {}, subscribe: async () => ({}), publish: async () => {}};
            },
        });
        stubModule('set-interval-async/dynamic', {
            setIntervalAsync: (fn, ms) => ({fn, ms}),
            clearIntervalAsync: async () => {},
        });
        const expressStarts = [];
        stubModule('../express_server', {runExpress: async (collaborators) => expressStarts.push(collaborators)});

        const logs = [];
        const realLog = console.log;
        const realError = console.error;
        console.log = (...args) => logs.push(args.join(' '));
        console.error = (...args) => logs.push(args.join(' '));
        const exits = [];
        const realExit = process.exit;
        process.exit = (code) => exits.push(code);

        // Nothing below should schedule the hourly refresh, since the read it follows fails; the
        // timer is caught anyway so that a regression which does schedule it fails the assertions
        // below rather than holding this process open for an hour.
        const realSetTimeout = global.setTimeout;
        const hourlySchedules = [];
        global.setTimeout = (fn, ms, ...rest) => {
            if (ms === 60 * 60 * 1000) {
                hourlySchedules.push(fn);
                const idle = realSetTimeout(() => {}, 1);
                idle.unref();
                return idle;
            }
            return realSetTimeout(fn, ms, ...rest);
        };

        require('../server');
        const ArenaObject = mongoose.model('ArenaObject');
        // Rejecting the very first query is the whole scenario: mongoose is connected, but the
        // keys cannot be read, so the service would come up believing nothing is persisted.
        ArenaObject.find = () => Promise.reject(new Error('mongo unavailable'));
        releaseConnect();
        try {
            for (let turn = 0; turn < 20; turn++) {
                await new Promise((resolve) => setImmediate(resolve));
            }
        } finally {
            // Everything global goes back, including process.exit: a test process left unable to
            // exit is how a suite that passes here hangs somewhere else.
            global.setTimeout = realSetTimeout;
            process.exit = realExit;
            console.log = realLog;
            console.error = realError;
        }

        assert.deepEqual(exits, [1],
            'startup exits non-zero, so a supervisor restarts the service rather than leaving it hung');
        assert.deepEqual(expressStarts, [],
            'the REST server is never started, so no request is answered out of an empty set');
        assert.deepEqual(mqttConnects, [],
            'and no MQTT subscription is taken, so no update is silently discarded');
        assert.deepEqual(hourlySchedules, [],
            'and no hourly refresh is left behind to make the service look self-healing');
        assert.ok(logs.some((line) => line.includes('mongo unavailable')),
            'the failure names its cause');
    });
});
