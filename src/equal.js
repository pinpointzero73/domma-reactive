/**
 * Deep structural equality.
 *
 * Used as the change-detection gate for observables and the propagation
 * short-circuit for computeds, so it must be cheap and total — never throw,
 * never recurse forever.
 *
 * Handles primitives (with Object.is semantics, so NaN equals itself), Date,
 * Array and plain objects. Everything else falls back to reference equality,
 * which is the correct conservative answer for functions, class instances,
 * DOM nodes and the like.
 *
 * @param {*} a
 * @param {*} b
 * @param {WeakMap} [seen] Internal — guards against cyclic structures
 * @returns {boolean}
 */
export function isEqual(a, b, seen = new WeakMap()) {
    if (Object.is(a, b)) return true;
    // Object.is treats +0/-0 as different; for change detection they are not
    if (a === 0 && b === 0) return true;

    if (a === null || b === null) return false;
    if (typeof a !== 'object' || typeof b !== 'object') return false;

    if (a instanceof Date || b instanceof Date) {
        return a instanceof Date && b instanceof Date && a.getTime() === b.getTime();
    }

    const aIsArray = Array.isArray(a);
    if (aIsArray !== Array.isArray(b)) return false;

    // Cycle guard: if we are already comparing this pair, assume equal and let
    // the rest of the structure decide.
    const pending = seen.get(a);
    if (pending && pending.has(b)) return true;
    if (pending) pending.add(b);
    else seen.set(a, new Set([b]));

    if (aIsArray) {
        if (a.length !== b.length) return false;
        for (let i = 0; i < a.length; i++) {
            if (!isEqual(a[i], b[i], seen)) return false;
        }
        return true;
    }

    // Only plain objects are compared structurally
    const aProto = Object.getPrototypeOf(a);
    const bProto = Object.getPrototypeOf(b);
    const plain = (p) => p === Object.prototype || p === null;
    if (!plain(aProto) || !plain(bProto)) return false;

    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    if (aKeys.length !== bKeys.length) return false;

    for (const key of aKeys) {
        if (!Object.prototype.hasOwnProperty.call(b, key)) return false;
        if (!isEqual(a[key], b[key], seen)) return false;
    }
    return true;
}
