/**
 * Performs forEach async callback on an array in serial manner.
 * @param {Array} array - Array or array-like object over which to iterate.
 * @param {function} callback - The function to call, wait await, for every element.
 */
exports.asyncForEach = async (array, callback) => {
    for (let index = 0; index < array.length; index++) {
        await callback(array[index], index, array);
    }
};

/**
 * Performs map callback on an array in async manner.
 * @param {Array} m - Array or array-like object over which to iterate.
 * @param {function} callback - The function to call, wait await, for every element.
 */
exports.asyncMapForEach = async (m, callback) => {
    for (const e of m.entries()) {
        await callback(e[1], e[0]);
    }
};

const isPlainObj = (o) => Boolean(
    o && o.constructor && o.constructor.prototype &&
    o.constructor.prototype.hasOwnProperty('isPrototypeOf'),
);

const flatten = (obj, keys = []) => {
    return Object.keys(obj).reduce((acc, key) => {
        return Object.assign(acc,
            isPlainObj(obj[key]) ? flatten(obj[key], keys.concat(key)) : {
                [keys.concat(key).join('.')]: obj[key],
            });
    }, {});
};

exports.flatten = flatten;

exports.filterNulls = (obj) => {
    const sets = {};
    const unSets = {};
    for (const key in obj) {
        if (obj.hasOwnProperty(key)) {
            if (obj[key] === null) {
                unSets[key] = '';
            } else {
                sets[key] = obj[key];
            }
        }
    }
    return [sets, unSets];
};

/**
 * Escapes every regular expression metacharacter in a literal string, so it can be
 * embedded in a RegExp and only ever match itself. ARENA object ids routinely
 * contain '|' and '.', which would otherwise read as alternation and wildcards.
 * @param {string} literal - Text to match literally.
 * @return {string} The same text, safe to embed in a regular expression.
 */
exports.escapeRegExp = (literal) => literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The filter fragment that selects the objects of a scene whose deadline has not passed.
 *
 * Spread into a query rather than written out at each site, so the three read paths that need it
 * cannot drift apart: the MQTT getPersist handler and the two REST scene reads.
 *
 * Not `{expireAt: {$not: {$lt: now}}}`, which is what those reads used to send. A negated range
 * gives the query planner nothing it can turn into index bounds, so `expireAt` could only ever be
 * applied as a filter over already-fetched documents.
 *
 * This keeps every document shape this service writes: `expireAt` absent, `expireAt` null, and a
 * deadline at or after the cutoff, that last one including a deadline falling exactly on it.
 *
 * `{expireAt: null}` is deliberate, and is not the same as `{expireAt: {$exists: false}}`: an
 * equality against null matches both a null value and a missing field, where `$exists: false`
 * would silently stop serving a document whose `expireAt` is explicitly null — a shape this
 * service never writes, since an object created without a ttl leaves the field off the document
 * altogether, but one another writer can leave behind, and one that mongod's TTL monitor will
 * never reap either.
 *
 * It does differ from the old form for an `expireAt` that is not a Date. `$lt` compares only
 * within one BSON type bracket, so `{$not: {$lt: now}}` was true of a string or a number in that
 * field, and neither branch here matches those. Measured on MongoDB 8.0.29: the old form returned
 * documents holding `'not-a-date'`, `0` and `false`, this fragment returns none of them, and there
 * is no document this fragment returns that the old form did not. Only a writer bypassing this
 * schema can leave such a value behind: casting a non-date string here yields `undefined`, so the
 * field is left off the document, and a raw `0` casts to the epoch, a Date in the past that
 * neither form serves.
 * @param {Date} now - Cutoff; a deadline at or after it has not passed.
 * @return {Object} A filter fragment to spread into a query.
 */
exports.liveObjectsOnly = (now) => ({
    $or: [{expireAt: null}, {expireAt: {$gte: now}}],
});

// eslint-disable-next-line no-extend-native
String.prototype.formatStr = function formatStr(...args) {
    const params = arguments.length === 1 && typeof args[0] === 'object' ? args[0] : args;
    return this.replace(/\{([^}]+)\}/g, (match, key) => (typeof params[key] !== 'undefined' ? params[key] : match));
};
