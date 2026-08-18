/**
 * applyBindings — activating DOM that already exists.
 *
 * The three properties that have to hold, and that the brief singled out:
 * idempotence (applying twice must not double-bind), disposal (a handle that
 * tears down every effect and listener it created), and an explicit answer about
 * `{{ }}` in already-rendered DOM. Each has a section below, and each is
 * asserted against observable behaviour rather than against internals.
 */

import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {applyBindings, resetApplyWarnings} from './apply-bindings.js';
import {computed, flushSync, liveComputations} from './graph.js';
import {observable, observableArray} from './observable.js';
import {registerBinding, unregisterBinding} from './handlers.js';

let host;

beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    resetApplyWarnings();
});

afterEach(() => {
    host.remove();
});

/** Build a server-rendered page fragment. */
function serve(html) {
    host.innerHTML = html;
    return host.firstElementChild;
}

// ── Activation ────────────────────────────────────────────────────────────────

describe('activating existing markup', () => {
    it('leaves the markup alone apart from its own marker', () => {
        serve('<section class="card"><h1 data-bind-text="title">Server said this</h1></section>');

        const handle = applyBindings({title: 'Client says this'}, host);

        expect(host.querySelector('section').className).toBe('card');
        expect(host.querySelector('h1').tagName).toBe('H1');
        expect(host.querySelector('h1').getAttribute('data-bind-text')).toBe('title');
        expect(host.querySelector('h1').textContent).toBe('Client says this');

        handle.dispose();
    });

    it('primes every binding from the data, overwriting what the server sent', () => {
        serve(`
            <div>
                <span data-bind-text="name">stale</span>
                <input data-model="query" value="stale">
                <a data-bind-href="url">link</a>
                <b data-bind-hidden="hide">x</b>
            </div>`);

        const handle = applyBindings(
            {name: 'Ada', query: 'live', url: '/x', hide: true}, host
        );

        expect(host.querySelector('span').textContent).toBe('Ada');
        expect(host.querySelector('input').value).toBe('live');
        expect(host.querySelector('a').getAttribute('href')).toBe('/x');
        expect(host.querySelector('b').hidden).toBe(true);

        handle.dispose();
    });

    it('wires events, with the view model as `this`', () => {
        serve('<button data-on-click="save">Save</button>');
        const vm = {saved: 0, save() { this.saved++; }};

        const handle = applyBindings(vm, host);
        host.querySelector('button').click();
        host.querySelector('button').click();

        expect(vm.saved).toBe(2);
        handle.dispose();
    });

    it('wires two-way binding back into the view model', () => {
        serve('<input data-model="query">');
        const vm = {query: ''};

        const handle = applyBindings(vm, host);
        const input = host.querySelector('input');
        input.value = 'typed';
        input.dispatchEvent(new Event('input'));

        expect(vm.query).toBe('typed');
        handle.dispose();
    });

    it('follows observables with no further help', () => {
        serve('<span data-bind-text="count.value">0</span>');
        const count = observable(1);

        const handle = applyBindings({count}, host);
        expect(host.querySelector('span').textContent).toBe('1');

        count.value = 7;
        flushSync();

        expect(host.querySelector('span').textContent).toBe('7');
        handle.dispose();
    });

    it('re-runs everything on update() for a plain, untracked view model', () => {
        serve('<span data-bind-text="name">x</span>');
        const vm = {name: 'a'};

        const handle = applyBindings(vm, host);
        vm.name = 'b';
        expect(host.querySelector('span').textContent).toBe('a');

        handle.update(vm);
        expect(host.querySelector('span').textContent).toBe('b');

        handle.dispose();
    });

    it('activates the root element itself, not only its descendants', () => {
        const root = serve('<div data-bind-text="msg">x</div>');

        const handle = applyBindings({msg: 'hello'}, root);

        expect(root.textContent).toBe('hello');
        handle.dispose();
    });

    it('refuses anything that is not an element', () => {
        expect(() => applyBindings({}, null)).toThrow(TypeError);
        expect(() => applyBindings({}, 'body')).toThrow(TypeError);
    });

    it('works with a custom binding from the public registry', () => {
        registerBinding('shout', {
            attribute: 'data-shout',
            expression: true,
            tracks: true,
            update({binding, nodes, context}) {
                for (const el of nodes) el.textContent = String(binding.evaluate(context)).toUpperCase();
                return true;
            }
        });

        serve('<p data-shout="word">x</p>');
        const handle = applyBindings({word: 'quiet'}, host);

        expect(host.querySelector('p').textContent).toBe('QUIET');

        handle.dispose();
        unregisterBinding('shout');
    });
});

// ── data-if ───────────────────────────────────────────────────────────────────

describe('data-if detaches the element rather than re-rendering it', () => {
    it('removes it when false and puts the SAME node back when true', () => {
        serve('<div><p data-if="open">body</p></div>');
        const original = host.querySelector('p');
        const vm = {open: true};

        const handle = applyBindings(vm, host);
        expect(host.querySelector('p')).toBe(original);

        vm.open = false;
        handle.update(vm);
        expect(host.querySelector('p')).toBeNull();

        vm.open = true;
        handle.update(vm);
        // Node identity across a toggle — which the compiled `data-if` cannot
        // offer, because it re-renders its region from captured source.
        expect(host.querySelector('p')).toBe(original);

        handle.dispose();
    });

    it('puts it back in the right place among its siblings', () => {
        serve('<div><i>1</i><p data-if="open">2</p><i>3</i></div>');
        const vm = {open: true};
        const handle = applyBindings(vm, host);

        vm.open = false;
        handle.update(vm);
        expect(host.querySelector('div').textContent).toBe('13');

        vm.open = true;
        handle.update(vm);
        expect(host.querySelector('div').textContent).toBe('123');

        handle.dispose();
    });

    it('binds the children of an element that starts out hidden', () => {
        serve('<div><p data-if="open"><b data-bind-text="msg">x</b></p></div>');
        const vm = {open: false, msg: 'ready'};

        const handle = applyBindings(vm, host);
        expect(host.querySelector('b')).toBeNull();

        vm.open = true;
        handle.update(vm);

        // Bound while detached, and correct the moment it reappears.
        expect(host.querySelector('b').textContent).toBe('ready');
        handle.dispose();
    });

    it('is not fooled by an empty array, matching {{#if}}', () => {
        serve('<div><p data-if="items">any</p></div>');
        const handle = applyBindings({items: []}, host);

        expect(host.querySelector('p')).toBeNull();
        handle.dispose();
    });
});

// ── data-each ─────────────────────────────────────────────────────────────────

describe('data-each reconciles a list over the element\'s own contents', () => {
    it('treats the initial contents as the item template', () => {
        serve('<ul data-each="rows key=id"><li data-bind-text="name">placeholder</li></ul>');

        const handle = applyBindings({rows: [{id: 1, name: 'a'}, {id: 2, name: 'b'}]}, host);

        expect([...host.querySelectorAll('li')].map((el) => el.textContent)).toEqual(['a', 'b']);
        handle.dispose();
    });

    it('preserves node identity across a change, like the compiled block', () => {
        serve('<ul data-each="rows key=id"><li data-bind-text="name">x</li></ul>');
        const rows = observableArray([{id: 1, name: 'a'}, {id: 2, name: 'b'}]);

        const handle = applyBindings({rows}, host);
        const before = [...host.querySelectorAll('li')];

        rows.unshift({id: 0, name: 'z'});
        flushSync();

        const after = [...host.querySelectorAll('li')];
        expect(after.map((el) => el.textContent)).toEqual(['z', 'a', 'b']);
        expect(after[1]).toBe(before[0]);
        expect(after[2]).toBe(before[1]);

        handle.dispose();
    });

    it('supports mustache inside the item template, because that IS a template', () => {
        serve('<ul data-each="rows key=id"><li>{{name}} ({{$index}})</li></ul>');

        const handle = applyBindings({rows: [{id: 1, name: 'a'}]}, host);

        expect(host.querySelector('li').textContent).toBe('a (0)');
        handle.dispose();
    });

    it('does not activate the item template as page markup', () => {
        // The <li> is a template, so it must not end up in the WeakSet as a
        // bound element — it is about to be removed from the document.
        serve('<ul data-each="rows key=id"><li data-bind-text="name">x</li></ul>');
        const template = host.querySelector('li');

        const handle = applyBindings({rows: []}, host);

        expect(template.hasAttribute('data-dm-bound')).toBe(false);
        expect(host.querySelectorAll('li')).toHaveLength(0);
        handle.dispose();
    });

    it('refuses an unkeyed list, loudly', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        serve('<ul data-each="rows"><li data-bind-text="name">x</li></ul>');

        const handle = applyBindings({rows: [{id: 1, name: 'a'}]}, host);

        expect(host.querySelectorAll('li')).toHaveLength(1);   // untouched
        expect(warn.mock.calls.flat().join('\n')).toMatch(/needs a key/);

        handle.dispose();
        warn.mockRestore();
    });
});

// ── {{ }} in rendered DOM ─────────────────────────────────────────────────────

describe('{{ }} in already-rendered DOM', () => {
    it('is left exactly as it was found', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        serve('<p>Hello {{name}}</p>');

        const handle = applyBindings({name: 'Ada'}, host);

        expect(host.querySelector('p').textContent).toBe('Hello {{name}}');
        handle.dispose();
        warn.mockRestore();
    });

    it('says so once, and points at the supported spelling', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        serve('<p>Hello {{name}}</p><p>and {{other}}</p>');

        const handle = applyBindings({name: 'Ada'}, host);

        const messages = warn.mock.calls.flat().join('\n');
        expect(messages).toMatch(/does not interpolate/);
        expect(messages).toMatch(/data-bind-text/);
        expect(warn).toHaveBeenCalledTimes(1);

        handle.dispose();
        warn.mockRestore();
    });

    // The documented exception. A data-each body is a TEMPLATE — lifted out,
    // compiled and cloned per item — so mustache there is substituted and the
    // warning was telling the author to replace working markup.
    it('says nothing about mustache inside a data-each item template', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        serve('<ul data-each="rows key=id"><li>{{name}}</li></ul>');

        const handle = applyBindings({rows: [{id: 1, name: 'Ada'}]}, host);

        expect(host.querySelector('li').textContent).toBe('Ada');
        expect(warn).not.toHaveBeenCalled();

        handle.dispose();
        warn.mockRestore();
    });

    it('still warns about mustache outside the list, alongside one', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        serve('<div><p>Hello {{name}}</p><ul data-each="rows key=id"><li>{{name}}</li></ul></div>');

        const handle = applyBindings({name: 'Ada', rows: [{id: 1, name: 'Grace'}]}, host);

        const messages = warn.mock.calls.flat().join('\n');
        expect(messages).toMatch(/does not interpolate/);
        // Named the token that is genuinely stranded, not the one in the list.
        expect(messages).toMatch(/Hello \{\{name\}\}/);

        handle.dispose();
        warn.mockRestore();
    });

    it('says nothing when the root itself is the list', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        host.setAttribute('data-each', 'rows key=id');
        serve('<li>{{name}}</li>');

        // Cleanup in `finally`: a failing expect() would otherwise leave
        // data-each on the shared host and take the next test down with it.
        try {
            const handle = applyBindings({rows: [{id: 1, name: 'Ada'}]}, host);
            expect(warn).not.toHaveBeenCalled();
            handle.dispose();
        } finally {
            host.removeAttribute('data-each');
            warn.mockRestore();
        }
    });

    it('says nothing about prose that merely contains braces', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        serve('<p>Use {{ }} for interpolation, or { a: 1 } for an object.</p>');

        const handle = applyBindings({}, host);

        expect(warn).not.toHaveBeenCalled();
        handle.dispose();
        warn.mockRestore();
    });
});

// ── Idempotence ───────────────────────────────────────────────────────────────

describe('applying twice', () => {
    it('does not bind an element a second time', () => {
        serve('<span data-bind-text="a">x</span>');
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

        const first = applyBindings({a: 'one'}, host);
        const second = applyBindings({a: 'two'}, host);

        expect(first.bindings).toBe(1);
        expect(second.bindings).toBe(0);
        // The first handle still owns it — the second call changed nothing.
        expect(host.querySelector('span').textContent).toBe('one');

        first.dispose();
        second.dispose();
        warn.mockRestore();
    });

    it('does not double up event listeners', () => {
        serve('<button data-on-click="hit">go</button>');
        const vm = {hits: 0, hit() { this.hits++; }};
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

        const first = applyBindings(vm, host);
        const second = applyBindings(vm, host);

        host.querySelector('button').click();
        expect(vm.hits).toBe(1);

        first.dispose();
        second.dispose();
        warn.mockRestore();
    });

    it('warns once, naming the root', () => {
        serve('<span data-bind-text="a" id="target">x</span>');
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

        const first = applyBindings({a: 1}, host);
        const second = applyBindings({a: 2}, host);
        const third = applyBindings({a: 3}, host);

        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls[0][0]).toMatch(/already bound/);

        first.dispose();
        second.dispose();
        third.dispose();
        warn.mockRestore();
    });

    it('allows re-applying after the first handle is disposed', () => {
        serve('<span data-bind-text="a">x</span>');

        const first = applyBindings({a: 'one'}, host);
        first.dispose();

        const second = applyBindings({a: 'two'}, host);
        expect(second.bindings).toBe(1);
        expect(host.querySelector('span').textContent).toBe('two');

        second.dispose();
    });
});

// ── Disposal ──────────────────────────────────────────────────────────────────

describe('the disposal handle', () => {
    it('returns the Computation count to where it started', () => {
        const before = liveComputations();

        serve(`
            <div>
                <span data-bind-text="a">x</span>
                <span data-bind-text="b">x</span>
                <p data-if="show">y</p>
                <ul data-each="rows key=id"><li data-bind-text="n">z</li></ul>
            </div>`);

        const handle = applyBindings(
            {a: 1, b: 2, show: true, rows: [{id: 1, n: 'r'}, {id: 2, n: 's'}]}, host
        );

        expect(liveComputations()).toBeGreaterThan(before);

        handle.dispose();

        expect(liveComputations()).toBe(before);
    });

    it('removes the listeners it attached', () => {
        serve('<button data-on-click="hit">go</button><input data-model="q">');
        const vm = {hits: 0, q: '', hit() { this.hits++; }};

        const handle = applyBindings(vm, host);
        handle.dispose();

        host.querySelector('button').click();
        const input = host.querySelector('input');
        input.value = 'after';
        input.dispatchEvent(new Event('input'));

        expect(vm.hits).toBe(0);
        expect(vm.q).toBe('');
    });

    it('removes the visible marker it added', () => {
        serve('<span data-bind-text="a">x</span>');

        const handle = applyBindings({a: 1}, host);
        expect(host.querySelector('span').hasAttribute('data-dm-bound')).toBe(true);

        handle.dispose();
        expect(host.querySelector('span').hasAttribute('data-dm-bound')).toBe(false);
    });

    it('restores a hidden data-if element and removes its placeholder', () => {
        serve('<div><p data-if="open">body</p></div>');
        const before = host.innerHTML;
        const vm = {open: false};

        const handle = applyBindings(vm, host);
        expect(host.querySelector('p')).toBeNull();

        handle.dispose();

        expect(host.querySelector('p')).not.toBeNull();
        expect(host.innerHTML).toBe(before);
    });

    it('stops updating after disposal', () => {
        serve('<span data-bind-text="count.value">x</span>');
        const count = observable(1);

        const handle = applyBindings({count}, host);
        handle.dispose();

        count.value = 99;
        flushSync();

        expect(host.querySelector('span').textContent).toBe('1');
    });

    it('is safe to call twice', () => {
        serve('<span data-bind-text="a">x</span>');
        const handle = applyBindings({a: 1}, host);

        handle.dispose();
        expect(() => handle.dispose()).not.toThrow();
    });

    it('leaves a torn-down list empty and leak-free', () => {
        const before = liveComputations();
        serve('<ul data-each="rows key=id"><li data-bind-text="n">x</li></ul>');

        const handle = applyBindings({rows: [{id: 1, n: 'a'}, {id: 2, n: 'b'}]}, host);
        expect(host.querySelectorAll('li')).toHaveLength(2);

        handle.dispose();

        expect(host.querySelectorAll('li')).toHaveLength(0);
        expect(liveComputations()).toBe(before);
    });
});

// ── Region bindings that cannot work here ─────────────────────────────────────

describe('a custom region binding', () => {
    it('is refused with an explanation rather than half-applied', () => {
        registerBinding('boxed', {
            attribute: 'data-boxed',
            expression: true,
            region: true,
            capturesBody: true,
            update() { return true; }
        });

        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        serve('<p data-boxed="x">y</p>');

        const handle = applyBindings({x: 1}, host);

        expect(warn.mock.calls.flat().join('\n')).toMatch(/region binding/);
        expect(host.querySelector('p').textContent).toBe('y');

        handle.dispose();
        unregisterBinding('boxed');
        warn.mockRestore();
    });
});

// ── The method-call opt-in is per HANDLER, not per entry point ────────────────
//
// applyBindings has its own compile path, separate from the template compiler's,
// so "only the event binding may call a method" has to be true twice. The app
// test above proves the permissive half here (a row calls $parent.remove); this
// proves the strict half, which is the one that would fail silently — a leak
// would not break anything visible, it would just let a method run inside an
// effect on every render.

describe('applyBindings refuses a method call outside an event binding', () => {
    it('skips data-bind-text rather than calling it', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        let called = false;
        host.innerHTML = '<b data-bind-text="api.name()"></b>';

        const handle = applyBindings({api: {name: () => { called = true; return 'x'; }}}, host);

        expect(called).toBe(false);
        expect(host.querySelector('b').textContent).toBe('');
        expect(warn).toHaveBeenCalledWith(
            expect.stringContaining('only registered helpers can be called')
        );

        handle.dispose();
        warn.mockRestore();
    });

    it('skips data-if rather than calling it', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        let called = false;
        host.innerHTML = '<b data-if="api.ok()">shown</b>';

        const handle = applyBindings({api: {ok: () => { called = true; return false; }}}, host);

        expect(called).toBe(false);
        handle.dispose();
        warn.mockRestore();
    });
});

// ── One whole small application ───────────────────────────────────────────────
//
// Every other test here proves one binding in isolation, which is how a suite
// can be green while the library is unusable: the failure that prompted this one
// was not in any single binding but in the SEAM between two of them — a keyed
// list renders, an event binding fires, and yet a row still had no way to name
// the list that owns it, so a delete button was unspellable and every test
// passed anyway.
//
// So this builds a real thing — add, edit, toggle, remove, derive, empty state —
// out of nothing but the public API, and asserts on what the user would see. It
// is deliberately the shape of the smallest app anyone actually writes.

describe('a whole small application', () => {
    it('adds, toggles, removes, and keeps a derived summary honest', async () => {
        host.innerHTML = `
            <input data-model="draft.value" id="draft">
            <button data-on-click="add()" id="add">Add</button>
            <ul data-each="todos key=id">
              <li>
                <input type="checkbox" data-model="done.value">
                <span data-bind-class="done.value && 'struck'" data-bind-text="title"></span>
                <button class="rm" data-on-click="$parent.remove($data)">x</button>
              </li>
            </ul>
            <p id="empty" data-if="todos.length === 0">Nothing to do.</p>
            <p id="summary" data-bind-text="summary.value"></p>`;

        const todos = observableArray([]);
        const draft = observable('');
        let nextId = 1;

        const vm = {
            todos,
            draft,
            summary: computed(() => {
                const all = todos.value;
                return `${all.filter((t) => !t.done.value).length} of ${all.length} left`;
            }),
            add() {
                if (draft.value.trim() === '') return;
                todos.push({id: nextId++, title: draft.value.trim(), done: observable(false)});
                draft.value = '';
            },
            remove(item) {
                todos.remove(item);
            }
        };

        const handle = applyBindings(vm, host);

        const type = (text) => {
            const input = host.querySelector('#draft');
            input.value = text;
            input.dispatchEvent(new window.Event('input', {bubbles: true}));
        };
        const click = (el) =>
            el.dispatchEvent(new window.Event('click', {bubbles: true, cancelable: true}));
        const titles = () => [...host.querySelectorAll('li span')].map((s) => s.textContent);
        const summary = () => host.querySelector('#summary').textContent;

        expect(host.querySelector('#empty')).not.toBeNull();

        type('Write the README');
        click(host.querySelector('#add'));
        type('Ship 0.4.0');
        click(host.querySelector('#add'));
        await flushSync();

        expect(titles()).toEqual(['Write the README', 'Ship 0.4.0']);
        expect(summary()).toBe('2 of 2 left');
        expect(host.querySelector('#empty')).toBeNull();

        // The draft was cleared through the model, so the control follows.
        expect(host.querySelector('#draft').value).toBe('');

        // Ticking a row's box writes through data-model and the summary follows.
        const box = host.querySelector('li input[type=checkbox]');
        box.checked = true;
        box.dispatchEvent(new window.Event('change', {bubbles: true}));
        await flushSync();

        expect(summary()).toBe('1 of 2 left');
        expect(host.querySelector('li span').className).toBe('struck');

        // The point of the whole test: a row reaching the list that owns it.
        click(host.querySelectorAll('.rm')[1]);
        await flushSync();

        expect(titles()).toEqual(['Write the README']);
        expect(summary()).toBe('0 of 1 left');

        click(host.querySelector('.rm'));
        await flushSync();

        expect(titles()).toEqual([]);
        expect(host.querySelector('#empty')).not.toBeNull();

        handle.dispose();
    });
});

// ── Virtual elements ──────────────────────────────────────────────────────────
//
// Knockout's `<!-- ko if: x --> … <!-- /ko -->`. It exists because a binding
// attribute needs an element to sit on, and sometimes there is no element to
// spare: a run of `<li>`s, three `<td>`s in a row, a fragment inside a `<p>`.
// Wrapping them in a `<div>` to hold the attribute changes the layout, and in a
// table it is not even valid HTML.
//
// `compile()` has never needed this — `{{#if}}` already delimits a region with
// comments. It is applyBindings, where the markup is the page and the author
// cannot add mustache, that has nothing to offer.

describe('virtual bindings', () => {
    it('shows a run of siblings when the condition is true', () => {
        serve('<ul><li>keep</li><!-- dm if: open --><li>a</li><li>b</li><!-- /dm --></ul>');
        applyBindings({open: true}, host);

        expect([...host.querySelectorAll('li')].map(li => li.textContent))
            .toEqual(['keep', 'a', 'b']);
    });

    it('removes the run when the condition is false', () => {
        serve('<ul><li>keep</li><!-- dm if: open --><li>a</li><li>b</li><!-- /dm --></ul>');
        applyBindings({open: false}, host);

        expect([...host.querySelectorAll('li')].map(li => li.textContent)).toEqual(['keep']);
    });

    it('brings the same nodes back, rather than rebuilding them', () => {
        serve('<ul><!-- dm if: open.value --><li>a</li><!-- /dm --></ul>');
        const open = observable(true);
        applyBindings({open}, host);

        const li = host.querySelector('li');
        open.value = false;
        flushSync();
        expect(host.querySelector('li')).toBeNull();

        open.value = true;
        flushSync();
        expect(host.querySelector('li')).toBe(li);
    });

    it('keeps the bindings inside a hidden run alive', () => {
        serve('<ul><!-- dm if: open.value --><li data-bind-text="name.value">x</li><!-- /dm --></ul>');
        const open = observable(false);
        const name = observable('Ada');
        applyBindings({open, name}, host);

        name.value = 'Grace';
        open.value = true;
        flushSync();

        expect(host.querySelector('li').textContent).toBe('Grace');
    });

    it('nests', () => {
        serve(
            '<ul><!-- dm if: outer --><li>a</li>' +
            '<!-- dm if: inner --><li>b</li><!-- /dm --><!-- /dm --></ul>'
        );
        applyBindings({outer: true, inner: false}, host);

        expect([...host.querySelectorAll('li')].map(li => li.textContent)).toEqual(['a']);
    });

    it('keeps a nested block hidden across the outer block closing and reopening', () => {
        // The inner block's anchors travel with the outer block's held nodes.
        // If they lost their siblings on the way out, the inner range would come
        // back empty and its content would reappear regardless of its own
        // condition — silently, and only on the second toggle.
        serve(
            '<ul><!-- dm if: outer.value --><li>a</li>' +
            '<!-- dm if: inner.value --><li>b</li><!-- /dm --><!-- /dm --></ul>'
        );
        const outer = observable(true);
        const inner = observable(false);
        applyBindings({outer, inner}, host);

        expect([...host.querySelectorAll('li')].map(li => li.textContent)).toEqual(['a']);

        outer.value = false;
        flushSync();
        expect(host.querySelectorAll('li')).toHaveLength(0);

        outer.value = true;
        flushSync();
        expect([...host.querySelectorAll('li')].map(li => li.textContent)).toEqual(['a']);
    });

    it('honours a nested block that changed while the outer one was closed', () => {
        // The case that decides how held nodes are stored. While the outer block
        // is closed, the inner block's anchors are out of the document — but it
        // is still live, and its condition can still change. It has to be able to
        // insert into wherever its anchors currently are, which means they must
        // still have a parent and their siblings.
        serve(
            '<ul><!-- dm if: outer.value --><li>a</li>' +
            '<!-- dm if: inner.value --><li>b</li><!-- /dm --><!-- /dm --></ul>'
        );
        const outer = observable(true);
        const inner = observable(false);
        applyBindings({outer, inner}, host);

        outer.value = false;
        flushSync();

        inner.value = true;          // changed while out of the document
        flushSync();

        outer.value = true;
        flushSync();

        expect([...host.querySelectorAll('li')].map(li => li.textContent)).toEqual(['a', 'b']);
    });

    it('renders a keyed list over the nodes between the anchors', () => {
        serve('<ul><!-- dm each: rows key=id --><li data-bind-text="name"></li><!-- /dm --></ul>');
        applyBindings({rows: [{id: 1, name: 'Ada'}, {id: 2, name: 'Grace'}]}, host);

        expect([...host.querySelectorAll('li')].map(li => li.textContent)).toEqual(['Ada', 'Grace']);
    });

    it('keeps node identity across a change to a virtual list', () => {
        serve('<ul><!-- dm each: rows key=id --><li data-bind-text="name"></li><!-- /dm --></ul>');
        const rows = observableArray([{id: 1, name: 'Ada'}]);
        applyBindings({rows}, host);

        const ada = host.querySelector('li');
        rows.unshift({id: 2, name: 'Grace'});
        flushSync();

        expect(host.querySelectorAll('li')).toHaveLength(2);
        expect(host.querySelectorAll('li')[1]).toBe(ada);
    });

    it('writes text between the anchors', () => {
        serve('<p>Hello <!-- dm text: name -->placeholder<!-- /dm -->!</p>');
        applyBindings({name: 'Ada'}, host);

        expect(host.querySelector('p').textContent).toBe('Hello Ada!');
    });

    it('updates that text when the value changes', () => {
        serve('<p><!-- dm text: name.value -->x<!-- /dm --></p>');
        const name = observable('Ada');
        applyBindings({name}, host);

        name.value = 'Grace';
        flushSync();
        expect(host.querySelector('p').textContent).toBe('Grace');
    });

    it('warns once about a virtual binding it does not implement', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        serve('<ul><!-- dm with: obj --><li>a</li><!-- /dm --></ul>');
        applyBindings({obj: {}}, host);

        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls[0][0]).toContain('with');
        warn.mockRestore();
    });

    it('warns once about an opener with no closer, and binds nothing', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        serve('<ul><!-- dm if: open --><li>a</li></ul>');
        applyBindings({open: false}, host);

        expect(host.querySelectorAll('li')).toHaveLength(1);
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls[0][0]).toContain('/dm');
        warn.mockRestore();
    });

    it('refuses a virtual list with no key', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        serve('<ul><!-- dm each: rows --><li></li><!-- /dm --></ul>');
        applyBindings({rows: [{id: 1}]}, host);

        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls[0][0]).toContain('key');
        warn.mockRestore();
    });

    it('puts the markup back on dispose', () => {
        serve('<ul><li>keep</li><!-- dm if: open --><li>a</li><!-- /dm --></ul>');
        const handle = applyBindings({open: false}, host);

        expect(host.querySelectorAll('li')).toHaveLength(1);
        handle.dispose();
        expect([...host.querySelectorAll('li')].map(li => li.textContent)).toEqual(['keep', 'a']);
    });

    it('leaves no effects behind after dispose', () => {
        serve('<ul><!-- dm each: rows key=id --><li data-bind-text="name"></li><!-- /dm --></ul>');
        const baseline = liveComputations();

        const handle = applyBindings({rows: [{id: 1, name: 'Ada'}]}, host);
        handle.dispose();

        expect(liveComputations()).toBe(baseline);
    });

    it('ignores an ordinary comment', () => {
        serve('<ul><!-- just a note --><li>a</li></ul>');
        const handle = applyBindings({}, host);

        expect(host.querySelectorAll('li')).toHaveLength(1);
        expect(handle.bindings).toBe(0);
    });
});

describe('ancestor names on server-rendered markup', () => {
    /**
     * One level, because that is what this path supports: a `data-each` nested
     * inside a keyed `data-each` is not expanded here, which predates these
     * names and is unrelated to them. The compiled path covers deeper nesting
     * through `{{#each}}`, in reconciler.test.js.
     */
    it('reaches the root through $parents and $parentContext', () => {
        const host = document.createElement('div');
        host.innerHTML =
            '<ul data-each="groups key=id"><li>' +
            '<b data-bind-text="$parents[0].title"></b>' +
            '<u data-bind-text="$parents.length"></u>' +
            '<s data-bind-text="$parentContext.$data.title"></s>' +
            '</li></ul>';
        document.body.appendChild(host);

        applyBindings({
            title: 'Contacts',
            groups: [{id: 1, name: 'Family'}, {id: 2, name: 'Work'}]
        }, host);
        flushSync();

        expect([...host.querySelectorAll('b')].map((n) => n.textContent))
            .toEqual(['Contacts', 'Contacts']);
        expect([...host.querySelectorAll('u')].map((n) => n.textContent))
            .toEqual(['1', '1']);
        expect([...host.querySelectorAll('s')].map((n) => n.textContent))
            .toEqual(['Contacts', 'Contacts']);
    });
});

describe('a nested data-each says so instead of failing quietly', () => {
    it('warns, naming the mustache form that does work', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

        const host = document.createElement('div');
        host.innerHTML =
            '<ul data-each="groups key=id"><li>' +
            '<ol data-each="members key=id"><li><b data-bind-text="name"></b></li></ol>' +
            '</li></ul>';
        document.body.appendChild(host);

        applyBindings({groups: [{id: 1, name: 'Family', members: [{id: 11, name: 'Ada'}]}]}, host);
        flushSync();

        const said = warn.mock.calls.map((c) => c[0]).join('\n');
        expect(said).toContain('data-each="members key=id"');
        expect(said).toContain('{{#each members key=id}}');

        vi.restoreAllMocks();
    });

    it('and the mustache form it names actually works, at depth, with the new names', () => {
        const host = document.createElement('div');
        host.innerHTML =
            '<ul data-each="groups key=id"><li>' +
            '{{#each members key=id}}<b>{{$parents[1].title}}/{{$parentContext.$index}}</b>{{/each}}' +
            '</li></ul>';
        document.body.appendChild(host);

        applyBindings({
            title: 'Contacts',
            groups: [
                {id: 1, name: 'Family', members: [{id: 11, name: 'Ada'}]},
                {id: 2, name: 'Work', members: [{id: 21, name: 'Grace'}, {id: 22, name: 'Alan'}]}
            ]
        }, host);
        flushSync();

        expect([...host.querySelectorAll('b')].map((n) => n.textContent))
            .toEqual(['Contacts/0', 'Contacts/1', 'Contacts/1']);
    });
});
