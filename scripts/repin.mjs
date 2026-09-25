/**
 * Move an exact dependency pin, touching nothing else.
 *
 *     cd <downstream checkout> && node <this repo>/scripts/repin.mjs domma-reactive 1.2.0
 *
 * Run by repin-downstream.yml in the downstream checkout. It exists because
 * `npm install pkg@X --save-exact` does not only move the pin: it re-resolves
 * the tree, and on domma-cms a re-resolve rewrote 2400 unrelated lockfile
 * lines. A re-pin PR whose diff is mostly noise is one nobody can review.
 *
 * So the edit is surgical, as it is done by hand:
 *
 *   package.json        the one `"pkg": "old"` line, by text, so its
 *                       formatting and key order are untouched
 *   package-lock.json   the root's dependency range, and the package's own
 *                       entry - version, resolved, integrity - from npm
 *
 * That is only correct while the new version has the same dependencies as
 * the old one, because the lockfile also records the tree beneath the
 * package. The two are compared as npm publishes them, not against the
 * lockfile: a lockfile can legitimately record less than the manifest (the
 * domma-cms one omits domma-js's optional live-server), and what matters is
 * whether the bump changes anything, not whether the lock was complete
 * before it. When they differ this refuses, and the re-pin needs a real
 * `npm install` by a person who can read the result.
 *
 * Exit codes: 0 moved, 3 already pinned there (nothing to do), 1 refused.
 *
 * domma/scripts/repin.mjs is the same script; keep the two in step.
 */

import {execFileSync} from 'node:child_process';
import {readFileSync, writeFileSync} from 'node:fs';

const fail = (message) => {
    console.error(`\n  repin: ${message}\n`);
    process.exit(1);
};

const [name, version] = process.argv.slice(2);
if (!name || !/^\d+\.\d+\.\d+$/.test(version || '')) fail('usage: repin.mjs <package> X.Y.Z');

const SECTIONS = ['dependencies', 'devDependencies', 'optionalDependencies'];
const DEP_FIELDS = ['dependencies', 'optionalDependencies', 'peerDependencies'];

// ── package.json ──────────────────────────────────────────────────────────────

const pkgSource = readFileSync('package.json', 'utf8');
const pkg = JSON.parse(pkgSource);

const section = SECTIONS.find((s) => pkg[s] && name in pkg[s]);
if (!section) fail(`package.json does not depend on ${name}`);

const current = pkg[section][name];
if (!/^\d+\.\d+\.\d+$/.test(current)) {
    fail(`${name} is pinned as "${current}", not an exact version - this only moves exact pins`);
}
if (current === version) {
    console.log(`${name} is already pinned at ${version}`);
    process.exit(3);
}

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
const line = new RegExp(`("${escape(name)}"\\s*:\\s*)"${escape(current)}"`, 'g');
if ((pkgSource.match(line) || []).length !== 1) {
    fail(`expected exactly one "${name}": "${current}" in package.json`);
}

// ── What npm says the two versions are ───────────────────────────────────────

const npmView = (v) => JSON.parse(execFileSync(
    'npm',
    ['view', `${name}@${v}`, 'dist.tarball', 'dist.integrity', ...DEP_FIELDS, '--json'],
    {encoding: 'utf8'}
));

const before = npmView(current);
const after = npmView(version);

const tarball = after['dist.tarball'];
const integrity = after['dist.integrity'];
if (!tarball || !integrity) fail(`npm returned no tarball or integrity for ${name}@${version}`);

// ── package-lock.json ─────────────────────────────────────────────────────────

const lockSource = readFileSync('package-lock.json', 'utf8');
const lock = JSON.parse(lockSource);

const root = lock.packages?.[''];
const entry = lock.packages?.[`node_modules/${name}`];
if (!root || !entry) fail(`package-lock.json has no packages[""] or node_modules/${name} entry - lockfile v2/v3 only`);
if (entry.version !== current) {
    fail(`package-lock.json has ${name} at ${entry.version}, package.json at ${current} - reconcile them first`);
}

const sameDeps = (a = {}, b = {}) => {
    const ka = Object.keys(a).sort();
    const kb = Object.keys(b).sort();
    return ka.length === kb.length && ka.every((k, i) => k === kb[i] && a[k] === b[k]);
};

const changed = DEP_FIELDS.filter((field) => !sameDeps(before[field], after[field]));
if (changed.length > 0) {
    fail(
        `${name}@${version} changes its own ${changed.join(', ')} since ${current} - the lockfile needs a real ` +
        `re-resolve, not a surgical edit. Re-pin by hand: npm install ${name}@${version} --save-exact`
    );
}

if (root[section]?.[name] !== undefined) root[section][name] = version;
entry.version = version;
entry.resolved = tarball;
entry.integrity = integrity;

// Written back in the indentation it came in, so the diff is the three fields.
const indent = (lockSource.match(/\n( +)"/) || [null, '  '])[1];

writeFileSync('package.json', pkgSource.replace(line, `$1"${version}"`));
writeFileSync('package-lock.json', `${JSON.stringify(lock, null, indent)}\n`);

console.log(`${name}: ${current} → ${version} (${section})`);
