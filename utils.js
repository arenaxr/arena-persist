/**
 * Performs forEach callback on an array in async manner.
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
