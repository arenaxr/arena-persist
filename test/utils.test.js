/**
 * @fileoverview Unit tests for the pure helpers exported by utils.js.
 *
 * Open source software under the terms in /LICENSE
 * Copyright (c) 2026 ARENAXR. All rights reserved.
 */

const assert = require('node:assert/strict');
const {describe, it} = require('node:test');

const {asyncForEach, asyncMapForEach, escapeRegExp, filterNulls, flatten} = require('../utils');

/**
 * Resolves after the given delay, used to stagger async callbacks in ordering tests.
 * @param {number} ms - Milliseconds to wait before resolving.
 * @return {Promise<void>} Promise that settles once the timer fires.
 */
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

describe('flatten', () => {
    const cases = [
        {
            name: 'returns a shallow object unchanged',
            input: {a: 1, b: 'two'},
            expected: {a: 1, b: 'two'},
        },
        {
            name: 'joins nested keys with dots',
            input: {a: {b: {c: 2}}},
            expected: {'a.b.c': 2},
        },
        {
            name: 'flattens sibling branches of differing depth',
            input: {a: {b: 1}, c: {d: {e: 2}}, f: 3},
            expected: {'a.b': 1, 'c.d.e': 2, 'f': 3},
        },
        {
            name: 'treats arrays as leaf values rather than recursing into indices',
            input: {a: {b: [1, 2, 3]}},
            expected: {'a.b': [1, 2, 3]},
        },
        {
            name: 'treats an array of objects as a single leaf value',
            input: {a: [{b: 1}]},
            expected: {a: [{b: 1}]},
        },
        {
            name: 'keeps null leaves',
            input: {a: {b: null}},
            expected: {'a.b': null},
        },
        {
            name: 'keeps undefined leaves',
            input: {a: undefined},
            expected: {a: undefined},
        },
        {
            name: 'keeps falsy primitives',
            input: {a: {b: 0, c: false, d: ''}},
            expected: {'a.b': 0, 'a.c': false, 'a.d': ''},
        },
        {
            name: 'returns an empty object for an empty input',
            input: {},
            expected: {},
        },
        {
            name: 'drops keys whose value is an empty object, since there is no leaf to emit',
            input: {a: {}, b: 1},
            expected: {b: 1},
        },
        {
            name: 'drops keys whose only descendants are empty objects',
            input: {a: {b: {}}},
            expected: {},
        },
        {
            name: 'concatenates keys that already contain dots',
            input: {'a.b': {c: 1}},
            expected: {'a.b.c': 1},
        },
        {
            name: 'flattens an ARENA object attribute tree into mongo dotted paths',
            input: {
                attributes: {
                    object_type: 'box',
                    position: {x: 0, y: 1.6, z: -2},
                    material: {color: '#ffffff', opacity: 1},
                },
            },
            expected: {
                'attributes.object_type': 'box',
                'attributes.position.x': 0,
                'attributes.position.y': 1.6,
                'attributes.position.z': -2,
                'attributes.material.color': '#ffffff',
                'attributes.material.opacity': 1,
            },
        },
    ];

    cases.forEach(({name, input, expected}) => {
        it(name, () => {
            assert.deepStrictEqual(flatten(input), expected);
        });
    });

    it('treats a Date as a leaf value and preserves the instance', () => {
        const stamp = new Date('2024-01-02T03:04:05.000Z');
        const flat = flatten({a: {expireAt: stamp}});
        assert.deepStrictEqual(Object.keys(flat), ['a.expireAt']);
        assert.strictEqual(flat['a.expireAt'], stamp);
    });

    it('preserves the identity of array leaves instead of copying them', () => {
        const items = [1, 2];
        assert.strictEqual(flatten({a: {b: items}})['a.b'], items);
    });

    it('does not mutate the input object', () => {
        const input = {a: {b: {c: 1}}, d: [1, 2]};
        const before = JSON.stringify(input);
        flatten(input);
        assert.strictEqual(JSON.stringify(input), before);
    });
});

describe('filterNulls', () => {
    it('returns a [sets, unSets] tuple', () => {
        const result = filterNulls({a: 1, b: null});
        assert.ok(Array.isArray(result));
        assert.strictEqual(result.length, 2);
        const [sets, unSets] = result;
        assert.deepStrictEqual(sets, {a: 1});
        assert.deepStrictEqual(unSets, {b: ''});
    });

    const cases = [
        {
            name: 'maps every null value to an empty string in unSets',
            input: {a: null, b: null},
            sets: {},
            unSets: {a: '', b: ''},
        },
        {
            name: 'keeps undefined in sets, since only null is treated as an unset',
            input: {a: undefined},
            sets: {a: undefined},
            unSets: {},
        },
        {
            name: 'keeps falsy non-null values in sets',
            input: {a: 0, b: false, c: '', d: NaN},
            sets: {a: 0, b: false, c: '', d: NaN},
            unSets: {},
        },
        {
            name: 'keeps object and array values in sets untouched',
            input: {a: {b: 1}, c: [1, 2]},
            sets: {a: {b: 1}, c: [1, 2]},
            unSets: {},
        },
        {
            name: 'returns two empty objects for an empty input',
            input: {},
            sets: {},
            unSets: {},
        },
        {
            name: 'partitions a mixed dotted-path update',
            input: {'attributes.position.x': 0, 'attributes.material': null, 'attributes.visible': true},
            sets: {'attributes.position.x': 0, 'attributes.visible': true},
            unSets: {'attributes.material': ''},
        },
    ];

    cases.forEach(({name, input, sets, unSets}) => {
        it(name, () => {
            assert.deepStrictEqual(filterNulls(input), [sets, unSets]);
        });
    });

    it('ignores inherited enumerable properties', () => {
        const input = Object.create({inherited: 'nope', alsoInherited: null});
        input.own = 1;
        input.ownNull = null;
        assert.deepStrictEqual(filterNulls(input), [{own: 1}, {ownNull: ''}]);
    });

    it('composes with flatten to build a mongo $set/$unset pair', () => {
        const [sets, unSets] = filterNulls(flatten({
            attributes: {
                position: {x: 1, y: 2, z: 3},
                color: null,
            },
        }));
        assert.deepStrictEqual(sets, {
            'attributes.position.x': 1,
            'attributes.position.y': 2,
            'attributes.position.z': 3,
        });
        assert.deepStrictEqual(unSets, {'attributes.color': ''});
    });
});

describe('String.prototype.formatStr', () => {
    const cases = [
        {
            name: 'substitutes named placeholders from a single object argument',
            template: '{realm}/s/{nameSpace}/{sceneName}',
            args: [{realm: 'realm', nameSpace: 'public', sceneName: 'lobby'}],
            expected: 'realm/s/public/lobby',
        },
        {
            name: 'substitutes positional placeholders from multiple arguments',
            template: '{0}/s/{1}/{2}',
            args: ['realm', 'public', 'lobby'],
            expected: 'realm/s/public/lobby',
        },
        {
            name: 'treats a lone non-object argument as positional index 0',
            template: 'hello {0}',
            args: ['world'],
            expected: 'hello world',
        },
        {
            name: 'reuses positional arguments out of order',
            template: '{1}-{0}-{1}',
            args: ['a', 'b'],
            expected: 'b-a-b',
        },
        {
            name: 'replaces every occurrence of a repeated named key',
            template: '{id}/{id}',
            args: [{id: 'x'}],
            expected: 'x/x',
        },
        {
            name: 'leaves unknown keys in place verbatim',
            template: '{known}/{unknown}',
            args: [{known: 'yes'}],
            expected: 'yes/{unknown}',
        },
        {
            name: 'leaves every placeholder in place when given no arguments',
            template: '{a}/{b}',
            args: [],
            expected: '{a}/{b}',
        },
        {
            name: 'leaves a placeholder in place when its value is undefined',
            template: '{a}/{b}',
            args: [{a: 'set', b: undefined}],
            expected: 'set/{b}',
        },
        {
            name: 'substitutes falsy values that are not undefined',
            template: '{zero}/{empty}/{no}/{nil}',
            args: [{zero: 0, empty: '', no: false, nil: null}],
            expected: '0//false/null',
        },
        {
            name: 'ignores empty braces, which the placeholder pattern does not match',
            template: 'a{}b',
            args: [{'': 'x'}],
            expected: 'a{}b',
        },
        {
            name: 'returns strings without placeholders unchanged',
            template: '$NETWORK/latency',
            args: [{nameSpace: 'public'}],
            expected: '$NETWORK/latency',
        },
        {
            name: 'does not recurse into substituted values that look like placeholders',
            template: '{a}',
            args: [{a: '{b}', b: 'nope'}],
            expected: '{b}',
        },
    ];

    cases.forEach(({name, template, args, expected}) => {
        it(name, () => {
            assert.strictEqual(template.formatStr(...args), expected);
        });
    });

    it('returns a primitive string', () => {
        assert.strictEqual(typeof '{a}'.formatStr({a: 1}), 'string');
    });

    it('does not mutate the template it is called on', () => {
        const template = '{a}/{b}';
        template.formatStr({a: 1, b: 2});
        assert.strictEqual(template, '{a}/{b}');
    });
});

describe('asyncForEach', () => {
    it('awaits each callback before starting the next, despite staggered durations', async () => {
        const events = [];
        // Descending then ascending delays: a parallel implementation would interleave these.
        const items = [{id: 'a', ms: 30}, {id: 'b', ms: 1}, {id: 'c', ms: 15}];

        await asyncForEach(items, async (item) => {
            events.push(`start:${item.id}`);
            await delay(item.ms);
            events.push(`end:${item.id}`);
        });

        assert.deepStrictEqual(events, [
            'start:a', 'end:a',
            'start:b', 'end:b',
            'start:c', 'end:c',
        ]);
    });

    it('passes (element, index, array) to the callback', async () => {
        const input = ['x', 'y'];
        const seen = [];
        await asyncForEach(input, async (element, index, array) => {
            seen.push({element, index, sameArray: array === input});
        });
        assert.deepStrictEqual(seen, [
            {element: 'x', index: 0, sameArray: true},
            {element: 'y', index: 1, sameArray: true},
        ]);
    });

    it('never calls the callback for an empty array', async () => {
        let calls = 0;
        await asyncForEach([], async () => {
            calls += 1;
        });
        assert.strictEqual(calls, 0);
    });

    it('iterates array-like objects using length and index access', async () => {
        const seen = [];
        await asyncForEach({length: 2, 0: 'a', 1: 'b'}, async (element) => {
            seen.push(element);
        });
        assert.deepStrictEqual(seen, ['a', 'b']);
    });

    it('accepts synchronous callbacks', async () => {
        const seen = [];
        await asyncForEach([1, 2], (element) => {
            seen.push(element);
        });
        assert.deepStrictEqual(seen, [1, 2]);
    });

    it('resolves to undefined', async () => {
        assert.strictEqual(await asyncForEach([1], async () => 'ignored'), undefined);
    });

    it('rejects and stops iterating when a callback throws', async () => {
        const seen = [];
        await assert.rejects(
            asyncForEach([1, 2, 3], async (element) => {
                seen.push(element);
                if (element === 2) {
                    throw new Error('boom');
                }
            }),
            /boom/,
        );
        assert.deepStrictEqual(seen, [1, 2]);
    });
});

describe('asyncMapForEach', () => {
    it('awaits each callback before starting the next, despite staggered durations', async () => {
        const events = [];
        const expirations = new Map([
            ['key-a', 30],
            ['key-b', 1],
            ['key-c', 15],
        ]);

        await asyncMapForEach(expirations, async (value, key) => {
            events.push(`start:${key}`);
            await delay(value);
            events.push(`end:${key}`);
        });

        assert.deepStrictEqual(events, [
            'start:key-a', 'end:key-a',
            'start:key-b', 'end:key-b',
            'start:key-c', 'end:key-c',
        ]);
    });

    it('passes (value, key) to the callback in Map insertion order', async () => {
        const seen = [];
        const map = new Map([['second', 2], ['first', 1]]);
        await asyncMapForEach(map, async (value, key) => {
            seen.push([key, value]);
        });
        assert.deepStrictEqual(seen, [['second', 2], ['first', 1]]);
    });

    it('passes (value, index) when handed an array, whose entries() yields index keys', async () => {
        const seen = [];
        await asyncMapForEach(['a', 'b'], async (value, key) => {
            seen.push([key, value]);
        });
        assert.deepStrictEqual(seen, [[0, 'a'], [1, 'b']]);
    });

    it('never calls the callback for an empty Map', async () => {
        let calls = 0;
        await asyncMapForEach(new Map(), async () => {
            calls += 1;
        });
        assert.strictEqual(calls, 0);
    });

    it('rejects and stops iterating when a callback throws', async () => {
        const seen = [];
        const map = new Map([['a', 1], ['b', 2], ['c', 3]]);
        await assert.rejects(
            asyncMapForEach(map, async (value, key) => {
                seen.push(key);
                if (key === 'b') {
                    throw new Error('boom');
                }
            }),
            /boom/,
        );
        assert.deepStrictEqual(seen, ['a', 'b']);
    });

    it('tolerates deleting the current key during iteration, as the expiry sweep does', async () => {
        const map = new Map([['a', 1], ['b', 2]]);
        const seen = [];
        await asyncMapForEach(map, async (value, key) => {
            seen.push(key);
            map.delete(key);
        });
        assert.deepStrictEqual(seen, ['a', 'b']);
        assert.strictEqual(map.size, 0);
    });
});

describe('escapeRegExp', () => {
    const cases = [
        {name: 'leaves plain text alone', input: 'shelf', expected: 'shelf'},
        {
            name: 'escapes the pipe in a template container id, which would otherwise be alternation',
            input: 'public|store::shelf::',
            expected: 'public\\|store::shelf::',
        },
        {
            name: 'escapes every metacharacter',
            input: '.*+?^${}()|[]\\',
            expected: '\\.\\*\\+\\?\\^\\$\\{\\}\\(\\)\\|\\[\\]\\\\',
        },
    ];

    cases.forEach(({name, input, expected}) => {
        it(name, () => {
            assert.strictEqual(escapeRegExp(input), expected);
        });
    });

    it('matches only the literal prefix it was built from', () => {
        const anchored = RegExp('^' + escapeRegExp('public|store::shelf::'));
        assert.ok(anchored.test('public|store::shelf::box'));
        // Unescaped, '^public|store::shelf::' would match anything starting with 'public'.
        assert.ok(!anchored.test('public|lobby|other'));
        assert.ok(!anchored.test('publicX'));
    });
});
