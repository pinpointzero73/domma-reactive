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

const PREFIX = '[Domma Reactive]';

// ── Subscriptions ─────────────────────────────────────────────────────────────

/**
 * The `.subscribe(fn)` half of an observable.
 *
 * ── Why this is not an effect ────────────────────────────────────────────────
 *
 * `effect(() => count.value)` already exists and already re-runs on change, so a
 * subscription could have been sugar over one. It is not, for two reasons.
 *
 *   1. A subscription is about ONE observable. An effect is about whatever its
 *      body happened to read, which is a different — and, for a caller porting
 *      from Knockout, a surprising — contract.
 *   2. An effect is a `Computation` in the graph. A page that subscribes to a
 *      hundred observables would add a hundred nodes to the dependency graph
 *      that no computed ever reads, and would show up in exactly the live-
 *      computation count the reconciler's leak tests rely on.
 *
 * So a subscription is a plain callback list hanging off the observable.
 *
 * ── Timing: synchronous, at the write ────────────────────────────────────────
 *
 * Subscribers fire during the assignment, NOT on the next flush. Knockout does
 * the same, and the reason survives the comparison: the caller subscribed to a
 * value, not to a derived graph settling. `count.value = 5` followed by an
 * assertion about the callback needs no `flushSync()`, which is the behaviour
 * anyone writing `count.subscribe(...)` expects.
 *
 * The graph is unaffected — `dep.trigger()` still batches computeds and effects
 * onto the microtask flush. The two mechanisms are deliberately different, and
 * the difference is the point: subscriptions are notifications about a write,
 * effects are recomputations of a graph.
 *
 * ── The change gate applies ──────────────────────────────────────────────────
 *
 * A subscription fires exactly when `dep.trigger()` fires. Assigning a deeply
 * equal value notifies neither. An in-place array mutator notifies both,
 * unconditionally, for the reason set out on `observableArray` below.
 */
function subscribers() {
    const list = new Set();

    return {
        /**
         * @param {Function} fn called with the new value
         * @returns {Function} unsubscribe; also available as `.dispose()`
         */
        add(fn) {
            if (typeof fn !== 'function') {
                throw new TypeError(`${PREFIX} subscribe: expected a function`);
            }
            list.add(fn);

            const off = () => {
                list.delete(fn);
            };
            // `.dispose()` is what a Knockout subscription is torn down with.
            // Offering both costs one property and removes a porting papercut.
            off.dispose = off;
            return off;
        },

        /**
         * Iterated over a copy, so a subscriber that unsubscribes itself — or
         * subscribes something else — cannot corrupt the walk. A subscriber
         * that throws is reported and skipped: one bad callback must not turn a
         * write into an exception at an unrelated call site.
         */
        notify(value) {
            if (list.size === 0) return;
            for (const fn of [...list]) {
                try {
                    fn(value);
                } catch (err) {
                    console.warn(`${PREFIX} a subscriber threw:`, err);
                }
            }
        },

        size: () => list.size
    };
}

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
 * @returns {{value: *, peek: Function, set: Function, subscribe: Function}}
 */
export function observable(initial, options = {}) {
    const equals = options.equals || isEqual;
    const dep = new Dep();
    const subs = subscribers();
    let current = initial;

    /**
     * Assign, then announce only if the comparator saw a change.
     * @param {*} next
     */
    const write = (next) => {
        const changed = !equals(current, next);
        current = next;
        if (!changed) return;
        dep.trigger();
        subs.notify(current);
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
        set: (next) => write(next),

        /**
         * Call `fn(value)` on every change. See the note above `subscribers()`.
         * @param {Function} fn
         * @returns {Function} unsubscribe, also callable as `.dispose()`
         */
        subscribe: (fn) => subs.add(fn)
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
 * than a wholesale replacement — which the keyed reconciler turns into a single
 * DOM insertion, leaving every existing row's nodes and effects untouched.
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
    const subs = subscribers();
    let current = Array.isArray(initial) ? initial.slice() : [];

    /** Announce an in-place mutation to both the graph and the subscribers. */
    const announce = () => {
        dep.trigger();
        subs.notify(current);
    };

    /** Wholesale replacement: always stores, announces only a real change. */
    const write = (next) => {
        const arr = Array.isArray(next) ? next.slice() : [];
        const changed = !equals(current, arr);
        current = arr;
        if (changed) announce();
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
         * Remove items in place — every occurrence of a value, or everything a
         * test function accepts.
         *
         * ── Why a function is a test and not a value ─────────────────────────
         *
         * `remove(item)` matching by identity is what a reconciled list wants:
         * `$parent.remove($data)` hands over the very object the row was
         * rendered from. But `remove(t => t.id === 2)` is the spelling most
         * people reach for first, and treating it as a value made it fail in
         * the worst available way — the function was compared against each item
         * by identity, never matched, and removed nothing without a word.
         *
         * The case this gives up is an array of bare functions removing one of
         * its own members by passing it. That is rare, `peek()` plus `splice()`
         * still covers it, and it is a far better thing to lose than a silent
         * no-op on the common spelling. Knockout resolves the same ambiguity
         * the same way.
         *
         * Walked back to front, because removing while walking forward skips
         * the element after each hit. The index handed to the test is therefore
         * still the item's real index: splicing at `i` cannot disturb anything
         * before it.
         *
         * Notifies even when nothing matched. `remove`/`removeAll` follow the
         * mutator rule, not the assignment rule — gating them on "did anything
         * actually go?" would add a third write rule to save a single
         * microtask, and "removed nothing" is a coherent patch for the M4
         * reconciler to be handed. Worth stating here because these two are
         * Domma's own inventions, where a caller may reasonably expect
         * removing an absent item to be a no-op; `sort()` carries no such
         * expectation.
         *
         * @param {*|function(*, number): boolean} match a value, or a test
         * @returns {Object} this observableArray, so calls chain
         */
        remove: (match) => {
            const test = typeof match === 'function'
                ? match
                : (item) => item === match;

            for (let i = current.length - 1; i >= 0; i--) {
                if (test(current[i], i)) current.splice(i, 1);
            }
            announce();
            return api;
        },

        /** Empty the array, in place. */
        removeAll: () => {
            current.length = 0;
            announce();
            return api;
        },

        /**
         * Call `fn(array)` on every change — every mutator, and every wholesale
         * assignment that the comparator judged a real change. See the note
         * above `subscribers()`.
         *
         * The value handed to a subscriber is the LIVE array, the same one
         * `peek()` returns, not a copy. Copying per notification would cost
         * O(n) on every push for the benefit of subscribers who mostly want to
         * read a length or re-render; a subscriber that intends to keep the
         * value should copy it itself.
         *
         * @param {Function} fn
         * @returns {Function} unsubscribe, also callable as `.dispose()`
         */
        subscribe: (fn) => subs.add(fn)
    };

    // In-place mutators: run the native method against the live array, hand
    // back exactly what it returned, and announce the change directly.
    for (const name of MUTATORS) {
        api[name] = (...args) => {
            const result = Array.prototype[name].apply(current, args);
            announce();
            return result;
        };
    }

    return api;
}
