/**
 * Extenders - layering behaviour onto an observable after it exists.
 *
 * `observable(initial, {equals})` says how an observable compares values. An
 * extender says how it *announces* them: hold the notification back for 300ms,
 * announce even when nothing changed, log every write. Knockout spells this
 * `.extend({rateLimit: 300})`, and so does this, because the concept and the
 * spelling both port cleanly.
 *
 * ── What an extender may touch ───────────────────────────────────────────────
 *
 * Exactly two things, both on the notification path:
 *
 *   control.setEquals(fn)   replace the change gate
 *   control.intercept(wrap) wrap the announcement - wrap(next) => (value) => {}
 *
 * It may not touch the stored value. That is the invariant the whole design
 * rests on: **a write always lands, immediately, whatever is extended onto it**.
 * `count.value = 5` is followed by `count.value === 5` even under a rate limit,
 * because the limiter defers the *announcement*, not the assignment. Knockout's
 * original `throttle` deferred the write itself, which is exactly why reading a
 * throttled observable used to return a value that was already stale, and why
 * Knockout deprecated it in favour of `rateLimit`. That mistake is not repeated
 * here - `throttle` is accepted as a name and given rateLimit's behaviour.
 *
 * ── Interception stacks; rate limiting does not ──────────────────────────────
 *
 * `intercept()` wraps whatever chain is already in place, so two extenders that
 * both intercept compose, outermost last. `rateLimit` deliberately does not:
 * extending twice *reconfigures* the one limiter rather than nesting a second
 * inside the first, since two nested limiters would multiply their delays and
 * `.extend({rateLimit: 0})` would have no way to undo anything. The limiter's
 * state is held in a WeakMap against the observable, so it dies with it.
 *
 * ── Timers are timers ────────────────────────────────────────────────────────
 *
 * A rate limiter uses `setTimeout`, not the graph's microtask flush, because a
 * delay measured in milliseconds is not a delay measured in propagation passes.
 * The consequence is that `flushSync()` does NOT deliver a held notification -
 * it drains the dependency graph, and a held notification has not reached the
 * graph yet. A test advances its own clock.
 */

const PREFIX = '[Domma Reactive]';

/** @type {Map<string, Function>} name → (control, value) => void */
const registry = new Map();

/**
 * Names this module owns. They are registered through the same public
 * `registerExtender()` a consumer would use - the mechanism is not a side door -
 * but they may not be unregistered, because a page that removed `rateLimit`
 * from under a library that relies on it would fail somewhere else entirely.
 */
const BUILT_IN = new Set(['notify', 'rateLimit', 'throttle']);

// ── Registry ──────────────────────────────────────────────────────────────────

/**
 * Register an extender under a name usable in `.extend({name: value})`.
 *
 * @param {string}   name
 * @param {Function} fn  (control, value) => void
 * @returns {Function} the handler, so a registration can be assigned
 */
export function registerExtender(name, fn) {
    if (typeof name !== 'string' || name.length === 0) {
        throw new TypeError(`${PREFIX} registerExtender: the name must be a non-empty string`);
    }
    if (typeof fn !== 'function') {
        throw new TypeError(`${PREFIX} registerExtender: "${name}" was not given a function`);
    }
    if (registry.has(name) && !BUILT_IN.has(name)) {
        console.warn(`${PREFIX} registerExtender: "${name}" replaces an existing extender`);
    }
    registry.set(name, fn);
    return fn;
}

/**
 * Remove a registered extender. Built-ins are refused.
 *
 * @param {string} name
 * @returns {boolean} whether anything was removed
 */
export function unregisterExtender(name) {
    if (BUILT_IN.has(name)) return false;
    return registry.delete(name);
}

/**
 * Run every extender named in a spec against one observable's control surface.
 * An unknown name warns and is skipped; it never throws, for the same reason a
 * broken binding never throws - one bad option must not take down the page.
 *
 * @param {Object} control
 * @param {Object} spec
 */
export function applyExtenders(control, spec) {
    if (!spec || typeof spec !== 'object') {
        console.warn(`${PREFIX} extend: expected an object of extenders`);
        return;
    }

    for (const [name, value] of Object.entries(spec)) {
        const fn = registry.get(name);
        if (!fn) {
            console.warn(
                `${PREFIX} extend: no extender named "${name}". ` +
                `Registered: ${[...registry.keys()].join(', ')}.`
            );
            continue;
        }
        fn(control, value);
    }
}

// ── notify ────────────────────────────────────────────────────────────────────

/**
 * `notify: 'always'` - announce every write, including one the change gate
 * would have swallowed.
 *
 * Implemented by replacing the comparator rather than by bypassing it, so it
 * overrides an `equals` given at construction. That is the useful direction: a
 * comparator is a default the owner of the observable chose, and `notify:
 * 'always'` is a specific later instruction to stop being clever.
 */
registerExtender('notify', (control, value) => {
    if (value !== 'always') {
        console.warn(`${PREFIX} extend: notify accepts only 'always' - got ${JSON.stringify(value)}`);
        return;
    }
    control.setEquals(() => false);
});

// ── rateLimit ─────────────────────────────────────────────────────────────────

/** Per-observable limiter state, so re-extending reconfigures rather than nests. */
const limiters = new WeakMap();

/**
 * Read `rateLimit: 300` or `rateLimit: {timeout: 300, method: '…'}`.
 * @returns {{timeout: number, fixed: boolean}|null} null when unusable
 */
function readLimit(value) {
    const spec = (value && typeof value === 'object') ? value : {timeout: value};
    const timeout = spec.timeout;

    if (typeof timeout !== 'number' || !Number.isFinite(timeout) || timeout < 0) {
        console.warn(
            `${PREFIX} extend: rateLimit needs a timeout in milliseconds - ` +
            `got ${JSON.stringify(timeout)}`
        );
        return null;
    }

    const method = spec.method || 'notifyWhenChangesStop';
    if (method !== 'notifyWhenChangesStop' && method !== 'notifyAtFixedRate') {
        console.warn(
            `${PREFIX} extend: rateLimit method must be 'notifyWhenChangesStop' or ` +
            `'notifyAtFixedRate' - got ${JSON.stringify(method)}`
        );
        return null;
    }

    return {timeout, fixed: method === 'notifyAtFixedRate'};
}

/**
 * Hold `value` until the window closes, then deliver the most recent one.
 *
 * The two methods differ in one line - whether an arriving change resets the
 * deadline. `notifyWhenChangesStop` measures *quiet*: the window restarts on
 * every change, so a continuous stream of keystrokes announces nothing until
 * typing stops. `notifyAtFixedRate` measures *elapsed time*: the deadline is set
 * by the first change of a burst and does not move, so a continuous stream
 * announces once per window. Neither ever announces a stale value; both deliver
 * `state.latest` as it stands when the timer fires.
 */
function hold(state, next, value) {
    if (state.timeout <= 0) {
        next(value);
        return;
    }

    state.latest = value;
    if (state.fixed && state.armed) return;

    state.armed = true;
    if (state.timer) clearTimeout(state.timer);
    state.timer = setTimeout(() => {
        state.timer = null;
        state.armed = false;
        next(state.latest);
    }, state.timeout);
}

registerExtender('rateLimit', (control, value) => {
    const limit = readLimit(value);
    if (!limit) return;

    let state = limiters.get(control.observable);
    if (!state) {
        state = {timeout: limit.timeout, fixed: limit.fixed, timer: null, latest: undefined, armed: false};
        limiters.set(control.observable, state);
        control.intercept(next => (v) => hold(state, next, v));
    }

    state.timeout = limit.timeout;
    state.fixed   = limit.fixed;

    // A limit of zero is the documented way to switch rate limiting off, so it
    // must also drop whatever is already waiting rather than let one last
    // notification arrive after the caller asked for immediacy.
    if (limit.timeout === 0 && state.timer) {
        clearTimeout(state.timer);
        state.timer = null;
        state.armed = false;
    }
});

/**
 * `throttle` is Knockout's older name for the same thing. It is an alias rather
 * than a reimplementation of Knockout's original semantics - see the note at the
 * top of this file on why deferring the write is the wrong behaviour.
 */
registerExtender('throttle', (control, value) => {
    registry.get('rateLimit')(control, value);
});
