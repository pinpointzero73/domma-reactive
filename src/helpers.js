/**
 * Built-in array helpers - the calls every expression may make without anyone
 * registering them.
 *
 * Expressions cannot call methods, so `tags.includes('urgent')` and
 * `rows.filter(...)` are refused, and until these existed every screen that
 * wanted "is the list empty?" or "how many are done?" had to write a computed
 * for it. These cover the questions a template asks of a list; anything
 * cleverer still belongs in a computed.
 *
 * ── The rules they all follow ────────────────────────────────────────────────
 *
 *   - Pure. No helper mutates its input, and the two that return an array
 *     (`where`, `sortBy`, `pluck`) return a fresh one.
 *   - Forgiving. A list that is null, undefined or not a list is treated as
 *     empty, so `len(user.tags)` before the user has loaded is 0, not a warning.
 *   - Reactive-aware. A list may be an observable or observableArray itself -
 *     `len(todos)` as well as `len(todos.value)` - and so may a field on an item:
 *     `count(todos, 'done')` reads `done.value` when `done` is an observable.
 *     Those reads happen inside the binding's effect, so they are TRACKED:
 *     ticking one row's checkbox re-runs the count. Unwrapping here is safe in a
 *     way it is not for an operator (see `operand` in expression.js) - a helper
 *     knows it wants a value, so there is no wrong answer to fail closed on.
 *   - Guarded. A `key` is a property name or a dotted path (`'meta.done'`), read
 *     through the evaluator's own `readMember`, so `__proto__` and friends are
 *     refused here exactly as they are everywhere else.
 *
 * ── Why a factory ────────────────────────────────────────────────────────────
 *
 * The helpers need `readMember`, which lives in expression.js, and expression.js
 * needs the helpers. Handing the reader in keeps the dependency one-way and the
 * blocklist in one place.
 *
 * ── Precedence ───────────────────────────────────────────────────────────────
 *
 * A helper registered under the same name wins, and unregistering it brings the
 * built-in back. Built-ins cannot be removed - there is nothing to gain from a
 * template that works on one page and not another.
 */

import {isReactive} from './brand.js';

/**
 * Build the built-in helper table.
 *
 * @param {function(*, *): *} readMember the evaluator's guarded property read
 * @returns {Map<string, Function>}
 */
export function createBuiltinHelpers(readMember) {
    /** An observable's value, tracked; anything else as it is. */
    const unwrap = (value) => (isReactive(value) ? value.value : value);

    /** The list behind an argument, as an array - possibly the live one, so never mutated. */
    function list(value) {
        const v = unwrap(value);
        if (Array.isArray(v)) return v;
        if (v instanceof Set) return [...v];
        return [];
    }

    /** `item[key]`, or a dotted path, unwrapping observables at every step. */
    function field(item, key) {
        if (key === undefined || key === null) return unwrap(item);
        let out = unwrap(item);
        for (const part of String(key).split('.')) {
            out = unwrap(readMember(out, part));
            if (out === undefined || out === null) return out;
        }
        return out;
    }

    /**
     * The test shared by some/every/count/where: with a value, the field must
     * equal it (===); without one, the field must be truthy.
     */
    function matcher(args) {
        const [key, value] = args;
        return args.length >= 2
            ? (item) => field(item, key) === value
            : (item) => Boolean(field(item, key));
    }

    return new Map(Object.entries({
        /** Length of a list or string; size of a Set or Map; 0 otherwise. */
        len(value) {
            const v = unwrap(value);
            if (typeof v === 'string' || Array.isArray(v)) return v.length;
            if (v instanceof Set || v instanceof Map) return v.size;
            return 0;
        },

        /** Whether a list contains a value (===), or a string a substring. */
        includes(value, needle) {
            const v = unwrap(value);
            if (typeof v === 'string') return v.includes(String(needle));
            return list(v).includes(needle);
        },

        /** Any item whose `key` is truthy - or equals `value`, when given. */
        some(value, ...args) {
            return list(value).some(matcher(args));
        },

        /** Every item's `key` truthy / equal to `value`. True for an empty list. */
        every(value, ...args) {
            return list(value).every(matcher(args));
        },

        /** How many items match; with no key, how many items there are. */
        count(value, ...args) {
            const items = list(value);
            if (args.length === 0) return items.length;
            const test = matcher(args);
            let n = 0;
            for (const item of items) if (test(item)) n++;
            return n;
        },

        /** The items that match, as a new array - `data-each="where(todos, 'done', false) key=id"`. */
        where(value, ...args) {
            return list(value).filter(matcher(args));
        },

        /** Total of the items, or of each item's `key`. Non-numbers count as 0. */
        sum(value, key) {
            let total = 0;
            for (const item of list(value)) {
                const n = Number(field(item, key));
                if (Number.isFinite(n)) total += n;
            }
            return total;
        },

        /** Each item's `key`, as a new array. */
        pluck(value, key) {
            return list(value).map((item) => field(item, key));
        },

        /**
         * A sorted copy, by `key` (or by the items themselves). Strings compare
         * with localeCompare, so 'b' < 'C'; missing values sort last either way.
         */
        sortBy(value, key, direction = 'asc') {
            const sign = direction === 'desc' ? -1 : 1;
            return list(value)
                .map((item) => ({item, by: field(item, key)}))
                .sort((a, b) => {
                    const aMissing = a.by === undefined || a.by === null;
                    const bMissing = b.by === undefined || b.by === null;
                    if (aMissing || bMissing) return aMissing - bMissing;
                    if (typeof a.by === 'string' && typeof b.by === 'string') {
                        return sign * a.by.localeCompare(b.by);
                    }
                    return a.by < b.by ? -sign : a.by > b.by ? sign : 0;
                })
                .map((entry) => entry.item);
        },

        /** The first item, or undefined. */
        first(value) {
            return list(value)[0];
        },

        /** The last item, or undefined. */
        last(value) {
            const items = list(value);
            return items[items.length - 1];
        },

        /** Items joined into a string, `', '` between them by default. */
        join(value, separator = ', ') {
            return list(value)
                .map((item) => {
                    const v = unwrap(item);
                    return v === undefined || v === null ? '' : String(v);
                })
                .join(String(separator));
        }
    }));
}
