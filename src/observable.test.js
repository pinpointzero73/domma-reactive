// src/observable.test.js
import {describe, expect, it, vi} from 'vitest';
import {observable} from './observable.js';
import {computed, effect} from './graph.js';

const tick = () => new Promise(resolve => setTimeout(resolve, 0));

describe('observable', () => {
    it('holds and returns a value', () => {
        const count = observable(5);
        expect(count.value).toBe(5);
    });

    it('updates on write', () => {
        const count = observable(0);
        count.value = 7;
        expect(count.value).toBe(7);
    });

    it('is tracked by a computed', () => {
        const count = observable(2);
        const body = vi.fn(() => count.value * 2);
        const doubled = computed(body);

        expect(doubled.get()).toBe(4);
        expect(body).toHaveBeenCalledTimes(1);

        doubled.get();
        expect(body).toHaveBeenCalledTimes(1);   // cached

        count.value = 5;
        expect(doubled.get()).toBe(10);
        expect(body).toHaveBeenCalledTimes(2);
    });

    it('re-runs an effect on change', async () => {
        const name = observable('alice');
        const seen = [];

        effect(() => seen.push(name.value));
        expect(seen).toEqual(['alice']);

        name.value = 'bob';
        await tick();
        expect(seen).toEqual(['alice', 'bob']);
    });

    it('does not notify when the new value is deeply equal', async () => {
        const config = observable({theme: 'dark'});
        const body = vi.fn(() => config.value);

        effect(body);
        expect(body).toHaveBeenCalledTimes(1);

        config.value = {theme: 'dark'};      // structurally identical
        await tick();
        expect(body).toHaveBeenCalledTimes(1);

        config.value = {theme: 'light'};
        await tick();
        expect(body).toHaveBeenCalledTimes(2);
    });

    it('accepts a custom equality function', async () => {
        // Domma passes utils.isEqual here to preserve its exact semantics
        const alwaysEqual = () => true;
        const v = observable(1, {equals: alwaysEqual});
        const body = vi.fn(() => v.value);

        effect(body);
        v.value = 999;
        await tick();
        expect(body).toHaveBeenCalledTimes(1);   // never considered changed
        expect(v.value).toBe(999);               // but the value did update
    });

    it('peek() reads without registering a dependency', async () => {
        const v = observable(1);
        const body = vi.fn(() => v.peek());

        effect(body);
        v.value = 2;
        await tick();
        expect(body).toHaveBeenCalledTimes(1);
    });

    it('set() is an alias for assigning value', () => {
        const v = observable(1);
        v.set(3);
        expect(v.value).toBe(3);
    });

    // ── Beyond the plan's eight ───────────────────────────────────────────────

    it('stores the new value even when the comparator reports no change', async () => {
        // Mirrors Domma's Model._setField: the write always lands, and only the
        // notification is gated. A comparator that ignores some of the payload
        // must not cause reads to serve stale data.
        const byId = (a, b) => a?.id === b?.id;
        const user = observable({id: 1, name: 'Alice'}, {equals: byId});
        const body = vi.fn(() => user.value.name);

        effect(body);
        expect(body).toHaveBeenCalledTimes(1);

        user.value = {id: 1, name: 'Alicia'};
        await tick();
        expect(body).toHaveBeenCalledTimes(1);        // comparator: unchanged
        expect(user.peek().name).toBe('Alicia');      // store: current
    });

    it('set() works when detached from the observable', () => {
        // A published API's methods get destructured and passed as callbacks.
        const v = observable(1);
        const {set} = v;
        set(3);
        expect(v.value).toBe(3);

        const target = observable(0);
        [7].forEach(target.set);
        expect(target.value).toBe(7);
    });

    it('treats an initially undefined value as a value, not an empty slot', async () => {
        const v = observable();
        const body = vi.fn(() => v.value);

        effect(body);
        expect(v.value).toBeUndefined();

        v.value = undefined;             // no change
        await tick();
        expect(body).toHaveBeenCalledTimes(1);

        v.value = 0;
        await tick();
        expect(body).toHaveBeenCalledTimes(2);
    });

    it('does not notify when a mutated reference is written back', async () => {
        // The corollary of gating on equality: mutating in place and reassigning
        // is invisible to the graph. Task 5's observableArray exists for this.
        const list = observable(['a']);
        const body = vi.fn(() => list.value.length);

        effect(body);
        list.peek().push('b');
        list.value = list.peek();

        await tick();
        expect(body).toHaveBeenCalledTimes(1);
        expect(list.peek()).toEqual(['a', 'b']);   // mutation visible, unannounced
    });

    it('peek() inside a computed leaves it cached, so the derived value goes stale', () => {
        const v = observable(1);
        const body = vi.fn(() => v.peek() * 2);
        const doubled = computed(body);

        expect(doubled.get()).toBe(2);

        v.value = 5;
        expect(doubled.get()).toBe(2);           // peek registered nothing
        expect(body).toHaveBeenCalledTimes(1);
    });
});
