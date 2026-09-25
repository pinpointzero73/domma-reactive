/**
 * Pre-fill the downstream repository's pending release notes for a re-pin.
 *
 *     cd <downstream checkout> && node <this repo>/scripts/note-repin.mjs domma-reactive 1.2.0 <url>
 *
 * Run by repin-downstream.yml after repin.mjs. A re-pin PR used to leave the
 * notes to the reviewer, and the CHANGELOG was the part that got missed - the
 * domma-cms re-pin to domma-js 0.44.4 was merged with nothing recording it, and
 * a reviewer had to point that out. So the PR now carries a factual stub, which
 * the reviewer edits to say what the upgrade means downstream.
 *
 * The stub states only what is certainly true - "built against X" - so an
 * unedited stub still ships an accurate, if terse, note.
 *
 * Two downstream formats, told apart by which file exists:
 *
 *   docs/NEXT_RELEASE.md   domma. The stub is an emoji-headed group appended
 *                          to the notes; if the file is still empty, the title
 *                          and the website summary are filled too, so the
 *                          release button will run on it.
 *   CHANGELOG.md           domma-cms. A bullet under `## [Unreleased]`, which
 *                          is created above the first release if absent.
 *
 * A second re-pin before a release REPLACES the first one's stub rather than
 * adding another, so the notes never claim two versions at once. Only the
 * stub's own wording is matched; prose a person wrote is never touched.
 *
 * domma/scripts/note-repin.mjs is the same script; keep the two in step.
 */

import {existsSync, readFileSync, writeFileSync} from 'node:fs';

const fail = (message) => {
    console.error(`\n  note-repin: ${message}\n`);
    process.exit(1);
};

const [name, version, url] = process.argv.slice(2);
if (!name || !/^\d+\.\d+\.\d+$/.test(version || '') || !url) {
    fail('usage: note-repin.mjs <package> X.Y.Z <notes url>');
}

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
const V = '\\d+\\.\\d+\\.\\d+';
const pkg = escape(name);

// ── domma: docs/NEXT_RELEASE.md ───────────────────────────────────────────────

function noteNextRelease(file) {
    const MARKER = '<!-- website -->';
    const source = readFileSync(file, 'utf8');

    const template = source.match(/^<!--[\s\S]*?-->\s*/);
    const head = template ? template[0] : '';
    const body = source.slice(head.length);

    const at = body.indexOf(MARKER);
    if (at === -1) fail(`${file} has lost its "${MARKER}" marker`);

    // The template's title line is "# " with nothing after it; drop it, so an
    // empty page is recognised as one and the stub's title takes its place.
    let notes = body.slice(0, at).replace(/^#[ \t]*$/m, '').trim();
    let summary = body.slice(at + MARKER.length).trim();

    const group = `🔁 **${name} ${version}**\n\n*   Domma is now built against ${name} ${version} - see [its release notes](${url}).`;
    const previous = new RegExp(`🔁 \\*\\*${pkg} ${V}\\*\\*\\n\\n\\*   Domma is now built against ${pkg} ${V} - see \\[its release notes\\]\\([^)]*\\)\\.`);

    const titleLine = notes.match(/^# (.*)$/m);
    const title = titleLine ? titleLine[1].trim() : '';
    const stubTitle = new RegExp(`^${pkg} ${V}$`);

    if (previous.test(notes)) {
        notes = notes.replace(previous, group);
    } else {
        notes = [notes, group].filter(Boolean).join('\n\n');
    }

    // An empty page, or a title that is only an earlier stub, gets the stub.
    if (title === '' || stubTitle.test(title)) {
        notes = notes.replace(/^# .*$/m, `# ${name} ${version}`);
        if (!/^# /m.test(notes)) notes = [`# ${name} ${version}`, notes].filter(Boolean).join('\n\n');
    }

    const stubSummary = new RegExp(`^<p>Domma is now built against ${pkg} ${V}\\.</p>$`);
    if (summary === '' || stubSummary.test(summary)) {
        summary = `<p>Domma is now built against ${name} ${version}.</p>`;
    }

    writeFileSync(file, `${head}${notes.trim()}\n\n${MARKER}\n\n${summary}\n`);
}

// ── domma-cms: CHANGELOG.md ───────────────────────────────────────────────────

function noteChangelog(file) {
    const source = readFileSync(file, 'utf8');
    const bullet = `- **Built against ${name} ${version}** - see [its release notes](${url}).`;
    const previous = new RegExp(`^- \\*\\*Built against ${pkg} ${V}\\*\\*.*$`, 'm');

    const heading = /^## \[Unreleased\][^\n]*\n/m.exec(source);

    if (!heading) {
        const first = source.search(/^## \[/m);
        if (first === -1) fail(`${file} has no release headings to put [Unreleased] above`);
        writeFileSync(file, `${source.slice(0, first)}## [Unreleased]\n\n${bullet}\n\n${source.slice(first)}`);
        return;
    }

    const start = heading.index + heading[0].length;
    const next = source.slice(start).search(/^## \[/m);
    const end = next === -1 ? source.length : start + next;
    let section = source.slice(start, end);

    if (previous.test(section)) {
        section = section.replace(previous, bullet);
    } else {
        // Bullets in one release are consecutive lines here, no blank between.
        const existing = section.trim();
        section = existing === '' ? `\n${bullet}\n\n` : `\n${existing}\n${bullet}\n\n`;
    }

    writeFileSync(file, source.slice(0, start) + section + source.slice(end));
}

if (existsSync('docs/NEXT_RELEASE.md')) {
    noteNextRelease('docs/NEXT_RELEASE.md');
    console.log(`docs/NEXT_RELEASE.md: noted ${name} ${version}`);
} else if (existsSync('CHANGELOG.md')) {
    noteChangelog('CHANGELOG.md');
    console.log(`CHANGELOG.md: noted ${name} ${version} under [Unreleased]`);
} else {
    fail('found neither docs/NEXT_RELEASE.md nor CHANGELOG.md to note the re-pin in');
}
