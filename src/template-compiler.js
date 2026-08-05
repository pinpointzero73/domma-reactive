/**
 * Template Binding Compiler for Domma Components
 *
 * Compiles a Mustache template into a set of *fine-grained* bindings, each of
 * which owns a small piece of the DOM and can be updated independently.
 *
 * Four binding kinds:
 *
 *   text   {{name}}                  → a <span> anchor; updated via textContent
 *   attr   class="{{cls}}"           → the owning element; updated via setAttribute
 *   block  {{#if x}}…{{/if}}         → a comment-delimited region; re-rendered in place
 *   raw    {{{html}}}                → a comment-delimited region; re-rendered in place
 *
 * Every binding declares which root fields it depends on, so the component can
 * wire one reactive effect per binding. A structural change re-renders only the
 * block that changed — never the whole component.
 *
 * The full binding set is known statically from the template, including
 * bindings nested inside blocks that are not currently rendered. Those simply
 * hold no DOM nodes until their enclosing block renders them, at which point
 * re-indexing re-attaches them by id.
 *
 * Context-shifting blocks ({{#each}} and {{#with}}) evaluate their bodies
 * against a different data object, so bindings inside them are deliberately NOT
 * bound independently — they are refreshed when the enclosing block re-renders.
 * Binding them to root fields would resolve the wrong values.
 *
 * ── Trust model ──────────────────────────────────────────────────────────────
 * Component templates are author-written source, not user input. All
 * interpolated DATA is HTML-escaped by utils.render before it reaches this
 * module; {{{triple-stache}}} is the documented, explicit opt-out. Parsing is
 * therefore funnelled through the single `parseFragment` helper below, which is
 * the only place in this file that turns a string into DOM.
 */

// ── Token patterns ────────────────────────────────────────────────────────────

/** Opening or closing block token: {{#each items}} / {{/each}} */
const BLOCK_TOKEN = /\{\{([#/])(if|unless|each|with)(?:\s+([^}]+?))?\s*\}\}/g;

/** Triple-stache raw output: {{{html}}} */
const TRIPLE = /\{\{\{\s*([^{}]+?)\s*\}\}\}/g;

/** Simple interpolation: {{name}} — not {{#…}}, {{/…}}, {{>…}}, {{!…}}, {{{…}}} */
const INTERP = /\{\{(?!\{)\s*([^#/>!{}][^{}]*?)\s*\}\}/g;

/** Opening HTML tag, tolerating quoted attribute values that contain > */
const OPEN_TAG = /<([a-zA-Z][\w:-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g;

/** An attribute with a quoted value */
const ATTR = /([\w:@.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

/** A path we can resolve against the data object (excludes helper expressions) */
const SIMPLE_PATH = /^[A-Za-z_$][\w$]*(?:\.[\w$]+)*$/;

const ANCHOR_OPEN = (id) => `<!--dm:${id}-->`;
const ANCHOR_CLOSE = (id) => `<!--/dm:${id}-->`;

// ── The single HTML parse site ────────────────────────────────────────────────

/**
 * Parse a rendered template string into a DocumentFragment.
 *
 * This is the ONLY place this module converts a string into DOM. See the trust
 * model note at the top of the file: the template is author source and the data
 * inside it has already been escaped by the renderer. A <template> element is
 * used (rather than DOMParser) because it parses context-sensitive tags such as
 * <tr>, <td>, <option> and <li> correctly at the top level.
 *
 * @param {string} html
 * @returns {DocumentFragment}
 */
function parseFragment(html) {
    const tpl = document.createElement('template');
    tpl.innerHTML = html;
    return tpl.content;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Edit ordering for insertions that land on the same index. */
const CLOSING = 0;
const OPENING = 1;

/**
 * Apply a list of {index, text, order} insertions.
 *
 * Ties matter: adjacent interpolations such as `{{a}}{{b}}` put a's closing tag
 * and b's opening tag at the same index. Closing edits are emitted before
 * opening ones so the result nests correctly (`</span><span …>`) rather than
 * interleaving.
 *
 * @param {string} source
 * @param {Array<{index:number,text:string,order:number}>} edits
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
        out += source.slice(cursor, edit.index) + edit.text;
        cursor = edit.index;
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

/** Current [start, end) ranges of every context-shifting block body. */
function shiftingRanges(annotated, blockMeta) {
    const ranges = [];
    for (let i = 0; i < blockMeta.length; i++) {
        const meta = blockMeta[i];
        if (meta.kind !== 'each' && meta.kind !== 'with') continue;
        const start = annotated.indexOf(ANCHOR_OPEN(`${i}_blk`));
        const end = annotated.indexOf(ANCHOR_CLOSE(`${i}_blk`));
        if (start !== -1 && end !== -1) ranges.push([start, end]);
    }
    return ranges;
}

// ── Compilation ───────────────────────────────────────────────────────────────

/**
 * Annotate a template with anchors and build the static binding list.
 *
 * @param {string} rawTemplate
 * @returns {{annotated: string, bindings: Array}}
 */
export function annotate(rawTemplate) {
    const bindings = [];
    let counter = 0;
    const nextId = (suffix) => `${counter++}_${suffix}`;

    // ── Pass 1: wrap every block with comment anchors ─────────────────────
    const blockMeta = scanBlocks(rawTemplate);
    const blockEdits = [];

    for (let i = 0; i < blockMeta.length; i++) {
        blockEdits.push({index: blockMeta[i].start, text: ANCHOR_OPEN(`${i}_blk`), order: OPENING});
        blockEdits.push({index: blockMeta[i].end, text: ANCHOR_CLOSE(`${i}_blk`), order: CLOSING});
    }

    let annotated = insertAll(rawTemplate, blockEdits);

    // Register a binding per block. `body` is filled in at the very end, once
    // every pass has inserted its anchors — a block that re-renders must
    // reproduce the text, attribute and nested-block anchors inside it.
    for (let i = 0; i < blockMeta.length; i++) {
        const id = `${i}_blk`;
        if (annotated.indexOf(ANCHOR_OPEN(id)) === -1) continue;

        const meta = blockMeta[i];
        bindings.push({
            id,
            kind: 'block',
            blockKind: meta.kind,
            expr: meta.expr,
            body: '',
            deps: SIMPLE_PATH.test(meta.expr)
                ? new Set([rootOf(meta.expr)])
                : collectDeps(meta.expr),
            nodes: null
        });
    }
    counter = blockMeta.length;

    // ── Pass 2: triple-staches outside context-shifting blocks ────────────
    const tripleEdits = [];
    for (const m of [...annotated.matchAll(TRIPLE)]) {
        if (inRanges(m.index, shiftingRanges(annotated, blockMeta))) continue;

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

    const shifted = shiftingRanges(annotated, blockMeta);
    const textEdits = [];

    for (const m of [...annotated.matchAll(INTERP)]) {
        if (inRanges(m.index, shifted)) continue;
        if (inRanges(m.index, rawRanges)) continue;
        // Interpolations inside a tag are attribute bindings — see pass 4
        if (isInsideTag(annotated, m.index)) continue;

        const expr = m[1].trim();
        if (!SIMPLE_PATH.test(expr)) continue;

        const id = nextId('txt');
        textEdits.push({index: m.index, text: `<span data-dm-t="${id}">`, order: OPENING});
        textEdits.push({index: m.index + m[0].length, text: '</span>', order: CLOSING});

        bindings.push({
            id, kind: 'text', expr,
            deps: new Set([rootOf(expr)]), nodes: null
        });
    }
    annotated = insertAll(annotated, textEdits);

    // ── Pass 4: dynamic attributes, grouped per element ───────────────────
    const shifted2 = shiftingRanges(annotated, blockMeta);
    const attrEdits = [];

    for (const tag of [...annotated.matchAll(OPEN_TAG)]) {
        if (inRanges(tag.index, shifted2)) continue;

        const attrBlob = tag[2] || '';
        if (!attrBlob.includes('{{')) continue;

        const parts = [];
        for (const a of attrBlob.matchAll(ATTR)) {
            const name = a[1];
            if (name.startsWith('data-dm-')) continue;

            const value = a[2] !== undefined ? a[2] : (a[3] || '');
            if (!value.includes('{{')) continue;

            const deps = collectDeps(value);
            if (deps.size === 0) continue;

            parts.push({name, tmpl: value, deps: [...deps]});
        }
        if (parts.length === 0) continue;

        const id = nextId('attr');
        const deps = new Set();
        for (const p of parts) for (const d of p.deps) deps.add(d);

        // Marker goes just before the tag's closing ">" (or "/>")
        const insertAt = tag.index + tag[0].length - (tag[3] ? 2 : 1);
        attrEdits.push({index: insertAt, text: ` data-dm-a="${id}"`, order: OPENING});

        bindings.push({id, kind: 'attr', parts, deps, nodes: null});
    }
    annotated = insertAll(annotated, attrEdits);

    // ── Final pass: capture each block's body from the fully-annotated
    // template, so re-rendering a block reproduces every anchor inside it.
    for (const b of bindings) {
        if (b.kind !== 'block') continue;
        const openTag = ANCHOR_OPEN(b.id);
        const start = annotated.indexOf(openTag);
        const end = annotated.indexOf(ANCHOR_CLOSE(b.id));
        if (start === -1 || end === -1) continue;
        b.body = annotated.slice(start + openTag.length, end);
    }

    return {annotated, bindings};
}

// ── Runtime ───────────────────────────────────────────────────────────────────

/**
 * Compile a template into a container and return a BindingController.
 *
 * @param {string}   rawTemplate       Mustache template
 * @param {Object}   data              Initial merged data context
 * @param {Element}  contentContainer  Element to render into (NOT the shadowRoot)
 * @param {Function} renderFn          (template, data) => string
 * @returns {Object} BindingController
 */
export function compile(rawTemplate, data, contentContainer, renderFn) {
    const {annotated, bindings} = annotate(rawTemplate);
    const byId = new Map(bindings.map(b => [b.id, b]));

    /** Render the whole annotated template into the container. */
    function paint(fullData) {
        contentContainer.replaceChildren(parseFragment(renderFn(annotated, fullData)));
    }

    paint(data);

    /** Re-attach DOM nodes to bindings by id across the whole container. */
    function index() {
        for (const b of bindings) b.nodes = null;

        contentContainer.querySelectorAll('[data-dm-t]').forEach(el => {
            const b = byId.get(el.getAttribute('data-dm-t'));
            if (b) (b.nodes ||= []).push(el);
        });
        contentContainer.querySelectorAll('[data-dm-a]').forEach(el => {
            const b = byId.get(el.getAttribute('data-dm-a'));
            if (b) (b.nodes ||= []).push(el);
        });

        const walker = document.createTreeWalker(
            contentContainer, NodeFilter.SHOW_COMMENT, null
        );
        const open = new Map();
        let node;
        while ((node = walker.nextNode())) {
            const text = node.data;
            if (text.startsWith('/dm:')) {
                const id = text.slice(4);
                const start = open.get(id);
                if (!start) continue;
                const b = byId.get(id);
                if (b) (b.nodes ||= []).push({open: start, close: node});
                open.delete(id);
            } else if (text.startsWith('dm:')) {
                open.set(text.slice(3), node);
            }
        }
    }

    index();

    /** Replace everything between a pair of comment anchors. */
    function replaceRegion(open, close, html) {
        const parent = open.parentNode;
        if (!parent) return;

        let node = open.nextSibling;
        while (node && node !== close) {
            const next = node.nextSibling;
            parent.removeChild(node);
            node = next;
        }

        if (!html) return;
        parent.insertBefore(parseFragment(html), close);
    }

    const controller = {
        bindings,

        /** Dependencies of a single binding. */
        deps(id) {
            return byId.get(id)?.deps || new Set();
        },

        /**
         * Update one binding in place. A binding whose enclosing block is not
         * currently rendered has no nodes and is skipped.
         *
         * @param {string} id
         * @param {Object} fullData  Merged data context
         * @returns {boolean} True if anything was written to the DOM
         */
        update(id, fullData) {
            const b = byId.get(id);
            if (!b || !b.nodes || b.nodes.length === 0) return false;

            if (b.kind === 'text') {
                const value = resolvePath(fullData, b.expr);
                const str = value !== null && value !== undefined ? String(value) : '';
                for (const el of b.nodes) el.textContent = str;
                return true;
            }

            if (b.kind === 'attr') {
                for (const el of b.nodes) {
                    for (const part of b.parts) {
                        const rendered = renderFn(part.tmpl, fullData);
                        el.setAttribute(part.name, rendered);
                        // Keep the live property in step for form controls
                        if (part.name === 'value' && 'value' in el) el.value = rendered;
                    }
                }
                return true;
            }

            // block / raw — re-render just this region, then re-index so any
            // bindings that appeared or disappeared pick up their nodes.
            const html = renderFn(b.body, fullData);
            for (const region of b.nodes) {
                replaceRegion(region.open, region.close, html);
            }
            index();
            return true;
        },

        /** Update every binding (used after a props change). */
        updateAll(fullData) {
            for (const b of bindings) controller.update(b.id, fullData);
        },

        /** Full re-render — the escape hatch for props changes. */
        rerenderAll(fullData) {
            paint(fullData);
            index();
        },

        /** @deprecated Retained for callers still using the coarse API. */
        rerender(fullData) {
            controller.rerenderAll(fullData);
        }
    };

    return controller;
}

export const TemplateCompiler = {annotate, compile, scanBlocks, resolvePath};
