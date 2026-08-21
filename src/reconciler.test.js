/**
 * Keyed reconciliation, per-item bindings, and instance lifecycle (M4).
 *
 * Two of these tests carry more weight than the rest, and both are easy to write
 * in a form that proves nothing:
 *
 *   NODE IDENTITY. A test that checks the list "still says the right thing"
 *   after a change passes just as happily against the old implementation, which
 *   threw every node away and rendered new ones saying the same thing. So every
 *   identity assertion here compares NODE OBJECTS with `toBe`, and the mutation
 *   log in the report shows it going red when reuse is removed.
 *
 *   NO LEAKS. A disposed instance leaves the DOM looking perfect and the
 *   dependency graph one Computation heavier, for ever. The only evidence is the
 *   count, so the count is what is asserted - before and after, back to baseline.
 */

import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {compile, componentFactory, resetUnkeyedWarnings} from './template-compiler.js';
import {flushSync, liveComputations} from './graph.js';
import {liveDisposers} from './lifecycle.js';
import {observable, observableArray} from './observable.js';
import {createInstance, resetReconcilerWarnings} from './reconciler.js';
import {createComponentContext, createRootContext} from './context.js';
import {render} from './support/mini-render.js';

let host;

beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    resetUnkeyedWarnings();
    resetReconcilerWarnings();
});

afterEach(() => {
    host.remove();
});

/** The list's rendered rows, by text. */
const texts = (selector = 'li') => [...host.querySelectorAll(selector)].map((el) => el.textContent);

/** The list's rendered rows, by node. */
const nodes = (selector = 'li') => [...host.querySelectorAll(selector)];

// ── Rendering ─────────────────────────────────────────────────────────────────

describe('a keyed {{#each}} renders', () => {
    it('one instance per item', () => {
        const data = {items: [{id: 1, name: 'a'}, {id: 2, name: 'b'}]};
        compile('<ul>{{#each items key=id}}<li>{{name}}</li>{{/each}}</ul>', data, host);

        expect(texts()).toEqual(['a', 'b']);
    });

    it('nothing at all for an empty collection', () => {
        compile('<ul>{{#each items key=id}}<li>{{name}}</li>{{/each}}</ul>', {items: []}, host);

        expect(texts()).toEqual([]);
        expect(host.querySelector('ul').children.length).toBe(0);
    });

    it('nothing for a collection that is not an array yet', () => {
        // A list that has not loaded is a normal state, not an error.
        compile('<ul>{{#each items key=id}}<li>{{name}}</li>{{/each}}</ul>', {}, host);

        expect(texts()).toEqual([]);
    });

    it('an observableArray directly, without .value at the call site', () => {
        const items = observableArray([{id: 1, name: 'a'}]);
        compile('<ul>{{#each items key=id}}<li>{{name}}</li>{{/each}}</ul>', {items}, host);

        expect(texts()).toEqual(['a']);
    });

    it('leaves no unsubstituted mustache in a cloned item', () => {
        // An instance is cloned from a <template>, not rendered from a string,
        // so nothing substitutes a token the compiler did not bind. Domma's
        // space-separated helper form is one such token: it produces no binding
        // here and no output in the renderer either, so the skeleton has to
        // strip it rather than leave it sitting in the page as literal text.
        const data = {rows: [{id: 1, name: 'a'}]};
        compile('{{#each rows key=id}}<li>{{name}}|{{upper name}}</li>{{/each}}', data, host);

        expect(host.innerHTML).not.toContain('{{');
        expect(texts()).toEqual(['a|']);
    });

    it('leaves no mustache source in the annotated template', () => {
        // The block is removed outright: leaving it would have the renderer
        // paint a second, unmanaged copy of the list before the reconciler ran.
        const data = {items: [{id: 1, name: 'a'}]};
        compile('<ul>{{#each items key=id}}<li>{{name}}</li>{{/each}}</ul>', data, host);

        expect(host.innerHTML).not.toContain('{{');
        expect(texts()).toEqual(['a']);
    });
});

// ── Node identity ─────────────────────────────────────────────────────────────

describe('node identity survives a collection change', () => {
    let data;
    let controller;

    beforeEach(() => {
        data = {items: [{id: 1, n: 'a'}, {id: 2, n: 'b'}, {id: 3, n: 'c'}]};
        controller = compile(
            '<ul>{{#each items key=id}}<li>{{n}}</li>{{/each}}</ul>', data, host
        );
    });

    const change = (next) => {
        data.items = next;
        controller.updateAll(data);
    };

    it('for every unchanged key across an append', () => {
        const before = nodes();

        change([...data.items, {id: 4, n: 'd'}]);

        const after = nodes();
        expect(texts()).toEqual(['a', 'b', 'c', 'd']);
        expect(after[0]).toBe(before[0]);
        expect(after[1]).toBe(before[1]);
        expect(after[2]).toBe(before[2]);
    });

    it('for every unchanged key across a prepend', () => {
        const before = nodes();

        change([{id: 0, n: 'z'}, ...data.items]);

        const after = nodes();
        expect(texts()).toEqual(['z', 'a', 'b', 'c']);
        expect(after.slice(1)).toEqual(before);
    });

    it('for the survivors of a removal from the middle', () => {
        const [first, , third] = nodes();

        change([data.items[0], data.items[2]]);

        expect(texts()).toEqual(['a', 'c']);
        expect(nodes()[0]).toBe(first);
        expect(nodes()[1]).toBe(third);
    });

    it('across a reversal, where every item moves', () => {
        const before = nodes();

        change([...data.items].reverse());

        expect(texts()).toEqual(['c', 'b', 'a']);
        expect(nodes()).toEqual([before[2], before[1], before[0]]);
    });

    it('across a shuffle that keeps every key', () => {
        const before = nodes();

        change([data.items[1], data.items[2], data.items[0]]);

        expect(nodes()).toEqual([before[1], before[2], before[0]]);
    });

    it('when an item object is replaced but its key is not', () => {
        const before = nodes();

        // Same identity, new contents - the row is updated in place rather
        // than rebuilt.
        change([{id: 1, n: 'A'}, data.items[1], data.items[2]]);

        expect(texts()).toEqual(['A', 'b', 'c']);
        expect(nodes()[0]).toBe(before[0]);
    });

    it('but NOT when the key changes, because that is a different item', () => {
        const before = nodes();

        change([{id: 99, n: 'a'}, data.items[1], data.items[2]]);

        expect(texts()).toEqual(['a', 'b', 'c']);
        expect(nodes()[0]).not.toBe(before[0]);
    });
});

describe('what node identity is worth', () => {
    it('an uncommitted edit below an insertion is not clobbered', () => {
        const data = {rows: [{id: 1, name: 'a'}, {id: 2, name: 'b'}]};
        const controller = compile(
            '{{#each rows key=id}}<input data-model="name">{{/each}}', data, host
        );

        const [, second] = [...host.querySelectorAll('input')];
        second.value = 'half-typed';

        data.rows = [{id: 0, name: 'z'}, ...data.rows];
        controller.updateAll(data);

        const after = [...host.querySelectorAll('input')];
        expect(after).toHaveLength(3);
        expect(after[2]).toBe(second);
        expect(after[2].value).toBe('half-typed');
    });

    it('focus stays where the user put it', () => {
        const data = {rows: [{id: 1}, {id: 2}, {id: 3}]};
        const controller = compile(
            '{{#each rows key=id}}<input data-bind-value="id">{{/each}}', data, host
        );

        const target = host.querySelectorAll('input')[2];
        target.focus();
        expect(document.activeElement).toBe(target);

        data.rows = [{id: 9}, ...data.rows];
        controller.updateAll(data);

        expect(document.activeElement).toBe(target);
    });
});

// ── Per-item bindings and contexts ────────────────────────────────────────────

describe('bindings inside a keyed block', () => {
    it('resolve names against the item, not the root', () => {
        const data = {name: 'ROOT', rows: [{id: 1, name: 'a'}]};
        compile('{{#each rows key=id}}<b>{{name}}</b>{{/each}}', data, host);

        expect(host.querySelector('b').textContent).toBe('a');
    });

    it('expose $index, $data, $parent and $root', () => {
        const data = {title: 'T', rows: [{id: 1, n: 'a'}, {id: 2, n: 'b'}]};
        compile(
            '{{#each rows key=id}}<li>{{$index}}|{{$root.title}}|{{$parent.title}}|{{$data.n}}</li>{{/each}}',
            data, host
        );

        expect(texts()).toEqual(['0|T|T|a', '1|T|T|b']);
    });

    it('expose the renderer loop forms too, so key= is not a downgrade', () => {
        const data = {rows: [{id: 1, n: 'a'}, {id: 2, n: 'b'}, {id: 3, n: 'c'}]};
        compile(
            '{{#each rows key=id}}<li>{{@index}}/{{@first}}/{{@last}}</li>{{/each}}',
            data, host
        );

        expect(texts()).toEqual(['0/true/false', '1/false/false', '2/false/true']);
    });

    it('handle {{.}} for a list of primitives', () => {
        // Primitives have no key property; position is the honest fallback and
        // it says so once.
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        compile('{{#each rows key=id}}<li>{{.}}</li>{{/each}}', {rows: ['x', 'y']}, host);

        expect(texts()).toEqual(['x', 'y']);
        expect(warn.mock.calls.flat().join('\n')).toMatch(/missing/);
        warn.mockRestore();
    });

    it('wire an event listener per item, with $data as `this`', () => {
        const clicked = [];
        const data = {
            rows: [{id: 1, n: 'a'}, {id: 2, n: 'b'}],
            pick() { clicked.push(this.n); }
        };
        compile(
            '{{#each rows key=id}}<button data-on-click="$root.pick">{{n}}</button>{{/each}}',
            data, host
        );

        host.querySelectorAll('button')[1].click();
        expect(clicked).toEqual(['b']);
    });

    it('wire a two-way binding per item, writing back to that item', () => {
        const data = {rows: [{id: 1, name: 'a'}, {id: 2, name: 'b'}]};
        compile('{{#each rows key=id}}<input data-model="name">{{/each}}', data, host);

        const second = host.querySelectorAll('input')[1];
        second.value = 'edited';
        second.dispatchEvent(new Event('input'));

        expect(data.rows[1].name).toBe('edited');
        expect(data.rows[0].name).toBe('a');
    });

    it('wire data-bind-* per item', () => {
        const data = {rows: [{id: 1, on: true}, {id: 2, on: false}]};
        compile(
            '{{#each rows key=id}}<li data-bind-class="on && \'active\'"></li>{{/each}}',
            data, host
        );

        expect(nodes()[0].className).toBe('active');
        expect(nodes()[1].className).toBe('');
    });

    it('wire data-if per item', () => {
        const data = {rows: [{id: 1, on: true}, {id: 2, on: false}]};
        compile(
            '{{#each rows key=id}}<li><b data-if="on">yes</b></li>{{/each}}', data, host
        );

        expect(nodes()[0].querySelector('b')).not.toBeNull();
        expect(nodes()[1].querySelector('b')).toBeNull();
    });

    it('render a nested {{#if}} from the item', () => {
        const data = {rows: [{id: 1, on: true}, {id: 2, on: false}]};
        compile(
            '{{#each rows key=id}}<li>{{#if on}}shown{{/if}}</li>{{/each}}', data, host
        );

        expect(texts()).toEqual(['shown', '']);
    });

    it('nest one keyed list inside another, with $parent reaching the outer item', () => {
        const data = {
            groups: [
                {id: 'g1', title: 'G1', rows: [{id: 1, n: 'a'}, {id: 2, n: 'b'}]},
                {id: 'g2', title: 'G2', rows: [{id: 3, n: 'c'}]}
            ]
        };
        compile(
            '{{#each groups key=id}}<ul>{{#each rows key=id}}<li>{{$parent.title}}:{{n}}</li>{{/each}}</ul>{{/each}}',
            data, host
        );

        expect(texts()).toEqual(['G1:a', 'G1:b', 'G2:c']);
    });

    it('keeps inner node identity when only the outer list is reordered', () => {
        const data = {
            groups: [
                {id: 'g1', rows: [{id: 1, n: 'a'}]},
                {id: 'g2', rows: [{id: 2, n: 'b'}]}
            ]
        };
        const controller = compile(
            '{{#each groups key=id}}<ul>{{#each rows key=id}}<li>{{n}}</li>{{/each}}</ul>{{/each}}',
            data, host
        );

        const before = nodes();
        data.groups = [...data.groups].reverse();
        controller.updateAll(data);

        expect(texts()).toEqual(['b', 'a']);
        expect(nodes()).toEqual([before[1], before[0]]);
    });

    it('does not confuse an item binding with a page binding of the same id', () => {
        // Both the outer template and the item body number their bindings from
        // zero. Without per-template id namespacing the outer runtime - which
        // walks every node beneath it, item content included - hands an item's
        // node to the page's binding.
        const data = {heading: 'H', rows: [{id: 1, n: 'a'}]};
        compile(
            '<h1>{{heading}}</h1>{{#each rows key=id}}<li>{{n}}</li>{{/each}}', data, host
        );

        expect(host.querySelector('h1').textContent).toBe('H');
        expect(texts()).toEqual(['a']);
    });
});

// ── Reactivity ────────────────────────────────────────────────────────────────

describe('an instance follows its own data', () => {
    it('updates one row when only that row changes, leaving the rest alone', () => {
        const rows = observableArray([{id: 1, n: 'a'}, {id: 2, n: 'b'}]);
        compile(
            '{{#each rows key=id}}<li>{{n}}</li>{{/each}}',
            {rows}, host, undefined, {reactive: true}
        );

        const before = nodes();
        rows.splice(1, 1, {id: 2, n: 'B'});
        flushSync();

        expect(texts()).toEqual(['a', 'B']);
        expect(nodes()[0]).toBe(before[0]);
    });

    it('turns a push into an insertion, not a re-render', () => {
        const rows = observableArray([{id: 1, n: 'a'}]);
        compile(
            '{{#each rows key=id}}<li>{{n}}</li>{{/each}}',
            {rows}, host, undefined, {reactive: true}
        );

        const before = nodes()[0];
        rows.push({id: 2, n: 'b'});
        flushSync();

        expect(texts()).toEqual(['a', 'b']);
        expect(nodes()[0]).toBe(before);
    });
});

// ── Keys ──────────────────────────────────────────────────────────────────────

describe('keys', () => {
    it('warn once, and fall back to re-rendering, when key= is absent', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const data = {rows: [{id: 1, n: 'a'}]};
        const controller = compile('{{#each rows}}<li>{{n}}</li>{{/each}}', data, host);

        const message = warn.mock.calls.flat().join('\n');
        expect(message).toMatch(/has no key=/);
        expect(message).toMatch(/key=id/);

        // Still renders - the fallback is Tier 3 behaviour, not an error.
        expect(texts()).toEqual(['a']);

        const before = nodes()[0];
        data.rows = [{id: 1, n: 'a'}, {id: 2, n: 'b'}];
        controller.updateAll(data);

        expect(texts()).toEqual(['a', 'b']);
        // …and that is exactly what it costs: the surviving row is a new node.
        expect(nodes()[0]).not.toBe(before);

        warn.mockRestore();
    });

    it('warn about a duplicate key rather than dropping a row', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        compile(
            '{{#each rows key=id}}<li>{{n}}</li>{{/each}}',
            {rows: [{id: 1, n: 'a'}, {id: 1, n: 'b'}]}, host
        );

        expect(texts()).toEqual(['a', 'b']);
        expect(warn.mock.calls.flat().join('\n')).toMatch(/share key=/);
        warn.mockRestore();
    });

    it('take a dotted key path', () => {
        const data = {rows: [{meta: {ref: 'x'}, n: 'a'}, {meta: {ref: 'y'}, n: 'b'}]};
        const controller = compile(
            '{{#each rows key=meta.ref}}<li>{{n}}</li>{{/each}}', data, host
        );

        const before = nodes();
        data.rows = [data.rows[1], data.rows[0]];
        controller.updateAll(data);

        expect(texts()).toEqual(['b', 'a']);
        expect(nodes()).toEqual([before[1], before[0]]);
    });

    it('treat 0 and "" as real keys, not as missing ones', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        compile(
            '{{#each rows key=id}}<li>{{n}}</li>{{/each}}',
            {rows: [{id: 0, n: 'a'}, {id: '', n: 'b'}]}, host
        );

        expect(texts()).toEqual(['a', 'b']);
        expect(warn.mock.calls.flat().join('\n')).not.toMatch(/missing/);
        warn.mockRestore();
    });
});

// ── Awkward shapes ────────────────────────────────────────────────────────────

describe('a keyed block in an awkward place', () => {
    it('renders inside a table, where the HTML parser is fussy', () => {
        // A <template> parses <tr> correctly at the top level; a <div> does not.
        const data = {rows: [{id: 1, n: 'a'}, {id: 2, n: 'b'}]};
        compile(
            '<table><tbody>{{#each rows key=id}}<tr><td>{{n}}</td></tr>{{/each}}</tbody></table>',
            data, host
        );

        expect(texts('td')).toEqual(['a', 'b']);
    });

    it('handles void elements in the item body', () => {
        const data = {rows: [{id: 1, src: '/x.png', n: 'a'}]};
        compile(
            '{{#each rows key=id}}<li><img src="{{src}}"><br>{{n}}</li>{{/each}}', data, host
        );

        expect(host.querySelector('img').getAttribute('src')).toBe('/x.png');
        expect(texts()).toEqual(['a']);
    });

    it('survives an empty item body', () => {
        const data = {rows: [{id: 1}, {id: 2}]};
        const controller = compile('{{#each rows key=id}}{{/each}}', data, host);

        expect(() => controller.updateAll(data)).not.toThrow();
    });

    it('keeps two sibling lists apart', () => {
        const data = {a: [{id: 1, n: 'a'}], b: [{id: 1, n: 'b'}]};
        const controller = compile(
            '<ul>{{#each a key=id}}<li>{{n}}</li>{{/each}}</ul>' +
            '<ol>{{#each b key=id}}<li>{{n}}</li>{{/each}}</ol>',
            data, host
        );

        expect(texts('ul li')).toEqual(['a']);
        expect(texts('ol li')).toEqual(['b']);

        // Same key value in both lists, and they do not collide.
        data.a = [{id: 1, n: 'A'}];
        controller.updateAll(data);

        expect(texts('ul li')).toEqual(['A']);
        expect(texts('ol li')).toEqual(['b']);
    });

    it('demotes a keyed block inside an UNKEYED one rather than rendering nothing', () => {
        /*
         * The collection expression of the inner block would be evaluated
         * against the top-level data, where `rows` means nothing - so it would
         * render an empty list on a page that looks finished. Demoting it to a
         * re-rendered block gets the right output at the cost of reconciliation,
         * and says so.
         */
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const data = {groups: [{rows: [{id: 1, n: 'a'}]}, {rows: [{id: 2, n: 'b'}]}]};

        compile(
            '{{#each groups}}<ul>{{#each rows key=id}}<li>{{n}}</li>{{/each}}</ul>{{/each}}',
            data, host
        );

        expect(texts()).toEqual(['a', 'b']);
        expect(warn.mock.calls.flat().join('\n')).toMatch(/demoted/);
        warn.mockRestore();
    });

    it('demotes a keyed block inside a {{#with}} for the same reason', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const data = {page: {rows: [{id: 1, n: 'a'}]}};

        compile(
            '{{#with page}}<ul>{{#each rows key=id}}<li>{{n}}</li>{{/each}}</ul>{{/with}}',
            data, host
        );

        expect(texts()).toEqual(['a']);
        expect(warn.mock.calls.flat().join('\n')).toMatch(/demoted/);
        warn.mockRestore();
    });

    it('does NOT demote a keyed block inside another keyed one', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const data = {groups: [{id: 'g', rows: [{id: 1, n: 'a'}]}]};

        const controller = compile(
            '{{#each groups key=id}}<ul>{{#each rows key=id}}<li>{{n}}</li>{{/each}}</ul>{{/each}}',
            data, host
        );

        expect(texts()).toEqual(['a']);
        expect(warn.mock.calls.flat().join('\n')).not.toMatch(/demoted/);

        // …and it really is reconciling: the inner node survives an outer change.
        const before = nodes()[0];
        data.groups = [{id: 'g', rows: [{id: 1, n: 'a'}, {id: 2, n: 'b'}]}];
        controller.updateAll(data);

        expect(texts()).toEqual(['a', 'b']);
        expect(nodes()[0]).toBe(before);

        warn.mockRestore();
    });
});

// ── Disposal ──────────────────────────────────────────────────────────────────

describe('disposal', () => {
    it('drops the effects of a row that leaves the collection', () => {
        const data = {rows: [{id: 1, n: 'a'}, {id: 2, n: 'b'}]};
        const controller = compile(
            '{{#each rows key=id}}<li>{{n}}</li>{{/each}}', data, host
        );

        const withTwo = liveComputations();

        data.rows = [data.rows[0]];
        controller.updateAll(data);

        expect(texts()).toEqual(['a']);
        expect(liveComputations()).toBeLessThan(withTwo);
    });

    it('drops every instance when an enclosing {{#if}} closes over the list', () => {
        const before = liveComputations();
        const data = {show: true, rows: [{id: 1, n: 'a'}, {id: 2, n: 'b'}]};
        const controller = compile(
            '{{#if show}}{{#each rows key=id}}<li>{{n}}</li>{{/each}}{{/if}}', data, host
        );

        expect(liveComputations()).toBeGreaterThan(before);

        data.show = false;
        controller.updateAll(data);

        expect(texts()).toEqual([]);
        expect(liveComputations()).toBe(before);
    });

    it('drops every instance on controller.destroy()', () => {
        // A controller's own bindings own no effects in the default mode - the
        // caller wires those. Its list instances DO, and nothing else is in a
        // position to dispose them, so destroy() has to reach them.
        const before = liveComputations();
        const data = {rows: [{id: 1, n: 'a'}, {id: 2, n: 'b'}]};
        const controller = compile(
            '{{#each rows key=id}}<li>{{n}}</li>{{/each}}', data, host
        );

        expect(liveComputations()).toBeGreaterThan(before);

        controller.destroy();

        expect(liveComputations()).toBe(before);
    });

    it('drops the effect of a binding a nested {{#if}} has hidden', () => {
        // An instance owns an effect per binding, including bindings that are
        // not currently rendered. When a region inside the item closes over
        // one, its effect has nothing left to write to and has to go - or a row
        // that toggles a detail panel leaks one Computation per toggle.
        const before = liveComputations();
        const data = {rows: [{id: 1, show: true, n: 'a'}]};
        const controller = compile(
            '{{#each rows key=id}}<li>{{#if show}}<b data-bind-text="n"></b>{{/if}}</li>{{/each}}',
            data, host
        );

        const withInner = liveComputations();
        expect(host.querySelector('b')).not.toBeNull();

        data.rows = [{id: 1, show: false, n: 'a'}];
        controller.updateAll(data);

        expect(host.querySelector('b')).toBeNull();
        expect(liveComputations()).toBeLessThan(withInner);

        controller.destroy();
        expect(liveComputations()).toBe(before);
    });

    it('removes a row\'s listeners along with its nodes', () => {
        const clicked = [];
        const data = {rows: [{id: 1}], hit() { clicked.push(1); }};
        const controller = compile(
            '{{#each rows key=id}}<button data-on-click="$root.hit"></button>{{/each}}',
            data, host
        );

        const button = host.querySelector('button');
        button.click();
        expect(clicked).toHaveLength(1);

        data.rows = [];
        controller.updateAll(data);

        // Detached, and deaf.
        button.click();
        expect(clicked).toHaveLength(1);
    });
});

// ── The leak test ─────────────────────────────────────────────────────────────

describe('heavy churn leaks nothing', () => {
    it('returns the Computation count to its baseline', () => {
        const baseComputations = liveComputations();

        const data = {rows: []};
        const controller = compile(
            '{{#each rows key=id}}<li>{{n}}<b data-if="on">!</b></li>{{/each}}', data, host
        );

        // Measured after compiling: the region itself registers one disposer,
        // which lives as long as the region does and is not churn.
        const afterCompile = liveComputations();
        const baseDisposers = liveDisposers();

        let peak = 0;
        for (let round = 0; round < 100; round++) {
            data.rows = Array.from({length: 20}, (unused, i) => ({
                id: (round * 7 + i) % 40,
                n: `r${round}-${i}`,
                on: (round + i) % 2 === 0
            }));
            controller.updateAll(data);
            peak = Math.max(peak, liveComputations());
        }

        // Proof the churn was real: at 20 rows with two bindings each plus a
        // revealed one, the graph was carrying dozens of live computations.
        expect(peak).toBeGreaterThan(20);

        data.rows = [];
        controller.updateAll(data);

        expect(liveComputations()).toBe(afterCompile);
        expect(liveComputations()).toBe(baseComputations);
        expect(liveDisposers()).toBe(baseDisposers);

        controller.destroy();
    });

    it('returns to baseline when the whole list is torn down by an {{#if}}', () => {
        const baseComputations = liveComputations();
        const baseDisposers = liveDisposers();

        const data = {show: true, rows: []};
        const controller = compile(
            '{{#if show}}{{#each rows key=id}}<li>{{n}}</li>{{/each}}{{/if}}', data, host
        );

        for (let round = 0; round < 50; round++) {
            data.show = true;
            data.rows = Array.from({length: 10}, (unused, i) => ({id: i, n: `x${round}${i}`}));
            controller.updateAll(data);

            data.show = false;
            controller.updateAll(data);
        }

        controller.destroy();

        expect(liveComputations()).toBe(baseComputations);
        expect(liveDisposers()).toBe(baseDisposers);
    });
});

// ── Property-based ────────────────────────────────────────────────────────────

/**
 * A seeded generator, so a failure is reproducible from the seed printed with it.
 * mulberry32: small, fast, and good enough for shuffling a list of six things.
 */
function rng(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

const TEMPLATE = '<ul>{{#each rows key=id}}<li class="row">{{n}}#{{$index}}</li>{{/each}}</ul>';

/** Strip everything that is bookkeeping rather than output. */
function normalise(html) {
    return html
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/\s*data-dm-[\w-]+="[^"]*"/g, '');
}

/** The reference implementation: compile the same template from scratch. */
function fullRender(rows) {
    const fresh = document.createElement('div');
    document.body.appendChild(fresh);
    const controller = compile(TEMPLATE, {rows}, fresh);
    const html = normalise(fresh.innerHTML);
    controller.destroy();
    fresh.remove();
    return html;
}

/** Every mutation a real list gets put through. */
const MUTATIONS = [
    (rows, random, next) => [...rows, next()],                       // push
    (rows, random, next) => [next(), ...rows],                       // unshift
    (rows) => rows.slice(0, -1),                                     // pop
    (rows) => rows.slice(1),                                         // shift
    (rows, random) => {                                              // remove one
        if (rows.length === 0) return rows;
        const at = Math.floor(random() * rows.length);
        return [...rows.slice(0, at), ...rows.slice(at + 1)];
    },
    (rows, random, next) => {                                        // insert one
        const at = Math.floor(random() * (rows.length + 1));
        return [...rows.slice(0, at), next(), ...rows.slice(at)];
    },
    (rows) => [...rows].reverse(),                                   // reverse
    (rows, random) => {                                              // move one
        if (rows.length < 2) return rows;
        const from = Math.floor(random() * rows.length);
        const to = Math.floor(random() * rows.length);
        const copy = [...rows];
        copy.splice(to, 0, ...copy.splice(from, 1));
        return copy;
    },
    (rows, random) => {                                              // swap two
        if (rows.length < 2) return rows;
        const copy = [...rows];
        const i = Math.floor(random() * copy.length);
        const j = Math.floor(random() * copy.length);
        [copy[i], copy[j]] = [copy[j], copy[i]];
        return copy;
    },
    (rows, random) => {                                              // edit one
        if (rows.length === 0) return rows;
        const at = Math.floor(random() * rows.length);
        const copy = [...rows];
        copy[at] = {...copy[at], n: `${copy[at].n}'`};
        return copy;
    },
    () => [],                                                        // clear
    (rows, random, next) => [next(), next(), next()]                 // replace wholesale
];

describe('property: any sequence of mutations lands where a full render would', () => {
    const CASES = 250;
    const STEPS = 14;

    /*
     * 3,500 reconciles, each checked against a reference render that compiles
     * the whole template from scratch - so 7,000 compiles in all. That lands
     * within a second or two of vitest's 5s default, which is close enough to
     * fail intermittently on a loaded machine and say nothing useful when it
     * does. The budget is explicit rather than borrowed.
     */
    const BUDGET = 60_000;

    it(`holds for ${CASES} random sequences of ${STEPS} mutations`, () => {
        const baseComputations = liveComputations();

        for (let seed = 1; seed <= CASES; seed++) {
            const random = rng(seed);
            let nextId = 0;
            const next = () => ({id: nextId++, n: `v${nextId}`});

            let rows = [next(), next(), next()];
            const data = {rows};
            const controller = compile(TEMPLATE, data, host);

            /** key → the element rendering it, as of the previous step. */
            let seen = new Map();
            const snapshot = () => {
                const map = new Map();
                const elements = [...host.querySelectorAll('li')];
                rows.forEach((row, i) => map.set(row.id, elements[i]));
                return map;
            };
            seen = snapshot();

            for (let step = 0; step < STEPS; step++) {
                const mutate = MUTATIONS[Math.floor(random() * MUTATIONS.length)];
                const before = rows;
                rows = mutate(rows, random, next);
                data.rows = rows;
                controller.updateAll(data);

                const where = `seed ${seed}, step ${step}, ` +
                    `${before.length} → ${rows.length} rows`;

                // 1. The DOM matches what rendering the whole thing produces.
                expect(normalise(host.innerHTML), where).toBe(fullRender(rows));

                // 2. Every key that survived kept the SAME NODE OBJECT. This is
                //    the assertion the milestone exists for; a test comparing
                //    text would pass against a full re-render.
                const now = snapshot();
                for (const [key, element] of now) {
                    if (!seen.has(key)) continue;
                    const survivor = before.some((row) => row.id === key);
                    if (!survivor) continue;
                    expect(element, `${where}: node identity for key ${key}`)
                        .toBe(seen.get(key));
                }
                seen = now;
            }

            controller.destroy();
            host.replaceChildren();
        }

        // 3. And 250 sequences of churn left nothing behind.
        expect(liveComputations()).toBe(baseComputations);
    }, BUDGET);
});

// ── $length, and the cost of asking for it ────────────────────────────────────

describe('$length and {{@last}}', () => {
    it('keeps @last correct as the collection grows', () => {
        const data = {rows: [{id: 1}, {id: 2}]};
        const controller = compile(
            '{{#each rows key=id}}<li>{{@last}}</li>{{/each}}', data, host
        );

        expect(texts()).toEqual(['false', 'true']);

        data.rows = [...data.rows, {id: 3}];
        controller.updateAll(data);

        // The row that used to be last has to be told it no longer is.
        expect(texts()).toEqual(['false', 'false', 'true']);
    });

    it('keeps $length correct as the collection shrinks', () => {
        const data = {rows: [{id: 1}, {id: 2}, {id: 3}]};
        const controller = compile(
            '{{#each rows key=id}}<li>{{$index}}/{{$length}}</li>{{/each}}', data, host
        );

        expect(texts()).toEqual(['0/3', '1/3', '2/3']);

        data.rows = data.rows.slice(0, 2);
        controller.updateAll(data);

        expect(texts()).toEqual(['0/2', '1/2']);
    });

    it('is null outside a list, so it resolves everywhere', () => {
        compile('<p>{{$length}}|{{$index}}</p>', {}, host);
        expect(host.querySelector('p').textContent).toBe('|');
    });
});

// ── compile({reactive: true}) ─────────────────────────────────────────────────

describe('compile in reactive mode', () => {
    it('follows observables at the top level as well as inside a list', () => {
        const title = observable('first');
        const rows = observableArray([{id: 1, n: 'a'}]);

        const controller = compile(
            '<h1 data-bind-text="title.value"></h1>{{#each rows key=id}}<li>{{n}}</li>{{/each}}',
            {title, rows}, host, undefined, {reactive: true}
        );

        expect(host.querySelector('h1').textContent).toBe('first');

        title.value = 'second';
        rows.push({id: 2, n: 'b'});
        flushSync();

        expect(host.querySelector('h1').textContent).toBe('second');
        expect(texts()).toEqual(['a', 'b']);

        controller.destroy();
    });

    it('disposes its own effects on destroy, not just the instances\'', () => {
        const before = liveComputations();
        const title = observable('x');

        const controller = compile(
            '<h1 data-bind-text="title.value"></h1>',
            {title}, host, undefined, {reactive: true}
        );
        expect(liveComputations()).toBeGreaterThan(before);

        controller.destroy();
        expect(liveComputations()).toBe(before);

        title.value = 'y';
        flushSync();
        expect(host.querySelector('h1').textContent).toBe('x');
    });

    it('does not let a region effect swallow its children\'s dependencies', () => {
        /*
         * If the {{#if}}'s effect were credited with everything its children
         * read, changing `name` would re-render the whole region - replacing
         * the <b> with a new node on every keystroke. Node identity across an
         * unrelated change is the observable proof that attribution is right.
         */
        const open = observable(true);
        const name = observable('a');

        const controller = compile(
            '{{#if open.value}}<b data-bind-text="name.value"></b>{{/if}}',
            {open, name}, host, undefined, {reactive: true}
        );

        const b = host.querySelector('b');
        expect(b.textContent).toBe('a');

        name.value = 'z';
        flushSync();

        expect(host.querySelector('b')).toBe(b);
        expect(b.textContent).toBe('z');

        controller.destroy();
    });
});

// ── Items marked destroyed ────────────────────────────────────────────────────

describe('keyed list - destroyed items', () => {
    it('drops a destroyed item from the DOM and disposes its instance', () => {
        const rows = observableArray([{id: 1, name: 'Ada'}, {id: 2, name: 'Grace'}]);
        const controller = compile(
            '<ul>{{#each rows key=id}}<li>{{name}}</li>{{/each}}</ul>',
            {rows: rows.peek()}, host, undefined, {reactive: true}
        );

        expect(host.querySelectorAll('li')).toHaveLength(2);
        const baseline = liveComputations();

        const grace = rows.peek()[1];
        rows.destroy(grace);
        controller.updateAll({rows: rows.peek()});

        expect(host.querySelectorAll('li')).toHaveLength(1);
        expect(host.textContent).toContain('Ada');
        expect(host.textContent).not.toContain('Grace');
        expect(liveComputations()).toBeLessThan(baseline);

        controller.destroy();
    });

    it('keeps the node identity of the rows that survive', () => {
        const rows = observableArray([{id: 1, name: 'Ada'}, {id: 2, name: 'Grace'}]);
        const controller = compile(
            '<ul>{{#each rows key=id}}<li>{{name}}</li>{{/each}}</ul>',
            {rows: rows.peek()}, host
        );

        const ada = host.querySelector('li');
        rows.destroy(rows.peek()[1]);
        controller.updateAll({rows: rows.peek()});

        expect(host.querySelector('li')).toBe(ada);
        controller.destroy();
    });
});

describe('ancestor names through a real nested render', () => {
    /**
     * The compiler discovers `each` from mustache syntax; `data-each` is the
     * applyBindings spelling and is tested there. Same createChildContext, two
     * routes in, so both are worth pinning.
     */
    function nested(body) {
        const host = document.createElement('div');
        document.body.appendChild(host);

        compile(
            `{{#each groups key=id}}<div>{{#each members key=id}}${body}{{/each}}</div>{{/each}}`,
            {
                title: 'Contacts',
                groups: [
                    {id: 1, name: 'Family', members: [{id: 11, name: 'Ada'}]},
                    {id: 2, name: 'Work', members: [{id: 21, name: 'Grace'}, {id: 22, name: 'Alan'}]}
                ]
            },
            host, undefined, {reactive: true}
        );
        flushSync();

        return (selector) => [...host.querySelectorAll(selector)].map((n) => n.textContent);
    }

    it('reaches ancestor data past the immediate parent', () => {
        const text = nested(
            '<b data-bind-text="$parents[0].name"></b>' +
            '<s data-bind-text="$parents[1].title"></s>' +
            '<u data-bind-text="$parents.length"></u>'
        );

        // [0] is the group, which $parent already reached.
        expect(text('b')).toEqual(['Family', 'Work', 'Work']);

        // [1] is the root, which nothing could reach before.
        expect(text('s')).toEqual(['Contacts', 'Contacts', 'Contacts']);

        // The group, then the root.
        expect(text('u')).toEqual(['2', '2', '2']);
    });

    it('reaches the enclosing position, which no amount of ancestor data can give', () => {
        const text = nested(
            '<i data-bind-text="$parentContext.$index"></i>' +
            '<e data-bind-text="$parentContext.$length"></e>'
        );

        expect(text('i')).toEqual(['0', '1', '1']);
        expect(text('e')).toEqual(['2', '2', '2']);
    });

    it('renders empty past the end rather than throwing', () => {
        expect(() => nested('<b data-bind-text="$parents[99].name"></b>')).not.toThrow();
    });

    /**
     * The three tests above assert the FIRST render, which is where this went
     * wrong for four versions.
     *
     * `refresh` decides whether an instance needs a new context by comparing
     * the parent context's `$data` and `$root` - never the context itself,
     * because it is a fresh object on every update and comparing identity
     * would refresh everything, always. Reordering the OUTER list changes
     * neither of those for an inner item: same group object, same root, same
     * member, same inner index. So the nodes moved and `$parentContext.$index`
     * went on reporting the position the group used to be in.
     *
     * `$parents[0].name` is asserted alongside precisely because it is
     * ancestor DATA and was always correct - it is the evidence that the list
     * really did reorder, which is what makes a stale index stale rather than
     * a list that never moved.
     */
    it('follows the outer list when it reorders', () => {
        const data = {
            title: 'Contacts',
            groups: [
                {id: 1, name: 'Family', members: [{id: 11, name: 'Ada'}]},
                {id: 2, name: 'Work', members: [{id: 21, name: 'Grace'}]}
            ]
        };

        const controller = compile(
            '{{#each groups key=id}}<div>{{#each members key=id}}' +
            '<i data-bind-text="$parentContext.$index"></i>' +
            '<b data-bind-text="$parents[0].name"></b>' +
            '{{/each}}</div>{{/each}}',
            data, host
        );

        expect(texts('i')).toEqual(['0', '1']);
        expect(texts('b')).toEqual(['Family', 'Work']);

        data.groups = [...data.groups].reverse();
        controller.updateAll(data);

        expect(texts('b')).toEqual(['Work', 'Family']);
        expect(texts('i')).toEqual(['0', '1']);
    });
});

describe('createInstance with a caller-supplied context', () => {
    it('uses the supplied context rather than building a child one', () => {
        const factory = componentFactory('<b data-bind-text="label"></b>', 'test', render, {});
        const vm = {label: 'ada'};
        const parent = createRootContext({});

        const instance = createInstance(factory, parent, vm, null, null, {
            context: createComponentContext(parent, vm)
        });

        expect(instance.runtime.context().$component).toBe(vm);
        expect(instance.runtime.context().$data).toBe(vm);
        instance.dispose();
    });

    it('builds a child context when none is supplied, as a list item needs', () => {
        const factory = componentFactory('<b data-bind-text="label"></b>', 'test', render, {});
        const instance = createInstance(factory, createRootContext({}), {label: 'ada'}, 2, 5);

        expect(instance.runtime.context().$component).toBeNull();
        expect(instance.runtime.context().$index).toBe(2);
        instance.dispose();
    });
});
