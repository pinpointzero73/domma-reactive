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
import {annotate, compile, scanBlocks, TemplateCompiler} from './template-compiler.js';

const SURFACE = [
    'Computation', 'Dep', 'DepMap', 'TemplateCompiler',
    'annotate', 'compile', 'computed', 'effect', 'flushSync', 'isEqual',
    'observable', 'observableArray', 'scanBlocks', 'trackingProxy', 'untracked'
];

/**
 * The one export that is not a function. `TemplateCompiler` is a namespace
 * object grouping the compiler's three named exports plus `resolvePath`, which
 * has no named export of its own. It is listed here rather than special-cased
 * inline so that a SECOND non-function export cannot slip in unnoticed.
 */
const NAMESPACE_EXPORTS = ['TemplateCompiler'];

describe('public API', () => {
    it('exports exactly the intended surface', () => {
        expect(Object.keys(api).sort()).toEqual(SURFACE);
    });

    it('every export is callable, constructible, or a namespace of those', () => {
        for (const [name, value] of Object.entries(api)) {
            if (NAMESPACE_EXPORTS.includes(name)) {
                // A namespace earns its exemption only by being a plain object
                // whose every member is itself callable — an empty object or
                // one carrying data would still fail here.
                expect(typeof value, `${name} should be an object`).toBe('object');
                expect(Object.keys(value).length, `${name} should not be empty`).toBeGreaterThan(0);
                for (const [member, fn] of Object.entries(value)) {
                    expect(typeof fn, `${name}.${member} should be a function`).toBe('function');
                }
                continue;
            }
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
        expect(api.annotate, 'annotate').toBe(annotate);
        expect(api.compile, 'compile').toBe(compile);
        expect(api.scanBlocks, 'scanBlocks').toBe(scanBlocks);
        expect(api.TemplateCompiler, 'TemplateCompiler').toBe(TemplateCompiler);
    });

    it('binds the TemplateCompiler namespace to the same functions it exports', () => {
        // The namespace is a second route to three of the names above. If the
        // two routes ever diverge, a caller reaching through the object gets
        // different behaviour from one importing the named export — and the
        // pairwise checks above cannot see it, because they only test the
        // object's identity, never its contents.
        expect(api.TemplateCompiler.annotate, 'TemplateCompiler.annotate').toBe(api.annotate);
        expect(api.TemplateCompiler.compile, 'TemplateCompiler.compile').toBe(api.compile);
        expect(api.TemplateCompiler.scanBlocks, 'TemplateCompiler.scanBlocks').toBe(api.scanBlocks);

        // resolvePath is reachable ONLY here. If it ever gains a named export,
        // SURFACE must grow and this comment is wrong.
        expect(typeof api.TemplateCompiler.resolvePath).toBe('function');
        expect(api, 'resolvePath should not be a named export').not.toHaveProperty('resolvePath');
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
        // src/component-factory.js imports these three from the package, plus
        // TemplateCompiler, which used to be a local file in Domma.
        for (const name of ['computed', 'effect', 'untracked', 'TemplateCompiler']) {
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

    it('drives a compiled binding from an observable, through the surface alone', () => {
        // The two halves of the package are only worth shipping together if
        // they compose: the graph decides WHEN to update, the compiler decides
        // WHAT. Nothing else in either suite crosses that seam.
        const host = document.createElement('div');
        document.body.appendChild(host);

        const name = api.observable('alice');

        // A renderer is the caller's to supply — the package has none.
        const stubRender = (tmpl, data) => tmpl.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) => data[k] ?? '');

        const ctrl = api.compile('<b>{{name}}</b>', {name: name.value}, host, stubRender);
        const textId = ctrl.bindings.find(b => b.kind === 'text').id;

        api.effect(() => ctrl.update(textId, {name: name.value}));
        expect(host.textContent).toBe('alice');

        name.set('bob');
        api.flushSync();
        expect(host.textContent).toBe('bob');

        host.remove();
    });
});
