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
