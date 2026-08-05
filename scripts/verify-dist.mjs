/**
 * Packaged-artefact verification.
 *
 * Unit tests import from `src/`, so they prove nothing about what consumers
 * actually receive. The bug this script exists for was invisible to them: the
 * `require` condition pointed at a UMD file with a `.js` extension, and because
 * this package declares `"type": "module"`, Node parsed it as ESM. A UMD bundle
 * has no `export` statements, so `require('domma-reactive')` resolved to an
 * *empty namespace object* — no error, no warning, every CommonJS consumer
 * silently broken. Nothing in a `src/`-facing suite can see that.
 *
 * So this checks the three consumption routes as the three kinds of consumer,
 * against the real `exports` map:
 *
 *   1. require()  — self-referenced by package name, so the exports map is
 *                   exercised rather than bypassed by a direct file path
 *   2. import()   — likewise
 *   3. <script>   — the UMD bundle in a vm context with no `module`/`exports`
 *                   in scope, which is what a browser actually provides
 *
 * Each route must expose the full public surface *and* drive a real chain
 * end to end, because a bundle can export names that do not work. Three chains
 * are driven: the reactive graph, the string-only half of the template compiler
 * (the half that needs no `document` — see assertCompiler), and the expression
 * evaluator, including its prototype guard.
 *
 * The bundles are also scanned for dynamic code construction. src/ is checked
 * by the unit suite, but a bundler or minifier is perfectly capable of emitting
 * a Function constructor that no source file contains, and acceptance criterion
 * 7 is about the *package*, not the sources.
 *
 * Deliberately not part of `vitest run`: it needs `dist/`, and the normal
 * suite must never depend on a build having happened. Run via `npm run
 * test:dist`, which builds first.
 */

import {createRequire} from 'node:module';
import {existsSync, readFileSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import vm from 'node:vm';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

/** The public surface, per src/index.js. */
const EXPECTED = [
    'isEqual',
    'observable',
    'observableArray',
    'Dep',
    'DepMap',
    'Computation',
    'computed',
    'effect',
    'untracked',
    'trackingProxy',
    'flushSync',
    'annotate',
    'compile',
    'scanBlocks',
    'TemplateCompiler',
    'parseExpression',
    'evaluateAst',
    'evaluateExpression',
    'compileExpression',
    'expressionDependencies',
    'registerHelper',
    'unregisterHelper',
    'clearExpressionCache',
    'renderTemplate',
    'registerBinding',
    'unregisterBinding',
    'createRootContext',
    'createChildContext'
];

/**
 * Exports that are namespace objects rather than functions.
 * Checked for shape below instead of callability.
 */
const NAMESPACES = {
    TemplateCompiler: ['annotate', 'compile', 'scanBlocks', 'resolvePath']
};

const failures = [];

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

async function check(label, fn) {
    try {
        await fn();
        console.log(`  ok    ${label}`);
    } catch (err) {
        failures.push(label);
        console.log(`  FAIL  ${label}`);
        console.log(`        ${err.message}`);
    }
}

/** Every documented name is present and callable. */
function assertSurface(api, label) {
    assert(api !== null && typeof api === 'object', `${label}: did not resolve to an object`);

    const missing = EXPECTED.filter((name) => api[name] === undefined);
    if (missing.length === EXPECTED.length) {
        throw new Error(
            `${label}: resolved to an empty namespace — all ${EXPECTED.length} exports missing. ` +
            'A UMD bundle parsed as ESM does exactly this; check the file extension ' +
            'against package.json "type".'
        );
    }
    assert(missing.length === 0, `${label}: missing ${missing.join(', ')}`);

    const uncallable = EXPECTED.filter(
        (name) => !(name in NAMESPACES) && typeof api[name] !== 'function'
    );
    assert(uncallable.length === 0, `${label}: present but not callable — ${uncallable.join(', ')}`);

    for (const [name, members] of Object.entries(NAMESPACES)) {
        const ns = api[name];
        assert(ns !== null && typeof ns === 'object', `${label}: ${name} is not a namespace object`);
        const broken = members.filter((member) => typeof ns[member] !== 'function');
        assert(broken.length === 0, `${label}: ${name} missing callable ${broken.join(', ')}`);
    }
}

/**
 * The compiler survived bundling.
 *
 * Only the string-only half is exercised here. `compile()` needs a `document`
 * (see the DOM note in src/index.js) and none of these three routes has one:
 * Node has no DOM, and the <script> route runs in a bare vm context. That is
 * the correct boundary to test at — if `annotate` had been dropped or mangled
 * by the bundler, this catches it; `compile` is covered by the jsdom suite.
 */
function assertCompiler(api, label) {
    const {annotated, bindings} = api.annotate('<p>{{a}}</p>');

    assert(
        annotated.includes('data-dm-t="0_txt"'),
        `${label}: annotate() did not insert a text anchor — got ${annotated}`
    );
    assert(
        bindings.length === 1 && bindings[0].kind === 'text' && bindings[0].expr === 'a',
        `${label}: expected one text binding on 'a', got ${JSON.stringify(bindings)}`
    );

    const blocks = api.scanBlocks('{{#if a}}x{{/if}}');
    assert(
        blocks.length === 1 && blocks[0].kind === 'if',
        `${label}: scanBlocks() did not find the if block`
    );

    assert(
        api.TemplateCompiler.resolvePath({user: {email: 'a@b.c'}}, 'user.email') === 'a@b.c',
        `${label}: TemplateCompiler.resolvePath() did not resolve a dotted path`
    );
}

/**
 * The expression evaluator survived bundling — including its guard.
 *
 * A minifier that mangled the blocked-key set, or dropped the `String(key)`
 * coercion, would leave every name present and callable and the package
 * silently insecure. Nothing in a `src/`-facing suite can see that either.
 */
function assertExpression(api, label) {
    // Half of what follows is hostile input, and every hostile input warns.
    // The <script> route has its own console (a silent stub in the sandbox);
    // this quietens the two Node routes.
    const realWarn = console.warn;
    console.warn = () => {};
    try {
        checkExpression(api, label);
    } finally {
        console.warn = realWarn;
    }
}

function checkExpression(api, label) {
    const {compileExpression, evaluateExpression, registerHelper, unregisterHelper} = api;

    registerHelper('upper', (s) => String(s).toUpperCase());

    const evaluate = compileExpression("n > 1 ? upper(name) : 'none'");
    assert(typeof evaluate === 'function', `${label}: compileExpression did not return a function`);
    assert(
        evaluate({n: 2, name: 'ada'}) === 'ADA',
        `${label}: expected ADA, got ${JSON.stringify(evaluate({n: 2, name: 'ada'}))}`
    );
    assert(
        evaluate({n: 0, name: 'ada'}) === 'none',
        `${label}: the ternary took the wrong branch`
    );

    // Precedence survived, which a broken table would not show above.
    assert(evaluateExpression('1 + 2 * 3', {}) === 7, `${label}: precedence is wrong in the bundle`);

    // The guard survived, in all three forms.
    const hostile = ['x.__proto__', "x['__proto__']", 'x[k]', 'x.constructor'];
    for (const source of hostile) {
        const value = evaluateExpression(source, {x: {}, k: '__proto__'});
        assert(value === undefined, `${label}: ${source} was not blocked — got ${String(value)}`);
    }
    assert({}.polluted === undefined, `${label}: Object.prototype was polluted`);

    // Only registered helpers are callable.
    assert(
        evaluateExpression('alert(1)', {}) === undefined,
        `${label}: an unregistered function was callable`
    );

    unregisterHelper('upper');
}

/**
 * The renderer and the binding registry survived bundling.
 *
 * Neither can be checked by `assertCompiler` above, which is deliberately
 * restricted to the string-only half of the compiler: `compile()` needs a
 * `document` and none of these three routes has one. But the DEFAULT RENDERER
 * is pure string work, and so is the registry's attribute-claiming, so both
 * can be exercised here — and both are new enough surface that a bundler
 * dropping one would otherwise show up first in a consumer's project.
 *
 * The renderer is what makes `compile()` work with no renderFn argument, which
 * is the whole standalone story. If it is missing from a bundle, the package
 * ships a binding compiler nobody can drive.
 */
function assertBindings(api, label) {
    const {renderTemplate, registerBinding, unregisterBinding, expressionDependencies} = api;

    assert(
        renderTemplate('{{#if ok}}<b>{{name}}</b>{{else}}none{{/if}}', {ok: true, name: 'Ada'})
        === '<b>Ada</b>',
        `${label}: the default renderer did not render a block`
    );
    assert(
        renderTemplate('{{#each xs}}{{.}}{{/each}}', {xs: [1, 2]}) === '12',
        `${label}: the default renderer did not render {{#each}}`
    );
    assert(
        renderTemplate('{{h}}', {h: '<b>'}) === '&lt;b&gt;',
        `${label}: the default renderer stopped escaping`
    );
    assert(
        renderTemplate("{{ n > 1 ? 'many' : 'one' }}", {n: 3}) === 'many',
        `${label}: the default renderer lost its expression evaluation`
    );

    const deps = [...expressionDependencies('a.b + c')].sort();
    assert(
        deps.length === 2 && deps[0] === 'a' && deps[1] === 'c',
        `${label}: expressionDependencies returned ${JSON.stringify(deps)}`
    );

    // registerBinding is the mechanism the built-ins use, so a working custom
    // registration proves acceptance criterion 8 against the built artefact.
    let updated = null;
    registerBinding('dist-check', {
        attribute: 'data-dist-check',
        expression: true,
        update({binding, context}) { updated = binding.evaluate(context); return true; }
    });
    assert(
        typeof unregisterBinding === 'function' && unregisterBinding('dist-check'),
        `${label}: registerBinding/unregisterBinding did not round-trip`
    );
    assert(updated === null, `${label}: the custom handler ran when nothing asked it to`);
}

/** observable → computed → effect → write → flushSync, for real. */
function assertChain(api, label) {
    const {observable, computed, effect, flushSync} = api;

    const n = observable(2);
    const doubled = computed(() => n.value * 2);
    const seen = [];
    effect(() => seen.push(doubled.get()));

    assert(
        seen.length === 1 && seen[0] === 4,
        `${label}: effect should run once on creation with 4, got ${JSON.stringify(seen)}`
    );

    n.value = 5;
    flushSync();

    assert(
        seen.length === 2 && seen[1] === 10,
        `${label}: after write + flushSync expected [4,10], got ${JSON.stringify(seen)}`
    );
}

console.log(`\nverifying ${pkg.name}@${pkg.version} packaged artefacts\n`);

await check('declared entry points all exist on disk', () => {
    const declared = [
        ['main', pkg.main],
        ['module', pkg.module],
        ['browser', pkg.browser],
        ['exports["."].import', pkg.exports?.['.']?.import],
        ['exports["."].require', pkg.exports?.['.']?.require],
        ['exports["."].default', pkg.exports?.['.']?.default]
    ];

    for (const [field, relative] of declared) {
        assert(typeof relative === 'string', `${field} is not declared`);
        assert(existsSync(join(root, relative)), `${field} → ${relative} is missing from disk`);
    }
});

await check('require() through the exports map (CommonJS consumer)', () => {
    const require = createRequire(import.meta.url);
    const api = require(pkg.name);
    assertSurface(api, 'require()');
    assertChain(api, 'require()');
    assertCompiler(api, 'require()');
    assertExpression(api, 'require()');
    assertBindings(api, 'require()');
});

await check('import() through the exports map (ESM consumer)', async () => {
    const api = await import(pkg.name);
    assertSurface(api, 'import()');
    assertChain(api, 'import()');
    assertCompiler(api, 'import()');
    assertExpression(api, 'import()');
    assertBindings(api, 'import()');
});

await check('UMD bundle as a browser <script> (no module/exports in scope)', () => {
    const source = readFileSync(join(root, pkg.browser), 'utf8');

    // A bare context: no `module`, no `exports`, no `define` — exactly what a
    // script tag gets, and the only condition under which UMD takes its
    // global-assignment branch. A `console` IS provided, because every browser
    // has one and the package warns through it; withholding it would make the
    // sandbox less like a browser, not more.
    const context = vm.createContext({console: {warn() {}, log() {}, error() {}}});
    assert(vm.runInContext('typeof module', context) === 'undefined', 'sandbox leaked `module`');
    assert(vm.runInContext('typeof exports', context) === 'undefined', 'sandbox leaked `exports`');

    vm.runInContext(source, context);

    const api = context.DommaReactive;
    assert(api !== undefined, 'the UMD bundle did not define a DommaReactive global');
    assertSurface(api, 'window.DommaReactive');
    assertChain(api, 'window.DommaReactive');
    assertCompiler(api, 'window.DommaReactive');
    assertExpression(api, 'window.DommaReactive');
    assertBindings(api, 'window.DommaReactive');
});

await check('no dynamic code construction in any bundle (CSP: script-src \'self\')', () => {
    const forbidden = [
        [/\beval\s*\(/, 'a call to eval'],
        [/\bnew\s+Function\b/, 'the Function constructor'],
        [/\bFunction\s*\(/, 'a call to Function'],
        [/\b(setTimeout|setInterval)\s*\(\s*['"`]/, 'a string-bodied timer']
    ];

    for (const relative of [pkg.main, pkg.module, pkg.browser]) {
        const source = readFileSync(join(root, relative), 'utf8');
        for (const [pattern, description] of forbidden) {
            assert(!pattern.test(source), `${relative} contains ${description}`);
        }
    }
});

if (failures.length > 0) {
    console.log(`\n${failures.length} check(s) failed:`);
    for (const label of failures) console.log(`  - ${label}`);
    console.log();
    process.exitCode = 1;
} else {
    console.log(`\nall ${EXPECTED.length} exports verified across require(), import() and <script>\n`);
}
