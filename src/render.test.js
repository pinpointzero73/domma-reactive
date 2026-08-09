/**
 * The default renderer.
 *
 * Two things are under test, and they pull in opposite directions.
 *
 *   PARITY     A template written for Domma's `utils.render` must render the
 *              same here, because `compile()` now uses this by default and a
 *              consumer moving between the two must not be surprised.
 *   DIVERGENCE Where this one is deliberately better — same-kind block nesting,
 *              full expressions in `{{ }}` — the difference is asserted rather
 *              than left to a README claim nobody checks.
 *
 * The parity expectations below are the output of Domma's actual `utils.render`
 * at v0.33.1, verified out of band. They are written as literals rather than
 * computed by importing Domma, because a package taking a dependency on its own
 * consumer to test itself is a circle, not a suite.
 */

import {describe, expect, it, vi} from 'vitest';
import {render, truthy} from './render.js';
import {clearExpressionCache, registerHelper, unregisterHelper} from './expression.js';

describe('interpolation', () => {
    it('substitutes a name and a dotted path', () => {
        expect(render('{{a}}', {a: 1})).toBe('1');
        expect(render('{{ user.email }}', {user: {email: 'a@b.c'}})).toBe('a@b.c');
    });

    it('renders a missing value as nothing, not as "undefined"', () => {
        expect(render('[{{missing}}]', {})).toBe('[]');
        expect(render('[{{a.b.c}}]', {a: {}})).toBe('[]');
        expect(render('[{{n}}]', {n: null})).toBe('[]');
    });

    it('renders 0 and false, which are values and not absences', () => {
        expect(render('{{n}}', {n: 0})).toBe('0');
        expect(render('{{b}}', {b: false})).toBe('false');
    });

    it('escapes {{ }} and does not escape {{{ }}}', () => {
        const data = {html: '<b>&"\'</b>'};
        expect(render('{{html}}', data)).toBe('&lt;b&gt;&amp;&quot;&#39;&lt;/b&gt;');
        expect(render('{{{html}}}', data)).toBe('<b>&"\'</b>');
    });

    it('strips comments and passes unrelated braces through', () => {
        expect(render('a{{! never seen }}b', {})).toBe('ab');
        expect(render('{ not a token }', {})).toBe('{ not a token }');
    });

    it('leaves an empty or non-string template alone', () => {
        expect(render('', {})).toBe('');
        expect(render(null, {})).toBe('');
        expect(render(undefined)).toBe('');
    });
});

describe('blocks', () => {
    it('renders {{#if}} on truthiness, with {{else}}', () => {
        expect(render('{{#if ok}}y{{/if}}', {ok: true})).toBe('y');
        expect(render('{{#if ok}}y{{/if}}', {ok: false})).toBe('');
        expect(render('{{#if ok}}y{{else}}n{{/if}}', {ok: false})).toBe('n');
        expect(render('{{#if ok}}y{{else}}n{{/if}}', {ok: true})).toBe('y');
    });

    it('treats an empty array as falsy, mustache-style', () => {
        expect(render('{{#if xs}}y{{else}}n{{/if}}', {xs: []})).toBe('n');
        expect(render('{{#if xs}}y{{else}}n{{/if}}', {xs: [1]})).toBe('y');
        expect(truthy([])).toBe(false);
        expect(truthy([0])).toBe(true);
    });

    it('renders {{#unless}} as the inverse, and takes no else', () => {
        expect(render('{{#unless ok}}n{{/unless}}', {ok: false})).toBe('n');
        expect(render('{{#unless ok}}n{{/unless}}', {ok: true})).toBe('');
    });

    it('renders {{#each}} with . @index @first @last', () => {
        expect(render('{{#each xs}}[{{.}}:{{@index}}]{{/each}}', {xs: ['a', 'b']}))
            .toBe('[a:0][b:1]');
        expect(render('{{#each xs}}{{#if @first}}F{{/if}}{{#if @last}}L{{/if}}{{/each}}', {xs: [1, 2]}))
            .toBe('FL');
    });

    it('renders object items with their own fields in scope', () => {
        expect(render('{{#each xs}}{{name}};{{/each}}', {xs: [{name: 'a'}, {name: 'b'}]}))
            .toBe('a;b;');
    });

    it('renders nothing for a non-array {{#each}}', () => {
        expect(render('{{#each xs}}x{{/each}}', {xs: 'nope'})).toBe('');
        expect(render('{{#each xs}}x{{/each}}', {})).toBe('');
    });

    it('shifts context with {{#with}}, and renders nothing for a non-object', () => {
        expect(render('{{#with u}}{{name}}{{/with}}', {u: {name: 'Ada'}})).toBe('Ada');
        expect(render('{{#with u}}{{name}}{{/with}}', {u: null})).toBe('');
        expect(render('{{#with u}}x{{/with}}', {u: 'string'})).toBe('');
    });

    it('renders text either side of a block, and consecutive blocks', () => {
        expect(render('a{{#if ok}}b{{/if}}c{{#if ok}}d{{/if}}e', {ok: true})).toBe('abcde');
    });

    it('expands {{> partial}}, and renders nothing when there is none', () => {
        expect(render('[{{> row}}]', {n: 1}, {partials: {row: '<i>{{n}}</i>'}}))
            .toBe('[<i>1</i>]');
        expect(render('[{{> row}}]', {})).toBe('[]');
    });

    it('renders an unmatched opener as text rather than throwing', () => {
        expect(() => render('{{#if ok}}dangling', {ok: true})).not.toThrow();
        expect(render('{{#if ok}}dangling', {ok: true})).toBe('{{#if ok}}dangling');
    });
});

describe('nesting', () => {
    it('nests blocks of DIFFERENT kinds', () => {
        expect(render('{{#if ok}}{{#each xs}}{{.}}{{/each}}{{/if}}', {ok: true, xs: [1, 2]}))
            .toBe('12');
    });

    it('nests blocks of the SAME kind — the divergence from Domma', () => {
        // Domma's utils.render matches `{{#each …}}([\s\S]*?){{/each}}`
        // non-greedily, so the outer loop's body stops at the INNER {{/each}}
        // and the template falls apart. Counting depth is what fixes it.
        const template = '{{#each rows}}<tr>{{#each cells}}<td>{{.}}</td>{{/each}}</tr>{{/each}}';
        const data = {rows: [{cells: ['a', 'b']}, {cells: ['c']}]};

        expect(render(template, data))
            .toBe('<tr><td>a</td><td>b</td></tr><tr><td>c</td></tr>');
    });

    it('binds {{else}} to its own {{#if}}, not to an enclosing one', () => {
        const template = '{{#if a}}{{#if b}}AB{{else}}A{{/if}}{{else}}none{{/if}}';

        expect(render(template, {a: true, b: true})).toBe('AB');
        expect(render(template, {a: true, b: false})).toBe('A');
        expect(render(template, {a: false, b: true})).toBe('none');
    });

    it('renders {{.}} as the item — Domma renders the item CONTEXT', () => {
        // Verified against utils.render at v0.33.1: for a list of primitives it
        // produces "[object Object][object Object][object Object]", because its
        // getValue treats `.` as the whole data object and the item context it
        // builds for a primitive is `{'.': item, '@index': …}`. This renderer
        // reaches into `'.'`, which is what every mustache implementation does.
        //
        // A divergence, and an improvement — but it IS a divergence, so a
        // template relying on Domma's output would see different text here.
        expect(render('{{#each xs}}{{.}}{{/each}}', {xs: [1, 2, 3]})).toBe('123');
        expect(render('{{#if a}}{{#each xs}}{{.}}{{/each}}{{/if}}', {a: 1, xs: [7]})).toBe('7');
    });

    it('nests to depth without losing $-free item scope', () => {
        const template = '{{#each groups}}{{title}}:{{#each items}}{{.}},{{/each}};{{/each}}';
        const data = {groups: [{title: 'g1', items: [1, 2]}, {title: 'g2', items: [3]}]};

        expect(render(template, data)).toBe('g1:1,2,;g2:3,;');
    });
});

describe('expressions in {{ }} — the other divergence', () => {
    it('evaluates a ternary, a comparison and a helper call', () => {
        registerHelper('upper', (s) => String(s).toUpperCase());

        expect(render("{{ n > 1 ? 'many' : 'one' }}", {n: 3})).toBe('many');
        expect(render("{{ n > 1 ? 'many' : 'one' }}", {n: 1})).toBe('one');
        expect(render('{{ upper(name) }}', {name: 'ada'})).toBe('ADA');
        expect(render('{{ a + b }}', {a: 2, b: 3})).toBe('5');

        unregisterHelper('upper');
        clearExpressionCache();
    });

    it('takes an expression as a block condition', () => {
        expect(render('{{#if n > 2}}big{{else}}small{{/if}}', {n: 5})).toBe('big');
        expect(render('{{#if n > 2}}big{{else}}small{{/if}}', {n: 1})).toBe('small');
    });

    it('escapes the RESULT of an expression, like any other value', () => {
        expect(render("{{ ok ? tag : '' }}", {ok: true, tag: '<b>'})).toBe('&lt;b&gt;');
    });

    it('resolves a kebab-case key as a key, not as a subtraction', () => {
        // The key-lookup fallback exists for exactly this. `first-name` is a
        // legitimate data key and `{{first-name}}` must not become NaN.
        expect(render('{{first-name}}', {'first-name': 'Ada'})).toBe('Ada');
        expect(render('{{ a - b }}', {a: 5, b: 2})).toBe('3');
    });

    it('warns once and renders nothing for an expression that will not parse', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        clearExpressionCache();

        expect(render('[{{ a ==== b }}]', {})).toBe('[]');
        expect(warn).toHaveBeenCalledTimes(1);

        warn.mockRestore();
        clearExpressionCache();
    });
});

describe('parity with Domma utils.render', () => {
    /*
     * Each case below is a template plus the string Domma's utils.render
     * produces for it at v0.33.1. The suite asserts this renderer agrees. A
     * change here that broke a real Domma template would fail on the row that
     * covers it.
     */
    const cases = [
        ['{{a}}', {a: 'x'}, 'x'],
        ['{{a.b}}', {a: {b: 'x'}}, 'x'],
        ['{{missing}}', {}, ''],
        ['{{{h}}}', {h: '<b>'}, '<b>'],
        ['{{h}}', {h: '<b>'}, '&lt;b&gt;'],
        ['{{#if a}}y{{/if}}', {a: 1}, 'y'],
        ['{{#if a}}y{{else}}n{{/if}}', {a: 0}, 'n'],
        ['{{#if a}}y{{else}}n{{/if}}', {a: []}, 'n'],
        ['{{#unless a}}n{{/unless}}', {a: 0}, 'n'],
        ['{{#each xs}}{{@index}}{{/each}}', {xs: ['a', 'b']}, '01'],
        ['{{#each xs}}{{@first}}{{/each}}', {xs: [1, 2]}, 'truefalse'],
        ['{{#each xs}}{{name}}|{{/each}}', {xs: [{name: 'a'}, {name: 'b'}]}, 'a|b|'],
        ['{{#each xs}}x{{/each}}', {xs: []}, ''],
        ['{{#each xs}}{{#if @first}}F{{/if}}{{#if @last}}L{{/if}}{{/each}}', {xs: [1, 2]}, 'FL'],
        ['{{#with u}}{{n}}{{/with}}', {u: {n: 5}}, '5'],
        ['{{#with u}}{{n}}{{/with}}', {u: null}, ''],
        ['a{{b}}c', {b: '-'}, 'a-c'],
        ['{{first-name}}', {'first-name': 'Ada'}, 'Ada'],
        ['{{upper name}}', {name: 'ada'}, '']
    ];

    it.each(cases)('renders %s the same as Domma does', (template, data, expected) => {
        expect(render(template, data)).toBe(expected);
    });

    it('does NOT support Domma\'s space-separated helper form, and says nothing', () => {
        // `{{upper name}}` is a helper call to Domma's renderer, and neither a
        // key nor a parseable expression here. It renders as nothing, which is
        // what utils.render itself produces when the helper is not registered —
        // and it does so WITHOUT a warning, because warning about a template
        // that works elsewhere would be noise. Use `upper(name)` instead.
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        clearExpressionCache();

        expect(render('[{{upper name}}]', {name: 'ada'})).toBe('[]');
        expect(warn).not.toHaveBeenCalled();

        warn.mockRestore();
        clearExpressionCache();
    });
});

// ── Items marked destroyed ────────────────────────────────────────────────────
//
// `observableArray.destroy(item)` leaves the item in the collection carrying
// `_destroy: true`, so a form can still submit it to a server that deletes on
// that flag. A renderer that showed it anyway would put rows on screen the user
// believes they have deleted, so both render paths skip it — here, and in the
// keyed reconciler.

describe('render - destroyed items', () => {
    it('skips an item marked _destroy', () => {
        const data = {rows: [{name: 'Ada'}, {name: 'Grace', _destroy: true}, {name: 'Katherine'}]};
        expect(render('{{#each rows}}[{{name}}]{{/each}}', data)).toBe('[Ada][Katherine]');
    });

    it('renumbers @index and @last around the gap', () => {
        const data = {rows: [{n: 'a'}, {n: 'b', _destroy: true}, {n: 'c'}]};
        expect(render('{{#each rows}}{{@index}}{{n}}{{#if @last}}!{{/if}}{{/each}}', data))
            .toBe('0a1c!');
    });

    it('renders an all-destroyed collection as empty', () => {
        const data = {rows: [{n: 'a', _destroy: true}]};
        expect(render('{{#each rows}}[{{n}}]{{/each}}', data)).toBe('');
    });

    it('leaves a falsy _destroy alone', () => {
        const data = {rows: [{n: 'a', _destroy: false}]};
        expect(render('{{#each rows}}[{{n}}]{{/each}}', data)).toBe('[a]');
    });

    it('does not copy the array when nothing is destroyed', () => {
        // The filter is the cost every list would otherwise pay for a feature
        // most pages never use, so it runs only when something is marked.
        const rows = [{n: 'a'}, {n: 'b'}];
        const seen = [];
        const proxied = new Proxy(rows, {
            get(t, k) {
                if (k === 'filter') seen.push('filter');
                return Reflect.get(t, k);
            }
        });

        render('{{#each rows}}{{n}}{{/each}}', {rows: proxied});
        expect(seen).toEqual([]);
    });
});
