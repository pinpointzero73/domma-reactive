/**
 * The default mustache renderer.
 *
 * ── Why this exists ──────────────────────────────────────────────────────────
 *
 * `compile()` used to take its renderer as a mandatory parameter, on the
 * principle that this package contributes binding machinery and not templating.
 * The principle is right; the mandatory part was not. It meant that
 *
 *     compile('<p>{{name}}</p>', {name: 'Ada'}, host)
 *
 * threw `renderFn is not a function`, so a consumer who installed the package
 * could not render anything with it until they had brought their own template
 * engine. A package that ships a binding compiler and no way to drive it is a
 * package with a hole in it.
 *
 * So `renderFn` is now optional and this is the default. Passing one still
 * overrides it completely — Domma passes `utils.render` and gets byte-identical
 * behaviour to before, because nothing in this file runs for it.
 *
 * ── Relationship to Domma's `utils.render` ───────────────────────────────────
 *
 * This implements the same surface: `{{x}}`, `{{{x}}}`, `{{#if}}` / `{{else}}`,
 * `{{#unless}}`, `{{#each}}`, `{{#with}}`, `{{> partial}}`, `{{.}}`, `{{@index}}`,
 * `{{@first}}`, `{{@last}}`. It is NOT a clone, and the divergences are listed
 * in the README rather than glossed over. The two that matter:
 *
 *   1. Blocks nest properly here, including blocks of the SAME kind. Domma's
 *      renderer matches blocks with a non-greedy regular expression, so an
 *      `{{#each}}` inside an `{{#each}}` binds to the wrong `{{/each}}`. This
 *      one counts depth.
 *   2. `{{ }}` takes the full expression subset — `{{ n > 1 ? 'many' : 'one' }}`
 *      renders here and renders empty in Domma's. A plain dotted path is still
 *      resolved by path lookup, without the parser, so the common case is
 *      identical in both behaviour and cost.
 *
 * Divergence 1 is a bug fix and divergence 2 an addition, so a template written
 * for Domma renders the same here. The reverse is not guaranteed, which is
 * exactly why the README says so.
 *
 * ── Escaping ─────────────────────────────────────────────────────────────────
 *
 * `{{x}}` escapes; `{{{x}}}` does not. That is the whole contract, it is the
 * same one every mustache implementation offers, and the triple-stache is the
 * documented, explicit opt-out. Nothing here decides whether data is safe.
 */

import {evaluateExpression} from './expression.js';

/** {{#kind expr}} — a block opener. */
const OPEN = /\{\{#(if|unless|each|with)\s+([^}]+?)\s*\}\}/;

/** Any block token, used to find the `{{else}}` that belongs to THIS block. */
const BLOCK_TOKEN = /\{\{([#/])(if|unless|each|with)(?:\s+[^}]*?)?\s*\}\}|\{\{else\}\}/g;

/** {{{x}}} */
const TRIPLE = /\{\{\{\s*([^{}]+?)\s*\}\}\}/g;

/** {{> name}} */
const PARTIAL = /\{\{>\s*([^{}]+?)\s*\}\}/g;

/** {{! comment }} */
const COMMENT = /\{\{!\s*[^{}]*?\s*\}\}/g;

/** {{x}} — not {{#…}}, {{/…}}, {{>…}}, {{!…}}, {{{…}}} */
const INTERP = /\{\{(?!\{)\s*([^#/>!{}][^{}]*?)\s*\}\}/g;

/**
 * A path we can resolve by walking keys, with no parser involved.
 *
 * The fast path is not only a performance choice. `first-name` is a perfectly
 * good key in a data object and a subtraction to the expression parser, so a
 * template that only ever uses paths should never reach the parser at all.
 */
const SIMPLE_PATH = /^[A-Za-z_$][\w$]*(?:\.[\w$]+)*$/;

/**
 * Characters that mean a `{{ }}` is an EXPRESSION rather than a key.
 *
 * Without this, `{{first-name}}` — a template reading a kebab-case key, which
 * is exactly what Domma's renderer resolves it as — parses as a subtraction and
 * renders `NaN`. Requiring whitespace around `-` and `+` separates the two: a
 * key is written closed up, arithmetic is written spaced out.
 *
 * Anything with no hint at all falls through to a raw key lookup, which is what
 * makes `{{upper name}}` (Domma's space-separated helper form) render as
 * nothing rather than warning about a template that works elsewhere.
 *
 * Exported because template-compiler.js applies the same test when deciding
 * whether a `{{ }}` becomes a live expression binding, and two copies of this
 * rule would drift.
 */
export const EXPRESSION_HINT = /[?:()[\]'"!<>=*/%]|&&|\|\||\s[-+]\s/;

const ESCAPES = {'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'};

const escapeHtml = (value) => value.replace(/[&<>"']/g, (char) => ESCAPES[char]);

/** Render a value to a string. null and undefined render as nothing, not as "null". */
const str = (value) => (value === null || value === undefined ? '' : String(value));

/**
 * Mustache truthiness: an empty array is falsy.
 *
 * Exported because `data-if` uses the same rule, and a template in which
 * `{{#if items}}` and `data-if="items"` disagreed about an empty list would be
 * indefensible.
 *
 * @param {*} value
 * @returns {boolean}
 */
export function truthy(value) {
    return Array.isArray(value) ? value.length > 0 : Boolean(value);
}

/**
 * The items of a collection that should actually be rendered.
 *
 * `observableArray.destroy(item)` marks an item `_destroy: true` and leaves it
 * in the array, so a form can still submit it to a server that deletes on that
 * flag. Every render path must agree to skip it, or the user sees rows they
 * believe they have deleted — so this is exported and the keyed reconciler uses
 * it too, rather than each implementing `{{#each}}` semantics separately.
 *
 * The scan-before-filter is deliberate. Filtering unconditionally would cost an
 * array copy on every render of every list, for a feature most pages never
 * touch; scanning costs one property read per item and allocates nothing in the
 * overwhelmingly common case where nothing is marked.
 *
 * @param {*} value the collection expression's value
 * @returns {Array} the same array when nothing is marked, otherwise a filtered copy
 */
export function liveItems(value) {
    if (!Array.isArray(value)) return [];

    for (let i = 0; i < value.length; i++) {
        const item = value[i];
        if (item !== null && typeof item === 'object' && item._destroy === true) {
            return value.filter(
                (candidate) => !(candidate !== null && typeof candidate === 'object' && candidate._destroy === true)
            );
        }
    }
    return value;
}

/** Walk a dotted path. Missing anywhere along it yields undefined. */
function resolvePath(data, path) {
    let value = data;
    for (const part of path.split('.')) {
        if (value === null || value === undefined) return undefined;
        value = value[part];
    }
    return value;
}

/**
 * One `{{ }}` expression → its value.
 *
 * The order here is the contract:
 *
 *   `.`             the current item inside {{#each}}
 *   `@…`            the loop variables — @index, @first, @last
 *   a path          resolved by walking keys (see SIMPLE_PATH)
 *   no operators    also resolved by walking keys, so `{{first-name}}` reads a
 *                   kebab-case key and `{{upper name}}` (Domma's helper form)
 *                   yields nothing instead of a parse warning
 *   anything else   handed to the expression evaluator
 *
 * The first two are renderer variables rather than expressions: neither `.` nor
 * `@index` is valid input to the parser, and both predate it.
 *
 * @param {string} source
 * @param {Object} data
 * @param {Object} options
 * @returns {*}
 */
function valueOf(source, data, options) {
    const expr = source.trim();

    if (expr === '.') {
        return data !== null && typeof data === 'object' && '.' in data ? data['.'] : data;
    }
    if (expr.startsWith('@')) return data?.[expr];
    if (SIMPLE_PATH.test(expr) || !EXPRESSION_HINT.test(expr)) return resolvePath(data, expr);

    return evaluateExpression(expr, data, options);
}

/** Substitute every interpolation in a chunk that contains no blocks. */
function interpolate(template, data, options) {
    return template
        .replace(COMMENT, '')
        .replace(PARTIAL, (_, name) => {
            const partial = options.partials?.[name.trim()];
            return partial === undefined ? '' : render(partial, data, options);
        })
        .replace(TRIPLE, (_, expr) => str(valueOf(expr, data, options)))
        .replace(INTERP, (_, expr) => escapeHtml(str(valueOf(expr, data, options))));
}

/**
 * Index of the `{{/kind}}` closing an opener whose body starts at `from`, and
 * of the `{{else}}` belonging to that same opener if there is one.
 *
 * Depth counting is what makes same-kind nesting work. A non-greedy regular
 * expression — the approach Domma's renderer takes — stops at the first close
 * token it meets, which for `{{#each a}}{{#each b}}…{{/each}}{{/each}}` is the
 * inner one, silently producing the wrong body for the outer loop.
 *
 * Depth counts openers of EVERY kind, not only this one. Counting only matching
 * kinds looks right and is not: in `{{#if a}}{{#each x}}…{{/each}}{{/if}}` the
 * `{{/each}}` would leave the counter raised, and the block's own `{{/if}}`
 * would be mistaken for a nested close. A block's close is simply the first
 * close of its kind that appears at depth zero.
 *
 * `{{else}}` is likewise only recognised at depth 0, so an `{{else}}` inside any
 * nested block belongs to that block and not to this one.
 *
 * Indices are returned relative to `template`, not to the scanned slice.
 *
 * @returns {{close: number, alternate: number}} close is -1 when unmatched
 */
function findClose(template, kind, from) {
    let depth = 0;
    let alternate = -1;

    for (const match of template.slice(from).matchAll(BLOCK_TOKEN)) {
        const at = from + match.index;

        // An {{else}} token matches the alternation's second branch, so it has
        // no capture groups.
        if (match[1] === undefined) {
            if (depth === 0 && alternate === -1) alternate = at;
            continue;
        }
        if (match[1] === '#') {
            depth++;
            continue;
        }
        if (depth === 0) {
            // A close at depth zero of some other kind is a stray token — the
            // template is malformed. Ignoring it lets this block still find its
            // own close rather than giving up on the rest of the template.
            if (match[2] === kind) return {close: at, alternate};
            continue;
        }
        depth--;
    }

    return {close: -1, alternate: -1};
}

/** The data context for one `{{#each}}` item, matching Domma's `utils.render`. */
function itemContext(item, index, length) {
    const loop = {'@index': index, '@first': index === 0, '@last': index === length - 1};
    return item !== null && typeof item === 'object'
        ? {...item, ...loop}
        : {'.': item, ...loop};
}

/**
 * Render a template against a data object.
 *
 * Signature-compatible with the `renderFn` `compile()` accepts: the third
 * parameter is optional and `compile()` never passes it.
 *
 * @param {string} template
 * @param {Object} [data]
 * @param {Object} [options]
 * @param {Object} [options.partials] name → template, for `{{> name}}`
 * @param {string} [options.template] a label for expression warnings
 * @returns {string}
 */
export function render(template, data = {}, options = {}) {
    if (typeof template !== 'string' || template.length === 0) return '';

    const open = template.match(OPEN);
    if (!open) return interpolate(template, data, options);

    const [token, kind, expr] = open;
    const bodyStart = open.index + token.length;
    const {close, alternate} = findClose(template, kind, bodyStart);

    // An unmatched opener is a typo, not a crash. Render what is there.
    if (close === -1) return interpolate(template, data, options);

    const hasElse = kind === 'if' && alternate !== -1 && alternate < close;
    const consequent = template.slice(bodyStart, hasElse ? alternate : close);
    const alternative = hasElse ? template.slice(alternate + '{{else}}'.length, close) : '';

    const before = interpolate(template.slice(0, open.index), data, options);
    const after = render(template.slice(close + `{{/${kind}}}`.length), data, options);
    const value = valueOf(expr, data, options);

    let middle = '';

    if (kind === 'if') {
        middle = truthy(value)
            ? render(consequent, data, options)
            : render(alternative, data, options);
    } else if (kind === 'unless') {
        middle = truthy(value) ? '' : render(consequent, data, options);
    } else if (kind === 'each') {
        const items = liveItems(value);
        middle = items
            .map((item, index) => render(consequent, itemContext(item, index, items.length), options))
            .join('');
    } else {
        // with — a non-object context renders nothing, as Domma's does.
        middle = value !== null && typeof value === 'object'
            ? render(consequent, value, options)
            : '';
    }

    return before + middle + after;
}
