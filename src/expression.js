/**
 * Expression evaluator - tokeniser, Pratt parser, AST walker, helper registry.
 *
 * Bindings need more than a dotted path. `data-bind-class="isActive && 'on'"`,
 * `{{ count > 0 ? 'some' : 'none' }}` and `upper(user.name)` are all ordinary
 * things to want from a template, and none of them is a path.
 *
 * The obvious implementation - hand the source to the Function constructor
 * wrapped in a `with` block - is the one this module exists to avoid. Under
 * `script-src 'self'` without `unsafe-eval` that constructor throws, which is
 * why Knockout bindings die under a strict CSP. Parsing the subset ourselves
 * costs a few hundred lines and buys deployability under a policy that forbids
 * dynamic code, plus the ability to say precisely what an expression may do.
 *
 * This file contains no dynamic code construction of any kind, and a test
 * asserts that of the source text itself - see expression.test.js. The same
 * assertion runs against the built bundles in scripts/verify-dist.mjs, because
 * a bundler could in principle introduce one.
 *
 * ── The subset ───────────────────────────────────────────────────────────────
 *
 *   paths           a, a.b.c, a[0], a[key], a['x']
 *   literals        'str', "str", 1, 1.5, 1e3, true, false, null
 *   arithmetic      + - * / %          (+ is also string concatenation)
 *   comparison      === !== < <= > >=
 *   logical         && || !            (short-circuiting)
 *   ternary         a ? b : c
 *   unary           - + !
 *   calls           helper(arg, ...)   registered helpers ONLY
 *   context         $data $root $parent $index
 *
 * Absent by design: assignment, `new`, member calls (`x.foo()`), arbitrary
 * function calls, loose equality (`==`), nullish coalescing (`??`), regular
 * expressions, object and array literals, template literals, comma sequences.
 * Each of those is recognised by the tokeniser or parser purely so it can be
 * rejected with a message that says what to do instead.
 *
 * ── Failure is never fatal ───────────────────────────────────────────────────
 *
 * A template is authored, but it is authored by a human at three in the
 * afternoon, and a typo in one binding must not blank a page. So:
 *
 *   - parse failure   → console warning naming the source (and the template,
 *                       when the caller supplied one) and `null`. The caller
 *                       skips that binding and renders the rest.
 *   - eval failure    → console warning and `undefined`. Nothing propagates.
 *
 * Neither path throws. The one exception is registerHelper(), which throws on
 * a bad argument: that is programmer error at a call site, caught in
 * development in the first second, and a silent no-op there would be worse
 * than useless. User-supplied *expressions* never throw; API misuse does.
 *
 * ── Parse once, evaluate many ────────────────────────────────────────────────
 *
 * Expressions are parsed at compile time and the AST cached by source text, so
 * a binding re-evaluating sixty times a second re-parses zero times. ASTs are
 * frozen: the cache hands the same object to every caller, and one of them
 * mutating it would corrupt the others.
 */

import {CONTEXT_KEYS, toContext} from './context.js';

const PREFIX = '[Domma Reactive]';

/**
 * Maximum nesting depth, enforced in three places: while parsing (so a
 * pathological input cannot overflow the parser's own stack), on the finished
 * AST (so a left-associative chain, which is flat to the parser but deep to the
 * walker, is caught too), and while evaluating (so a hand-built AST handed to
 * evaluateAst() cannot overflow either).
 *
 * 64 is far beyond anything a template needs - a five-branch ternary chain is
 * five levels - and far below the depth at which any JavaScript engine's stack
 * is in danger. Note the consequence for chains: `1+1+1+…` builds one level per
 * operand, so 64 is also the ceiling on operands in a single flat chain. An
 * expression that hits that is not an expression, it is a spreadsheet.
 */
export const MAX_DEPTH = 64;

/**
 * Entries after which the parse cache is dropped wholesale.
 *
 * The cache is a module global keyed by source text. That is exactly right for
 * templates, which are finite and authored, and exactly wrong for expressions
 * built at runtime from user input, which are not - and would grow the map
 * forever. Clearing everything at the limit is the cheapest policy that bounds
 * it; the cost is re-parsing a working set once, which is microseconds.
 */
const CACHE_LIMIT = 1000;

/**
 * Property names that may never be read through an expression.
 *
 * `__proto__` hands out Object.prototype. `constructor` hands out a route to
 * the Function constructor one hop later, and that route is dynamic code
 * execution by another name. `prototype` completes the pair. Reading any of
 * them is the first move in every prototype-pollution chain, and no legitimate
 * template expression needs any of them.
 *
 * Exported - though deliberately NOT re-exported from index.js - because the
 * binding layer must refuse to *write* them too, and `data-model="x.__proto__"`
 * is prototype pollution with the arrow pointing the other way. One list, one
 * place to audit; two lists would drift and the write side would be the one
 * left behind.
 */
export const BLOCKED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Words that are valid identifiers to the tokeniser but must not open an
 * expression. They are rejected by name rather than by falling out of the
 * grammar so the message can say what is actually wrong.
 *
 * Applied in prefix position only - `item.in` and `x.new` are perfectly good
 * property names and must keep working.
 */
const REJECTED_WORDS = new Map([
    ['new', 'the `new` operator is not supported'],
    ['delete', '`delete` is not supported'],
    ['typeof', '`typeof` is not supported'],
    ['void', '`void` is not supported'],
    ['instanceof', '`instanceof` is not supported'],
    ['in', 'the `in` operator is not supported'],
    ['function', 'function expressions are not supported'],
    ['class', 'class expressions are not supported'],
    ['this', '`this` is not supported - use $data'],
    ['await', '`await` is not supported'],
    ['yield', '`yield` is not supported']
]);

/** Parse/eval failure. Internal: it never escapes this module. */
class ExpressionError extends Error {}

// ── Registries ────────────────────────────────────────────────────────────────

/** name → function. The only things an expression may call. */
const helpers = new Map();

/**
 * source → AST | null (null meaning "this source failed to parse").
 *
 * TWO caches, because the same text parses differently depending on whether the
 * caller allows method calls: `a.b()` is a MethodCall for an event binding and a
 * parse failure for an interpolation. Keyed by text alone, whichever call
 * arrived first would decide for the other - an interpolation elsewhere on the
 * page could silently break an event handler, or worse, let a method call into
 * an expression that is supposed to refuse one.
 */
const cache = new Map();
const methodCallCache = new Map();

/**
 * AST root → the source it was parsed from, for evaluation-time warnings.
 *
 * A WeakMap rather than a `source` field on the node, because the AST shape is
 * a contract the binding layer walks and a field that exists only on the root
 * is a trap in a recursive walker. Weak, so it never outlives the AST - which
 * a cleared cache discards. A hand-built AST is simply absent from it, and the
 * warning says so rather than inventing a name.
 */
const sources = new WeakMap();

/** Helper names already warned about, so a 1000-row list warns once, not 1000×. */
const warnedHelpers = new Set();

// ── Tokeniser ─────────────────────────────────────────────────────────────────

const DIGIT = /[0-9]/;

/*
 * Unicode identifiers, via the Unicode property escapes rather than a
 * hand-rolled [A-Za-z_$] class: `café`, `naïve` and `имя` are legitimate
 * property names, and a template that reads one should not be a parse error.
 * `$` is not in ID_Start or ID_Continue, so it is added explicitly - the
 * context variables ($data, $index …) depend on it.
 */
const IDENT_START = /[\p{ID_Start}$_]/u;
const IDENT_PART = /[\p{ID_Continue}$\u200C\u200D]/u;

/** Punctuators, longest first so that maximal munch falls out of the order. */
const PUNCTUATORS = [
    '===', '!==', '&&', '||', '<=', '>=', '??', '==', '!=',
    '<', '>', '+', '-', '*', '/', '%', '!', '?', ':', '.', ',',
    '(', ')', '[', ']', '='
];

/**
 * Punctuators recognised only in order to be refused, with the message to give.
 * Tokenising them is what turns "unexpected character" into advice.
 */
const REJECTED_PUNCTUATORS = new Map([
    ['==', 'loose equality is not supported - use ==='],
    ['!=', 'loose inequality is not supported - use !=='],
    ['=', 'assignment is not supported'],
    ['??', 'the ?? operator is not supported']
]);

/** Single-character string escapes. \uXXXX is handled separately. */
const ESCAPES = {n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v', 0: '\0'};

/**
 * Source text → token list.
 *
 * @param {string} source
 * @returns {Array<{type: string, value: *, pos: number}>} always ending in an `eof` token
 * @throws {ExpressionError}
 */
function tokenise(source) {
    const tokens = [];
    let i = 0;

    while (i < source.length) {
        const char = source[i];

        // Whitespace, including the exotic kinds a copy-paste can introduce.
        if (/\s/.test(char)) {
            i++;
            continue;
        }

        // Number: 1, 1.5, 1e3, 1.5e-3. No hex, no leading dot, no separators -
        // a template that needs 0xFF needs a computed.
        if (DIGIT.test(char)) {
            const start = i;
            while (i < source.length && DIGIT.test(source[i])) i++;
            if (source[i] === '.') {
                i++;
                while (i < source.length && DIGIT.test(source[i])) i++;
            }
            if (source[i] === 'e' || source[i] === 'E') {
                const mark = i;
                i++;
                if (source[i] === '+' || source[i] === '-') i++;
                if (DIGIT.test(source[i] ?? '')) {
                    while (i < source.length && DIGIT.test(source[i])) i++;
                } else {
                    i = mark;   // `1e` is the number 1 followed by the identifier e
                }
            }
            tokens.push({type: 'num', value: Number(source.slice(start, i)), pos: start});
            continue;
        }

        // String.
        if (char === '"' || char === "'") {
            const token = readString(source, i);
            tokens.push({type: 'str', value: token.value, pos: i});
            i = token.end;
            continue;
        }

        if (char === '`') {
            throw new ExpressionError(`template literals are not supported at position ${i}`);
        }

        // Identifier or keyword literal.
        if (IDENT_START.test(char)) {
            const start = i;
            i++;
            while (i < source.length && IDENT_PART.test(source[i])) i++;
            const name = source.slice(start, i);

            if (name === 'true') tokens.push({type: 'num', value: true, pos: start});
            else if (name === 'false') tokens.push({type: 'num', value: false, pos: start});
            else if (name === 'null') tokens.push({type: 'num', value: null, pos: start});
            else tokens.push({type: 'ident', value: name, pos: start});
            continue;
        }

        // Punctuator, longest match first.
        const punct = PUNCTUATORS.find((p) => source.startsWith(p, i));
        if (punct) {
            const rejection = REJECTED_PUNCTUATORS.get(punct);
            if (rejection) throw new ExpressionError(`${rejection} (at position ${i})`);
            tokens.push({type: 'punct', value: punct, pos: i});
            i += punct.length;
            continue;
        }

        throw new ExpressionError(`unexpected character "${char}" at position ${i}`);
    }

    tokens.push({type: 'eof', value: null, pos: source.length});
    return tokens;
}

/**
 * Read one quoted string starting at `start`.
 * @returns {{value: string, end: number}} `end` is the index after the closing quote
 */
function readString(source, start) {
    const quote = source[start];
    let out = '';
    let i = start + 1;

    while (i < source.length) {
        const char = source[i];

        if (char === '\\') {
            const next = source[i + 1];
            if (next === undefined) break;
            if (next === 'u') {
                const hex = source.slice(i + 2, i + 6);
                if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
                    throw new ExpressionError(`bad \\u escape at position ${i}`);
                }
                out += String.fromCharCode(parseInt(hex, 16));
                i += 6;
                continue;
            }
            out += Object.prototype.hasOwnProperty.call(ESCAPES, next) ? ESCAPES[next] : next;
            i += 2;
            continue;
        }

        if (char === quote) return {value: out, end: i + 1};

        out += char;
        i++;
    }

    throw new ExpressionError(`unterminated string starting at position ${start}`);
}

// ── Grammar ───────────────────────────────────────────────────────────────────

/**
 * Infix operators and their binding powers. Higher binds tighter.
 *
 *   2   ?:            (right associative, handled separately)
 *   3   ||
 *   4   &&
 *   5   === !==
 *   6   < <= > >=
 *   7   + -
 *   8   * / %
 *   9   unary - + !   (prefix, handled separately)
 *  10   . [] ()       (postfix, handled separately)
 *
 * All infix operators here are left associative: the right operand is parsed
 * at the operator's own power, so an operator of equal power stops rather than
 * recursing. `10 - 3 - 2` is therefore `(10 - 3) - 2` = 5, not 9.
 */
const INFIX = {
    '||': {bp: 3, logical: true},
    '&&': {bp: 4, logical: true},
    '===': {bp: 5},
    '!==': {bp: 5},
    '<': {bp: 6},
    '<=': {bp: 6},
    '>': {bp: 6},
    '>=': {bp: 6},
    '+': {bp: 7},
    '-': {bp: 7},
    '*': {bp: 8},
    '/': {bp: 8},
    '%': {bp: 8}
};

const TERNARY_BP = 2;
const UNARY_BP = 9;
const POSTFIX_BP = 10;

/** Prefix operators. */
const UNARY = new Set(['-', '+', '!']);

/** Every node is frozen on creation - the cache shares them between callers. */
const node = (props) => Object.freeze(props);

/**
 * Source text → frozen AST.
 *
 * @param {string} source
 * @returns {Object} the root node
 * @throws {ExpressionError}
 */
function parseSource(source, allowMethodCalls = false) {
    const tokens = tokenise(source);
    let i = 0;
    let nest = 0;

    const peek = () => tokens[i];
    const at = (value) => tokens[i].type === 'punct' && tokens[i].value === value;
    const fail = (message, token = tokens[i]) => {
        throw new ExpressionError(`${message} at position ${token.pos}`);
    };
    const eat = (value) => {
        if (!at(value)) return false;
        i++;
        return true;
    };
    const expect = (value) => {
        if (!eat(value)) fail(`expected "${value}" but found ${describe(peek())}`);
    };

    /**
     * Pratt loop: a prefix parse, then infix and postfix operators for as long
     * as they bind tighter than the caller's floor.
     */
    function parseExpr(minBp) {
        if (++nest > MAX_DEPTH) {
            throw new ExpressionError(`expression nests deeper than ${MAX_DEPTH} levels`);
        }
        try {
            let left = parsePrefix();

            for (;;) {
                const token = peek();
                if (token.type !== 'punct') break;

                // Member access and calls bind tighter than everything.
                if (POSTFIX_BP > minBp
                    && (token.value === '.' || token.value === '[' || token.value === '(')) {
                    left = parsePostfix(left);
                    continue;
                }

                // Ternary: lowest precedence, right associative.
                if (token.value === '?' && TERNARY_BP > minBp) {
                    i++;
                    const consequent = parseExpr(0);
                    expect(':');
                    const alternate = parseExpr(TERNARY_BP - 1);
                    left = node({type: 'Conditional', test: left, consequent, alternate});
                    continue;
                }

                const infix = Object.prototype.hasOwnProperty.call(INFIX, token.value)
                    ? INFIX[token.value]
                    : undefined;
                if (!infix || infix.bp <= minBp) break;

                i++;
                const right = parseExpr(infix.bp);
                left = node({
                    type: infix.logical ? 'Logical' : 'Binary',
                    operator: token.value,
                    left,
                    right
                });
            }

            return left;
        } finally {
            nest--;
        }
    }

    function parsePrefix() {
        const token = peek();

        if (token.type === 'num' || token.type === 'str') {
            i++;
            return node({type: 'Literal', value: token.value});
        }

        if (token.type === 'ident') {
            const rejection = REJECTED_WORDS.get(token.value);
            if (rejection) fail(rejection);
            i++;
            return node({type: 'Identifier', name: token.value});
        }

        if (token.type === 'punct') {
            if (UNARY.has(token.value)) {
                i++;
                return node({
                    type: 'Unary',
                    operator: token.value,
                    argument: parseExpr(UNARY_BP)
                });
            }
            if (token.value === '(') {
                i++;
                const inner = parseExpr(0);
                expect(')');
                return inner;
            }
            if (token.value === '[') fail('array literals are not supported');
        }

        return fail(`unexpected ${describe(token)}`);
    }

    function parsePostfix(left) {
        if (eat('.')) {
            const token = peek();
            if (token.type !== 'ident') {
                fail(`expected a property name after "." but found ${describe(token)}`);
            }
            i++;
            return node({type: 'Member', object: left, property: token.value, computed: false});
        }

        if (eat('[')) {
            const property = parseExpr(0);
            expect(']');
            return node({type: 'Member', object: left, property, computed: true});
        }

        // A call. Ordinarily the callee must be a bare name, which is then
        // looked up in the helper registry and nowhere else - see evaluateCall.
        // Rejecting `x.foo()` HERE rather than at evaluation is deliberate: it
        // is a grammatical fact, not a data-dependent one, so the author gets
        // told at compile time instead of on whichever render first reaches it.
        //
        // `allowMethodCalls` is the one exception, and only an event binding
        // sets it. See the MethodCall note in evaluateNode for why the evaluator
        // still refuses to perform one even after the parser has accepted it.
        expect('(');
        const method = allowMethodCalls && left.type === 'Member';
        if (left.type !== 'Identifier' && !method) {
            fail('only registered helpers can be called - `x.foo()` is not supported');
        }

        const args = [];
        if (!at(')')) {
            do {
                args.push(parseExpr(0));
            } while (eat(','));
        }
        expect(')');

        if (method) {
            return node({
                type: 'MethodCall',
                object: left.object,
                property: left.property,
                computed: left.computed,
                args: Object.freeze(args)
            });
        }

        return node({type: 'Call', callee: left.name, args: Object.freeze(args)});
    }

    if (tokens.length === 1) throw new ExpressionError('the expression is empty');

    const ast = parseExpr(0);
    if (peek().type !== 'eof') fail(`unexpected ${describe(peek())}`);

    const depth = astDepth(ast);
    if (depth > MAX_DEPTH) {
        throw new ExpressionError(`expression nests deeper than ${MAX_DEPTH} levels (${depth})`);
    }

    return ast;
}

/** Token → a phrase fit for an error message. */
function describe(token) {
    if (token.type === 'eof') return 'end of expression';
    if (token.type === 'str') return `string ${JSON.stringify(token.value)}`;
    if (token.type === 'num') return `literal ${String(token.value)}`;
    return `"${token.value}"`;
}

/**
 * Depth of a finished AST, measured iteratively.
 *
 * The parser's own recursion counter cannot see this: `1+1+1+…` is one loop
 * iteration per term with no recursion at all, yet produces a left-nested tree
 * as deep as it is long - which the evaluator, which IS recursive, would then
 * walk. Measuring the tree after the fact catches both shapes with one number,
 * and does so without recursing itself.
 */
function astDepth(root) {
    let max = 0;
    const stack = [[root, 1]];

    while (stack.length > 0) {
        const [current, depth] = stack.pop();
        if (depth > max) max = depth;

        // Stop as soon as the answer can only get worse. Without this a hostile
        // 100k-term chain is measured in full before being rejected.
        if (max > MAX_DEPTH) return max;

        for (const child of childrenOf(current)) {
            stack.push([child, depth + 1]);
        }
    }

    return max;
}

/** Child nodes of an AST node, in no particular order. */
function childrenOf(current) {
    switch (current?.type) {
        case 'Member':
            return current.computed ? [current.object, current.property] : [current.object];
        case 'Unary':
            return [current.argument];
        case 'Binary':
        case 'Logical':
            return [current.left, current.right];
        case 'Conditional':
            return [current.test, current.consequent, current.alternate];
        case 'Call':
            return current.args;
        case 'MethodCall':
            return current.computed
                ? [current.object, current.property, ...current.args]
                : [current.object, ...current.args];
        default:
            return [];
    }
}

// ── Evaluation ────────────────────────────────────────────────────────────────

/**
 * Read one property, and the only place in this module that does.
 *
 * Exported within the package because the event binding must resolve a method
 * off its receiver, and doing that anywhere else would mean a second read path
 * with a second copy of the prototype guard - which is exactly how a guard ends
 * up applied in one place and forgotten in the other.
 *
 * ── Why the prototype guard lives here, and not in the parser ────────────────
 *
 * Because a parse-time guard cannot be complete. `a.__proto__` and
 * `a['__proto__']` are visible in the source text, but `a[key]` where `key`
 * holds the string `'__proto__'` is not - the dangerous key does not exist
 * until the moment of access. A guard that catches two forms out of three is
 * worse than one that catches all three, because it reads as though it works.
 *
 * One chokepoint also means one thing to audit and one thing to test. Every
 * property read in the evaluator - dotted, bracketed, computed, and bare
 * identifiers resolved against $data - arrives here.
 *
 * The blocked read yields `undefined` rather than throwing, so a hostile
 * expression degrades to a blank rather than taking the render down with it.
 * It warns loudly, because nothing legitimate does this.
 *
 * Note what is deliberately NOT done: the guard does not restrict reads to own
 * properties. Model getters, class accessors and `array.length` all live on a
 * prototype, and templates read them constantly. The blocklist is the whole
 * defence, which is why it covers the entry points to the prototype chain
 * rather than trying to enumerate what is safe.
 *
 * @param {*} object
 * @param {*} key
 * @returns {*}
 */
export function readMember(object, key) {
    if (object === null || object === undefined) return undefined;

    const name = String(key);
    if (BLOCKED_KEYS.has(name)) {
        console.warn(
            `${PREFIX} blocked an expression from reading "${name}" - ` +
            '__proto__, constructor and prototype are not readable from an expression'
        );
        return undefined;
    }

    return object[name];
}

/**
 * Resolve a bare name.
 *
 * The four context variables come from the context. Everything else is a
 * property of `$data` - there is no scope-chain walk up through `$parent`.
 * Knockout does not walk either, and for the same reason: a name that silently
 * resolves one level up is a name whose meaning depends on data you are not
 * looking at. `$parent.name` says what it means.
 *
 * Helper names are NOT visible here. `upper` is callable as `upper(x)` and is
 * not a value; a bare `upper` is a lookup on $data like any other name. Keeping
 * the two namespaces apart is what stops a data field from shadowing a helper,
 * or a helper leaking out as a callable value.
 */
function resolveIdentifier(name, context) {
    if (CONTEXT_KEYS.has(name)) return context[name];
    return readMember(context.$data, name);
}

/** Apply a helper, or warn once and yield undefined. */
function evaluateCall(name, args) {
    const helper = helpers.get(name);

    if (typeof helper !== 'function') {
        if (!warnedHelpers.has(name)) {
            warnedHelpers.add(name);
            console.warn(
                `${PREFIX} no helper named "${name}" is registered - ` +
                'expressions can only call helpers registered with registerHelper()'
            );
        }
        return undefined;
    }

    return helper(...args);
}

/**
 * Walk one node.
 *
 * @param {Object} current
 * @param {Object} context normalised
 * @param {number} depth
 */
function evaluateNode(current, context, depth) {
    if (depth > MAX_DEPTH) {
        throw new ExpressionError(`evaluation nests deeper than ${MAX_DEPTH} levels`);
    }

    switch (current.type) {
        case 'Literal':
            return current.value;

        case 'Identifier':
            return resolveIdentifier(current.name, context);

        case 'Member': {
            const object = evaluateNode(current.object, context, depth + 1);
            const key = current.computed
                ? evaluateNode(current.property, context, depth + 1)
                : current.property;
            return readMember(object, key);
        }

        case 'Unary': {
            const value = evaluateNode(current.argument, context, depth + 1);
            switch (current.operator) {
                case '!': return !value;
                case '-': return -value;
                default: return +value;
            }
        }

        case 'Logical': {
            // Short-circuiting is a semantic guarantee, not an optimisation:
            // `user && user.name` must not read the property when there is no
            // user, and `ok || warn()` must not call the helper when ok.
            const left = evaluateNode(current.left, context, depth + 1);
            if (current.operator === '&&') {
                return left ? evaluateNode(current.right, context, depth + 1) : left;
            }
            return left ? left : evaluateNode(current.right, context, depth + 1);
        }

        case 'Binary': {
            const left = evaluateNode(current.left, context, depth + 1);
            const right = evaluateNode(current.right, context, depth + 1);
            switch (current.operator) {
                case '+': return left + right;
                case '-': return left - right;
                case '*': return left * right;
                case '/': return left / right;
                case '%': return left % right;
                case '===': return left === right;
                case '!==': return left !== right;
                case '<': return left < right;
                case '<=': return left <= right;
                case '>': return left > right;
                default: return left >= right;
            }
        }

        case 'Conditional':
            return evaluateNode(current.test, context, depth + 1)
                ? evaluateNode(current.consequent, context, depth + 1)
                : evaluateNode(current.alternate, context, depth + 1);

        case 'Call':
            return evaluateCall(
                current.callee,
                current.args.map((arg) => evaluateNode(arg, context, depth + 1))
            );

        // Parsed, but never performed here. The parser accepts `x.foo()` when
        // the caller opts in, which lets the EVENT binding resolve and invoke it
        // at dispatch time; an expression is a read that runs inside an effect,
        // and invoking a method during a read is a side effect where the whole
        // design promises none. So the node reaches this walker only if it was
        // put somewhere it does not belong, and the honest answer is to refuse
        // and say so rather than quietly yield undefined.
        case 'MethodCall':
            throw new ExpressionError(
                'an expression cannot call a method - `x.foo()` is available to ' +
                'data-on-* handlers only, because a call during a render is a side effect'
            );

        default:
            throw new ExpressionError(`unknown node type "${current.type}"`);
    }
}

// ── Public surface ────────────────────────────────────────────────────────────

/**
 * Parse an expression, with the result cached by source text.
 *
 * A failure is cached too, as `null`. That is what makes the warning fire once
 * per broken expression rather than once per render: the second call is a cache
 * hit and says nothing. It also means the `template` label in the warning
 * belongs to whichever template reached the expression first - an acceptable
 * asymmetry, since the source text in the message is what identifies the fault.
 *
 * @param {string} source
 * @param {Object} [options]
 * @param {string} [options.template] Name of the template, for the warning.
 * @param {boolean} [options.methodCalls] Permit `x.foo()`, producing a MethodCall
 *        node the evaluator will still refuse to perform. Only the event binding
 *        sets this; see parsePostfix.
 * @returns {Object|null} a frozen AST, or null if the source did not parse
 */
export function parseExpression(source, options = {}) {
    const key = typeof source === 'string' ? source : String(source ?? '');
    const methodCalls = options.methodCalls === true;
    const store = methodCalls ? methodCallCache : cache;

    if (store.has(key)) return store.get(key);

    let ast = null;
    try {
        ast = parseSource(key, methodCalls);
        sources.set(ast, key);
    } catch (err) {
        const where = options.template ? ` in template "${options.template}"` : '';
        console.warn(
            `${PREFIX} could not parse expression "${key}"${where}: ${err.message}. ` +
            'The binding is skipped.'
        );
        ast = null;
    }

    // Bounded: see CACHE_LIMIT.
    if (store.size >= CACHE_LIMIT) store.clear();
    store.set(key, ast);

    return ast;
}

/**
 * Evaluate a parsed AST against a context.
 *
 * Never throws. An error anywhere in the walk - a helper that blew up, a
 * malformed hand-built node, a depth overrun - is reported and yields
 * `undefined`, because the alternative is one bad binding destroying a render.
 *
 * @param {Object|null} ast     from parseExpression()
 * @param {*}           context a binding context, or plain data (see normaliseContext)
 * @returns {*}
 */
export function evaluateAst(ast, context) {
    if (ast === null || typeof ast !== 'object' || typeof ast.type !== 'string') return undefined;

    try {
        // `toContext` is what keeps §5's promise that $data/$root/$parent/$index
        // resolve outside a block as well as inside one: plain data handed in
        // here is promoted to a root context before the walk begins.
        return evaluateNode(ast, toContext(context), 0);
    } catch (err) {
        const source = sources.get(ast);
        console.warn(
            `${PREFIX} expression ${source === undefined ? '(not from parseExpression) ' : `"${source}" `}` +
            'threw during evaluation:',
            err
        );
        return undefined;
    }
}

/**
 * Source → a reusable evaluator.
 *
 * This is the form the binding layer wants: call it once at compile time, keep
 * the returned function, call that per update. The AST is captured in the
 * closure, so "parse once, evaluate many" is structural rather than a promise
 * about cache behaviour.
 *
 * Returns `null` when the source does not parse, rather than a function that
 * always yields undefined, because §7 says a failed binding is *skipped* - and
 * a caller cannot skip something it cannot distinguish from a working binding.
 *
 * @param {string} source
 * @param {Object} [options] as parseExpression
 * @returns {Function|null} (context) => value
 */
export function compileExpression(source, options = {}) {
    const ast = parseExpression(source, options);
    if (ast === null) return null;
    return (context) => evaluateAst(ast, context);
}

/**
 * Source → value, in one call.
 *
 * The convenience form, for callers evaluating an expression once - a test, a
 * one-off read. It is cache-backed, so it does not re-parse on repeat calls,
 * but it does re-look-up; a binding that runs on every update should hold the
 * function from compileExpression() instead.
 *
 * @param {string} source
 * @param {*}      context
 * @param {Object} [options] as parseExpression
 * @returns {*} undefined if the source did not parse
 */
export function evaluateExpression(source, context, options = {}) {
    return evaluateAst(parseExpression(source, options), context);
}

/**
 * Which top-level names an expression reads.
 *
 * The binding layer wires one reactive effect per binding, and an effect needs
 * to know what to subscribe to. Computing that from the AST rather than from the
 * source text is the whole reason this lives here: a regular expression over
 * `{{ }}` cannot tell a property from a string literal, and would happily
 * report `'name'` as a dependency of `label === 'name'`.
 *
 * ROOT names only, deliberately. `user.email` yields `user`, not `user.email`,
 * because the package tracks whole values and not paths within them (design
 * spec §2, "deep/nested tracking" is out of scope). A consumer subscribing to
 * `user` re-runs when the object is replaced, which is the granularity the
 * graph actually offers.
 *
 * Two special cases earn their code:
 *
 *   $data.x / $root.x   yield `x`. In M3 those are the same object as the data,
 *                       so the dependency is the field, not the context name.
 *   $parent, $index     yield nothing. They are facts about position, owned by
 *                       whoever created the child context, and they do not
 *                       change without that context being rebuilt.
 *
 * Helper names are not dependencies either: `upper(name)` depends on `name`.
 * A helper is code, and code does not change under you.
 *
 * @param {string|Object|null} source an expression source, or an AST
 * @param {Object} [options] as parseExpression, when a source string is given
 * @returns {Set<string>} empty when the source did not parse
 */
export function expressionDependencies(source, options = {}) {
    const ast = typeof source === 'string' ? parseExpression(source, options) : source;
    const deps = new Set();
    if (ast === null || typeof ast !== 'object') return deps;

    const stack = [ast];
    while (stack.length > 0) {
        const current = stack.pop();
        if (current === null || typeof current !== 'object') continue;

        if (current.type === 'Identifier') {
            if (!CONTEXT_KEYS.has(current.name)) deps.add(current.name);
            continue;
        }

        if (current.type === 'Member'
            && !current.computed
            && current.object?.type === 'Identifier'
            && (current.object.name === '$data' || current.object.name === '$root')) {
            deps.add(current.property);
            continue;
        }

        for (const child of childrenOf(current)) stack.push(child);
    }

    return deps;
}

/**
 * Register a helper - the only kind of function an expression may call.
 *
 * Throws on bad input, unlike everything else here. A helper registry with a
 * typo'd name is a bug in the application, discovered in the first second of
 * development if it is loud and on some unlucky render if it is not. Templates
 * are input; this is code.
 *
 * @param {string}   name
 * @param {Function} fn
 * @returns {Function} fn, so a registration can be inlined
 */
export function registerHelper(name, fn) {
    if (typeof name !== 'string' || !isIdentifier(name)) {
        throw new TypeError(
            `${PREFIX} registerHelper: "${String(name)}" is not a valid helper name ` +
            '(it must be a plain identifier, so that an expression can spell it)'
        );
    }
    if (typeof fn !== 'function') {
        throw new TypeError(
            `${PREFIX} registerHelper: "${name}" was given a ${typeof fn}, not a function`
        );
    }

    helpers.set(name, fn);
    warnedHelpers.delete(name);   // it exists now; warn again if it is removed
    return fn;
}

/**
 * Remove a helper.
 *
 * @param {string} name
 * @returns {boolean} whether a helper of that name existed
 */
export function unregisterHelper(name) {
    return helpers.delete(name);
}

/**
 * Empty the parse cache.
 *
 * Exposed because the cache is a module global and therefore part of the
 * contract, not a hidden detail: a long-running application that generates
 * expressions, and a test suite that wants to observe a fresh parse, both need
 * a way to drop it.
 *
 * @returns {number} entries dropped
 */
export function clearExpressionCache() {
    const size = cache.size + methodCallCache.size;
    cache.clear();
    methodCallCache.clear();
    return size;
}

/** A plain identifier, per the tokeniser's own rules. */
function isIdentifier(name) {
    if (name.length === 0 || !IDENT_START.test(name[0])) return false;
    for (const char of name.slice(1)) {
        if (!IDENT_PART.test(char)) return false;
    }
    return !REJECTED_WORDS.has(name);
}
