/**
 * Binding context.
 *
 * Small module, short suite — but the two assertions that matter are easy to
 * write wrong: that $root survives arbitrary nesting, and that the four names
 * resolve OUTSIDE a block as well as inside one, which is the sentence in
 * design spec §5 most likely to be quietly dropped.
 */

import {describe, expect, it} from 'vitest';
import {
    CONTEXT_KEYS,
    createChildContext,
    createRootContext,
    isContext,
    toContext
} from './context.js';
import {evaluateExpression} from './expression.js';

describe('createRootContext', () => {
    it('makes $data and $root the same object, with no parent and no index', () => {
        const data = {name: 'Ada'};
        const context = createRootContext(data);

        expect(context.$data).toBe(data);
        expect(context.$root).toBe(data);
        expect(context.$parent).toBeNull();
        expect(context.$index).toBeNull();
    });

    it('freezes the context', () => {
        const context = createRootContext({});
        expect(Object.isFrozen(context)).toBe(true);
        expect(() => { 'use strict'; context.$index = 3; }).toThrow(TypeError);
    });

    it('accepts a primitive, or nothing at all', () => {
        expect(createRootContext(7).$data).toBe(7);
        expect(createRootContext(undefined).$data).toBeUndefined();
        expect(createRootContext(null).$root).toBeNull();
    });
});

describe('createChildContext', () => {
    it('points $parent at the enclosing DATA, not at the enclosing context', () => {
        const root = {title: 'People'};
        const item = {name: 'Ada'};
        const child = createChildContext(createRootContext(root), item, 0);

        // $parent.title must work. If $parent were the context, it would be
        // undefined and every template using it would silently blank.
        expect(child.$parent).toBe(root);
        expect(child.$parent.title).toBe('People');
    });

    it('carries $root down through arbitrary nesting', () => {
        const root = {level: 0};
        let context = createRootContext(root);

        for (let i = 1; i <= 5; i++) {
            context = createChildContext(context, {level: i}, i);
        }

        expect(context.$root).toBe(root);
        expect(context.$data.level).toBe(5);
        expect(context.$parent.level).toBe(4);
        expect(context.$index).toBe(5);
    });

    it('promotes a plain parent, so the root need not be built explicitly', () => {
        const root = {a: 1};
        const child = createChildContext(root, {b: 2}, 0);

        expect(child.$root).toBe(root);
        expect(child.$parent).toBe(root);
    });

    it('defaults $index to null rather than undefined', () => {
        // {{#with}} shifts context without an index, and `$index` must still
        // resolve — to null, the documented "not in a list" value.
        expect(createChildContext({}, {}).$index).toBeNull();
        expect(createChildContext({}, {}, undefined).$index).toBeNull();
        expect(createChildContext({}, {}, 0).$index).toBe(0);
    });
});

describe('isContext / toContext', () => {
    it('recognises a context by its $data field', () => {
        expect(isContext(createRootContext({}))).toBe(true);
        expect(isContext({$data: 1})).toBe(true);
        expect(isContext({name: 'Ada'})).toBe(false);
        expect(isContext(null)).toBe(false);
        expect(isContext('string')).toBe(false);
    });

    it('passes a context through untouched, and promotes anything else', () => {
        const context = createRootContext({});
        expect(toContext(context)).toBe(context);

        const data = {name: 'Ada'};
        expect(toContext(data).$data).toBe(data);
    });
});

describe('§5: the four names resolve outside a block too', () => {
    it('resolves $data, $root, $parent and $index against plain data', () => {
        const data = {name: 'Ada'};

        expect(evaluateExpression('$data.name', data)).toBe('Ada');
        expect(evaluateExpression('$root.name', data)).toBe('Ada');
        expect(evaluateExpression('$parent', data)).toBeNull();
        expect(evaluateExpression('$index', data)).toBeNull();
    });

    it('agrees with an explicitly built root context', () => {
        // The evaluator promotes plain data through toContext, so the two
        // routes must be indistinguishable. If they ever diverge, one of the
        // two definitions of "root context" has drifted.
        const data = {name: 'Ada'};

        for (const source of ['$data.name', '$root.name', '$parent', '$index', 'name']) {
            expect(evaluateExpression(source, data), source)
                .toEqual(evaluateExpression(source, createRootContext(data)));
        }
    });

    it('resolves them against a child context inside a list', () => {
        const root = {title: 'People'};
        const child = createChildContext(createRootContext(root), {name: 'Ada'}, 2);

        expect(evaluateExpression('name', child)).toBe('Ada');
        expect(evaluateExpression('$index', child)).toBe(2);
        expect(evaluateExpression('$parent.title', child)).toBe('People');
        expect(evaluateExpression('$root.title', child)).toBe('People');
    });

    it('does not walk the scope chain — a name means $data or nothing', () => {
        const child = createChildContext({title: 'People'}, {name: 'Ada'}, 0);

        // `title` lives on the parent. Resolving it silently would make the
        // meaning of a name depend on data you are not looking at.
        expect(evaluateExpression('title', child)).toBeUndefined();
        expect(evaluateExpression('$parent.title', child)).toBe('People');
    });
});

describe('CONTEXT_KEYS', () => {
    it('lists exactly the seven names, and nothing has drifted', () => {
        expect([...CONTEXT_KEYS].sort())
            .toEqual([
                '$data', '$index', '$length', '$parent',
                '$parentContext', '$parents', '$root'
            ]);
    });
});

describe('$parentContext', () => {
    it('is null at the root', () => {
        expect(createRootContext({a: 1}).$parentContext).toBeNull();
    });

    it('is the enclosing context one level down', () => {
        const root = createRootContext({a: 1});
        expect(createChildContext(root, {b: 2}).$parentContext).toBe(root);
    });

    it('promotes plain data to a root context first', () => {
        const child = createChildContext({a: 1}, {b: 2});
        expect(child.$parentContext.$data).toEqual({a: 1});
        expect(child.$parentContext.$parentContext).toBeNull();
    });

    it('chains, so two levels are reachable', () => {
        const root = createRootContext({a: 1});
        const one = createChildContext(root, {b: 2});
        const two = createChildContext(one, {c: 3});

        expect(two.$parentContext).toBe(one);
        expect(two.$parentContext.$parentContext).toBe(root);
    });
});

describe('$parents', () => {
    it('is empty at the root', () => {
        expect(createRootContext({a: 1}).$parents).toEqual([]);
    });

    it('holds the parent data one level down', () => {
        const root = createRootContext({a: 1});
        expect(createChildContext(root, {b: 2}).$parents).toEqual([{a: 1}]);
    });

    it('is nearest-first, three levels deep', () => {
        const root = createRootContext({n: 'root'});
        const one = createChildContext(root, {n: 'one'});
        const two = createChildContext(one, {n: 'two'});
        const three = createChildContext(two, {n: 'three'});

        expect(three.$parents.map((d) => d.n)).toEqual(['two', 'one', 'root']);
    });

    it('agrees with $parent below the root', () => {
        const root = createRootContext({a: 1});
        const one = createChildContext(root, {b: 2});
        const two = createChildContext(one, {c: 3});

        expect(one.$parents[0]).toBe(one.$parent);
        expect(two.$parents[0]).toBe(two.$parent);
    });

    it('is the one place the two disagree at the root', () => {
        const root = createRootContext({a: 1});
        expect(root.$parent).toBeNull();
        expect(root.$parents[0]).toBeUndefined();
    });

    it('reaches $root data at the far end', () => {
        const root = createRootContext({n: 'root'});
        const two = createChildContext(createChildContext(root, {n: 'one'}), {n: 'two'});
        expect(two.$parents[two.$parents.length - 1]).toBe(two.$root);
    });

    it('yields undefined past the end rather than throwing', () => {
        const child = createChildContext(createRootContext({}), {});
        expect(child.$parents[99]).toBeUndefined();
    });

    it('is frozen, at the root and below it', () => {
        const child = createChildContext(createRootContext({}), {});
        expect(Object.isFrozen(child.$parents)).toBe(true);
        expect(Object.isFrozen(createRootContext({}).$parents)).toBe(true);
    });

    it('is memoised — the same context returns the same array', () => {
        const child = createChildContext(createRootContext({}), {});
        expect(child.$parents).toBe(child.$parents);
    });

    it('does not share an array between sibling contexts', () => {
        const root = createRootContext({});
        expect(createChildContext(root, {n: 'a'}).$parents)
            .not.toBe(createChildContext(root, {n: 'b'}).$parents);
    });

    it('is lazy — a getter, not an eager field', () => {
        const child = createChildContext(createRootContext({}), {});
        const descriptor = Object.getOwnPropertyDescriptor(child, '$parents');

        expect(typeof descriptor.get).toBe('function');
        expect(descriptor.enumerable).toBe(true);
    });
});
