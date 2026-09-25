/**
 * Turn the CHANGELOG's `## [Unreleased]` heading into `## [X.Y.Z] - YYYY-MM-DD`.
 *
 * The release notes are the one part of a release a workflow cannot write, so
 * they are written as the work lands, under `[Unreleased]`, and this is what
 * the "Cut a release" workflow does with them. Refusing to run without them is
 * the point: a release with no entry is a release nobody can read about, and
 * `make preflight` refuses the same thing.
 *
 * With `--print X.Y.Z` it instead prints an already-released section, which is
 * what the downstream re-pin PR quotes as its description.
 *
 *     node scripts/promote-changelog.mjs 1.2.0 2026-10-01
 *     node scripts/promote-changelog.mjs --print 1.2.0
 */

import {readFileSync, writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'CHANGELOG.md');

const fail = (message) => {
    console.error(`\n  promote-changelog: ${message}\n`);
    process.exit(1);
};

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The body under a `## [label]` heading, up to the next `## [` heading. */
function section(source, label) {
    const heading = new RegExp(`^## \\[${escape(label)}\\][^\\n]*\\n`, 'm');
    const match = heading.exec(source);
    if (!match) return null;

    const start = match.index + match[0].length;
    const next = source.slice(start).search(/^## \[/m);
    const end = next === -1 ? source.length : start + next;
    return {heading: match, start, end, body: source.slice(start, end).trim()};
}

const source = readFileSync(FILE, 'utf8');

if (process.argv[2] === '--print') {
    const version = process.argv[3];
    const found = version && section(source, version);
    if (!found) fail(`no '## [${version}]' section in CHANGELOG.md`);
    console.log(found.body);
    process.exit(0);
}

const [version, date] = process.argv.slice(2);
if (!/^\d+\.\d+\.\d+$/.test(version || '')) fail('usage: promote-changelog.mjs X.Y.Z YYYY-MM-DD');
if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) fail(`"${date}" is not a YYYY-MM-DD date`);

if (section(source, version)) fail(`CHANGELOG.md already has a '## [${version}]' section`);

const pending = section(source, 'Unreleased');
if (!pending) {
    fail("no '## [Unreleased]' section - write the release notes there first, then cut the release");
}
if (pending.body === '') {
    fail("'## [Unreleased]' is empty - write the release notes there first, then cut the release");
}

writeFileSync(
    FILE,
    source.slice(0, pending.heading.index) + `## [${version}] - ${date}\n` + source.slice(pending.start)
);
console.log(`\n  CHANGELOG.md: [Unreleased] → [${version}] - ${date}\n`);
