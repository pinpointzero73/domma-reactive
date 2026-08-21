import {describe, expect, it} from 'vitest';
import {isEqual} from './equal.js';

describe('isEqual', () => {
    it('compares primitives', () => {
        expect(isEqual(1, 1)).toBe(true);
        expect(isEqual(1, 2)).toBe(false);
        expect(isEqual('a', 'a')).toBe(true);
        expect(isEqual(true, false)).toBe(false);
        expect(isEqual(null, null)).toBe(true);
        expect(isEqual(undefined, undefined)).toBe(true);
        expect(isEqual(null, undefined)).toBe(false);
    });

    it('treats NaN as equal to itself', () => {
        // Change detection must not fire forever on a NaN field
        expect(isEqual(NaN, NaN)).toBe(true);
    });

    it('treats +0 and -0 as equal', () => {
        expect(isEqual(0, -0)).toBe(true);
    });

    it('compares arrays deeply', () => {
        expect(isEqual([1, 2, 3], [1, 2, 3])).toBe(true);
        expect(isEqual([1, 2], [1, 2, 3])).toBe(false);
        expect(isEqual([{a: 1}], [{a: 1}])).toBe(true);
        expect(isEqual([{a: 1}], [{a: 2}])).toBe(false);
    });

    it('compares plain objects deeply, ignoring key order', () => {
        expect(isEqual({a: 1, b: 2}, {b: 2, a: 1})).toBe(true);
        expect(isEqual({a: 1}, {a: 1, b: 2})).toBe(false);
        expect(isEqual({a: {b: {c: 1}}}, {a: {b: {c: 1}}})).toBe(true);
    });

    it('compares objects with a null prototype', () => {
        const a = Object.create(null);
        a.x = 1;
        const b = Object.create(null);
        b.x = 1;
        expect(isEqual(a, b)).toBe(true);

        const c = Object.create(null);
        c.x = 2;
        expect(isEqual(a, c)).toBe(false);
    });

    it('compares dates by value', () => {
        expect(isEqual(new Date('2026-01-01'), new Date('2026-01-01'))).toBe(true);
        expect(isEqual(new Date('2026-01-01'), new Date('2026-01-02'))).toBe(false);
    });

    it('treats two invalid dates as equal', () => {
        // Both getTime() values are NaN - the same "must not fire forever"
        // rationale as the NaN case above
        expect(isEqual(new Date('nonsense'), new Date('nonsense'))).toBe(true);
        expect(isEqual(new Date('nonsense'), new Date('2026-01-01'))).toBe(false);
    });

    it('falls back to reference equality for functions', () => {
        const fn = () => {};
        expect(isEqual(fn, fn)).toBe(true);
        expect(isEqual(() => {}, () => {})).toBe(false);
    });

    it('falls back to reference equality for class instances', () => {
        class P {
            constructor(x) {
                this.x = x;
            }
        }

        const p = new P(1);
        expect(isEqual(p, p)).toBe(true);
        // Structurally identical, but not ours to compare field by field
        expect(isEqual(new P(1), new P(1))).toBe(false);
        // An instance is never equal to a look-alike plain object
        expect(isEqual(new P(1), {x: 1})).toBe(false);
        expect(isEqual({x: 1}, new P(1))).toBe(false);
    });

    it('falls back to reference equality for Map and Set', () => {
        // Both have zero own keys, so a naive key-walk would call these equal
        // and silently miss the change
        expect(isEqual(new Map([['a', 1]]), new Map([['a', 2]]))).toBe(false);
        expect(isEqual(new Map([['a', 1]]), new Map([['a', 1]]))).toBe(false);
        expect(isEqual(new Set([1]), new Set([2]))).toBe(false);

        const m = new Map([['a', 1]]);
        expect(isEqual(m, m)).toBe(true);
    });

    it('does not recurse infinitely on cyclic structures', () => {
        const a = {name: 'a'}; a.self = a;
        const b = {name: 'a'}; b.self = b;
        expect(() => isEqual(a, b)).not.toThrow();
    });

    it('compares cyclic structures by their payload', () => {
        const a = {name: 'a'}; a.self = a;
        const b = {name: 'a'}; b.self = b;
        expect(isEqual(a, b)).toBe(true);

        const c = {n: 1}; c.self = c;
        const d = {n: 2}; d.self = d;
        expect(isEqual(c, d)).toBe(false);
    });

    it('compares mutually cyclic structures', () => {
        const a1 = {n: 1};
        const a2 = {n: 2};
        a1.p = a2;
        a2.p = a1;

        const b1 = {n: 1};
        const b2 = {n: 2};
        b1.p = b2;
        b2.p = b1;

        expect(isEqual(a1, b1)).toBe(true);

        const c1 = {n: 1};
        const c2 = {n: 99};
        c1.p = c2;
        c2.p = c1;

        expect(isEqual(a1, c1)).toBe(false);
    });

    it('exposes no internal parameters on the public signature', () => {
        expect(isEqual.length).toBe(2);
    });
});
