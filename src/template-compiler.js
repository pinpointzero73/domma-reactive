/**
 * Template Binding Compiler
 *
 * Compiles a mustache template into a set of *fine-grained* bindings, each of
 * which owns a small piece of the DOM and can be updated independently.
 *
 * Eleven binding kinds, five from mustache syntax and six from attributes:
 *
 *   text   {{name}}                  → a <span> anchor; updated via textContent
 *   attr   class="{{cls}}"           → the owning element; updated via setAttribute
 *   block  {{#if x}}…{{/if}}         → a comment-delimited region; re-rendered in place
 *   raw    {{{html}}}                → a comment-delimited region; re-rendered in place
 *   each   {{#each xs key=id}}…      → a comment-delimited region; RECONCILED per item
 *
 *   event  data-on-click="save"      → an event listener
 *   bind   data-bind-text="name"     → a property, attribute or class
 *   model  data-model="query"        → two-way, control ↔ data
 *   if     data-if="isOpen"          → the element is in the DOM, or it is not
 *   options data-options="cities"    → the options of a <select>
 *   focus  data-focus="editing"      → two-way, value ↔ focus
 *
 * None of those eleven is special to this file. Every one is a handler in the
 * registry in handlers.js, registered through the same public `registerBinding()`
 * a consumer calls; this module finds them in the template, prepares what they
 * need, and dispatches. Adding a tenth is a `registerBinding()` call with an
 * `attribute` on it and no change here.
 *
 * Every binding declares which root fields it depends on, so the caller can wire
 * one reactive effect per binding. A structural change re-renders only the block
 * that changed - never the whole component.
 *
 * The full binding set is known statically from the template, including bindings
 * nested inside blocks that are not currently rendered. Those simply hold no DOM
 * nodes until their enclosing block renders them, at which point re-indexing
 * re-attaches them by id.
 *
 * ── Two kinds of {{#each}} ───────────────────────────────────────────────────
 *
 * A KEYED block - `{{#each rows key=id}}` - is removed from the annotated
 * template entirely. Its body is compiled separately into a cloneable
 * `<template>` (see `buildFactory`), and the reconciler clones one instance per
 * item, each with its own binding context and its own effects. Everything works
 * inside one: text, attributes, events, two-way binding, nested blocks, nested
 * keyed blocks.
 *
 * An UNKEYED block, and `{{#with}}`, evaluate their bodies against a different
 * data object with no per-item identity to hang anything on, so bindings inside
 * them are deliberately NOT bound independently - they are refreshed when the
 * enclosing block re-renders, exactly as they were before M4. Binding them to
 * root fields would resolve the wrong values. Behaviour bindings inside such a
 * block warn rather than failing silently, because a click handler that is
 * quietly not wired is worse than one that says so.
 *
 * ── Trust model ──────────────────────────────────────────────────────────────
 * Templates are author-written source, not user input. All interpolated DATA is
 * HTML-escaped by the renderer before it reaches this module; {{{triple-stache}}}
 * is the documented, explicit opt-out. Parsing is therefore funnelled through the
 * single `parseFragment` helper below, which is the only place in this file that
 * turns a string into DOM.
 */

import {toContext} from './context.js';
import {compileExpression, expressionDependencies, parseExpression} from './expression.js';
import {bindingHandler, claimAttribute} from './handlers.js';
import {
    ANCHOR_CLOSE,
    ANCHOR_OPEN,
    parseFragment
} from './nodes.js';
import {EXPRESSION_HINT, render as defaultRender} from './render.js';
import {registerComponentHandler} from './components.js';
import {registerEachHandler} from './reconciler.js';
import {createRuntime} from './runtime.js';

const PREFIX = '[Domma Reactive]';

// ── Token patterns ────────────────────────────────────────────────────────────

/** Opening or closing block token: {{#each items}} / {{/each}} */
const BLOCK_TOKEN = /\{\{([#/])(if|unless|each|with)(?:\s+([^}]+?))?\s*\}\}/g;

/** Triple-stache raw output: {{{html}}} */
const TRIPLE = /\{\{\{\s*([^{}]+?)\s*\}\}\}/g;

/** Simple interpolation: {{name}} - not {{#…}}, {{/…}}, {{>…}}, {{!…}}, {{{…}}} */
const INTERP = /\{\{(?!\{)\s*([^#/>!{}][^{}]*?)\s*\}\}/g;

/** Partial reference: {{> name}} */
const PARTIAL = /\{\{>\s*[^{}]+?\s*\}\}/;

/**
 * A `data-each` attribute, and whatever it was given.
 *
 * `data-each` is an applyBindings spelling, implemented directly there. The
 * compiler discovers lists from `{{#each}}` only, so the attribute is inert in
 * anything this module annotates - including a keyed block body, which is where
 * it bites: an author nests one list inside another, the inner attribute is left
 * exactly as written, and the bindings inside it quietly resolve against the
 * OUTER item. Nothing was wrong enough to say anything about, which is the
 * problem. See the warning in `annotate`.
 */
const EACH_ATTRIBUTE = /\sdata-each\s*=\s*(?:"([^"]*)"|'([^']*)')/;

/** Opening HTML tag, tolerating quoted attribute values that contain > */
const OPEN_TAG = /<([a-zA-Z][\w:-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g;

/** An attribute with a quoted value */
const ATTR = /([\w:@.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

/** A path we can resolve against the data object (excludes helper expressions) */
const SIMPLE_PATH = /^[A-Za-z_$][\w$]*(?:\.[\w$]+)*$/;

/**
 * The entities a serialiser can put into an attribute value, and their text.
 *
 * `&amp;` is in the same alternation as the rest rather than applied afterwards,
 * because ONE pass is what makes the order safe: scanning left to right, the
 * `&amp;` in `&amp;lt;` is consumed and the scan resumes after it, so the
 * remaining `lt;` is plain text and the result is the literal `&lt;`. Decoding
 * in two passes - entities, then `&amp;` - would turn it into `<`, which is the
 * classic double-decode and a real bug in a template compiler.
 */
const ENTITY = /&(?:lt|gt|quot|apos|nbsp|amp|#39|#x27);/g;
const ENTITY_TEXT = {
    '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'",
    '&#39;': "'", '&#x27;': "'", '&nbsp;': ' ', '&amp;': '&'
};

/**
 * An attribute value, as the DOM would have given it to getAttribute().
 *
 * An HTML attribute value is entity-encoded text, so `data-bind-class="a &amp;&amp;
 * b"` and `data-bind-class="a && b"` are the same attribute and a browser hands
 * both to getAttribute() as `a && b`. This compiler reads attributes out of a
 * STRING and so has to do that decoding itself; without it the two spellings
 * behave differently, which is the one thing HTML says they cannot.
 *
 * It is not a corner case reached only by typing an entity on purpose.
 * Serialising DOM back to HTML escapes every `&` it writes, and `el.innerHTML`
 * is exactly how applyBindings captures a `data-each` body - so an ordinary
 * `data-bind-class="done && 'struck'"`, the documented idiom, came back out as
 * `&amp;&amp;` and failed to parse, with no entity anywhere in the author's page.
 *
 * Applied ONLY to values that are parsed as expressions. An ordinary attribute's
 * value is written back into the annotated template, where `&amp;` is correct
 * markup and `&quot;` inside a double-quoted value is load-bearing.
 */
function decodeAttribute(value) {
    return value.includes('&') ? value.replace(ENTITY, (m) => ENTITY_TEXT[m]) : value;
}

/*
 * EXPRESSION_HINT comes from render.js so that the compiler and the default
 * renderer answer "is this an expression or a key?" identically. The compiler
 * cannot simply hand every non-path interpolation to the parser: `{{@index}}`,
 * `{{.}}` and Domma's `{{helper arg}}` are all valid template text the parser
 * would reject, and warning about them would be noise about templates that
 * work. See the note on the constant for why `-` and `+` need whitespace.
 */

/** Forms owned by the renderer, never by the expression parser. */
const RENDERER_FORM = /^[@.]/;

/**
 * The renderer's loop variables, re-expressed against a binding context.
 *
 * Inside an UNKEYED `{{#each}}` these are substituted by the renderer, which
 * builds a per-item data object containing `@index`, `@first`, `@last` and `.`.
 * A keyed block has no render pass over its items - that is the point of it -
 * so the same four forms have to come from the context instead. Without this,
 * `{{@index}}` would work in a block and silently vanish the moment its author
 * added `key=`, which is precisely the trap a new feature must not set.
 *
 * They are only recognised when the compiler is told it is compiling an item
 * body (`options.itemForms`). At the top level `{{@index}}` means nothing, and
 * binding it to a null `$index` would print an empty span where the renderer
 * currently prints the literal text.
 */
const ITEM_FORMS = {
    '.': (context) => context.$data,
    '@index': (context) => context.$index,
    '@first': (context) => context.$index === 0,
    '@last': (context) => context.$length !== null && context.$index === context.$length - 1
};

/** Elements the HTML parser closes for you, so they have no matching end tag. */
const VOID_ELEMENTS = new Set([
    'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
    'link', 'meta', 'param', 'source', 'track', 'wbr'
]);

/** Legacy id suffixes. Changing these would change the markup Domma renders. */
const ID_SUFFIX = {text: 'txt', attr: 'attr', raw: 'raw', block: 'blk'};

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Edit ordering for insertions that land on the same index. */
const CLOSING = 0;
const OPENING = 1;

/**
 * Apply a list of {index, text, order, skip} edits.
 *
 * Ties matter: adjacent interpolations such as `{{a}}{{b}}` put a's closing tag
 * and b's opening tag at the same index. Closing edits are emitted before
 * opening ones so the result nests correctly (`</span><span …>`) rather than
 * interleaving.
 *
 * `skip` DELETES that many characters after the insertion point, which is how a
 * keyed `{{#each}}` removes itself from the annotated template - its body is
 * compiled separately into a cloneable <template>, and leaving the mustache
 * source behind would have the renderer paint a second, unmanaged copy of the
 * list before the reconciler ever ran. Edits falling inside a deleted range are
 * dropped, so a caller cannot half-annotate something it has just removed.
 *
 * @param {string} source
 * @param {Array<{index:number,text:string,order:number,skip:number}>} edits
 * @returns {string}
 */
function insertAll(source, edits) {
    if (edits.length === 0) return source;

    const sorted = [...edits].sort(
        (a, b) => a.index - b.index || (a.order ?? CLOSING) - (b.order ?? CLOSING)
    );

    let out = '';
    let cursor = 0;
    for (const edit of sorted) {
        if (edit.index < cursor) continue;
        out += source.slice(cursor, edit.index) + edit.text;
        cursor = edit.index + (edit.skip ?? 0);
    }
    return out + source.slice(cursor);
}

/** True when `index` falls inside any [start, end) range. */
function inRanges(index, ranges) {
    for (const [start, end] of ranges) {
        if (index >= start && index < end) return true;
    }
    return false;
}

/** Root field name of a path expression ("user.email" → "user"). */
function rootOf(expr) {
    return String(expr).trim().split('.')[0];
}

/** Resolve a dotted path against a data object. */
function resolvePath(data, expr) {
    const parts = String(expr).trim().split('.');
    let value = data;
    for (const part of parts) {
        if (value === null || value === undefined) return undefined;
        value = value[part];
    }
    return value;
}

/** Collect the root fields of every simple interpolation in a template chunk. */
function collectDeps(chunk) {
    const deps = new Set();

    for (const m of chunk.matchAll(INTERP)) {
        const expr = m[1].trim();
        if (SIMPLE_PATH.test(expr)) deps.add(rootOf(expr));
    }
    for (const m of chunk.matchAll(TRIPLE)) {
        const expr = m[1].trim();
        if (SIMPLE_PATH.test(expr)) deps.add(rootOf(expr));
    }

    return deps;
}

/**
 * Locate every block in a template, at any nesting depth.
 * Unmatched tokens are skipped rather than throwing.
 *
 * @param {string} template
 * @returns {Array<{start:number,end:number,kind:string,expr:string}>}
 */
export function scanBlocks(template) {
    const stack = [];
    const blocks = [];

    for (const m of template.matchAll(BLOCK_TOKEN)) {
        if (m[1] === '#') {
            stack.push({start: m.index, kind: m[2], expr: (m[3] || '').trim()});
            continue;
        }

        // Unwind to the nearest matching open token
        let open = null;
        while (stack.length > 0) {
            const candidate = stack.pop();
            if (candidate.kind === m[2]) { open = candidate; break; }
        }
        if (!open) continue;

        blocks.push({
            start: open.start,
            end: m.index + m[0].length,
            kind: open.kind,
            expr: open.expr
        });
    }

    return blocks;
}

/**
 * True when `index` sits inside an HTML tag (i.e. within an attribute value)
 * rather than in text content.
 */
function isInsideTag(source, index) {
    const lastOpen = source.lastIndexOf('<', index);
    if (lastOpen === -1) return false;
    return lastOpen > source.lastIndexOf('>', index);
}

/**
 * [start, end) of the whole element an open tag begins, close tag included.
 *
 * Depth is counted over open and close tags of the same name, so a `data-if`
 * <div> containing other <div>s finds its own `</div>`. Self-closing and void
 * elements end at their own `>`.
 *
 * @returns {[number, number]|null} null when the element is never closed
 */
function elementRange(source, tag) {
    const name = tag[1];
    const start = tag.index;
    const afterOpen = start + tag[0].length;

    if (tag[3] === '/' || VOID_ELEMENTS.has(name.toLowerCase())) return [start, afterOpen];

    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`<(/?)${escaped}(?=[\\s/>])`, 'gi');
    let depth = 1;

    for (const m of source.slice(afterOpen).matchAll(pattern)) {
        const at = afterOpen + m.index;

        if (m[1] === '/') {
            depth--;
            if (depth > 0) continue;
            const close = source.indexOf('>', at);
            return close === -1 ? null : [start, close + 1];
        }

        // A self-closing tag of the same name opens nothing.
        const gt = source.indexOf('>', at);
        if (gt !== -1 && source[gt - 1] === '/') continue;
        depth++;
    }

    return null;
}

/**
 * Every element carrying an attribute claimed by a REGION handler (`data-if`).
 *
 * These are found on the raw template, alongside the mustache blocks, because
 * both produce comment-anchored regions and the anchors must be inserted in one
 * pass for the nesting to come out right.
 */
function scanRegionElements(template) {
    const found = [];

    for (const tag of template.matchAll(OPEN_TAG)) {
        const attrBlob = tag[2] || '';
        if (!attrBlob.includes('data-')) continue;

        for (const a of attrBlob.matchAll(ATTR)) {
            const claim = claimAttribute(a[1]);
            if (claim === null || !claim.handler.region) continue;

            const range = elementRange(template, tag);
            if (range === null) break;

            found.push({
                start: range[0],
                end: range[1],
                kind: claim.kind,
                arg: claim.arg,
                expr: decodeAttribute(a[2] !== undefined ? a[2] : (a[3] || '')).trim()
            });
            break;   // one region per element; a second would nest with itself
        }
    }

    return found;
}

/** Current [start, end) ranges of every context-shifting region body. */
function shiftingRanges(annotated, regions) {
    const ranges = [];
    for (const region of regions) {
        if (region.kind !== 'each' && region.kind !== 'with') continue;
        const start = annotated.indexOf(ANCHOR_OPEN(region.id));
        const end = annotated.indexOf(ANCHOR_CLOSE(region.id));
        if (start !== -1 && end !== -1) ranges.push([start, end]);
    }
    return ranges;
}

// ── Keyed blocks ──────────────────────────────────────────────────────────────

/**
 * `{{#each items key=id}}` → the collection expression and the key property.
 *
 * `key=` is what turns a block from "re-render the lot" into "reconcile". Design
 * spec §5 makes it required for reconciliation and makes its absence a warning
 * rather than an error, so every template written before M4 keeps working
 * exactly as it did.
 *
 * The key must be a path - a property of the item. Not an expression: a key is
 * an identity, it is read once per item per reconcile, and letting it be
 * `a + b` would invite keys that change when the item's *contents* change, which
 * is the one thing a key must never do.
 */
const KEYED = /^([\s\S]*?)\s+key\s*=\s*([A-Za-z_$][\w$]*(?:\.[\w$]+)*)\s*$/;

/** The `key=…` part of an opening token, for stripping it back out again. */
const KEY_SEGMENT = /\s+key\s*=\s*[A-Za-z_$][\w$]*(?:\.[\w$]+)*/;

/** Templates already warned about an unkeyed {{#each}}. Once per session. */
const warnedUnkeyed = new Set();

/**
 * Split `items key=id` into its two halves, or null for an unkeyed block.
 *
 * @param {string} expr the whole `{{#each …}}` expression
 * @returns {{collection: string, key: string}|null}
 */
function parseKeyed(expr) {
    const m = KEYED.exec(String(expr));
    if (m === null || m[1].trim() === '') return null;
    return {collection: m[1].trim(), key: m[2]};
}

/**
 * The opening and closing token lengths of a block, so its body can be sliced.
 *
 * `scanBlocks` reports where a block starts and ends, not where its *body* does.
 * Recovering that by assuming `{{#each x}}` is a fixed width would break on
 * `{{#each  x  }}`, so the tokens are re-matched.
 *
 * @returns {[number, number]} [bodyStart, bodyEnd] absolute in `source`
 */
function bodyRange(source, block) {
    const open = /^\{\{#(?:if|unless|each|with)(?:\s+[^}]*?)?\s*\}\}/.exec(
        source.slice(block.start, block.end)
    );
    const close = /\{\{\/(?:if|unless|each|with)\s*\}\}$/.exec(
        source.slice(block.start, block.end)
    );
    if (open === null || close === null) return [block.start, block.end];
    return [block.start + open[0].length, block.start + close.index];
}

/**
 * Strip an annotated template down to a cloneable skeleton.
 *
 * This is the piece design spec §6 calls "the significant architectural shift".
 * A block body used to be re-rendered to a string per item; now it is parsed
 * ONCE into a `<template>` and cloned, which is what makes a per-item binding
 * possible at all - a binding needs a node, and a string has none.
 *
 * Two things come out:
 *
 *   region bodies    emptied. A region's handler re-renders its own contents
 *                    from `binding.body`; leaving the source in the skeleton
 *                    would paint it once, unbound, before the handler ran.
 *   `{{ }}` tokens   removed. There is no render pass over an instance, so a
 *                    token left in place would sit in the DOM as literal text
 *                    until - and only if - something happened to update it.
 *                    Every one of them has a binding that fills it on
 *                    instantiation, which is why the skeleton can be blank.
 *
 * @param {string} annotated
 * @param {Array<Object>} bindings
 * @returns {string}
 */
function toSkeleton(annotated, bindings) {
    const ranges = [];

    for (const b of bindings) {
        if (bindingHandler(b.kind)?.capturesBody !== true) continue;
        const openTag = ANCHOR_OPEN(b.id);
        const start = annotated.indexOf(openTag);
        const end = annotated.indexOf(ANCHOR_CLOSE(b.id));
        if (start === -1 || end === -1) continue;
        ranges.push([start + openTag.length, end]);
    }

    ranges.sort((a, b) => a[0] - b[0]);

    let out = '';
    let cursor = 0;
    for (const [start, end] of ranges) {
        // Nested inside a region already emptied - it went with its parent.
        if (start < cursor) continue;
        out += annotated.slice(cursor, start);
        cursor = end;
    }
    out += annotated.slice(cursor);

    return out.replace(/\{\{\{[^{}]*\}\}\}/g, '').replace(/\{\{[^{}]*\}\}/g, '');
}

/**
 * Compile a keyed block body into a factory the reconciler can clone from.
 *
 * Built lazily, on the block's first update, for one reason: `annotate()` is
 * string-only and documented as DOM-free, and a `<template>` element is not.
 * Deferring keeps that promise - a consumer can annotate a template in Node and
 * only pays for a `document` when something actually renders.
 *
 * @param {Object} binding  the `each` binding, carrying the raw body
 * @param {Function} render
 * @param {Object} options
 * @returns {Object} factory: {content, bindings, render, label, usesLength}
 */
/**
 * Everything about an item that changes when it MOVES rather than when it
 * changes.
 *
 * An instance whose index shifted - because something was inserted above it -
 * needs the bindings that render its position re-run, and nothing else. Without
 * this distinction a prepend re-runs every binding of every item below it, and
 * a `data-model` input in the list writes its stored value back over whatever
 * the user was in the middle of typing.
 */
const POSITIONAL = /\$index|\$length|@index|@first|@last/;

/** Every piece of template source a binding might read a position from. */
function sourceOf(binding) {
    const parts = (binding.parts ?? []).map((p) => p.tmpl).join(' ');
    return `${binding.expr ?? ''} ${binding.body ?? ''} ${parts}`;
}

let factorySeq = 0;

/**
 * Compile template source into a factory the reconciler can clone from.
 *
 * Shared by `{{#each}}` block bodies and by component templates, which differ
 * only in where the source came from, what the label says, and which id prefix
 * keeps their binding records apart. A second copy of this would drift the
 * moment either grew a compiler option.
 *
 * @param {string} source
 * @param {string} label
 * @param {Function} render
 * @param {Object} options
 * @param {string} idPrefix
 * @returns {Object} factory
 */
function factoryFrom(source, label, render, options, idPrefix) {
    const {annotated, bindings} = annotate(source, {
        ...options,
        itemForms: true,
        template: label,
        idPrefix
    });

    for (const b of bindings) b.positional = POSITIONAL.test(sourceOf(b));

    return {
        content: parseFragment(toSkeleton(annotated, bindings)),
        bindings,
        render,
        label,
        options,
        /*
         * Whether an instance's rendering can depend on how many siblings there
         * are. A push changes `$length` for every existing item, so without this
         * every instance in the list would be refreshed on every append - the
         * exact O(n) the reconciler exists to avoid. A source scan rather than
         * an AST walk because `@last` is a renderer form that never reaches the
         * parser, so there is no one AST to interrogate.
         *
         * Narrower than `positional` on purpose: `@index` moves an item without
         * the list's size changing, and conflating the two would put the O(n)
         * straight back.
         */
        usesLength: /@last|\$length/.test(source)
    };
}

function buildFactory(binding, render, options) {
    const label = `${options.template ? `${options.template} ` : ''}{{#each ${binding.expr}}}`;

    if (PARTIAL.test(binding.body)) {
        console.warn(
            `${PREFIX} {{> partial}} inside a keyed {{#each}} is not expanded - ` +
            `the block body is compiled once into a <template>, before any render ` +
            `pass exists to resolve a partial against. Inline it, in ${label}`
        );
    }

    return factoryFrom(binding.body, label, render, options, `i${++factorySeq}:`);
}

/**
 * A component's template, compiled once and cloned per instance.
 *
 * Same machinery as a keyed block body, and for the same reason - an instance
 * owns its effects, so it needs its own copy of the binding records.
 *
 * @param {string} source
 * @param {string} label
 * @param {Function} render
 * @param {Object} options
 * @returns {Object} factory
 */
export function componentFactory(source, label, render, options) {
    return factoryFrom(source, label, render, options, `c${++factorySeq}:`);
}

/**
 * Say once, per template, that an `{{#each}}` is re-rendering rather than
 * reconciling.
 *
 * Design spec §5 requires this: "without it the block falls back to Tier 3
 * behaviour (full re-render) and logs a one-time console warning naming the
 * template, so the degradation is visible rather than silent."
 *
 * It is deliberately once per (template, expression) for the whole session, not
 * once per compile. A component re-renders; a warning that came back on every
 * render would be noise, and noise is how a real warning gets ignored.
 *
 * @param {string} expr
 * @param {Object} options
 */
function warnUnkeyed(expr, options) {
    if (options.warnUnkeyed === false) return;

    const key = `${options.template ?? ''}|${expr}`;
    if (warnedUnkeyed.has(key)) return;
    warnedUnkeyed.add(key);

    const where = options.template ? ` in template "${options.template}"` : '';
    console.warn(
        `${PREFIX} {{#each ${expr}}}${where} has no key=, so it re-renders the whole ` +
        `block on every change - losing DOM node identity, focus and uncommitted ` +
        `input. Write {{#each ${expr} key=id}}, naming whichever property identifies ` +
        `an item, to reconcile instead.`
    );
}

/**
 * Say once that a keyed block could not be keyed after all.
 *
 * @param {string} expr
 * @param {Object} options
 */
function warnDemoted(expr, options) {
    const key = `demoted|${options.template ?? ''}|${expr}`;
    if (warnedUnkeyed.has(key)) return;
    warnedUnkeyed.add(key);

    const where = options.template ? ` in template "${options.template}"` : '';
    console.warn(
        `${PREFIX} {{#each ${expr}}}${where} sits inside an unkeyed {{#each}} or a ` +
        `{{#with}}, so it cannot reconcile: its collection would be resolved against ` +
        `the top-level data. It has been demoted to a plain re-rendered block. Add ` +
        `key= to the ENCLOSING block and both will reconcile.`
    );
}

/** For tests: forget which templates have already been warned about. */
export function resetUnkeyedWarnings() {
    warnedUnkeyed.clear();
}

/** Exposed for the `each` handler, which owns instantiation but not templates. */
export function eachFactory(binding, render) {
    if (binding.factoryBox.value === null) {
        binding.factoryBox.value = buildFactory(binding, render, binding.factoryBox.options);
    }
    return binding.factoryBox.value;
}

/**
 * Prepare the expression half of a binding: its AST, its evaluator, its deps.
 *
 * Returns null when the source does not parse, which is the caller's signal to
 * skip the binding entirely - design spec §7 says a parse failure warns and
 * skips, never throws, and a binding that cannot be evaluated is worse than no
 * binding because it would write `undefined` over working markup.
 */
function prepareExpression(source, handler, options) {
    // `methodCalls` comes from the HANDLER, not the template, so a page cannot
    // opt itself into calling methods from an interpolation. Only the event
    // binding declares it - see the note on eventHandler in handlers.js.
    const parseOptions = {...options, methodCalls: handler.methodCalls === true};

    const ast = parseExpression(source, parseOptions);
    if (ast === null) return null;

    return {
        ast,
        evaluate: compileExpression(source, parseOptions),
        deps: handler.tracks === false ? new Set() : expressionDependencies(ast)
    };
}

// ── Compilation ───────────────────────────────────────────────────────────────

/**
 * Annotate a template with anchors and build the static binding list.
 *
 * @param {string} rawTemplate
 * @param {Object} [options]
 * @param {string} [options.template] a name for this template, used in warnings
 * @returns {{annotated: string, bindings: Array}}
 */
export function annotate(rawTemplate, options = {}) {
    const bindings = [];
    const warnedHere = new Set();

    /*
     * Ids are namespaced per compiled template, and a keyed block body is a
     * compiled template of its own. Without this, an instance's `0_blk` and the
     * enclosing template's `0_blk` are the same string, and the enclosing
     * runtime - which walks every node beneath it, instance content included -
     * would happily hand an item's nodes to a binding belonging to the page.
     * Empty by default, so the markup Domma renders is unchanged.
     */
    const prefix = options.idPrefix ?? '';

    const warn = (key, message) => {
        if (warnedHere.has(key)) return;
        warnedHere.add(key);
        const where = options.template ? ` in template "${options.template}"` : '';
        console.warn(`${PREFIX} ${message}${where}`);
    };

    // Said before anything is compiled, because the alternative is silence: an
    // inert data-each renders its item template once, as ordinary markup, and
    // looks close enough to working to survive review.
    const inertEach = EACH_ATTRIBUTE.exec(rawTemplate);
    if (inertEach !== null) {
        const expr = inertEach[1] ?? inertEach[2] ?? '';
        warn(
            'inert-each',
            `data-each="${expr}" does nothing here. It is an applyBindings spelling, and this ` +
            `is compiled markup - write {{#each ${expr}}} … {{/each}} instead. A data-each ` +
            'nested inside another list is compiled markup too, which is the usual way to meet this'
        );
    }

    // Params with nothing to give them to. Said here rather than at render time
    // because the element is never claimed by any handler, so nothing downstream
    // would ever look at it - and the symptom is a component that renders with
    // every param undefined, which is indistinguishable from a typo in the
    // component name.
    for (const tag of rawTemplate.matchAll(OPEN_TAG)) {
        const attrBlob = tag[2] || '';
        if (!attrBlob.includes('data-param-')) continue;
        if (/\sdata-component\s*=/.test(attrBlob)) continue;

        const orphan = /\s(data-param-[\w-]+)/.exec(attrBlob);
        warn(
            'orphan-param',
            `${orphan === null ? 'data-param-*' : orphan[1]} does nothing on an element with no ` +
            'data-component. Check the component attribute is present and spelled correctly - ' +
            'and remember its value is an expression, so a literal name takes quotes: ' +
            'data-component="\'my-thing\'"'
        );
    }

    // ── Pass 1: wrap every region with comment anchors ────────────────────
    //
    // A region is a mustache block or an element carrying a region attribute
    // (data-if). They are anchored together so that a data-if inside an {{#if}},
    // or the reverse, nests correctly - insertAll sorts by position, so the two
    // kinds interleave properly without either knowing about the other.
    //
    // Block ids keep their historical `${i}_blk` numbering, so the markup Domma
    // renders is unchanged by this pass gaining a second source of regions.
    const blocks = scanBlocks(rawTemplate);
    const regionElements = scanRegionElements(rawTemplate);

    // A keyed {{#each}} owns its body outright: the body is compiled separately
    // into a cloneable <template>, and everything inside it belongs to the
    // instance rather than to this template. So the block is REMOVED from the
    // annotated source, and every region that fell inside it is dropped here -
    // annotating markup that is about to be deleted would leave orphan anchors
    // and bindings that could never acquire a node.
    const keyedRanges = [];
    const demoted = new Set();

    /*
     * A keyed block inside an UNKEYED {{#each}} or a {{#with}} cannot reconcile.
     * Its collection expression would be evaluated against the top-level data,
     * where the name means nothing, and the list would render EMPTY - the worst
     * of the three possible outcomes, because the page looks finished. So it is
     * demoted to an ordinary block: the `key=` is stripped from its opening
     * token, the enclosing block re-renders it as a string like every other
     * nested block, and it says why.
     *
     * A keyed block inside a KEYED one is a different matter entirely and is
     * fully supported - it is compiled as part of the outer block's item body,
     * which is why those are filtered out here rather than demoted.
     */
    const shifting = blocks
        .filter((b) => b.kind === 'with' || (b.kind === 'each' && parseKeyed(b.expr) === null))
        .map((b) => [b.start, b.end]);

    for (const b of blocks) {
        if (b.kind !== 'each' || parseKeyed(b.expr) === null) continue;

        if (shifting.some(([ss, se]) => b.start > ss && b.end <= se)) {
            demoted.add(b.start);
            warnDemoted(b.expr, options);
            continue;
        }
        keyedRanges.push([b.start, b.end]);
    }

    const insideKeyed = (start, end) =>
        keyedRanges.some(([ks, ke]) => start > ks && end <= ke);

    const regions = [
        ...blocks
            .map((b, i) => ({...b, id: `${prefix}${i}_blk`, mustache: true}))
            .filter((b) => !insideKeyed(b.start, b.end)),
        ...regionElements
            .map((r, i) => ({...r, id: `${prefix}${blocks.length + i}_${r.kind}`}))
            .filter((r) => !insideKeyed(r.start, r.end))
    ];

    const regionEdits = [];
    for (const region of regions) {
        if (region.mustache && demoted.has(region.start)) {
            // Strip `key=…` from the opening token, so the renderer sees an
            // ordinary {{#each rows}} rather than an expression it cannot parse.
            const token = rawTemplate.slice(region.start, region.end);
            const keyPart = KEY_SEGMENT.exec(token);
            if (keyPart !== null) {
                regionEdits.push({
                    index: region.start + keyPart.index,
                    text: '',
                    order: OPENING,
                    skip: keyPart[0].length
                });
            }
            region.expr = parseKeyed(region.expr)?.collection ?? region.expr;
        }

        const keyed = region.mustache
            && region.kind === 'each'
            && !demoted.has(region.start)
            && parseKeyed(region.expr);
        if (keyed) {
            // Anchors only, and the source between them deleted.
            regionEdits.push({
                index: region.start,
                text: ANCHOR_OPEN(region.id) + ANCHOR_CLOSE(region.id),
                order: OPENING,
                skip: region.end - region.start
            });
            region.keyed = keyed;
            const [bodyStart, bodyEnd] = bodyRange(rawTemplate, region);
            region.rawBody = rawTemplate.slice(bodyStart, bodyEnd);
            continue;
        }

        if (region.mustache && region.kind === 'each') warnUnkeyed(region.expr, options);

        regionEdits.push({index: region.start, text: ANCHOR_OPEN(region.id), order: OPENING});
        regionEdits.push({index: region.end, text: ANCHOR_CLOSE(region.id), order: CLOSING});
    }

    let annotated = insertAll(rawTemplate, regionEdits);

    let counter = regions.length;
    const nextId = (kind) => `${prefix}${counter++}_${ID_SUFFIX[kind] ?? kind}`;

    // Register a binding per region. `body` is filled in at the very end, once
    // every pass has inserted its anchors - a region that re-renders must
    // reproduce the text, attribute and nested-region anchors inside it.
    for (const region of regions) {
        if (annotated.indexOf(ANCHOR_OPEN(region.id)) === -1) continue;

        if (region.keyed) {
            const handler = bindingHandler('each');
            const prepared = prepareExpression(region.keyed.collection, handler, options);
            if (prepared === null) continue;

            bindings.push({
                id: region.id,
                kind: 'each',
                blockKind: 'each',
                expr: region.keyed.collection,
                keyPath: region.keyed.key,
                body: region.rawBody,
                ast: prepared.ast,
                evaluate: prepared.evaluate,
                deps: prepared.deps,
                prime: handler.primes === true,
                /*
                 * A shared box rather than a plain field. A list instance
                 * shallow-copies every binding record it owns, so a factory
                 * cached on the record itself would be rebuilt - parsed,
                 * annotated, skeletonised - once per instance of an enclosing
                 * list. The box survives the copy; the compiled template is
                 * built once per template, as §6 requires.
                 */
                factoryBox: {value: null, options},
                nodes: null
            });
            continue;
        }

        if (region.mustache) {
            bindings.push({
                id: region.id,
                kind: 'block',
                blockKind: region.kind,
                expr: region.expr,
                body: '',
                deps: SIMPLE_PATH.test(region.expr)
                    ? new Set([rootOf(region.expr)])
                    : collectDeps(region.expr),
                nodes: null
            });
            continue;
        }

        const handler = bindingHandler(region.kind);
        const prepared = prepareExpression(region.expr, handler, options);
        if (prepared === null) continue;

        bindings.push({
            id: region.id,
            kind: region.kind,
            arg: region.arg,
            expr: region.expr,
            body: '',
            ast: prepared.ast,
            evaluate: prepared.evaluate,
            deps: prepared.deps,
            prime: handler.primes === true,
            nodes: null
        });
    }

    // ── Pass 2: triple-staches outside context-shifting blocks ────────────
    const tripleEdits = [];
    for (const m of [...annotated.matchAll(TRIPLE)]) {
        if (inRanges(m.index, shiftingRanges(annotated, regions))) continue;

        const expr = m[1].trim();
        if (!SIMPLE_PATH.test(expr)) continue;

        const id = nextId('raw');
        tripleEdits.push({index: m.index, text: ANCHOR_OPEN(id), order: OPENING});
        tripleEdits.push({index: m.index + m[0].length, text: ANCHOR_CLOSE(id), order: CLOSING});

        bindings.push({
            id, kind: 'raw', expr, body: m[0],
            deps: new Set([rootOf(expr)]), nodes: null
        });
    }
    annotated = insertAll(annotated, tripleEdits);

    // ── Pass 3: text interpolations ───────────────────────────────────────
    const rawRanges = bindings
        .filter(b => b.kind === 'raw')
        .map(b => {
            const s = annotated.indexOf(ANCHOR_OPEN(b.id));
            const e = annotated.indexOf(ANCHOR_CLOSE(b.id));
            return s !== -1 && e !== -1 ? [s, e + ANCHOR_CLOSE(b.id).length] : null;
        })
        .filter(Boolean);

    const shifted = shiftingRanges(annotated, regions);
    const textEdits = [];

    for (const m of [...annotated.matchAll(INTERP)]) {
        if (inRanges(m.index, shifted)) continue;
        if (inRanges(m.index, rawRanges)) continue;
        // Interpolations inside a tag are attribute bindings - see pass 4
        if (isInsideTag(annotated, m.index)) continue;

        const expr = m[1].trim();
        const binding = textBinding(expr, options, warn);
        if (binding === null) continue;

        const id = nextId('text');
        textEdits.push({index: m.index, text: `<span data-dm-t="${id}">`, order: OPENING});
        textEdits.push({index: m.index + m[0].length, text: '</span>', order: CLOSING});

        bindings.push({id, ...binding, nodes: null});
    }
    annotated = insertAll(annotated, textEdits);

    // ── Pass 4: dynamic attributes and behaviour bindings, per element ────
    //
    // One pass over the open tags rather than two, so a tag carrying both
    // `class="{{cls}}"` and `data-on-click="save"` is matched once and gets both
    // markers from the same offset calculation.
    const shifted2 = shiftingRanges(annotated, regions);
    const attrEdits = [];

    for (const tag of [...annotated.matchAll(OPEN_TAG)]) {
        const attrBlob = tag[2] || '';
        const shiftedTag = inRanges(tag.index, shifted2);

        const parts = [];
        const behaviourIds = [];

        for (const a of attrBlob.matchAll(ATTR)) {
            const name = a[1];
            if (name.startsWith('data-dm-')) continue;

            const value = a[2] !== undefined ? a[2] : (a[3] || '');
            const claim = claimAttribute(name);

            if (claim !== null) {
                // Regions were anchored in pass 1 and must not be claimed twice.
                if (claim.handler.region) continue;
                if (shiftedTag) {
                    warn(
                        `shifted:${name}`,
                        `"${name}" inside an {{#each}} or {{#with}} block is not bound - ` +
                        'per-item bindings arrive with the reconciler. Move it outside the ' +
                        'block, or wire it up imperatively for now'
                    );
                    continue;
                }

                const handler = claim.handler;

                // Decoded here and not at extraction: `value` is also the
                // template for an ordinary attribute below, where the entities
                // are markup and must survive.
                const expr = decodeAttribute(value).trim();

                const prepared = handler.expression === false
                    ? {ast: null, evaluate: null, deps: new Set()}
                    : prepareExpression(expr, handler, options);
                if (prepared === null) continue;

                const id = nextId(claim.kind);
                behaviourIds.push(id);
                bindings.push({
                    id,
                    kind: claim.kind,
                    arg: claim.arg,
                    expr,
                    ast: prepared.ast,
                    evaluate: prepared.evaluate,
                    deps: prepared.deps,
                    prime: handler.primes === true,
                    nodes: null
                });
                continue;
            }

            if (shiftedTag) continue;
            if (!value.includes('{{')) continue;

            const deps = collectDeps(value);
            if (deps.size === 0) continue;

            parts.push({name, tmpl: value, deps: [...deps]});
        }

        // Marker goes just before the tag's closing ">" (or "/>")
        const insertAt = tag.index + tag[0].length - (tag[3] ? 2 : 1);

        if (parts.length > 0) {
            const id = nextId('attr');
            const deps = new Set();
            for (const p of parts) for (const d of p.deps) deps.add(d);

            attrEdits.push({index: insertAt, text: ` data-dm-a="${id}"`, order: OPENING});
            bindings.push({id, kind: 'attr', parts, deps, nodes: null});
        }

        if (behaviourIds.length > 0) {
            attrEdits.push({
                index: insertAt,
                text: ` data-dm-b="${behaviourIds.join(' ')}"`,
                order: OPENING
            });
        }
    }
    annotated = insertAll(annotated, attrEdits);

    // ── Final pass: capture each region's body from the fully-annotated
    // template, so re-rendering a region reproduces every anchor inside it.
    for (const b of bindings) {
        if (bindingHandler(b.kind)?.capturesBody !== true) continue;
        const openTag = ANCHOR_OPEN(b.id);
        const start = annotated.indexOf(openTag);
        const end = annotated.indexOf(ANCHOR_CLOSE(b.id));
        if (start === -1 || end === -1) continue;
        b.body = annotated.slice(start + openTag.length, end);
    }

    return {annotated, bindings};
}

/**
 * Decide what, if anything, a `{{ }}` becomes.
 *
 * Three outcomes:
 *
 *   a dotted path      a text binding resolved by walking keys - the only form
 *                      supported before M3, and still the fast path
 *   an expression      a text binding evaluated by the parser, and primed after
 *                      the first paint because the renderer may not have
 *                      produced the right text for it
 *   anything else      no binding. `{{.}}`, `{{@index}}` and Domma's
 *                      `{{helper arg}}` belong to the renderer; the compiler
 *                      leaves them alone, exactly as it did before.
 */
function textBinding(expr, options, warn) {
    if (options.itemForms === true && ITEM_FORMS[expr] !== undefined) {
        return {
            kind: 'text',
            expr,
            evaluate: ITEM_FORMS[expr],
            deps: new Set(),
            prime: true
        };
    }

    if (SIMPLE_PATH.test(expr)) {
        // A path through a context name is not a path through $data. Walking
        // keys from `$data` for `{{$root.title}}` looks for a field called
        // "$root" on the item and finds nothing - the evaluator is the only
        // thing that knows $root, $parent, $index and $length are not data.
        if (expr.startsWith('$')) {
            const prepared = prepareExpression(expr, bindingHandler('text'), options);
            if (prepared === null) return null;
            return {
                kind: 'text',
                expr,
                ast: prepared.ast,
                evaluate: prepared.evaluate,
                deps: prepared.deps,
                prime: true
            };
        }

        return {
            kind: 'text',
            expr,
            evaluate: (context) => resolvePath(context.$data, expr),
            deps: new Set([rootOf(expr)]),
            prime: false
        };
    }

    if (RENDERER_FORM.test(expr) || !EXPRESSION_HINT.test(expr)) return null;

    const prepared = prepareExpression(expr, bindingHandler('text'), options);
    if (prepared === null) {
        warn(`expr:${expr}`, `"{{${expr}}}" is not bound`);
        return null;
    }

    return {
        kind: 'text',
        expr,
        ast: prepared.ast,
        evaluate: prepared.evaluate,
        deps: prepared.deps,
        prime: true
    };
}

// ── Runtime ───────────────────────────────────────────────────────────────────

/**
 * Compile a template into a container and return a BindingController.
 *
 * @param {string}   rawTemplate       mustache template
 * @param {Object}   data              initial merged data context, or a binding context
 * @param {Element}  contentContainer  element to render into (NOT the shadowRoot)
 * @param {Function} [renderFn]        (template, data) => string. Defaults to the
 *                                     renderer in render.js, so the package works
 *                                     with no template engine supplied.
 * @param {Object}   [options]
 * @param {string}   [options.template] a name for this template, used in warnings
 * @param {boolean}  [options.reactive] own one effect per binding, so the DOM
 *                                     follows the data with no caller involved.
 *                                     OFF by default: Domma wires its own
 *                                     effects from `binding.deps` and calls
 *                                     `update()` inside `untracked()`, and two
 *                                     effects per binding would be one too many.
 *                                     A standalone consumer almost certainly
 *                                     wants it on. Note that list *instances*
 *                                     always own their effects either way -
 *                                     see runtime.js.
 * @returns {Object} BindingController
 */
export function compile(rawTemplate, data, contentContainer, renderFn, options = {}) {
    const render = typeof renderFn === 'function' ? renderFn : defaultRender;
    const {annotated, bindings} = annotate(rawTemplate, options);

    /** Render the whole annotated template into the container. */
    const paint = (context) => {
        contentContainer.replaceChildren(parseFragment(render(annotated, context.$data)));
    };

    const controller = createRuntime({
        bindings,
        render,
        context: toContext(data),
        getRoots: () => [...contentContainer.childNodes],
        reactive: options.reactive === true,
        label: options.template,
        repaint: paint
    });

    paint(controller.context());
    controller.index();

    return controller;
}

/*
 * Registered here, not in reconciler.js, so the dependency runs one way: this
 * module knows how to compile a block body into a cloneable factory, and hands
 * that capability to a reconciler that knows nothing about templates. The
 * alternative - reconciler.js importing `annotate` - would be a cycle between
 * the two hardest files in the package.
 */
registerEachHandler(eachFactory);

/**
 * definition → its compiled factory.
 *
 * Keyed by the definition object rather than the name, so re-registering a
 * component under the same name compiles the new template rather than serving
 * the old one from cache - and so a definition that is unregistered stops being
 * held alive by this map.
 */
const componentFactories = new WeakMap();

/** Compile once per definition, then clone per instance. */
function factoryForComponent(definition, name, render, options) {
    let factory = componentFactories.get(definition);
    if (factory === undefined) {
        factory = componentFactory(definition.template, `component ${name}`, render, options);
        componentFactories.set(definition, factory);
    }
    return factory;
}

registerComponentHandler(factoryForComponent);

export const TemplateCompiler = {annotate, compile, scanBlocks, resolvePath};
