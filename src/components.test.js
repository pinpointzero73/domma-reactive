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
import {compile} from './template-compiler.js';
import {flushSync, liveComputations} from './graph.js';
import {liveDisposers} from './lifecycle.js';
import {
    collectParams,
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
