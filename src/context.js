/**
 * Binding context — `$data`, `$root`, `$parent`, `$index`, `$length`.
 *
 * An expression in a template is evaluated against a *context*, not against a
 * data object. The difference matters as soon as a template has a list in it:
 * inside `{{#each people}}` the name `name` must mean the person's name, while
 * `$root.title` must still reach the top of the tree and `$index` must say
 * which person this is.
 *
 * Design spec §5 fixes the four names and one further rule that is easy to miss:
 *
 *   > Outside such a block these still resolve — `$data` and `$root` are the
 *   > top-level context, `$parent` is `null`, `$index` is `null`.
 *
 * So there is no "no context" state. A caller that passes a plain object gets it
 * promoted to a root context (see `toContext`), and every one of the four names
 * answers. A binding never has to ask whether it is inside a block.
 *
 * ── $parent and $root are DATA, not contexts ─────────────────────────────────
 *
 * `$parent.name` reads the enclosing item's `name`. It does not read the
 * enclosing *context's* `name`, because a context has no `name` — it has
 * `$data`. Knockout draws the line in the same place and for the same reason:
 * the names exist to reach data one level up, and making them contexts would
 * force every template that uses them to write `$parent.$data.name`.
 *
 * The cost is that there is no `$parents[2]`. Two levels up is not reachable in
 * M3. If it turns out to be wanted, it is an additive field on this object and
 * nothing else in the package changes.
 *
 * ── Contexts are frozen ──────────────────────────────────────────────────────
 *
 * A context is a statement about where in the tree an expression sits. It is not
 * scratch space, and a binding that mutated one would silently change the
 * meaning of every other binding sharing it. Freezing makes that a TypeError in
 * strict mode rather than a bug found three renders later.
 *
 * ── This module has no imports, and must keep it that way ────────────────────
 *
 * It is the bottom of the binding layer: expression.js depends on it, handlers.js
 * depends on both. Nothing here knows what an AST is, what a DOM node is, or
 * that a template exists. That is what makes it testable on its own.
 */

/**
 * The names an expression may use that do not come from `$data`.
 *
 * Exported because both the evaluator (which must resolve them from the context
 * rather than the data) and the binding layer (which must refuse to *write*
 * through them) need the same list, and two lists would drift.
 *
 * ── $length, the fifth name, added in M4 ─────────────────────────────────────
 *
 * Design spec §5 fixes four. This is the fifth, and it is here for one concrete
 * reason: `{{@last}}` inside a keyed `{{#each}}`. `@index` and `@first` are
 * answerable from `$index` alone; "am I the last one?" is not answerable without
 * knowing how many there are, and the alternative — leaving `{{@last}}` silently
 * empty inside a keyed block while it works inside an unkeyed one — would be a
 * trap set by the very feature meant to be the upgrade.
 *
 * It is `null` outside a list, exactly as `$index` is, so the §5 rule that every
 * context name resolves everywhere still holds.
 */
export const CONTEXT_KEYS = new Set(['$data', '$root', '$parent', '$index', '$length']);

/**
 * The top-level context for a data object.
 *
 * `$root` is the same object as `$data` — at the root they are by definition the
 * same thing — and both of the block-only names are null.
 *
 * @param {*} data
 * @returns {{$data: *, $root: *, $parent: null, $index: null,
 *            $length: null}} frozen
 */
export function createRootContext(data) {
    return Object.freeze({
        $data: data, $root: data, $parent: null, $index: null, $length: null
    });
}

/**
 * A context one level down — for an item of a list, or the body of a `with`.
 *
 * `$root` is inherited rather than recomputed, so it stays the top of the tree
 * however deep the nesting goes. `$parent` is the enclosing *data*, per the note
 * at the top of this file.
 *
 * `parent` may be a context or a plain data object; a plain object is promoted
 * first, so a caller building the first child of a root does not have to make
 * the root explicitly.
 *
 * @param {Object|*} parent  the enclosing context, or plain data
 * @param {*}        data    the data this context resolves names against
 * @param {number|null} [index]  position within a list, or null outside one
 * @param {number|null} [length] size of the enclosing list, or null outside one
 * @returns {{$data: *, $root: *, $parent: *, $index: number|null,
 *            $length: number|null}} frozen
 */
export function createChildContext(parent, data, index = null, length = null) {
    const base = toContext(parent);
    return Object.freeze({
        $data: data,
        $root: base.$root,
        $parent: base.$data,
        $index: index === undefined ? null : index,
        $length: length === undefined ? null : length
    });
}

/**
 * Is this already a binding context?
 *
 * Detection is by the presence of `$data`, which is the one field every context
 * has and no sensible data object does. A data object that genuinely has a
 * `$data` field is indistinguishable from a context and will be treated as one —
 * the alternative is a branded symbol, which would mean a context built by hand
 * (in a test, or by a consumer) was not a context. The name is reserved; this is
 * what reserving it means.
 *
 * @param {*} value
 * @returns {boolean}
 */
export function isContext(value) {
    return value !== null && typeof value === 'object' && '$data' in value;
}

/**
 * Whatever the caller passed → a binding context.
 *
 * This is what keeps §5's promise that the four names resolve everywhere. Every
 * entry point that accepts "a context or plain data" runs its argument through
 * here first, so nothing downstream has to handle both shapes.
 *
 * @param {*} value a context, or plain data
 * @returns {Object} a context
 */
export function toContext(value) {
    return isContext(value) ? value : createRootContext(value);
}
