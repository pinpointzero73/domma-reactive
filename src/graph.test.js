// src/graph.test.js
import {describe, expect, it, vi} from 'vitest';
import {computed, effect, untracked, flushSync, DepMap, trackingProxy} from './graph.js';

/** Let the batched microtask flush run. */
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

/** Minimal field-bag stand-in for a Model, so the graph can be tested alone. */
function bag(initial = {}) {
    const deps = new DepMap();
    const data = {...initial};
    return {
        get: (k) => { deps.for(k).track(); return data[k]; },
        set: (k, v) => { data[k] = v; deps.trigger(k); },
        proxy: () => trackingProxy(data, (k) => deps.for(k))
    };
}

describe('reactive graph - dependency tracking', () => {

    it('computed evaluates lazily and caches until a dependency changes', () => {
        const model = bag({price: 10, qty: 3});
        const body = vi.fn(() => model.get('price') * model.get('qty'));
        const total = computed(body);

        expect(body).not.toHaveBeenCalled();      // lazy: not run until read

        expect(total.get()).toBe(30);
        expect(total.get()).toBe(30);
        expect(body).toHaveBeenCalledTimes(1);    // cached

        model.set('qty', 4);
        expect(total.get()).toBe(40);
        expect(body).toHaveBeenCalledTimes(2);
    });

    it('computed does not re-run when an untouched field changes', () => {
        const model = bag({a: 1, b: 1});
        const body = vi.fn(() => model.get('a') * 2);
        const derived = computed(body);

        derived.get();
        expect(body).toHaveBeenCalledTimes(1);

        model.set('b', 99);              // 'b' was never read
        derived.get();
        expect(body).toHaveBeenCalledTimes(1);
    });

    it('effect re-runs when a dependency changes', async () => {
        const model = bag({count: 0});
        const seen = [];

        effect(() => seen.push(model.get('count')));
        expect(seen).toEqual([0]);       // runs immediately

        model.set('count', 1);
        await tick();
        expect(seen).toEqual([0, 1]);
    });

    it('batches a burst of writes into a single effect run', async () => {
        const model = bag({a: 0, b: 0, c: 0});
        const body = vi.fn(() => {
            model.get('a'); model.get('b'); model.get('c');
        });

        effect(body);
        expect(body).toHaveBeenCalledTimes(1);

        model.set('a', 1);               // three field notifications
        model.set('b', 2);
        model.set('c', 3);
        await tick();
        expect(body).toHaveBeenCalledTimes(2);   // one flush, not three
    });

    it('re-collects dependencies so untaken branches stop triggering', async () => {
        const model = bag({mode: 'x', x: 1, y: 1});
        const body = vi.fn(() => (model.get('mode') === 'x' ? model.get('x') : model.get('y')));

        effect(body);
        expect(body).toHaveBeenCalledTimes(1);

        model.set('y', 50);              // 'y' not read on the taken branch
        await tick();
        expect(body).toHaveBeenCalledTimes(1);

        model.set('mode', 'y');          // now the branch flips
        await tick();
        expect(body).toHaveBeenCalledTimes(2);

        model.set('y', 51);              // 'y' is now a real dependency
        await tick();
        expect(body).toHaveBeenCalledTimes(3);

        model.set('x', 99);              // 'x' no longer read
        await tick();
        expect(body).toHaveBeenCalledTimes(3);
    });

    it('stops propagation when a computed recomputes to an equal value', async () => {
        const model = bag({n: 2});
        const isEven = computed(() => model.get('n') % 2 === 0);
        const downstream = vi.fn(() => isEven.get());

        effect(downstream);
        expect(downstream).toHaveBeenCalledTimes(1);

        model.set('n', 4);               // still even → derived value unchanged
        await tick();
        expect(downstream).toHaveBeenCalledTimes(1);

        model.set('n', 5);               // now odd → propagates
        await tick();
        expect(downstream).toHaveBeenCalledTimes(2);
    });

    it('propagates through chained computeds', async () => {
        const model = bag({n: 1});
        const doubled = computed(() => model.get('n') * 2);
        const quadrupled = computed(() => doubled.get() * 2);

        const seen = [];
        effect(() => seen.push(quadrupled.get()));
        expect(seen).toEqual([4]);

        model.set('n', 3);
        await tick();
        expect(seen).toEqual([4, 12]);
    });

    it('settles a diamond dependency without a stale read', async () => {
        // D reads A directly and via B — B must settle before D's final value.
        const model = bag({a: 1});
        const b = computed(() => model.get('a') + 10);
        const seen = [];

        effect(() => seen.push(`${model.get('a')}:${b.get()}`));
        expect(seen).toEqual(['1:11']);

        model.set('a', 2);
        await tick();
        expect(seen).toEqual(['1:11', '2:12']);
    });

    it('disposing an effect detaches it', async () => {
        const model = bag({v: 0});
        const body = vi.fn(() => model.get('v'));

        const comp = effect(body);
        expect(body).toHaveBeenCalledTimes(1);

        comp.dispose();
        model.set('v', 1);
        await tick();
        expect(body).toHaveBeenCalledTimes(1);
    });

    it('untracked reads do not create dependencies', async () => {
        const model = bag({tracked: 0, hidden: 0});
        const body = vi.fn(() => {
            model.get('tracked');
            untracked(() => model.get('hidden'));
        });

        effect(body);
        model.set('hidden', 99);
        await tick();
        expect(body).toHaveBeenCalledTimes(1);

        model.set('tracked', 1);
        await tick();
        expect(body).toHaveBeenCalledTimes(2);
    });

    it('flushSync settles pending work synchronously', () => {
        const model = bag({v: 0});
        const seen = [];

        effect(() => seen.push(model.get('v')));
        model.set('v', 7);

        expect(seen).toEqual([0]);   // not yet flushed
        flushSync();
        expect(seen).toEqual([0, 7]);
    });
});

describe('reactive graph - trackingProxy', () => {

    it('records a property read as a dependency of the enclosing computation', async () => {
        const model = bag({count: 0});
        const state = model.proxy();
        const seen = [];

        effect(() => seen.push(state.count));
        expect(seen).toEqual([0]);

        model.set('count', 1);
        await tick();
        expect(seen).toEqual([0, 1]);
    });

    it('returns nested objects unwrapped, so tracking stops at one level', () => {
        // The mechanism behind one-level-deep tracking: `get` hands back the
        // raw value. Any recursive variant — whatever keyspace it tracked
        // nested reads under — would return a fresh Proxy here instead.
        const deps = new DepMap();
        const nested = {name: 'Ada'};
        const state = trackingProxy({user: nested}, (k) => deps.for(k));

        expect(state.user).toBe(nested);
    });

    it('registers only the top-level field when a nested property is read', async () => {
        // 'name' is both a nested key of 'user' and a top-level field, so the
        // two would collide if a nested read leaked into the same keyspace.
        // Triggering 'name' below reaches a Dep that only has a subscriber if
        // that leak happened — DepMap.trigger looks up the Dep, not the datum.
        const model = bag({user: {name: 'Ada'}, name: 'top-level namesake'});
        const state = model.proxy();
        const body = vi.fn(() => state.user.name);

        effect(body);
        expect(body).toHaveBeenCalledTimes(1);

        model.set('name', 'changed');          // triggers the 'name' Dep
        await tick();
        expect(body).toHaveBeenCalledTimes(1);

        model.set('user', {name: 'Grace'});    // the field actually tracked
        await tick();
        expect(body).toHaveBeenCalledTimes(2);
    });

    it('tracks membership tests made with `in`', async () => {
        const model = bag({flag: 1});
        const state = model.proxy();
        const body = vi.fn(() => 'flag' in state);

        effect(body);
        expect(body).toHaveBeenCalledTimes(1);

        model.set('flag', 2);
        await tick();
        expect(body).toHaveBeenCalledTimes(2);
    });

    it('does not track symbol-keyed reads', async () => {
        const hidden = Symbol('hidden');
        const deps = new DepMap();
        const data = {[hidden]: 0, plain: 0};
        const state = trackingProxy(data, (k) => deps.for(k));

        const body = vi.fn(() => {
            void state[hidden];
            void state.plain;
        });

        effect(body);
        expect(body).toHaveBeenCalledTimes(1);

        data[hidden] = 1;
        deps.trigger(hidden);          // no Dep was ever allocated for a symbol
        await tick();
        expect(body).toHaveBeenCalledTimes(1);

        data.plain = 1;
        deps.trigger('plain');         // the string key is tracked as normal
        await tick();
        expect(body).toHaveBeenCalledTimes(2);
    });

    it('routes writes through onSet instead of mutating the target', () => {
        const deps = new DepMap();
        const data = {count: 1};
        const writes = [];
        const state = trackingProxy(data, (k) => deps.for(k), {
            onSet: (key, value) => writes.push([key, value])
        });

        state.count = 5;

        expect(writes).toEqual([['count', 5]]);
        expect(data.count).toBe(1);    // target left for the host store to update
    });

    it('writes straight through to the target when onSet is absent', () => {
        const deps = new DepMap();
        const data = {count: 1};
        const state = trackingProxy(data, (k) => deps.for(k));

        state.count = 5;

        expect(data.count).toBe(5);
    });
});

describe('reactive graph - propagation policy', () => {

    it('fires an effect once per flush, after the value graph has settled', async () => {
        // The effect is reachable twice in one walk: directly, because it reads
        // 'b', and again as a dependent of the computed reading 'a'. Deferring
        // effects to the end collapses that into a single run.
        const model = bag({a: 1, b: 1});
        const scaled = computed(() => model.get('a') * 10, {label: 'scaled'});
        const body = vi.fn(() => `${scaled.get()}:${model.get('b')}`);

        effect(body);
        expect(body).toHaveBeenCalledTimes(1);

        model.set('a', 2);
        model.set('b', 2);
        await tick();
        expect(body).toHaveBeenCalledTimes(2);
    });

    it('leaves an unobserved computed dirty instead of recomputing it in the flush', async () => {
        const model = bag({n: 1});
        const body = vi.fn(() => model.get('n') * 2);
        const derived = computed(body);

        expect(derived.get()).toBe(2);
        expect(body).toHaveBeenCalledTimes(1);

        model.set('n', 5);
        await tick();
        expect(body).toHaveBeenCalledTimes(1);   // nothing reads it — stays lazy

        expect(derived.get()).toBe(10);          // the next read pays for it
        expect(body).toHaveBeenCalledTimes(2);
    });

    it('recomputes an unobserved computed that carries a change callback', async () => {
        // onNotify counts as an observer, so laziness must not apply.
        const model = bag({n: 1});
        const body = vi.fn(() => model.get('n') * 2);
        computed(body, {onNotify: () => {}}).get();
        expect(body).toHaveBeenCalledTimes(1);

        model.set('n', 5);
        await tick();
        expect(body).toHaveBeenCalledTimes(2);
    });

    it('lets a computed be revisited within one flush without warning', async () => {
        // Diamond: 'derived' reads 'base' and 'x', and base reads 'x' too, so a
        // write to 'x' reaches derived once directly and once via base. The
        // second visit is legitimate and must not trip the cycle guard.
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            const model = bag({x: 1});
            const base = computed(() => model.get('x') + 10, {label: 'base'});
            const derived = computed(() => base.get() + model.get('x'), {label: 'derived'});
            const seen = [];

            effect(() => seen.push(derived.get()));
            expect(seen).toEqual([12]);

            model.set('x', 2);
            await tick();

            expect(seen).toEqual([12, 14]);
            expect(warn).not.toHaveBeenCalled();
        } finally {
            warn.mockRestore();
        }
    });

    it('terminates a dependency cycle with a warning rather than spinning', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            // The cycle is introduced only after both nodes have been evaluated
            // once, so building it does not recurse infinitely.
            const model = bag({x: 1});
            let phase = 0;
            let b;
            const a = computed(() => (phase === 0 ? model.get('x') : b.get() + 1), {label: 'a'});
            b = computed(() => a.get() + 1, {label: 'b'});

            b.get();
            phase = 1;

            model.set('x', 2);
            await tick();            // must settle, not hang

            expect(warn).toHaveBeenCalled();
            const messages = warn.mock.calls.map(([msg]) => String(msg));
            expect(messages.some(m => /likely a dependency cycle/.test(m))).toBe(true);
        } finally {
            warn.mockRestore();
        }
    });
});

describe('reactive graph - teardown', () => {

    it('disposal unlinks a computation from the deps it read', async () => {
        // Once the watcher is gone the computed has no observers left, so the
        // laziness skip should apply. It only can if dispose() actually removed
        // the watcher from the computed's subscriber set.
        const model = bag({n: 1});
        const body = vi.fn(() => model.get('n') * 2);
        const derived = computed(body);
        const watcher = effect(() => derived.get());

        expect(body).toHaveBeenCalledTimes(1);

        watcher.dispose();
        model.set('n', 5);
        await tick();

        expect(body).toHaveBeenCalledTimes(1);
    });

    it('disposal clears the computation own subscriber set', () => {
        // Asserted on internals deliberately: with the computation detached
        // from the graph there is no longer any path that can observe this
        // leak behaviourally.
        const model = bag({n: 1});
        const derived = computed(() => model.get('n') * 2);
        const watcher = effect(() => derived.get());

        expect(derived.dep.subs.has(watcher)).toBe(true);

        derived.dispose();
        expect(derived.dep.subs.size).toBe(0);
    });

    it('clearing a DepMap detaches everything tracking it', async () => {
        const deps = new DepMap();
        const data = {n: 1};
        const body = vi.fn(() => { deps.for('n').track(); return data.n; });

        effect(body);
        expect(body).toHaveBeenCalledTimes(1);

        deps.clear();
        data.n = 2;
        deps.trigger('n');
        await tick();

        expect(body).toHaveBeenCalledTimes(1);
    });
});

describe('reactive graph - error handling', () => {

    it('warns and yields undefined when a computation body throws', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            const boom = computed(() => { throw new Error('kaboom'); }, {label: 'boom'});

            expect(boom.get()).toBeUndefined();
            expect(warn).toHaveBeenCalled();
            expect(String(warn.mock.calls[0][0])).toContain('boom');
        } finally {
            warn.mockRestore();
        }
    });
});

// ── Reading a computed as a property ──────────────────────────────────────────
//
// `computed()` returns a Computation, whose canonical read is `get()`. A
// TEMPLATE cannot call it: the expression evaluator refuses method calls,
// deliberately, because a call inside a render is a side effect. So a computed
// was unreadable from a binding — `{{total.get()}}` will not parse, and
// `{{total.value}}` used to reach a plain cached FIELD that neither recomputed
// nor registered a dependency, which is worse than unreadable because it renders
// a stale number once and then never changes.
//
// `.value` is now the same read as `get()`, which also makes a computed and an
// observable spell their read identically.

describe('computed().value', () => {
    /** A tracked source, built from DepMap so this file stays graph-only. */
    function source(initial) {
        const deps = new DepMap();
        let held = initial;
        return {
            read() { deps.for('v').track(); return held; },
            write(next) { held = next; deps.trigger('v'); }
        };
    }

    it('recomputes when dirty, exactly as get() does', () => {
        const n = source(2);
        const double = computed(() => n.read() * 2);

        expect(double.value).toBe(4);
        n.write(5);
        expect(double.value).toBe(10);
    });

    it('registers a dependency, so a reader re-runs', async () => {
        const n = source(1);
        const double = computed(() => n.read() * 2);

        const seen = [];
        effect(() => seen.push(double.value));

        n.write(3);
        await flushSync();

        expect(seen).toEqual([2, 6]);
    });

    it('agrees with get()', () => {
        const n = source(4);
        const half = computed(() => n.read() / 2);
        expect(half.value).toBe(half.get());
    });
});

// ── Writing through a computed ────────────────────────────────────────────────
//
// A computed derives a value, so writing to one is only meaningful if the author
// says where the write should land. `computed({read, write})` is that statement.
// Without a `write`, an assignment has nowhere to go and is refused loudly rather
// than dropped — a two-way binding pointed at a read-only computed would
// otherwise look wired up and silently discard every keystroke.

describe('writable computed', () => {
    /** A tracked source, built from DepMap so this file stays graph-only. */
    function source(initial) {
        const deps = new DepMap();
        let held = initial;
        return {
            read() { deps.for('v').track(); return held; },
            write(next) { held = next; deps.trigger('v'); }
        };
    }

    it('reads through the object form', () => {
        const n = source(3);
        const double = computed({read: () => n.read() * 2});
        expect(double.value).toBe(6);
    });

    it('stays lazy in the object form', () => {
        const body = vi.fn(() => 1);
        computed({read: body});
        expect(body).not.toHaveBeenCalled();
    });

    it('keeps the label given in the object form', () => {
        const c = computed({read: () => 1, label: 'total'});
        expect(c.label).toBe('total');
    });

    it('refuses an object with no read function', () => {
        expect(() => computed({write: () => {}})).toThrow(TypeError);
        expect(() => computed({read: 'nope'})).toThrow(TypeError);
    });

    it('hands an assignment to the write function', () => {
        const write = vi.fn();
        const c = computed({read: () => 1, write});

        c.value = 42;
        expect(write).toHaveBeenCalledTimes(1);
        expect(write).toHaveBeenCalledWith(42);
    });

    it('lets the write land where the read came from', () => {
        const celsius = source(100);
        const fahrenheit = computed({
            read: () => celsius.read() * 9 / 5 + 32,
            write: (f) => celsius.write((f - 32) * 5 / 9)
        });

        expect(fahrenheit.value).toBe(212);

        fahrenheit.value = 32;
        expect(fahrenheit.value).toBe(32);
        expect(celsius.read()).toBe(0);
    });

    it('offers set() as the same write, for symmetry with an observable', () => {
        const n = source(1);
        const c = computed({read: () => n.read(), write: (v) => n.write(v)});

        c.set(9);
        expect(c.value).toBe(9);
    });

    it('does not collect dependencies from inside the write', () => {
        const shown = source(1);
        const hidden = source(0);

        const c = computed({
            read: () => shown.read(),
            write: (v) => { hidden.read(); shown.write(v); }
        });

        c.get();                       // collects: shown
        expect(c.deps.size).toBe(1);

        c.value = 5;
        c.get();                       // recollects: still only shown
        expect(c.deps.size).toBe(1);
    });

    it('warns when a read-only computed is assigned, and changes nothing', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const c = computed(() => 7);

        expect(c.value).toBe(7);
        c.value = 99;

        expect(c.value).toBe(7);
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls[0][0]).toContain('read-only');
        warn.mockRestore();
    });

    it('re-runs a dependent effect after a write', async () => {
        const n = source(1);
        const c = computed({read: () => n.read(), write: (v) => n.write(v)});

        const seen = [];
        effect(() => seen.push(c.value));

        c.value = 4;
        flushSync();
        expect(seen).toEqual([1, 4]);
    });
});
