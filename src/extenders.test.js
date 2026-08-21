// src/extenders.test.js
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {observable, observableArray} from './observable.js';
import {effect, flushSync} from './graph.js';
import {registerExtender, unregisterExtender} from './extenders.js';

describe('extend()', () => {
    it('returns the observable, so calls chain', () => {
        const count = observable(0);
        expect(count.extend({notify: 'always'})).toBe(count);
    });

    it('warns once about an extender nobody registered, and changes nothing', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const count = observable(0);
        const seen = [];
        count.subscribe(v => seen.push(v));

        count.extend({nonsense: 1});
        count.value = 1;

        expect(seen).toEqual([1]);
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls[0][0]).toContain('nonsense');
        warn.mockRestore();
    });

    it('is available on an observableArray too', () => {
        const rows = observableArray([]);
        expect(rows.extend({notify: 'always'})).toBe(rows);
    });
});

describe('notify: always', () => {
    it('notifies subscribers on a write the change gate would have swallowed', () => {
        const config = observable({theme: 'dark'});
        const seen = [];
        config.subscribe(v => seen.push(v));

        config.value = {theme: 'dark'};          // deeply equal - normally silent
        expect(seen).toHaveLength(0);

        config.extend({notify: 'always'});
        config.value = {theme: 'dark'};
        expect(seen).toHaveLength(1);
    });

    it('re-runs an effect on an equal write', async () => {
        const count = observable(1).extend({notify: 'always'});
        const body = vi.fn(() => count.value);
        effect(body);
        expect(body).toHaveBeenCalledTimes(1);

        count.value = 1;
        flushSync();
        expect(body).toHaveBeenCalledTimes(2);
    });

    it('overrides an equals comparator given at construction', () => {
        const user = observable({id: 1, seenAt: 0}, {equals: (a, b) => a.id === b.id});
        const seen = [];
        user.subscribe(v => seen.push(v));

        user.value = {id: 1, seenAt: 99};        // same id - the comparator says quiet
        expect(seen).toHaveLength(0);

        user.extend({notify: 'always'});
        user.value = {id: 1, seenAt: 100};
        expect(seen).toHaveLength(1);
    });

    it('warns about a value it does not understand', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        observable(0).extend({notify: 'sometimes'});
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls[0][0]).toContain('always');
        warn.mockRestore();
    });
});

describe('rateLimit', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('holds the notification back for the timeout', () => {
        const query = observable('').extend({rateLimit: 100});
        const seen = [];
        query.subscribe(v => seen.push(v));

        query.value = 'a';
        expect(seen).toHaveLength(0);

        vi.advanceTimersByTime(99);
        expect(seen).toHaveLength(0);

        vi.advanceTimersByTime(1);
        expect(seen).toEqual(['a']);
    });

    it('does not delay the write itself', () => {
        const query = observable('').extend({rateLimit: 100});
        query.value = 'abc';
        expect(query.value).toBe('abc');
        expect(query.peek()).toBe('abc');
    });

    it('collapses a burst into one notification carrying the latest value', () => {
        const query = observable('').extend({rateLimit: 100});
        const seen = [];
        query.subscribe(v => seen.push(v));

        query.value = 'a';
        query.value = 'ab';
        query.value = 'abc';

        vi.advanceTimersByTime(100);
        expect(seen).toEqual(['abc']);
    });

    it('holds the graph back too, so an effect runs once', () => {
        const query = observable('').extend({rateLimit: 100});
        const body = vi.fn(() => query.value);
        effect(body);
        expect(body).toHaveBeenCalledTimes(1);

        query.value = 'a';
        query.value = 'ab';
        flushSync();
        expect(body).toHaveBeenCalledTimes(1);   // nothing has reached the graph yet

        vi.advanceTimersByTime(100);
        flushSync();
        expect(body).toHaveBeenCalledTimes(2);
        expect(query.peek()).toBe('ab');
    });

    it('starts the window again after it has fired', () => {
        const query = observable('').extend({rateLimit: 100});
        const seen = [];
        query.subscribe(v => seen.push(v));

        query.value = 'a';
        vi.advanceTimersByTime(100);
        query.value = 'b';
        vi.advanceTimersByTime(100);

        expect(seen).toEqual(['a', 'b']);
    });

    it('stays quiet when the change gate rejected every write in the window', () => {
        const count = observable(1).extend({rateLimit: 100});
        const seen = [];
        count.subscribe(v => seen.push(v));

        count.value = 1;                          // equal - never reaches the limiter
        vi.advanceTimersByTime(100);
        expect(seen).toHaveLength(0);
    });

    it('pushes the deadline out on every change, by default', () => {
        // notifyWhenChangesStop: the window is quiet-time, not elapsed-time.
        const query = observable('').extend({rateLimit: 100});
        const seen = [];
        query.subscribe(v => seen.push(v));

        query.value = 'a';
        vi.advanceTimersByTime(80);
        query.value = 'ab';
        vi.advanceTimersByTime(80);
        expect(seen).toHaveLength(0);             // 160ms in, but only 80ms quiet

        vi.advanceTimersByTime(20);
        expect(seen).toEqual(['ab']);
    });

    it('holds the deadline fixed under notifyAtFixedRate', () => {
        const query = observable('').extend({
            rateLimit: {timeout: 100, method: 'notifyAtFixedRate'}
        });
        const seen = [];
        query.subscribe(v => seen.push(v));

        query.value = 'a';
        vi.advanceTimersByTime(80);
        query.value = 'ab';
        vi.advanceTimersByTime(20);
        expect(seen).toEqual(['ab']);             // fired 100ms after the FIRST change
    });

    it('rate-limits an observableArray mutator', () => {
        const rows = observableArray([]).extend({rateLimit: 100});
        const seen = [];
        rows.subscribe(v => seen.push(v.length));

        rows.push(1);
        rows.push(2);
        expect(seen).toHaveLength(0);

        vi.advanceTimersByTime(100);
        expect(seen).toEqual([2]);
    });

    it('warns about a timeout that is not a number', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        observable(0).extend({rateLimit: 'soon'});
        expect(warn).toHaveBeenCalledTimes(1);
        warn.mockRestore();
    });

    it('is cancelled by a later rateLimit of zero', () => {
        const query = observable('').extend({rateLimit: 100});
        const seen = [];
        query.subscribe(v => seen.push(v));

        query.extend({rateLimit: 0});
        query.value = 'a';
        expect(seen).toEqual(['a']);              // straight through, no timer
    });
});

describe('throttle', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('is rateLimit under its Knockout name', () => {
        const query = observable('').extend({throttle: 100});
        const seen = [];
        query.subscribe(v => seen.push(v));

        query.value = 'a';
        query.value = 'ab';
        expect(seen).toHaveLength(0);

        vi.advanceTimersByTime(100);
        expect(seen).toEqual(['ab']);
    });
});

describe('registerExtender', () => {
    afterEach(() => unregisterExtender('shout'));

    it('adds an extender that can replace the change gate', () => {
        registerExtender('shout', (control) => control.setEquals(() => false));

        const count = observable(1).extend({shout: true});
        const seen = [];
        count.subscribe(v => seen.push(v));

        count.value = 1;
        expect(seen).toEqual([1]);
    });

    it('adds an extender that can intercept the notification', () => {
        const log = [];
        registerExtender('shout', (control) => {
            control.intercept(next => (value) => {
                log.push(value);
                next(value);
            });
        });

        const count = observable(0).extend({shout: true});
        count.value = 5;
        expect(log).toEqual([5]);
    });

    it('hands the extender its option value and the observable', () => {
        const seen = [];
        registerExtender('shout', (control, value) => {
            seen.push(value, control.observable);
        });

        const count = observable(0);
        count.extend({shout: 42});
        expect(seen).toEqual([42, count]);
    });

    it('refuses a bad name', () => {
        expect(() => registerExtender('', () => {})).toThrow(TypeError);
        expect(() => registerExtender(null, () => {})).toThrow(TypeError);
    });

    it('refuses a handler that is not a function', () => {
        expect(() => registerExtender('shout', 'nope')).toThrow(TypeError);
    });

    it('warns when it replaces one that already exists', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        registerExtender('shout', () => {});
        registerExtender('shout', () => {});
        expect(warn).toHaveBeenCalledTimes(1);
        warn.mockRestore();
    });

    it('reports whether unregistering removed anything', () => {
        registerExtender('shout', () => {});
        expect(unregisterExtender('shout')).toBe(true);
        expect(unregisterExtender('shout')).toBe(false);
    });

    it('refuses to unregister a built-in', () => {
        expect(unregisterExtender('rateLimit')).toBe(false);
        const query = observable('').extend({rateLimit: 0});
        expect(query).toBeTruthy();
    });
});
