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
import {createRootContext} from './context.js';
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
