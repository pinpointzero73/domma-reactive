/**
 * Binding handlers and the registry they live in.
 *
 * ── One registry, no private door ────────────────────────────────────────────
 *
 * Design spec §8 requires that Tier 3's four binding kinds — text, attr, block,
 * raw — become "built-in handlers on the new registry, the same mechanism public
 * `registerBinding()` uses". They do, literally: the bottom of this file calls
 * `registerBinding()` ten times through the same exported function a consumer
 * calls, with no privileged flag and no second code path. The eleventh built-in,
 * `each`, is registered by template-compiler.js through that same function — it
 * lives elsewhere only because the reconciler needs a compiled block template
 * and this module must not know that templates exist. If the public API could
 * not express a built-in, the public API would be a demo.
 *
 * The one thing a custom binding cannot do is invent `{{ }}` syntax. `text`,
 * `attr`, `block` and `raw` are discovered by the compiler from mustache tokens,
 * which are a fixed grammar; the six behaviour bindings and every custom one
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

import {BLOCKED_KEYS, compileExpression, evaluateAst, readMember} from './expression.js';
import {CONTEXT_KEYS, createChildContext} from './context.js';
import {liveItems, truthy} from './render.js';

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
 *     data-on-click="save(item, 2)"      save.call($data, item, 2, event)
 *     data-on-click="$parent.remove($data)"   remove.call($parent, item, event)
 *
 * The rule is "your arguments, then the event", which means a handler that
 * wants only the event and a handler that wants arguments are spelled the same
 * way round.
 *
 * ── Why a method call is allowed here and nowhere else ───────────────────────
 *
 * Inside a list `$data` is the ITEM, and a bare name resolves against `$data`
 * and nowhere else — the evaluator deliberately does not walk up to `$parent`,
 * because a name that silently resolves one level up is a name whose meaning
 * depends on data you are not looking at. That leaves `$parent.remove($data)`
 * as the only way for a row to reach the list that owns it, and until the event
 * binding could parse it, a row's delete button was unspellable.
 *
 * So this handler sets `methodCalls`, and it is the only one that does. An
 * interpolation, a `data-if` and a `data-bind-*` are READS that run inside an
 * effect; calling a method during one is a side effect where the design promises
 * none, and the evaluator still throws on a MethodCall node for exactly that
 * reason. An event fires on a gesture, outside every effect, and calling a
 * method on your view model is the whole point of it.
 *
 * Neither call form goes through the evaluator's helper registry — the callee is
 * resolved against the binding context instead, because an event handler is a
 * method on your data, not a pure helper. Arguments are evaluated by the
 * ordinary evaluator, so they obey every rule it does, and the method name is
 * read through the same `readMember` the evaluator uses, so `$data.constructor()`
 * is shut by the same blocklist that shuts `{{ $data.constructor }}`.
 *
 * ── What `this` is ───────────────────────────────────────────────────────────
 *
 *     save                 $data     a reference; the receiver is not named
 *     save(x)              $data     a bare callee is a name on $data
 *     handlers.save        $data     STILL a reference — nothing is called here
 *     handlers.save()      handlers  a method call keeps its receiver
 *
 * The last two look inconsistent and are not: they are what `const f = o.m; f()`
 * and `o.m()` do in the language the author already knows.
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
    methodCalls: true,
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
    let self = context.$data;

    if (ast.type === 'MethodCall') {
        // The receiver is evaluated once and kept, because it is both the thing
        // the method is read from and the `this` it runs with — resolving it
        // twice would let a getter disagree with itself between the two.
        self = evaluateAst(ast.object, context);
        const key = ast.computed ? evaluateAst(ast.property, context) : ast.property;
        fn = readMember(self, key);
        args = ast.args.map((arg) => evaluateAst(arg, context));
    } else if (ast.type === 'Call') {
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

    if (fn.call(self, ...args, event) === false) event.preventDefault();
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

/** binding → (node → the CSS properties this binding last applied). */
const appliedStyles = new WeakMap();

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
            } else if (target === 'style') {
                applyStyles(binding, el, value);
            } else if (target.startsWith('style-')) {
                setStyleProperty(el, target.slice('style-'.length), value);
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

/**
 * Style, in two spellings.
 *
 * ── Why not one, the way Knockout has one ────────────────────────────────────
 *
 * Knockout writes `style: {color: shade, fontWeight: w}`, which works because it
 * compiles the binding string with the `Function` constructor and gets object
 * literals for free. This expression language has no object literal and will not
 * grow one — parsing `{…}` safely is most of the way to the `eval` this package
 * exists to avoid. So the two halves are separated:
 *
 *   data-bind-style="look"              an object the view model already holds
 *   data-bind-style-color="shade"       one property, named in the attribute
 *
 * The second is the common case, and it is the one Knockout makes awkward — a
 * single colour there means inventing an object to carry it.
 *
 * Property names are kebab-cased in the attribute, because an HTML attribute
 * name is lowercased by the parser and `data-bind-style-fontWeight` would arrive
 * as `fontweight`. In an object they may be camelCase, as CSSOM spells them, and
 * are converted. A custom property (`--brand`) passes through either way.
 */
function setStyleProperty(el, property, value) {
    // Empty string included: `style.setProperty(p, '')` is a removal in CSSOM
    // anyway, and going through removeProperty says so. Zero is NOT in this
    // list — `opacity: 0` is a legitimate value, and the falsy check that swept
    // it away would be a bug an author could not see.
    if (value === null || value === undefined || value === false || value === '') {
        el.style.removeProperty(property);
        return;
    }
    el.style.setProperty(property, str(value));
}

/** camelCase → kebab-case, leaving a custom property untouched. */
function cssProperty(name) {
    return name.startsWith('--') ? name : name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
}

/**
 * Apply an object of CSS properties, removing only the ones this binding put
 * there last time — the same ownership rule `applyClasses` follows, and for the
 * same reason: a static `style="margin: 4px"` on the element is not this
 * binding's to delete.
 */
function applyStyles(binding, el, value) {
    if (value !== null && value !== undefined && typeof value !== 'object') {
        warnOnce(
            `bind:style:${binding.id}`,
            `data-bind-style="${binding.expr}" needs an object of CSS properties — got ` +
            `${typeof value}. For a single property use data-bind-style-<property>.`
        );
        return;
    }

    let byNode = appliedStyles.get(binding);
    if (!byNode) appliedStyles.set(binding, (byNode = new WeakMap()));

    const owned = byNode.get(el) || [];
    const applied = [];

    for (const [key, next] of Object.entries(value || {})) {
        const property = cssProperty(key);
        setStyleProperty(el, property, next);
        applied.push(property);
    }

    for (const property of owned) {
        if (!applied.includes(property)) el.style.removeProperty(property);
    }

    byNode.set(el, applied);
}

// ── data-options ──────────────────────────────────────────────────────────────

/**
 * The raw value behind an `<option>`, when it is not a string.
 *
 * A Symbol rather than a property name so it cannot collide with anything the
 * DOM or another library puts on the element, and so it does not serialise.
 */
const OPTION_VALUE = Symbol('dm:option-value');

/**
 * A value `data-model` asked a select to show while no option carried it.
 *
 * Attribute order decides which of two bindings on one element runs first, and
 * `<select data-model="chosen" data-options="cities">` is a perfectly reasonable
 * thing to write — at which point the model writes a value into a select with no
 * options at all, and it lands nowhere. Rather than impose an ordering between
 * binding kinds, the select remembers what it was asked for, and the next
 * rebuild honours it.
 *
 * The same mechanism covers the case ordering could never fix: options that
 * arrive later, from a fetch, long after the model settled on a value.
 */
const PENDING_VALUE = Symbol('dm:pending-value');

/**
 * `data-options="cities"` → populate a `<select>` from a collection.
 *
 * ── Why this exists when {{#each}} already renders a list ────────────────────
 *
 * `{{#each cities}}<option>{{.}}</option>{{/each}}` produces the same markup.
 * What it does not produce is the SELECTION, and that is the whole problem:
 * rebuilding a select's options resets `value` to the first one, and the
 * selection lives on the select rather than on any item, so a keyed each has
 * nothing to preserve it with. This binding rebuilds the list and puts the
 * selection back, which is the only part an author cannot easily write.
 *
 * ── The three companion attributes ───────────────────────────────────────────
 *
 *   data-options-text="name"        the label — an expression against the item
 *   data-options-value="id"         the value — likewise; defaults to the item
 *   data-options-caption="'Any…'"   a leading blank-valued option
 *
 * They are expressions evaluated in a child context, so `$index`, `$parent` and
 * `$root` all resolve, and `data-options-text="first + ' ' + last"` works.
 * Knockout takes a property NAME here, which cannot express that. The cost is
 * that a literal caption needs its quotes — `"'Any…'"` — and that is the price
 * of every binding value in this package being an expression rather than
 * sometimes an expression and sometimes a string.
 *
 * ── Values that are not strings ──────────────────────────────────────────────
 *
 * An `<option>`'s `value` is a string, always. When the resolved value is not
 * one, the real value is kept on the option under a Symbol and the DOM value
 * becomes an opaque token, so `data-model` reads back the object or the number
 * that went in rather than "[object Object]" or "2". See `readFromControl`.
 */
const optionsHandler = {
    attribute: 'data-options',
    expression: true,
    tracks: true,
    primes: true,

    update({binding, nodes, context}) {
        const items = liveItems(binding.evaluate(context));
        for (const el of nodes) buildOptions(binding, el, items, context);
        return true;
    }
};

/** Compile a companion attribute, or null when it is absent or unparseable. */
function optionExpression(el, attribute) {
    const source = el.getAttribute(attribute);
    if (source === null || source.trim() === '') return null;
    return compileExpression(source);
}

/** What is selected now, as raw values, so it can be restored after a rebuild. */
function currentSelection(el) {
    return [...el.options]
        .filter((option) => option.selected)
        .map((option) => (OPTION_VALUE in option ? option[OPTION_VALUE] : option.value));
}

function buildOptions(binding, el, items, context) {
    if (el.tagName !== 'SELECT') {
        warnOnce(
            `options:${binding.id}`,
            `data-options="${binding.expr}" is on <${el.tagName.toLowerCase()}>, which has no ` +
            'options. Put it on a <select>.'
        );
        return;
    }

    const textOf    = optionExpression(el, 'data-options-text');
    const valueOf   = optionExpression(el, 'data-options-value');
    const captionOf = optionExpression(el, 'data-options-caption');

    // What the rebuild has to put back. A value the model could not apply wins
    // over what is selected now: the model is the source of truth, and the
    // current selection is only a browser default if it never got to run.
    const wanted = PENDING_VALUE in el ? [].concat(el[PENDING_VALUE]) : currentSelection(el);

    el.textContent = '';

    if (captionOf) {
        const caption = document.createElement('option');
        caption.value = '';
        caption.textContent = str(captionOf(context));
        el.appendChild(caption);
    }

    items.forEach((item, index) => {
        const itemContext = createChildContext(context, item, index, items.length);
        const option = document.createElement('option');

        option.textContent = str(textOf ? textOf(itemContext) : item);

        const value = valueOf ? valueOf(itemContext) : item;
        if (value === null || value === undefined || typeof value === 'object') {
            // Opaque on purpose: two items that stringify alike must not become
            // the same option. The NUL prefix is the same trick the reconciler
            // uses for a synthesised key — no author-supplied string can collide.
            option.value = ` opt:${index}`;
            option[OPTION_VALUE] = value;
        } else if (typeof value !== 'string') {
            option.value = str(value);
            option[OPTION_VALUE] = value;
        } else {
            option.value = value;
        }

        el.appendChild(option);
    });

    restoreSelection(el, wanted);
}

/**
 * Re-select what was selected before, by raw value where there is one.
 *
 * A value that no longer has an option is dropped rather than forced, which
 * leaves the browser's own default (the first option, or the caption) showing —
 * the honest result when the thing that was chosen is no longer on offer.
 */
function restoreSelection(el, wanted) {
    if (wanted.length === 0) return;

    let matched = false;

    for (const option of el.options) {
        const raw = OPTION_VALUE in option ? option[OPTION_VALUE] : option.value;
        const hit = wanted.some((value) => value === raw);

        if (el.multiple) {
            option.selected = hit;
            matched = matched || hit;
        } else if (hit && !matched) {
            option.selected = true;
            matched = true;
        }
    }

    if (!el.multiple && !matched) el.selectedIndex = el.options.length > 0 ? 0 : -1;

    // Honoured, so stop holding it. Still unmatched means the option has not
    // arrived yet, and it stays pending for the rebuild that brings it.
    if (matched) delete el[PENDING_VALUE];
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
            return Array.from(el.options).filter((o) => o.selected).map(optionValue);
        case 'select':
            return el.selectedIndex === -1 ? '' : optionValue(el.options[el.selectedIndex]);
        case 'number':
            return el.value === '' ? null : Number(el.value);
        default:
            return el.value;
    }
}

/**
 * An option's value as the data saw it.
 *
 * `data-options` stashes anything that is not a string, so a select built from
 * objects or numbers reads back objects or numbers. An option written by hand in
 * the template has no stash and reads back its string, exactly as before.
 */
function optionValue(option) {
    return OPTION_VALUE in option ? option[OPTION_VALUE] : option.value;
}

/** The option holding this raw value, by identity. */
function optionFor(el, value) {
    return [...el.options].find((option) => optionValue(option) === value) || null;
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
            const wanted = Array.isArray(value) ? value : [];

            // No options yet — same story as a single select, so remember the
            // request until they turn up. See PENDING_VALUE.
            if (el.options.length === 0) {
                if (wanted.length > 0) el[PENDING_VALUE] = wanted;
                return;
            }

            const strings = new Set(wanted.map(str));
            for (const option of el.options) {
                const raw = optionValue(option);
                // Identity first, so an option carrying a stashed object matches
                // the object itself; string comparison second, so a hand-written
                // <option value="a"> still matches the string "a".
                const next = wanted.some((v) => v === raw) || strings.has(option.value);
                if (option.selected !== next) option.selected = next;
            }
            return;
        }
        case 'select': {
            const option = optionFor(el, value);
            if (option) {
                if (!option.selected) option.selected = true;
                delete el[PENDING_VALUE];
                return;
            }

            const next = str(value);
            if (el.value !== next) el.value = next;

            // The assignment is ignored by the DOM when no option carries that
            // value, so this is how "it did not take" is detected. See
            // PENDING_VALUE for why it is remembered rather than dropped.
            if (el.value !== next) el[PENDING_VALUE] = value;
            else delete el[PENDING_VALUE];
            return;
        }
        default: {
            const next = str(value);
            if (el.value !== next) el.value = next;
        }
    }
}

// ── data-focus ────────────────────────────────────────────────────────────────

/** Elements this binding is moving focus on right now. */
const focusing = new WeakSet();

/**
 * `data-focus="editing"` → two-way binding between the value and focus.
 *
 * Knockout calls this `hasFocus`. The name here says which way the arrow points,
 * and matches `data-model` in being the second of only two two-way bindings in
 * the package — everything else is a read.
 *
 * Both directions earn their place. Data → DOM is how a view model moves the
 * caret into the field it has just revealed, which otherwise means reaching for
 * a DOM node from code that should not have one. DOM → data is how it knows
 * which field the user is in without wiring up focus listeners by hand.
 *
 * ── The re-entrancy guard ────────────────────────────────────────────────────
 *
 * Calling `focus()` fires a focus event, which writes `true` back to the very
 * expression that asked for it. With an observable the change gate stops there,
 * but with a plain object there is no gate, and the write is at best pointless
 * and at worst a loop through a computed that recomputes on it. The element is
 * flagged for the duration of the call instead, so the echo is ignored at
 * source rather than absorbed downstream.
 *
 * ── A write-back that cannot land is not fatal ───────────────────────────────
 *
 * `data-model` refuses to be one-way: a form control you cannot write through is
 * broken. Focus is different — `data-focus="isEditing && !isSaving"` is a
 * perfectly sensible way to drive focus from derived state, and it is only the
 * write-back that is impossible. So the data → DOM direction keeps working and
 * the write warns once, naming the expression.
 */
const focusHandler = {
    attribute: 'data-focus',
    expression: true,
    tracks: true,
    primes: true,

    update({binding, nodes, context}) {
        const wanted = truthy(binding.evaluate(context));

        for (const el of nodes) {
            if (typeof el.focus !== 'function') continue;

            const has = el.ownerDocument.activeElement === el;
            if (wanted === has) continue;

            focusing.add(el);
            try {
                if (wanted) el.focus();
                else el.blur();
            } finally {
                focusing.delete(el);
            }
        }

        return true;
    },

    attach({binding, node, controller}) {
        const listener = (event) => {
            if (focusing.has(node)) return;

            const context = controller.context();
            const target = resolveWriteTarget(binding.ast, context);
            if (target === null) {
                warnOnce(
                    `focus:${binding.id}:${binding.expr}`,
                    `data-focus="${binding.expr}" is not a settable path, so focus was not ` +
                    'written back. Focus still follows the value.'
                );
                return;
            }

            target.object[target.key] = event.type === 'focus';
        };

        const types = ['focus', 'blur'];
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
registerBinding('options', optionsHandler);
registerBinding('focus', focusHandler);

/**
 * The kinds registered above, for tests that must notice a built-in going
 * missing. Not exported from index.js — it is a fact about this module, not a
 * promise to consumers.
 */
export const BUILT_IN_BINDINGS = Object.freeze([
    'text', 'attr', 'block', 'raw', 'if', 'event', 'bind', 'model', 'options', 'focus'
]);
