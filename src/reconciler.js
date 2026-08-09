/**
 * Keyed list reconciliation and instance lifecycle.
 *
 * ── What an instance is ──────────────────────────────────────────────────────
 *
 * One item of a keyed `{{#each}}`: a pair of comment anchors, the nodes between
 * them, a binding context of its own, and one effect per binding inside it. It
 * is created when a key first appears, kept — nodes, effects and all — for as
 * long as that key is in the collection, and disposed when it goes.
 *
 * That is the whole point of the milestone. Before it, a collection change
 * re-rendered the block to a string and replaced everything, so every item's
 * DOM was a different node than it had been a moment ago: focus lost, a
 * half-typed input reset, a CSS transition restarted, a `<video>` back to zero.
 * Reconciliation is not an optimisation. It is the difference between a list you
 * can put a form in and one you cannot.
 *
 * ── The algorithm ────────────────────────────────────────────────────────────
 *
 *   1. Walk the new collection once, in order. For each item take its key. If an
 *      instance already exists for that key, CLAIM it — delete it from the
 *      previous key map and refresh its context. Otherwise clone a new one.
 *   2. Whatever is left in the previous key map is gone from the collection.
 *      Dispose it: effects first, then nodes. (Design spec §6, and in that
 *      order — see `dispose` below.)
 *   3. Walk the claimed-and-created instances in order, placing each one after
 *      the last, moving only those not already in the right place.
 *
 * O(n) in the size of the collection, with one Map lookup and one delete per
 * item. Lookup is by key rather than by scanning the DOM, so an item that has
 * not moved costs a comparison and nothing else.
 *
 * ── Moves are in order, not minimal ──────────────────────────────────────────
 *
 * DEFERRED, and logged here rather than quietly omitted, per design spec §2:
 * step 3 places nodes in order, which is correct for append, prepend, insert,
 * remove and reorder, but performs more DOM moves than strictly necessary. The
 * known refinement is to compute the longest increasing subsequence of the
 * previous positions and move only the items outside it; reversing a list of n
 * items then costs n-1 moves instead of n, and a single item dragged from the
 * end to the front costs 1 instead of n. Neither the correctness of the result
 * nor node identity depends on it — an instance that is moved is the same
 * instance, with the same nodes and the same effects — so it is a performance
 * refinement and nothing more.
 *
 * ── Disposal is the dangerous part ───────────────────────────────────────────
 *
 * Every instance owns effects, and an effect is a live node in the dependency
 * graph. Dropping the nodes does not drop the effects; it turns them into
 * computations that recompute forever, writing to DOM no document contains. So
 * disposal happens on three routes, and all three converge on `dispose()`:
 *
 *   the key left the collection    → the reconciler disposes it directly
 *   an enclosing region re-rendered → `replaceRegion` disposes the subtree, and
 *                                     the instance's registration on its own
 *                                     opening anchor fires
 *   the whole list went away        → the region's registration disposes every
 *                                     instance it holds
 *
 * The order within `dispose()` is effects, then nodes. The other way round, an
 * effect can be recomputed by a flush that is already in flight, between the
 * nodes leaving the document and the effect being unlinked — writing to
 * detached nodes at best, and re-entering a half-torn-down instance at worst.
 */

import {createChildContext} from './context.js';
import {registerBinding} from './handlers.js';
import {disposeSubtree, registerDisposer, unregisterDisposer} from './lifecycle.js';
import {rangeNodes} from './nodes.js';
import {liveItems} from './render.js';
import {createRuntime} from './runtime.js';

const PREFIX = '[Domma Reactive]';

/** Region opening anchor → the instances living between it and its close. */
const states = new WeakMap();

const warned = new Set();

function warnOnce(key, message) {
    if (warned.has(key)) return;
    warned.add(key);
    console.warn(`${PREFIX} ${message}`);
}

/** For tests. */
export function resetReconcilerWarnings() {
    warned.clear();
}

// ── Instances ─────────────────────────────────────────────────────────────────

/**
 * Clone one item of a keyed block and bring it to life.
 *
 * The anchors are part of the instance, not decoration. They make the instance's
 * extent knowable at any moment without holding a node list that a nested region
 * re-render could invalidate: an `{{#if}}` inside an item replaces its own
 * contents whenever it likes, and a cached array of "the item's nodes" would go
 * stale the first time it did. Walking between two comments cannot.
 *
 * @param {Object} factory       from the compiler: {content, bindings, render, …}
 * @param {Object} parentContext the enclosing binding context
 * @param {*} item
 * @param {number} index
 * @param {number} length
 * @returns {Object} the instance
 */
export function createInstance(factory, parentContext, item, index, length) {
    const open = document.createComment('dm:item');
    const close = document.createComment('/dm:item');

    const fragment = factory.content.cloneNode(true);
    fragment.insertBefore(open, fragment.firstChild);
    fragment.appendChild(close);

    // Each instance needs its own binding records: `nodes` and `seen` are
    // per-instance state, and sharing the compiler's records would have every
    // item in the list overwriting the same two fields.
    const bindings = factory.bindings.map((descriptor) => ({...descriptor}));

    const runtime = createRuntime({
        bindings,
        render: factory.render,
        context: createChildContext(parentContext, item, index, length),
        getRoots: () => rangeNodes(open, close),
        reactive: true,
        label: factory.label
    });

    const instance = {
        key: null,
        item,
        index,
        length,
        parentContext,
        open,
        close,
        runtime,
        disposed: false,

        /** Anchors included — what has to move when the instance moves. */
        allNodes() {
            return [open, ...rangeNodes(open, close), close];
        },

        /**
         * Re-point at a new item, index or enclosing context.
         *
         * The DOM is only rewritten when something an instance can actually
         * observe has changed. Item identity and index always count; the
         * collection's length counts only when the body mentions `@last` or
         * `$length`, because otherwise every append would refresh every existing
         * item — an O(n) pass on every push, which is exactly the cost keyed
         * reconciliation exists to remove.
         *
         * A mutated-in-place item is deliberately NOT detected. The same rule
         * holds throughout the package (see the note on `observable`): a
         * derivation must produce a new value rather than editing an old one,
         * because an in-place edit is invisible to the equality gate that every
         * other layer is built on. An item edited in place notifies nothing
         * anywhere; this is not the layer to start guessing.
         */
        refresh(nextParent, nextItem, nextIndex, nextLength) {
            /*
             * The parent CONTEXT is a fresh frozen object on every update — a
             * caller passing the same data twice still produces two of them —
             * so comparing it by identity would make every reconcile a full
             * refresh and undo the paragraph below. What an instance can
             * actually observe of its parent is `$parent` and `$root`.
             */
            const replaced =
                nextParent.$data !== instance.parentContext.$data ||
                nextParent.$root !== instance.parentContext.$root ||
                nextItem !== instance.item;
            const moved =
                nextIndex !== instance.index ||
                (factory.usesLength === true && nextLength !== instance.length);

            instance.item = nextItem;
            instance.index = nextIndex;
            instance.length = nextLength;
            instance.parentContext = nextParent;

            // When nothing observable changed, the context keeps a $length that
            // is out of date and that — by the test just above — nothing in this
            // instance reads.
            if (!replaced && !moved) return false;

            runtime.setContext(
                createChildContext(nextParent, nextItem, nextIndex, nextLength)
            );

            // Same item, new position: only the bindings that render a position
            // are stale. Re-running the rest would undo a half-typed input in
            // every row below an insertion.
            runtime.refresh(replaced ? null : (b) => b.positional === true);
            return true;
        },

        /**
         * Effects first, then nodes. See the note at the top of the file.
         *
         * @param {boolean} [removeNodes=true] false when a caller is already
         *        removing the nodes and only the effects are still ours to drop
         */
        dispose(removeNodes = true) {
            if (instance.disposed) return;
            instance.disposed = true;

            unregisterDisposer(open, effectsOnly);
            runtime.destroy();

            // Nested lists hang their own teardown on nodes inside this one.
            for (const node of rangeNodes(open, close)) disposeSubtree(node);

            if (!removeNodes) return;
            const parent = open.parentNode;
            if (!parent) return;
            for (const node of instance.allNodes()) parent.removeChild(node);
        }
    };

    const effectsOnly = () => instance.dispose(false);
    registerDisposer(open, effectsOnly);

    runtime.index();

    return instance;
}

// ── Placement ─────────────────────────────────────────────────────────────────

/**
 * Put the instances in order after the region's opening anchor.
 *
 * An instance already sitting where it belongs is not touched — which is what
 * makes an append cost one insertion rather than n moves — and one that is not
 * is moved whole, anchors included, so its extent survives the move intact.
 *
 * @param {Comment} open
 * @param {Array<Object>} instances
 */
function place(open, instances) {
    const parent = open.parentNode;
    if (!parent) return;

    let cursor = open;

    for (const instance of instances) {
        if (cursor.nextSibling === instance.open) {
            cursor = instance.close;
            continue;
        }

        for (const node of instance.allNodes()) {
            parent.insertBefore(node, cursor.nextSibling);
            cursor = node;
        }
    }
}

// ── Reconciliation ────────────────────────────────────────────────────────────

/** Walk a dotted path. Missing anywhere along it yields undefined. */
function resolvePath(item, path) {
    let value = item;
    for (const part of path.split('.')) {
        if (value === null || value === undefined) return undefined;
        value = value[part];
    }
    return value;
}

/**
 * Whatever the collection expression produced → an array.
 *
 * An `observableArray` is accepted directly, because `{{#each items key=id}}`
 * over one is the obvious thing to write and `.value` is a read the surrounding
 * effect should be tracking anyway. Anything else that is not an array renders
 * an empty list rather than throwing: a collection that has not loaded yet is a
 * normal state, not an error.
 */
function toArray(value) {
    if (Array.isArray(value)) return value;
    if (value !== null && typeof value === 'object' && Array.isArray(value.value)) {
        return value.value;
    }
    return [];
}

/**
 * Bring one region's instances into line with a collection.
 *
 * @param {{open: Comment, close: Comment}} region
 * @param {Array} items
 * @param {Object} factory
 * @param {string} keyPath
 * @param {Object} parentContext
 * @param {string} label
 */
export function reconcile(region, items, factory, keyPath, parentContext, label) {
    let state = states.get(region.open);
    if (state === undefined) {
        state = {byKey: new Map()};
        states.set(region.open, state);
        registerDisposer(region.open, () => {
            for (const instance of state.byKey.values()) instance.dispose(false);
            state.byKey = new Map();
        });
    }

    const previous = state.byKey;
    const next = new Map();
    const ordered = [];

    // Applied here rather than in the handler so that every route into a keyed
    // list agrees — apply-bindings reconciles through this function too, and a
    // destroyed item that vanished from one path and not the other would be a
    // difference between server-rendered and compiled markup.
    const live = liveItems(items);

    for (let index = 0; index < live.length; index++) {
        const item = live[index];
        let key = resolvePath(item, keyPath);

        if (key === null || key === undefined) {
            warnOnce(
                `key:missing:${label}:${keyPath}`,
                `key=${keyPath} is missing on an item of ${label} — falling back to ` +
                'position for that item, which reconciles no better than an unkeyed ' +
                'block. Give every item a stable identifier.'
            );
            key = ` position:${index}`;
        } else if (next.has(key)) {
            warnOnce(
                `key:duplicate:${label}:${keyPath}`,
                `two items of ${label} share key=${keyPath} value "${String(key)}" — ` +
                'a key must identify exactly one item. The duplicate is being kept ' +
                'apart by position, so it will not reconcile across changes.'
            );
            key = ` duplicate:${index}:${String(key)}`;
        }

        let instance = previous.get(key);
        if (instance === undefined) {
            instance = createInstance(factory, parentContext, item, index, live.length);
            instance.key = key;
        } else {
            // Claimed. What is left in `previous` afterwards is what has gone.
            previous.delete(key);
            instance.refresh(parentContext, item, index, live.length);
        }

        next.set(key, instance);
        ordered.push(instance);
    }

    for (const instance of previous.values()) instance.dispose();

    place(region.open, ordered);

    state.byKey = next;
}

// ── The binding handler ───────────────────────────────────────────────────────

/**
 * Build the `each` handler.
 *
 * The compiled block template is supplied by the caller rather than imported,
 * which is what keeps this module free of any knowledge of templates: it clones
 * `factory.content`, it never parses anything, and it could reconcile a factory
 * produced by something other than the mustache compiler without a line
 * changing here.
 *
 * @param {Function} factoryFor (binding, render) => factory
 * @returns {Object} a binding handler
 */
export function createEachHandler(factoryFor) {
    return {
        tracks: true,
        region: true,
        primes: true,

        update({binding, nodes, context, render}) {
            const factory = factoryFor(binding, render);
            const items = toArray(binding.evaluate(context));

            for (const region of nodes) {
                reconcile(region, items, factory, binding.keyPath, context, factory.label);
            }

            return true;
        }
    };
}

/**
 * Register the handler under the kind the compiler emits.
 *
 * Through the public `registerBinding`, like every other built-in.
 *
 * @param {Function} factoryFor
 */
export function registerEachHandler(factoryFor) {
    registerBinding('each', createEachHandler(factoryFor));
}
