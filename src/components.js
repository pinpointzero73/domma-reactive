/**
 * Components - a registry, a params collector, and one binding handler.
 *
 * A component is a template plus an optional factory that makes the view model
 * it renders against. That is the whole of it, and the reason it is so little
 * code is that a component instance is not a new kind of thing: it is a
 * `createInstance()` instance, exactly as a keyed list item is. Cloned template,
 * its own binding records, its own effects, an anchored range, and disposal that
 * works when an ancestor removes the subtree without knowing a component was
 * there. All of that already existed for lists.
 *
 * ── Why a component model exists here at all ─────────────────────────────────
 *
 * It was once ruled out on the grounds that a component model is a framework
 * decision, and a host framework has already made it. What changed is the goal:
 * capability parity with Knockout, which turns components from a choice into a
 * gap. What has NOT changed is the refusal to become a framework - there is no
 * router, no lifecycle beyond `dispose()`, no async template loading, and no
 * opinion about where a component's markup comes from.
 *
 * ── This module must not import the template compiler ────────────────────────
 *
 * It takes its factory builder by injection, through `registerComponentHandler`,
 * for the same reason `reconciler.js` does: template-compiler.js knows how to
 * turn source into a cloneable factory, and it hands that capability down. The
 * reverse dependency would be a cycle between the two files that already know
 * the most about each other. Nothing here knows that a mustache exists.
 *
 * ── Registration throws; rendering warns ─────────────────────────────────────
 *
 * `registerComponent` throws on a bad definition, as `registerExtender` does. A
 * render-time failure - an unknown name, a param that will not parse, a `create`
 * that threw - warns exactly once and skips that component alone. The asymmetry
 * is deliberate: a bad registration is a programming error at startup, where a
 * bad expression is authored data met halfway through a paint, and taking the
 * page down over it would be the worse failure by far.
 */

import {compileExpression} from './expression.js';
import {createComponentContext} from './context.js';
import {createInstance} from './reconciler.js';
import {registerBinding} from './handlers.js';
import {registerDisposer} from './lifecycle.js';

const PREFIX = '[Domma Reactive]';

/** name → definition. */
const registry = new Map();

/**
 * Warnings that must fire once rather than once per render.
 *
 * A component in a list renders once per row, and a mistake in its markup is one
 * mistake however many rows there are. Keyed by `binding.id`, so two different
 * components making the same mistake both get heard.
 */
const warned = new Set();

function warnOnce(key, message) {
    if (warned.has(key)) return;
    warned.add(key);
    console.warn(`${PREFIX} ${message}`);
}

/** For tests: forget which warnings have already fired. */
export function resetComponentWarnings() {
    warned.clear();
}

/**
 * Register a component.
 *
 * @param {string} name
 * @param {{template: string, create?: Function}} definition
 * @returns {Object} the definition, so a registration can be inlined
 */
export function registerComponent(name, definition) {
    if (typeof name !== 'string' || name.length === 0) {
        throw new TypeError(`${PREFIX} registerComponent: the name must be a non-empty string`);
    }
    if (definition === null || typeof definition !== 'object') {
        throw new TypeError(`${PREFIX} registerComponent: "${name}" was not given a definition object`);
    }
    if (typeof definition.template !== 'string') {
        throw new TypeError(`${PREFIX} registerComponent: "${name}" has no template string`);
    }
    if (definition.create !== undefined && typeof definition.create !== 'function') {
        throw new TypeError(`${PREFIX} registerComponent: "${name}".create is not a function`);
    }

    if (registry.has(name)) {
        console.warn(
            `${PREFIX} registerComponent: "${name}" replaces an existing component. ` +
            'That is allowed, but it is almost always a name collision rather than an intention.'
        );
    }

    registry.set(name, definition);
    return definition;
}

/**
 * Remove one.
 *
 * @param {string} name
 * @returns {boolean} whether there was one
 */
export function unregisterComponent(name) {
    return registry.delete(name);
}

/**
 * The definition registered under a name, or undefined.
 *
 * @param {string} name
 * @returns {Object|undefined}
 */
export function componentDefinition(name) {
    return registry.get(name);
}

const PARAM_PREFIX = 'data-param-';

/**
 * `first-name` → `firstName`.
 *
 * Kebab in the attribute because an HTML attribute name is lowercased by the
 * parser, so `data-param-firstName` would arrive as `firstname`. This is
 * `cssProperty()` in handlers.js run in the opposite direction, and the
 * reasoning is the one written down there.
 *
 * @param {string} suffix the part after `data-param-`
 * @returns {string}
 */
export function paramName(suffix) {
    return suffix.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

/**
 * The params object for one component instance.
 *
 * ── Two spellings, for the reason data-bind-style has two ────────────────────
 *
 *   data-param-contact="$data"   one param, named in the attribute
 *   data-params="cardParams"     an object the view model already holds
 *
 * The first is the common case and the one Knockout makes awkward, because
 * `params: {value: x}` means inventing an object literal - and object literals
 * are exactly what this expression language refuses, which is what lets bindings
 * parse without `eval`. The second is for many params at once. They merge, and
 * the attribute wins, because it is the more specific of the two.
 *
 * ── Evaluated once, at instantiation ─────────────────────────────────────────
 *
 * A param is a constructor argument, not a live binding. What makes that
 * sufficient is that observables are references:
 *
 *   data-param-x="thing"         passes the observable - the parent sees writes
 *   data-param-x="thing.value"   passes a snapshot - it does not
 *
 * No code decides this and no convention has to be remembered: the two are
 * different expressions, and the difference is the same `.value` the author
 * already reads through. Knockout needs a documented rule here and its users
 * still get it wrong, because `params: {a: x}` and `params: {a: x()}` look
 * equally plausible at a glance.
 *
 * Wrapping every param in a computed was the alternative, and it was rejected
 * because it double-wraps the reference case: `params.contact` would be a
 * computed OF an observable, and the view model would have to read `.value` on
 * some params and not others with no way to tell which from its own code.
 *
 * Frozen, because it is an input rather than scratch space - the same reasoning
 * that freezes a binding context. Observables inside it stay writable through
 * `.value`, which is the intended path back to the parent.
 *
 * @param {Element} element
 * @param {Object} binding
 * @param {Object} context
 * @returns {Object} frozen
 */
export function collectParams(element, binding, context) {
    const params = {};

    // Read before the loop, so a named attribute can be seen to override a key
    // the object supplied. The other order would make the collision invisible.
    const bag = element.getAttribute('data-params');
    if (bag !== null && bag.trim() !== '') {
        const evaluate = compileExpression(bag);
        const value = evaluate === null ? null : evaluate(context);

        if (evaluate === null) {
            warnOnce(
                `component:params:${binding.id}`,
                `data-params="${bag}" did not parse, in ${binding.expr}`
            );
        } else if (value === null || typeof value !== 'object') {
            warnOnce(
                `component:params:${binding.id}`,
                `data-params="${bag}" needs an object of params - got ` +
                `${value === null ? 'null' : typeof value}, in ${binding.expr}`
            );
        } else {
            Object.assign(params, value);
        }
    }

    for (const attribute of [...element.attributes]) {
        if (!attribute.name.startsWith(PARAM_PREFIX)) continue;

        const key = paramName(attribute.name.slice(PARAM_PREFIX.length));
        if (key === '') continue;

        const evaluate = compileExpression(attribute.value);
        if (evaluate === null) {
            warnOnce(
                `component:param:${binding.id}:${key}`,
                `${attribute.name}="${attribute.value}" did not parse, in ${binding.expr}`
            );
            continue;
        }

        if (key in params) {
            warnOnce(
                `component:collide:${binding.id}:${key}`,
                `"${key}" is given by both data-params and ${attribute.name}, in ` +
                `${binding.expr}. The attribute wins, but one of the two is redundant.`
            );
        }

        params[key] = evaluate(context);
    }

    return Object.freeze(params);
}

// ── Slots ─────────────────────────────────────────────────────────────────────

const SLOT_ATTRIBUTE = 'data-slot';

/**
 * Take the host element's children, keyed by which slot they belong to.
 *
 * ── Slot content is relocated, never recompiled ──────────────────────────────
 *
 * This markup was written at the usage site, so the enclosing template already
 * annotated it, painted it and bound it to the OUTER context. Nothing about it
 * needs compiling again, and that is what makes slots cheap: an effect holds a
 * direct node reference, and `indexRoots` matches bindings to nodes by marker id
 * anywhere in the subtree, so moving a node does not disturb its binding.
 *
 * It also means "slot content binds where it was written" needs no code to be
 * true - it is simply what these nodes already are.
 *
 * The children are DETACHED, never disposed. They belong to the outer runtime;
 * this handler is only moving them, and disposing something it does not own is
 * the one thing that would make slots worse than no slots.
 *
 * A text node cannot carry an attribute, so bare text always lands in the
 * default slot - as does the whitespace between labelled elements, which is
 * harmless because HTML collapses it.
 *
 * @param {Element} element
 * @returns {Map<string, Array<Node>>} name -> nodes, '' being the default slot
 */
export function harvestSlotContent(element) {
    const map = new Map();

    for (const node of [...element.childNodes]) {
        const name = node.nodeType === 1 ? (node.getAttribute(SLOT_ATTRIBUTE) ?? '') : '';

        if (!map.has(name)) map.set(name, []);
        map.get(name).push(node);
        node.remove();
    }

    return map;
}

/**
 * The comment pair marking one slot inside an instance.
 *
 * Found by walking rather than held from compile time, because the anchors are
 * cloned per instance: the factory knows the ids, only the instance knows the
 * nodes.
 *
 * @param {Array<Node>} roots the instance's nodes
 * @param {string} id
 * @returns {{open: Comment, close: Comment}|null}
 */
function findSlotAnchors(roots, id) {
    const openData = `dm:${id}`;
    const closeData = `/dm:${id}`;
    let open = null;
    let close = null;

    const visit = (node) => {
        if (node.nodeType === 8) {
            if (node.data === openData) open = node;
            else if (node.data === closeData) close = node;
            return;
        }
        for (const child of node.childNodes) visit(child);
    };

    for (const root of roots) {
        visit(root);
        if (open !== null && close !== null) return {open, close};
    }

    return null;
}

/** Every node strictly between two anchors. */
function between(open, close) {
    const out = [];
    for (let n = open.nextSibling; n !== null && n !== close; n = n.nextSibling) out.push(n);
    return out;
}

/**
 * Move projected content into the instance's slots.
 *
 * A slot the map has content for loses its fallback and gains that content; a
 * slot with nothing projected keeps the fallback it was compiled with. That one
 * rule is also why the two resolve against different contexts: the fallback came
 * from the component's template and reads its view model, while projected nodes
 * came from the page and read the page. One hole, two scopes, decided by which
 * template supplied the markup.
 *
 * Returns what was placed, so teardown can take back exactly those nodes rather
 * than trying to tell projected content from component markup by inspection -
 * which would be guesswork the moment a component moved a node itself.
 *
 * @returns {Array<{name: string, nodes: Array<Node>}>} what was placed
 */
function fillSlots(instance, factory, slotMap, binding, name) {
    const placed = [];
    const roots = instance.allNodes();
    const seen = new Set();

    for (const slot of factory.slots ?? []) {
        if (seen.has(slot.name)) {
            warnOnce(
                `component:slot:duplicate:${binding.id}:${name}:${slot.name}`,
                `the component "${name}" declares more than one ` +
                `${slot.name === '' ? 'default slot' : `slot named "${slot.name}"`}. ` +
                'The first is filled and the rest keep their fallback content.'
            );
            continue;
        }
        seen.add(slot.name);

        const content = slotMap.get(slot.name);
        if (content === undefined || content.length === 0) continue;

        const anchors = findSlotAnchors(roots, slot.id);
        if (anchors === null) continue;

        for (const node of between(anchors.open, anchors.close)) node.remove();
        for (const node of content) anchors.close.parentNode.insertBefore(node, anchors.close);

        placed.push({name: slot.name, nodes: content});
    }

    for (const [slotName, nodes] of slotMap) {
        if (seen.has(slotName) || nodes.length === 0) continue;

        // Indented markup puts whitespace text nodes in the default slot.
        // Warning about those would fire on every well-formatted usage.
        if (nodes.every((n) => n.nodeType === 3 && n.data.trim() === '')) continue;

        warnOnce(
            `component:slot:unmatched:${binding.id}:${name}:${slotName}`,
            slotName === ''
                ? `the component "${name}" was given content but declares no {{#slot}}, so that `
                  + 'content is not rendered. Add a slot to its template, or remove the content.'
                : `the component "${name}" has no slot named "${slotName}", so that content is `
                  + "not rendered. Check data-slot against the template's {{#slot}} blocks."
        );
    }

    return placed;
}

// ── Mounting ──────────────────────────────────────────────────────────────────

/** host element → what is mounted inside it. */
const states = new WeakMap();

/**
 * Build the view model, or fall back to the params when there is no `create`.
 *
 * A template-only component reads its params unqualified, which is what makes
 * the trivial case trivial - and the trivial case is where Knockout's
 * `viewModel`-or-constructor ambiguity does the most damage.
 *
 * Anything that throws in `create` takes that instance and nothing else: one
 * warning, an empty host, and the rest of the page carries on.
 *
 * @returns {*} the view model, or null if `create` threw
 */
function buildViewModel(definition, params, element, binding, name) {
    if (definition.create === undefined) return params;

    try {
        return definition.create(params, {element});
    } catch (err) {
        warnOnce(
            `component:create:${binding.id}:${name}`,
            `the component "${name}" threw while being created, in ${binding.expr}: ${err && err.message}`
        );
        return null;
    }
}

/**
 * View model first, then the instance.
 *
 * That order matters: disposing the instance first would tear down the effects
 * the view model's own `dispose()` may still be reading through, and the
 * reference to it is held by the state object either way.
 *
 * A `dispose()` that throws is warned about and stepped over, as `disposeNode`
 * already does - a component that fails to clean up must not prevent every
 * component after it from cleaning up.
 */
function teardown(state) {
    if (state.instance === null) return;

    /*
     * Take the projected content back BEFORE anything is disposed. These nodes
     * belong to the outer runtime; the instance is about to be destroyed, and
     * anything still inside it goes with it. Detaching them keeps them alive
     * with their bindings intact, ready for the replacement.
     *
     * Exactly the nodes that were placed, by reference - not a guess based on
     * what the DOM happens to look like now.
     */
    for (const {nodes} of state.placed) {
        for (const node of nodes) node.remove();
    }
    state.placed = [];

    const vm = state.viewModel;
    if (vm !== null && typeof vm === 'object' && typeof vm.dispose === 'function') {
        try {
            vm.dispose();
        } catch (err) {
            console.warn(`${PREFIX} a component's dispose() threw:`, err);
        }
    }

    state.instance.dispose();
    state.instance = null;
    state.viewModel = null;
    state.name = null;
}

/**
 * The `data-component` handler.
 *
 * ── Why this is not a region binding ─────────────────────────────────────────
 *
 * `data-if` is, and the difference is worth stating. The compiler anchors an
 * attribute region around the WHOLE element (`scanRegionElements` takes
 * `elementRange`), so a region handler re-renders the element it is written on -
 * which would put this binding's own `data-param-*` attributes inside the region
 * it replaces, and there would be no element left to read them from. A region is
 * `{open, close}` and carries no element reference; see nodes.js.
 *
 * So the component owns its element's CONTENTS instead, as `data-options` owns a
 * `<select>`'s options. The host element persists across a swap, keeping its own
 * attributes, classes and identity, and Knockout's `component:` renders inside
 * its element in exactly the same way.
 *
 * ── The name is an expression, like every other binding value ────────────────
 *
 * Which is why a literal takes inner quotes: `data-component="'contact-card'"`.
 * That costs one pair of quotes in the common case and buys dynamic components
 * for nothing - `data-component="currentView.value"` swaps what is rendered when
 * the observable changes, which is how a great many Knockout applications route.
 * Making this the one binding whose value was not an expression would have cost
 * a special case in the compiler and a documented exception to a rule the README
 * states without one.
 *
 * The element's original children are replaced on mount. Stage 1 has no slots;
 * when `$componentTemplateNodes` arrives, this is the line that changes.
 *
 * Takes its factory builder by injection, exactly as the `each` handler does and
 * for the same reason: this module must not know that a template compiler
 * exists, or the two would import each other.
 *
 * @param {Function} factoryFor (definition, name, render, options) → factory
 * @returns {Object} a binding handler
 */
export function createComponentHandler(factoryFor) {
    return {
        tracks: true,
        primes: true,
        attribute: 'data-component',
        expression: true,

        update({binding, nodes, context, render}) {
            const name = binding.evaluate(context);

            for (const element of nodes) {
                let state = states.get(element);
                if (state === undefined) {
                    state = {
                        name: null, instance: null, viewModel: null,
                        slots: null, placed: []
                    };
                    states.set(element, state);
                    registerDisposer(element, () => teardown(state));
                }

                // Same component, already mounted: an unrelated update ran, and
                // rebuilding would throw away the instance's own state - a
                // half-typed input, a scroll position, an open panel - for
                // nothing.
                if (state.name === name && state.instance !== null) continue;

                teardown(state);

                // Harvested once per host, not once per mount: a swap must
                // carry the same content into the replacement, and after the
                // first mount the children have already been taken.
                if (state.slots === null) state.slots = harvestSlotContent(element);
                element.replaceChildren();

                if (typeof name !== 'string' || name === '') {
                    warnOnce(
                        `component:name:${binding.id}`,
                        `data-component="${binding.expr}" needs a component name - got ` +
                        `${name === null ? 'null' : typeof name}. Remember that a literal name ` +
                        `takes quotes, because every binding value is an expression: ` +
                        `data-component="'my-thing'"`
                    );
                    continue;
                }

                const definition = componentDefinition(name);
                if (definition === undefined) {
                    warnOnce(
                        `component:missing:${binding.id}:${name}`,
                        `no component is registered as "${name}", in ${binding.expr}`
                    );
                    continue;
                }

                const params = collectParams(element, binding, context);
                const viewModel = buildViewModel(definition, params, element, binding, name);
                if (viewModel === null) continue;

                const factory = factoryFor(definition, name, render, binding.options ?? {});

                state.name = name;
                state.viewModel = viewModel;
                state.instance = createInstance(factory, context, viewModel, null, null, {
                    context: createComponentContext(context, viewModel)
                });

                state.placed = fillSlots(state.instance, factory, state.slots, binding, name);

                // The fallback bindings were indexed and primed by createInstance
                // before the fill removed their nodes. Re-index so the runtime
                // notices: a binding whose nodes are gone is exactly the case
                // index() already handles, and it disposes their effects.
                if (state.placed.length > 0) state.instance.runtime.index();

                // createInstance leaves its nodes in a fragment, anchors included.
                element.append(...state.instance.allNodes());
            }

            return true;
        },

        /**
         * Tear down when the controller is destroyed.
         *
         * `registerDisposer` above covers the other way a component ends: an
         * ancestor removing the subtree, which runs node-scoped disposers
         * without anything being "destroyed". Neither path covers the other -
         * `applyBindings`' dispose() runs detach hooks and its own teardowns but
         * does not walk node disposers, so a component activated in place would
         * leak its view model without this.
         *
         * `teardown` is idempotent, so the two overlapping is harmless.
         */
        detach({node}) {
            const state = states.get(node);
            if (state !== undefined) teardown(state);
        }
    };
}

/**
 * Register the handler under the kind the compiler emits.
 *
 * @param {Function} factoryFor
 */
export function registerComponentHandler(factoryFor) {
    registerBinding('component', createComponentHandler(factoryFor));
}
