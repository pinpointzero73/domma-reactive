/**
 * Components — a registry, a params collector, and one binding handler.
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
 * gap. What has NOT changed is the refusal to become a framework — there is no
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
 * render-time failure — an unknown name, a param that will not parse, a `create`
 * that threw — warns exactly once and skips that component alone. The asymmetry
 * is deliberate: a bad registration is a programming error at startup, where a
 * bad expression is authored data met halfway through a paint, and taking the
 * page down over it would be the worse failure by far.
 */

import {compileExpression} from './expression.js';

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
 * `params: {value: x}` means inventing an object literal — and object literals
 * are exactly what this expression language refuses, which is what lets bindings
 * parse without `eval`. The second is for many params at once. They merge, and
 * the attribute wins, because it is the more specific of the two.
 *
 * ── Evaluated once, at instantiation ─────────────────────────────────────────
 *
 * A param is a constructor argument, not a live binding. What makes that
 * sufficient is that observables are references:
 *
 *   data-param-x="thing"         passes the observable — the parent sees writes
 *   data-param-x="thing.value"   passes a snapshot — it does not
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
 * Frozen, because it is an input rather than scratch space — the same reasoning
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
                `data-params="${bag}" needs an object of params — got ` +
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
