// src/observable.test.js
import {describe, expect, it, vi} from 'vitest';
import {observable, observableArray} from './observable.js';
import {computed, effect, flushSync, liveComputations} from './graph.js';

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

    it('records the read as a dependency edge', () => {
        // Asserted structurally, not through a notification: a read that is
        // never recorded and a write that is never announced both present as
        // "the graph did not move", so the two are only separable at the edge.
        const v = observable(1);
        const e = effect(() => v.value);
        expect(e.deps.size).toBe(1);
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

    it('peek() leaves no dependency edge', () => {
        const v = observable(1);
        const e = effect(() => v.peek());
        expect(e.deps.size).toBe(0);
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

    it('silently drops an in-place mutation written back - use observableArray()', async () => {
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

// ── subscribe ─────────────────────────────────────────────────────────────────

describe('observable.subscribe', () => {
    it('fires synchronously at the write, with no flush', () => {
        const count = observable(1);
        const seen = [];

        count.subscribe((value) => seen.push(value));
        count.value = 2;

        // No flushSync() - a subscription is a notification about a write, not
        // a recomputation of a graph.
        expect(seen).toEqual([2]);
    });

    it('does not fire on creation', () => {
        const count = observable(1);
        const seen = [];

        count.subscribe((value) => seen.push(value));

        expect(seen).toEqual([]);
    });

    it('fires for set() as well as for .value', () => {
        const count = observable(1);
        const seen = [];

        count.subscribe((value) => seen.push(value));
        count.set(5);

        expect(seen).toEqual([5]);
    });

    it('follows the change gate: an equal write notifies nobody', () => {
        const point = observable({x: 1});
        const seen = [];

        point.subscribe((value) => seen.push(value));
        point.value = {x: 1};
        expect(seen).toEqual([]);

        point.value = {x: 2};
        expect(seen).toHaveLength(1);
    });

    it('honours a custom comparator, exactly as the graph does', () => {
        const row = observable({id: 1, at: 'a'}, {equals: (a, b) => a?.id === b?.id});
        const seen = [];

        row.subscribe((value) => seen.push(value));
        row.value = {id: 1, at: 'b'};
        expect(seen).toEqual([]);

        row.value = {id: 2, at: 'b'};
        expect(seen).toHaveLength(1);
    });

    it('returns an unsubscribe handle that is also a Knockout-style dispose()', () => {
        const count = observable(0);
        const one = [];
        const two = [];

        const offOne = count.subscribe((v) => one.push(v));
        const offTwo = count.subscribe((v) => two.push(v));

        count.value = 1;
        offOne();
        count.value = 2;
        offTwo.dispose();
        count.value = 3;

        expect(one).toEqual([1]);
        expect(two).toEqual([1, 2]);
    });

    it('unsubscribing twice is harmless', () => {
        const count = observable(0);
        const off = count.subscribe(() => {});

        off();
        expect(() => off()).not.toThrow();
    });

    it('supports several subscribers, in the order they subscribed', () => {
        const count = observable(0);
        const order = [];

        count.subscribe(() => order.push('first'));
        count.subscribe(() => order.push('second'));
        count.value = 1;

        expect(order).toEqual(['first', 'second']);
    });

    it('survives a subscriber unsubscribing itself mid-notification', () => {
        const count = observable(0);
        const seen = [];

        const off = count.subscribe((value) => {
            seen.push(value);
            off();
        });
        count.subscribe((value) => seen.push(`other:${value}`));

        count.value = 1;
        count.value = 2;

        expect(seen).toEqual([1, 'other:1', 'other:2']);
    });

    it('reports a throwing subscriber and carries on', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const count = observable(0);
        const seen = [];

        count.subscribe(() => { throw new Error('bad subscriber'); });
        count.subscribe((value) => seen.push(value));

        expect(() => { count.value = 1; }).not.toThrow();
        expect(seen).toEqual([1]);
        expect(warn).toHaveBeenCalled();

        warn.mockRestore();
    });

    it('rejects anything that is not a function', () => {
        const count = observable(0);
        expect(() => count.subscribe(null)).toThrow(TypeError);
        expect(() => count.subscribe('nope')).toThrow(TypeError);
    });

    it('is not a Computation, so it does not enter the graph', () => {
        const before = liveComputations();
        const count = observable(0);

        count.subscribe(() => {});
        count.subscribe(() => {});

        expect(liveComputations()).toBe(before);
    });

    it('reads inside a subscriber do not attach to the enclosing computation', () => {
        // The subscriber runs during the WRITE, which may well be inside some
        // other computation's body. Whatever it reads must not become that
        // computation's dependency.
        const source = observable(0);
        const other = observable('x');
        let runs = 0;

        source.subscribe(() => { other.peek(); });

        const watcher = effect(() => { runs++; source.value; });
        expect(runs).toBe(1);

        other.value = 'y';
        flushSync();
        expect(runs).toBe(1);

        watcher.dispose();
    });
});

describe('observableArray.subscribe', () => {
    it('fires for every in-place mutator', () => {
        const rows = observableArray([1, 2, 3]);
        const seen = [];

        rows.subscribe((value) => seen.push([...value]));

        rows.push(4);
        rows.pop();
        rows.shift();
        rows.unshift(0);
        rows.splice(1, 1);
        rows.reverse();
        rows.sort();

        expect(seen).toHaveLength(7);
        expect(seen[0]).toEqual([1, 2, 3, 4]);
    });

    it('fires for remove() and removeAll()', () => {
        const rows = observableArray(['a', 'b']);
        const seen = [];

        rows.subscribe((value) => seen.push([...value]));
        rows.remove('a');
        rows.removeAll();

        expect(seen).toEqual([['b'], []]);
    });

    it('gates wholesale assignment on the comparator, like observable()', () => {
        const rows = observableArray([1, 2]);
        const seen = [];

        rows.subscribe((value) => seen.push([...value]));

        rows.value = [1, 2];
        expect(seen).toEqual([]);

        rows.value = [1, 2, 3];
        expect(seen).toEqual([[1, 2, 3]]);
    });

    it('hands over the live array, not a copy', () => {
        const rows = observableArray([1]);
        let received = null;

        rows.subscribe((value) => { received = value; });
        rows.push(2);

        expect(received).toBe(rows.peek());
    });
});
