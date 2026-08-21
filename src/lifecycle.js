/**
 * Node-scoped disposal.
 *
 * ── The problem this exists for ──────────────────────────────────────────────
 *
 * M4 gives list items *instances*, and an instance owns effects. An effect is a
 * live node in the dependency graph; dropping the DOM it writes to does not drop
 * it. Whoever removes the nodes must dispose the effects, and the awkward part is
 * that the remover usually has no idea an instance was there:
 *
 *     {{#if open}}
 *         {{#each rows key=id}} … {{/each}}
 *     {{/if}}
 *
 * Setting `open` to false makes the `if` handler replace the contents of its own
 * region. It knows nothing about the `each` inside it, or about the twenty
 * instances that `each` created, or about the effects those instances own. Every
 * one of them would leak - silently, permanently, and in exactly the shape a
 * naive test would not notice, because the DOM would look right.
 *
 * So disposal is attached to the NODE. Anything that owns resources tied to a
 * subtree registers a disposer on a node inside it; anything that removes nodes
 * calls `disposeSubtree` on the way out. Neither side needs to know what the
 * other is.
 *
 * ── Why a WeakMap and a counter ──────────────────────────────────────────────
 *
 * A WeakMap so that a node dropped without going through `disposeSubtree` - by
 * `innerHTML =`, by a consumer, by anything - takes its entry with it rather than
 * pinning it in a registry forever.
 *
 * A counter because `disposeSubtree` would otherwise walk every removed subtree
 * on every region re-render, whether or not anything had ever registered. Most
 * templates have no instances at all; for those, the walk is pure cost. The
 * counter makes the common case a single integer comparison.
 *
 * The counter is deliberately approximate in one direction: it counts
 * registrations that are still notionally live, and a node collected without
 * disposal leaves it high. That only ever causes an unnecessary walk, never a
 * missed disposal, which is the safe way round.
 */

/** @type {WeakMap<Node, Set<Function>>} */
const disposers = new WeakMap();

/** Registrations not yet disposed. See the note above. */
let live = 0;

/**
 * Tie a teardown function to a node.
 *
 * Called again for the same node, both disposers run - a node can carry
 * resources from more than one owner.
 *
 * @param {Node} node
 * @param {Function} fn
 */
export function registerDisposer(node, fn) {
    if (node === null || node === undefined || typeof fn !== 'function') return;

    let set = disposers.get(node);
    if (!set) disposers.set(node, (set = new Set()));
    set.add(fn);
    live++;
}

/**
 * Drop a single registration without running it.
 *
 * Used when an owner tears itself down through its own API: it has already run
 * its teardown, and leaving the registration behind would run it a second time
 * when the nodes are eventually removed.
 *
 * @param {Node} node
 * @param {Function} fn
 * @returns {boolean} whether the registration existed
 */
export function unregisterDisposer(node, fn) {
    const set = disposers.get(node);
    if (!set || !set.delete(fn)) return false;
    live--;
    if (set.size === 0) disposers.delete(node);
    return true;
}

/**
 * Run and clear every disposer on one node.
 *
 * The set is cleared BEFORE the disposers run, so a disposer that removes the
 * node it is registered on cannot re-enter this function and run itself twice.
 *
 * @param {Node} node
 */
export function disposeNode(node) {
    const set = disposers.get(node);
    if (!set) return;

    disposers.delete(node);
    live -= set.size;

    for (const fn of set) {
        try {
            fn();
        } catch (err) {
            console.warn('[Domma Reactive] a disposer threw:', err);
        }
    }
}

/**
 * Run every disposer on a node and everything beneath it.
 *
 * Comments are walked as well as elements: a region's identity is its opening
 * comment, and that is where a list's instances hang their teardown.
 *
 * @param {Node} node
 */
export function disposeSubtree(node) {
    if (live === 0 || node === null || node === undefined) return;

    disposeNode(node);

    // Text nodes have no descendants, and a TreeWalker rooted at one is a
    // wasted allocation per text node in every removed region.
    if (node.nodeType !== 1 && node.nodeType !== 11) return;

    const walker = node.ownerDocument.createTreeWalker(
        node, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_COMMENT, null
    );

    // Collected first: a disposer is free to remove nodes, and mutating the
    // tree underneath a live TreeWalker is undefined territory.
    const found = [];
    let current;
    while ((current = walker.nextNode())) {
        if (disposers.has(current)) found.push(current);
    }

    for (const target of found) disposeNode(target);
}

/**
 * How many registrations are outstanding.
 *
 * For tests. A leak in the reconciler shows up here as well as in the live
 * `Computation` count, and this one says *which layer* leaked.
 *
 * @returns {number}
 */
export function liveDisposers() {
    return live;
}
