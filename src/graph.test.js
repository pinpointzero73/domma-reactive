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

    it('stop function detaches an effect', async () => {
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

    it('tracks reads one level deep only', async () => {
        // 'name' exists both as a nested key of 'user' and as a top-level field.
        // Reading state.user.name must depend on 'user' alone — the nested read
        // happens on the raw object the proxy returned, which is not itself
        // wrapped.
        const model = bag({user: {name: 'Ada'}, name: 'top-level decoy'});
        const state = model.proxy();
        const body = vi.fn(() => state.user.name);

        effect(body);
        expect(body).toHaveBeenCalledTimes(1);

        model.set('name', 'changed');          // nested key, never tracked
        await tick();
        expect(body).toHaveBeenCalledTimes(1);

        model.set('user', {name: 'Grace'});    // the tracked top-level field
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
