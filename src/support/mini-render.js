/**
 * A minimal mustache renderer — TEST SUPPORT ONLY. Not exported by the package.
 *
 * `compile()` takes its renderer as a parameter, so this package deliberately
 * owns no template engine: it supplies the anchor and binding machinery, and
 * the consumer supplies the evaluation. Domma injects `utils.render`.
 *
 * The compiler's own tests still need *some* renderer, and importing Domma's
 * would invert the dependency — the package's suite would rest on its consumer.
 * So this stands in. It implements only the subset the compiler exercises:
 *
 *   {{x}} / {{x.y}}   interpolation, HTML-escaped
 *   {{{x}}}           triple-stache, raw
 *   {{.}}             the current item inside {{#each}}
 *   {{#if}} {{#unless}} {{#each}} {{#with}}, nesting to any depth
 *
 * No partials, no helpers, no `@index`, no lenient whitespace handling beyond
 * trimming. It is a fixture, not an engine: if a test needs more than this,
 * that is a signal the test has drifted from what the compiler contracts for.
 */

/** {{#kind expr}} — a block opener. */
const OPEN = /\{\{#(if|unless|each|with)\s+([^}]+?)\s*\}\}/;

/** {{{x}}} */
const TRIPLE = /\{\{\{\s*([^{}]+?)\s*\}\}\}/g;

/** {{x}} — not {{#…}}, {{/…}}, {{>…}}, {{!…}}, {{{…}}} */
const INTERP = /\{\{(?!\{)\s*([^#/>!{}][^{}]*?)\s*\}\}/g;

const ESCAPES = {'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'};

const escapeHtml = (s) => s.replace(/[&<>"']/g, (c) => ESCAPES[c]);

const str = (v) => (v === null || v === undefined ? '' : String(v));

/** Truthiness, mustache-style: an empty array is falsy. */
const truthy = (v) => (Array.isArray(v) ? v.length > 0 : Boolean(v));

/** Resolve a dotted path; `.` is the current item. */
function resolve(data, expr) {
    const path = String(expr).trim();
    if (path === '.') return data['.'];

    let value = data;
    for (const part of path.split('.')) {
        if (value === null || value === undefined) return undefined;
        value = value[part];
    }
    return value;
}

/** Substitute every interpolation in a chunk containing no blocks. */
function interpolate(template, data) {
    return template
        .replace(TRIPLE, (_, expr) => str(resolve(data, expr)))
        .replace(INTERP, (_, expr) => escapeHtml(str(resolve(data, expr))));
}

/**
 * Index of the {{/kind}} matching an opener whose body starts at `from`,
 * counting nested openers of the same kind. -1 when unmatched.
 *
 * Scanning is done with indexOf rather than a sticky regex so there is no
 * lastIndex state to reset between calls.
 */
function findClose(template, kind, from) {
    const openTag = `{{#${kind}`;
    const closeTag = `{{/${kind}}}`;

    let depth = 1;
    let cursor = from;

    while (depth > 0) {
        const nextOpen = template.indexOf(openTag, cursor);
        const nextClose = template.indexOf(closeTag, cursor);

        if (nextClose === -1) return -1;

        if (nextOpen !== -1 && nextOpen < nextClose) {
            depth++;
            cursor = nextOpen + openTag.length;
        } else {
            depth--;
            if (depth === 0) return nextClose;
            cursor = nextClose + closeTag.length;
        }
    }

    return -1;
}

/** The data context for one {{#each}} item. */
function itemContext(item, data) {
    return item !== null && typeof item === 'object'
        ? {...data, ...item, '.': item}
        : {...data, '.': item};
}

/**
 * Render a template against a data object.
 *
 * @param {string} template
 * @param {Object} data
 * @returns {string}
 */
export function render(template, data) {
    const open = template.match(OPEN);
    if (!open) return interpolate(template, data);

    const [token, kind, expr] = open;
    const bodyStart = open.index + token.length;
    const closeAt = findClose(template, kind, bodyStart);

    // Unmatched opener: treat the rest as plain text rather than throwing.
    if (closeAt === -1) return interpolate(template, data);

    const before = interpolate(template.slice(0, open.index), data);
    const body = template.slice(bodyStart, closeAt);
    const after = render(template.slice(closeAt + `{{/${kind}}}`.length), data);

    const value = resolve(data, expr);
    let middle = '';

    if (kind === 'if') {
        middle = truthy(value) ? render(body, data) : '';
    } else if (kind === 'unless') {
        middle = truthy(value) ? '' : render(body, data);
    } else if (kind === 'each') {
        middle = (Array.isArray(value) ? value : [])
            .map((item) => render(body, itemContext(item, data)))
            .join('');
    } else if (kind === 'with') {
        middle = value ? render(body, {...data, ...value, '.': value}) : '';
    }

    return before + middle + after;
}
