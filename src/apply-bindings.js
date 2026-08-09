/**
 * applyBindings(data, rootElement) - activate DOM that already exists.
 *
 * -- Why this is the entry point that matters ---------------------------------
 *
 * `compile()` takes a template STRING and renders it into a container. That is
 * the right shape for a component, and it is the wrong shape for the audience
 * this package is aimed at: a server that already emits HTML, a page that is
 * already correct before any JavaScript runs, an author who wants behaviour
 * added to markup rather than markup generated from JavaScript. Knockout's
 * defining capability is that second direction - point it at rendered HTML
 * carrying binding attributes and it comes alive in place, with no build step
 * and no second source of truth for the markup. This is that.
 *
 * The two are complementary, not alternatives. `compile()` owns markup;
 * `applyBindings` borrows it.
 *
 * -- What it activates --------------------------------------------------------
 *
 *   data-on-<event>   an event listener
 *   data-bind-<name>  text, a class, a property or an attribute
 *   data-model        two-way, control <-> data
 *   data-if           the element is in the document, or it is not
 *   data-each         a keyed list; the element's initial contents are the
 *                     item template
 *   ...and any custom attribute binding added with registerBinding()
 *
 * Every one of them is the same handler `compile()` uses, from the same
 * registry. A custom binding written for one works in the other.
 *
 * -- {{ }} is NOT interpolated, and that is a decision -------------------------
 *
 * Text interpolation in already-rendered DOM is not supported. A `{{name}}` sat
 * in a text node is left exactly as it is, and if the scan sees one that looks
 * like a binding it says so, once, naming the element.
 *
 * The reasoning is that there is nothing coherent to do with it. Either the
 * server rendered the value - in which case the token is gone and there is
 * nothing left to bind to, only text that happens to say "Ada" - or the server
 * emitted the raw token, in which case the page was broken until JavaScript ran,
 * which is the one thing server rendering exists to avoid. Guessing which text
 * nodes are dynamic is not possible; rewriting every text node into anchored
 * spans would mutate the markup this function promises to leave alone, and would
 * do it destructively to a page that was already correct.
 *
 * `data-bind-text="name"` is the supported spelling. It is explicit, it survives
 * server rendering (the server writes the text AND the attribute), and it is
 * greppable.
 *
 * The one exception is the contents of a `data-each`, which are a TEMPLATE
 * rather than rendered output - they are removed from the document at
 * activation, compiled, and cloned per item. Mustache works there because there
 * it means something.
 *
 * -- Idempotence --------------------------------------------------------------
 *
 * Applying twice must not double-bind, and re-running `applyBindings` over a
 * region of a long-lived page is a normal thing to do by accident. Every element
 * this function activates is recorded in a module-level WeakSet and marked with
 * `data-dm-bound`. A second pass skips anything already recorded and warns once,
 * naming the root.
 *
 * The WeakSet is the truth and the attribute is the visible marker, not the
 * reverse. A cloned node carries the attribute but is genuinely unbound, and
 * treating the attribute as authoritative would leave every clone dead. The
 * attribute is there so that "why is this not updating" is answerable in
 * devtools, and it is removed again on dispose.
 *
 * -- Disposal -----------------------------------------------------------------
 *
 * The returned handle owns everything this call created and nothing it did not:
 * effects, listeners, list instances, the placeholder comments `data-if` needs,
 * and the markers. `dispose()` puts a hidden `data-if` element back where it
 * came from, so the markup ends up as it started. An unteardownable binding on a
 * page that lives for hours is a leak, and a handle that only half-works is
 * worse than none, because it reads as if it did the job.
 */

import {toContext} from './context.js';
import {effect} from './graph.js';
import {bindingHandler, claimAttribute} from './handlers.js';
import {compileExpression, expressionDependencies, parseExpression} from './expression.js';
import {rangeNodes} from './nodes.js';
import {reconcile} from './reconciler.js';
import {render as defaultRender, truthy} from './render.js';
import {eachFactory} from './template-compiler.js';

const PREFIX = '[Domma Reactive]';

/** The attribute a keyed list is declared with. Not a registry binding - see below. */
const EACH_ATTRIBUTE = 'data-each';

/** `items key=id` */
const EACH_VALUE = /^([\s\S]*?)\s+key\s*=\s*([A-Za-z_$][\w$]*(?:\.[\w$]+)*)\s*$/;

/**
 * A virtual binding: `<!-- dm if: open -->` … `<!-- /dm -->`.
 *
 * Knockout spells it `<!-- ko if: open -->`. The concept is the one thing
 * applyBindings genuinely could not express: a binding attribute needs an
 * element to live on, and a run of `<li>`s or `<td>`s has no spare element to
 * give it. Wrapping them in a `<div>` to carry the attribute changes the layout,
 * and inside a table it is not even valid HTML that a browser will keep.
 *
 * `compile()` has never needed this — `{{#if}}` already delimits a region with
 * comments of its own. This is for markup that arrived from a server, where the
 * author cannot add mustache and has only comments to work with.
 */
const VIRTUAL_OPEN = /^\s*dm\s+([a-zA-Z][\w-]*)\s*:\s*([\s\S]+?)\s*$/;
const VIRTUAL_CLOSE = /^\s*\/dm\s*$/;

/** A text node that looks like it was expecting interpolation. */
const LOOKS_INTERPOLATED = /\{\{\s*[\w$][\w$.]*\s*\}\}/;

/** The visible half of the idempotence marker. */
const BOUND_ATTRIBUTE = 'data-dm-bound';

/** The authoritative half. See the note at the top. */
const bound = new WeakSet();

const warned = new Set();

function warnOnce(key, message) {
    if (warned.has(key)) return;
    warned.add(key);
    console.warn(`${PREFIX} ${message}`);
}

/** For tests. */
export function resetApplyWarnings() {
    warned.clear();
}

/** A readable name for an element, for warnings. */
function describe(el) {
    if (!el || el.nodeType !== 1) return String(el);
    const id = el.id ? `#${el.id}` : '';
    const cls = el.classList?.length ? `.${[...el.classList].join('.')}` : '';
    return `<${el.tagName.toLowerCase()}${id}${cls}>`;
}

/**
 * Walk a subtree, collecting the elements that carry bindings.
 *
 * A `data-each` element's contents are its item template, so the walk does not
 * descend into it: those nodes are about to be lifted out of the document
 * altogether, and activating them would bind the template rather than the items.
 *
 * @param {Element} root
 * @param {Function} onElement (el) => boolean, false to skip the subtree
 */
function walk(root, onElement) {
    if (root === null || root === undefined || root.nodeType !== 1) return;
    if (onElement(root) === false) return;
    for (const child of [...root.children]) walk(child, onElement);
}

/**
 * Find every `<!-- dm kind: expr -->` … `<!-- /dm -->` pair in a subtree.
 *
 * Pairing is per parent and stack-based, so a nested pair binds to its own
 * closer rather than to the first one that comes along. The result is in
 * document order of the OPENING comment, which puts an enclosing block before
 * the blocks inside it — the order they have to be wired in, since wiring the
 * outer one may detach the inner one's anchors.
 *
 * @param {Element} root
 * @param {Function} onUnclosed (block) => void
 * @returns {Array<{kind, expr, open, close, parent, seq}>}
 */
function virtualBlocks(root, onUnclosed) {
    const found = [];
    let seq = 0;

    const visit = (parent) => {
        const stack = [];

        for (const node of [...parent.childNodes]) {
            if (node.nodeType === 8) {
                if (VIRTUAL_CLOSE.test(node.data)) {
                    const opener = stack.pop();
                    if (opener !== undefined) found.push({...opener, close: node});
                    continue;
                }

                const match = node.data.match(VIRTUAL_OPEN);
                if (match !== null) {
                    stack.push({kind: match[1], expr: match[2], open: node, parent, seq: seq++});
                }
                continue;
            }

            if (node.nodeType === 1) visit(node);
        }

        for (const orphan of stack) onUnclosed(orphan);
    };

    visit(root);

    // Pushed on the CLOSING comment, so an inner pair completes first. Sorting
    // by the opener's sequence puts them back into the nesting order.
    return found.sort((a, b) => a.seq - b.seq);
}

/**
 * Everything one element asks for, in registry order.
 *
 * @returns {Array<{name, value, kind, arg, handler}>}
 */
function claimsOn(el) {
    const found = [];
    for (const attr of [...el.attributes]) {
        if (attr.name === BOUND_ATTRIBUTE || attr.name === EACH_ATTRIBUTE) continue;
        const claim = claimAttribute(attr.name);
        if (claim === null) continue;
        found.push({
            name: attr.name,
            value: attr.value.trim(),
            kind: claim.kind,
            arg: claim.arg,
            handler: claim.handler
        });
    }
    return found;
}

/**
 * Activate an existing DOM subtree against a data object.
 *
 * @param {Object} data          the view model; a plain object, an object of
 *                               observables, or a tracking proxy
 * @param {Element} rootElement  the subtree to activate, inclusive
 * @param {Object} [options]
 * @param {Function} [options.render]   (template, data) => string, for
 *                                      `data-each` item templates
 * @param {string} [options.template]   a name for this subtree, used in warnings
 * @returns {{dispose: Function, update: Function, context: Function,
 *            bindings: number}}
 */
export function applyBindings(data, rootElement, options = {}) {
    if (rootElement === null || rootElement === undefined || rootElement.nodeType !== 1) {
        throw new TypeError(
            `${PREFIX} applyBindings: expected an element to activate, got ${String(rootElement)}`
        );
    }

    const render = typeof options.render === 'function' ? options.render : defaultRender;
    const label = options.template || describe(rootElement);

    let context = toContext(data);

    /** Everything this call created, in creation order. */
    const computations = [];
    const teardowns = [];
    const marked = [];

    let disposed = false;
    let skipped = 0;

    const controller = {
        context: () => context,
        update: () => false,
        bindings: []
    };

    // ---- Pass 0: virtual blocks --------------------------------------------
    //
    // Before the element walk, because a virtual list's body is lifted out of
    // the document here. Leaving it in place would have the walk below bind the
    // TEMPLATE — the same rule `data-each` follows by not descending into its
    // own element.
    const virtual = virtualBlocks(rootElement, (orphan) => {
        warnOnce(
            `virtual:unclosed:${label}:${orphan.kind}`,
            `<!-- dm ${orphan.kind}: ${orphan.expr} --> in ${label} has no matching ` +
            '<!-- /dm -->, so the block was skipped. Every virtual binding needs a closer.'
        );
    });

    for (const block of virtual) {
        if (block.kind === 'each') liftVirtualBody(block, virtual);
    }

    // ---- Pass 1: find the work, before touching anything --------------------
    //
    // Collected up front so that a `data-if` which starts out false does not
    // hide its own children from the scan. Their bindings are wired while
    // detached and are correct the moment the element comes back.
    const work = [];

    walk(rootElement, (el) => {
        if (bound.has(el)) {
            skipped++;
            return false;
        }

        const each = el.getAttribute(EACH_ATTRIBUTE);
        const claims = claimsOn(el);

        if (each === null && claims.length === 0) return true;

        work.push({el, each, claims});
        // A list's contents are a template, not markup to activate.
        return each === null;
    });

    if (skipped > 0) {
        warnOnce(
            `double:${label}`,
            `applyBindings ran again over ${label}, where ${skipped} element(s) were ` +
            'already bound. Those were skipped rather than bound twice; the handle ' +
            'returned owns only what this call created. Dispose the first handle ' +
            'before re-applying.'
        );
    }

    for (const {el} of work) {
        bound.add(el);
        el.setAttribute(BOUND_ATTRIBUTE, '');
        marked.push(el);
    }

    // ---- Pass 2: is there mustache in here that will never be substituted? ---
    checkForInterpolation(rootElement, label);

    // ---- Pass 3: wire ------------------------------------------------------
    let seq = 0;

    for (const item of work) {
        if (item.each !== null) wireEach(item.el, item.each);
        for (const claim of item.claims) wireClaim(item.el, claim);
    }

    for (const block of virtual) wireVirtual(block);

    /** Compile the expression half of a binding, or null if it will not parse. */
    function prepare(source, handler, where) {
        if (handler.expression === false) return {ast: null, evaluate: null, deps: new Set()};

        // `methodCalls` comes from the HANDLER, not the markup: only the event
        // binding declares it, so `x.foo()` stays a parse error everywhere a
        // call would run inside an effect. See eventHandler in handlers.js.
        const options = {
            template: `${label} ${where}`,
            methodCalls: handler.methodCalls === true
        };

        const ast = parseExpression(source, options);
        if (ast === null) return null;

        return {
            ast,
            evaluate: compileExpression(source, options),
            deps: handler.tracks === false ? new Set() : expressionDependencies(ast)
        };
    }

    function wireClaim(el, claim) {
        const {handler, kind, arg, value, name} = claim;

        const prepared = prepare(value, handler, name);
        if (prepared === null) return;

        const binding = {
            id: `apply${seq++}_${kind}`,
            kind,
            arg,
            expr: value,
            ast: prepared.ast,
            evaluate: prepared.evaluate,
            deps: prepared.deps,
            nodes: [el]
        };
        controller.bindings.push(binding);

        if (typeof handler.attach === 'function') {
            handler.attach({binding, node: el, controller});
            teardowns.push(() => handler.detach?.({binding, node: el, controller}));
        }

        // A region handler owns a stretch of DOM and re-renders it from source
        // it captured at compile time. There is no compile time here, so `if`
        // gets a different - and strictly better - implementation below, and
        // any OTHER region binding has nothing to work with.
        if (handler.region === true) {
            if (kind === 'if') wireIf(el, binding);
            else {
                warnOnce(
                    `region:${kind}`,
                    `"${name}" is a region binding, which needs a compiled template body. ` +
                    `applyBindings has none - the markup is the page. Use compile() for ` +
                    `${kind}, or data-if / data-each, which are implemented here directly.`
                );
            }
            return;
        }

        // An event binding writes nothing; its attach() did the work, and an
        // effect around a no-op update would be a Computation that can only
        // ever do nothing.
        if (handler.tracks === false) return;

        track(() => handler.update({
            binding,
            nodes: [el],
            context,
            render,
            controller
        }));
    }

    /**
     * `data-if` by detaching the element, not by re-rendering a region.
     *
     * `compile()` cannot do this: while an element is detached, every binding
     * inside it is invisible to re-indexing, so it stops updating and comes back
     * carrying whatever it held when it left. Here nothing is ever re-indexed -
     * a binding was wired to a node reference once and keeps writing to that
     * node whether or not the document contains it - so detaching is safe, and
     * it preserves the one thing the region implementation cannot: the element
     * itself, with its children, its listeners and its focus.
     */
    function wireIf(el, binding) {
        const placeholder = document.createComment(`dm:if ${binding.expr}`);
        el.parentNode?.insertBefore(placeholder, el);

        track(() => {
            const show = truthy(binding.evaluate(context));
            if (show && el.parentNode === null) {
                placeholder.parentNode?.insertBefore(el, placeholder.nextSibling);
            } else if (!show && el.parentNode !== null) {
                el.parentNode.removeChild(el);
            }
            return true;
        });

        teardowns.push(() => {
            // Leave the markup as it was found: the element back in place, the
            // placeholder gone.
            if (el.parentNode === null) {
                placeholder.parentNode?.insertBefore(el, placeholder.nextSibling);
            }
            placeholder.parentNode?.removeChild(placeholder);
        });
    }

    /**
     * `data-each="items key=id"` - a keyed list over the element's own contents.
     *
     * The contents are lifted out and compiled once into a cloneable template,
     * exactly as `{{#each items key=id}}` is, and the same reconciler fills the
     * element. So a list activated this way gets everything the compiled one
     * does: node identity across changes, per-item contexts, per-item effects
     * and disposal.
     *
     * `key=` is not optional here. A compiled block can fall back to re-rendering
     * a captured body; there is no body to fall back to when the body IS the
     * page, so an unkeyed `data-each` is refused rather than half-supported.
     */
    function wireEach(el, value) {
        const parsed = EACH_VALUE.exec(value);
        if (parsed === null || parsed[1].trim() === '') {
            warnOnce(
                `each:unkeyed:${label}`,
                `${EACH_ATTRIBUTE}="${value}" on ${describe(el)} needs a key: write ` +
                `${EACH_ATTRIBUTE}="${value.trim()} key=id", naming whichever property ` +
                'identifies an item. Without one there is nothing to reconcile against.'
            );
            return;
        }

        const collection = parsed[1].trim();
        const keyPath = parsed[2];

        const prepared = prepare(collection, {expression: true, tracks: true}, EACH_ATTRIBUTE);
        if (prepared === null) return;

        // The item template is the element's initial contents. Taken as source
        // rather than as nodes so that it goes through the same compiler a
        // {{#each}} body does - bindings, anchors, skeleton and all.
        const body = el.innerHTML;
        el.replaceChildren();

        const open = document.createComment('dm:each');
        const close = document.createComment('/dm:each');
        el.append(open, close);

        const binding = {
            id: `apply${seq++}_each`,
            kind: 'each',
            expr: collection,
            keyPath,
            body,
            ast: prepared.ast,
            evaluate: prepared.evaluate,
            deps: prepared.deps,
            factoryBox: {value: null, options: {template: label}},
            nodes: [{open, close}]
        };
        controller.bindings.push(binding);

        const handler = bindingHandler('each');
        track(() => handler.update({
            binding,
            nodes: binding.nodes,
            context,
            render,
            controller
        }));

        teardowns.push(() => {
            // Disposing the instances is what drops their effects; the
            // reconciler's own registration on `open` does it.
            reconcile({open, close}, [], eachFactory(binding, render), keyPath, context, label);
            el.replaceChildren();
        });
    }

    /**
     * Take a virtual list's body out of the document and keep it as source.
     *
     * The nodes between the anchors are the item template, exactly as a
     * `data-each` element's contents are, and they must be gone before the
     * element walk runs or the walk would bind the template instead of the
     * items. Moving them into a holder rather than reading `outerHTML` off each
     * one keeps text and comment nodes intact, and gives the serialised source
     * in the same step.
     */
    function liftVirtualBody(block, all) {
        const holder = document.createElement('div');
        for (const node of rangeNodes(block.open, block.close)) holder.appendChild(node);
        block.body = holder.innerHTML;

        // A virtual block inside this body went with it. It cannot be wired —
        // its anchors are no longer in the document — and the compiler does not
        // read `<!-- dm -->` out of a lifted template, so it is not silently
        // handled elsewhere either.
        for (const other of all) {
            if (other === block || !holder.contains(other.open)) continue;
            other.consumed = true;
            warnOnce(
                `virtual:nested:${label}:${other.kind}`,
                `<!-- dm ${other.kind}: ${other.expr} --> is inside a virtual list's body, ` +
                'which is compiled as a template — virtual bindings are not read there. ' +
                `Use {{#${other.kind}}} inside the body, or data-if on an element.`
            );
        }
    }

    /** Dispatch one virtual block to its implementation. */
    function wireVirtual(block) {
        if (block.consumed === true) return;

        if (block.kind === 'if') {
            wireVirtualIf(block);
        } else if (block.kind === 'each') {
            wireVirtualEach(block);
        } else if (block.kind === 'text') {
            wireVirtualText(block);
        } else {
            warnOnce(
                `virtual:kind:${block.kind}`,
                `<!-- dm ${block.kind}: … --> is not a virtual binding. ` +
                'Supported: if, each, text. Anything else needs an element to bind to.'
            );
        }
    }

    /**
     * A virtual `if`: the run of nodes between the anchors is in the document,
     * or it is held aside.
     *
     * Held in a DocumentFragment rather than an array, which matters more than
     * it looks. The nodes stay SIBLINGS in the fragment, so a nested virtual
     * block inside a hidden one can still find its own range and go on
     * hiding and showing within it. Detached into an array they would each lose
     * their siblings, the inner block's range would come back empty, and its
     * content would reappear on the outer block's next show whatever its own
     * condition said.
     */
    function wireVirtualIf(block) {
        const prepared = prepare(block.expr, {expression: true, tracks: true}, '<!-- dm if -->');
        if (prepared === null) return;

        const binding = {
            id: `apply${seq++}_if`,
            kind: 'if',
            expr: block.expr,
            ast: prepared.ast,
            evaluate: prepared.evaluate,
            deps: prepared.deps,
            nodes: [{open: block.open, close: block.close}]
        };
        controller.bindings.push(binding);

        /** @type {DocumentFragment|null} the nodes while they are out of the document */
        let held = null;

        const show = () => {
            if (held === null) return;
            block.close.parentNode?.insertBefore(held, block.close);
            held = null;
        };

        track(() => {
            if (truthy(binding.evaluate(context))) {
                show();
            } else if (held === null) {
                held = document.createDocumentFragment();
                for (const node of rangeNodes(block.open, block.close)) held.appendChild(node);
            }
            return true;
        });

        // Leave the markup as it was found.
        teardowns.push(show);
    }

    /** A virtual keyed list, reconciled between the author's own comments. */
    function wireVirtualEach(block) {
        const parsed = block.expr.match(EACH_VALUE);
        if (parsed === null || parsed[1].trim() === '') {
            warnOnce(
                `virtual:each:unkeyed:${label}`,
                `<!-- dm each: ${block.expr} --> needs a key: write ` +
                `<!-- dm each: ${block.expr.trim()} key=id -->, naming whichever property ` +
                'identifies an item. Without one there is nothing to reconcile against.'
            );
            return;
        }

        const collection = parsed[1].trim();
        const keyPath = parsed[2];

        const prepared = prepare(collection, {expression: true, tracks: true}, '<!-- dm each -->');
        if (prepared === null) return;

        const binding = {
            id: `apply${seq++}_each`,
            kind: 'each',
            expr: collection,
            keyPath,
            body: block.body,
            ast: prepared.ast,
            evaluate: prepared.evaluate,
            deps: prepared.deps,
            factoryBox: {value: null, options: {template: label}},
            nodes: [{open: block.open, close: block.close}]
        };
        controller.bindings.push(binding);

        const handler = bindingHandler('each');
        track(() => handler.update({
            binding,
            nodes: binding.nodes,
            context,
            render,
            controller
        }));

        teardowns.push(() => {
            reconcile(
                {open: block.open, close: block.close}, [],
                eachFactory(binding, render), keyPath, context, label
            );
        });
    }

    /**
     * A virtual `text`: one text node between the anchors, owned by the binding.
     *
     * Whatever the server put there is placeholder content — it is what the page
     * showed before the data arrived — so it is replaced rather than appended to.
     */
    function wireVirtualText(block) {
        const prepared = prepare(block.expr, {expression: true, tracks: true}, '<!-- dm text -->');
        if (prepared === null) return;

        for (const node of rangeNodes(block.open, block.close)) node.parentNode?.removeChild(node);

        const text = document.createTextNode('');
        block.close.parentNode?.insertBefore(text, block.close);

        const binding = {
            id: `apply${seq++}_text`,
            kind: 'text',
            expr: block.expr,
            ast: prepared.ast,
            evaluate: prepared.evaluate,
            deps: prepared.deps,
            nodes: [text]
        };
        controller.bindings.push(binding);

        track(() => {
            const value = binding.evaluate(context);
            text.data = value === null || value === undefined ? '' : String(value);
            return true;
        });

        teardowns.push(() => text.parentNode?.removeChild(text));
    }

    /** Create an effect and remember it, so `dispose()` can find it again. */
    function track(body) {
        computations.push(effect(body, {label: `${label}:${computations.length}`}));
    }

    return {
        /** How many bindings this call activated. */
        get bindings() {
            return controller.bindings.length;
        },

        /** The binding context in force. */
        context: () => context,

        /**
         * Re-point at different data and re-run every binding.
         *
         * For a plain, untracked view model this is the only way the DOM hears
         * about a change. A view model built from observables does not need it:
         * the effects are already subscribed to whatever they read.
         *
         * @param {Object} next
         */
        update(next) {
            if (disposed) return;
            if (next !== undefined) context = toContext(next);
            for (const comp of computations) comp.recompute();
        },

        /**
         * Tear down everything this call created. Safe to call twice.
         */
        dispose() {
            if (disposed) return;
            disposed = true;

            // Effects first: a teardown may remove nodes, and an effect still
            // in a scheduled flush must not be able to write to them.
            for (const comp of computations) comp.dispose();
            computations.length = 0;

            for (const fn of teardowns) {
                try {
                    fn();
                } catch (err) {
                    console.warn(`${PREFIX} applyBindings teardown threw:`, err);
                }
            }
            teardowns.length = 0;

            for (const el of marked) {
                bound.delete(el);
                el.removeAttribute(BOUND_ATTRIBUTE);
            }
            marked.length = 0;
        }
    };
}

/**
 * Is this node inside a list's item template?
 *
 * A `data-each` element's contents are the one place mustache DOES mean
 * something here: they are lifted out of the document, compiled and cloned per
 * item, exactly as `compile()` would. Warning about them told the author to
 * replace working markup with `data-bind-text`, which is the opposite of the
 * advice — so the check has to stop at a list boundary rather than walk through
 * it.
 *
 * The walk stops AT `root`, inclusive — a root that is itself a list holds
 * nothing but an item template — and goes no further: a `data-each` ancestor
 * above the root is somebody else's list and not ours to reason about.
 *
 * @param {Node}    node
 * @param {Element} root
 * @returns {boolean}
 */
function insideListTemplate(node, root) {
    for (let el = node.parentNode; el; el = el.parentNode) {
        if (el.nodeType === 1 && el.hasAttribute(EACH_ATTRIBUTE)) return true;
        if (el === root) return false;
    }
    return false;
}

/**
 * Say once if the subtree contains mustache that nothing will ever substitute.
 *
 * Only tokens that look like a binding count: `{{ name }}`, `{{user.email}}`.
 * Prose containing a stray `{{` is left alone, because warning about it would
 * train people to ignore the warning.
 *
 * @param {Element} root
 * @param {string} label
 */
function checkForInterpolation(root, label) {
    const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);

    let node;
    while ((node = walker.nextNode())) {
        if (!LOOKS_INTERPOLATED.test(node.data)) continue;
        if (insideListTemplate(node, root)) continue;

        warnOnce(
            `interp:${label}`,
            `${label} contains "${node.data.trim().slice(0, 40)}" - applyBindings does ` +
            'not interpolate {{ }} in already-rendered DOM, and leaves it as it found ' +
            'it. Use data-bind-text="expr", which the server can render alongside the ' +
            'text, or compile() if the markup should come from a template.'
        );
        return;
    }
}
