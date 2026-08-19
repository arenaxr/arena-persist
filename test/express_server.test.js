/**
 * @fileoverview Unit tests for the REST API and JWT authorization in express_server.js.
 *
 * runExpress already takes every collaborator it needs as an injected parameter, so the only
 * things standing between it and a unit test are the express and cookie-parser modules and the
 * app.listen() call at the end. Both modules are replaced in the require cache before
 * express_server is loaded, by a fake express whose app only records what was registered on it,
 * so nothing binds a port, opens a socket or talks to MongoDB. The route handlers and the
 * middleware chain are then the real ones, invoked directly.
 *
 * Path patterns are express's job, not this service's, so requests here name the registered route
 * and supply req.params/req.query/req.body directly rather than being parsed out of a URL.
 *
 * Open source software under the terms in /LICENSE
 * Copyright (c) 2026 ARENAXR. All rights reserved.
 */

const assert = require('node:assert/strict');
const {describe, it} = require('node:test');

/**
 * Installs a module into the require cache so later requires of it get these exports.
 * @param {string} request - Module specifier, resolved from this file.
 * @param {*} exports - Value to hand out as the module's exports.
 */
const stubModule = (request, exports) => {
    const filename = require.resolve(request);
    require.cache[filename] = {id: filename, filename, loaded: true, exports, children: [], paths: []};
};

/** Apps handed out by the fake express module, newest last. */
const createdApps = [];

/**
 * Builds a fake express app that records registrations instead of serving them.
 * @return {Object} The fake app, with its recorded middleware, routes, listen ports and
 *     disabled settings.
 */
const makeFakeApp = () => {
    const app = {middleware: [], routes: [], listens: [], disabled: []};
    app.disable = (setting) => app.disabled.push(setting);
    app.use = (...handlers) => app.middleware.push(...handlers);
    for (const method of ['get', 'post', 'delete']) {
        app[method] = (path, ...handlers) => app.routes.push({method, path, handlers});
    }
    app.listen = (port) => {
        app.listens.push(port);
        return {close: () => {}};
    };
    return app;
};

const fakeExpress = () => {
    const app = makeFakeApp();
    createdApps.push(app);
    return app;
};
fakeExpress.json = () => function jsonMiddleware(req, res, next) {
    next();
};

stubModule('express', fakeExpress);
stubModule('cookie-parser', () => function cookieMiddleware(req, res, next) {
    next();
});

const {runExpress} = require('../express_server');
require('../utils'); // installs String.prototype.formatStr, used by the TOPICS table
const {TOPICS} = require('../topics');

/**
 * Renders the scene-objects topic the authorization checks are built around.
 * @param {string} nameSpace - Namespace of the scene.
 * @param {string} sceneName - Name of the scene.
 * @param {string} [userClient] - Client token, defaulting to the single-level wildcard.
 * @return {string} The rendered topic, with the object id left as a wildcard.
 */
const sceneTopic = (nameSpace, sceneName, userClient = '+') => TOPICS.PUBLISH.SCENE_OBJECTS.formatStr({
    nameSpace, sceneName, userClient, objectId: '+',
});

/**
 * A thenable that also answers the query-builder calls the routes chain onto find/aggregate.
 * @param {*} rows - Value the query resolves to.
 * @return {Promise} Promise carrying sort() and exec() passthroughs.
 */
const fakeQuery = (rows) => {
    const query = Promise.resolve(rows);
    query.sort = () => query;
    query.exec = () => query;
    return query;
};

/**
 * Builds a fake ArenaObject model that records every query it is asked to run.
 * @param {Object} [results] - Canned results.
 * @param {Array} [results.find] - Rows returned by find().
 * @param {Array} [results.aggregate] - Rows returned by aggregate().
 * @param {Array} [results.distinct] - Values returned by distinct().
 * @param {Array<number>} [results.counts] - countDocuments() answers, consumed in call order.
 * @param {number} [results.deletedCount] - deletedCount reported by deleteMany().
 * @return {Object} The fake model, with a calls record keyed by method name.
 */
const fakeArenaObject = ({find = [], aggregate = [], distinct = [], counts = [], deletedCount = 0} = {}) => {
    const calls = {find: [], aggregate: [], distinct: [], countDocuments: [], deleteMany: []};
    const pending = [...counts];
    return {
        calls,
        find: (...args) => {
            calls.find.push(args);
            return fakeQuery(find);
        },
        aggregate: (...args) => {
            calls.aggregate.push(args);
            return fakeQuery(aggregate);
        },
        distinct: (...args) => {
            calls.distinct.push(args);
            return fakeQuery(distinct);
        },
        countDocuments: async (...args) => {
            calls.countDocuments.push(args);
            return pending.length ? pending.shift() : 0;
        },
        deleteMany: async (...args) => {
            calls.deleteMany.push(args);
            return {deletedCount};
        },
    };
};

/**
 * Builds a fake response that records the status and body a handler produced.
 * @return {Object} The fake response; ended is true once json() has been called.
 */
const fakeRes = () => {
    const res = {statusCode: 200, bodies: [], ended: false};
    res.status = (code) => {
        res.statusCode = code;
        return res;
    };
    res.json = (body) => {
        res.bodies.push(body);
        res.body = body;
        res.ended = true;
        if (res.onEnd) {
            res.onEnd();
        }
        return res;
    };
    return res;
};

/**
 * Runs one middleware or handler and resolves once it either finishes the response or calls next.
 *
 * Handlers that finish inside a promise chain (the JWT check, every mongoose query) settle on a
 * microtask, so two macrotask turns are enough to see the outcome without any wall-clock waiting.
 * @param {function} handler - The middleware or route handler to invoke.
 * @param {Object} req - Fake request.
 * @param {Object} res - Fake response.
 * @return {Promise<Object>} What the handler did: ended, next, and the argument next got.
 */
const runHandler = (handler, req, res) => new Promise((resolve, reject) => {
    const outcome = {ended: false, next: false, nextArg: undefined};
    let settled = false;
    const settle = () => {
        if (!settled) {
            settled = true;
            resolve(outcome);
        }
    };
    res.onEnd = () => {
        outcome.ended = true;
        settle();
    };
    const next = (arg) => {
        outcome.next = true;
        outcome.nextArg = arg;
        settle();
    };
    let returned;
    try {
        returned = handler(req, res, next);
    } catch (err) {
        reject(err);
        return;
    }
    Promise.resolve(returned).then(() => setImmediate(() => setImmediate(settle)), reject);
});

/**
 * Starts the service against fakes and returns the app it built.
 * @param {Object} [deps] - Overrides for the injected collaborators.
 * @return {Promise<Object>} The fake app, plus the collaborators it was started with.
 */
const startApp = async (deps = {}) => {
    const collaborators = {
        ArenaObject: fakeArenaObject(),
        mqttClient: {connected: true},
        jwk: null,
        mongooseConnection: {readyState: 1},
        loadTemplate: async () => {},
        persists: new Set(),
        jose: {jwtVerify: async () => ({payload: {}})},
        ...deps,
    };
    await runExpress(collaborators);
    return {app: createdApps[createdApps.length - 1], ...collaborators};
};

/**
 * Sends a request through the app's global middleware and the named route's handlers.
 * @param {Object} app - Fake app returned by startApp.
 * @param {Object} request - The request to run.
 * @param {string} request.method - HTTP method, lowercase.
 * @param {string} request.path - The route path as registered on the app.
 * @param {Object} [request.params] - req.params.
 * @param {Object} [request.query] - req.query.
 * @param {Object} [request.body] - req.body.
 * @param {Object} [request.cookies] - req.cookies.
 * @param {string} [request.originalUrl] - req.originalUrl, defaults to the route path.
 * @return {Promise<Object>} The request, the response and the per-handler outcomes.
 */
const request = async (app, {method, path, params = {}, query = {}, body = {}, cookies = {}, originalUrl}) => {
    const route = app.routes.find((r) => r.method === method && r.path === path);
    assert.ok(route, `no route registered for ${method} ${path}`);
    const req = {method, params, query, body, cookies, originalUrl: originalUrl ?? path};
    const res = fakeRes();
    const outcomes = [];
    for (const handler of [...app.middleware, ...route.handlers]) {
        const outcome = await runHandler(handler, req, res);
        outcomes.push(outcome);
        if (outcome.ended || !outcome.next) {
            break;
        }
    }
    return {req, res, outcomes};
};

/** A JWK stand-in: runExpress only checks it for truthiness and hands it to jose. */
const JWK = {kty: 'RSA', fake: true};

/**
 * A jose stand-in that verifies exactly one token string and rejects everything else.
 * @param {Object} payload - Payload to return for the good token.
 * @param {string} [goodToken] - The token string that verifies.
 * @return {Object} The fake jose, with the arguments of every jwtVerify call.
 */
const fakeJose = (payload, goodToken = 'good-token') => {
    const verifyCalls = [];
    return {
        verifyCalls,
        jwtVerify: (token, key, options) => {
            verifyCalls.push({token, key, options});
            if (token !== goodToken) {
                return Promise.reject(new Error('JWSSignatureVerificationFailed'));
            }
            return Promise.resolve({payload});
        },
    };
};

describe('runExpress app wiring', () => {
    it('disables the x-powered-by header and listens on the persist port', async () => {
        const {app} = await startApp();
        assert.deepEqual(app.disabled, ['x-powered-by']);
        assert.deepEqual(app.listens, [8884]);
    });

    it('registers every documented route exactly once', async () => {
        const {app} = await startApp();
        assert.deepEqual(app.routes.map((r) => `${r.method} ${r.path}`), [
            'get /persist/\\!allnamespaces',
            'get /persist/\\!allscenes',
            'get /persist/:namespace/\\!allscenes',
            'post /persist/:namespace/:sceneId',
            'get /persist/:namespace/:sceneId',
            'delete /persist/:namespace/:sceneId',
            'get /persist/:namespace/:sceneId/:objectId',
            'get /persist/health',
        ]);
    });

    it('guards the read and write routes with a per-route rights check, and health with none', async () => {
        const {app} = await startApp({jwk: JWK, jose: fakeJose({})});
        const guards = new Map(app.routes.map((r) => [`${r.method} ${r.path}`, r.handlers.length - 1]));
        assert.equal(guards.get('get /persist/:namespace/:sceneId'), 1);
        assert.equal(guards.get('get /persist/:namespace/:sceneId/:objectId'), 1);
        assert.equal(guards.get('post /persist/:namespace/:sceneId'), 1);
        assert.equal(guards.get('delete /persist/:namespace/:sceneId'), 1);
        assert.equal(guards.get('get /persist/health'), 0);
    });

    it('adds cookie parsing and token verification only when a JWK is configured', async () => {
        const open = await startApp({jwk: null});
        const closed = await startApp({jwk: JWK, jose: fakeJose({})});
        assert.equal(open.app.middleware.length, 2, 'mqtt gate and json body parser only');
        assert.equal(closed.app.middleware.length, 4, 'plus cookie parsing and token verification');
    });
});

describe('MQTT connection gate', () => {
    for (const route of [
        {method: 'get', path: '/persist/:namespace/:sceneId'},
        {method: 'delete', path: '/persist/:namespace/:sceneId'},
        {method: 'get', path: '/persist/health'},
    ]) {
        it(`answers 503 for ${route.method} ${route.path} while MQTT is disconnected`, async () => {
            const {app} = await startApp({mqttClient: {connected: false}});
            const {res, outcomes} = await request(app, {...route, params: {namespace: 'public', sceneId: 'lobby'}});
            assert.equal(res.statusCode, 503);
            assert.equal(res.body, 'Disconnected from MQTT');
            assert.equal(outcomes.length, 1, 'nothing downstream of the gate runs');
            assert.equal(outcomes[0].nextArg, 'Disconnected from MQTT', 'and the error is passed to next');
        });
    }

    it('lets requests through while MQTT is connected', async () => {
        const {app, ArenaObject} = await startApp();
        const {res} = await request(app, {
            method: 'get', path: '/persist/:namespace/:sceneId', params: {namespace: 'public', sceneId: 'lobby'},
        });
        assert.equal(res.statusCode, 200);
        assert.equal(ArenaObject.calls.find.length, 1);
    });
});

describe('token verification middleware', () => {
    it('verifies the mqtt_token cookie with RS256 only, and exposes the payload to the routes', async () => {
        const jose = fakeJose({subs: ['realm/#'], publ: ['realm/#']});
        const {app} = await startApp({jwk: JWK, jose});
        const {req, res} = await request(app, {
            method: 'get',
            path: '/persist/:namespace/:sceneId',
            params: {namespace: 'public', sceneId: 'lobby'},
            cookies: {mqtt_token: 'good-token'},
        });
        assert.equal(res.statusCode, 200);
        assert.equal(jose.verifyCalls.length, 1);
        assert.equal(jose.verifyCalls[0].token, 'good-token');
        assert.equal(jose.verifyCalls[0].key, JWK);
        assert.deepEqual(jose.verifyCalls[0].options, {algorithms: ['RS256']},
            'no algorithm other than RS256 is accepted, so an unsigned token cannot be substituted');
        assert.deepEqual(req.jwtPayload, {subs: ['realm/#'], publ: ['realm/#']});
    });

    const rejected = [
        {name: 'no cookie at all', cookies: {}},
        {name: 'an unrelated cookie', cookies: {other: 'good-token'}},
        {name: 'an empty token', cookies: {mqtt_token: ''}},
        {name: 'a token that fails verification', cookies: {mqtt_token: 'forged'}},
    ];
    for (const {name, cookies} of rejected) {
        it(`answers 401 for ${name}`, async () => {
            const jose = fakeJose({subs: ['realm/#']});
            const {app, ArenaObject} = await startApp({jwk: JWK, jose});
            const {res} = await request(app, {
                method: 'get',
                path: '/persist/:namespace/:sceneId',
                params: {namespace: 'public', sceneId: 'lobby'},
                cookies,
            });
            assert.equal(res.statusCode, 401);
            assert.equal(res.body, 'Error validating mqtt permissions');
            assert.equal(ArenaObject.calls.find.length, 0, 'the scene is never queried');
        });
    }

    it('lets the health check through without a token, so an unauthenticated probe still works', async () => {
        const jose = fakeJose({});
        const {app} = await startApp({jwk: JWK, jose});
        const {res} = await request(app, {method: 'get', path: '/persist/health'});
        assert.equal(res.statusCode, 200);
        assert.deepEqual(res.body, {result: 'success'});
        assert.equal(jose.verifyCalls.length, 0);
    });

    it('does not verify anything when no JWK is configured', async () => {
        const jose = fakeJose({});
        const {app} = await startApp({jwk: null, jose});
        const {req, res} = await request(app, {
            method: 'get', path: '/persist/:namespace/:sceneId', params: {namespace: 'public', sceneId: 'lobby'},
        });
        assert.equal(res.statusCode, 200);
        assert.equal(jose.verifyCalls.length, 0);
        assert.equal(req.jwtPayload, undefined);
    });
});

describe('scene rights checks', () => {
    /**
     * Runs a request for public/lobby with the given rights in the token.
     * @param {Object} rights - The subs and publ claims to put in the payload.
     * @param {Object} route - method and path of the route to call.
     * @return {Promise<Object>} The response and the fake model.
     */
    const withRights = async (rights, route) => {
        const {app, ArenaObject} = await startApp({jwk: JWK, jose: fakeJose(rights)});
        const {res} = await request(app, {
            ...route,
            params: {namespace: 'public', sceneId: 'lobby', objectId: 'box-1'},
            cookies: {mqtt_token: 'good-token'},
        });
        return {res, ArenaObject};
    };

    const READ = {method: 'get', path: '/persist/:namespace/:sceneId'};

    const granting = [
        {name: 'the exact scene-objects wildcard for the scene', right: sceneTopic('public', 'lobby')},
        {name: 'a hash wildcard over the whole realm', right: 'realm/#'},
        {name: 'a hash wildcard over the namespace', right: 'realm/s/public/#'},
        {name: 'a hash wildcard over the scene', right: 'realm/s/public/lobby/#'},
        {name: 'a plus wildcard over every namespace and scene', right: sceneTopic('+', '+')},
        {
            name: 'a per-client right for this scene, kept for id purposes',
            right: sceneTopic('public', 'lobby', 'a_1_web'),
        },
    ];
    for (const {name, right} of granting) {
        it(`grants read access for ${name}`, async () => {
            const {res, ArenaObject} = await withRights({subs: [right]}, READ);
            assert.equal(res.statusCode, 200, `expected ${right} to grant public/lobby`);
            assert.equal(ArenaObject.calls.find.length, 1);
        });
    }

    const denying = [
        {name: 'no rights at all', right: undefined, rights: []},
        {name: 'another scene in the same namespace', right: sceneTopic('public', 'other')},
        {name: 'another namespace', right: sceneTopic('private', 'lobby')},
        {name: 'a scene whose name only shares a prefix', right: sceneTopic('public', 'lobbyextra')},
        {name: 'a per-client right in another scene', right: sceneTopic('public', 'other', 'a_1_web')},
        {name: 'a right scoped to a single object in the scene', right: 'realm/s/public/lobby/o/a_1_web/box-1'},
        {name: 'a right that stops short of the object id', right: 'realm/s/public/lobby/o/a_1_web'},
        {name: 'a chat topic for the scene rather than an objects topic', right: 'realm/s/public/lobby/c/+/+'},
        {name: 'the same scene under a different realm', right: 'other/s/public/lobby/o/+/+'},
    ];
    for (const {name, right, rights} of denying) {
        it(`denies read access for ${name}`, async () => {
            const {res, ArenaObject} = await withRights({subs: rights ?? [right]}, READ);
            assert.equal(res.statusCode, 401, `expected ${right} not to grant public/lobby`);
            assert.equal(res.body, 'You have not been granted read access');
            assert.equal(ArenaObject.calls.find.length, 0, 'the scene is never queried');
        });
    }

    it('takes the first matching right out of a long list', async () => {
        const rights = [sceneTopic('public', 'other'), 'realm/s/private/#', sceneTopic('public', 'lobby')];
        const {res} = await withRights({subs: rights}, READ);
        assert.equal(res.statusCode, 200);
    });

    it('reads the subs claim for reads and the publ claim for writes', async () => {
        const readOnly = {subs: [sceneTopic('public', 'lobby')], publ: []};
        const readable = await withRights(readOnly, READ);
        assert.equal(readable.res.statusCode, 200);
        const writable = await withRights(readOnly, {method: 'delete', path: '/persist/:namespace/:sceneId'});
        assert.equal(writable.res.statusCode, 401);
        assert.equal(writable.res.body, 'You have not been granted write access');
        assert.equal(writable.ArenaObject.calls.deleteMany.length, 0, 'nothing is deleted');

        const writeOnly = {subs: [], publ: [sceneTopic('public', 'lobby')]};
        const denied = await withRights(writeOnly, READ);
        assert.equal(denied.res.statusCode, 401);
        assert.equal(denied.res.body, 'You have not been granted read access');
        const allowed = await withRights(writeOnly, {method: 'delete', path: '/persist/:namespace/:sceneId'});
        assert.equal(allowed.res.statusCode, 200);
    });

    it('guards the single-object route with the same scene-wide read check', async () => {
        const route = {method: 'get', path: '/persist/:namespace/:sceneId/:objectId'};
        const granted = await withRights({subs: [sceneTopic('public', 'lobby')]}, route);
        assert.equal(granted.res.statusCode, 200);
        const denied = await withRights({subs: [sceneTopic('public', 'other')]}, route);
        assert.equal(denied.res.statusCode, 401);
    });

    // Characterization, not endorsement: a verified token that simply has no claim for the rights
    // type being checked makes the check throw instead of answering 401, which express turns into
    // a 500. Pinned so a later change to the check has to decide about it deliberately.
    it('throws instead of answering 401 when the token has no claim of the checked type', async () => {
        const {app} = await startApp({jwk: JWK, jose: fakeJose({subs: ['realm/#']})});
        await assert.rejects(() => request(app, {
            method: 'delete',
            path: '/persist/:namespace/:sceneId',
            params: {namespace: 'public', sceneId: 'lobby'},
            cookies: {mqtt_token: 'good-token'},
        }), TypeError);
    });

    it('applies no rights check at all when no JWK is configured', async () => {
        const {app, ArenaObject} = await startApp({jwk: null});
        const {res} = await request(app, {
            method: 'delete', path: '/persist/:namespace/:sceneId', params: {namespace: 'public', sceneId: 'lobby'},
        });
        assert.equal(res.statusCode, 200);
        assert.equal(ArenaObject.calls.deleteMany.length, 1);
    });
});

describe('namespace and scene listings', () => {
    const STAFF = sceneTopic('+', '+');

    it('lists namespaces for a token with realm-wide read rights', async () => {
        const ArenaObject = fakeArenaObject({distinct: ['public', 'private']});
        const {app} = await startApp({jwk: JWK, jose: fakeJose({subs: [STAFF]}), ArenaObject});
        const {res} = await request(app, {
            method: 'get', path: '/persist/\\!allnamespaces', cookies: {mqtt_token: 'good-token'},
        });
        assert.deepEqual(res.body, ['public', 'private']);
        assert.deepEqual(ArenaObject.calls.distinct, [['namespace']]);
    });

    it('refuses the namespace listing for a token limited to one namespace', async () => {
        const ArenaObject = fakeArenaObject({distinct: ['public']});
        const {app} = await startApp({jwk: JWK, jose: fakeJose({subs: ['realm/s/public/#']}), ArenaObject});
        const {res} = await request(app, {
            method: 'get', path: '/persist/\\!allnamespaces', cookies: {mqtt_token: 'good-token'},
        });
        assert.equal(res.statusCode, 401);
        assert.equal(res.body, 'You have not been granted read access');
        assert.equal(ArenaObject.calls.distinct.length, 0);
    });

    it('lists every scene as namespace/sceneId for a staff token', async () => {
        const ArenaObject = fakeArenaObject({aggregate: [
            {_id: {namespace: 'public', sceneId: 'lobby'}},
            {_id: {namespace: 'private', sceneId: 'office'}},
        ]});
        const {app} = await startApp({jwk: JWK, jose: fakeJose({subs: [STAFF]}), ArenaObject});
        const {res} = await request(app, {
            method: 'get', path: '/persist/\\!allscenes', cookies: {mqtt_token: 'good-token'},
        });
        assert.deepEqual(res.body, ['public/lobby', 'private/office']);
        const [pipeline] = ArenaObject.calls.aggregate[0];
        assert.deepEqual(pipeline[0].$group._id, {namespace: '$namespace', sceneId: '$sceneId'});
        assert.deepEqual(pipeline[1].$sort, {'_id.namespace': 1, '_id.sceneId': 1});
    });

    it('refuses the global scene listing for a namespace-only token', async () => {
        const ArenaObject = fakeArenaObject({aggregate: [{_id: {namespace: 'public', sceneId: 'lobby'}}]});
        const {app} = await startApp({jwk: JWK, jose: fakeJose({subs: ['realm/s/public/#']}), ArenaObject});
        const {res} = await request(app, {
            method: 'get', path: '/persist/\\!allscenes', cookies: {mqtt_token: 'good-token'},
        });
        assert.equal(res.statusCode, 401);
        assert.equal(ArenaObject.calls.aggregate.length, 0);
    });

    it('scopes the per-namespace listing to that namespace and requires rights over it', async () => {
        const ArenaObject = fakeArenaObject({aggregate: [
            {_id: {namespace: 'public', sceneId: 'lobby'}},
            {_id: {namespace: 'public', sceneId: 'atrium'}},
        ]});
        const {app} = await startApp({jwk: JWK, jose: fakeJose({subs: ['realm/s/public/#']}), ArenaObject});
        const {res} = await request(app, {
            method: 'get',
            path: '/persist/:namespace/\\!allscenes',
            params: {namespace: 'public'},
            cookies: {mqtt_token: 'good-token'},
        });
        assert.deepEqual(res.body, ['public/lobby', 'public/atrium']);
        const [pipeline] = ArenaObject.calls.aggregate[0];
        assert.deepEqual(pipeline[0].$match, {namespace: 'public'});
        assert.deepEqual(pipeline[2].$sort, {'_id.sceneId': 1});
    });

    it('refuses the per-namespace listing for a token scoped to a single scene of it', async () => {
        const ArenaObject = fakeArenaObject();
        const {app} = await startApp({
            jwk: JWK, jose: fakeJose({subs: [sceneTopic('public', 'lobby')]}), ArenaObject,
        });
        const {res} = await request(app, {
            method: 'get',
            path: '/persist/:namespace/\\!allscenes',
            params: {namespace: 'public'},
            cookies: {mqtt_token: 'good-token'},
        });
        assert.equal(res.statusCode, 401);
        assert.equal(ArenaObject.calls.aggregate.length, 0);
    });

    it('serves all three listings unauthenticated when no JWK is configured', async () => {
        const ArenaObject = fakeArenaObject({distinct: ['public'], aggregate: []});
        const {app} = await startApp({jwk: null, ArenaObject});
        for (const path of ['/persist/\\!allnamespaces', '/persist/\\!allscenes']) {
            const {res} = await request(app, {method: 'get', path});
            assert.equal(res.statusCode, 200, path);
        }
    });
});

describe('GET scene objects', () => {
    it('excludes expired objects, hides internal fields and sorts by parent', async () => {
        const rows = [{object_id: 'box-1'}];
        const ArenaObject = fakeArenaObject({find: rows});
        const {app} = await startApp({ArenaObject});
        const before = new Date();
        const {res} = await request(app, {
            method: 'get', path: '/persist/:namespace/:sceneId', params: {namespace: 'public', sceneId: 'lobby'},
        });
        assert.deepEqual(res.body, rows);
        const [query, projection] = ArenaObject.calls.find[0];
        assert.equal(query.namespace, 'public');
        assert.equal(query.sceneId, 'lobby');
        assert.ok(query.expireAt.$not.$lt >= before, 'the expiry cutoff is the time of the request');
        assert.equal(query.type, undefined, 'no type filter unless one was asked for');
        assert.deepEqual(projection, {_id: 0, realm: 0, namespace: 0, sceneId: 0, __v: 0});
    });

    it('filters by type when the query string asks for one', async () => {
        const ArenaObject = fakeArenaObject({find: []});
        const {app} = await startApp({ArenaObject});
        await request(app, {
            method: 'get',
            path: '/persist/:namespace/:sceneId',
            params: {namespace: 'public', sceneId: 'lobby'},
            query: {type: 'scene-options'},
        });
        assert.equal(ArenaObject.calls.find[0][0].type, 'scene-options');
    });

    it('queries one object by id on the single-object route', async () => {
        const ArenaObject = fakeArenaObject({find: [{object_id: 'box-1'}]});
        const {app} = await startApp({ArenaObject});
        const {res} = await request(app, {
            method: 'get',
            path: '/persist/:namespace/:sceneId/:objectId',
            params: {namespace: 'public', sceneId: 'lobby', objectId: 'box-1'},
        });
        assert.deepEqual(res.body, [{object_id: 'box-1'}]);
        const [query] = ArenaObject.calls.find[0];
        assert.equal(query.object_id, 'box-1');
        assert.equal(query.namespace, 'public');
        assert.equal(query.sceneId, 'lobby');
        assert.ok(query.expireAt.$not.$lt instanceof Date);
    });
});

describe('DELETE scene', () => {
    it('deletes the scene and reports how many objects went', async () => {
        const ArenaObject = fakeArenaObject({deletedCount: 7});
        const {app} = await startApp({ArenaObject});
        const {res} = await request(app, {
            method: 'delete', path: '/persist/:namespace/:sceneId', params: {namespace: 'public', sceneId: 'lobby'},
        });
        assert.deepEqual(res.body, {result: 'success', deletedCount: 7});
        assert.deepEqual(ArenaObject.calls.deleteMany, [[{namespace: 'public', sceneId: 'lobby'}]]);
    });

    it('forgets the in-memory keys of that scene only', async () => {
        const persists = new Set([
            'public|lobby|box-1',
            'public|lobby|box-2',
            'public|lobbyextra|box-3',
            'public|other|box-4',
            'private|lobby|box-5',
        ]);
        const {app} = await startApp({persists});
        await request(app, {
            method: 'delete', path: '/persist/:namespace/:sceneId', params: {namespace: 'public', sceneId: 'lobby'},
        });
        assert.deepEqual([...persists].sort(), [
            'private|lobby|box-5',
            'public|lobbyextra|box-3',
            'public|other|box-4',
        ], 'a scene whose name merely shares a prefix keeps its keys');
    });

    it('removes those keys through the injected forgetPersist, not out of the set itself', async () => {
        const persists = new Set(['public|lobby|box-1', 'public|lobby|box-2', 'public|other|box-3']);
        const forgotten = [];
        const {app} = await startApp({persists, forgetPersist: (key) => forgotten.push(key)});
        await request(app, {
            method: 'delete', path: '/persist/:namespace/:sceneId', params: {namespace: 'public', sceneId: 'lobby'},
        });
        assert.deepEqual(forgotten.sort(), ['public|lobby|box-1', 'public|lobby|box-2'],
            'the keys of the deleted scene go to the removal the caller injected');
        assert.deepEqual([...persists].sort(), ['public|lobby|box-1', 'public|lobby|box-2', 'public|other|box-3'],
            'and the route never reaches past it into the set, so a removal the caller has to ' +
            'record cannot be made behind its back');
    });
});

describe('POST scene clone', () => {
    const TARGET = {namespace: 'public', sceneId: 'copy'};
    const SOURCE = {action: 'clone', namespace: 'public', sceneId: 'template'};

    /**
     * Posts a clone request as a token holding read and write rights over both scenes.
     * @param {Object} body - The request body.
     * @param {Object} [options] - Test options.
     * @param {Array<number>} [options.counts] - countDocuments answers: source then target.
     * @param {Array<string>} [options.subs] - Read rights, defaulting to the whole realm.
     * @param {function} [options.loadTemplate] - Clone implementation to inject.
     * @return {Promise<Object>} The response, the fake model and the recorded clone calls.
     */
    const post = async (body, {counts = [1, 0], subs = ['realm/#'], loadTemplate} = {}) => {
        const cloneCalls = [];
        const ArenaObject = fakeArenaObject({counts});
        const {app} = await startApp({
            ArenaObject,
            jwk: JWK,
            jose: fakeJose({subs, publ: ['realm/#']}),
            loadTemplate: loadTemplate ?? (async (...args) => {
                cloneCalls.push(args);
            }),
        });
        const {res} = await request(app, {
            method: 'post',
            path: '/persist/:namespace/:sceneId',
            params: TARGET,
            body,
            cookies: {mqtt_token: 'good-token'},
        });
        return {res, ArenaObject, cloneCalls};
    };

    it('clones the source scene into an empty target', async () => {
        const {res, cloneCalls, ArenaObject} = await post(SOURCE, {counts: [3, 0]});
        assert.deepEqual(res.body, {result: 'success', objectsCloned: 3});
        assert.equal(cloneCalls.length, 1);
        assert.deepEqual(cloneCalls[0], [
            'clone', 'realm', 'public', 'template', 'public', 'copy',
            {noPrefix: true, persist: true, noParent: true},
        ], 'the clone keeps the original object ids, persists them and wraps them in no container');
        assert.deepEqual(ArenaObject.calls.countDocuments, [
            [{namespace: 'public', sceneId: 'template'}],
            [{namespace: 'public', sceneId: 'copy'}],
        ], 'the source is counted first, then the target');
    });

    it('refuses a body with no action', async () => {
        const {res, cloneCalls} = await post({namespace: 'public', sceneId: 'template'});
        assert.equal(res.statusCode, 400);
        assert.equal(res.body, 'No valid action.');
        assert.equal(cloneCalls.length, 0);
    });

    it('refuses an unknown action', async () => {
        const {res, cloneCalls} = await post({action: 'move', namespace: 'public', sceneId: 'template'});
        assert.equal(res.statusCode, 400);
        assert.equal(res.body, 'No valid action.');
        assert.equal(cloneCalls.length, 0);
    });

    for (const missing of ['namespace', 'sceneId']) {
        it(`refuses a clone with no source ${missing}`, async () => {
            const body = {...SOURCE};
            delete body[missing];
            const {res, ArenaObject} = await post(body);
            assert.equal(res.statusCode, 400);
            assert.equal(res.body, 'No namespace or sceneId specified');
            assert.equal(ArenaObject.calls.countDocuments.length, 0, 'nothing is counted');
        });
    }

    it('refuses to clone a source scene the token cannot read', async () => {
        const {res, ArenaObject, cloneCalls} = await post(SOURCE, {subs: [sceneTopic('public', 'copy')]});
        assert.equal(res.statusCode, 401);
        assert.equal(res.body, 'You have not been granted read access');
        assert.equal(ArenaObject.calls.countDocuments.length, 0);
        assert.equal(cloneCalls.length, 0);
    });

    it('answers 404 for an empty source scene', async () => {
        const {res, cloneCalls} = await post(SOURCE, {counts: [0, 0]});
        assert.equal(res.statusCode, 404);
        assert.equal(res.body, 'The source scene is empty!');
        assert.equal(cloneCalls.length, 0);
    });

    it('answers 409 for a target scene that already holds objects', async () => {
        const {res, cloneCalls} = await post(SOURCE, {counts: [3, 5]});
        assert.equal(res.statusCode, 409);
        assert.equal(res.body, 'The target scene is not empty!');
        assert.equal(cloneCalls.length, 0);
    });

    it('clones into a non-empty target when the caller opts in, without counting it', async () => {
        const {res, cloneCalls, ArenaObject} = await post({...SOURCE, allowNonEmptyTarget: true}, {counts: [3]});
        assert.deepEqual(res.body, {result: 'success', objectsCloned: 3});
        assert.equal(cloneCalls.length, 1);
        assert.equal(ArenaObject.calls.countDocuments.length, 1, 'only the source is counted');
    });

    it('answers 500 when the clone itself fails', async () => {
        const {res} = await post(SOURCE, {
            counts: [3, 0],
            loadTemplate: async () => {
                throw new Error('mongo went away');
            },
        });
        assert.equal(res.statusCode, 500);
        assert.equal(res.body, undefined);
    });
});

describe('GET health', () => {
    const cases = [
        {name: 'database and broker both up', readyState: 1, connected: true, status: 200,
            body: {result: 'success'}},
        {name: 'database down', readyState: 0, connected: true, status: 500,
            body: {result: 'failure', database: 'disconnected', mqtt: 'connected'}},
        {name: 'no mongoose connection object at all', readyState: undefined, connected: true, status: 500,
            body: {result: 'failure', database: 'disconnected', mqtt: 'connected'}},
        {name: 'database connecting', readyState: 2, connected: true, status: 500,
            body: {result: 'failure', database: 'disconnected', mqtt: 'connected'}},
    ];
    for (const {name, readyState, connected, status, body} of cases) {
        it(`reports ${name}`, async () => {
            const {app} = await startApp({
                mongooseConnection: readyState === undefined ? undefined : {readyState},
                mqttClient: {connected},
            });
            const {res} = await request(app, {method: 'get', path: '/persist/health'});
            assert.equal(res.statusCode, status);
            assert.deepEqual(res.body, body);
        });
    }
});
