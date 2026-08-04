/**
 * domma-reactive — public API.
 *
 * Deliberately small. Anything not listed here is an internal detail and may
 * change without a major version bump.
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
