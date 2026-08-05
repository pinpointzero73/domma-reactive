/**
 * Node-scoped disposal.
 *
 * Small module, but the one every leak in M4 routes through: if a disposer
 * registered inside a removed subtree is not found, an instance's effects
 * outlive its DOM and nothing anywhere reports it.
 */

import {beforeEach, describe, expect, it, vi} from 'vitest';

import {
    disposeNode,
    disposeSubtree,
    liveDisposers,
    registerDisposer,
    unregisterDisposer
} from './lifecycle.js';

let host;

beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
});

describe('registerDisposer', () => {
    it('counts a registration and forgets it once run', () => {
        const node = document.createElement('span');
        const base = liveDisposers();

        registerDisposer(node, () => {});
        expect(liveDisposers()).toBe(base + 1);

        disposeNode(node);
        expect(liveDisposers()).toBe(base);
    });

    it('lets several owners register on one node', () => {
        const node = document.createElement('span');
        const ran = [];

        registerDisposer(node, () => ran.push('a'));
        registerDisposer(node, () => ran.push('b'));
        disposeNode(node);

        expect(ran).toEqual(['a', 'b']);
    });

    it('ignores a missing node or a non-function', () => {
        const base = liveDisposers();

        registerDisposer(null, () => {});
        registerDisposer(document.createElement('i'), 'not a function');

        expect(liveDisposers()).toBe(base);
    });

    it('runs each disposer exactly once, however often disposal is asked for', () => {
        const node = document.createElement('span');
        let runs = 0;

        registerDisposer(node, () => { runs++; });
        disposeNode(node);
        disposeNode(node);
        disposeSubtree(node);

        expect(runs).toBe(1);
    });

    it('survives a disposer that removes the node it is registered on', () => {
        // The set is cleared before the disposers run, so re-entering cannot
        // run the same disposer twice.
        const node = document.createElement('span');
        host.appendChild(node);
        let runs = 0;

        registerDisposer(node, () => {
            runs++;
            disposeSubtree(node);
            node.remove();
        });

        disposeNode(node);
        expect(runs).toBe(1);
    });

    it('reports a throwing disposer and carries on with the rest', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const node = document.createElement('span');
        let ran = false;

        registerDisposer(node, () => { throw new Error('bad'); });
        registerDisposer(node, () => { ran = true; });

        expect(() => disposeNode(node)).not.toThrow();
        expect(ran).toBe(true);
        expect(warn).toHaveBeenCalled();
        warn.mockRestore();
    });
});

describe('unregisterDisposer', () => {
    it('drops a registration without running it', () => {
        const node = document.createElement('span');
        const base = liveDisposers();
        let ran = false;
        const fn = () => { ran = true; };

        registerDisposer(node, fn);
        expect(unregisterDisposer(node, fn)).toBe(true);
        expect(liveDisposers()).toBe(base);

        disposeNode(node);
        expect(ran).toBe(false);
    });

    it('reports when there was nothing to drop', () => {
        expect(unregisterDisposer(document.createElement('i'), () => {})).toBe(false);
    });
});

describe('disposeSubtree', () => {
    it('finds a disposer on a descendant element', () => {
        host.innerHTML = '<div><p><b>deep</b></p></div>';
        const deep = host.querySelector('b');
        let ran = false;

        registerDisposer(deep, () => { ran = true; });
        disposeSubtree(host.querySelector('div'));

        expect(ran).toBe(true);
    });

    it('finds a disposer on a descendant COMMENT', () => {
        // This is the one that matters: a list region's identity is its opening
        // comment, and that is where instances hang their teardown. A walk that
        // only visited elements would miss every one of them.
        const wrapper = document.createElement('div');
        const marker = document.createComment('dm:each');
        wrapper.appendChild(marker);
        host.appendChild(wrapper);
        let ran = false;

        registerDisposer(marker, () => { ran = true; });
        disposeSubtree(wrapper);

        expect(ran).toBe(true);
    });

    it('finds a disposer on the root node it is given', () => {
        const node = document.createComment('dm:item');
        let ran = false;

        registerDisposer(node, () => { ran = true; });
        disposeSubtree(node);

        expect(ran).toBe(true);
    });

    it('walks a DocumentFragment as well as an element', () => {
        const fragment = document.createDocumentFragment();
        const child = document.createElement('span');
        fragment.appendChild(child);
        let ran = false;

        registerDisposer(child, () => { ran = true; });
        disposeSubtree(fragment);

        expect(ran).toBe(true);
    });

    it('does nothing at all when nothing is registered', () => {
        host.innerHTML = '<div><p>a</p></div>';
        expect(() => disposeSubtree(host)).not.toThrow();
    });

    it('tolerates a disposer that mutates the tree it is being walked in', () => {
        host.innerHTML = '<div><p><b>1</b></p><p><b>2</b></p></div>';
        const [first, second] = host.querySelectorAll('b');
        const ran = [];

        registerDisposer(first, () => {
            ran.push(1);
            second.parentNode.remove();
        });
        registerDisposer(second, () => ran.push(2));

        disposeSubtree(host.querySelector('div'));

        // Both are found, because the walk collects before it disposes.
        expect(ran).toEqual([1, 2]);
    });
});
