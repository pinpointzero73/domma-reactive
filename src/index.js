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
 *   handlers.js, lifecycle.js           DOM-free to import. They write to nodes
 *                                       they are handed and never reach for a
 *                                       global `document`.
 *   nodes.js, runtime.js,               NOT DOM-free. These parse markup via a
 *   reconciler.js,                      <template> element, walk it with
 *   apply-bindings.js                   createTreeWalker, and clone fragments.
 *   template-compiler.js                NOT DOM-free at `compile()`. `annotate()`
 *                                       and `scanBlocks()` are string-only and
 *                                       still are — a keyed block's `<template>`
 *                                       is built lazily, on first render, so
 *                                       annotating in Node keeps working.
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
 * all ten built-ins — text, attr, block, raw, if, event, bind, model, options,
 * focus — are registered through this exact function, so anything a built-in
 * can do a consumer can do. `unregisterBinding` removes one. The handler
 * contract is documented at the top of handlers.js.
 *
 * `registerExtender(name, fn)` is the same idea one layer down, for the
 * `.extend({…})` vocabulary an observable understands. `rateLimit`, `throttle`
 * and `notify` are registered through it too. See extenders.js.
 *
 * ── Binding contexts ─────────────────────────────────────────────────────────
 *
 * `createRootContext` and `createChildContext` build the `$data` / `$root` /
 * `$parent` / `$index` / `$length` object expressions resolve against. The
 * reconciler creates child contexts by itself now, one per list item; these stay
 * published because a consumer evaluating an expression against a list item
 * outside a template has no other way to say which item it is.
 *
 * ── Two entry points, opposite directions ────────────────────────────────────
 *
 *   compile(template, data, container)   a template string becomes DOM
 *   applyBindings(data, rootElement)     DOM that exists becomes live
 *
 * They share every handler, every expression, and the same reconciler. Which one
 * fits depends on who owns the markup: a component owns its template, a
 * server-rendered page owns its HTML and wants behaviour added to it.
 *
 * `applyBindings` returns a handle with `dispose()`. `compile` returns a
 * controller with `destroy()`. Both must be called on a page that outlives the
 * markup — an effect is a live node in the dependency graph and does not go away
 * because its nodes did.
 *
 * ── Keyed lists ──────────────────────────────────────────────────────────────
 *
 * `{{#each items key=id}}` reconciles: an item that stays in the collection
 * keeps its DOM nodes and its effects across changes, so focus, uncommitted
 * input, scroll position and animation state survive. Without `key=` the block
 * re-renders wholesale, as it did before M4, and says so once.
 *
 * Nothing about the reconciler is exported. An instance is created and destroyed
 * by the binding that owns it, and a consumer holding one could only get the
 * lifetime wrong.
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

// The `.extend()` vocabulary. `applyExtenders` stays inside: it is how an
// observable dispatches a spec, not something a consumer has a use for.
export {registerExtender, unregisterExtender} from './extenders.js';

// The other direction from compile(): take DOM that already exists and bring it
// to life, rather than producing DOM from a template. See the file header for
// what it does with `{{ }}` (nothing, deliberately) and how it stays idempotent.
export {applyBindings} from './apply-bindings.js';

// Named `renderTemplate` rather than `render`, which in a package about DOM
// bindings would read as "render this binding" and is the one name a consumer
// is most likely to already have in scope.
export {render as renderTemplate} from './render.js';
