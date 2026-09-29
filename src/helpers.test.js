/**
 * Built-in array helpers - see helpers.js. Evaluated through the expression
 * language, because that is the only way a template can reach them, and
 * then once end to end through applyBindings to prove the reads are tracked.
 */

import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {applyBindings, resetApplyWarnings} from './apply-bindings.js';
import {evaluateExpression as evaluate, registerHelper, unregisterHelper} from './expression.js';
import {flushSync} from './graph.js';
import {observable, observableArray} from './observable.js';

let warn;
beforeEach(() => { warn = vi.spyOn(console, 'warn').mockImplementation(() => {}); });
afterEach(() => { warn.mockRestore(); });

const TODOS = [
    {id: 1, title: 'Write', done: true, hours: 2, meta: {tag: 'a'}},
    {id: 2, title: 'test', done: false, hours: 3, meta: {tag: 'b'}},
    {id: 3, title: 'Ship', done: true, hours: 'n/a', meta: {tag: 'a'}}
];

describe('len', () => {
    it('measures arrays, strings, Sets and Maps', () => {
        expect(evaluate('len(xs)', {xs: [1, 2, 3]})).toBe(3);
        expect(evaluate("len('four')")).toBe(4);
        expect(evaluate('len(s)', {s: new Set([1, 2])})).toBe(2);
        expect(evaluate('len(m)', {m: new Map([[1, 1]])})).toBe(1);
    });

    it('is 0 for anything else, without a warning', () => {
        expect(evaluate('len(user.tags)', {user: null})).toBe(0);
        expect(evaluate('len(n)', {n: 5})).toBe(0);
        expect(evaluate('!len(xs)', {xs: []})).toBe(true);
        expect(warn).not.toHaveBeenCalled();
    });

    it('takes an observableArray or an observable directly', () => {
        expect(evaluate('len(xs)', {xs: observableArray([1, 2])})).toBe(2);
        expect(evaluate('len(xs)', {xs: observable([1])})).toBe(1);
        expect(warn).not.toHaveBeenCalled();
    });
});

describe('includes', () => {
    it('finds a value in a list by identity', () => {
        expect(evaluate("includes(tags, 'urgent')", {tags: ['urgent', 'bug']})).toBe(true);
        expect(evaluate("includes(tags, 'nope')", {tags: ['urgent']})).toBe(false);
        expect(evaluate('includes(rows, row)', {rows: TODOS, row: TODOS[1]})).toBe(true);
    });

    it('finds a substring in a string', () => {
        expect(evaluate("includes(email, '@')", {email: 'a@b.c'})).toBe(true);
    });

    it('is false for a missing list', () => {
        expect(evaluate("includes(tags, 'x')", {})).toBe(false);
    });
});

describe('some / every / count / where', () => {
    it('tests a field for truthiness', () => {
        expect(evaluate("some(todos, 'done')", {todos: TODOS})).toBe(true);
        expect(evaluate("every(todos, 'done')", {todos: TODOS})).toBe(false);
        expect(evaluate("count(todos, 'done')", {todos: TODOS})).toBe(2);
        expect(evaluate("where(todos, 'done')", {todos: TODOS}).map((t) => t.id)).toEqual([1, 3]);
    });

    it('tests a field against a value with ===', () => {
        expect(evaluate("count(todos, 'done', false)", {todos: TODOS})).toBe(1);
        expect(evaluate("where(todos, 'meta.tag', 'a')", {todos: TODOS}).map((t) => t.id)).toEqual([1, 3]);
        expect(evaluate("some(todos, 'id', '1')", {todos: TODOS})).toBe(false);
    });

    it('tests the items themselves when no key is given', () => {
        expect(evaluate('count(xs)', {xs: [0, 1, 2]})).toBe(3);
        expect(evaluate('some(xs, null)', {xs: [0, '', 3]})).toBe(true);
        expect(evaluate('where(xs, null, 2)', {xs: [1, 2, 2]})).toEqual([2, 2]);
    });

    it('follows JavaScript on an empty list', () => {
        expect(evaluate("every(xs, 'done')", {xs: []})).toBe(true);
        expect(evaluate("some(xs, 'done')", {xs: []})).toBe(false);
    });

    it('reads observable fields on items', () => {
        const rows = [{done: observable(true)}, {done: observable(false)}];
        expect(evaluate("count(rows, 'done')", {rows})).toBe(1);
    });

    it('never mutates the list', () => {
        const todos = TODOS.slice();
        evaluate("where(todos, 'done')", {todos});
        evaluate("sortBy(todos, 'title')", {todos});
        expect(todos).toEqual(TODOS);
    });
});

describe('sum / pluck / join', () => {
    it('sums items or a field, skipping non-numbers', () => {
        expect(evaluate('sum(xs)', {xs: [1, 2, 3]})).toBe(6);
        expect(evaluate("sum(todos, 'hours')", {todos: TODOS})).toBe(5);
    });

    it('plucks a field', () => {
        expect(evaluate("pluck(todos, 'title')", {todos: TODOS})).toEqual(['Write', 'test', 'Ship']);
    });

    it('joins, with a default separator', () => {
        expect(evaluate("join(pluck(todos, 'title'))", {todos: TODOS})).toBe('Write, test, Ship');
        expect(evaluate("join(xs, ' / ')", {xs: ['a', null, 'c']})).toBe('a /  / c');
    });
});

describe('sortBy / first / last', () => {
    it('sorts strings by locale and numbers numerically', () => {
        expect(evaluate("pluck(sortBy(todos, 'title'), 'id')", {todos: TODOS})).toEqual([3, 2, 1]);
        expect(evaluate('sortBy(xs)', {xs: [10, 9, 100]})).toEqual([9, 10, 100]);
        expect(evaluate("sortBy(xs, null, 'desc')", {xs: [10, 9, 100]})).toEqual([100, 10, 9]);
    });

    it('puts missing values last in either direction', () => {
        const rows = [{n: 2}, {}, {n: 1}];
        expect(evaluate("pluck(sortBy(rows, 'n'), 'n')", {rows})).toEqual([1, 2, undefined]);
        expect(evaluate("pluck(sortBy(rows, 'n', 'desc'), 'n')", {rows})).toEqual([2, 1, undefined]);
    });

    it('gives the ends of a list', () => {
        expect(evaluate('first(xs)', {xs: [1, 2]})).toBe(1);
        expect(evaluate('last(xs)', {xs: [1, 2]})).toBe(2);
        expect(evaluate('first(xs)', {xs: []})).toBeUndefined();
    });
});

describe('the registry', () => {
    it('lets a registered helper override a built-in, and restores it on removal', () => {
        registerHelper('len', () => 'mine');
        expect(evaluate('len(xs)', {xs: [1]})).toBe('mine');
        unregisterHelper('len');
        expect(evaluate('len(xs)', {xs: [1]})).toBe(1);
    });

    it('keeps built-ins out of the data namespace', () => {
        expect(evaluate('len', {})).toBeUndefined();
        expect(evaluate('len(xs)', {xs: [1], len: 'shadow'})).toBe(1);
    });

    it('refuses a blocked key in a path', () => {
        expect(evaluate("pluck(xs, '__proto__')", {xs: [{}]})).toEqual([undefined]);
        expect(warn.mock.calls.flat().join(' ')).toContain('blocked');
    });
});

describe('inside bindings', () => {
    let host;
    beforeEach(() => {
        host = document.createElement('div');
        document.body.appendChild(host);
        resetApplyWarnings();
    });
    afterEach(() => host.remove());

    it('re-runs when the list changes and when a row field changes', () => {
        host.innerHTML = '<p><span data-bind-text="count(todos, \'done\')"></span>/<span data-bind-text="len(todos)"></span></p>';
        const todos = observableArray([{id: 1, done: observable(false)}]);
        const handle = applyBindings({todos}, host);
        const text = () => host.textContent;

        expect(text()).toBe('0/1');

        todos.push({id: 2, done: observable(true)});
        flushSync();
        expect(text()).toBe('1/2');

        todos.peek()[0].done.value = true;
        flushSync();
        expect(text()).toBe('2/2');

        handle.dispose();
    });

    it('drives data-if from an observableArray without .value', () => {
        host.innerHTML = '<div><p data-if="!len(rows)">Empty</p></div>';
        const rows = observableArray([]);
        const handle = applyBindings({rows}, host);

        expect(host.textContent).toBe('Empty');
        rows.push(1);
        flushSync();
        expect(host.textContent).toBe('');

        handle.dispose();
        expect(warn).not.toHaveBeenCalled();
    });

    it('feeds data-each from where(), re-filtering as rows change', () => {
        host.innerHTML = '<ul data-each="where(todos, \'done\', false) key=id"><li data-bind-text="title"></li></ul>';
        const todos = observableArray([
            {id: 1, title: 'a', done: observable(false)},
            {id: 2, title: 'b', done: observable(true)}
        ]);
        const handle = applyBindings({todos}, host);
        const items = () => [...host.querySelectorAll('li')].map((li) => li.textContent);

        expect(items()).toEqual(['a']);

        todos.peek()[1].done.value = false;
        flushSync();
        expect(items()).toEqual(['a', 'b']);

        todos.push({id: 3, title: 'c', done: observable(true)});
        flushSync();
        expect(items()).toEqual(['a', 'b']);

        handle.dispose();
    });
});
