/**
 * Components.
 *
 * The suite is long because a component model is mostly promises about
 * teardown, and teardown is the half that looks fine in the DOM while leaking
 * every effect it ever created. `liveDisposers()` returning to its baseline is
 * the assertion that matters most here; the rendering tests would all pass on
 * an implementation that never disposed anything.
 */

import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {createRootContext} from './context.js';
import {observable, observableArray} from './observable.js';
import {parseFragment} from './nodes.js';
import {applyBindings} from './apply-bindings.js';
import {compile} from './template-compiler.js';
import {flushSync, liveComputations} from './graph.js';
import {liveDisposers} from './lifecycle.js';
import {
    collectParams,
    harvestSlotContent,
    componentDefinition,
    paramName,
    registerComponent,
    resetComponentWarnings,
    unregisterComponent
} from './components.js';

afterEach(() => {
    unregisterComponent('probe');
    resetComponentWarnings();
    vi.restoreAllMocks();
});

describe('registerComponent', () => {
    it('returns the definition, so a registration can be inlined', () => {
        const def = {template: '<b>hi</b>'};
        expect(registerComponent('probe', def)).toBe(def);
    });

    it('makes the definition findable', () => {
        const def = {template: '<b>hi</b>'};
        registerComponent('probe', def);
        expect(componentDefinition('probe')).toBe(def);
    });

    it('rejects a name that is not a non-empty string', () => {
        expect(() => registerComponent('', {template: 'x'})).toThrow(TypeError);
        expect(() => registerComponent(null, {template: 'x'})).toThrow(TypeError);
    });

    it('rejects a definition with no template', () => {
        expect(() => registerComponent('probe', {})).toThrow(TypeError);
        expect(() => registerComponent('probe', {template: 42})).toThrow(TypeError);
    });

    it('rejects a create that is not a function', () => {
        expect(() => registerComponent('probe', {template: 'x', create: 1})).toThrow(TypeError);
    });

    it('warns when it replaces an existing registration', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        registerComponent('probe', {template: 'a'});
        registerComponent('probe', {template: 'b'});
        expect(warn).toHaveBeenCalledOnce();
        expect(warn.mock.calls[0][0]).toContain('probe');
    });
});

describe('unregisterComponent', () => {
    it('reports whether there was one', () => {
        registerComponent('probe', {template: 'x'});
        expect(unregisterComponent('probe')).toBe(true);
        expect(unregisterComponent('probe')).toBe(false);
        expect(componentDefinition('probe')).toBeUndefined();
    });
});

/** One element from a markup string. */
function el(html) {
    return parseFragment(html).firstElementChild;
}

describe('paramName', () => {
    it('leaves a single word alone', () => {
        expect(paramName('contact')).toBe('contact');
    });

    it('camelCases a kebab name', () => {
        expect(paramName('first-name')).toBe('firstName');
        expect(paramName('a-b-c')).toBe('aBC');
    });
});

describe('collectParams', () => {
    const binding = {id: 'b1', expr: "'probe'"};

    it('reads a named param', () => {
        const node = el(`<div data-component="'probe'" data-param-label="title"></div>`);
        const params = collectParams(node, binding, createRootContext({title: 'Ada'}));
        expect(params).toEqual({label: 'Ada'});
    });

    it('camelCases the attribute suffix', () => {
        const node = el(`<div data-param-first-name="who"></div>`);
        expect(collectParams(node, binding, createRootContext({who: 'Ada'}))).toEqual({firstName: 'Ada'});
    });

    it('passes an observable by reference', () => {
        const name = observable('Ada');
        const node = el(`<div data-param-name="who"></div>`);
        const params = collectParams(node, binding, createRootContext({who: name}));

        expect(params.name).toBe(name);
        params.name.value = 'Grace';
        expect(name.value).toBe('Grace');
    });

    it('passes a snapshot when the expression reads .value', () => {
        const name = observable('Ada');
        const node = el(`<div data-param-name="who.value"></div>`);
        const params = collectParams(node, binding, createRootContext({who: name}));

        expect(params.name).toBe('Ada');
        name.value = 'Grace';
        expect(params.name).toBe('Ada');
    });

    it('reads the object form', () => {
        const node = el(`<div data-params="bag"></div>`);
        const params = collectParams(node, binding, createRootContext({bag: {a: 1, b: 2}}));
        expect(params).toEqual({a: 1, b: 2});
    });

    it('merges both, with the named attribute winning', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const node = el(`<div data-params="bag" data-param-a="override"></div>`);
        const params = collectParams(node, binding, createRootContext({bag: {a: 1, b: 2}, override: 9}));

        expect(params).toEqual({a: 9, b: 2});
        expect(warn).toHaveBeenCalledOnce();
        expect(warn.mock.calls[0][0]).toContain('a');
    });

    it('is frozen', () => {
        const node = el(`<div data-param-a="x"></div>`);
        const params = collectParams(node, binding, createRootContext({x: 1}));
        expect(Object.isFrozen(params)).toBe(true);
    });

    it('warns once and omits the param when its expression will not parse', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const node = el(`<div data-param-a="((("></div>`);
        const params = collectParams(node, binding, createRootContext({}));

        expect('a' in params).toBe(false);
        expect(warn).toHaveBeenCalled();
    });

    it('warns when data-params is not an object', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const node = el(`<div data-params="nope"></div>`);
        expect(collectParams(node, binding, createRootContext({nope: 5}))).toEqual({});
        expect(warn).toHaveBeenCalled();
    });

    it('is empty when there are no params at all', () => {
        const node = el(`<div data-component="'probe'"></div>`);
        expect(collectParams(node, binding, createRootContext({}))).toEqual({});
    });
});

/** Compile markup against data in a live host, reactively. */
function mount(markup, data) {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const controller = compile(markup, data, host, undefined, {reactive: true});
    return {host, controller};
}

describe('mounting', () => {
    it('renders a template-only component, with params as $data', () => {
        registerComponent('probe', {template: '<b data-bind-text="label"></b>'});

        const {host} = mount(`<div data-component="'probe'" data-param-label="who"></div>`, {who: 'Ada'});

        expect(host.querySelector('b').textContent).toBe('Ada');
    });

    it('renders a component with a view model', () => {
        registerComponent('probe', {
            template: '<b data-bind-text="shouted.value"></b>',
            create: (params) => ({shouted: observable(params.label.toUpperCase())})
        });

        const {host} = mount(`<div data-component="'probe'" data-param-label="who"></div>`, {who: 'Ada'});

        expect(host.querySelector('b').textContent).toBe('ADA');
    });

    it('gives the view model the host element as info.element', () => {
        let seen = null;
        registerComponent('probe', {
            template: '<b></b>',
            create: (params, info) => { seen = info.element; return {}; }
        });

        const {host} = mount(`<div id="slot" data-component="'probe'"></div>`, {});

        expect(seen).toBe(host.querySelector('#slot'));
        expect(seen.querySelector('b')).not.toBeNull();   // mounted inside its element
    });

    it('writes back to the parent through an observable param', () => {
        const name = observable('Ada');
        registerComponent('probe', {
            template: '<b></b>',
            create: (params) => { params.name.value = 'Grace'; return {}; }
        });

        mount(`<div data-component="'probe'" data-param-name="who"></div>`, {who: name});

        expect(name.value).toBe('Grace');
    });

    it('keeps the host element, its attributes and its identity', () => {
        registerComponent('probe', {template: '<b>x</b>'});

        const {host} = mount(`<div id="slot" class="card" data-component="'probe'"></div>`, {});
        const slot = host.querySelector('#slot');

        expect(slot.className).toBe('card');
        expect(slot.querySelector('b').textContent).toBe('x');
    });

    it('replaces whatever was inside the host element', () => {
        registerComponent('probe', {template: '<b>new</b>'});

        const {host} = mount(`<div data-component="'probe'"><i>old</i></div>`, {});

        expect(host.querySelector('i')).toBeNull();
        expect(host.querySelector('b').textContent).toBe('new');
    });

    it('resolves $component inside a nested each in the component template', () => {
        registerComponent('probe', {
            template: '{{#each rows key=id}}<li data-bind-text="$component.title"></li>{{/each}}',
            create: () => ({title: 'T', rows: [{id: 1}, {id: 2}]})
        });

        const {host} = mount(`<ul data-component="'probe'"></ul>`, {});
        flushSync();

        expect([...host.querySelectorAll('li')].map((li) => li.textContent)).toEqual(['T', 'T']);
    });

    it('reaches the page through $parents from inside a component', () => {
        registerComponent('probe', {
            template: '<b data-bind-text="$parents[0].title"></b>',
            create: () => ({})
        });

        const {host} = mount(`<div data-component="'probe'"></div>`, {title: 'Page'});

        expect(host.querySelector('b').textContent).toBe('Page');
    });
});

describe('lifecycle', () => {
    it('calls dispose() on the view model when the component goes away', () => {
        const disposed = vi.fn();
        registerComponent('probe', {template: '<b></b>', create: () => ({dispose: disposed})});

        const {controller} = mount(`<div data-component="'probe'"></div>`, {});
        controller.destroy();

        expect(disposed).toHaveBeenCalledOnce();
    });

    it('swaps the component when the name changes, disposing the old one exactly once', () => {
        const goneA = vi.fn();
        registerComponent('probe', {template: '<b>A</b>', create: () => ({dispose: goneA})});
        registerComponent('probe-b', {template: '<i>B</i>'});

        const which = observable('probe');
        const {host} = mount(`<div data-component="which.value"></div>`, {which});
        expect(host.querySelector('b')).not.toBeNull();

        which.value = 'probe-b';
        flushSync();

        expect(host.querySelector('b')).toBeNull();
        expect(host.querySelector('i').textContent).toBe('B');
        expect(goneA).toHaveBeenCalledOnce();

        unregisterComponent('probe-b');
    });

    it('does not rebuild when an unrelated update runs and the name is unchanged', () => {
        const created = vi.fn(() => ({}));
        registerComponent('probe', {template: '<b></b>', create: created});

        const which = observable('probe');
        mount(`<div data-component="which.value"></div>`, {which});

        which.value = 'probe';
        flushSync();

        expect(created).toHaveBeenCalledOnce();
    });

    it('leaves no disposers behind after teardown', () => {
        const before = liveDisposers();
        registerComponent('probe', {
            template: '<b data-bind-text="x.value"></b>',
            create: () => ({x: observable(1)})
        });

        const {controller} = mount(`<div data-component="'probe'"></div>`, {});
        controller.destroy();

        expect(liveDisposers()).toBe(before);
    });

    it('leaves no live computations behind after teardown', () => {
        const before = liveComputations();
        registerComponent('probe', {
            template: '<b data-bind-text="x.value"></b>',
            create: () => ({x: observable(1)})
        });

        const {controller} = mount(`<div data-component="'probe'"></div>`, {});
        controller.destroy();

        expect(liveComputations()).toBe(before);
    });

    it('leaves nothing behind across repeated swaps', () => {
        registerComponent('probe', {
            template: '<b data-bind-text="x.value"></b>',
            create: () => ({x: observable(1)})
        });
        registerComponent('probe-b', {template: '<i>B</i>'});

        const which = observable('probe');
        const {controller} = mount(`<div data-component="which.value"></div>`, {which});
        const afterFirst = liveDisposers();

        for (let i = 0; i < 5; i++) {
            which.value = i % 2 === 0 ? 'probe-b' : 'probe';
            flushSync();
        }
        which.value = 'probe';
        flushSync();

        expect(liveDisposers()).toBe(afterFirst);

        controller.destroy();
        unregisterComponent('probe-b');
    });

    it('keeps its instance when a sibling row is removed from an enclosing list', () => {
        registerComponent('probe', {template: '<b data-bind-text="id"></b>'});

        const rows = observableArray([{id: 1}, {id: 2}]);
        const {host} = mount(
            `{{#each rows key=id}}<li><div data-component="'probe'" data-params="$data"></div></li>{{/each}}`,
            {rows}
        );
        flushSync();

        const first = host.querySelector('b');
        expect(first.textContent).toBe('1');

        rows.remove((r) => r.id === 2);
        flushSync();

        expect(host.querySelectorAll('b').length).toBe(1);
        expect(host.querySelector('b')).toBe(first);
    });
});

describe('failure is never fatal', () => {
    beforeEach(() => resetComponentWarnings());

    it('warns once for an unknown component and leaves the host empty', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const {host} = mount(`<div data-component="'nope'"></div><p>after</p>`, {});

        expect(warn).toHaveBeenCalledOnce();
        expect(warn.mock.calls[0][0]).toContain('nope');
        expect(host.querySelector('p').textContent).toBe('after');
    });

    it('warns once when the name is not a string', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        mount(`<div data-component="n"></div>`, {n: 42});
        expect(warn).toHaveBeenCalledOnce();
    });

    it('says that a literal name needs quotes, because that is the likely mistake', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        mount(`<div data-component="n"></div>`, {n: 42});
        expect(warn.mock.calls[0][0]).toContain("data-component=\"'my-thing'\"");
    });

    it('warns once when create() throws, and renders nothing', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        registerComponent('probe', {template: '<b>x</b>', create: () => { throw new Error('boom'); }});

        const {host} = mount(`<div data-component="'probe'"></div>`, {});

        expect(warn).toHaveBeenCalledOnce();
        expect(host.querySelector('b')).toBeNull();
    });

    it('warns but completes teardown when dispose() throws', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        registerComponent('probe', {
            template: '<b>x</b>',
            create: () => ({dispose() { throw new Error('boom'); }})
        });

        const {controller, host} = mount(`<div data-component="'probe'"></div>`, {});
        expect(() => controller.destroy()).not.toThrow();

        expect(warn).toHaveBeenCalled();
        expect(host.querySelector('b')).toBeNull();
    });

    it('warns once for data-param-* with no data-component', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        mount(`<div data-param-a="x"></div>`, {x: 1});
        expect(warn).toHaveBeenCalledOnce();
        expect(warn.mock.calls[0][0]).toContain('data-param-a');
    });

    it('does not warn for data-param-* alongside a data-component', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        registerComponent('probe', {template: '<b data-bind-text="a"></b>'});
        mount(`<div data-component="'probe'" data-param-a="x"></div>`, {x: 1});
        expect(warn).not.toHaveBeenCalled();
    });
});

describe('through applyBindings', () => {
    /** Activate a component in DOM that already exists, as a server-rendered page has. */
    function activate(markup, data) {
        const host = parseFragment(`<div>${markup}</div>`).firstElementChild;
        document.body.appendChild(host);
        return {host, handle: applyBindings(data, host)};
    }

    it('renders a component in already-rendered DOM', () => {
        registerComponent('probe', {template: '<b data-bind-text="label"></b>'});

        const {host, handle} = activate(
            `<div data-component="'probe'" data-param-label="who"></div>`,
            {who: 'Ada'}
        );

        expect(host.querySelector('b').textContent).toBe('Ada');
        handle.dispose();
    });

    it('disposes the view model when the handle is disposed', () => {
        const disposed = vi.fn();
        registerComponent('probe', {template: '<b></b>', create: () => ({dispose: disposed})});

        const {handle} = activate(`<div data-component="'probe'"></div>`, {});
        handle.dispose();

        expect(disposed).toHaveBeenCalledOnce();
    });

    it('swaps on a dynamic name here too', () => {
        registerComponent('probe', {template: '<b>A</b>'});
        registerComponent('probe-b', {template: '<i>B</i>'});

        const which = observable('probe');
        const {host, handle} = activate(`<div data-component="which.value"></div>`, {which});
        expect(host.querySelector('b')).not.toBeNull();

        which.value = 'probe-b';
        flushSync();

        expect(host.querySelector('i').textContent).toBe('B');

        handle.dispose();
        unregisterComponent('probe-b');
    });

    it('works inside a data-each row, which is the applyBindings list spelling', () => {
        registerComponent('probe', {template: '<b data-bind-text="id"></b>'});

        const rows = observableArray([{id: 1}, {id: 2}]);
        const {host, handle} = activate(
            `<ul data-each="rows key=id"><li><div data-component="'probe'" data-params="$data"></div></li></ul>`,
            {rows}
        );
        flushSync();

        expect([...host.querySelectorAll('b')].map((b) => b.textContent)).toEqual(['1', '2']);

        handle.dispose();
    });
});

describe('harvestSlotContent', () => {
    it('puts unlabelled children in the default slot', () => {
        const node = el(`<div><b>one</b><i>two</i></div>`);
        const map = harvestSlotContent(node);

        expect(map.get('').map((n) => n.tagName)).toEqual(['B', 'I']);
    });

    it('keys labelled children by their data-slot', () => {
        const node = el(`<div><h2 data-slot="header">h</h2><p>body</p></div>`);
        const map = harvestSlotContent(node);

        expect(map.get('header').map((n) => n.tagName)).toEqual(['H2']);
        expect(map.get('').map((n) => n.tagName)).toEqual(['P']);
    });

    it('groups several elements into one named slot, in document order', () => {
        const node = el(`<div><b data-slot="a">1</b><i data-slot="a">2</i></div>`);
        expect(harvestSlotContent(node).get('a').map((n) => n.textContent)).toEqual(['1', '2']);
    });

    it('detaches what it harvests, leaving the host empty', () => {
        const node = el(`<div><b>one</b></div>`);
        harvestSlotContent(node);

        expect(node.childNodes.length).toBe(0);
    });

    it('does not dispose what it harvests - the outer runtime owns it', () => {
        const node = el(`<div><b>one</b></div>`);
        const b = node.firstElementChild;
        harvestSlotContent(node);

        expect(b.isConnected).toBe(false);
        expect(b.textContent).toBe('one');
    });

    it('returns an empty map for a host with no children', () => {
        expect(harvestSlotContent(el(`<div></div>`)).size).toBe(0);
    });

    it('sends text nodes to the default slot', () => {
        const node = el(`<div>bare text</div>`);
        expect(harvestSlotContent(node).get('')).toHaveLength(1);
    });
});

describe('slots', () => {
    it('projects the default slot', () => {
        registerComponent('probe', {template: '<div class="frame">{{#slot}}{{/slot}}</div>'});

        const {host} = mount(`<div data-component="'probe'"><b>hello</b></div>`, {});

        expect(host.querySelector('.frame b').textContent).toBe('hello');
    });

    it('projects named slots', () => {
        registerComponent('probe', {
            template: '<header>{{#slot header}}{{/slot}}</header><main>{{#slot}}{{/slot}}</main>'
        });

        const {host} = mount(
            `<div data-component="'probe'"><h2 data-slot="header">H</h2><p>B</p></div>`, {}
        );

        expect(host.querySelector('header h2').textContent).toBe('H');
        expect(host.querySelector('main p').textContent).toBe('B');
    });

    it('renders the fallback when nothing is projected', () => {
        registerComponent('probe', {template: '<div>{{#slot}}<i>default</i>{{/slot}}</div>'});

        const {host} = mount(`<div data-component="'probe'"></div>`, {});

        expect(host.querySelector('i').textContent).toBe('default');
    });

    it('does not render the fallback when something is projected', () => {
        registerComponent('probe', {template: '<div>{{#slot}}<i>default</i>{{/slot}}</div>'});

        const {host} = mount(`<div data-component="'probe'"><b>given</b></div>`, {});

        expect(host.querySelector('i')).toBeNull();
        expect(host.querySelector('b').textContent).toBe('given');
    });

    it('resolves the fallback against the COMPONENT view model', () => {
        registerComponent('probe', {
            template: '<div>{{#slot}}<i data-bind-text="mine"></i>{{/slot}}</div>',
            create: () => ({mine: 'component'})
        });

        const {host} = mount(`<div data-component="'probe'"></div>`, {mine: 'page'});

        expect(host.querySelector('i').textContent).toBe('component');
    });

    it('resolves projected content against the OUTER context', () => {
        registerComponent('probe', {
            template: '<div>{{#slot}}{{/slot}}</div>',
            create: () => ({who: 'component'})
        });

        const {host} = mount(
            `<div data-component="'probe'"><b data-bind-text="who"></b></div>`,
            {who: 'page'}
        );

        expect(host.querySelector('b').textContent).toBe('page');
    });

    it('keeps projected content live after projection', () => {
        registerComponent('probe', {template: '<div>{{#slot}}{{/slot}}</div>'});

        const who = observable('Ada');
        const {host} = mount(
            `<div data-component="'probe'"><b data-bind-text="who.value"></b></div>`, {who}
        );
        expect(host.querySelector('b').textContent).toBe('Ada');

        who.value = 'Grace';
        flushSync();

        expect(host.querySelector('b').textContent).toBe('Grace');
    });

    it('lets a projected data-model write back to the page', () => {
        registerComponent('probe', {template: '<div>{{#slot}}{{/slot}}</div>'});

        const name = observable('Ada');
        const {host} = mount(
            `<div data-component="'probe'"><input data-model="name.value"></div>`, {name}
        );

        const input = host.querySelector('input');
        input.value = 'Grace';
        input.dispatchEvent(new Event('input', {bubbles: true}));
        flushSync();

        expect(name.value).toBe('Grace');
    });

    it('anchors a slot inside a tbody, where an element spelling cannot go', () => {
        registerComponent('probe', {
            template: '<table><tbody>{{#slot}}<tr><td>fallback</td></tr>{{/slot}}</tbody></table>'
        });

        const {host} = mount(`<div data-component="'probe'"></div>`, {});

        // The anchors survived inside <tbody>; <dm-slot> would have been
        // hoisted out of the table by the parser before any of this ran.
        expect(host.querySelector('table tbody tr td').textContent).toBe('fallback');
    });

    it('projects real rows when the host is itself a tbody', () => {
        registerComponent('probe', {template: '{{#slot}}{{/slot}}'});

        // The usage site has to be valid HTML too: <tr> is only kept by the
        // parser inside a table context, so the host element is the <tbody>.
        const {host} = mount(
            `<table><tbody data-component="'probe'"><tr><td>cell</td></tr></tbody></table>`,
            {}
        );

        expect(host.querySelector('tbody tr td').textContent).toBe('cell');
    });
});
