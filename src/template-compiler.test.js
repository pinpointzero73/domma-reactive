// src/template-compiler.test.js
//
// Tier 3: fine-grained bindings. A structural change must re-render only its
// own block — everything else keeps its DOM node identity.
//
// ── On the renderer ──────────────────────────────────────────────────────────
// `compile()` takes the mustache renderer as a parameter; this package does not
// own one. In Domma the injected function is `utils.render`. Importing Domma
// here would make the package's own suite depend on its consumer, so these
// tests inject `render` from ./support/mini-render.js — a deliberately minimal
// stand-in supporting only the subset the compiler exercises: interpolation,
// triple-stache, {{#if}}, {{#unless}}, {{#each}}, {{#with}} and {{.}}.
//
// That substitution is the point rather than a compromise: it demonstrates the
// contract the compiler actually depends on. Anything these tests prove holds
// for any renderer meeting it.

import {beforeEach, describe, expect, it} from 'vitest';
import {annotate, compile, scanBlocks, TemplateCompiler} from './template-compiler.js';
import {render} from './support/mini-render.js';

describe('template-compiler - annotation', () => {

    it('gives adjacent interpolations separate, non-nested anchors', () => {
        const {annotated, bindings} = annotate('<p>{{a}}{{b}}</p>');

        expect(annotated).toContain('<span data-dm-t="0_txt">{{a}}</span>');
        expect(annotated).toContain('<span data-dm-t="1_txt">{{b}}</span>');
        expect(bindings).toHaveLength(2);
    });

    it('binds dynamic attributes, grouping several on one element', () => {
        const {bindings} = annotate('<div class="box {{cls}}" id="{{uid}}">x</div>');
        const attr = bindings.find(b => b.kind === 'attr');

        expect(attr).toBeDefined();
        expect([...attr.deps].sort()).toEqual(['cls', 'uid']);
        expect(attr.parts).toHaveLength(2);
    });

    it('does not bind interpolations inside context-shifting blocks', () => {
        // {{label}} resolves against the item, not the root — binding it to a
        // root field would resolve the wrong value.
        const {bindings} = annotate('{{#each items}}<li>{{label}}</li>{{/each}}{{count}}');

        expect(bindings.some(b => b.kind === 'text' && b.expr === 'label')).toBe(false);
        expect(bindings.some(b => b.kind === 'text' && b.expr === 'count')).toBe(true);
        expect(bindings.find(b => b.kind === 'block').deps).toEqual(new Set(['items']));
    });

    it('treats a triple-stache as its own re-rendered region', () => {
        const {bindings} = annotate('<p>{{{html}}}</p>');
        const raw = bindings.find(b => b.kind === 'raw');

        expect(raw).toBeDefined();
        expect(raw.deps).toEqual(new Set(['html']));
    });

    it('skips helper expressions it cannot resolve', () => {
        const {bindings} = annotate('<p>{{formatDate created}}</p>');
        expect(bindings).toHaveLength(0);
    });

    it('scans nested blocks at every depth', () => {
        const blocks = scanBlocks('{{#if a}}{{#each b}}x{{/each}}{{/if}}');
        expect(blocks.map(b => b.kind).sort()).toEqual(['each', 'if']);
    });

    it('ignores an unmatched closing token instead of throwing', () => {
        expect(() => annotate('{{/if}}<p>{{a}}</p>')).not.toThrow();
    });
});

// ── Runtime ──────────────────────────────────────────────────────────────────
// The annotation tests above are pure string work. These drive `compile()`
// against real DOM, which is what the binding machinery exists for. In Domma
// this surface is covered through the component factory; the package needs its
// own coverage because the factory stays behind.

describe('template-compiler - compiled bindings against the DOM', () => {

    let host;

    beforeEach(() => {
        document.body.replaceChildren();
        host = document.createElement('div');
        document.body.appendChild(host);
    });

    /** compile() with the stand-in renderer injected. */
    const build = (template, data) => compile(template, data, host, render);

    /** The id of the first binding of a given kind. */
    const idOf = (ctrl, kind) => ctrl.bindings.find(b => b.kind === kind).id;

    it('paints the template on compile', () => {
        build('<p id="greeting">{{name}}</p>', {name: 'alice'});

        expect(host.querySelector('#greeting').textContent).toBe('alice');
    });

    it('updates a text binding without replacing surrounding nodes', () => {
        const ctrl = build('<p id="keep">static</p><b>{{name}}</b>', {name: 'alice'});
        const keep = host.querySelector('#keep');

        expect(host.textContent).toContain('alice');

        expect(ctrl.update(idOf(ctrl, 'text'), {name: 'bob'})).toBe(true);

        expect(host.textContent).toContain('bob');
        expect(host.textContent).not.toContain('alice');
        // The untouched paragraph is the SAME node, not a re-created one.
        expect(host.querySelector('#keep')).toBe(keep);
    });

    it('renders a null or undefined text value as an empty string', () => {
        const ctrl = build('<b>{{name}}</b>', {name: 'alice'});
        const anchor = host.querySelector('[data-dm-t]');

        ctrl.update(idOf(ctrl, 'text'), {name: null});
        expect(anchor.textContent).toBe('');

        ctrl.update(idOf(ctrl, 'text'), {name: undefined});
        expect(anchor.textContent).toBe('');
    });

    it('updates a dynamic attribute in place, keeping the element identity', () => {
        const ctrl = build(
            '<div id="box" class="card {{tone}}"><p id="body">{{text}}</p></div>',
            {tone: 'is-quiet', text: 'hi'}
        );

        const box = host.querySelector('#box');
        const body = host.querySelector('#body');
        expect(box.getAttribute('class')).toBe('card is-quiet');

        ctrl.update(idOf(ctrl, 'attr'), {tone: 'is-loud', text: 'hi'});

        expect(box.getAttribute('class')).toBe('card is-loud');
        expect(host.querySelector('#box')).toBe(box);
        expect(host.querySelector('#body')).toBe(body);
    });

    it('keeps the live value property in step for form controls', () => {
        // setAttribute alone does not move a rendered input's current value.
        const ctrl = build('<input id="field" value="{{v}}">', {v: 'one'});
        const field = host.querySelector('#field');

        ctrl.update(idOf(ctrl, 'attr'), {v: 'two'});

        expect(field.getAttribute('value')).toBe('two');
        expect(field.value).toBe('two');
    });

    it('renders a block region and preserves DOM identity outside it', () => {
        const ctrl = build(
            '<p id="keep">{{label}}</p>{{#if open}}<span id="panel">P</span>{{/if}}',
            {label: 'hello', open: false}
        );

        const keep = host.querySelector('#keep');
        expect(host.querySelector('#panel')).toBeNull();

        ctrl.update(idOf(ctrl, 'block'), {label: 'hello', open: true});

        expect(host.querySelector('#panel')).not.toBeNull();
        // Under a full-re-render strategy this assertion fails.
        expect(host.querySelector('#keep')).toBe(keep);
    });

    it('keeps user input across a structural change', () => {
        const ctrl = build(
            '<input id="field"><b>{{n}}</b>{{#if big}}<i id="flag">big</i>{{/if}}',
            {n: 1, big: false}
        );

        host.querySelector('#field').value = 'typed by the user';

        ctrl.update(idOf(ctrl, 'block'), {n: 1, big: true});

        expect(host.querySelector('#flag')).not.toBeNull();
        // A full re-render would have destroyed this input and its value.
        expect(host.querySelector('#field').value).toBe('typed by the user');
    });

    it('re-renders an each block when its collection changes', () => {
        const ctrl = build(
            '<ul>{{#each items}}<li>{{.}}</li>{{/each}}</ul><p id="keep">static</p>',
            {items: ['a']}
        );

        const keep = host.querySelector('#keep');
        expect(host.querySelectorAll('li')).toHaveLength(1);

        ctrl.update(idOf(ctrl, 'block'), {items: ['a', 'b', 'c']});

        expect(host.querySelectorAll('li')).toHaveLength(3);
        expect(host.textContent).toContain('c');
        expect(host.querySelector('#keep')).toBe(keep);
    });

    it('re-indexes so a binding inside a newly rendered block becomes live', () => {
        const ctrl = build('{{#if shown}}<b>{{name}}</b>{{/if}}', {shown: false, name: 'alice'});
        const textId = idOf(ctrl, 'text');

        // Not rendered yet: the binding holds no nodes and writes nothing.
        expect(ctrl.update(textId, {shown: false, name: 'alice'})).toBe(false);
        expect(host.textContent).not.toContain('alice');

        ctrl.update(idOf(ctrl, 'block'), {shown: true, name: 'alice'});
        expect(host.textContent).toContain('alice');

        // The nested binding must be live now that its block exists.
        expect(ctrl.update(textId, {shown: true, name: 'bob'})).toBe(true);
        expect(host.textContent).toContain('bob');
    });

    it('renders a triple-stache region as markup and replaces it on update', () => {
        const ctrl = build('<div>{{{markup}}}</div>', {markup: '<em id="a">one</em>'});

        expect(host.querySelector('#a')).not.toBeNull();

        ctrl.update(idOf(ctrl, 'raw'), {markup: '<strong id="b">two</strong>'});

        expect(host.querySelector('#b')).not.toBeNull();
        expect(host.querySelector('#a')).toBeNull();
    });

    it('escapes interpolated data but not a triple-stache', () => {
        // The trust model in template-compiler.js rests on this split.
        build('<p id="esc">{{a}}</p><div id="raw">{{{b}}}</div>', {
            a: '<em>x</em>',
            b: '<em>y</em>'
        });

        expect(host.querySelector('#esc em')).toBeNull();
        expect(host.querySelector('#esc').textContent).toBe('<em>x</em>');
        expect(host.querySelector('#raw em')).not.toBeNull();
    });

    it('reports the dependencies of each binding', () => {
        const ctrl = build('<div class="{{tone}}">{{name}}</div>', {tone: 't', name: 'n'});

        expect(ctrl.deps(idOf(ctrl, 'text'))).toEqual(new Set(['name']));
        expect(ctrl.deps(idOf(ctrl, 'attr'))).toEqual(new Set(['tone']));
        expect(ctrl.deps('no-such-binding')).toEqual(new Set());
    });

    it('updateAll refreshes every binding at once', () => {
        const ctrl = build('<div class="{{tone}}"><b>{{name}}</b></div>', {tone: 'a', name: 'x'});

        ctrl.updateAll({tone: 'b', name: 'y'});

        expect(host.querySelector('div').getAttribute('class')).toBe('b');
        expect(host.textContent).toContain('y');
    });

    it('rerenderAll repaints from scratch, discarding node identity', () => {
        const ctrl = build('<p id="keep">{{name}}</p>', {name: 'alice'});
        const keep = host.querySelector('#keep');

        ctrl.rerenderAll({name: 'bob'});

        expect(host.textContent).toContain('bob');
        // This is the escape hatch, so losing identity here is the contract.
        expect(host.querySelector('#keep')).not.toBe(keep);
    });
});

describe('template-compiler - the TemplateCompiler namespace', () => {

    it('carries the named exports plus resolvePath', () => {
        expect(TemplateCompiler.annotate).toBe(annotate);
        expect(TemplateCompiler.compile).toBe(compile);
        expect(TemplateCompiler.scanBlocks).toBe(scanBlocks);
        // resolvePath is reachable ONLY through this object — there is no
        // named export for it. If that ever changes, this test should too.
        expect(typeof TemplateCompiler.resolvePath).toBe('function');
    });

    it('resolves a dotted path and stops at a missing link', () => {
        const {resolvePath} = TemplateCompiler;

        expect(resolvePath({user: {email: 'a@b.c'}}, 'user.email')).toBe('a@b.c');
        expect(resolvePath({user: null}, 'user.email')).toBeUndefined();
        expect(resolvePath({}, 'nope')).toBeUndefined();
    });
});
