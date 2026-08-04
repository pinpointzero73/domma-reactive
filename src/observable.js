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
 * The initial array, and any array assigned wholesale, is **copied** rather
 * than adopted. Holding the caller's reference would alias it: a push through
 * the original would change what `.value` returns without ever reaching the
 * graph, so the data and the DOM would disagree silently and permanently, with
 * no `notify()` to recover by. The copy costs O(n) once per assignment and
 * does not touch the property that matters — the mutators work in place on the
 * array held here, and nothing about them cares what it was copied from.
 *
 * That `observable()` adopts by reference and this does not is the point, not
 * an inconsistency: `observable()` is safe by reference precisely because it
 * offers no in-place path, and offering one is exactly what turns adoption
 * into aliasing. A caller who genuinely wants the live array takes it from
 * `peek()` — that is the deliberate escape hatch.
 *
 * @param {Array}  [initial=[]] Non-arrays are coerced to an empty array.
 * @param {Object} [options]    Same options as observable(); `equals` gates
 *                              wholesale assignment only.
 * @returns {{value: Array, length: number, peek: Function, set: Function,
 *            remove: Function, removeAll: Function, push: Function,
 *            pop: Function, shift: Function, unshift: Function,
 *            splice: Function, sort: Function, reverse: Function,
 *            fill: Function, copyWithin: Function}}
 */
export function observableArray(initial = [], options = {}) {
    const equals = options.equals || isEqual;
    const dep = new Dep();
    let current = Array.isArray(initial) ? initial.slice() : [];

    /** Wholesale replacement: always stores, announces only a real change. */
    const write = (next) => {
        const arr = Array.isArray(next) ? next.slice() : [];
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
         * and a count that never updated would be a trap.
         *
         * It subscribes to the whole array rather than to the length alone,
         * which is coarse but cheap enough not to be worth a second Dep:
         * drainPending's equality short-circuit absorbs the coarseness for
         * anything read through a computed, since a length recomputing to the
         * same number propagates no further. Only an effect reading `.length`
         * directly pays, and it pays one redundant text update.
         */
        get length() {
            dep.track();
            return current.length;
        },

        /** Read without registering a dependency. */
        peek: () => current,

        /** Imperative alias for assigning `.value`. */
        set: (next) => write(next),

        /**
         * Remove every occurrence of a value, in place.
         *
         * Notifies even when nothing matched. `remove`/`removeAll` follow the
         * mutator rule, not the assignment rule — gating them on "did anything
         * actually go?" would add a third write rule to save a single
         * microtask, and "removed nothing" is a coherent patch for the M4
         * reconciler to be handed. Worth stating here because these two are
         * Domma's own inventions, where a caller may reasonably expect
         * removing an absent item to be a no-op; `sort()` carries no such
         * expectation.
         */
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
