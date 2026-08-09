/**
 * Reactive dependency graph
 *
 * Dependency tracking with a batched microtask flush.
 *
 * Provides the primitive that lets a computation discover — at runtime — which
 * pieces of data it actually read, so that a later write to one of those pieces
 * can invalidate exactly the computations that care, and nothing else. That is
 * a graph walk over real dependencies, rather than the usual fallback of
 * re-evaluating every derived value and deep-comparing the results.
 *
 * This module knows nothing about the DOM, about bindings, or about any
 * particular store. It owns the graph and the scheduler, and nothing else.
 *
 * Two node types share one class:
 *   - a *computed* produces a value and can itself be depended upon
 *   - an *effect* produces no value and sits at the leaves of the graph
 *
 * Writes never recompute anything synchronously. They mark computations dirty,
 * queue them, and schedule a single microtask flush — so a burst of writes
 * (setting three fields at once, a rapid sequence of keystrokes) collapses into
 * one propagation pass and, downstream, one render.
 *
 * Usage:
 *
 *   const deps  = new DepMap();
 *   const state = trackingProxy({ count: 1 }, key => deps.for(key));
 *
 *   const doubled = computed(() => state.count * 2);
 *   effect(() => console.log('doubled is', doubled.get()));
 *
 *   state.count = 5;
 *   deps.trigger('count');   // → effect re-runs on the next microtask
 */

import { isEqual } from './equal.js';

// ── Tracking stack ────────────────────────────────────────────────────────────
// `_active` is the computation currently evaluating. Any Dep read while it is
// set records a two-way link. The stack supports nesting (a computed reading
// another computed).

let _active = null;
const _stack = [];

// ── Flush queue ───────────────────────────────────────────────────────────────

/** Computations invalidated by writes since the last flush. */
const _pending = new Set();

let _flushScheduled = false;
let _flushing       = false;

// ── Instrumentation ───────────────────────────────────────────────────────────

/**
 * Computations constructed but not yet disposed.
 *
 * A diagnostic, not a feature: it is how a test proves that churning a keyed
 * list a thousand times leaves the dependency graph exactly the size it started
 * at. A leak here is invisible in the DOM — the markup looks right while the
 * graph grows without bound — so "it renders correctly" is not evidence and this
 * number is.
 *
 * Deliberately not re-exported from index.js. It says nothing about bindings or
 * about the DOM, which is what keeps this module free of both, but it is also
 * not a promise to consumers.
 */
let _liveComputations = 0;

/** @returns {number} Computations alive right now. */
export function liveComputations() {
    return _liveComputations;
}

// ── Dep ───────────────────────────────────────────────────────────────────────

/**
 * A single reactive slot — one data field, or the output of one computed.
 * Holds the set of computations that read it during their last evaluation.
 */
export class Dep {
    constructor(owner = null) {
        /** @type {Set<Computation>} */
        this.subs  = new Set();
        /** The Computation this Dep represents the output of, if any. */
        this.owner = owner;
    }

    /** Record that the currently-evaluating computation read this slot. */
    track() {
        if (!_active || _active === this.owner) return;
        this.subs.add(_active);
        _active.deps.add(this);
    }

    /** Queue every dependent computation and schedule a flush. */
    trigger() {
        if (this.subs.size === 0) return;
        for (const sub of this.subs) {
            sub.invalidate();
            _pending.add(sub);
        }
        scheduleFlush();
    }
}

// ── DepMap ────────────────────────────────────────────────────────────────────

/**
 * A lazily-populated keyed collection of Deps — one per data field.
 * Fields are only allocated a Dep once something actually reads them.
 */
export class DepMap {
    constructor() {
        /** @type {Map<string, Dep>} */
        this._deps = new Map();
    }

    /**
     * Get (creating if needed) the Dep for a field.
     * @param {string} key
     * @returns {Dep}
     */
    for(key) {
        let dep = this._deps.get(key);
        if (!dep) {
            dep = new Dep();
            this._deps.set(key, dep);
        }
        return dep;
    }

    /**
     * Signal that a field's value has changed.
     * No-op when nothing has ever read the field.
     * @param {string} key
     */
    trigger(key) {
        this._deps.get(key)?.trigger();
    }

    /** Drop every Dep — used when the owning store is destroyed. */
    clear() {
        for (const dep of this._deps.values()) dep.subs.clear();
        this._deps.clear();
    }
}

// ── Computation ───────────────────────────────────────────────────────────────

/**
 * A tracked unit of work: a computed value or an effect.
 */
export class Computation {
    /**
     * @param {Function} fn                  Body to evaluate. Must be synchronous.
     * @param {Object}   [options]
     * @param {boolean}  [options.effect]    True for effects (no meaningful return value).
     * @param {Function} [options.onNotify]  Called after this computation's value changes.
     * @param {string}   [options.label]     Debug label (e.g. the computed's name).
     * @param {Function} [options.write]     Makes the computation writable; see `write()`.
     */
    constructor(fn, options = {}) {
        this.fn       = fn;
        this.label    = options.label || (options.effect ? 'effect' : 'computed');
        this.isEffect = options.effect === true;
        this.onNotify = options.onNotify || null;
        this._write   = typeof options.write === 'function' ? options.write : null;

        /** Deps this computation read during its last evaluation. */
        this.deps  = new Set();
        /** Deps representing *this* computation's output, for transitive tracking. */
        this.dep   = new Dep(this);

        this._value   = undefined;
        this.dirty    = true;
        this.disposed = false;

        _liveComputations++;
    }

    /**
     * Evaluate the body with dependency collection active.
     * Old dependency links are dropped first, so a computation whose branches
     * changed (`mode === 'a' ? x : y`) stops depending on the branch not taken.
     *
     * @returns {*}
     * @private
     */
    _run() {
        for (const dep of this.deps) dep.subs.delete(this);
        this.deps.clear();

        _stack.push(_active);
        _active = this;
        try {
            return this.fn();
        } catch (err) {
            console.warn(`[Domma Reactive] "${this.label}" threw during evaluation:`, err);
            return undefined;
        } finally {
            _active = _stack.pop();
        }
    }

    /**
     * Pull the current value, recomputing only if dirty, and register the
     * *reading* computation as a dependent of this one.
     *
     * @returns {*}
     */
    get() {
        if (this.dirty && !this.disposed) {
            this._value = this._run();
            this.dirty = false;
        }
        this.dep.track();
        return this._value;
    }

    /**
     * The same read as `get()`, spelled as a property.
     *
     * Not sugar. A template expression cannot call a method — the evaluator
     * refuses `x.foo()` because a call inside a render is a side effect — so
     * `{{total.get()}}` does not parse, and without this a computed could not be
     * read from a binding at all. It also makes an observable and a computed
     * spell their read the same way, which is what an author expects of two
     * things the documentation presents side by side.
     *
     * The cached result lives in `_value` rather than `value` precisely so this
     * getter can exist: a plain `value` field was reachable, stale, and silent —
     * it neither recomputed nor registered a dependency, so a binding that read
     * it rendered one wrong number and then never changed again.
     */
    get value() {
        return this.get();
    }

    /**
     * Assigning to a computed hands the value to its `write` function.
     *
     * There is nowhere else for it to go: the cached `_value` is an output, and
     * storing into it would produce a value that the next recompute silently
     * discards. So a computed is writable only if its author said where a write
     * should land — `computed({read, write})` — and read-only otherwise.
     *
     * This is what lets `data-model` bind a derived value. Without it the
     * binding would evaluate the computed, find an object, assign `value` onto
     * it, and hit the getter's cache: the control would appear to work, and
     * every keystroke would vanish on the next recompute.
     */
    set value(next) {
        this.write(next);
    }

    /**
     * Push a value back through the derivation.
     *
     * Run untracked, because the writer's own reads are not what this
     * computation depends on. A writer that reads a unit setting to convert
     * before storing would otherwise acquire a dependency on that setting, and
     * changing it would invalidate the computed for no reason.
     *
     * @param {*} next
     */
    write(next) {
        if (!this._write) {
            console.warn(
                `[Domma Reactive] "${this.label}" is a read-only computed — the assignment ` +
                'was ignored. Pass computed({read, write}) to say where a write should land.'
            );
            return;
        }
        untracked(() => this._write(next));
    }

    /** Imperative alias for assigning `.value`, matching observable().set. */
    set(next) {
        this.write(next);
    }

    /**
     * Force a re-evaluation and report whether the produced value differs from
     * the previous one. Uses `isEqual`, so structurally-identical objects
     * and arrays count as unchanged.
     *
     * @returns {{ changed: boolean, value: * }}
     */
    recompute() {
        if (this.disposed) return { changed: false, value: this._value };

        const previous = this._value;
        this._value = this._run();
        this.dirty = false;

        return { changed: !isEqual(previous, this._value), value: this._value };
    }

    /** Mark stale without recomputing. */
    invalidate() {
        this.dirty = true;
    }

    /**
     * Computations that read this one's output during their last evaluation.
     * @returns {Set<Computation>}
     */
    dependents() {
        return this.dep.subs;
    }

    /** Fire the change callback (for effects, and for render hookups). */
    notify() {
        if (this.disposed || !this.onNotify) return;
        this.onNotify(this._value, this);
    }

    /** Unlink from the graph. Safe to call more than once. */
    dispose() {
        if (this.disposed) return;

        for (const dep of this.deps) dep.subs.delete(this);
        this.deps.clear();
        this.dep.subs.clear();
        _pending.delete(this);
        this.disposed = true;

        _liveComputations--;
    }
}

// ── Scheduling ────────────────────────────────────────────────────────────────

/** Queue a flush for the end of the current microtask checkpoint. */
function scheduleFlush() {
    if (_flushScheduled || _flushing) return;
    _flushScheduled = true;
    Promise.resolve().then(flush);
}

/**
 * Drain the pending queue.
 *
 * Writes that land *during* a flush are collected and drained in a follow-up
 * flush rather than re-entering this one, so a runaway effect that writes to
 * its own dependency degrades into repeated microtasks instead of a blown stack.
 */
export function flush() {
    _flushScheduled = false;
    if (_flushing || _pending.size === 0) return;

    _flushing = true;
    try {
        const batch = new Set(_pending);
        _pending.clear();
        drainPending(batch);
    } finally {
        _flushing = false;
        if (_pending.size > 0) scheduleFlush();
    }
}

/**
 * Run any queued work immediately instead of waiting for the microtask.
 * Useful in tests, and for code that must read a settled value synchronously.
 */
export function flushSync() {
    _flushScheduled = false;
    flush();
}

// ── Propagation policy ────────────────────────────────────────────────────────

/**
 * Propagate a batch of invalidations through the dependency graph.
 *
 * `batch` holds the computations that a write touched *directly* — the ones
 * whose Deps were triggered this tick. Their dependents are not in the batch;
 * reaching those is this function's job.
 *
 * Available on each Computation:
 *   comp.recompute()   → { changed, value }  re-runs the body, re-collects deps,
 *                                            and deep-compares against the old value
 *   comp.dependents()  → Set<Computation>    computations that read this one's output
 *   comp.notify()      → void                fires the onNotify callback
 *   comp.isEffect      → boolean             true for leaf effects
 *   comp.invalidate()  → void                mark dirty without recomputing
 *
 * Policy implemented here:
 *
 *   1. Equality short-circuit. A computed that recomputes to an `isEqual` value
 *      does not propagate, so a write that cancels itself out costs nothing
 *      downstream. Note the corollary: a computed that mutates and returns the
 *      same object reference will not propagate — derivations must return new
 *      values, not edit old ones.
 *
 *   2. Cascade via worklist. Changed computeds push their dependents back onto
 *      the queue, so deep chains settle in one pass.
 *
 *   3. Re-visiting is allowed, up to MAX_VISITS. A diamond (D reads both A and
 *      B; B also reads A) can reach D before B has settled, so D must be free to
 *      run again once B changes. The visit budget is what stops a dependency
 *      cycle from spinning forever.
 *
 *   4. Effects last. Effects drive renders, so they are collected during the
 *      walk and fired only once the value graph has settled — one render per
 *      flush, never an intermediate state.
 *
 * @param {Set<Computation>} batch  Directly-invalidated computations.
 */
export function drainPending(batch) {
    /** Guards against dependency cycles spinning the worklist forever. */
    const MAX_VISITS = 20;

    const visits  = new Map();
    const effects = new Set();
    const queue   = [...batch];

    while (queue.length > 0) {
        const comp = queue.shift();
        if (comp.disposed) continue;

        const seen = (visits.get(comp) || 0) + 1;
        visits.set(comp, seen);
        if (seen > MAX_VISITS) {
            console.warn(
                `[Domma Reactive] "${comp.label}" re-entered the flush ${MAX_VISITS} times — ` +
                'likely a dependency cycle. Skipping.'
            );
            continue;
        }

        // Effects are leaves: defer them until every value has settled.
        if (comp.isEffect) {
            effects.add(comp);
            continue;
        }

        // Nothing observes this value, so leave it dirty and let the next
        // .get() pay for it. Recomputing here would break the laziness
        // guarantee for computeds that are held but not currently read.
        if (comp.dependents().size === 0 && !comp.onNotify) continue;

        const { changed } = comp.recompute();
        if (!changed) continue;

        for (const dependent of comp.dependents()) {
            dependent.invalidate();
            queue.push(dependent);
        }
    }

    for (const eff of effects) {
        if (!eff.disposed) eff.recompute();
    }
}

// ── Tracking Proxy ────────────────────────────────────────────────────────────

/**
 * Wrap a plain object so that every string-keyed property read is recorded
 * against the currently-evaluating computation.
 *
 * Reads are tracked one level deep, which matches the granularity at which a
 * host store typically notifies (per top-level field), so nested proxying is
 * unnecessary.
 *
 * @param {Object}   target            Object to wrap (typically a store's data).
 * @param {Function} depFor            (key) => Dep — resolves a field name to its Dep.
 * @param {Object}   [options]
 * @param {Function} [options.onSet]   (key, value) => void. When supplied, writes
 *                                     are routed here instead of mutating the
 *                                     target directly — letting a host store keep
 *                                     its validation and change-notification path.
 * @returns {Proxy}
 */
export function trackingProxy(target, depFor, options = {}) {
    const { onSet = null } = options;

    return new Proxy(target, {
        get(obj, key, receiver) {
            if (typeof key === 'string') depFor(key).track();
            return Reflect.get(obj, key, receiver);
        },

        has(obj, key) {
            if (typeof key === 'string') depFor(key).track();
            return Reflect.has(obj, key);
        },

        set(obj, key, value, receiver) {
            if (onSet && typeof key === 'string') {
                onSet(key, value);
                return true;
            }
            return Reflect.set(obj, key, value, receiver);
        },

        ownKeys(obj) {
            return Reflect.ownKeys(obj);
        }
    });
}

// ── Public constructors ───────────────────────────────────────────────────────

/**
 * Create a lazily-evaluated derived value.
 * The body is not run until something calls `.get()`.
 *
 * Two forms:
 *
 *   computed(() => a.value + b.value)              read-only
 *   computed({read, write})                        writable — see Computation#write
 *
 * The object form is Knockout's, and is kept because the alternative spellings
 * are worse: a second positional function is unreadable at the call site, and
 * `computed(fn, {write})` splits one derivation across two arguments.
 *
 * @param {Function|Object} fn            Derivation, or {read, write}.
 * @param {Object}   [options]
 * @param {string}   [options.label]     Debug label.
 * @param {Function} [options.onNotify]  Called when the derived value changes.
 * @param {Function} [options.write]     Where an assignment should land.
 * @returns {Computation}
 * @throws {TypeError} when the object form has no `read` function — a
 *                     construction-time programmer error, not a runtime input.
 */
export function computed(fn, options = {}) {
    if (fn !== null && typeof fn === 'object') {
        const { read, ...rest } = fn;
        if (typeof read !== 'function') {
            throw new TypeError('[Domma Reactive] computed({read, write}): `read` must be a function');
        }
        return new Computation(read, { ...rest, ...options, effect: false });
    }
    return new Computation(fn, { ...options, effect: false });
}

/**
 * Create an effect: a computation run for its side effects, evaluated
 * immediately so its dependencies are collected up front.
 *
 * @param {Function} fn               Synchronous body. Must not await.
 * @param {Object}   [options]
 * @param {string}   [options.label]   Debug label.
 * @returns {Computation}
 */
export function effect(fn, options = {}) {
    // Evaluated immediately so its dependencies are collected up front.
    // Re-runs are driven by drainPending(), which calls recompute() directly.
    const comp = new Computation(fn, { ...options, effect: true, onNotify: null });
    comp.recompute();
    return comp;
}

/**
 * Run a function with dependency tracking suspended.
 * Reads inside are not recorded against the enclosing computation.
 *
 * @param {Function} fn
 * @returns {*}
 */
export function untracked(fn) {
    _stack.push(_active);
    _active = null;
    try {
        return fn();
    } finally {
        _active = _stack.pop();
    }
}

export const reactive = {
    Dep,
    DepMap,
    Computation,
    computed,
    effect,
    untracked,
    trackingProxy,
    flush,
    flushSync
};
