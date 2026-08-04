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
 * end to end, because a bundle can export names that do not work.
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
    'flushSync'
];

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

    const uncallable = EXPECTED.filter((name) => typeof api[name] !== 'function');
    assert(uncallable.length === 0, `${label}: present but not callable — ${uncallable.join(', ')}`);
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
});

await check('import() through the exports map (ESM consumer)', async () => {
    const api = await import(pkg.name);
    assertSurface(api, 'import()');
    assertChain(api, 'import()');
});

await check('UMD bundle as a browser <script> (no module/exports in scope)', () => {
    const source = readFileSync(join(root, pkg.browser), 'utf8');

    // A bare context: no `module`, no `exports`, no `define` — exactly what a
    // script tag gets, and the only condition under which UMD takes its
    // global-assignment branch.
    const context = vm.createContext({});
    assert(vm.runInContext('typeof module', context) === 'undefined', 'sandbox leaked `module`');
    assert(vm.runInContext('typeof exports', context) === 'undefined', 'sandbox leaked `exports`');

    vm.runInContext(source, context);

    const api = context.DommaReactive;
    assert(api !== undefined, 'the UMD bundle did not define a DommaReactive global');
    assertSurface(api, 'window.DommaReactive');
    assertChain(api, 'window.DommaReactive');
});

if (failures.length > 0) {
    console.log(`\n${failures.length} check(s) failed:`);
    for (const label of failures) console.log(`  - ${label}`);
    console.log();
    process.exitCode = 1;
} else {
    console.log(`\nall ${EXPECTED.length} exports verified across require(), import() and <script>\n`);
}
