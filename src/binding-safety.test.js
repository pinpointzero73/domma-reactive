/**
 * Bindings fail closed.
 *
 * Two silent failures reported from a real port, both of which showed content
 * that was meant to be hidden:
 *
 *   - a read binding whose expression resolves to a bare observable
 *     (`data-if="show"` with `show = observable(false)`) - an object is truthy,
 *     so the content rendered. Now: one warning naming the fix, and the value
 *     reads as empty - hidden, off, no text.
 *   - a virtual `<!-- dm if -->` inside a virtual list's body - warned, then
 *     rendered its content in every row. Now: warned and left out.
 *
 * And the one nice-to-have from the same report: object and array literals in
 * expressions.
 */

import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {applyBindings, resetApplyWarnings} from './apply-bindings.js';
import {compile} from './template-compiler.js';
import {computed, flushSync} from './graph.js';
import {observable, observableArray} from './observable.js';
import {isReactive} from './brand.js';
import {
    evaluateExpression,
    expressionDependencies,
    parseExpression,
    registerHelper,
    unregisterHelper
} from './expression.js';

let host;
let warn;

beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    resetApplyWarnings();
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
    host.remove();
    warn.mockRestore();
});

const warnings = (fragment) => warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes(fragment));

// ── The brand ─────────────────────────────────────────────────────────────────

describe('isReactive', () => {
    it('knows observables, arrays and computeds, and nothing else', () => {
        expect(isReactive(observable(1))).toBe(true);
        expect(isReactive(observableArray([]))).toBe(true);
        expect(isReactive(computed(() => 1))).toBe(true);
        for (const other of [null, undefined, 0, '', {}, [], {value: 1}, () => 1]) {
            expect(isReactive(other)).toBe(false);
        }
    });

    it('is invisible to spreading and JSON', () => {
        const obs = observable(1);
        expect(Object.keys(obs)).not.toContain(String(Symbol.for('domma-reactive.reactive')));
        expect(JSON.stringify({...observableArray([1])}).includes('domma-reactive')).toBe(false);
    });
});

// ── A bare observable in a read binding ───────────────────────────────────────

describe('a read binding given a bare observable', () => {
    it('data-if="show" with show = observable(false) is hidden, with one warning', () => {
        host.innerHTML = '<p data-if="show">SECRET</p>';
        const show = observable(false);
        const handle = applyBindings({show}, host);

        expect(host.textContent).not.toContain('SECRET');
        show.value = true;
        flushSync();
        expect(host.textContent).not.toContain('SECRET');   // still wrong, still closed

        const hits = warnings('"show"');
        expect(hits).toHaveLength(1);
        expect(hits[0]).toContain('use "show.value"');

        handle.dispose();
    });

    it('data-if="show.value" works and says nothing', () => {
        host.innerHTML = '<p data-if="show.value">SHOWN</p>';
        const show = observable(false);
        const handle = applyBindings({show}, host);

        expect(host.textContent).not.toContain('SHOWN');
        show.value = true;
        flushSync();
        expect(host.textContent).toContain('SHOWN');
        expect(warnings('is an observable')).toHaveLength(0);

        handle.dispose();
    });

    it('fails closed on hidden, disabled and class bindings too', () => {
        host.innerHTML = `
            <button data-bind-disabled="busy">Go</button>
            <b data-bind-hidden="gone">x</b>
            <i data-bind-class="active && 'on'">y</i>`;
        const handle = applyBindings({busy: observable(true), gone: observable(true), active: observable(true)}, host);

        expect(host.querySelector('button').disabled).toBe(false);
        expect(host.querySelector('b').hidden).toBe(false);
        expect(host.querySelector('i').classList.contains('on')).toBe(false);
        expect(warnings('is an observable')).toHaveLength(3);   // busy, gone, and active inside `&&`

        handle.dispose();
    });

    it('fails closed through negation and comparison: the whole expression is empty', () => {
        host.innerHTML = '<p data-if="!show">NEGATED</p><p data-if="count > 3">BIG</p>';
        const handle = applyBindings({show: observable(false), count: observable(10)}, host);

        expect(host.textContent).not.toContain('NEGATED');
        expect(host.textContent).not.toContain('BIG');
        expect(warnings('is an observable used in an expression')).toHaveLength(2);

        handle.dispose();
    });

    it('writes nothing, not "[object Object]", for text and attributes', () => {
        host.innerHTML = '<span data-bind-text="name">x</span><a data-bind-title="name">y</a>';
        const handle = applyBindings({name: observable('Ada')}, host);

        expect(host.querySelector('span').textContent).toBe('');
        expect(host.innerHTML).not.toContain('[object Object]');

        handle.dispose();
    });

    it('treats a bare computed the same way', () => {
        host.innerHTML = '<p data-if="ready">READY</p>';
        const handle = applyBindings({ready: computed(() => true)}, host);

        expect(host.textContent).not.toContain('READY');
        expect(warnings('"ready"')).toHaveLength(1);

        handle.dispose();
    });

    it('applies to compiled templates: {{#if show}} and {{name}}', () => {
        compile('<div>{{#if show}}SECRET{{/if}}<span>{{name}}</span></div>',
            {show: observable(false), name: observable('Ada')}, host);

        expect(host.textContent).not.toContain('SECRET');
        expect(host.innerHTML).not.toContain('[object Object]');
    });

    it('still accepts an observableArray directly as a keyed list', () => {
        host.innerHTML = '<ul data-each="rows key=id"><li data-bind-text="name"></li></ul>';
        const rows = observableArray([{id: 1, name: 'a'}]);
        const handle = applyBindings({rows}, host);

        expect(host.querySelector('li').textContent).toBe('a');
        expect(warnings('is an observable')).toHaveLength(0);

        handle.dispose();
    });

    it('leaves event bindings alone', () => {
        host.innerHTML = '<button data-on-click="go">Go</button>';
        const go = vi.fn();
        const handle = applyBindings({go}, host);

        host.querySelector('button').click();
        expect(go).toHaveBeenCalledTimes(1);
        expect(warnings('is an observable')).toHaveLength(0);

        handle.dispose();
    });
});

// ── Virtual control flow inside a virtual list body ───────────────────────────

describe('a virtual block inside a virtual list body', () => {
    it('is left out of every row, with a warning naming {{#if}}', () => {
        host.innerHTML = '<ul><!-- dm each: rows key=id --><li><span data-bind-text="name"></span>' +
            '<!-- dm if: flag -->INNER<!-- /dm --></li><!-- /dm --></ul>';
        const rows = [{id: 1, name: 'A', flag: false}, {id: 2, name: 'B', flag: false}];
        const handle = applyBindings({rows}, host);

        expect(host.textContent).toContain('A');
        expect(host.textContent).toContain('B');
        expect(host.textContent).not.toContain('INNER');

        const hits = warnings('inside a virtual list');
        expect(hits).toHaveLength(1);
        expect(hits[0]).toContain('{{#if}}');

        handle.dispose();
    });

    it('the supported spelling, {{#if flag}} in the body, works per row', () => {
        host.innerHTML = '<ul><!-- dm each: rows key=id --><li>{{name}}{{#if flag}} INNER{{/if}}</li><!-- /dm --></ul>';
        const rows = [{id: 1, name: 'A', flag: false}, {id: 2, name: 'B', flag: true}];
        const handle = applyBindings({rows}, host);

        const items = [...host.querySelectorAll('li')].map((li) => li.textContent.trim());
        expect(items).toEqual(['A', 'B INNER']);

        handle.dispose();
    });
});

// ── Object and array literals ─────────────────────────────────────────────────

describe('object and array literals in expressions', () => {
    afterEach(() => unregisterHelper('obj'));

    it('obj({a:1}) parses and evaluates', () => {
        registerHelper('obj', (o) => o);
        expect(parseExpression('obj({a:1})')).not.toBeNull();
        expect(evaluateExpression('obj({a:1})', {})).toEqual({a: 1});
    });

    it('takes name and string keys and any expression as a value', () => {
        expect(evaluateExpression("{a: x + 1, 'b-c': y ? 'yes' : 'no'}", {x: 1, y: true}))
            .toEqual({a: 2, 'b-c': 'yes'});
        expect(evaluateExpression('{}', {})).toEqual({});
    });

    it('builds arrays, nested either way', () => {
        expect(evaluateExpression('[1, x, [y], {z: z}]', {x: 2, y: 3, z: 4})).toEqual([1, 2, [3], {z: 4}]);
        expect(evaluateExpression('[]', {})).toEqual([]);
        expect(evaluateExpression('[a, b][1]', {a: 'first', b: 'second'})).toBe('second');
    });

    it('returns a fresh value every time', () => {
        const a = evaluateExpression('{k: 1}', {});
        const b = evaluateExpression('{k: 1}', {});
        expect(a).not.toBe(b);
    });

    it('tracks the names used in values, not the keys', () => {
        expect([...expressionDependencies('{colour: tone, size: [big, small]}')].sort())
            .toEqual(['big', 'small', 'tone']);
    });

    it.each([
        ['a blocked key', '{__proto__: 1}', 'the key "__proto__" is not allowed'],
        ['a quoted blocked key', "{'constructor': 1}", 'the key "constructor" is not allowed'],
        ['a computed key', '{[k]: 1}', 'computed keys are not supported'],
        ['shorthand', '{a}', 'shorthand properties are not supported'],
        ['a method', '{a() {}}', 'methods are not supported'],
        ['spread in an object', '{...a}', 'spread is not supported'],
        ['a trailing comma in an object', '{a: 1,}', 'trailing comma'],
        ['a trailing comma in an array', '[1,]', 'trailing comma'],
        ['a hole', '[1,,2]', 'unexpected'],
        ['a missing colon', '{a 1}', 'expected ":"'],
        ['an unclosed object', '{a: 1', 'expected "}"'],
        ['an unclosed array', '[1', 'expected "]"']
    ])('refuses %s with a positioned message', (_, source, message) => {
        expect(parseExpression(source)).toBeNull();
        const hit = warn.mock.calls.map((c) => String(c[0])).find((m) => m.includes(source));
        expect(hit).toContain(message);
        expect(hit).toMatch(/at position \d+/);
    });

    it('cannot pollute a prototype through a literal', () => {
        evaluateExpression("{'__proto__': {polluted: 1}}", {});
        expect({}.polluted).toBeUndefined();
    });
});
