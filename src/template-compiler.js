/**
 * Template Binding Compiler
 *
 * Compiles a mustache template into a set of *fine-grained* bindings, each of
 * which owns a small piece of the DOM and can be updated independently.
 *
 * Eight binding kinds, four from mustache syntax and four from attributes:
 *
 *   text   {{name}}                  → a <span> anchor; updated via textContent
 *   attr   class="{{cls}}"           → the owning element; updated via setAttribute
 *   block  {{#if x}}…{{/if}}         → a comment-delimited region; re-rendered in place
 *   raw    {{{html}}}                → a comment-delimited region; re-rendered in place
 *
 *   event  data-on-click="save"      → an event listener
 *   bind   data-bind-text="name"     → a property, attribute or class
 *   model  data-model="query"        → two-way, control ↔ data
 *   if     data-if="isOpen"          → the element is in the DOM, or it is not
 *
 * None of those eight is special to this file. Every one is a handler in the
 * registry in handlers.js, registered through the same public `registerBinding()`
 * a consumer calls; this module finds them in the template, prepares what they
 * need, and dispatches. Adding a ninth is a `registerBinding()` call with an
 * `attribute` on it and no change here.
 *
 * Every binding declares which root fields it depends on, so the caller can wire
 * one reactive effect per binding. A structural change re-renders only the block
 * that changed — never the whole component.
 *
 * The full binding set is known statically from the template, including bindings
 * nested inside blocks that are not currently rendered. Those simply hold no DOM
 * nodes until their enclosing block renders them, at which point re-indexing
 * re-attaches them by id.
 *
 * Context-shifting blocks ({{#each}} and {{#with}}) evaluate their bodies against
 * a different data object, so bindings inside them are deliberately NOT bound
 * independently — they are refreshed when the enclosing block re-renders. Binding
 * them to root fields would resolve the wrong values. THIS IS THE M4 SEAM: the
 * reconciler is what gives each item its own child context, and until it exists a
 * per-item binding has nowhere correct to resolve against. Behaviour bindings
 * inside such a block warn rather than failing silently, because a click handler
 * that is quietly not wired is worse than one that says so.
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
import {EXPRESSION_HINT, render as defaultRender} from './render.js';

const PREFIX = '[Domma Reactive]';

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

const ANCHOR_OPEN = (id) => `<!--dm:${id}-->`;
const ANCHOR_CLOSE = (id) => `<!--/dm:${id}-->`;

/** Marker attributes, in the order a node is checked against them. */
const MARKER_ATTRS = ['data-dm-t', 'data-dm-a', 'data-dm-b'];
const MARKER_SELECTOR = MARKER_ATTRS.map((name) => `[${name}]`).join(',');

/** Elements the HTML parser closes for you, so they have no matching end tag. */
const VOID_ELEMENTS = new Set([
    'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
    'link', 'meta', 'param', 'source', 'track', 'wbr'
]);

/** Legacy id suffixes. Changing these would change the markup Domma renders. */
const ID_SUFFIX = {text: 'txt', attr: 'attr', raw: 'raw', block: 'blk'};

// ── The single HTML parse site ────────────────────────────────────────────────

/**
 * Parse a rendered template string into a DocumentFragment.
 *
 * This is the ONLY place this module converts a string into DOM. See the trust
 * model note at the top of the file. A <template> element is used (rather than
 * DOMParser) because it parses context-sensitive tags such as <tr>, <td>,
 * <option> and <li> correctly at the top level.
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
                expr: (a[2] !== undefined ? a[2] : (a[3] || '')).trim()
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

/**
 * Prepare the expression half of a binding: its AST, its evaluator, its deps.
 *
 * Returns null when the source does not parse, which is the caller's signal to
 * skip the binding entirely — design spec §7 says a parse failure warns and
 * skips, never throws, and a binding that cannot be evaluated is worse than no
 * binding because it would write `undefined` over working markup.
 */
function prepareExpression(source, handler, options) {
    const ast = parseExpression(source, options);
    if (ast === null) return null;

    return {
        ast,
        evaluate: compileExpression(source, options),
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

    const warn = (key, message) => {
        if (warnedHere.has(key)) return;
        warnedHere.add(key);
        const where = options.template ? ` in template "${options.template}"` : '';
        console.warn(`${PREFIX} ${message}${where}`);
    };

    // ── Pass 1: wrap every region with comment anchors ────────────────────
    //
    // A region is a mustache block or an element carrying a region attribute
    // (data-if). They are anchored together so that a data-if inside an {{#if}},
    // or the reverse, nests correctly — insertAll sorts by position, so the two
    // kinds interleave properly without either knowing about the other.
    //
    // Block ids keep their historical `${i}_blk` numbering, so the markup Domma
    // renders is unchanged by this pass gaining a second source of regions.
    const blocks = scanBlocks(rawTemplate);
    const regionElements = scanRegionElements(rawTemplate);
    const regions = [
        ...blocks.map((b, i) => ({...b, id: `${i}_blk`, mustache: true})),
        ...regionElements.map((r, i) => ({...r, id: `${blocks.length + i}_${r.kind}`}))
    ];

    const regionEdits = [];
    for (const region of regions) {
        regionEdits.push({index: region.start, text: ANCHOR_OPEN(region.id), order: OPENING});
        regionEdits.push({index: region.end, text: ANCHOR_CLOSE(region.id), order: CLOSING});
    }

    let annotated = insertAll(rawTemplate, regionEdits);

    let counter = regions.length;
    const nextId = (kind) => `${counter++}_${ID_SUFFIX[kind] ?? kind}`;

    // Register a binding per region. `body` is filled in at the very end, once
    // every pass has inserted its anchors — a region that re-renders must
    // reproduce the text, attribute and nested-region anchors inside it.
    for (const region of regions) {
        if (annotated.indexOf(ANCHOR_OPEN(region.id)) === -1) continue;

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
        // Interpolations inside a tag are attribute bindings — see pass 4
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
                        `"${name}" inside an {{#each}} or {{#with}} block is not bound — ` +
                        'per-item bindings arrive with the reconciler. Move it outside the ' +
                        'block, or wire it up imperatively for now'
                    );
                    continue;
                }

                const handler = claim.handler;
                const prepared = handler.expression === false
                    ? {ast: null, evaluate: null, deps: new Set()}
                    : prepareExpression(value.trim(), handler, options);
                if (prepared === null) continue;

                const id = nextId(claim.kind);
                behaviourIds.push(id);
                bindings.push({
                    id,
                    kind: claim.kind,
                    arg: claim.arg,
                    expr: value.trim(),
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
 *   a dotted path      a text binding resolved by walking keys — the only form
 *                      supported before M3, and still the fast path
 *   an expression      a text binding evaluated by the parser, and primed after
 *                      the first paint because the renderer may not have
 *                      produced the right text for it
 *   anything else      no binding. `{{.}}`, `{{@index}}` and Domma's
 *                      `{{helper arg}}` belong to the renderer; the compiler
 *                      leaves them alone, exactly as it did before.
 */
function textBinding(expr, options, warn) {
    if (SIMPLE_PATH.test(expr)) {
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
 * @returns {Object} BindingController
 */
export function compile(rawTemplate, data, contentContainer, renderFn, options = {}) {
    const render = typeof renderFn === 'function' ? renderFn : defaultRender;
    const {annotated, bindings} = annotate(rawTemplate, options);
    const byId = new Map(bindings.map(b => [b.id, b]));

    /**
     * Nodes this binding has already been settled against — attached to, and
     * primed on. A WeakSet keyed by node rather than a count, because a region
     * re-render replaces its contents with brand new elements and the binding
     * must treat those as new even though there are the same number of them.
     */
    for (const b of bindings) b.seen = new WeakSet();

    /** Bindings that have acquired a node and must be primed against it. */
    let pending = [];

    /** True while the settle loop below is draining `pending`. */
    let settling = false;

    /**
     * Convergence bound for the settle loop below.
     *
     * Each round only queues bindings that saw a node they had not seen before,
     * so rounds are bounded by template nesting depth and twenty is far past
     * anything real. Being honest about what the loop is for: for every
     * built-in binding, one round suffices, because a region's re-render
     * re-indexes before the rest of the round runs and so refreshes the nodes
     * of everything still queued. The loop exists for a CUSTOM region binding
     * whose update reveals anchors that were not in the document at all — the
     * one case a single pass cannot reach — and to guarantee termination if one
     * ever fails to converge.
     */
    const MAX_SETTLE_ROUNDS = 20;

    /**
     * The context every handler resolves against.
     *
     * Held on the controller rather than passed in per call because an event
     * listener fires long after the update that wired it, and has to read
     * whatever the data is at that moment. Every entry point that receives data
     * refreshes it.
     */
    let context = toContext(data);

    /** Render the whole annotated template into the container. */
    function paint(fullData) {
        contentContainer.replaceChildren(parseFragment(render(annotated, fullData)));
    }

    /** Re-attach DOM nodes to bindings by id across the whole container. */
    function index() {
        for (const b of bindings) b.nodes = null;

        for (const el of contentContainer.querySelectorAll(MARKER_SELECTOR)) {
            for (const attrName of MARKER_ATTRS) {
                const raw = el.getAttribute(attrName);
                if (raw === null) continue;
                for (const id of raw.split(/\s+/)) {
                    const b = byId.get(id);
                    if (b) (b.nodes ||= []).push(el);
                }
            }
        }

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

        collectNewNodes();
        settle();
    }

    /**
     * Attach handlers to nodes not seen before, and queue the bindings that
     * must now be primed against them.
     *
     * A region's "node" is a pair of comment anchors rather than an element;
     * the opening anchor is its identity, and it is never attached to — only
     * element-anchored bindings have listeners.
     */
    function collectNewNodes() {
        for (const b of bindings) {
            if (b.nodes === null) continue;

            const handler = bindingHandler(b.kind);
            let fresh = false;

            for (const node of b.nodes) {
                const key = node.nodeType === undefined ? node.open : node;
                if (b.seen.has(key)) continue;
                b.seen.add(key);
                fresh = true;
                if (node.nodeType !== undefined) {
                    handler?.attach?.({binding: b, node, controller});
                }
            }

            if (fresh && b.prime === true) pending.push(b);
        }
    }

    /**
     * Prime every binding that the render could not have got right.
     *
     * A `{{name}}` is already correct after a paint — the renderer substituted
     * it. `data-bind-text="name"` is not, because there is no token in an
     * attribute for a renderer to substitute. Neither is a binding that has
     * just been REVEALED by a block re-rendering: without this, an
     * `{{#if editing}}<input data-model="draft">{{/if}}` would come back empty
     * every time it opened, and would stay empty until `draft` happened to
     * change. Domma updates one binding at a time, so nothing else would have
     * filled it in.
     *
     * Priming a region replaces its contents, which reveals further bindings —
     * hence the rounds, which are what make this correct. Regions go first
     * within a round purely to save work: priming something a region is about
     * to replace is wasted, and a later round would have to redo it anyway.
     *
     * A nested index() (a region re-render calls one) queues into `pending` and
     * returns; this loop, already running, drains what it queued.
     */
    function settle() {
        if (settling) return;
        settling = true;

        try {
            let round = 0;
            while (pending.length > 0) {
                if (++round > MAX_SETTLE_ROUNDS) {
                    console.warn(
                        `${PREFIX} a binding kept revealing new nodes after ` +
                        `${MAX_SETTLE_ROUNDS} rounds; giving up so the page still renders. ` +
                        `Kinds still pending: ${[...new Set(pending.map(b => b.kind))].join(', ')}`
                    );
                    break;
                }

                const batch = pending;
                pending = [];

                for (const regionsFirst of [true, false]) {
                    for (const b of batch) {
                        if ((bindingHandler(b.kind)?.region === true) !== regionsFirst) continue;
                        controller.update(b.id);
                    }
                }
            }
        } finally {
            settling = false;
            pending = [];
        }
    }

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
         * The binding context in force — what an event listener resolves
         * against, and what the last call to update/updateAll/rerenderAll left
         * behind. Handlers reach it through this, never through a captured copy.
         */
        context() {
            return context;
        },

        /**
         * Update one binding in place. A binding whose enclosing block is not
         * currently rendered has no nodes and is skipped.
         *
         * @param {string} id
         * @param {Object} [fullData]  merged data, or a binding context
         * @returns {boolean} True if anything was written to the DOM
         */
        update(id, fullData) {
            if (fullData !== undefined) context = toContext(fullData);

            const b = byId.get(id);
            if (!b || !b.nodes || b.nodes.length === 0) return false;

            const handler = bindingHandler(b.kind);
            if (handler === undefined) return false;

            return handler.update({
                binding: b,
                nodes: b.nodes,
                context,
                render,
                replaceRegion,
                reindex: index,
                controller
            }) === true;
        },

        /** Update every binding (used after a props change). */
        updateAll(fullData) {
            if (fullData !== undefined) context = toContext(fullData);
            for (const b of bindings) controller.update(b.id);
        },

        /** Full re-render — the escape hatch for props changes. */
        rerenderAll(fullData) {
            if (fullData !== undefined) context = toContext(fullData);
            paint(context.$data);
            index();
        },

        /** @deprecated Retained for callers still using the coarse API. */
        rerender(fullData) {
            controller.rerenderAll(fullData);
        },

        /**
         * Detach everything this controller attached.
         *
         * Only listeners on nodes still indexed can be removed; nodes discarded
         * by a region re-render were collected along with their listeners long
         * ago. Per-instance lifecycle — disposing effects alongside nodes as a
         * list churns — is the reconciler's job, and M4's.
         */
        destroy() {
            for (const b of bindings) {
                const handler = bindingHandler(b.kind);
                if (handler?.detach === undefined || b.nodes === null) continue;
                for (const node of b.nodes) {
                    if (node.nodeType === undefined) continue;
                    handler.detach({binding: b, node, controller});
                }
            }
        }
    };

    paint(context.$data);
    index();

    return controller;
}

export const TemplateCompiler = {annotate, compile, scanBlocks, resolvePath};
