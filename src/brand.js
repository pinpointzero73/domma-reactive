/**
 * The brand every reactive object carries, and the guard read bindings use.
 *
 * `data-if="show"` with `show = observable(false)` used to render its content:
 * the binding evaluated to the observable ITSELF, an object, and every object
 * is truthy. Nothing warned. A binding reads a value, so an expression that
 * resolves to a reactive object is always a mistake - `.value` was left off -
 * and the guard below turns that into a warning plus `undefined`: falsy where a
 * binding tests truth (fail closed - hidden, disabled off, no rows), empty
 * where it writes text or an attribute (not "[object Object]").
 *
 * It does NOT unwrap. Unwrapping (Knockout's `ko.unwrap`) would make `.value`
 * optional in some places and required in others; one spelling is clearer.
 *
 * The brand is a registered symbol (`Symbol.for`) so that two bundled copies of
 * this package - Domma bundles one, a page may load another - still recognise
 * each other's observables. It is non-enumerable, so `isEqual`, spreading and
 * JSON never see it.
 */

export const REACTIVE = Symbol.for('domma-reactive.reactive');

/** Brand an object as reactive. Non-enumerable; returns the object. */
export function brand(target) {
    Object.defineProperty(target, REACTIVE, {value: true, enumerable: false});
    return target;
}

/** Whether a value is an observable, observable array or computation. */
export function isReactive(value) {
    return value !== null
        && (typeof value === 'object' || typeof value === 'function')
        && value[REACTIVE] === true;
}

const PREFIX = '[Domma Reactive]';

/**
 * Wrap a binding's evaluator so a bare reactive result warns once and reads as
 * `undefined`. Handlers that never read a value (`tracks: false` - events,
 * whose expression evaluates to the function to call) are left alone, and so
 * is a handler that declares `acceptsReactive: true` - the keyed list, which
 * takes an observableArray directly by design.
 *
 * @param {Function|null} evaluate
 * @param {Object}  info
 * @param {string}  info.expr     the expression source
 * @param {string}  [info.where]  where it is (template name, element)
 * @param {Object}  [info.handler]
 * @returns {Function|null}
 */
export function guardReactive(evaluate, {expr, where, handler} = {}) {
    if (typeof evaluate !== 'function' || handler?.tracks === false || handler?.acceptsReactive === true) {
        return evaluate;
    }
    let warned = false;
    return (context) => {
        const value = evaluate(context);
        if (!isReactive(value)) return value;
        if (!warned) {
            warned = true;
            const at = where ? ` in ${where}` : '';
            console.warn(
                `${PREFIX} "${expr}"${at} is an observable, not its value - use "${expr}.value". ` +
                'The binding reads it as empty (hidden, off, no rows) until then.'
            );
        }
        return undefined;
    };
}
