/**
 * Binding handlers and the registry they live in.
 *
 * ── One registry, no private door ────────────────────────────────────────────
 *
 * Design spec §8 requires that Tier 3's four binding kinds — text, attr, block,
 * raw — become "built-in handlers on the new registry, the same mechanism public
 * `registerBinding()` uses". They do, literally: the bottom of this file calls
 * `registerBinding()` eight times through the same exported function a consumer
 * calls, with no privileged flag and no second code path. The ninth built-in,
 * `each`, is registered by template-compiler.js through that same function — it
 * lives elsewhere only because the reconciler needs a compiled block template
 * and this module must not know that templates exist. If the public API could
 * not express a built-in, the public API would be a demo.
 *
 * The one thing a custom binding cannot do is invent `{{ }}` syntax. `text`,
 * `attr`, `block` and `raw` are discovered by the compiler from mustache tokens,
 * which are a fixed grammar; the four behaviour bindings and every custom one
 * are discovered from an ATTRIBUTE, which is open-ended. That asymmetry is in
 * the syntax, not in the registry — every handler here is the same shape, is
 * dispatched by the same `update()` call, and can be replaced by a consumer.
 *
 * ── The handler contract ─────────────────────────────────────────────────────
 *
 * A handler is a plain object. Only `update` is required.
 *
 *   Discovery (how a template asks for this binding):
 *     attribute        string  an exact attribute name, e.g. 'data-model'
 *     attributePrefix  string  a prefix, e.g. 'data-on-'; the remainder becomes
 *                              binding.arg, so data-on-click gives arg 'click'
 *     (neither)                the compiler creates it from mustache syntax
 *
 *   Compilation (what the compiler prepares before the first paint):
 *     expression   bool  parse the value; binding.ast and binding.evaluate are
 *                        set, and a value that does not parse skips the binding
 *     tracks       bool  contribute the expression's dependencies to binding.deps
 *     region       bool  wrap the owning element in comment anchors, so the
 *                        handler owns a region of DOM rather than an element
 *     capturesBody bool  fill binding.body with the annotated source of that
 *                        region, ready to re-render
 *     primes       bool  run update() once immediately after the initial paint
 *
 *   Runtime:
 *     update({binding, nodes, context, render, replaceRegion, reindex, controller})
 *                        → boolean, whether anything was written
 *     attach({binding, node, controller})   once per node, when it is indexed
 *     detach({binding, node, controller})   on controller.destroy()
 *
 * `update` receives ALL the binding's nodes at once rather than being called per
 * node, because a region handler must re-index exactly once however many regions
 * it owns — calling it per node would re-index per node, which is quadratic and
 * was the shape of the original code for a reason.
 *
 * ── primes, and why it exists ────────────────────────────────────────────────
 *
 * The first paint runs the whole annotated template through the renderer, so a
 * `{{name}}` is already correct before any binding updates. A `data-bind-text`
 * is not: there is no mustache token for the renderer to substitute, only an
 * attribute the renderer passes through untouched. Those bindings declare
 * `primes: true` and the compiler runs them once after painting, which is what
 * makes an input with `data-model="query"` show the current query rather than
 * an empty box until the user types.
 */

import {BLOCKED_KEYS, evaluateAst} from './expression.js';
import {CONTEXT_KEYS} from './context.js';
import {truthy} from './render.js';

const PREFIX = '[Domma Reactive]';

/** name → handler. Insertion order is the order attribute claims are tried. */
const registry = new Map();

/** Warnings that must fire once rather than once per node per render. */
const warned = new Set();

function warnOnce(key, message) {
    if (warned.has(key)) return;
    warned.add(key);
    console.warn(`${PREFIX} ${message}`);
}

// ── Registry ──────────────────────────────────────────────────────────────────

/**
 * Register a binding handler.
 *
 * @param {string} name    the binding kind, e.g. 'model'. Becomes binding.kind.
 * @param {Object} handler see the contract at the top of this file
 * @returns {Object} the handler, so a registration can be inlined
 * @throws {TypeError} on a bad name or a handler with no update()
 */
export function registerBinding(name, handler) {
    if (typeof name !== 'string' || name.length === 0) {
        throw new TypeError(`${PREFIX} registerBinding: the name must be a non-empty string`);
    }
    if (handler === null || typeof handler !== 'object') {
        throw new TypeError(`${PREFIX} registerBinding: "${name}" was not given a handler object`);
    }
    if (typeof handler.update !== 'function') {
        throw new TypeError(`${PREFIX} registerBinding: "${name}" has no update() function`);
    }
    for (const hook of ['attach', 'detach']) {
        if (handler[hook] !== undefined && typeof handler[hook] !== 'function') {
            throw new TypeError(`${PREFIX} registerBinding: "${name}".${hook} is not a function`);
        }
    }

    // Replacing a built-in is allowed — a consumer may legitimately want a
    // different `text` — but it is loud, because it is almost always a name
    // collision rather than an intention.
    if (registry.has(name)) {
        console.warn(`${PREFIX} registerBinding: "${name}" replaces an existing binding handler`);
    }

    registry.set(name, Object.freeze({...handler}));
    return handler;
}

/**
 * Remove a binding handler.
 *
 * Templates already compiled keep working: a binding record holds its kind, and
 * `update()` on a kind with no handler is a no-op rather than a throw.
 *
 * @param {string} name
 * @returns {boolean} whether a handler of that name existed
 */
export function unregisterBinding(name) {
    return registry.delete(name);
}

/**
 * The handler for a kind, or undefined.
 * Internal to the package; the compiler dispatches through it.
 *
 * @param {string} name
 * @returns {Object|undefined}
 */
export function bindingHandler(name) {
    return registry.get(name);
}

/**
 * Which binding, if any, claims this attribute name.
 *
 * Exact `attribute` matches beat `attributePrefix` matches, so a handler can
 * claim `data-bind-text` specifically without disturbing `data-bind-*`. Among
 * prefixes the longest wins, so a later `data-on-key-` would take precedence
 * over `data-on-` for `data-on-key-escape`.
 *
 * @param {string} attributeName
 * @returns {{kind: string, handler: Object, arg: string|null}|null}
 */
export function claimAttribute(attributeName) {
    let best = null;

    for (const [kind, handler] of registry) {
        if (handler.attribute === attributeName) {
            return {kind, handler, arg: null};
        }
        if (typeof handler.attributePrefix === 'string'
            && attributeName.startsWith(handler.attributePrefix)
            && attributeName.length > handler.attributePrefix.length
            && (best === null || handler.attributePrefix.length > best.handler.attributePrefix.length)) {
            best = {kind, handler, arg: attributeName.slice(handler.attributePrefix.length)};
        }
    }

    return best;
}

// ── Shared helpers ────────────────────────────────────────────────────────────

const str = (value) => (value === null || value === undefined ? '' : String(value));

/**
 * Resolve an AST to the object and key it would WRITE through.
 *
 * This is the other half of the evaluator, and `data-model` is the only thing
 * that needs it. Reading `user.email` walks to a value; writing it has to stop
 * one step short and hand back `{object: user, key: 'email'}`.
 *
 * What is settable is therefore exactly what is a *path*: a bare name, or a
 * member chain ending in one. `a + b` is not settable, `helper(x)` is not
 * settable, and `$data`/`$root`/`$parent`/`$index` are not settable — a context
 * is a fact about position, not a variable.
 *
 * The object part is evaluated with the ordinary evaluator, so its prototype
 * guard applies on the way in; the final key is checked against the same
 * BLOCKED_KEYS list on the way out, because `data-model="x.__proto__"` is
 * prototype pollution with the arrow pointing the other way and the read guard
 * would never see it.
 *
 * @param {Object|null} ast
 * @param {Object} context
 * @returns {{object: Object, key: string}|null}
 */
export function resolveWriteTarget(ast, context) {
    if (ast === null || typeof ast !== 'object') return null;

    if (ast.type === 'Identifier') {
        if (CONTEXT_KEYS.has(ast.name)) return null;
        const object = context.$data;
        if (object === null || typeof object !== 'object') return null;
        return BLOCKED_KEYS.has(ast.name) ? null : {object, key: ast.name};
    }

    if (ast.type === 'Member') {
        const object = evaluateAst(ast.object, context);
        if (object === null || typeof object !== 'object') return null;
        const key = str(ast.computed ? evaluateAst(ast.property, context) : ast.property);
        return BLOCKED_KEYS.has(key) ? null : {object, key};
    }

    return null;
}

// ── text ──────────────────────────────────────────────────────────────────────

/**
 * `{{name}}` → the textContent of a generated <span> anchor.
 *
 * `binding.evaluate` is prepared by the compiler and is one of two things: a
 * path walk, for the dotted paths that were the only supported form before M3,
 * or the expression evaluator, for everything else. The handler does not care
 * which — that decision belongs at compile time, where it is made once.
 */
const textHandler = {
    tracks: true,
    update({binding, nodes, context}) {
        const text = str(binding.evaluate(context));
        for (const el of nodes) el.textContent = text;
        return true;
    }
};

// ── attr ──────────────────────────────────────────────────────────────────────

/**
 * `class="{{cls}} static"` → setAttribute on the owning element.
 *
 * An attribute value is a template with literal text around its interpolations,
 * not an expression, so this one goes through the renderer rather than the
 * evaluator. `data-bind-class` is the expression-valued alternative.
 */
const attrHandler = {
    tracks: true,
    update({binding, nodes, context, render}) {
        for (const el of nodes) {
            for (const part of binding.parts) {
                const rendered = render(part.tmpl, context.$data);
                el.setAttribute(part.name, rendered);
                // Keep the live property in step for form controls: an <input>
                // whose value attribute changes does not change what is typed
                // in it.
                if (part.name === 'value' && 'value' in el) el.value = rendered;
            }
        }
        return true;
    }
};

// ── block / raw ───────────────────────────────────────────────────────────────

/**
 * `{{#if x}}…{{/if}}` and `{{{html}}}` → a comment-delimited region, re-rendered.
 *
 * One handler serves both because the operation is identical: render the
 * captured body, replace everything between the anchors, re-index so bindings
 * that appeared or vanished pick up (or drop) their nodes. They are registered
 * under two names because a binding's kind is what a consumer inspects, and
 * collapsing them would lose the distinction the compiler took care to make.
 */
const regionHandler = {
    tracks: true,
    capturesBody: true,
    update({binding, nodes, context, render, replaceRegion, reindex}) {
        const html = render(binding.body, context.$data);
        for (const region of nodes) replaceRegion(region.open, region.close, html);
        reindex();
        return true;
    }
};

// ── data-if ───────────────────────────────────────────────────────────────────

/**
 * `data-if="isOpen"` → the element is in the DOM, or it is not.
 *
 * ── Why removal, and not display:none ────────────────────────────────────────
 *
 * Because it is called `if`. A binding named after a conditional that leaves the
 * element in the document, styleable, focusable and read by a screen reader, is
 * lying about what it does; `data-bind-hidden` already covers wanting it there
 * but invisible. Knockout draws the same line between `if` and `visible`.
 *
 * ── Why a region, and not a detached node ────────────────────────────────────
 *
 * The obvious implementation stashes the element and puts it back. It is wrong,
 * and subtly: while detached, every binding *inside* the element is invisible to
 * re-indexing, so it stops updating — and when the element comes back it carries
 * whatever values it had when it left. Re-rendering from the captured body
 * cannot go stale, and reuses the machinery `{{#if}}` already relies on.
 *
 * The cost is node identity: toggling twice gives a new element. `{{#if}}` has
 * always behaved that way, so the two are at least consistent. `applyBindings`
 * is the one place `data-if` DOES preserve the element, and it can only do so
 * because nothing there is ever re-indexed — see apply-bindings.js.
 *
 * Truthiness is mustache truthiness — an empty array is falsy — so that
 * `{{#if items}}` and `data-if="items"` cannot disagree about an empty list.
 */
const ifHandler = {
    tracks: true,
    region: true,
    capturesBody: true,
    primes: true,
    attribute: 'data-if',
    expression: true,
    update({binding, nodes, context, render, replaceRegion, reindex}) {
        const html = truthy(binding.evaluate(context)) ? render(binding.body, context.$data) : '';
        for (const region of nodes) replaceRegion(region.open, region.close, html);
        reindex();
        return true;
    }
};

// ── data-on-* ─────────────────────────────────────────────────────────────────

/** node → Map<bindingId, {type, listener}>, so detach can undo exactly one attach. */
const listeners = new WeakMap();

/**
 * `data-on-click="save"` → an event listener.
 *
 * ── What the expression may be ───────────────────────────────────────────────
 *
 * Either a reference that evaluates to a function:
 *
 *     data-on-click="save"            save.call($data, event)
 *     data-on-click="handlers.save"   ditto
 *
 * or a call, in which case the arguments are evaluated at dispatch time and the
 * event is appended:
 *
 *     data-on-click="save(item, 2)"   save.call($data, item, 2, event)
 *
 * The rule is "your arguments, then the event", which means a handler that
 * wants only the event and a handler that wants arguments are spelled the same
 * way round. `this` is `$data`.
 *
 * The call form does NOT go through the evaluator's helper registry. The parser
 * produces a `Call` node whose callee is a bare name, and this handler resolves
 * that name against the binding context instead — because an event handler is a
 * method on your data, not a pure helper, and the evaluator is right to refuse
 * to call one during a render. Arguments are evaluated by the ordinary
 * evaluator, so they obey every rule it does.
 *
 * Returning `false` calls preventDefault(), the jQuery idiom Domma users
 * already have in their fingers.
 *
 * ── No dependencies ──────────────────────────────────────────────────────────
 *
 * `tracks: false`. A listener is attached once and reads the context at dispatch
 * time, so there is nothing for an effect to re-run. Declaring dependencies here
 * would wire an effect per handler that could only ever do nothing.
 */
const eventHandler = {
    attributePrefix: 'data-on-',
    expression: true,
    tracks: false,

    update() {
        return false;   // events write nothing; attach() does the work
    },

    attach({binding, node, controller}) {
        if (!binding.arg) return;

        const listener = (event) => dispatchEvent(binding, event, controller.context());
        node.addEventListener(binding.arg, listener);

        let byBinding = listeners.get(node);
        if (!byBinding) listeners.set(node, (byBinding = new Map()));
        byBinding.set(binding.id, {type: binding.arg, listener});
    },

    detach({binding, node}) {
        const entry = listeners.get(node)?.get(binding.id);
        if (!entry) return;
        node.removeEventListener(entry.type, entry.listener);
        listeners.get(node).delete(binding.id);
    }
};

/** Evaluate an event binding's expression and invoke whatever it names. */
function dispatchEvent(binding, event, context) {
    const ast = binding.ast;
    if (ast === null) return;

    let fn;
    let args;

    if (ast.type === 'Call') {
        fn = evaluateAst({type: 'Identifier', name: ast.callee}, context);
        args = ast.args.map((arg) => evaluateAst(arg, context));
    } else {
        fn = evaluateAst(ast, context);
        args = [];
    }

    if (typeof fn !== 'function') {
        warnOnce(
            `event:${binding.id}:${binding.expr}`,
            `data-on-${binding.arg}="${binding.expr}" did not resolve to a function — ` +
            'an event binding names a handler on your data, or calls one'
        );
        return;
    }

    if (fn.call(context.$data, ...args, event) === false) event.preventDefault();
}

// ── data-bind-* ───────────────────────────────────────────────────────────────

/**
 * Names written as a PROPERTY rather than an attribute.
 *
 * For each of these the attribute is the initial value and the property is the
 * live one, so `setAttribute('checked', '')` on a box the user has already
 * unticked does nothing visible. Setting the property reflects back to the
 * attribute where the DOM says it should, so this is strictly the better half
 * of the pair.
 */
const PROPERTY_FIRST = new Set([
    'value', 'checked', 'selected', 'disabled', 'readonly', 'required',
    'multiple', 'indeterminate', 'open', 'hidden'
]);

/** binding → (node → the class tokens this binding last applied). */
const appliedClasses = new WeakMap();

/**
 * `data-bind-text="user.name"`, `data-bind-class="active && 'on'"`,
 * `data-bind-disabled="busy"`, `data-bind-aria-label="label"`.
 *
 * The suffix after `data-bind-` is the target:
 *
 *   text        textContent
 *   class       class tokens — see below
 *   value, checked, disabled, …   the DOM property (see PROPERTY_FIRST)
 *   anything else                 an attribute of that name
 *
 * For an attribute, `false`/`null`/`undefined` REMOVES it and `true` sets it to
 * the empty string, which is what makes `data-bind-aria-hidden="collapsed"`
 * behave the way an author expects rather than rendering the string "false".
 *
 * ── class is additive, not a replacement ─────────────────────────────────────
 *
 * Writing `el.className = value` would delete every static class on the element,
 * which no author wants and which is silent until they look. So the handler
 * remembers the tokens it applied last time, removes exactly those, and adds the
 * new ones. Static classes, and classes added by other bindings or by code, are
 * untouched.
 *
 * ── There is no data-bind-html ───────────────────────────────────────────────
 *
 * Deliberately. Assigning innerHTML from data is the shortest route to an XSS
 * hole in a framework, and the template already has an explicit, documented,
 * greppable opt-out for it: `{{{triple-stache}}}`. An attribute that quietly did
 * the same thing would be the same hole with none of the visibility.
 */
const bindHandler = {
    attributePrefix: 'data-bind-',
    expression: true,
    tracks: true,
    primes: true,

    update({binding, nodes, context}) {
        const target = binding.arg;

        if (target === 'html') {
            warnOnce(
                'bind:html',
                'data-bind-html is not supported — assigning innerHTML from data is an ' +
                'XSS hole. Use {{{triple-stache}}}, which says so where an author can see it.'
            );
            return false;
        }

        const value = binding.evaluate(context);

        for (const el of nodes) {
            if (target === 'text') {
                el.textContent = str(value);
            } else if (target === 'class') {
                applyClasses(binding, el, value);
            } else if (PROPERTY_FIRST.has(target) && target in el) {
                el[target] = target === 'value' ? str(value) : Boolean(value);
            } else if (value === null || value === undefined || value === false) {
                el.removeAttribute(target);
            } else {
                el.setAttribute(target, value === true ? '' : str(value));
            }
        }

        return true;
    }
};

/**
 * Swap the class tokens this binding owns on one element, leaving the rest.
 *
 * A FALSY value contributes no classes at all. That is not a shortcut: the
 * documented idiom is `data-bind-class="isActive && 'on'"`, which evaluates to
 * `false` — not to `''` — when it is off, and stringifying that would add the
 * literal class `false` to the element.
 */
function applyClasses(binding, el, value) {
    let byNode = appliedClasses.get(binding);
    if (!byNode) appliedClasses.set(binding, (byNode = new WeakMap()));

    for (const token of byNode.get(el) || []) el.classList.remove(token);

    const tokens = value ? str(value).split(/\s+/).filter(Boolean) : [];
    for (const token of tokens) el.classList.add(token);

    byNode.set(el, tokens);
}

// ── data-model ────────────────────────────────────────────────────────────────

/**
 * `data-model="query"` → two-way binding between a form control and the data.
 *
 * ── How the write-back works, and what a settable path is ────────────────────
 *
 * The expression must be a PATH: a bare name, or a member chain ending in one.
 * At write time the object part is evaluated and the last step is used as a key,
 * so `data-model="user.email"` assigns to `user.email` and `data-model="a[i]"`
 * assigns to whichever element `i` currently names. Anything that is not a path
 * — a comparison, a helper call, a context variable — is refused at compile time
 * with a warning, because a binding you cannot write through is not two-way.
 *
 * There is no observable-unwrapping magic. A tracking proxy (what Domma's
 * `model.tracked()` returns) is written as `data-model="name"`; a standalone
 * observable is written as `data-model="count.value"`, which is the same `.value`
 * the design spec §5 makes the read/write route for one. Both are ordinary
 * property assignments, and neither needs the binding to guess which it has.
 *
 * ── Which property, which event ──────────────────────────────────────────────
 *
 *   checkbox            checked (boolean)              change
 *   radio               checked, against the value     change
 *   select[multiple]    an array of selected values    change
 *   select              value                          change
 *   number, range       value coerced to a Number      input, change
 *   everything else     value                          input, change
 *
 * `change` is listened for alongside `input` on text-like controls because not
 * every control, and not every browser, fires `input` for every kind of edit;
 * a duplicate write of an identical value costs nothing, since the graph's
 * equality short-circuit drops it.
 *
 * The data → DOM direction writes only when the value actually differs, so
 * re-rendering while someone is typing does not move their caret to the end.
 */
const modelHandler = {
    attribute: 'data-model',
    expression: true,
    tracks: true,
    primes: true,

    update({binding, nodes, context}) {
        const value = binding.evaluate(context);
        for (const el of nodes) writeToControl(el, value);
        return true;
    },

    attach({binding, node, controller}) {
        const listener = () => {
            const context = controller.context();
            const target = resolveWriteTarget(binding.ast, context);
            if (target === null) {
                warnOnce(
                    `model:${binding.id}:${binding.expr}`,
                    `data-model="${binding.expr}" is not a settable path, so nothing was written`
                );
                return;
            }
            const value = readFromControl(node);
            if (value !== NO_WRITE) target.object[target.key] = value;
        };

        const types = modelEvents(node);
        for (const type of types) node.addEventListener(type, listener);

        let byBinding = listeners.get(node);
        if (!byBinding) listeners.set(node, (byBinding = new Map()));
        byBinding.set(binding.id, {type: types, listener});
    },

    detach({binding, node}) {
        const entry = listeners.get(node)?.get(binding.id);
        if (!entry) return;
        for (const type of entry.type) node.removeEventListener(type, entry.listener);
        listeners.get(node).delete(binding.id);
    }
};

/** An unchecked radio has nothing to say; writing from it would clear the group. */
const NO_WRITE = Symbol('no-write');

function controlKind(el) {
    const tag = el.tagName;
    if (tag === 'SELECT') return el.multiple ? 'select-multiple' : 'select';
    if (tag !== 'INPUT') return 'text';
    const type = String(el.type || '').toLowerCase();
    if (type === 'checkbox' || type === 'radio') return type;
    if (type === 'number' || type === 'range') return 'number';
    return 'text';
}

function modelEvents(el) {
    const kind = controlKind(el);
    return kind === 'text' || kind === 'number' ? ['input', 'change'] : ['change'];
}

function readFromControl(el) {
    switch (controlKind(el)) {
        case 'checkbox':
            return el.checked;
        case 'radio':
            return el.checked ? el.value : NO_WRITE;
        case 'select-multiple':
            return Array.from(el.options).filter((o) => o.selected).map((o) => o.value);
        case 'number':
            return el.value === '' ? null : Number(el.value);
        default:
            return el.value;
    }
}

function writeToControl(el, value) {
    switch (controlKind(el)) {
        case 'checkbox': {
            const next = Boolean(value);
            if (el.checked !== next) el.checked = next;
            return;
        }
        case 'radio': {
            const next = str(value) === el.value;
            if (el.checked !== next) el.checked = next;
            return;
        }
        case 'select-multiple': {
            const wanted = new Set((Array.isArray(value) ? value : []).map(str));
            for (const option of el.options) {
                const next = wanted.has(option.value);
                if (option.selected !== next) option.selected = next;
            }
            return;
        }
        default: {
            const next = str(value);
            if (el.value !== next) el.value = next;
        }
    }
}

// ── Registration ──────────────────────────────────────────────────────────────
//
// Through the public function, with no privileged path. See the note at the top.

registerBinding('text', textHandler);
registerBinding('attr', attrHandler);
registerBinding('block', regionHandler);
registerBinding('raw', regionHandler);

registerBinding('if', ifHandler);
registerBinding('event', eventHandler);
registerBinding('bind', bindHandler);
registerBinding('model', modelHandler);

/**
 * The kinds registered above, for tests that must notice a built-in going
 * missing. Not exported from index.js — it is a fact about this module, not a
 * promise to consumers.
 */
export const BUILT_IN_BINDINGS = Object.freeze([
    'text', 'attr', 'block', 'raw', 'if', 'event', 'bind', 'model'
]);
