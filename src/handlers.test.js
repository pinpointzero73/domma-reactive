/**
 * The binding registry and the eight handlers in it.
 *
 * These tests drive bindings through `compile()` rather than calling handlers
 * directly, because a handler that works in isolation and is never reached by
 * the compiler is worth nothing. Design spec §9 puts it plainly: assert the
 * RENDERED STATE, not the API state.
 *
 * The registry itself is module-global, so anything that registers a custom
 * binding unregisters it again. A leaked registration would change how a later
 * test's template compiles.
 */

import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {compile} from './template-compiler.js';
import {
    BUILT_IN_BINDINGS,
    bindingHandler,
    claimAttribute,
    registerBinding,
    resolveWriteTarget,
    unregisterBinding
} from './handlers.js';
import {createChildContext, createRootContext} from './context.js';
import {parseExpression, clearExpressionCache} from './expression.js';
import {observable} from './observable.js';

let host;

beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
});

afterEach(() => {
    host.remove();
    clearExpressionCache();
});

/** Fire an event the way a browser would, so a listener actually sees it. */
function fire(el, type) {
    el.dispatchEvent(new window.Event(type, {bubbles: true, cancelable: true}));
}

// ── The registry ──────────────────────────────────────────────────────────────

describe('the registry', () => {
    it('holds every built-in, each with an update function', () => {
        for (const name of BUILT_IN_BINDINGS) {
            const handler = bindingHandler(name);
            expect(handler, `${name} should be registered`).toBeDefined();
            expect(typeof handler.update, `${name}.update`).toBe('function');
        }
    });

    it('registered the built-ins through the PUBLIC function', () => {
        // §8 requires the built-ins to use the same mechanism registerBinding()
        // offers. If they took a private path, replacing one would not warn —
        // because the warning lives in registerBinding, and a private path
        // would not have put them in the map it checks.
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const original = bindingHandler('text');

        registerBinding('text', {update: () => true});
        expect(warn).toHaveBeenCalledWith(
            expect.stringContaining('"text" replaces an existing binding handler')
        );

        registerBinding('text', original);
        warn.mockRestore();
    });

    it('refuses a handler it cannot dispatch to', () => {
        expect(() => registerBinding('', {update() {}})).toThrow(TypeError);
        expect(() => registerBinding('x', null)).toThrow(TypeError);
        expect(() => registerBinding('x', {})).toThrow(/no update/);
        expect(() => registerBinding('x', {update() {}, attach: 'no'})).toThrow(/attach/);
    });

    it('claims an attribute by exact name, and by prefix with an arg', () => {
        expect(claimAttribute('data-model')).toMatchObject({kind: 'model', arg: null});
        expect(claimAttribute('data-on-click')).toMatchObject({kind: 'event', arg: 'click'});
        expect(claimAttribute('data-bind-aria-label')).toMatchObject({
            kind: 'bind', arg: 'aria-label'
        });
        expect(claimAttribute('data-icon')).toBeNull();
        expect(claimAttribute('class')).toBeNull();
        // A bare prefix with nothing after it names no event.
        expect(claimAttribute('data-on-')).toBeNull();
    });

    it('unregisters, and a compiled template survives its handler going away', () => {
        const ctrl = compile('<b data-bind-text="name"></b>', {name: 'Ada'}, host);
        expect(host.textContent).toBe('Ada');

        const handler = bindingHandler('bind');
        unregisterBinding('bind');

        // No handler, no update — but no throw either.
        expect(() => ctrl.updateAll({name: 'Grace'})).not.toThrow();
        expect(host.textContent).toBe('Ada');

        registerBinding('bind', handler);
    });
});

describe('registerBinding is not a second-class citizen', () => {
    afterEach(() => unregisterBinding('shout'));

    it('a custom binding compiles, primes, updates and can be unregistered', () => {
        registerBinding('shout', {
            attribute: 'data-shout',
            expression: true,
            tracks: true,
            primes: true,
            update({binding, nodes, context}) {
                const value = String(binding.evaluate(context) ?? '');
                for (const el of nodes) el.textContent = `${value.toUpperCase()}!`;
                return true;
            }
        });

        const ctrl = compile('<p data-shout="name"></p>', {name: 'ada'}, host);

        // primes: true means it is right after the first paint, with no update.
        expect(host.textContent).toBe('ADA!');

        const binding = ctrl.bindings.find(b => b.kind === 'shout');
        expect(binding).toBeDefined();
        expect([...binding.deps]).toEqual(['name']);

        ctrl.update(binding.id, {name: 'grace'});
        expect(host.textContent).toBe('GRACE!');
    });

    it('a custom prefix binding gets its arg, exactly as data-on-* does', () => {
        registerBinding('shout', {
            attributePrefix: 'data-shout-',
            expression: true,
            primes: true,
            update({binding, nodes, context}) {
                for (const el of nodes) el.setAttribute(binding.arg, binding.evaluate(context));
                return true;
            }
        });

        compile('<p data-shout-title="name"></p>', {name: 'ada'}, host);
        expect(host.querySelector('p').getAttribute('title')).toBe('ada');
    });
});

// ── The four Tier 3 kinds, re-expressed ───────────────────────────────────────

describe('the four original kinds still behave exactly as before', () => {
    it('text updates textContent only, leaving siblings alone', () => {
        const ctrl = compile('<p>Hi {{name}}, welcome</p>', {name: 'Ada'}, host);
        const p = host.querySelector('p');

        expect(p.textContent).toBe('Hi Ada, welcome');
        ctrl.updateAll({name: 'Grace'});
        expect(p.textContent).toBe('Hi Grace, welcome');
    });

    it('attr writes the attribute and keeps an input value property in step', () => {
        const ctrl = compile('<input value="{{v}}" class="a {{c}}">', {v: 'x', c: 'on'}, host);
        const input = host.querySelector('input');

        expect(input.getAttribute('class')).toBe('a on');
        ctrl.updateAll({v: 'y', c: 'off'});
        expect(input.getAttribute('class')).toBe('a off');
        expect(input.value).toBe('y');
    });

    it('block re-renders only its own region', () => {
        const ctrl = compile(
            '<p>{{name}}</p>{{#if ok}}<b>yes</b>{{/if}}',
            {name: 'Ada', ok: false},
            host
        );

        const p = host.querySelector('p');
        expect(host.querySelector('b')).toBeNull();

        ctrl.updateAll({name: 'Ada', ok: true});
        expect(host.querySelector('b').textContent).toBe('yes');
        // The paragraph outside the block kept its identity.
        expect(host.querySelector('p')).toBe(p);
    });

    it('raw inserts markup unescaped', () => {
        const ctrl = compile('<div>{{{html}}}</div>', {html: '<i>a</i>'}, host);
        expect(host.querySelector('i').textContent).toBe('a');

        ctrl.updateAll({html: '<em>b</em>'});
        expect(host.querySelector('em').textContent).toBe('b');
    });
});

// ── data-if ───────────────────────────────────────────────────────────────────

describe('data-if', () => {
    it('removes the element from the DOM, rather than hiding it', () => {
        const ctrl = compile('<b data-if="ok">yes</b>', {ok: true}, host);
        expect(host.querySelector('b')).not.toBeNull();

        ctrl.updateAll({ok: false});

        // Rendered state, not API state: the element is GONE, not display:none.
        expect(host.querySelector('b')).toBeNull();
        expect(host.textContent).toBe('');

        ctrl.updateAll({ok: true});
        expect(host.querySelector('b').textContent).toBe('yes');
    });

    it('is correct on the first paint, without an update', () => {
        compile('<b data-if="ok">yes</b>', {ok: false}, host);
        expect(host.querySelector('b')).toBeNull();
    });

    it('takes a full expression, not just a name', () => {
        const ctrl = compile('<b data-if="n > 2 && ok">y</b>', {n: 3, ok: true}, host);
        expect(host.querySelector('b')).not.toBeNull();

        ctrl.updateAll({n: 1, ok: true});
        expect(host.querySelector('b')).toBeNull();
    });

    it('uses mustache truthiness, so an empty array is falsy', () => {
        // {{#if items}} and data-if="items" must not disagree about [].
        const ctrl = compile('<b data-if="items">y</b>{{#if items}}<i>y</i>{{/if}}', {items: []}, host);
        expect(host.querySelector('b')).toBeNull();
        expect(host.querySelector('i')).toBeNull();

        ctrl.updateAll({items: [1]});
        expect(host.querySelector('b')).not.toBeNull();
        expect(host.querySelector('i')).not.toBeNull();
    });

    it('takes its whole element, nested tags of the same name included', () => {
        const ctrl = compile(
            '<div data-if="ok"><div>inner</div></div><p>after</p>',
            {ok: true},
            host
        );
        expect(host.querySelectorAll('div').length).toBe(2);
        expect(host.querySelector('p').textContent).toBe('after');

        ctrl.updateAll({ok: false});
        expect(host.querySelectorAll('div').length).toBe(0);
        // Everything after the element is untouched — the region ended at the
        // right </div>, not at the first one.
        expect(host.querySelector('p').textContent).toBe('after');
    });

    it('works on a void element, which has no closing tag', () => {
        const ctrl = compile('<input data-if="ok"><p>x</p>', {ok: true}, host);
        expect(host.querySelector('input')).not.toBeNull();

        ctrl.updateAll({ok: false});
        expect(host.querySelector('input')).toBeNull();
        expect(host.querySelector('p')).not.toBeNull();
    });

    it('keeps bindings inside it live across a toggle', () => {
        // The reason the handler re-renders rather than stashing the element:
        // a stashed subtree goes stale while it is detached.
        const ctrl = compile('<b data-if="ok">{{name}}</b>', {ok: true, name: 'Ada'}, host);
        expect(host.textContent).toBe('Ada');

        ctrl.updateAll({ok: false, name: 'Grace'});
        expect(host.querySelector('b')).toBeNull();

        ctrl.updateAll({ok: true, name: 'Grace'});
        expect(host.textContent).toBe('Grace');
    });

    it('nests inside a mustache block', () => {
        const ctrl = compile(
            '{{#if outer}}<b data-if="inner">y</b>{{/if}}',
            {outer: true, inner: true},
            host
        );
        expect(host.querySelector('b')).not.toBeNull();

        ctrl.updateAll({outer: true, inner: false});
        expect(host.querySelector('b')).toBeNull();

        ctrl.updateAll({outer: false, inner: true});
        expect(host.querySelector('b')).toBeNull();
    });
});

// ── data-on-* ─────────────────────────────────────────────────────────────────

describe('data-on-*', () => {
    it('calls a handler named by a bare reference, with the event', () => {
        const seen = [];
        compile(
            '<button data-on-click="save">go</button>',
            {save: (event) => seen.push(event.type)},
            host
        );

        fire(host.querySelector('button'), 'click');
        expect(seen).toEqual(['click']);
    });

    it('binds `this` to $data', () => {
        let self = null;
        const data = {save() { self = this; }};
        compile('<button data-on-click="save"></button>', data, host);

        fire(host.querySelector('button'), 'click');
        expect(self).toBe(data);
    });

    it('passes declared arguments first and the event last', () => {
        let args = null;
        compile(
            '<button data-on-click="save(item, 2)"></button>',
            {save: (...a) => { args = a; }, item: 'x'},
            host
        );

        fire(host.querySelector('button'), 'click');
        expect(args.slice(0, 2)).toEqual(['x', 2]);
        expect(args[2].type).toBe('click');
    });

    it('resolves the callee from the data, NOT from the helper registry', () => {
        // The parser produces a Call node whose callee would normally have to
        // be a registered helper. An event handler is a method on your data,
        // and this is where that difference is honoured.
        let called = false;
        compile(
            '<button data-on-click="notAHelper()"></button>',
            {notAHelper: () => { called = true; }},
            host
        );

        fire(host.querySelector('button'), 'click');
        expect(called).toBe(true);
    });

    it('reads the CURRENT data, not the data it was compiled with', () => {
        const first = vi.fn();
        const second = vi.fn();
        const ctrl = compile('<button data-on-click="save"></button>', {save: first}, host);

        ctrl.updateAll({save: second});
        fire(host.querySelector('button'), 'click');

        expect(first).not.toHaveBeenCalled();
        expect(second).toHaveBeenCalledTimes(1);
    });

    it('calls preventDefault when the handler returns false', () => {
        compile('<a href="#" data-on-click="stop">x</a>', {stop: () => false}, host);

        const event = new window.Event('click', {bubbles: true, cancelable: true});
        host.querySelector('a').dispatchEvent(event);
        expect(event.defaultPrevented).toBe(true);
    });

    it('does NOT preventDefault otherwise', () => {
        compile('<a href="#" data-on-click="go">x</a>', {go: () => undefined}, host);

        const event = new window.Event('click', {bubbles: true, cancelable: true});
        host.querySelector('a').dispatchEvent(event);
        expect(event.defaultPrevented).toBe(false);
    });

    it('warns once, and survives, when the expression is not a function', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        compile('<button data-on-click="notAFunction"></button>', {notAFunction: 42}, host);

        const button = host.querySelector('button');
        expect(() => { fire(button, 'click'); fire(button, 'click'); }).not.toThrow();
        expect(warn).toHaveBeenCalledTimes(1);

        warn.mockRestore();
    });

    it('wires several events on one element', () => {
        const seen = [];
        compile(
            '<input data-on-focus="f" data-on-blur="b">',
            {f: () => seen.push('f'), b: () => seen.push('b')},
            host
        );

        const input = host.querySelector('input');
        fire(input, 'focus');
        fire(input, 'blur');
        expect(seen).toEqual(['f', 'b']);
    });

    it('attaches exactly one listener however often the template re-indexes', () => {
        const seen = [];
        const ctrl = compile(
            '{{#if ok}}<b>x</b>{{/if}}<button data-on-click="go"></button>',
            {ok: false, go: () => seen.push(1)},
            host
        );

        // Each block update re-indexes the whole container.
        ctrl.updateAll({ok: true, go: () => seen.push(1)});
        ctrl.updateAll({ok: false, go: () => seen.push(1)});

        fire(host.querySelector('button'), 'click');
        expect(seen).toEqual([1]);
    });

    it('declares no dependencies, so no effect is wired for it', () => {
        const ctrl = compile('<button data-on-click="save"></button>', {save() {}}, host);
        const binding = ctrl.bindings.find(b => b.kind === 'event');
        expect([...binding.deps]).toEqual([]);
    });

    it('stops firing after destroy()', () => {
        const seen = [];
        const ctrl = compile('<button data-on-click="go"></button>', {go: () => seen.push(1)}, host);

        fire(host.querySelector('button'), 'click');
        ctrl.destroy();
        fire(host.querySelector('button'), 'click');

        expect(seen).toEqual([1]);
    });
});

// ── data-bind-* ───────────────────────────────────────────────────────────────

describe('data-bind-*', () => {
    it('writes textContent for data-bind-text, correct on first paint', () => {
        const ctrl = compile('<p data-bind-text="user.name"></p>', {user: {name: 'Ada'}}, host);
        expect(host.querySelector('p').textContent).toBe('Ada');

        ctrl.updateAll({user: {name: 'Grace'}});
        expect(host.querySelector('p').textContent).toBe('Grace');
    });

    it('adds and removes only the classes it owns, never the static ones', () => {
        const ctrl = compile(
            `<p class="card static" data-bind-class="active && 'on'"></p>`,
            {active: true},
            host
        );
        const p = host.querySelector('p');
        expect([...p.classList].sort()).toEqual(['card', 'on', 'static']);

        ctrl.updateAll({active: false});
        expect([...p.classList].sort()).toEqual(['card', 'static']);

        // A class added by other code survives a binding update too.
        p.classList.add('by-hand');
        ctrl.updateAll({active: true});
        expect([...p.classList].sort()).toEqual(['by-hand', 'card', 'on', 'static']);
    });

    it('writes a DOM property for the property-first names', () => {
        const ctrl = compile('<input data-bind-disabled="busy" data-bind-value="v">', {busy: true, v: 'a'}, host);
        const input = host.querySelector('input');

        expect(input.disabled).toBe(true);
        expect(input.value).toBe('a');

        ctrl.updateAll({busy: false, v: 'b'});
        expect(input.disabled).toBe(false);
        expect(input.value).toBe('b');
    });

    it('sets an ordinary attribute, and REMOVES it for false/null/undefined', () => {
        const ctrl = compile('<p data-bind-title="t"></p>', {t: 'hello'}, host);
        const p = host.querySelector('p');
        expect(p.getAttribute('title')).toBe('hello');

        for (const value of [false, null, undefined]) {
            ctrl.updateAll({t: value});
            expect(p.hasAttribute('title'), String(value)).toBe(false);
        }

        // `true` means "present with no value", not the string "true".
        ctrl.updateAll({t: true});
        expect(p.getAttribute('title')).toBe('');
    });

    it('handles a hyphenated attribute name', () => {
        compile('<p data-bind-aria-label="label"></p>', {label: 'Close'}, host);
        expect(host.querySelector('p').getAttribute('aria-label')).toBe('Close');
    });

    it('refuses data-bind-html, once, and writes nothing', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const ctrl = compile('<p data-bind-html="h"></p>', {h: '<img src=x onerror=alert(1)>'}, host);

        expect(host.querySelector('p').innerHTML).toBe('');
        expect(host.querySelector('img')).toBeNull();

        ctrl.updateAll({h: '<b>x</b>'});
        expect(host.querySelector('b')).toBeNull();
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls[0][0]).toMatch(/XSS/);

        warn.mockRestore();
    });

    it('escapes nothing and interprets nothing — text is text', () => {
        compile('<p data-bind-text="h"></p>', {h: '<b>not markup</b>'}, host);
        expect(host.querySelector('p').textContent).toBe('<b>not markup</b>');
        expect(host.querySelector('b')).toBeNull();
    });
});

// ── data-model ────────────────────────────────────────────────────────────────

describe('data-model', () => {
    it('shows the current value on the first paint', () => {
        compile('<input data-model="query">', {query: 'hello'}, host);
        expect(host.querySelector('input').value).toBe('hello');
    });

    it('writes back to the data on input', () => {
        const data = {query: ''};
        compile('<input data-model="query">', data, host);

        const input = host.querySelector('input');
        input.value = 'typed';
        fire(input, 'input');

        expect(data.query).toBe('typed');
    });

    it('writes back through a dotted path', () => {
        const data = {user: {email: ''}};
        compile('<input data-model="user.email">', data, host);

        const input = host.querySelector('input');
        input.value = 'a@b.c';
        fire(input, 'input');

        expect(data.user.email).toBe('a@b.c');
    });

    it('drives a standalone observable through .value, with no unwrapping magic', () => {
        const count = observable(2);
        compile('<input type="number" data-model="count.value">', {count}, host);

        const input = host.querySelector('input');
        expect(input.value).toBe('2');

        input.value = '7';
        fire(input, 'input');
        expect(count.value).toBe(7);
    });

    it('coerces number inputs, and empty to null', () => {
        const data = {n: 1};
        compile('<input type="number" data-model="n">', data, host);
        const input = host.querySelector('input');

        input.value = '42';
        fire(input, 'input');
        expect(data.n).toBe(42);

        input.value = '';
        fire(input, 'input');
        expect(data.n).toBeNull();
    });

    it('binds a checkbox to a boolean, both ways', () => {
        const data = {agreed: true};
        const ctrl = compile('<input type="checkbox" data-model="agreed">', data, host);
        const box = host.querySelector('input');

        expect(box.checked).toBe(true);

        box.checked = false;
        fire(box, 'change');
        expect(data.agreed).toBe(false);

        ctrl.updateAll({agreed: true});
        expect(box.checked).toBe(true);
    });

    it('binds radios by value, and an unchecked one writes nothing', () => {
        const data = {size: 'm'};
        compile(
            '<input type="radio" name="s" value="s" data-model="size">' +
            '<input type="radio" name="s" value="m" data-model="size">',
            data,
            host
        );

        const [small, medium] = host.querySelectorAll('input');
        expect(small.checked).toBe(false);
        expect(medium.checked).toBe(true);

        // The browser unchecks `medium` and checks `small`, and BOTH fire
        // change. `small` is dispatched first so the data already reads 's'
        // when the unchecked `medium` fires: a radio that wrote its own value
        // regardless of checkedness would put it straight back to 'm', and a
        // test that fired them the other way round would not notice.
        small.checked = true;
        medium.checked = false;

        fire(small, 'change');
        expect(data.size).toBe('s');

        fire(medium, 'change');
        expect(data.size, 'an unchecked radio must write nothing').toBe('s');
    });

    it('binds a select, and a multiple select to an array', () => {
        const single = {v: 'b'};
        compile('<select data-model="v"><option>a</option><option>b</option></select>', single, host);
        expect(host.querySelector('select').value).toBe('b');

        host.querySelector('select').value = 'a';
        fire(host.querySelector('select'), 'change');
        expect(single.v).toBe('a');

        host.textContent = '';
        const many = {vs: ['b']};
        compile(
            '<select multiple data-model="vs"><option>a</option><option>b</option></select>',
            many,
            host
        );
        const select = host.querySelector('select');
        expect([...select.selectedOptions].map(o => o.value)).toEqual(['b']);

        select.options[0].selected = true;
        fire(select, 'change');
        expect(many.vs).toEqual(['a', 'b']);
    });

    it('does not touch the control when the value has not changed', () => {
        // Writing el.value unconditionally moves the caret to the end while
        // someone is typing. This is the cheapest defence against that.
        const ctrl = compile('<input data-model="q">', {q: 'abc'}, host);
        const input = host.querySelector('input');

        let writes = 0;
        const descriptor = Object.getOwnPropertyDescriptor(
            window.HTMLInputElement.prototype, 'value'
        );
        Object.defineProperty(input, 'value', {
            configurable: true,
            get: () => descriptor.get.call(input),
            set: (v) => { writes++; descriptor.set.call(input, v); }
        });

        ctrl.updateAll({q: 'abc'});
        expect(writes).toBe(0);

        ctrl.updateAll({q: 'abcd'});
        expect(writes).toBe(1);
    });

    it('refuses to write through an unsettable expression, once', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const data = {a: 1, b: 2};
        compile('<input data-model="a + b">', data, host);

        const input = host.querySelector('input');
        input.value = 'x';
        fire(input, 'input');
        fire(input, 'input');

        expect(data).toEqual({a: 1, b: 2});
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls[0][0]).toMatch(/not a settable path/);

        warn.mockRestore();
    });

    it('stops writing back after destroy()', () => {
        const data = {q: ''};
        const ctrl = compile('<input data-model="q">', data, host);
        const input = host.querySelector('input');

        ctrl.destroy();
        input.value = 'typed';
        fire(input, 'input');

        expect(data.q).toBe('');
    });
});

describe('resolveWriteTarget', () => {
    const target = (source, data) =>
        resolveWriteTarget(parseExpression(source), createRootContext(data));

    it('resolves a bare name against $data', () => {
        const data = {a: 1};
        expect(target('a', data)).toEqual({object: data, key: 'a'});
    });

    it('stops one step short of the value for a member chain', () => {
        const data = {u: {email: 'x'}};
        expect(target('u.email', data)).toEqual({object: data.u, key: 'email'});
    });

    it('evaluates a computed key at write time', () => {
        const data = {xs: ['a', 'b'], i: 1};
        expect(target('xs[i]', data)).toEqual({object: data.xs, key: '1'});
    });

    it('refuses anything that is not a path', () => {
        expect(target('a + b', {a: 1, b: 2})).toBeNull();
        expect(target("upper(a)", {a: 1})).toBeNull();
        expect(target('a ? b : c', {})).toBeNull();
        expect(target("'literal'", {})).toBeNull();
    });

    it('refuses the context variables — position is not a variable', () => {
        for (const name of ['$data', '$root', '$parent', '$index']) {
            expect(target(name, {}), name).toBeNull();
        }
    });

    it('refuses the prototype keys, in every form', () => {
        // Prototype pollution with the arrow pointing the other way. The read
        // guard in the evaluator never sees a write, so this is its own check.
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

        expect(target('x.__proto__', {x: {}})).toBeNull();
        expect(target("x['constructor']", {x: {}})).toBeNull();
        expect(target('x[k]', {x: {}, k: '__proto__'})).toBeNull();
        expect(target('__proto__', {})).toBeNull();

        warn.mockRestore();
    });

    it('refuses to write into a primitive or a missing object', () => {
        expect(target('a.b', {a: 'string'})).toBeNull();
        expect(target('a.b', {})).toBeNull();
        expect(target('a', 'not an object')).toBeNull();
    });
});

// ── Behaviour bindings inside a context-shifting block ────────────────────────

describe('the M4 seam — an UNKEYED block still degrades, loudly', () => {
    /*
     * M4 shipped per-item bindings, but only for a block with `key=`. An
     * unkeyed {{#each}} still re-renders to a string, so it still cannot carry
     * a behaviour binding — and now warns twice: once that it is not
     * reconciling at all, and once that this particular binding was dropped.
     * `calls.flat()` rather than `calls[0]` because the order of the two is an
     * implementation detail and pinning it would break on the next change.
     */
    const messages = (warn) => warn.mock.calls.flat().join('\n');

    it('warns rather than silently dropping a handler inside {{#each}}', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

        const ctrl = compile(
            '{{#each xs}}<button data-on-click="go">{{name}}</button>{{/each}}',
            {xs: [{name: 'a'}], go() {}},
            host
        );

        expect(ctrl.bindings.some(b => b.kind === 'event')).toBe(false);
        expect(warn).toHaveBeenCalledWith(
            expect.stringContaining('data-on-click')
        );
        expect(messages(warn)).toMatch(/reconciler/);
        expect(messages(warn)).toMatch(/key=/);

        warn.mockRestore();
    });

    it('names the template when one was given', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

        compile(
            '{{#each xs}}<b data-bind-text="name"></b>{{/each}}',
            {xs: []},
            host,
            undefined,
            {template: 'person-card'}
        );

        expect(messages(warn)).toMatch(/person-card/);
        warn.mockRestore();
    });
});

// ── Bindings revealed by a block re-render ────────────────────────────────────

describe('a binding revealed by a block is primed, not left blank', () => {
    /*
     * The bug this covers: `update()` was per-binding, so a block opening did
     * not touch the bindings it had just revealed. `updateAll()` masked it —
     * it walks every binding, and by the time it reached the revealed one the
     * block had already rendered it. Domma updates ONE binding per effect, so
     * Domma got the broken path and the suite did not.
     *
     * Every test below therefore drives a single targeted update.
     */

    /** Open a block by updating only the block's own binding, as an effect does. */
    function openBlock(ctrl, data) {
        const block = ctrl.bindings.find(b => b.kind === 'block' || b.kind === 'if');
        ctrl.update(block.id, data);
    }

    it('primes data-bind-text revealed by {{#if}}', () => {
        const data = {open: false, name: 'Ada'};
        const ctrl = compile('{{#if open}}<b data-bind-text="name"></b>{{/if}}', data, host);

        data.open = true;
        openBlock(ctrl, data);

        expect(host.querySelector('b').textContent).toBe('Ada');
    });

    it('primes data-model revealed by {{#if}}, and wires its write-back', () => {
        const data = {open: false, q: 'hi'};
        const ctrl = compile('{{#if open}}<input data-model="q">{{/if}}', data, host);

        data.open = true;
        openBlock(ctrl, data);

        const input = host.querySelector('input');
        expect(input.value).toBe('hi');

        input.value = 'typed';
        fire(input, 'input');
        expect(data.q).toBe('typed');
    });

    it('primes an expression interpolation revealed by {{#if}}', () => {
        const pathsOnly = (tmpl, d) =>
            tmpl.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, k) => String(d[k] ?? ''))
                .replace(/\{\{#if (\w+)\}\}([\s\S]*?)\{\{\/if\}\}/g, (_, k, body) => (d[k] ? body : ''));

        const data = {open: false, n: 5};
        const ctrl = compile(
            "{{#if open}}<em>{{ n > 1 ? 'many' : 'one' }}</em>{{/if}}",
            data, host, pathsOnly
        );

        data.open = true;
        openBlock(ctrl, data);

        expect(host.querySelector('em').textContent).toBe('many');
    });

    it('primes through TWO levels of nesting', () => {
        // Priming the outer region reveals the inner one, which must itself be
        // primed before the binding inside IT can be. One settle round is not
        // enough; this is what the rounds are for.
        const data = {open: false, inner: true, name: 'Ada'};
        const ctrl = compile(
            '{{#if open}}<div data-if="inner"><b data-bind-text="name"></b></div>{{/if}}',
            data, host
        );

        data.open = true;
        openBlock(ctrl, data);

        expect(host.querySelector('b').textContent).toBe('Ada');
    });

    it('re-primes each time the block re-opens, against the CURRENT data', () => {
        const data = {open: true, name: 'Ada'};
        const ctrl = compile('{{#if open}}<b data-bind-text="name"></b>{{/if}}', data, host);
        expect(host.querySelector('b').textContent).toBe('Ada');

        data.open = false;
        openBlock(ctrl, data);
        expect(host.querySelector('b')).toBeNull();

        data.open = true;
        data.name = 'Grace';
        openBlock(ctrl, data);
        expect(host.querySelector('b').textContent).toBe('Grace');
    });

    it('attaches a listener to the revealed element exactly once', () => {
        const seen = [];
        const data = {open: false, go: () => seen.push(1)};
        const ctrl = compile('{{#if open}}<button data-on-click="go"></button>{{/if}}', data, host);

        data.open = true;
        openBlock(ctrl, data);
        fire(host.querySelector('button'), 'click');
        expect(seen).toEqual([1]);

        // Closing and re-opening builds a NEW button, which must get its own
        // single listener — not zero, and not two.
        data.open = false;
        openBlock(ctrl, data);
        data.open = true;
        openBlock(ctrl, data);

        fire(host.querySelector('button'), 'click');
        expect(seen).toEqual([1, 1]);
    });

    it('primes a region that only APPEARS when an enclosing region renders', () => {
        // One settle round is not enough here. When `a` is false the outer
        // region renders empty, so the inner `data-if` has no anchors in the
        // DOM at all and cannot be queued. Only once the outer one has
        // rendered does the inner one exist — and until it is primed, the
        // renderer has emitted its element verbatim and it is visible
        // regardless of `c`.
        const data = {a: false, c: false};
        const ctrl = compile('<div data-if="a"><b data-if="c">hidden</b></div>', data, host);

        expect(host.querySelector('div')).toBeNull();

        data.a = true;
        ctrl.update(ctrl.bindings.find(b => b.expr === 'a').id, data);

        expect(host.querySelector('div')).not.toBeNull();
        expect(host.querySelector('b'), 'the inner data-if was never primed').toBeNull();

        data.c = true;
        ctrl.update(ctrl.bindings.find(b => b.expr === 'c').id, data);
        expect(host.querySelector('b').textContent).toBe('hidden');
    });

    it('does not re-render a region that has not changed', () => {
        // A region's nodes are a {open, close} PAIR, rebuilt as a fresh object
        // on every index(). Keying "have I seen this?" on that object rather
        // than on the opening anchor would make every region look new on every
        // re-index, re-rendering the whole page for one unrelated change — and
        // looping until the settle cap.
        const data = {open: false, always: true};
        const ctrl = compile(
            '{{#if open}}<b>x</b>{{/if}}<div data-if="always"><i>keep</i></div>',
            data, host
        );

        const keep = host.querySelector('i');
        expect(keep).not.toBeNull();

        data.open = true;
        ctrl.update(ctrl.bindings.find(b => b.kind === 'block').id, data);

        expect(host.querySelector('b')).not.toBeNull();
        expect(host.querySelector('i'), 'the untouched region re-rendered').toBe(keep);
    });
});

describe('the settle loop converges', () => {
    afterEach(() => unregisterBinding('churn'));

    it('gives up loudly rather than hanging on a binding that never settles', () => {
        // A handler that replaces its own element on every update reveals a
        // node it has never seen each time it runs, so it re-queues itself for
        // ever. Nothing built-in does this; a custom binding easily could, and
        // the failure mode without a bound is a locked tab and no error.
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        let updates = 0;

        registerBinding('churn', {
            attribute: 'data-churn',
            expression: false,
            primes: true,
            update({nodes, reindex}) {
                updates++;
                for (const el of nodes) el.replaceWith(el.cloneNode(true));
                reindex();
                return true;
            }
        });

        expect(() => compile('<p data-churn="x"></p>', {}, host)).not.toThrow();

        // Bounded, and the page still rendered.
        expect(updates).toBeLessThanOrEqual(21);
        expect(host.querySelector('p')).not.toBeNull();

        const runaway = warn.mock.calls.filter(c => /kept revealing new nodes/.test(c[0]));
        expect(runaway).toHaveLength(1);
        expect(runaway[0][0]).toMatch(/churn/);

        warn.mockRestore();
    });
});

// ── data-on-* method calls ────────────────────────────────────────────────────
//
// The gap this closes: inside a list, `$data` is the ITEM, and a bare name
// resolves against $data and nowhere else (expression.js deliberately does not
// walk up to $parent). So a row's delete button had no way to name the list that
// owns it — `$parent.remove($data)` is the only spelling, and it did not parse.
//
// It parses now, for event bindings only. Everything else still refuses.

describe('data-on-* can call a method on the data', () => {
    it('reaches the owning view model from inside a list', () => {
        const removed = [];
        const data = {
            items: [{id: 1}, {id: 2}],
            remove(item) { removed.push(item.id); }
        };
        compile(
            '{{#each items key=id}}<button data-on-click="$parent.remove($data)"></button>{{/each}}',
            data,
            host
        );

        fire(host.querySelectorAll('button')[1], 'click');
        expect(removed).toEqual([2]);
    });

    it('binds `this` to the receiver, exactly as JavaScript does', () => {
        // `handlers.save()` keeps its receiver; a bare reference `handlers.save`
        // does not, and is documented as running with `this` = $data. That is
        // not an inconsistency to apologise for — it is precisely what
        // `const f = o.m; f()` does in the language the author already knows.
        let self = null;
        const handlers = {save() { self = this; }};
        compile('<button data-on-click="handlers.save()"></button>', {handlers}, host);

        fire(host.querySelector('button'), 'click');
        expect(self).toBe(handlers);
    });

    it('passes declared arguments first and the event last', () => {
        let args = null;
        const data = {api: {go: (...a) => { args = a; }}, n: 7};
        compile('<button data-on-click="api.go(n, 2)"></button>', data, host);

        fire(host.querySelector('button'), 'click');
        expect(args.slice(0, 2)).toEqual([7, 2]);
        expect(args[2].type).toBe('click');
    });

    it('honours a computed method name', () => {
        let called = false;
        const data = {api: {save: () => { called = true; }}, which: 'save'};
        compile('<button data-on-click="api[which]()"></button>', data, host);

        fire(host.querySelector('button'), 'click');
        expect(called).toBe(true);
    });

    it('returning false still prevents the default', () => {
        const data = {api: {stop: () => false}};
        compile('<a href="#" data-on-click="api.stop()">x</a>', data, host);

        const event = new window.Event('click', {bubbles: true, cancelable: true});
        host.querySelector('a').dispatchEvent(event);
        expect(event.defaultPrevented).toBe(true);
    });

    it('will not call through a prototype-chain key', () => {
        // `$data.constructor()` is the route from "call a method on my data" to
        // "call the Object constructor", and it is shut with the same blocklist
        // the reader uses.
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        compile('<button data-on-click="$data.constructor()"></button>', {}, host);

        expect(() => fire(host.querySelector('button'), 'click')).not.toThrow();
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('__proto__, constructor'));
        warn.mockRestore();
    });

    it('warns once when the method is not a function', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        compile('<button data-on-click="api.nope()"></button>', {api: {nope: 42}}, host);

        fire(host.querySelector('button'), 'click');
        fire(host.querySelector('button'), 'click');

        const hits = warn.mock.calls.filter(([m]) => String(m).includes('did not resolve to a function'));
        expect(hits).toHaveLength(1);
        warn.mockRestore();
    });

    it('does nothing when the receiver is absent, rather than throwing', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        compile('<button data-on-click="missing.go()"></button>', {}, host);

        expect(() => fire(host.querySelector('button'), 'click')).not.toThrow();
        warn.mockRestore();
    });
});

describe('every OTHER binding still refuses a method call', () => {
    it('skips data-bind-text rather than calling it', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        let called = false;
        compile('<b data-bind-text="api.name()"></b>', {api: {name: () => { called = true; return 'x'; }}}, host);

        expect(called).toBe(false);
        expect(host.querySelector('b').textContent).toBe('');
        expect(warn).toHaveBeenCalledWith(
            expect.stringContaining('only registered helpers can be called')
        );
        warn.mockRestore();
    });

    it('skips data-if rather than calling it', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        let called = false;
        compile('<b data-if="api.ok()">shown</b>', {api: {ok: () => { called = true; return true; }}}, host);

        expect(called).toBe(false);
        warn.mockRestore();
    });
});

// ── Entities in an expression-valued attribute ────────────────────────────────
//
// An HTML attribute value is entity-encoded text: `data-bind-class="a &amp;&amp;
// b"` and `data-bind-class="a && b"` are the SAME attribute, and every browser
// hands both to getAttribute() as `a && b`. The compiler reads its attributes
// out of a template STRING, so it has to do that decoding itself — otherwise the
// two spellings behave differently, which is the one thing HTML says they cannot.
//
// This is not a corner case reached by writing `&amp;` on purpose. Serialising
// DOM back to HTML (`el.innerHTML`, which is how applyBindings captures a
// data-each body) escapes every `&` it emits, so a perfectly ordinary
// `data-bind-class="done && 'struck'"` — the documented idiom — comes back out
// as `&amp;&amp;` without anyone having typed an entity anywhere.

describe('an expression attribute is decoded like the HTML it is', () => {
    it('reads &amp;&amp; as &&', () => {
        compile(`<b data-bind-text="a &amp;&amp; b"></b>`, {a: 1, b: 'yes'}, host);
        expect(host.querySelector('b').textContent).toBe('yes');
    });

    it('reads &lt; and &gt; as < and >', () => {
        compile(`<b data-bind-text="n &lt; 5"></b>`, {n: 2}, host);
        expect(host.querySelector('b').textContent).toBe('true');
    });

    it('decodes in a region attribute too', () => {
        // Asserted on the FALSY case: a data-if whose expression fails to parse
        // is skipped, which leaves the body on the page — so "it is shown when
        // true" would pass whether the decoding worked or not.
        compile(`<b data-if="a &amp;&amp; b">shown</b>`, {a: 1, b: 0}, host);
        expect(host.textContent).not.toContain('shown');

        const other = document.createElement('div');
        compile(`<b data-if="a &amp;&amp; b">shown</b>`, {a: 1, b: 1}, other);
        expect(other.textContent).toContain('shown');
    });

    it('decodes in an event attribute', () => {
        let got = null;
        compile(
            `<button data-on-click="go(a &amp;&amp; b)"></button>`,
            {a: 1, b: 'x', go: (v) => { got = v; }},
            host
        );
        fire(host.querySelector('button'), 'click');
        expect(got).toBe('x');
    });

    it('decodes &amp; last, so &amp;lt; stays the text "&lt;"', () => {
        // Decoding in the wrong order turns the escaped form of an entity into
        // the entity itself — the classic double-decode.
        compile(`<b data-bind-text="'&amp;lt;'"></b>`, {}, host);
        expect(host.querySelector('b').textContent).toBe('&lt;');
    });

    it('leaves an ORDINARY attribute encoded, because it is markup', () => {
        // `href` is not an expression; its value is written back into the
        // annotated template and must stay valid HTML.
        compile(`<a href="/s?a=1&amp;b=2">{{x}}</a>`, {x: 'go'}, host);
        expect(host.querySelector('a').getAttribute('href')).toBe('/s?a=1&b=2');
    });
});

// ── data-bind-style ───────────────────────────────────────────────────────────
//
// Two spellings, because the expression language has no object literal — it
// cannot, without becoming the thing a CSP forbids. `data-bind-style="obj"`
// takes a map from the view model; `data-bind-style-<prop>` names one property
// in the attribute, where the author would otherwise have had to invent an
// object to hold a single value.

describe('data-bind-style', () => {
    it('sets one property named in the attribute', () => {
        compile('<p data-bind-style-color="shade"></p>', {shade: 'red'}, host);
        expect(host.querySelector('p').style.color).toBe('red');
    });

    it('takes a kebab-cased property name', () => {
        compile('<p data-bind-style-font-weight="w"></p>', {w: 'bold'}, host);
        expect(host.querySelector('p').style.fontWeight).toBe('bold');
    });

    it('sets a custom property', () => {
        compile('<p data-bind-style---brand="c"></p>', {c: '#c00'}, host);
        expect(host.querySelector('p').style.getPropertyValue('--brand')).toBe('#c00');
    });

    it('leaves other properties on the element alone', () => {
        compile('<p style="margin: 4px" data-bind-style-color="shade"></p>', {shade: 'red'}, host);
        const p = host.querySelector('p');
        expect(p.style.margin).toBe('4px');
        expect(p.style.color).toBe('red');
    });

    it('removes the property when the value is falsy', () => {
        const ctrl = compile('<p data-bind-style-color="shade"></p>', {shade: 'red'}, host);
        const p = host.querySelector('p');

        ctrl.updateAll({shade: null});
        expect(p.style.color).toBe('');
    });

    it('keeps a legitimate zero', () => {
        compile('<p data-bind-style-opacity="o"></p>', {o: 0}, host);
        expect(host.querySelector('p').style.opacity).toBe('0');
    });

    it('applies every property of an object', () => {
        compile('<p data-bind-style="look"></p>', {look: {color: 'red', fontWeight: 'bold'}}, host);
        const p = host.querySelector('p');

        expect(p.style.color).toBe('red');
        expect(p.style.fontWeight).toBe('bold');
    });

    it('drops a property that leaves the object', () => {
        const ctrl = compile('<p data-bind-style="look"></p>', {look: {color: 'red', opacity: '0.5'}}, host);
        const p = host.querySelector('p');

        ctrl.updateAll({look: {color: 'blue'}});
        expect(p.style.color).toBe('blue');
        expect(p.style.opacity).toBe('');
    });

    it('leaves a static style alone when the object drops a property', () => {
        const ctrl = compile('<p style="margin: 4px" data-bind-style="look"></p>', {look: {color: 'red'}}, host);
        const p = host.querySelector('p');

        ctrl.updateAll({look: {}});
        expect(p.style.margin).toBe('4px');
        expect(p.style.color).toBe('');
    });

    it('warns once about a non-object, and writes nothing', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        compile('<p data-bind-style="look"></p>', {look: 'color: red'}, host);

        expect(host.querySelector('p').style.color).toBe('');
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls[0][0]).toContain('data-bind-style');
        warn.mockRestore();
    });

    it('treats a null object as nothing to apply, without warning', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        compile('<p data-bind-style="look"></p>', {look: null}, host);

        expect(host.querySelector('p').style.cssText).toBe('');
        expect(warn).not.toHaveBeenCalled();
        warn.mockRestore();
    });
});

// ── data-options ──────────────────────────────────────────────────────────────
//
// A select's options are a list, so `{{#each}}<option>` renders them perfectly
// well. This exists for the one thing that does not: the SELECTION. Rebuilding
// the option list wipes it, and a keyed each cannot help because the selection
// lives on the parent element rather than on any item. So the binding that
// rebuilds the list is also the one that puts the selection back.

describe('data-options', () => {
    it('builds an option per item', () => {
        compile('<select data-options="cities"></select>', {cities: ['Bath', 'Ely']}, host);
        const options = [...host.querySelectorAll('option')];

        expect(options.map(o => o.textContent)).toEqual(['Bath', 'Ely']);
        expect(options.map(o => o.value)).toEqual(['Bath', 'Ely']);
    });

    it('takes the label and the value from expressions against the item', () => {
        compile(
            '<select data-options="rows" data-options-text="name" data-options-value="id"></select>',
            {rows: [{id: 1, name: 'Ada'}, {id: 2, name: 'Grace'}]},
            host
        );
        const options = [...host.querySelectorAll('option')];

        expect(options.map(o => o.textContent)).toEqual(['Ada', 'Grace']);
        expect(options.map(o => o.value)).toEqual(['1', '2']);
    });

    it('resolves $index inside an option expression', () => {
        compile(
            `<select data-options="rows" data-options-text="$index"></select>`,
            {rows: ['a', 'b']},
            host
        );
        expect([...host.querySelectorAll('option')].map(o => o.textContent)).toEqual(['0', '1']);
    });

    it('prepends a caption with an empty value', () => {
        compile(
            `<select data-options="cities" data-options-caption="'Choose…'"></select>`,
            {cities: ['Bath']},
            host
        );
        const options = [...host.querySelectorAll('option')];

        expect(options).toHaveLength(2);
        expect(options[0].textContent).toBe('Choose…');
        expect(options[0].value).toBe('');
    });

    it('rebuilds when the collection changes', () => {
        const ctrl = compile('<select data-options="cities"></select>', {cities: ['Bath']}, host);
        ctrl.updateAll({cities: ['Bath', 'Ely', 'Wells']});

        expect(host.querySelectorAll('option')).toHaveLength(3);
    });

    it('keeps the selection across a rebuild when the value survives', () => {
        const ctrl = compile('<select data-options="cities"></select>', {cities: ['Bath', 'Ely']}, host);
        const select = host.querySelector('select');

        select.value = 'Ely';
        ctrl.updateAll({cities: ['Bath', 'Ely', 'Wells']});

        expect(select.value).toBe('Ely');
    });

    it('skips an item marked destroyed', () => {
        compile('<select data-options="rows" data-options-text="n"></select>',
            {rows: [{n: 'a'}, {n: 'b', _destroy: true}]}, host);

        expect([...host.querySelectorAll('option')].map(o => o.textContent)).toEqual(['a']);
    });

    it('empties the list for a collection that is not an array', () => {
        const ctrl = compile('<select data-options="cities"></select>', {cities: ['Bath']}, host);
        ctrl.updateAll({cities: null});

        expect(host.querySelectorAll('option')).toHaveLength(0);
    });

    it('warns once about an element that is not a select', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        compile('<div data-options="cities"></div>', {cities: ['Bath']}, host);

        expect(host.querySelector('div').children).toHaveLength(0);
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls[0][0]).toContain('data-options');
        warn.mockRestore();
    });
});

describe('data-options with data-model', () => {
    it('shows the value the model already holds', () => {
        compile(
            '<select data-options="cities" data-model="chosen"></select>',
            {cities: ['Bath', 'Ely'], chosen: 'Ely'},
            host
        );
        expect(host.querySelector('select').value).toBe('Ely');
    });

    it('shows it when the model attribute comes first', () => {
        compile(
            '<select data-model="chosen" data-options="cities"></select>',
            {cities: ['Bath', 'Ely'], chosen: 'Ely'},
            host
        );
        expect(host.querySelector('select').value).toBe('Ely');
    });

    it('writes the chosen value back', () => {
        const data = {cities: ['Bath', 'Ely'], chosen: 'Bath'};
        compile('<select data-options="cities" data-model="chosen"></select>', data, host);

        const select = host.querySelector('select');
        select.value = 'Ely';
        fire(select, 'change');

        expect(data.chosen).toBe('Ely');
    });

    it('round-trips a non-string option value by identity', () => {
        const rows = [{id: 1, name: 'Ada'}, {id: 2, name: 'Grace'}];
        const data = {rows, chosen: null};

        compile(
            '<select data-options="rows" data-options-text="name" data-model="chosen"></select>',
            data, host
        );

        const select = host.querySelector('select');
        select.selectedIndex = 1;
        fire(select, 'change');

        expect(data.chosen).toBe(rows[1]);      // the object, not "[object Object]"
    });

    it('shows the option whose item the model holds', () => {
        const rows = [{id: 1, name: 'Ada'}, {id: 2, name: 'Grace'}];
        compile(
            '<select data-options="rows" data-options-text="name" data-model="chosen"></select>',
            {rows, chosen: rows[1]}, host
        );

        expect(host.querySelector('select').selectedIndex).toBe(1);
    });

    it('keeps a numeric option value a number on the way back', () => {
        const data = {rows: [{id: 1, name: 'Ada'}, {id: 2, name: 'Grace'}], chosen: null};
        compile(
            '<select data-options="rows" data-options-text="name" data-options-value="id" data-model="chosen"></select>',
            data, host
        );

        const select = host.querySelector('select');
        select.value = '2';
        fire(select, 'change');

        expect(data.chosen).toBe(2);
    });
});

describe('data-options arriving late', () => {
    it('applies a model value chosen before the options loaded', () => {
        const ctrl = compile(
            '<select data-model="chosen" data-options="cities"></select>',
            {cities: [], chosen: 'Ely'},
            host
        );
        const select = host.querySelector('select');
        expect(select.options).toHaveLength(0);

        ctrl.updateAll({cities: ['Bath', 'Ely'], chosen: 'Ely'});
        expect(select.value).toBe('Ely');
    });

    it('does the same for a multiple select', () => {
        const ctrl = compile(
            '<select multiple data-model="chosen" data-options="cities"></select>',
            {cities: [], chosen: ['Ely']},
            host
        );
        const select = host.querySelector('select');

        ctrl.updateAll({cities: ['Bath', 'Ely'], chosen: ['Ely']});
        expect([...select.selectedOptions].map(o => o.value)).toEqual(['Ely']);
    });

    it('stops holding the value once it has been applied', () => {
        const ctrl = compile(
            '<select data-model="chosen" data-options="cities"></select>',
            {cities: [], chosen: 'Ely'},
            host
        );
        const select = host.querySelector('select');

        ctrl.updateAll({cities: ['Bath', 'Ely'], chosen: 'Ely'});

        // The user picks something else; a later rebuild must respect that
        // rather than snapping back to the value that was once pending.
        select.value = 'Bath';
        fire(select, 'change');
        ctrl.updateAll({cities: ['Bath', 'Ely', 'Wells'], chosen: 'Bath'});

        expect(select.value).toBe('Bath');
    });
});

// ── data-focus ────────────────────────────────────────────────────────────────
//
// Knockout's `hasFocus`, under a name that says which way the arrow points.
// Two-way, because both directions are the point: a view model that can move
// focus to the field it just revealed, and one that knows which field the user
// is in without listening for events itself.

describe('data-focus', () => {
    it('focuses the element when the value starts true', () => {
        compile('<input data-focus="editing">', {editing: true}, host);
        expect(document.activeElement).toBe(host.querySelector('input'));
    });

    it('leaves it alone when the value starts false', () => {
        compile('<input data-focus="editing">', {editing: false}, host);
        expect(document.activeElement).not.toBe(host.querySelector('input'));
    });

    it('focuses when the value becomes true', () => {
        const ctrl = compile('<input data-focus="editing">', {editing: false}, host);
        ctrl.updateAll({editing: true});
        expect(document.activeElement).toBe(host.querySelector('input'));
    });

    it('blurs when the value becomes false', () => {
        const ctrl = compile('<input data-focus="editing">', {editing: true}, host);
        const input = host.querySelector('input');
        expect(document.activeElement).toBe(input);

        ctrl.updateAll({editing: false});
        expect(document.activeElement).not.toBe(input);
    });

    it('does not re-focus an element that already has focus', () => {
        const ctrl = compile('<input data-focus="editing">', {editing: true}, host);
        const input = host.querySelector('input');
        const focus = vi.spyOn(input, 'focus');

        ctrl.updateAll({editing: true});
        expect(focus).not.toHaveBeenCalled();
    });

    it('writes true back when the user focuses the field', () => {
        const data = {editing: false};
        compile('<input data-focus="editing">', data, host);

        host.querySelector('input').focus();
        expect(data.editing).toBe(true);
    });

    it('writes false back when the field loses focus', () => {
        const data = {editing: true};
        compile('<input data-focus="editing">', data, host);

        host.querySelector('input').blur();
        expect(data.editing).toBe(false);
    });

    it('drives an observable through .value', () => {
        const editing = observable(false);
        compile('<input data-focus="editing.value">', {editing}, host, undefined, {reactive: true});

        host.querySelector('input').focus();
        expect(editing.peek()).toBe(true);
    });

    it('warns once when the expression cannot be written through', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        compile('<input data-focus="a && b">', {a: false, b: false}, host);

        const input = host.querySelector('input');
        input.focus();
        input.blur();

        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls[0][0]).toContain('data-focus');
        warn.mockRestore();
    });

    it('still moves focus for an expression it cannot write through', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        compile('<input data-focus="a && b">', {a: true, b: true}, host);

        expect(document.activeElement).toBe(host.querySelector('input'));
        warn.mockRestore();
    });

    it('stops listening once the controller is destroyed', () => {
        const data = {editing: false};
        const ctrl = compile('<input data-focus="editing">', data, host);
        const input = host.querySelector('input');

        ctrl.destroy();
        input.focus();

        expect(data.editing).toBe(false);
    });
});

describe('resolveWriteTarget refuses a frozen target', () => {
    it('refuses to write into $parents', () => {
        const child = createChildContext(createRootContext({}), {name: 'ada'});
        expect(resolveWriteTarget(parseExpression('$parents[0]'), child)).toBeNull();
    });

    it('refuses to write into a context reached through $parentContext', () => {
        const child = createChildContext(createRootContext({}), {name: 'ada'});
        expect(resolveWriteTarget(parseExpression('$parentContext.$index'), child)).toBeNull();
    });

    it('still allows writing to ancestor data', () => {
        const child = createChildContext(createRootContext({title: 'T'}), {name: 'ada'});
        const target = resolveWriteTarget(parseExpression('$parent.title'), child);

        expect(target).not.toBeNull();
        expect(target.key).toBe('title');
    });

    it('refuses frozen view-model data rather than throwing', () => {
        const frozen = createRootContext(Object.freeze({x: 1}));
        expect(resolveWriteTarget(parseExpression('x'), frozen)).toBeNull();
    });

    it('refuses a frozen object reached through a member chain', () => {
        const ctx = createRootContext({inner: Object.freeze({x: 1})});
        expect(resolveWriteTarget(parseExpression('inner.x'), ctx)).toBeNull();
    });
});
