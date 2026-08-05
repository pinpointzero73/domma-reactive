/**
 * The DOM half of the binding runtime: markers, anchors, and finding them again.
 *
 * Three jobs, and nothing else:
 *
 *   1. Turn a string into nodes — the single parse site for the whole package.
 *   2. Index a set of root nodes, attaching each binding to the nodes carrying
 *      its id.
 *   3. Replace the contents of a comment-delimited region, disposing anything
 *      that was living in the part removed.
 *
 * This module knows what a binding *id* is and nothing else about bindings. It
 * does not know what kinds exist, how they update, or what an expression is.
 *
 * -- Why indexing takes roots rather than a container ------------------------
 *
 * Before M4 there was always a container element to search: `compile()` renders
 * into one. A list instance has no container - its nodes are siblings in the
 * middle of someone else's list, and wrapping them in a <div> to give the
 * indexer something to hold would put a <div> inside every <ul> in the
 * framework. So indexing works over an array of top-level nodes, and a container
 * is expressed as "its childNodes". Same code, one caller poorer.
 *
 * -- Trust model -------------------------------------------------------------
 *
 * Templates are author-written source, not user input. All interpolated DATA is
 * HTML-escaped by the renderer before it reaches here; {{{triple-stache}}} is
 * the documented, explicit opt-out. `parseFragment` below is the only place in
 * the package that turns a string into DOM, and it is a verbatim move of the
 * function that has held that role since the compiler was extracted - it is not
 * a new capability, and narrowing it belongs to whatever decides to stop
 * trusting templates, not here.
 */

import {disposeSubtree} from './lifecycle.js';

/** Marker attributes, in the order a node is checked against them. */
export const MARKER_ATTRS = ['data-dm-t', 'data-dm-a', 'data-dm-b'];
export const MARKER_SELECTOR = MARKER_ATTRS.map((name) => `[${name}]`).join(',');

export const ANCHOR_OPEN = (id) => `<!--dm:${id}-->`;
export const ANCHOR_CLOSE = (id) => `<!--/dm:${id}-->`;

/**
 * Parse a rendered template string into a DocumentFragment.
 *
 * A <template> element is used (rather than DOMParser) because it parses
 * context-sensitive tags such as <tr>, <td>, <option> and <li> correctly at the
 * top level. Its content is inert: scripts do not run, images do not load.
 *
 * @param {string} html author-written template, already rendered
 * @returns {DocumentFragment}
 */
export function parseFragment(html) {
    const tpl = document.createElement('template');
    tpl.innerHTML = html;   // trusted template source - see the note above
    return tpl.content;
}

/**
 * The nodes strictly between two anchors, snapshotted.
 *
 * A snapshot rather than a live walk because every caller either moves or
 * removes what it is given, and a live walk would lose its place on the first
 * one.
 *
 * @param {Node} open
 * @param {Node} close
 * @returns {Node[]}
 */
export function rangeNodes(open, close) {
    const out = [];
    for (let node = open.nextSibling; node && node !== close; node = node.nextSibling) {
        out.push(node);
    }
    return out;
}

/**
 * Replace everything between a pair of comment anchors.
 *
 * `disposeSubtree` on the way out is what stops a nested list from leaking when
 * an enclosing {{#if}} closes over it: the nodes carry the registrations, so
 * removing them is the event that disposes the effects. See lifecycle.js.
 *
 * @param {Comment} open
 * @param {Comment} close
 * @param {string} html
 */
export function replaceRegion(open, close, html) {
    const parent = open.parentNode;
    if (!parent) return;

    let node = open.nextSibling;
    while (node && node !== close) {
        const next = node.nextSibling;
        disposeSubtree(node);
        parent.removeChild(node);
        node = next;
    }

    if (!html) return;
    parent.insertBefore(parseFragment(html), close);
}

/**
 * Attach DOM nodes to bindings by id.
 *
 * Every binding's `nodes` is cleared first and then repopulated, so a binding
 * whose enclosing region is no longer rendered ends up with `null` rather than
 * with stale nodes - which is what tells the runtime to stop updating it, and
 * (when it owns effects) to dispose them.
 *
 * Two node shapes come out of this:
 *
 *   an Element         for marker-attribute bindings (text, attr, behaviour)
 *   {open, close}      for comment-anchored regions (blocks, raw, data-if, each)
 *
 * A region whose closing anchor is missing - because it sits inside a part of
 * the tree that has not been rendered - contributes nothing, rather than half a
 * region that a handler would then try to write between.
 *
 * @param {Node[]} roots       top-level nodes to search, in document order
 * @param {Map<string, Object>} byId
 * @param {Array<Object>} bindings
 */
export function indexRoots(roots, byId, bindings) {
    for (const b of bindings) b.nodes = null;

    const push = (id, node) => {
        const b = byId.get(id);
        if (b) (b.nodes ||= []).push(node);
    };

    const markersOn = (el) => {
        for (const attrName of MARKER_ATTRS) {
            const raw = el.getAttribute(attrName);
            if (raw === null) continue;
            for (const id of raw.split(/\s+/)) push(id, el);
        }
    };

    /** Anchors opened but not yet closed, shared across roots. */
    const open = new Map();

    const comment = (node) => {
        const text = node.data;
        if (text.startsWith('/dm:')) {
            const id = text.slice(4);
            const start = open.get(id);
            if (!start) return;
            push(id, {open: start, close: node});
            open.delete(id);
        } else if (text.startsWith('dm:')) {
            open.set(text.slice(3), node);
        }
    };

    for (const root of roots) {
        if (root.nodeType === 8) {
            comment(root);
            continue;
        }
        if (root.nodeType !== 1 && root.nodeType !== 11) continue;

        // A root element can itself carry markers - a list item's top-level
        // <li data-dm-a="..."> does, and a TreeWalker never visits its root.
        if (root.nodeType === 1) markersOn(root);

        // Elements and comments in one walk, so document order is preserved
        // between the two: a region anchor sitting between two marked elements
        // must be seen between them, not after both.
        const walker = root.ownerDocument.createTreeWalker(
            root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_COMMENT, null
        );
        let node;
        while ((node = walker.nextNode())) {
            if (node.nodeType === 8) comment(node);
            else markersOn(node);
        }
    }
}
