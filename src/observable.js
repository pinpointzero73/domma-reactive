/**
 * Observables — the state primitive.
 *
 * The dependency graph in graph.js tracks *reads*, but something has to own
 * the value being read. In Domma that role is played by Model; standalone,
 * this is it.
 *
 * Property-style by design (`count.value`), matching the idiom Domma
 * established with model.tracked(). See the design spec §5.
 *
 * This module owns the state primitives that sit on top of a Dep. It knows
 * nothing about the scheduler beyond calling `trigger()`, and nothing about
 * the DOM at all.
 */

import {Dep} from './graph.js';
import {isEqual} from './equal.js';

// ── Scalar ────────────────────────────────────────────────────────────────────

/**
 * Create an observable value.
 *
 * The `equals` comparator gates *notification*, not the write. A write always
 * lands; the graph only hears about it when the comparator reports a change.
 * That is precisely Domma's Model._setField, which assigns unconditionally and
 * then notifies `if (!utils.isEqual(oldValue, value))` — so a comparator that
 * deliberately ignores part of the payload (compare by id, say) can never leave
 * readers serving stale data.
 *
 * Note the corollary of gating at all: mutating the held value in place and
 * assigning it back is invisible, because the old and new values are the same
 * reference. Derivations must produce new values rather than editing old ones.
 *
 * @param {*} initial
 * @param {Object}   [options]
 * @param {Function} [options.equals] Change gate. Defaults to deep equality.
 *                                    Domma passes utils.isEqual to preserve
 *                                    its existing notification semantics.
 * @returns {{value: *, peek: Function, set: Function}}
 */
export function observable(initial, options = {}) {
    const equals = options.equals || isEqual;
    const dep = new Dep();
    let current = initial;

    /**
     * Assign, then announce only if the comparator saw a change.
     * @param {*} next
     */
    const write = (next) => {
        const changed = !equals(current, next);
        current = next;
        if (changed) dep.trigger();
    };

    // `peek` and `set` are closures rather than methods: they carry no `this`,
    // so they survive being destructured off the observable or handed straight
    // to a callback — both routine for a published API.
    return {
        get value() {
            dep.track();
            return current;
        },

        set value(next) {
            write(next);
        },

        /** Read without registering a dependency. */
        peek: () => current,

        /** Imperative alias for assigning `.value`. */
        set: (next) => write(next)
    };
}

// ── Array ─────────────────────────────────────────────────────────────────────

/** Array methods that mutate in place and must therefore notify. */
const MUTATORS = ['push', 'pop', 'shift', 'unshift', 'splice', 'sort', 'reverse', 'fill', 'copyWithin'];

/**
 * Create an observable array.
 *
 * `.value` is the underlying array and is tracked on read. The in-place
 * mutators notify after running, so a `push` is a single notification rather
 * than a wholesale replacement — which the keyed reconciler in M4 turns into
 * a single DOM insert.
 *
 * Two write paths, two rules, deliberately:
 *
 *   - **Mutators notify unconditionally.** They cannot go through an equality
 *     gate, because an in-place mutation leaves the array the same reference
 *     as itself: `isEqual(current, current)` is true no matter what `push` did.
 *     Comparing would mean holding a copy and diffing it, which costs O(n) per
 *     mutation and throws away the one thing worth knowing — that this was a
 *     push, of that item, at that index. `dep.trigger()` below is where M4
 *     attaches that patch information.
 *
 *   - **Wholesale assignment is gated**, exactly as `observable()` is, so
 *     replacing the array with a deeply equal one stays quiet.
 *
 * The accepted cost of the first rule is a spurious notification from a
 * mutator that changed nothing — a no-op `sort()`, `splice(0, 0)`. That errs
 * towards notifying too often, never too rarely, which is the safe direction.
 *
 * The initial array is adopted by reference, not copied — matching
 * `observable()`, and necessary for the mutators to be in-place at all.
 *
 * @param {Array}  [initial=[]] Non-arrays are coerced to an empty array.
 * @param {Object} [options]    Same options as observable(); `equals` gates
 *                              wholesale assignment only.
 * @returns {Object}
 */
export function observableArray(initial = [], options = {}) {
    const equals = options.equals || isEqual;
    const dep = new Dep();
    let current = Array.isArray(initial) ? initial : [];

    /** Wholesale replacement: always stores, announces only a real change. */
    const write = (next) => {
        const arr = Array.isArray(next) ? next : [];
        const changed = !equals(current, arr);
        current = arr;
        if (changed) dep.trigger();
    };

    const api = {
        get value() {
            dep.track();
            return current;
        },

        set value(next) {
            write(next);
        },

        /**
         * Tracked, because the obvious use of a length is rendering a count,
         * and a count that never updated would be a trap. It subscribes to the
         * whole array rather than to the length alone — coarser than ideal,
         * but wrong only in the direction of re-running too often.
         */
        get length() {
            dep.track();
            return current.length;
        },

        /** Read without registering a dependency. */
        peek: () => current,

        /** Imperative alias for assigning `.value`. */
        set: (next) => write(next),

        /** Remove every occurrence of a value, in place. */
        remove: (item) => {
            for (let i = current.length - 1; i >= 0; i--) {
                if (current[i] === item) current.splice(i, 1);
            }
            dep.trigger();
            return api;
        },

        /** Empty the array, in place. */
        removeAll: () => {
            current.length = 0;
            dep.trigger();
            return api;
        }
    };

    // In-place mutators: run the native method against the live array, hand
    // back exactly what it returned, and announce the change directly.
    for (const name of MUTATORS) {
        api[name] = (...args) => {
            const result = Array.prototype[name].apply(current, args);
            dep.trigger();
            return result;
        };
    }

    return api;
}
