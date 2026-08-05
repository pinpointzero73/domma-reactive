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
 *   context.js, expression.js,          DOM-free. Contexts, expressions and the
 *   render.js                           default mustache renderer are all
 *                                       string and object work.
 *   handlers.js                         DOM-free to import. The handlers write
 *                                       to nodes the compiler hands them; they
 *                                       never reach for a global `document`.
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
 * ── The compiler owns bindings, and now brings a renderer ────────────────────
 *
 * `compile(template, data, container, renderFn)` still takes the mustache
 * renderer as a parameter, and a caller who passes one gets exactly that and
 * nothing else — Domma passes `utils.render`. But the parameter is now
 * OPTIONAL. It used to be mandatory, which meant a consumer who installed this
 * package could not render anything with it until they had brought their own
 * template engine: `compile('<p>{{name}}</p>', data, host)` threw. `render` in
 * render.js is the default, it is built on the expression evaluator below, and
 * it is exported as `renderTemplate` so it can be used on its own.
 *
 * The separation of concerns is unchanged. The compiler still contributes the
 * anchor and binding machinery — which region of the DOM belongs to which
 * expression, and what re-renders when — and templating is still a replaceable
 * part. It is now a part with a working default rather than a hole.
 *
 * ── The expression evaluator ─────────────────────────────────────────────────
 *
 * expression.js evaluates ONE expression against a binding context. It is not a
 * template engine and does not know what a template is. As of M3 it is what the
 * default renderer, `data-bind-*`, `data-model`, `data-if`, `data-on-*` and
 * non-path `{{ }}` interpolations all evaluate through, and the guarantee it
 * carries — no dynamic code construction anywhere, so bindings work under
 * `script-src 'self'` — is a property of the whole package.
 *
 * Eight names are exported: parse a source to an AST, evaluate an AST, do both
 * in one call, compile a source to a reusable evaluator, ask which names an
 * expression reads, and register / unregister / clear. `MAX_DEPTH` and
 * `BLOCKED_KEYS` are deliberately NOT among them: both are hard-coded safety
 * limits rather than settings, and exporting them invites the belief that
 * changing them is supported. They stay readable from expression.js for the
 * tests that pin them and for handlers.js, which must refuse to write the same
 * keys the evaluator refuses to read.
 *
 * ── The binding registry ─────────────────────────────────────────────────────
 *
 * `registerBinding(name, handler)` adds a binding kind. It is not a side door:
 * all eight built-ins — text, attr, block, raw, if, event, bind, model — are
 * registered through this exact function, so anything a built-in can do a
 * consumer can do. `unregisterBinding` removes one. The handler contract is
 * documented at the top of handlers.js.
 *
 * ── Binding contexts ─────────────────────────────────────────────────────────
 *
 * `createRootContext` and `createChildContext` build the `$data` / `$root` /
 * `$parent` / `$index` object expressions resolve against. They are published
 * now, ahead of the reconciler that will create child contexts automatically,
 * because a consumer evaluating an expression against a list item has no other
 * way to say which item it is.
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

// Flat, with no grouping namespace to mirror TemplateCompiler. That object
// exists because Domma already had one; inventing a second route to these
// seven would be exactly the redundancy the note above declines.
export {
    clearExpressionCache,
    compileExpression,
    evaluateAst,
    evaluateExpression,
    expressionDependencies,
    parseExpression,
    registerHelper,
    unregisterHelper
} from './expression.js';

export {createChildContext, createRootContext} from './context.js';

export {registerBinding, unregisterBinding} from './handlers.js';

// Named `renderTemplate` rather than `render`, which in a package about DOM
// bindings would read as "render this binding" and is the one name a consumer
// is most likely to already have in scope.
export {render as renderTemplate} from './render.js';
