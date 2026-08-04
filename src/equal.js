/**
 * Deep structural equality.
 *
 * Used as the change-detection gate for observables and the propagation
 * short-circuit for computeds, so it must be cheap and it must terminate.
 * Termination is guaranteed: the cycle guard below stops self-referential
 * data recursing forever. Exception-freedom is not — a throwing property
 * getter propagates to the caller, and absurdly deep acyclic nesting can
 * still exhaust the stack.
 *
 * Values are compared with Object.is, save that +0 and -0 are treated as the
 * same value: a sign flip on zero is not a change worth propagating. NaN
 * therefore equals itself, so a NaN field settles instead of re-firing on
 * every write.
 *
 * Structural comparison covers Date, Array and plain objects. Everything else
 * — functions, class instances, Map, Set, DOM nodes — falls back to reference
 * equality, which is the correct conservative answer: it may report a change
 * that did not happen, never the reverse.
 *
 * @param {*} a
 * @param {*} b
 * @returns {boolean}
 */
export function isEqual(a, b) {
    return deepEqual(a, b, null);
}

/**
 * A plain object is one carrying no behaviour of its own — an object literal,
 * or an Object.create(null) bag. Anything else is somebody's instance, and not
 * ours to compare field by field.
 *
 * @param {Object|null} proto
 * @returns {boolean}
 */
function isPlainProto(proto) {
    return proto === Object.prototype || proto === null;
}

/**
 * @param {*} a
 * @param {*} b
 * @param {WeakMap|null} seen Pairs already under comparison. Created lazily on
 *        the first object pair, so the primitive path allocates nothing.
 * @returns {boolean}
 */
function deepEqual(a, b, seen) {
    if (Object.is(a, b)) return true;
    // Object.is separates +0 from -0; for change detection they are one value
    if (a === 0 && b === 0) return true;

    if (a === null || b === null) return false;
    if (typeof a !== 'object' || typeof b !== 'object') return false;

    if (a instanceof Date || b instanceof Date) {
        // Object.is, not ===, so two invalid Dates agree with the NaN rule above
        return a instanceof Date && b instanceof Date && Object.is(a.getTime(), b.getTime());
    }

    const aIsArray = Array.isArray(a);
    if (aIsArray !== Array.isArray(b)) return false;

    // Only plain objects are compared structurally. Anything else has already
    // had its chance at the reference check on the first line.
    if (!aIsArray && (!isPlainProto(Object.getPrototypeOf(a)) || !isPlainProto(Object.getPrototypeOf(b)))) {
        return false;
    }

    // Cycle guard: if this pair is already under comparison further up the
    // stack, assume equal and let the rest of the structure decide.
    const scope = seen || new WeakMap();
    const pending = scope.get(a);
    if (pending) {
        if (pending.has(b)) return true;
        pending.add(b);
    } else {
        scope.set(a, new Set([b]));
    }

    if (aIsArray) {
        if (a.length !== b.length) return false;
        for (let i = 0; i < a.length; i++) {
            if (!deepEqual(a[i], b[i], scope)) return false;
        }
        return true;
    }

    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    if (aKeys.length !== bKeys.length) return false;

    for (const key of aKeys) {
        if (!Object.prototype.hasOwnProperty.call(b, key)) return false;
        if (!deepEqual(a[key], b[key], scope)) return false;
    }
    return true;
}
