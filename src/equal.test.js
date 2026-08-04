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

    it('distinguishes +0 and -0 as equal values', () => {
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

    it('compares dates by value', () => {
        expect(isEqual(new Date('2026-01-01'), new Date('2026-01-01'))).toBe(true);
        expect(isEqual(new Date('2026-01-01'), new Date('2026-01-02'))).toBe(false);
    });

    it('falls back to reference equality for other object types', () => {
        const fn = () => {};
        expect(isEqual(fn, fn)).toBe(true);
        expect(isEqual(() => {}, () => {})).toBe(false);
    });

    it('does not recurse infinitely on cyclic structures', () => {
        const a = {name: 'a'}; a.self = a;
        const b = {name: 'a'}; b.self = b;
        expect(() => isEqual(a, b)).not.toThrow();
    });
});
