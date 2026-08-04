/**
 * The specification of what this package promises not to break.
 *
 * The name list below is the contract: adding to it is a minor version, taking
 * from it is a major one. But names alone are a weak contract — a namespace
 * object with the right keys can still have them bound to the wrong functions,
 * and `Object.keys()` cannot tell. So each name is also pinned to the
 * implementation it must resolve to.
 */

import {describe, expect, it} from 'vitest';
import * as api from './index.js';

import {isEqual} from './equal.js';
import {observable, observableArray} from './observable.js';
import {
    Computation,
    computed,
    Dep,
    DepMap,
    effect,
    flushSync,
    trackingProxy,
    untracked
} from './graph.js';
import * as graph from './graph.js';

const SURFACE = [
    'Computation', 'Dep', 'DepMap',
    'computed', 'effect', 'flushSync', 'isEqual',
    'observable', 'observableArray', 'trackingProxy', 'untracked'
];

describe('public API', () => {
    it('exports exactly the intended surface', () => {
        expect(Object.keys(api).sort()).toEqual(SURFACE);
    });

    it('every export is callable or constructible', () => {
        for (const [name, value] of Object.entries(api)) {
            expect(typeof value, `${name} should be a function`).toBe('function');
        }
    });

    // ── Identity ─────────────────────────────────────────────────────────────
    // Without these, `export {effect as computed}` is an undetectable change:
    // the key list is identical and both values are functions.

    it('binds each name to the implementation it claims', () => {
        expect(api.isEqual, 'isEqual').toBe(isEqual);
        expect(api.observable, 'observable').toBe(observable);
        expect(api.observableArray, 'observableArray').toBe(observableArray);
        expect(api.Dep, 'Dep').toBe(Dep);
        expect(api.DepMap, 'DepMap').toBe(DepMap);
        expect(api.Computation, 'Computation').toBe(Computation);
        expect(api.computed, 'computed').toBe(computed);
        expect(api.effect, 'effect').toBe(effect);
        expect(api.untracked, 'untracked').toBe(untracked);
        expect(api.trackingProxy, 'trackingProxy').toBe(trackingProxy);
        expect(api.flushSync, 'flushSync').toBe(flushSync);
    });

    it('gives every name a distinct implementation', () => {
        // Catches any aliasing mutation the pairwise checks above might miss,
        // e.g. two names collapsed onto one function.
        const values = new Set(Object.values(api));
        expect(values.size).toBe(SURFACE.length);
    });

    // ── Deliberate omissions ─────────────────────────────────────────────────

    it('withholds the internals that graph.js exports', () => {
        // These exist upstream and are kept out on purpose (see index.js).
        // The assertion is two-sided: it fails if they leak into the surface,
        // and it fails if they vanish from graph.js — at which point the
        // rationale recorded in index.js has gone stale and needs revisiting.
        for (const internal of ['flush', 'drainPending', 'reactive']) {
            expect(graph[internal], `graph.js should still have ${internal}`).toBeDefined();
            expect(api, `${internal} should not be public`).not.toHaveProperty(internal);
        }
    });

    // ── Sufficiency for Domma ────────────────────────────────────────────────

    it('covers everything Domma imports at Tasks 9 and 10', () => {
        // src/models.js imports these six from ./reactive.js today.
        for (const name of ['DepMap', 'trackingProxy', 'computed', 'effect', 'untracked', 'flushSync']) {
            expect(api, `models.js needs ${name}`).toHaveProperty(name);
        }
        // src/component-factory.js imports these three.
        for (const name of ['computed', 'effect', 'untracked']) {
            expect(api, `component-factory.js needs ${name}`).toHaveProperty(name);
        }
    });

    // ── End to end ───────────────────────────────────────────────────────────

    it('composes into a working reactive graph through the public surface alone', () => {
        const count = api.observable(1);
        const doubled = api.computed(() => count.value * 2);
        const seen = [];
        const watcher = api.effect(() => seen.push(doubled.get()));

        expect(seen).toEqual([2]);

        count.set(5);
        api.flushSync();
        expect(seen).toEqual([2, 10]);

        // untracked reads must not enlist a new dependency.
        api.untracked(() => count.value);

        watcher.dispose();
        count.set(9);
        api.flushSync();
        expect(seen).toEqual([2, 10]);
    });
});
