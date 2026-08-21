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
