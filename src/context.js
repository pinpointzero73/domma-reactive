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
 * The cost was that two levels up could not be reached at all. `$parents` fixes
 * that without disturbing the rule: it is an array of ancestor DATA, nearest
 * first, so `$parents[1].name` reads a grandparent's field with no `$data` in
 * sight. `$parent` and `$parents[0]` are the same value everywhere below the
 * root.
 *
 * ── $parentContext, for what $parents cannot carry ───────────────────────────
 *
 * Data one level up is not the only thing a nested block wants. "Which row of
 * the OUTER list am I in?" is a question about position, and position lives on
 * the context, not on the data — so no amount of ancestor data answers it.
 *
 * `$parentContext` is the enclosing context itself, and it is the one name here
 * that IS a context. `$parentContext.$index` is the question above, answered.
 * Knockout has both names, for both reasons, and arrived at them the same way
 * round.
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
export const CONTEXT_KEYS = new Set([
    '$data', '$root', '$parent', '$index', '$length', '$parents', '$parentContext'
]);

/**
 * The root's `$parents`, which is always empty.
 *
 * Shared across every root context, which is safe precisely because it is both
 * empty and frozen: there is nothing to tell two of them apart, and nothing that
 * could ever write to one.
 */
const NO_PARENTS = Object.freeze([]);

/**
 * Ancestor data, nearest first.
 *
 * Walks the `$parentContext` chain on demand rather than accumulating an array
 * on the way down, so a context that is never asked for its ancestry never
 * builds one. Most never are — `$parents` is a name for the awkward case, while
 * a keyed list creates a context per item per render whether any template
 * mentions it or not.
 *
 * Frozen for the reason contexts are frozen: it is a statement about where an
 * expression sits, not scratch space. `resolveWriteTarget` refuses to write
 * through anything frozen, so `$parents[0] = x` warns rather than throwing.
 *
 * @param {Object} ctx
 * @returns {Array} frozen
 */
function buildParents(ctx) {
    const out = [];
    for (let c = ctx.$parentContext; c !== null; c = c.$parentContext) out.push(c.$data);
    return Object.freeze(out);
}

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
        $data: data, $root: data, $parent: null, $index: null, $length: null,
        $parents: NO_PARENTS, $parentContext: null
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
    let parents = null;

    const ctx = {
        $data: data,
        $root: base.$root,
        $parent: base.$data,
        $index: index === undefined ? null : index,
        $length: length === undefined ? null : length,
        $parentContext: base
    };

    // Defined rather than assigned so it can be a getter, and enumerable so a
    // context still spreads and serialises exactly as it did. Freezing does not
    // stop the closure variable being written, so the memo survives it.
    Object.defineProperty(ctx, '$parents', {
        enumerable: true,
        get() {
            return parents ??= buildParents(ctx);
        }
    });

    return Object.freeze(ctx);
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
