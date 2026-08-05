// src/expression.test.js
//
// M2: the CSP-safe expression evaluator.
//
// Three things are being proved here, in descending order of how much they
// matter:
//
//   1. It cannot execute arbitrary code. No dynamic code construction in the
//      source, only registered helpers are callable, and the routes into the
//      prototype chain are shut — including the one that only exists at
//      runtime, `a[key]` where key holds '__proto__'.
//   2. It cannot take a render down. Every malformed input, every hostile
//      input and every helper that throws yields a warning and `undefined`.
//   3. It parses what the design spec says it parses, with JavaScript's own
//      precedence and associativity — because an expression that quietly means
//      something other than it reads is worse than one that fails.
//
// ── On the parse cache ───────────────────────────────────────────────────────
// The cache is a module global, and a failed parse warns only on a cache MISS
// (by design — otherwise a broken binding warns once per render forever). Every
// test that asserts on a warning therefore clears the cache first, which the
// global beforeEach does.

import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {readFileSync, readdirSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

import {
    MAX_DEPTH,
    clearExpressionCache,
    compileExpression,
    evaluateAst,
    evaluateExpression,
    expressionDependencies,
    parseExpression,
    registerHelper,
    unregisterHelper
} from './expression.js';

const evaluate = (source, context) => evaluateExpression(source, context);

let warn;

beforeEach(() => {
    clearExpressionCache();
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
    warn.mockRestore();
});

// ── The data every table case resolves against ───────────────────────────────

const DATA = Object.freeze({
    n: 3,
    zero: 0,
    empty: '',
    name: 'bob',
    flag: true,
    off: false,
    nothing: null,
    key: 'name',
    proto: '__proto__',
    user: {name: 'ada', address: {city: 'London'}, tags: ['x', 'y']},
    items: [10, 20, 30],
    café: 'au lait',
    имя: 'Ада'
});

/** Run a [source, expected] table. */
function table(cases, context = DATA) {
    for (const [source, expected] of cases) {
        it(`evaluates ${JSON.stringify(source)} to ${JSON.stringify(expected)}`, () => {
            expect(evaluate(source, context)).toEqual(expected);
        });
    }
}

// ── Literals ─────────────────────────────────────────────────────────────────

describe('expression - literals', () => {
    table([
        ['1', 1],
        ['0', 0],
        ['42', 42],
        ['1.5', 1.5],
        ['0.25', 0.25],
        ['1e3', 1000],
        ['1E3', 1000],
        ['1.5e2', 150],
        ['2e-2', 0.02],
        ['2e+2', 200],
        ["'hello'", 'hello'],
        ['"hello"', 'hello'],
        ["''", ''],
        ['"it\'s"', "it's"],
        ["'say \"hi\"'", 'say "hi"'],
        ["'a\\nb'", 'a\nb'],
        ["'a\\tb'", 'a\tb'],
        ["'a\\\\b'", 'a\\b'],
        ["'a\\'b'", "a'b"],
        ["'\\u00e9'", 'é'],
        ['true', true],
        ['false', false],
        ['null', null],
        // Unicode is data, not an exotic case: strings pass through verbatim.
        ["'日本語'", '日本語'],
        ["'👍 done'", '👍 done'],
        ["'naïve café'", 'naïve café']
    ]);

    it('treats `undefined` as an ordinary lookup that finds nothing', () => {
        // It is not a keyword. It resolves against $data like any other name,
        // which happens to give exactly the value the author expected.
        expect(evaluate('undefined', DATA)).toBeUndefined();
    });
});

// ── Paths and indexing ───────────────────────────────────────────────────────

describe('expression - paths and indexing', () => {
    table([
        ['n', 3],
        ['user', DATA.user],
        ['user.name', 'ada'],
        ['user.address.city', 'London'],
        ['items[0]', 10],
        ['items[2]', 30],
        ['items[1 + 1]', 30],
        ['user.tags[1]', 'y'],
        ["user['name']", 'ada'],
        ['user[key]', 'ada'],
        ['items.length', 3],
        ['user.name.length', 3],
        // Unicode identifiers.
        ['café', 'au lait'],
        ['имя', 'Ада']
    ]);

    it('yields undefined for a missing name rather than failing', () => {
        expect(evaluate('nope', DATA)).toBeUndefined();
        expect(warn).not.toHaveBeenCalled();
    });

    it('stops at a null or undefined link instead of throwing', () => {
        expect(evaluate('nothing.deep.deeper', DATA)).toBeUndefined();
        expect(evaluate('nope.at.all', DATA)).toBeUndefined();
        expect(warn).not.toHaveBeenCalled();
    });

    it('reads through a prototype, because getters live there', () => {
        // The guard blocks the routes INTO the prototype chain, not reads of
        // inherited members. A model's computed getter is a prototype
        // accessor, and templates read those constantly.
        class Person {
            constructor(first, last) {
                this.first = first;
                this.last = last;
            }

            get full() {
                return `${this.first} ${this.last}`;
            }
        }

        expect(evaluate('p.full', {p: new Person('Ada', 'Lovelace')})).toBe('Ada Lovelace');
    });
});

// ── Operators ────────────────────────────────────────────────────────────────

describe('expression - operators', () => {
    table([
        // Arithmetic.
        ['1 + 2', 3],
        ['5 - 2', 3],
        ['3 * 4', 12],
        ['12 / 4', 3],
        ['7 % 3', 1],
        ['n + 1', 4],
        // + is also concatenation, per §7.
        ["'a' + 'b'", 'ab'],
        ["user.name + '!'", 'ada!'],
        ["'n is ' + n", 'n is 3'],
        // Unary.
        ['-5', -5],
        ['-n', -3],
        ['+n', 3],
        ["+'4'", 4],
        ['!flag', false],
        ['!off', true],
        ['!!n', true],
        ['!nope', true],
        // Comparison.
        ['1 < 2', true],
        ['2 < 1', false],
        ['2 <= 2', true],
        ['3 > 2', true],
        ['2 >= 3', false],
        ['n === 3', true],
        ['n !== 3', false],
        ["user.name === 'ada'", true],
        // Strict, so no coercion.
        ["n === '3'", false],
        ["n !== '3'", true],
        // Logical.
        ['flag && n', 3],
        ['off && n', false],
        ['off || n', 3],
        ['flag || n', true],
        ['zero || n', 3],
        ['empty || n', 3],
        // Ternary.
        ["n > 0 ? 'some' : 'none'", 'some'],
        ["zero > 0 ? 'some' : 'none'", 'none'],
        ['flag ? user.name : n', 'ada']
    ]);

    it('divides by zero the way JavaScript does', () => {
        expect(evaluate('1 / 0')).toBe(Infinity);
        expect(evaluate('0 / 0')).toBeNaN();
    });
});

// ── Precedence and associativity ─────────────────────────────────────────────

describe('expression - precedence', () => {
    // The classic. If the precedence table is wrong this is 9, and every one
    // of the cases below moves with it.
    table([
        ['1 + 2 * 3', 7],
        ['2 * 3 + 1', 7],
        ['(1 + 2) * 3', 9],
        ['1 + 2 * 3 - 4 / 2', 5],
        ['2 + 3 % 2', 3],
        ['10 - 2 * 3', 4],

        // Comparison binds looser than arithmetic.
        ['1 + 2 < 4', true],
        ['1 < 2 + 3', true],

        // Equality binds looser than comparison.
        ['1 < 2 === true', true],
        ['2 < 1 === false', true],

        // && binds tighter than ||.
        ['true || false && false', true],
        ['(true || false) && false', false],
        ['false && false || true', true],

        // Unary binds tighter than any binary operator...
        ['!false && false', false],
        ['-2 + 3', 1],
        ['-2 * 3', -6],
        // ...but looser than member access.
        ['-user.tags.length', -2],
        ['!user.name', false],

        // Ternary is the loosest of all.
        ["1 + 1 === 2 ? 'y' : 'n'", 'y'],
        ['true ? 1 + 1 : 9', 2],
        ["false || true ? 'y' : 'n'", 'y']
    ]);

    // Associativity is a separate axis from precedence: a table with the right
    // powers and the wrong associativity still gets these wrong.
    table([
        ['10 - 3 - 2', 5],          // (10-3)-2, not 10-(3-2)=9
        ['100 / 10 / 2', 5],        // (100/10)/2, not 100/(10/2)=20
        ['2 - 3 + 4', 3],
        // Ternary is right associative: the second ? binds to the tail.
        ['false ? 1 : false ? 2 : 3', 3],
        ['false ? 1 : true ? 2 : 3', 2],
        ['true ? 1 : true ? 2 : 3', 1]
    ]);

    it('is left associative for %, distinguishably', () => {
        // Left gives (13%5)%3 = 3%3 = 0; right would give 13%(5%3) = 13%2 = 1.
        expect(evaluate('13 % 5 % 3')).toBe(0);
        expect(evaluate('13 % (5 % 3)')).toBe(1);
    });

    it('is left associative for -, distinguishably', () => {
        expect(evaluate('10 - 3 - 2')).toBe(5);
        expect(evaluate('10 - (3 - 2)')).toBe(9);
    });
});

// ── Short-circuiting ─────────────────────────────────────────────────────────

describe('expression - short-circuiting', () => {
    it('does not evaluate the right side of && when the left is falsy', () => {
        const spy = vi.fn(() => 'called');
        registerHelper('sideEffect', spy);

        expect(evaluate('off && sideEffect()', DATA)).toBe(false);
        expect(spy).not.toHaveBeenCalled();

        expect(evaluate('flag && sideEffect()', DATA)).toBe('called');
        expect(spy).toHaveBeenCalledTimes(1);

        unregisterHelper('sideEffect');
    });

    it('does not evaluate the right side of || when the left is truthy', () => {
        const spy = vi.fn(() => 'called');
        registerHelper('sideEffect', spy);

        expect(evaluate('flag || sideEffect()', DATA)).toBe(true);
        expect(spy).not.toHaveBeenCalled();

        unregisterHelper('sideEffect');
    });

    it('evaluates only the taken branch of a ternary', () => {
        const taken = vi.fn(() => 'yes');
        const skipped = vi.fn(() => 'no');
        registerHelper('taken', taken);
        registerHelper('skipped', skipped);

        expect(evaluate('flag ? taken() : skipped()', DATA)).toBe('yes');
        expect(taken).toHaveBeenCalledTimes(1);
        expect(skipped).not.toHaveBeenCalled();

        unregisterHelper('taken');
        unregisterHelper('skipped');
    });

    it('guards a property read, which is the whole point of &&', () => {
        expect(evaluate('user && user.name', {user: null})).toBeNull();
        expect(evaluate('user && user.name', {user: {name: 'ada'}})).toBe('ada');
    });
});

// ── Helpers ──────────────────────────────────────────────────────────────────

describe('expression - helpers', () => {
    beforeEach(() => {
        registerHelper('upper', (s) => String(s).toUpperCase());
        registerHelper('add', (a, b) => a + b);
    });

    afterEach(() => {
        unregisterHelper('upper');
        unregisterHelper('add');
    });

    it('calls a registered helper', () => {
        expect(evaluate('upper(user.name)', DATA)).toBe('ADA');
    });

    it('passes several arguments, each an expression in its own right', () => {
        expect(evaluate('add(1, 2)', DATA)).toBe(3);
        expect(evaluate('add(n * 2, 1)', DATA)).toBe(7);
        expect(evaluate('add(items[0], items[1])', DATA)).toBe(30);
    });

    it('nests helper calls', () => {
        expect(evaluate("upper(add('a', 'b'))", DATA)).toBe('AB');
    });

    it('takes no arguments happily', () => {
        registerHelper('now', () => 'noon');
        expect(evaluate('now()')).toBe('noon');
        unregisterHelper('now');
    });

    it('composes a helper call with operators', () => {
        expect(evaluate("upper(user.name) + '!'", DATA)).toBe('ADA!');
        expect(evaluate("upper(user.name) === 'ADA'", DATA)).toBe(true);
    });

    it('refuses to call anything that is not a registered helper', () => {
        // The killer case: a global that exists in every browser.
        expect(evaluate('alert(1)')).toBeUndefined();
        expect(warn.mock.calls.flat().join(' ')).toContain('no helper named "alert"');
    });

    it('refuses to call a function reached through the data', () => {
        // `save` IS a function and IS in scope. It is still not callable,
        // because callability comes from the registry, not from the value.
        const calls = [];
        const context = {save: () => calls.push('called')};

        expect(evaluate('save()', context)).toBeUndefined();
        expect(calls).toEqual([]);
    });

    it('still resolves a data function as a VALUE, which is what data-on-* needs', () => {
        const fn = () => 'handler';
        expect(evaluate('save', {save: fn})).toBe(fn);
    });

    it('keeps the helper namespace separate from the data namespace', () => {
        // A data field of the same name does not shadow the helper, and the
        // helper does not leak out as a value.
        expect(evaluate('upper(name)', {name: 'zoe', upper: 'not a function'})).toBe('ZOE');
        expect(evaluate('upper', {name: 'zoe'})).toBeUndefined();
    });

    it('warns once per unknown helper, not once per evaluation', () => {
        for (let i = 0; i < 5; i++) evaluate('mysteryHelperOne()');

        const messages = warn.mock.calls.flat().filter(
            (arg) => typeof arg === 'string' && arg.includes('mysteryHelperOne')
        );
        expect(messages).toHaveLength(1);
    });

    it('warns again after a helper is registered and then removed', () => {
        evaluate('mysteryHelperTwo()');
        registerHelper('mysteryHelperTwo', () => 1);
        expect(evaluate('mysteryHelperTwo()')).toBe(1);

        unregisterHelper('mysteryHelperTwo');
        warn.mockClear();
        evaluate('mysteryHelperTwo()');
        expect(warn).toHaveBeenCalledTimes(1);
    });

    it('contains a helper that throws, and names the expression that did it', () => {
        registerHelper('boom', () => {
            throw new Error('helper exploded');
        });

        expect(evaluate('boom() + 1')).toBeUndefined();

        const message = warn.mock.calls.flat().join(' ');
        expect(message).toContain('"boom() + 1"');
        expect(warn.mock.calls.flat().some((arg) => arg instanceof Error)).toBe(true);

        unregisterHelper('boom');
    });

    it('reports whether unregisterHelper removed anything', () => {
        registerHelper('temp', () => 1);
        expect(unregisterHelper('temp')).toBe(true);
        expect(unregisterHelper('temp')).toBe(false);
    });

    it('returns the function from registerHelper, so registration can be inlined', () => {
        const fn = () => 1;
        expect(registerHelper('inlined', fn)).toBe(fn);
        unregisterHelper('inlined');
    });

    // Registration is code, not user input — so it is the one thing here that
    // throws rather than warning. A typo'd registry must not fail silently.
    it.each([
        ['a non-function', 'notAFunction', 'nope'],
        ['undefined', 'undef', undefined],
        ['an object', 'obj', {}]
    ])('throws when registering %s', (_label, name, value) => {
        expect(() => registerHelper(name, value)).toThrow(TypeError);
    });

    it.each([
        ['an empty name', ''],
        ['a name with a space', 'two words'],
        ['a name starting with a digit', '1st'],
        ['a dotted name', 'a.b'],
        ['a reserved word', 'new'],
        ['a non-string', 42]
    ])('throws when registering %s', (_label, name) => {
        expect(() => registerHelper(name, () => 1)).toThrow(TypeError);
    });

    it('accepts a unicode helper name, because identifiers may be unicode', () => {
        expect(() => registerHelper('mayúscula', (s) => s)).not.toThrow();
        expect(evaluate('mayúscula(name)', DATA)).toBe('bob');
        unregisterHelper('mayúscula');
    });
});

// ── Binding context (§5, §8) ─────────────────────────────────────────────────

describe('expression - binding context', () => {
    const child = {
        $data: {id: 2, label: 'second'},
        $index: 1,
        $parent: {title: 'list', items: [1, 2]},
        $root: {title: 'page'}
    };

    it('resolves plain names against $data', () => {
        expect(evaluate('label', child)).toBe('second');
        expect(evaluate('id + 1', child)).toBe(3);
    });

    table([
        ['$index', 1],
        ['$data.label', 'second'],
        ['$parent.title', 'list'],
        ['$root.title', 'page'],
        ['$parent.items[0]', 1],
        ["$index === 1 ? 'odd' : 'even'", 'odd'],
        ["$root.title + ': ' + label", 'page: second']
    ], child);

    it('resolves the four names outside a block too, per §5', () => {
        // "Outside such a block these still resolve — $data and $root are the
        // top-level context, $parent is null, $index is null."
        const data = {x: 1};
        expect(evaluate('$data', data)).toBe(data);
        expect(evaluate('$root', data)).toBe(data);
        expect(evaluate('$parent', data)).toBeNull();
        expect(evaluate('$index', data)).toBeNull();
        expect(evaluate('$data.x', data)).toBe(1);
    });

    it('does not walk up to $parent for an unqualified name', () => {
        // `title` exists on $parent and $root but not on $data. A scope-chain
        // walk would find it; deliberately, there is no walk.
        expect(evaluate('title', child)).toBeUndefined();
        expect(evaluate('$parent.title', child)).toBe('list');
    });

    it('handles a primitive $data, as `{{.}}` over a list of strings produces', () => {
        const stringItem = {$data: 'abc', $index: 0, $parent: {}, $root: {}};
        expect(evaluate('$data', stringItem)).toBe('abc');
        expect(evaluate('$data.length', stringItem)).toBe(3);
        expect(evaluate('$index', stringItem)).toBe(0);
    });

    it('tolerates a missing context entirely', () => {
        expect(evaluate('a.b')).toBeUndefined();
        expect(evaluate('1 + 1')).toBe(2);
        expect(evaluate('a.b', null)).toBeUndefined();
        expect(evaluate('a.b', undefined)).toBeUndefined();
        expect(warn).not.toHaveBeenCalled();
    });
});

// ── Hostile input: the prototype guard ───────────────────────────────────────

describe('expression - prototype guard', () => {
    // Every syntactic route to a blocked key, plus the one that has no syntax
    // at all. The last of those is why the guard is at access time: no parser
    // can see that `key` holds '__proto__'.
    const HOSTILE = [
        ['dot, __proto__', 'user.__proto__'],
        ['dot, constructor', 'user.constructor'],
        ['dot, prototype', 'user.constructor.prototype'],
        ['bracket literal, __proto__', "user['__proto__']"],
        ['bracket literal, constructor', "user['constructor']"],
        ['bracket literal, prototype', "user['prototype']"],
        ['computed key, __proto__', 'user[proto]'],
        ['computed key, built at runtime', "user['__pro' + 'to__']"],
        ['bare identifier, __proto__', '__proto__'],
        ['bare identifier, constructor', 'constructor'],
        ['chained through an array', 'items.constructor'],
        ['chained through a string', 'name.constructor'],
        ['double hop', 'user.constructor.constructor']
    ];

    it.each(HOSTILE)('blocks %s', (_label, source) => {
        expect(evaluate(source, DATA)).toBeUndefined();
        expect(warn.mock.calls.flat().join(' ')).toContain('blocked an expression from reading');
    });

    it('blocks the key regardless of how the string was built', () => {
        expect(evaluate('a[k]', {a: {}, k: '__proto__'})).toBeUndefined();
        expect(evaluate('a[k]', {a: {}, k: 'constructor'})).toBeUndefined();
        expect(evaluate('a[k]', {a: {}, k: 'prototype'})).toBeUndefined();
    });

    it('does not block an innocent key that merely looks similar', () => {
        const context = {a: {proto: 1, _proto_: 2, constructors: 3, prototypes: 4}};
        expect(evaluate('a.proto', context)).toBe(1);
        expect(evaluate('a._proto_', context)).toBe(2);
        expect(evaluate('a.constructors', context)).toBe(3);
        expect(evaluate('a.prototypes', context)).toBe(4);
        expect(warn).not.toHaveBeenCalled();
    });

    it('does not block ordinary inherited members', () => {
        expect(evaluate('items.length', DATA)).toBe(3);
        expect(evaluate('name.length', DATA)).toBe(3);
    });
});

// ── Hostile input: the pollution proof ───────────────────────────────────────

describe('expression - prototype pollution', () => {
    // A read alone cannot pollute — there is no assignment in the grammar. The
    // realistic escalation is a MUTATING HELPER: the moment an expression can
    // hand Object.prototype to something like Object.assign, a read becomes a
    // write. Registering `assign` is not contrived; merging is exactly the kind
    // of thing an application registers.
    //
    // Each case below pollutes Object.prototype if readMember's blocklist is
    // removed, and is inert with it in place. That is verified by mutation, not
    // asserted on faith — see the report accompanying this milestone.

    beforeEach(() => {
        registerHelper('assign', (target, source) => Object.assign(target, source));
    });

    afterEach(() => {
        unregisterHelper('assign');
        delete Object.prototype.polluted;   // never leave a poisoned realm behind
    });

    const PAYLOAD = {polluted: 'yes'};

    it.each([
        ['via .__proto__', 'assign(user.__proto__, payload)'],
        ['via ["__proto__"]', 'assign(user["__proto__"], payload)'],
        ['via a computed key', 'assign(user[proto], payload)'],
        ['via .constructor.prototype', 'assign(user.constructor.prototype, payload)'],
        ['via a bare __proto__', 'assign(__proto__, payload)']
    ])('does not pollute Object.prototype %s', (_label, source) => {
        expect({}.polluted).toBeUndefined();   // clean before

        const result = evaluate(source, {user: {}, payload: PAYLOAD, proto: '__proto__'});

        expect({}.polluted, 'Object.prototype was polluted').toBeUndefined();
        expect(Object.prototype.polluted).toBeUndefined();
        expect(result).toBeUndefined();
        expect(warn).toHaveBeenCalled();
    });

    it('confirms the helper genuinely would pollute if handed the prototype', () => {
        // Without this, the tests above could pass because the HELPER is inert
        // rather than because the guard works. It is not inert.
        const victim = {};
        Object.assign(Object.getPrototypeOf(victim), PAYLOAD);
        expect({}.polluted).toBe('yes');
        delete Object.prototype.polluted;
        expect({}.polluted).toBeUndefined();
    });

    it('cannot reach the Function constructor, which is the other way out', () => {
        // x.constructor.constructor is the Function constructor, and that is
        // dynamic code execution by another name. The chain dies at hop one.
        expect(evaluate('x.constructor', {x: {}})).toBeUndefined();
        expect(evaluate('x.constructor.constructor', {x: {}})).toBeUndefined();
        expect(evaluate("x.constructor.constructor('return 1')()", {x: {}})).toBeUndefined();
    });
});

// ── Malformed input ──────────────────────────────────────────────────────────

describe('expression - malformed input', () => {
    const MALFORMED = [
        ['a dangling operator', '1 +'],
        ['a leading operator', '* 2'],
        ['an unclosed group', '('],
        ['an unopened group', '1)'],
        ['an unbalanced group', '(1 + 2'],
        ['a doubled dot', 'a..b'],
        ['a trailing dot', 'a.'],
        ['a dot before an index', 'a.[0]'],
        ['a numeric property', 'a.0'],
        ['an unterminated string', '"unterminated'],
        ['an unterminated single-quoted string', "'unterminated"],
        ['an unclosed index', 'a[0'],
        ['an empty index', 'a[]'],
        ['two expressions juxtaposed', 'a b'],
        ['a comma sequence', 'a, b'],
        ['a trailing comma in a call', 'f(1,)'],
        ['an unclosed call', 'f(1'],
        ['a ternary missing its colon', 'a ? b'],
        ['a ternary missing its alternate', 'a ? b :'],
        ['a stray colon', 'a : b'],
        ['an unknown character', 'a @ b'],
        ['a hash', '#a'],
        ['a brace', '{a}'],
        ['an array literal', '[1, 2]'],
        ['an object literal', '{a: 1}'],
        ['a template literal', '`hi ${a}`'],
        ['a bad unicode escape', "'\\uZZZZ'"],
        ['a regex', '/x/.test(a)'],
        ['an arrow function', 'x => x'],
        ['a semicolon', 'a; b'],
        ['a bitwise operator', 'a & b'],
        ['a pipe', 'a | b'],
        ['an increment', 'a++'],

        // Recognised purely so they can be refused with advice.
        ['assignment', 'a = 1'],
        ['loose equality', 'a == b'],
        ['loose inequality', 'a != b'],
        ['nullish coalescing', 'a ?? b'],
        ['the new operator', 'new Date()'],
        ['typeof', 'typeof a'],
        ['delete', 'delete a.b'],
        ['this', 'this.a'],
        ['instanceof', 'a instanceof b'],
        ['in', 'a in b'],
        ['a function expression', 'function () {}'],

        // Calls that are not helper calls.
        ['a member call', 'user.toString()'],
        ['a member call on a string', 'name.toUpperCase()'],
        ['a call on a call', 'f()()'],
        ['a call on an index', 'a[0]()'],
        ["a call on a literal", "'x'()"],

        // Nothing at all.
        ['an empty string', ''],
        ['whitespace only', '   '],
        ['a tab and a newline', '\t\n'],

        // Not even a string.
        ['null', null],
        ['undefined', undefined],
        ['an object', {}]
    ];

    it.each(MALFORMED)('rejects %s without throwing', (_label, source) => {
        let result;
        expect(() => {
            result = evaluate(source, DATA);
        }).not.toThrow();

        expect(result).toBeUndefined();
        expect(parseExpression(source)).toBeNull();
        expect(warn).toHaveBeenCalled();
    });

    it('names the offending source in the warning', () => {
        parseExpression('1 +');
        expect(warn.mock.calls.flat().join(' ')).toContain('"1 +"');
    });

    it('names the template too, when the caller supplies one', () => {
        parseExpression('1 +', {template: 'user-card'});
        const message = warn.mock.calls.flat().join(' ');
        expect(message).toContain('user-card');
        expect(message).toContain('1 +');
    });

    it('says what to do instead of == and =', () => {
        parseExpression('a == b');
        expect(warn.mock.calls.flat().join(' ')).toContain('===');

        warn.mockClear();
        parseExpression('a = 1');
        expect(warn.mock.calls.flat().join(' ')).toContain('assignment is not supported');
    });

    it('warns once per source, not once per evaluation', () => {
        for (let i = 0; i < 10; i++) evaluate('1 +', DATA);
        expect(warn).toHaveBeenCalledTimes(1);
    });

    it('keeps reserved words usable as property names', () => {
        // They are refused in prefix position only. `item.in` is a property.
        const context = {item: {in: 'inbox', new: true, class: 'row', this: 1, delete: 'x'}};
        expect(evaluate('item.in', context)).toBe('inbox');
        expect(evaluate('item.new', context)).toBe(true);
        expect(evaluate('item.class', context)).toBe('row');
        expect(evaluate('item.this', context)).toBe(1);
        expect(evaluate('item.delete', context)).toBe('x');
        expect(warn).not.toHaveBeenCalled();
    });

    it('tolerates surrounding and interior whitespace', () => {
        expect(evaluate('  n  +  1  ', DATA)).toBe(4);
        expect(evaluate('\tuser.name\n', DATA)).toBe('ada');
        expect(evaluate('user\n.\nname', DATA)).toBe('ada');
    });
});

// ── Depth ────────────────────────────────────────────────────────────────────

describe('expression - depth limit', () => {
    it(`pins the limit at ${MAX_DEPTH}`, () => {
        expect(MAX_DEPTH).toBe(64);
    });

    it('parses an expression at exactly the limit', () => {
        // 63 groupings plus the literal itself is 64 parser levels.
        const source = '('.repeat(MAX_DEPTH - 1) + '1' + ')'.repeat(MAX_DEPTH - 1);
        expect(evaluate(source)).toBe(1);
        expect(warn).not.toHaveBeenCalled();
    });

    it('refuses one level deeper, and says so', () => {
        const source = '('.repeat(MAX_DEPTH) + '1' + ')'.repeat(MAX_DEPTH);
        expect(evaluate(source)).toBeUndefined();
        expect(warn.mock.calls.flat().join(' ')).toContain('nests deeper than');
    });

    it('degrades rather than overflowing the stack on a hostile depth', () => {
        // 50,000 open parens. Without the parser's own depth counter this is a
        // RangeError from the engine, which is a thrown error escaping a
        // module that promises never to throw.
        const source = '('.repeat(50000) + '1' + ')'.repeat(50000);
        let result;
        expect(() => {
            result = evaluate(source);
        }).not.toThrow();
        expect(result).toBeUndefined();
    });

    it('rejects a flat chain at PARSE time, not merely at evaluation', () => {
        // A flat chain is one loop iteration per term to the parser and one
        // stack frame per term to the walker, so only the finished-AST depth
        // check sees it. Rejecting at parse time is what matters: the caller
        // skips the binding once, instead of evaluating to undefined and
        // warning on every render for the life of the page.
        const chain = Array(MAX_DEPTH + 5).fill('1').join('+');

        expect(parseExpression(chain)).toBeNull();
        expect(warn.mock.calls.flat().join(' ')).toContain('nests deeper than');
        expect(evaluate(chain)).toBeUndefined();

        const justUnder = Array(MAX_DEPTH).fill('1').join('+');
        expect(parseExpression(justUnder)).not.toBeNull();
        expect(evaluate(justUnder)).toBe(MAX_DEPTH);
    });

    it('survives a very long flat chain without overflowing', () => {
        const chain = Array(20000).fill('1').join('+');
        let result;
        expect(() => {
            result = parseExpression(chain);
        }).not.toThrow();
        expect(result).toBeNull();
        expect(evaluate(chain)).toBeUndefined();
    });

    it('bounds evaluation of a hand-built AST too', () => {
        // evaluateAst is public and will take any object. The parser's limits
        // are irrelevant to an AST that never went through it.
        let ast = {type: 'Literal', value: 1};
        for (let i = 0; i < 5000; i++) {
            ast = {type: 'Unary', operator: '!', argument: ast};
        }

        let result;
        expect(() => {
            result = evaluateAst(ast, {});
        }).not.toThrow();
        expect(result).toBeUndefined();
        expect(warn).toHaveBeenCalled();
    });

    it('tolerates a long but shallow expression', () => {
        // Length is not depth: 500 arguments is one level.
        registerHelper('count', (...args) => args.length);
        const source = `count(${Array(500).fill('1').join(', ')})`;
        expect(evaluate(source)).toBe(500);
        unregisterHelper('count');
    });
});

// ── Parse once, evaluate many ────────────────────────────────────────────────

describe('expression - the parse cache', () => {
    it('returns the identical AST for the same source', () => {
        const first = parseExpression('a.b + 1');
        const second = parseExpression('a.b + 1');
        expect(second).toBe(first);
    });

    it('parses afresh after the cache is cleared', () => {
        const first = parseExpression('a.b + 1');
        expect(clearExpressionCache()).toBeGreaterThan(0);
        const second = parseExpression('a.b + 1');

        expect(second).not.toBe(first);
        expect(second).toEqual(first);
    });

    it('caches failures as well as successes', () => {
        expect(parseExpression('1 +')).toBeNull();
        expect(parseExpression('1 +')).toBeNull();
        expect(warn).toHaveBeenCalledTimes(1);
    });

    it('does not re-parse when a compiled evaluator is re-run', () => {
        const ast = parseExpression('n * 2');
        const evaluator = compileExpression('n * 2');

        for (let i = 0; i < 100; i++) evaluator({n: i});

        // Still the same object: nothing replaced the cache entry, and nothing
        // built a second AST behind it.
        expect(parseExpression('n * 2')).toBe(ast);
    });

    it('freezes the AST, because the cache shares it between callers', () => {
        const ast = parseExpression('a.b');
        expect(Object.isFrozen(ast)).toBe(true);
        expect(Object.isFrozen(ast.object)).toBe(true);
        expect(() => {
            ast.type = 'Compromised';
        }).toThrow(TypeError);
    });

    it('freezes call argument lists too', () => {
        registerHelper('noop', () => 1);
        const ast = parseExpression('noop(1, 2)');
        expect(Object.isFrozen(ast.args)).toBe(true);
        unregisterHelper('noop');
    });

    it('reports how many entries it dropped', () => {
        clearExpressionCache();
        parseExpression('a');
        parseExpression('b');
        parseExpression('c');
        expect(clearExpressionCache()).toBe(3);
        expect(clearExpressionCache()).toBe(0);
    });

    it('stays bounded when fed unbounded distinct sources', () => {
        clearExpressionCache();
        for (let i = 0; i < 2500; i++) parseExpression(`x${i} + 1`);
        // Whatever the eviction policy, the map must not have grown to 2500.
        // Measured through the only public window onto it.
        expect(clearExpressionCache()).toBeLessThanOrEqual(1000);
    });
});

// ── The public shapes ────────────────────────────────────────────────────────

describe('expression - API shapes', () => {
    it('parseExpression returns an AST for valid source and null for invalid', () => {
        expect(parseExpression('a + 1')).toMatchObject({type: 'Binary', operator: '+'});
        expect(parseExpression('a +')).toBeNull();
    });

    it('compileExpression returns a reusable evaluator', () => {
        const evaluator = compileExpression('a * 2');
        expect(typeof evaluator).toBe('function');
        expect(evaluator({a: 2})).toBe(4);
        expect(evaluator({a: 10})).toBe(20);
    });

    it('compileExpression returns null when the source does not parse', () => {
        // Not a function that yields undefined: the caller must be able to
        // SKIP the binding, which means telling the two apart.
        expect(compileExpression('a +')).toBeNull();
    });

    it('evaluateAst tolerates anything that is not an AST', () => {
        for (const notAnAst of [null, undefined, 42, 'a + 1', {}, {type: 42}, []]) {
            expect(evaluateAst(notAnAst, {})).toBeUndefined();
        }
        expect(warn).not.toHaveBeenCalled();
    });

    it('evaluateAst warns and yields undefined for an unknown node type', () => {
        expect(evaluateAst({type: 'Assignment', left: 1, right: 2}, {})).toBeUndefined();
        expect(warn).toHaveBeenCalled();
    });

    it('says so when it cannot name the expression that failed', () => {
        // A hand-built AST has no source text to quote. Quoting nothing, or
        // quoting an empty string, would read as though the source WAS empty.
        evaluateAst({type: 'Assignment'}, {});
        expect(warn.mock.calls.flat().join(' ')).toContain('not from parseExpression');
    });

    it('builds the AST shape the binding layer will walk', () => {
        expect(parseExpression("a.b[c] ? upper(d) : 'x'")).toEqual({
            type: 'Conditional',
            test: {
                type: 'Member',
                computed: true,
                object: {
                    type: 'Member',
                    computed: false,
                    object: {type: 'Identifier', name: 'a'},
                    property: 'b'
                },
                property: {type: 'Identifier', name: 'c'}
            },
            consequent: {
                type: 'Call',
                callee: 'upper',
                args: [{type: 'Identifier', name: 'd'}]
            },
            alternate: {type: 'Literal', value: 'x'}
        });
    });
});

// ── CSP: the promise the whole module exists to keep ─────────────────────────

describe('expression - no dynamic code construction', () => {
    const here = dirname(fileURLToPath(import.meta.url));

    /** Patterns that mean "this file can execute a string". */
    const FORBIDDEN = [
        [/\beval\s*\(/, 'a call to eval'],
        [/\bnew\s+Function\b/, 'the Function constructor'],
        [/\bFunction\s*\(/, 'a call to Function'],
        [/\b(setTimeout|setInterval)\s*\(\s*['"`]/, 'a string-bodied timer']
    ];

    /** Every shipped source file, tests excluded. */
    function sourceFiles(directory) {
        const found = [];
        for (const entry of readdirSync(directory, {withFileTypes: true})) {
            const path = join(directory, entry.name);
            if (entry.isDirectory()) found.push(...sourceFiles(path));
            else if (entry.name.endsWith('.js') && !entry.name.endsWith('.test.js')) found.push(path);
        }
        return found;
    }

    it('has no dynamic code construction in expression.js', () => {
        const source = readFileSync(join(here, 'expression.js'), 'utf8');
        for (const [pattern, description] of FORBIDDEN) {
            expect(pattern.test(source), `expression.js contains ${description}`).toBe(false);
        }
    });

    it('has none anywhere else in the package source either', () => {
        const files = sourceFiles(here);
        expect(files.length).toBeGreaterThan(4);

        for (const file of files) {
            const source = readFileSync(file, 'utf8');
            for (const [pattern, description] of FORBIDDEN) {
                expect(pattern.test(source), `${file} contains ${description}`).toBe(false);
            }
        }
    });

    it('catches the patterns it is looking for', () => {
        // Assembled from fragments rather than written out, so that this file
        // does not itself contain the constructs it hunts for.
        const F = 'Function';
        const samples = [
            'ev' + 'al("2")',
            'new ' + F + '("return 1")',
            F + '("3")',
            'setTimeout("tick()", 10)'
        ];

        for (const sample of samples) {
            expect(FORBIDDEN.some(([pattern]) => pattern.test(sample)), sample).toBe(true);
        }
    });

    it('does not mistake evaluateAst for eval', () => {
        // Every name in this module starts with "eval". The patterns must not
        // fire on them, or the guard above would be unfalsifiable noise.
        const sample = 'export function evaluateAst(ast) { return evaluateNode(ast); }';
        expect(FORBIDDEN.some(([pattern]) => pattern.test(sample))).toBe(false);
    });
});

describe('expression - dependencies', () => {

    const deps = (source) => [...expressionDependencies(source)].sort();

    it('reports the root name of a path, not the whole path', () => {
        // The graph tracks whole values, not paths within them (design spec §2
        // puts deep tracking out of scope), so `user` is the honest answer.
        expect(deps('user')).toEqual(['user']);
        expect(deps('user.profile.email')).toEqual(['user']);
    });

    it('reports both sides of a computed index', () => {
        expect(deps('items[i]')).toEqual(['i', 'items']);
        expect(deps("items['fixed']")).toEqual(['items']);
    });

    it('collects from every branch of an operator, ternary or call', () => {
        expect(deps('a && b')).toEqual(['a', 'b']);
        expect(deps('a ? b : c')).toEqual(['a', 'b', 'c']);
        expect(deps('upper(a, b.c)')).toEqual(['a', 'b']);
        expect(deps('!(a + b * c)')).toEqual(['a', 'b', 'c']);
    });

    it('does not mistake a string literal for a name', () => {
        // This is why the walk is over the AST and not over the source text.
        expect(deps("label === 'name'")).toEqual(['label']);
        expect(deps("'name'")).toEqual([]);
        expect(deps('1 + 2')).toEqual([]);
    });

    it('does not report the helper being called', () => {
        expect(deps('upper(name)')).toEqual(['name']);
    });

    it('unwraps $data and $root to the field underneath', () => {
        expect(deps('$data.name')).toEqual(['name']);
        expect(deps('$root.title')).toEqual(['title']);
        expect(deps('$data.user.email')).toEqual(['user']);
    });

    it('reports nothing for $parent and $index, which are position', () => {
        expect(deps('$parent.name')).toEqual([]);
        expect(deps('$index')).toEqual([]);
        expect(deps('$index > 0 ? a : b')).toEqual(['a', 'b']);
    });

    it('accepts an AST as well as a source string', () => {
        const ast = parseExpression('a + b');
        expect([...expressionDependencies(ast)].sort()).toEqual(['a', 'b']);
    });

    it('yields an empty set for anything that did not parse', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        expect(expressionDependencies('a ==== b').size).toBe(0);
        expect(expressionDependencies(null).size).toBe(0);
        expect(expressionDependencies(undefined).size).toBe(0);
        warn.mockRestore();
    });

    it('de-duplicates a name read several times', () => {
        expect(deps('a + a + a.b')).toEqual(['a']);
    });
});

// ── Method calls, opted into ──────────────────────────────────────────────────
//
// `x.foo()` is refused by default and always will be: an interpolation, a
// `data-if` and a `data-bind-*` are READS that run inside an effect, and a read
// that invokes a method on your data is a side effect in a place that promises
// not to have one.
//
// An event handler is not a read. It fires on a gesture, outside every effect,
// and calling a method on your view model is the entire point — `$parent.remove
// ($data)` is how a row reaches the list that owns it, and there is no other way
// to spell it, because a bare name resolves against $data and $data is the row.
//
// So the restriction is not lifted, it is SCOPED: the parser accepts a method
// call only when the caller asks for it, and the evaluator still refuses to
// perform one. Only the event binding asks.

describe('method calls are refused by default', () => {
    it('does not parse x.foo(), and says why', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        expect(parseExpression('a.b()')).toBeNull();
        expect(warn).toHaveBeenCalledWith(
            expect.stringContaining('only registered helpers can be called')
        );
        warn.mockRestore();
    });

    it('refuses a computed callee too', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        expect(parseExpression('a["b"]()')).toBeNull();
        warn.mockRestore();
    });
});

describe('method calls, when the caller opts in', () => {
    it('parses x.foo(a) into a MethodCall', () => {
        const ast = parseExpression('$parent.remove($data)', {methodCalls: true});
        expect(ast).toMatchObject({
            type: 'MethodCall',
            computed: false,
            property: 'remove',
            object: {type: 'Identifier', name: '$parent'}
        });
        expect(ast.args).toHaveLength(1);
        expect(ast.args[0]).toMatchObject({type: 'Identifier', name: '$data'});
    });

    it('parses a computed callee', () => {
        const ast = parseExpression('handlers["save"]()', {methodCalls: true});
        expect(ast).toMatchObject({type: 'MethodCall', computed: true});
        expect(ast.property).toMatchObject({type: 'Literal', value: 'save'});
    });

    it('still parses a bare helper call as a plain Call', () => {
        const ast = parseExpression('upper(a)', {methodCalls: true});
        expect(ast).toMatchObject({type: 'Call', callee: 'upper'});
    });

    it('does not let one parse poison the other through the cache', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

        // Strict first, permissive second — the permissive caller must not get
        // the cached null, or an event binding would break because some earlier
        // interpolation happened to use the same text.
        expect(parseExpression('a.b()')).toBeNull();
        expect(parseExpression('a.b()', {methodCalls: true})).toMatchObject({type: 'MethodCall'});

        clearExpressionCache();

        // …and the other way round, or a permissive parse would let a method
        // call leak into an ordinary expression.
        expect(parseExpression('a.b()', {methodCalls: true})).toMatchObject({type: 'MethodCall'});
        expect(parseExpression('a.b()')).toBeNull();

        warn.mockRestore();
    });

    it('counts a method call towards the depth limit', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const deep = 'a.b(' .repeat(MAX_DEPTH + 2) + '1' + ')'.repeat(MAX_DEPTH + 2);
        expect(parseExpression(deep, {methodCalls: true})).toBeNull();
        warn.mockRestore();
    });
});

describe('the evaluator still will not perform a method call', () => {
    it('warns and yields undefined rather than invoking it', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const ast = parseExpression('obj.hit()', {methodCalls: true});

        let called = false;
        expect(evaluateAst(ast, {obj: {hit: () => { called = true; return 1; }}})).toBeUndefined();
        expect(called).toBe(false);
        expect(warn).toHaveBeenCalledWith(
            expect.stringContaining('threw during evaluation'),
            expect.objectContaining({message: expect.stringContaining('cannot call a method')})
        );

        warn.mockRestore();
    });

    it('reports the method call as a dependency of its receiver', () => {
        const ast = parseExpression('list.remove(item)', {methodCalls: true});
        expect([...expressionDependencies(ast)].sort()).toEqual(['item', 'list']);
    });
});
