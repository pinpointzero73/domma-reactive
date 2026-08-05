/**
 * domma-reactive — public API.
 *
 * Deliberately small. Anything not listed here is an internal detail and may
 * change without a major version bump.
 *
 * ── What needs a DOM, and what does not ──────────────────────────────────────
 *
 *   graph.js, equal.js, observable.js   DOM-free. Pure dependency tracking and
 *                                       value comparison; they run unchanged in
 *                                       Node, a worker, or any other host.
 *   template-compiler.js                NOT DOM-free. `compile()` parses markup
 *                                       via a <template> element and walks the
 *                                       result with createTreeWalker, so it
 *                                       needs a `document`. `annotate()` and
 *                                       `scanBlocks()` are string-only and do
 *                                       not.
 *
 * Importing this module has no DOM side effects either way — the requirement
 * only bites when a compiler function is actually called. A DOM-free consumer
 * can import `observable`/`computed`/`effect` and never touch a `document`.
 *
 * ── The compiler owns bindings, not templating ───────────────────────────────
 *
 * `compile(template, data, container, renderFn)` takes the mustache renderer as
 * a PARAMETER. This package therefore ships no template engine and no
 * expression evaluator: it contributes the anchor and binding machinery — which
 * region of the DOM belongs to which expression, and what re-renders when — and
 * the caller injects the evaluation. Domma passes `utils.render`. Any function
 * of the shape `(template, data) => string` will do.
 *
 * Three names from graph.js are withheld on purpose:
 *
 *   flush         — the microtask-scheduled drain. `flushSync` is the strictly
 *                   safer caller-facing form: it clears the scheduled flag
 *                   before draining, so a caller can never leave a stale
 *                   microtask queued behind it. Publishing both would offer a
 *                   choice with one wrong answer.
 *   drainPending  — the propagation policy itself. Callers reach it through
 *                   flushSync; exposing it would let them drive the graph
 *                   half-way through a batch.
 *   reactive      — the aggregate namespace object. Consumers of a module with
 *                   named exports do not need a second bundled copy of them,
 *                   and it duplicates `flush` back into the surface.
 *
 * This module is re-exports only. It must contain no logic of its own.
 */

export {isEqual} from './equal.js';
export {observable, observableArray} from './observable.js';
export {
    Dep,
    DepMap,
    Computation,
    computed,
    effect,
    untracked,
    trackingProxy,
    flushSync
} from './graph.js';

// `resolvePath` is reachable only through the TemplateCompiler object, not as a
// named export. That asymmetry is inherited from Domma and kept deliberately:
// promoting it would add a second, redundant way to spell the same function.
export {annotate, compile, scanBlocks, TemplateCompiler} from './template-compiler.js';
