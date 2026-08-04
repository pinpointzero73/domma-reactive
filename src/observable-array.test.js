// src/observable-array.test.js
import {describe, expect, it, vi} from 'vitest';
import {observableArray} from './observable.js';
import {effect} from './graph.js';

const tick = () => new Promise(resolve => setTimeout(resolve, 0));

describe('observableArray', () => {
    it('exposes the underlying array via value', () => {
        const items = observableArray([1, 2]);
        expect(items.value).toEqual([1, 2]);
        expect(items.length).toBe(2);
    });

    it('defaults to an empty array', () => {
        expect(observableArray().value).toEqual([]);
    });

    it('notifies on push', async () => {
        const items = observableArray([]);
        const body = vi.fn(() => items.value.length);

        effect(body);
        expect(body).toHaveBeenCalledTimes(1);

        items.push('a');
        await tick();
        expect(body).toHaveBeenCalledTimes(2);
        expect(items.value).toEqual(['a']);
    });

    it('notifies on pop, shift, unshift, splice, reverse and sort', async () => {
        const items = observableArray([3, 1, 2]);
        let runs = 0;
        effect(() => { items.value; runs++; });
        expect(runs).toBe(1);

        items.push(4);      await tick();
        items.pop();        await tick();
        items.unshift(0);   await tick();
        items.shift();      await tick();
        items.splice(0, 1); await tick();
        items.reverse();    await tick();
        items.sort();       await tick();

        expect(runs).toBe(8);   // initial + 7 mutations
    });

    it('remove() deletes by value and notifies', async () => {
        const items = observableArray(['a', 'b', 'c']);
        let runs = 0;
        effect(() => { items.value; runs++; });

        items.remove('b');
        await tick();
        expect(items.value).toEqual(['a', 'c']);
        expect(runs).toBe(2);
    });

    it('removeAll() empties and notifies', async () => {
        const items = observableArray([1, 2, 3]);
        let runs = 0;
        effect(() => { items.value; runs++; });

        items.removeAll();
        await tick();
        expect(items.value).toEqual([]);
        expect(runs).toBe(2);
    });

    it('replacing value wholesale notifies', async () => {
        const items = observableArray([1]);
        const body = vi.fn(() => items.value);

        effect(body);
        items.value = [1, 2];
        await tick();
        expect(body).toHaveBeenCalledTimes(2);
    });

    it('does not notify when replaced with a deeply equal array', async () => {
        const items = observableArray([{id: 1}]);
        const body = vi.fn(() => items.value);

        effect(body);
        items.value = [{id: 1}];
        await tick();
        expect(body).toHaveBeenCalledTimes(1);
    });

    it('mutators return what the native array methods return', () => {
        const items = observableArray([1, 2, 3]);
        expect(items.push(4)).toBe(4);          // new length
        expect(items.pop()).toBe(4);            // popped value
        expect(items.splice(0, 1)).toEqual([1]); // removed slice
    });

    // ── Beyond the plan's nine ────────────────────────────────────────────────

    it('mutators notify even when the contents did not change — the accepted cost', async () => {
        // The deliberate trade-off of triggering directly instead of comparing:
        // the mutator knows it was called, not whether it achieved anything.
        const items = observableArray([1, 2]);
        let runs = 0;
        effect(() => { items.value; runs++; });

        items.splice(0, 0);            // a splice that removes and inserts nothing
        await tick();
        expect(runs).toBe(2);
        expect(items.value).toEqual([1, 2]);
    });

    it('wholesale assignment always stores, even when the comparator says unchanged', async () => {
        // Task 4's corrected semantics, carried over: the gate is on the
        // notification, never on the write.
        const items = observableArray([1], {equals: () => true});
        const body = vi.fn(() => items.value);

        effect(body);
        items.value = [2, 3];
        await tick();
        expect(body).toHaveBeenCalledTimes(1);      // comparator: unchanged
        expect(items.peek()).toEqual([2, 3]);       // store: current
    });

    it('peek() reads without registering a dependency', async () => {
        const items = observableArray([1]);
        const body = vi.fn(() => items.peek().length);

        const e = effect(body);
        expect(e.deps.size).toBe(0);

        items.push(2);
        await tick();
        expect(body).toHaveBeenCalledTimes(1);
    });

    it('reading length registers a dependency and re-runs on mutation', async () => {
        // A length read that did not track would be a trap: rendering a count
        // is the most obvious thing to do with it, and it would never update.
        const items = observableArray(['a']);
        const seen = [];

        const e = effect(() => seen.push(items.length));
        expect(e.deps.size).toBe(1);

        items.push('b');
        await tick();
        expect(seen).toEqual([1, 2]);
    });

    it('remove() deletes every occurrence, not just the first', () => {
        const items = observableArray(['a', 'b', 'a', 'c', 'a']);
        items.remove('a');
        expect(items.value).toEqual(['b', 'c']);
    });

    it('coerces non-array input and non-array assignment to an empty array', () => {
        expect(observableArray('nonsense').value).toEqual([]);

        const items = observableArray([1, 2]);
        items.value = null;
        expect(items.value).toEqual([]);
    });
});
