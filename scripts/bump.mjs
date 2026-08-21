/**
 * Set the package version without reformatting package.json.
 *
 * `npm version --no-git-tag-version` does the right thing to the version and
 * the wrong thing to everything around it: it reserialises package.json with
 * npm's own formatting, which reflows hand-written inline arrays - `files` and
 * `keywords` here - into one entry per line. That lands in the release diff as
 * a dozen spurious lines around the one that matters, and has to be undone by
 * hand every time.
 *
 * So package.json is edited textually: exactly one field changes and nothing
 * else in the file is touched. package-lock.json IS reserialised, because npm
 * rewrites it on every install anyway and its formatting is not anyone's to
 * preserve.
 *
 *   node scripts/bump.mjs 0.4.2
 *
 * Refuses to run if the new version is not a plain semver, or is not higher
 * than the current one - a typo that lowers the version publishes fine and is
 * then unfixable, because npm will not let you republish a version number.
 */

import {readFileSync, writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PKG = path.join(ROOT, 'package.json');
const LOCK = path.join(ROOT, 'package-lock.json');

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

const fail = (message) => {
    console.error(`\n  bump: ${message}\n`);
    process.exit(1);
};

const next = process.argv[2];
if (!next) fail('no version given - usage: node scripts/bump.mjs X.Y.Z');
if (!SEMVER.test(next)) fail(`"${next}" is not a plain X.Y.Z version`);

const pkgSource = readFileSync(PKG, 'utf8');
const current = JSON.parse(pkgSource).version;

if (current === next) fail(`already at ${next}`);

const rank = (v) => v.match(SEMVER).slice(1, 4).map(Number);
const [a, b, c] = rank(next);
const [x, y, z] = rank(current);
if (a * 1e6 + b * 1e3 + c <= x * 1e6 + y * 1e3 + z) {
    fail(`${next} is not higher than the current ${current} - npm will not let you republish a version`);
}

// Textual, and anchored to the top-level field: a nested "version" (there is
// none today, but a devDependency block could grow one) must not match.
const versionField = new RegExp(`^(\\s*"version":\\s*)"${current.replace(/\\./g, '\\\\.')}"`, 'm');
if (!versionField.test(pkgSource)) fail(`could not find "version": "${current}" in package.json`);

writeFileSync(PKG, pkgSource.replace(versionField, `$1"${next}"`));

// The lock carries the version twice: the root, and the entry for the package
// itself. Both must move or `npm ci` reinstalls the old number.
const lock = JSON.parse(readFileSync(LOCK, 'utf8'));
lock.version = next;
if (lock.packages?.['']) lock.packages[''].version = next;
writeFileSync(LOCK, `${JSON.stringify(lock, null, 2)}\n`);

console.log(`\n  ${current} → ${next}  (package.json, package-lock.json)\n`);
