/**
 * The binding runtime: index, attach, prime, update, dispose.
 *
 * This is the machinery `compile()` has always had, lifted out so that a list
 * *instance* can have the same machinery over a different set of nodes. There
 * are now two callers and one implementation:
 *
 *   compile()        roots are a container's childNodes; painted from a string
 *   an instance      roots are the nodes between a pair of anchors; painted by
 *                    cloning a <template>
 *
 * Everything below is common to both: which nodes belong to which binding, when
 * a handler is attached, which bindings must be primed after a region reveals
 * them, and what teardown means.
 *
 * ── Two update strategies ────────────────────────────────────────────────────
 *
 * `reactive: false` - the runtime writes to the DOM only when told to. Nothing
 *   subscribes to anything; `controller.update(id)` is the only way a binding
 *   ever runs. This is the contract Domma depends on: its component factory
 *   wires one `effect` per binding itself, from `binding.deps`, and calls
 *   `update()` inside `untracked()` so the write cannot pollute its own
 *   dependency set. Changing this out from under it would be changing Domma.
 *
 * `reactive: true` - the runtime owns one `Computation` per binding. The effect
 *   body is the handler's update, so whatever the expression reads is what the
 *   binding depends on, collected at runtime with no `deps` analysis at all.
 *
 * List instances are ALWAYS reactive, and not by preference: an instance is
 * created and destroyed by the reconciler, in the middle of a flush, with no
 * caller in a position to wire or unwire anything for it. If it did not own its
 * effects, nothing would.
 *
 * ── Dependency attribution across nested effects ─────────────────────────────
 *
 * A region handler's update calls `reindex()`, which primes the bindings the
 * region just revealed. In reactive mode those bindings are primed by creating
 * or recomputing THEIR effects - never by calling the handler inline. That
 * distinction is the whole ballgame: `Computation._run` swaps the active
 * computation for the duration, so a child's reads are attributed to the child.
 * Priming inline would attribute every child's reads to the parent region, and
 * the region would then re-render itself - destroying its children's nodes -
 * every time any of them changed.
 */

import {effect} from './graph.js';
import {toContext} from './context.js';
import {bindingHandler} from './handlers.js';
import {disposeSubtree} from './lifecycle.js';
import {indexRoots, replaceRegion} from './nodes.js';

const PREFIX = '[Domma Reactive]';

/**
 * Convergence bound for the settle loop.
 *
 * Each round only queues bindings that saw a node they had not seen before, so
 * rounds are bounded by template nesting depth and twenty is far past anything
 * real. For every built-in binding one round suffices, because a region's
 * re-render re-indexes before the rest of the round runs. The loop exists for a
 * CUSTOM region binding whose update reveals anchors that were not in the
 * document at all, and to guarantee termination if one ever fails to converge.
 */
const MAX_SETTLE_ROUNDS = 20;

/**
 * Build a binding runtime over a live set of root nodes.
 *
 * @param {Object} spec
 * @param {Array<Object>} spec.bindings   binding records; mutated (nodes, seen)
 * @param {Function} spec.getRoots        () => Node[], evaluated on every index
 * @param {Function} spec.render          (template, data) => string
 * @param {Object} spec.context           a binding context, or plain data
 * @param {boolean} [spec.reactive]       own one effect per binding
 * @param {string} [spec.label]           template name, for warnings and labels
 * @param {Function} [spec.repaint]       (context) => void; full re-render
 * @returns {Object} the controller
 */
export function createRuntime(spec) {
    const {bindings, getRoots, render, reactive = false, label = '', repaint = null} = spec;

    const byId = new Map(bindings.map((b) => [b.id, b]));

    /**
     * Nodes this binding has already been settled against - attached to, and
     * primed on. A WeakSet keyed by node rather than a count, because a region
     * re-render replaces its contents with brand new elements and the binding
     * must treat those as new even though there are the same number of them.
     */
    for (const b of bindings) b.seen = new WeakSet();

    /** id → the Computation driving that binding. Reactive mode only. */
    const effects = new Map();

    /** Bindings that have acquired a node and must now be run against it. */
    let pending = [];

    /** True while the settle loop is draining `pending`. */
    let settling = false;

    let destroyed = false;

    /**
     * The context every handler resolves against.
     *
     * Held here rather than passed per call because an event listener fires long
     * after the update that wired it, and has to read whatever the data is at
     * that moment. Every entry point that receives data refreshes it.
     */
    let context = toContext(spec.context);

    /** Re-attach DOM nodes to bindings by id, then attach and settle. */
    function index() {
        if (destroyed) return;
        indexRoots(getRoots(), byId, bindings);
        collectNewNodes();
        settle();
    }

    /**
     * Attach handlers to nodes not seen before, queue the bindings that must
     * now be run against them, and - in reactive mode - dispose the effects of
     * bindings that have lost their nodes entirely.
     *
     * A region's "node" is a pair of comment anchors rather than an element; the
     * opening anchor is its identity, and it is never attached to - only
     * element-anchored bindings have listeners.
     */
    function collectNewNodes() {
        for (const b of bindings) {
            if (b.nodes === null) {
                // The enclosing region closed over it. Its effect has nothing
                // left to write to, and keeping it alive is exactly the leak
                // this milestone is about.
                disposeEffect(b.id);
                continue;
            }

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

            // In reactive mode every binding needs a run: the runtime owns the
            // effect, and creating it IS the first update. Otherwise only
            // bindings the renderer could not have got right are primed.
            if (fresh && (reactive || b.prime === true)) pending.push(b);
        }
    }

    /**
     * Run every binding that the render could not have got right.
     *
     * A `{{name}}` is already correct after a paint - the renderer substituted
     * it. `data-bind-text="name"` is not, because there is no token in an
     * attribute for a renderer to substitute. Neither is a binding that has just
     * been REVEALED by a region re-rendering: without this, an
     * `{{#if editing}}<input data-model="draft">{{/if}}` would come back empty
     * every time it opened.
     *
     * Regions go first within a round purely to save work: priming something a
     * region is about to replace is wasted, and a later round would redo it.
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
                        `Kinds still pending: ${[...new Set(pending.map((b) => b.kind))].join(', ')}`
                    );
                    break;
                }

                const batch = pending;
                pending = [];

                for (const regionsFirst of [true, false]) {
                    for (const b of batch) {
                        if ((bindingHandler(b.kind)?.region === true) !== regionsFirst) continue;
                        run(b);
                    }
                }
            }
        } finally {
            settling = false;
            pending = [];
        }
    }

    /**
     * Run one binding, by whichever strategy this runtime was built with.
     *
     * In reactive mode this creates the binding's effect (which runs it) or
     * recomputes the existing one. See the note on attribution at the top.
     */
    function run(b) {
        if (!reactive) {
            controller.update(b.id);
            return;
        }

        const existing = effects.get(b.id);
        if (existing && !existing.disposed) {
            existing.recompute();
            return;
        }

        effects.set(
            b.id,
            effect(() => controller.update(b.id), {label: `${label || 'binding'}:${b.id}`})
        );
    }

    function disposeEffect(id) {
        const comp = effects.get(id);
        if (!comp) return;
        effects.delete(id);
        comp.dispose();
    }

    const controller = {
        bindings,

        /** Dependencies of a single binding. */
        deps(id) {
            return byId.get(id)?.deps || new Set();
        },

        /**
         * The binding context in force - what an event listener resolves
         * against, and what the last call to update/updateAll/rerenderAll left
         * behind. Handlers reach it through this, never through a captured copy.
         */
        context() {
            return context;
        },

        /**
         * Re-point every binding at a different context, without running
         * anything. The reconciler uses this when a list item moves or is
         * replaced: the nodes and the effects stay, the data they resolve
         * against does not.
         *
         * @param {Object} next a binding context, or plain data
         */
        setContext(next) {
            context = toContext(next);
        },

        /**
         * Re-run every binding that currently has nodes.
         *
         * Reactive mode recomputes the effects rather than calling the handlers,
         * so each binding's dependency set is re-collected against whatever it
         * reads now - which matters, because the context it resolves against may
         * have changed underneath it.
         *
         * @param {Function|null} [filter] (binding) => boolean. The reconciler
         *        uses it when only an item's POSITION changed: re-running a
         *        `data-model` that reads nothing positional would write the
         *        stored value back over whatever the user has typed since,
         *        which is the very thing keyed reconciliation is for.
         */
        refresh(filter = null) {
            for (const b of bindings) {
                if (b.nodes === null || b.nodes.length === 0) continue;
                if (filter !== null && filter(b) !== true) continue;
                run(b);
            }
        },

        /** Re-index from the current roots. */
        index,

        /**
         * Update one binding in place. A binding whose enclosing region is not
         * currently rendered has no nodes and is skipped.
         *
         * @param {string} id
         * @param {Object} [fullData]  merged data, or a binding context
         * @returns {boolean} True if anything was written to the DOM
         */
        update(id, fullData) {
            if (fullData !== undefined) context = toContext(fullData);
            if (destroyed) return false;

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

        /** Full re-render - the escape hatch for props changes. */
        rerenderAll(fullData) {
            if (fullData !== undefined) context = toContext(fullData);
            repaint?.(context);
            index();
        },

        /** @deprecated Retained for callers still using the coarse API. */
        rerender(fullData) {
            controller.rerenderAll(fullData);
        },

        /**
         * Detach everything this runtime attached, and dispose every effect it
         * owns - including the effects it does not own directly.
         *
         * Only listeners on nodes still indexed can be removed; nodes discarded
         * by a region re-render were collected along with their listeners long
         * ago. Effects are unconditional - they are held here by id, not by
         * node, so none of them can be missed.
         *
         * The `disposeSubtree` sweep is the part that is easy to leave out and
         * expensive to leave out. A keyed list's instances belong to the
         * instances, not to this runtime: this runtime has one binding for the
         * whole block, and behind it sit n instances each owning effects of
         * their own. Tearing down a component without that sweep drops the DOM
         * and keeps every row's computation graph alive for the life of the
         * page.
         *
         * The nodes are left where they are. Destroying a controller means "stop
         * driving this markup", not "delete it" - the caller owns the container
         * and may well be about to render something else into it.
         */
        destroy() {
            destroyed = true;

            for (const b of bindings) {
                const handler = bindingHandler(b.kind);
                if (handler?.detach === undefined || b.nodes === null) continue;
                for (const node of b.nodes) {
                    if (node.nodeType === undefined) continue;
                    handler.detach({binding: b, node, controller});
                }
            }

            for (const comp of effects.values()) comp.dispose();
            effects.clear();

            for (const root of getRoots()) disposeSubtree(root);
        },

        /** Live effect count. For tests; a leak shows up here first. */
        effectCount() {
            return effects.size;
        }
    };

    return controller;
}
