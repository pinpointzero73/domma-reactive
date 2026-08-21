# Components (stage 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Ships as:** 0.7.0. The roadmap agreed on 2026-08-18 is 0.6.0 `$parents[n]`, **0.7.0 components**, 0.8.0 slots, 1.0.0 Knockout parity complete. Build 0.6.0 first - this plan assumes `$parents[n]` has already shipped.

**Goal:** Add a component model to domma-reactive - `registerComponent()`, a `data-component` binding, params in both spellings, view-model lifecycle, `$component`, and dynamic component swapping - closing the last substantial capability gap against Knockout apart from slots.

**Architecture:** Components reuse the keyed-list machinery almost entirely. A component instance *is* a `createInstance()` instance: a cloned template, its own child context, its own effects, an anchored region, and node-scoped disposal. The new code is a registry, a params collector, a context field, and one binding handler. The handler follows the `each` seam exactly - `src/components.js` knows nothing about templates, and `template-compiler.js` hands it a factory-builder, so the dependency runs one way and no cycle is created.

**Tech Stack:** Vanilla ES modules, Vitest + jsdom, Rollup. No new dependencies.

---

## Read first

- `docs/superpowers/specs/2026-08-18-component-params-design.md` - the agreed design. This plan implements it; where they disagree, the spec wins.
- `src/handlers.js` lines 24-64 - the binding handler contract.
- `src/reconciler.js` lines 380-408 - `createEachHandler` / `registerEachHandler`, the seam this copies.
- `src/reconciler.js` lines 302-330 - `reconcile`, for how per-region state is held in a `WeakMap` keyed by `region.open` with a `registerDisposer` beside it.

## File structure

| File | Status | Responsibility |
|---|---|---|
| `src/components.js` | **create** | Registry, params collection, the `component` binding handler. Knows nothing about templates or how one is compiled. |
| `src/components.test.js` | **create** | Everything in the spec's test list. |
| `src/context.js` | modify | `$component` added to `CONTEXT_KEYS`, inherited by `createChildContext`, plus `createComponentContext`. |
| `src/context.test.js` | modify | Inheritance and null-outside-a-component. |
| `src/template-compiler.js` | modify | `componentFactory()` - a template *string* to a cloneable factory - and the `registerComponentHandler` call that hands it over. |
| `src/reconciler.js` | modify | `createInstance` gains an options argument so a caller can supply the context. |
| `src/index.js` | modify | Export `registerComponent`, `unregisterComponent`. |
| `scripts/verify-dist.mjs` | modify | `EXPECTED` grows from 31 to 33. |
| `README.md` | modify | See Task 11. |
| `Tutorial.md`, `src/tutorial.test.js` | modify | See Task 12. |
| `CHANGELOG.md` | modify | See Task 13. |

## Conventions this codebase holds to

Follow these or the review will bounce it:

- **Nothing throws at render time.** Every failure logs exactly one warning naming the expression and the template, and skips that binding alone. Use `warnOnce(key, message)` with a key that includes `binding.id`.
- **Registration functions throw** on a bad name - see `registerExtender`. That asymmetry is deliberate: a bad registration is a programming error at startup, a bad expression is authored data at runtime.
- **British English** in prose and comments.
- **Module header comments explain *why*.** Every file in `src/` opens with one. Match the register.
- Run `npm run test:run` before every commit.

---

### Task 1: `$component` on the binding context

**Files:**
- Modify: `src/context.js`
- Test: `src/context.test.js`

- [ ] **Step 1: Write the failing tests**

Append to `src/context.test.js`:

```javascript
describe('$component', () => {
    it('is null at the root', () => {
        expect(createRootContext({a: 1}).$component).toBeNull();
    });

    it('is null in a child of a root', () => {
        const root = createRootContext({a: 1});
        expect(createChildContext(root, {b: 2}).$component).toBeNull();
    });

    it('is the view model inside a component context', () => {
        const vm = {name: 'ada'};
        const ctx = createComponentContext(createRootContext({}), vm);
        expect(ctx.$component).toBe(vm);
        expect(ctx.$data).toBe(vm);
    });

    it('is inherited by child contexts, as $root is', () => {
        const vm = {name: 'ada'};
        const component = createComponentContext(createRootContext({title: 't'}), vm);
        const row = createChildContext(component, {id: 1}, 0, 1);

        expect(row.$component).toBe(vm);
        expect(row.$data).toEqual({id: 1});
        expect(row.$parent).toBe(vm);
    });

    it('is a context key, so an expression may not be written through it', () => {
        expect(CONTEXT_KEYS.has('$component')).toBe(true);
    });
});
```

Add `createComponentContext` and `CONTEXT_KEYS` to the import at the top of the file if absent.

- [ ] **Step 2: Run and watch it fail**

Run: `npx vitest run src/context.test.js`
Expected: FAIL - `createComponentContext is not a function`.

- [ ] **Step 3: Implement**

In `src/context.js`, add `'$component'` to the set:

```javascript
export const CONTEXT_KEYS = new Set(['$data', '$root', '$parent', '$index', '$length', '$component']);
```

Add `$component: null` to the object `createRootContext` returns, and to `createChildContext` add inheritance beside `$root`:

```javascript
        $component: base.$component ?? null
```

Then add, after `createChildContext`:

```javascript
/**
 * The context inside a component's template.
 *
 * `$data` is the view model, so a template reads its own state unqualified, and
 * `$component` is the same object - the point of the name is that it survives
 * into nested blocks, where `$data` no longer refers to the component. It is
 * inherited by `createChildContext` for exactly that reason, as `$root` is.
 *
 * `$index` and `$length` are null: a component is not a list item, even when one
 * happens to be rendered inside a list.
 *
 * @param {Object|*} parent  the enclosing context, or plain data
 * @param {*} viewModel
 * @returns {Object} frozen
 */
export function createComponentContext(parent, viewModel) {
    const base = toContext(parent);
    return Object.freeze({
        $data: viewModel,
        $root: base.$root,
        $parent: base.$data,
        $index: null,
        $length: null,
        $component: viewModel
    });
}
```

- [ ] **Step 4: Run the whole suite**

Run: `npm run test:run`
Expected: PASS. 807 existing plus 5 new. If any existing context test asserts an exact object shape it will fail on the new key - update it; the addition is intended.

- [ ] **Step 5: Commit**

```bash
git add src/context.js src/context.test.js
git commit -m "feat: add \$component to the binding context

Inherited by child contexts as \$root is, so it still answers inside a list
nested in a component's template - which is the only reason the name exists,
since \$data already reaches the view model at the top level.

context.js predicted this: an additive field, and nothing else changes."
```

---

### Task 2: The component registry

**Files:**
- Create: `src/components.js`
- Create: `src/components.test.js`

- [ ] **Step 1: Write the failing tests**

Create `src/components.test.js`:

```javascript
import {afterEach, describe, expect, it, vi} from 'vitest';

import {registerComponent, unregisterComponent, componentDefinition} from './components.js';

afterEach(() => {
    unregisterComponent('probe');
    vi.restoreAllMocks();
});

describe('registerComponent', () => {
    it('returns the definition, so a registration can be inlined', () => {
        const def = {template: '<b>hi</b>'};
        expect(registerComponent('probe', def)).toBe(def);
    });

    it('makes the definition findable', () => {
        const def = {template: '<b>hi</b>'};
        registerComponent('probe', def);
        expect(componentDefinition('probe')).toBe(def);
    });

    it('rejects a name that is not a non-empty string', () => {
        expect(() => registerComponent('', {template: 'x'})).toThrow(TypeError);
        expect(() => registerComponent(null, {template: 'x'})).toThrow(TypeError);
    });

    it('rejects a definition with no template', () => {
        expect(() => registerComponent('probe', {})).toThrow(TypeError);
        expect(() => registerComponent('probe', {template: 42})).toThrow(TypeError);
    });

    it('rejects a create that is not a function', () => {
        expect(() => registerComponent('probe', {template: 'x', create: 1})).toThrow(TypeError);
    });

    it('warns when it replaces an existing registration', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        registerComponent('probe', {template: 'a'});
        registerComponent('probe', {template: 'b'});
        expect(warn).toHaveBeenCalledOnce();
        expect(warn.mock.calls[0][0]).toContain('probe');
    });
});

describe('unregisterComponent', () => {
    it('reports whether there was one', () => {
        registerComponent('probe', {template: 'x'});
        expect(unregisterComponent('probe')).toBe(true);
        expect(unregisterComponent('probe')).toBe(false);
        expect(componentDefinition('probe')).toBeUndefined();
    });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `npx vitest run src/components.test.js`
Expected: FAIL - cannot resolve `./components.js`.

- [ ] **Step 3: Implement**

Create `src/components.js`. Open it with a header explaining why the module exists and why it does not import the template compiler - copy the register of the other headers, and say plainly that it takes its factory-builder by injection so `template-compiler.js` can depend on it rather than the reverse.

```javascript
const PREFIX = '[Domma Reactive]';

/** name → definition. */
const registry = new Map();

/**
 * Register a component.
 *
 * Throws rather than warns, like `registerExtender`: a bad registration is a
 * programming error at startup, where a bad expression is authored data met at
 * render time. The two get different treatment on purpose.
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
```

- [ ] **Step 4: Run**

Run: `npx vitest run src/components.test.js`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add src/components.js src/components.test.js
git commit -m "feat: add the component registry

registerComponent/unregisterComponent, mirroring registerExtender including
its throw-on-bad-name rule and its loud-but-permitted replacement."
```

---

### Task 3: Params collection

**Files:**
- Modify: `src/components.js`
- Modify: `src/components.test.js`

This is pure logic over an element's attributes and a context. No DOM mounting yet, so it is testable on its own.

- [ ] **Step 1: Write the failing tests**

Append to `src/components.test.js`:

```javascript
import {parseFragment} from './nodes.js';
import {createRootContext} from './context.js';
import {collectParams, paramName} from './components.js';
import {observable} from './observable.js';

/** One element from a markup string. */
function el(html) {
    return parseFragment(html).firstElementChild;
}

describe('paramName', () => {
    it('leaves a single word alone', () => {
        expect(paramName('contact')).toBe('contact');
    });

    it('camelCases a kebab name', () => {
        expect(paramName('first-name')).toBe('firstName');
        expect(paramName('a-b-c')).toBe('aBC');
    });
});

describe('collectParams', () => {
    const binding = {id: 'b1', expr: "'probe'"};

    it('reads a named param', () => {
        const node = el(`<div data-component="'probe'" data-param-label="title"></div>`);
        const params = collectParams(node, binding, createRootContext({title: 'Ada'}));
        expect(params).toEqual({label: 'Ada'});
    });

    it('camelCases the attribute suffix', () => {
        const node = el(`<div data-param-first-name="who"></div>`);
        expect(collectParams(node, binding, createRootContext({who: 'Ada'}))).toEqual({firstName: 'Ada'});
    });

    it('passes an observable by reference', () => {
        const name = observable('Ada');
        const node = el(`<div data-param-name="who"></div>`);
        const params = collectParams(node, binding, createRootContext({who: name}));

        expect(params.name).toBe(name);
        params.name.value = 'Grace';
        expect(name.value).toBe('Grace');
    });

    it('passes a snapshot when the expression reads .value', () => {
        const name = observable('Ada');
        const node = el(`<div data-param-name="who.value"></div>`);
        const params = collectParams(node, binding, createRootContext({who: name}));

        expect(params.name).toBe('Ada');
        name.value = 'Grace';
        expect(params.name).toBe('Ada');
    });

    it('reads the object form', () => {
        const node = el(`<div data-params="bag"></div>`);
        const params = collectParams(node, binding, createRootContext({bag: {a: 1, b: 2}}));
        expect(params).toEqual({a: 1, b: 2});
    });

    it('merges both, with the named attribute winning', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const node = el(`<div data-params="bag" data-param-a="override"></div>`);
        const params = collectParams(node, binding, createRootContext({bag: {a: 1, b: 2}, override: 9}));

        expect(params).toEqual({a: 9, b: 2});
        expect(warn).toHaveBeenCalledOnce();
        expect(warn.mock.calls[0][0]).toContain('a');
    });

    it('is frozen', () => {
        const node = el(`<div data-param-a="x"></div>`);
        const params = collectParams(node, binding, createRootContext({x: 1}));
        expect(Object.isFrozen(params)).toBe(true);
    });

    it('warns once and omits the param when its expression will not parse', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const node = el(`<div data-param-a="((("></div>`);
        const params = collectParams(node, binding, createRootContext({}));

        expect('a' in params).toBe(false);
        expect(warn).toHaveBeenCalled();
    });

    it('warns when data-params is not an object', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const node = el(`<div data-params="nope"></div>`);
        expect(collectParams(node, binding, createRootContext({nope: 5}))).toEqual({});
        expect(warn).toHaveBeenCalled();
    });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `npx vitest run src/components.test.js`
Expected: FAIL - `collectParams is not a function`.

- [ ] **Step 3: Implement**

Add to `src/components.js`, importing `compileExpression` from `./expression.js`:

```javascript
import {compileExpression} from './expression.js';

const PARAM_PREFIX = 'data-param-';

/** Warnings that must fire once rather than once per render. */
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
 * Evaluated once, here, at instantiation - a constructor argument rather than a
 * live binding. An observable passed as `data-param-x="thing"` stays live because
 * the object itself is what was passed; `data-param-x="thing.value"` is a
 * snapshot. That distinction needs no code: it is the same `.value` the author
 * already reads through, and it is visible in the markup.
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
```

- [ ] **Step 4: Run**

Run: `npx vitest run src/components.test.js`
Expected: PASS.

Note on the merge-warning test: the collision warning fires only when the object form supplied the key first, which is why the loop checks `key in params` *before* assigning. If the test fails because no warning fired, check the attribute order - `data-params` must be read before the loop, not inside it.

- [ ] **Step 5: Commit**

```bash
git add src/components.js src/components.test.js
git commit -m "feat: collect component params from both spellings

data-param-<name> per param, data-params for an object the view model already
holds - the pair data-bind-style established and data-options-* followed.

By-reference versus by-value needs no rule: data-param-x=\"thing\" passes the
observable and data-param-x=\"thing.value\" passes a snapshot, which is the
same .value distinction the author already reads through."
```

---

### Task 4: A factory from a template string

**Files:**
- Modify: `src/template-compiler.js`
- Test: `src/template-compiler.test.js`

`buildFactory` compiles `binding.body`. A component's template comes from the registry instead, so the same work needs a second entry point. Extract rather than duplicate.

- [ ] **Step 1: Write the failing test**

Append to `src/template-compiler.test.js`:

```javascript
describe('componentFactory', () => {
    it('compiles a template string into a cloneable factory', () => {
        const factory = componentFactory('<b data-bind-text="label"></b>', 'component probe', render, {});

        expect(factory.content).toBeInstanceOf(DocumentFragment);
        expect(factory.bindings.length).toBe(1);
        expect(factory.bindings[0].kind).toBe('bind');
        expect(factory.label).toBe('component probe');
    });

    it('gives each call distinct binding ids, so two components do not collide', () => {
        const a = componentFactory('<b data-bind-text="x"></b>', 'component a', render, {});
        const b = componentFactory('<b data-bind-text="x"></b>', 'component b', render, {});
        expect(a.bindings[0].id).not.toBe(b.bindings[0].id);
    });
});
```

Import `componentFactory` from `./template-compiler.js` and `render` from `./render.js` at the top if absent.

- [ ] **Step 2: Run and watch it fail**

Run: `npx vitest run src/template-compiler.test.js`
Expected: FAIL - `componentFactory is not a function`.

- [ ] **Step 3: Implement**

In `src/template-compiler.js`, refactor so both entry points share one body. Replace the body of `buildFactory` with a call to a new shared function, and export the component entry point:

```javascript
/**
 * Compile template source into a factory the reconciler can clone from.
 *
 * Shared by `{{#each}}` block bodies and by component templates. The two differ
 * only in where the source came from and what the label says, and a second copy
 * of this would drift the moment either grew a compiler option.
 *
 * @param {string} source
 * @param {string} label
 * @param {Function} render
 * @param {Object} options
 * @param {string} idPrefix
 * @returns {Object} factory
 */
function factoryFrom(source, label, render, options, idPrefix) {
    const {annotated, bindings} = annotate(source, {
        ...options,
        itemForms: true,
        template: label,
        idPrefix
    });

    for (const b of bindings) b.positional = POSITIONAL.test(sourceOf(b));

    return {
        content: parseFragment(toSkeleton(annotated, bindings)),
        bindings,
        render,
        label,
        options,
        usesLength: bindings.some((b) => b.positional)
    };
}
```

Keep `buildFactory`'s existing partial-inside-a-keyed-block warning where it is, and have it delegate:

```javascript
function buildFactory(binding, render, options) {
    const label = `${options.template ? `${options.template} ` : ''}{{#each ${binding.expr}}}`;

    if (PARTIAL.test(binding.body)) {
        console.warn(
            `${PREFIX} {{> partial}} inside a keyed {{#each}} is not expanded - ` +
            `the block body is compiled once into a <template>, before any render ` +
            `pass exists to resolve a partial against. Inline it, in ${label}`
        );
    }

    return factoryFrom(binding.body, label, render, options, `i${++factorySeq}:`);
}

/**
 * A component's template, compiled once and cloned per instance.
 *
 * Same machinery as a keyed block body, and for the same reason - an instance
 * owns its effects, so it needs its own copy of the binding records.
 *
 * @param {string} source
 * @param {string} label
 * @param {Function} render
 * @param {Object} options
 * @returns {Object} factory
 */
export function componentFactory(source, label, render, options) {
    return factoryFrom(source, label, render, options, `c${++factorySeq}:`);
}
```

Preserve `usesLength`'s original meaning if the existing code computed it differently - read the lines after the current `return {` in `buildFactory` before replacing them, and keep that expression rather than the one above if it differs.

- [ ] **Step 4: Run the whole suite**

Run: `npm run test:run`
Expected: PASS. The `each` tests exercise `buildFactory` heavily; if any fail, the refactor changed behaviour and must be corrected rather than the tests.

- [ ] **Step 5: Commit**

```bash
git add src/template-compiler.js src/template-compiler.test.js
git commit -m "refactor: share one factory builder between each-bodies and components

A component template needs exactly what a keyed block body needs - annotate,
skeletonise, parse to a fragment, one set of binding records per instance. The
two entry points now differ only in their source, their label and their id
prefix."
```

---

### Task 5: Let a caller supply the instance context

**Files:**
- Modify: `src/reconciler.js`
- Test: `src/reconciler.test.js`

`createInstance` builds `createChildContext(parentContext, item, index, length)`. A component needs `createComponentContext(parentContext, viewModel)` instead.

- [ ] **Step 1: Write the failing test**

Append to `src/reconciler.test.js`:

```javascript
import {componentFactory} from './template-compiler.js';
import {createComponentContext, createRootContext} from './context.js';
import {render} from './render.js';

it('uses a caller-supplied context when one is given', () => {
    const factory = componentFactory('<b data-bind-text="label"></b>', 'test', render, {});
    const vm = {label: 'ada'};

    const instance = createInstance(factory, createRootContext({}), vm, null, null, {
        context: createComponentContext(createRootContext({}), vm)
    });

    expect(instance.runtime.context().$component).toBe(vm);
    expect(instance.runtime.context().$data).toBe(vm);
    instance.dispose();
});
```

`componentFactory` is the entry point Task 4 added, which is why this task follows it.

- [ ] **Step 2: Run and watch it fail**

Run: `npx vitest run src/reconciler.test.js`
Expected: FAIL - `$component` is `null`, because the supplied context was ignored.

- [ ] **Step 3: Implement**

Change the signature and the one line that builds the context:

```javascript
export function createInstance(factory, parentContext, item, index, length, options = {}) {
```

```javascript
        context: options.context ?? createChildContext(parentContext, item, index, length),
```

Nothing else changes. `reconcile` calls it with five arguments and keeps its behaviour exactly.

- [ ] **Step 4: Run the whole suite**

Run: `npm run test:run`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/reconciler.js src/reconciler.test.js
git commit -m "feat: let createInstance take a caller-supplied context

A component instance is a list item in every respect except which context it
resolves against. One optional argument, and lists are untouched."
```

---

### Task 6: Mount a component

**Files:**
- Modify: `src/components.js`
- Modify: `src/template-compiler.js`
- Modify: `src/components.test.js`

- [ ] **Step 1: Write the failing tests**

Append to `src/components.test.js`. Add a `mount` helper first - every remaining test uses it:

```javascript
import {compile} from './template-compiler.js';
import {flushSync} from './graph.js';

/** Compile markup against data in a live host, reactively. */
function mount(markup, data) {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const controller = compile(markup, data, host, undefined, {reactive: true});
    return {host, controller};
}

describe('mounting', () => {
    it('renders a template-only component, with params as $data', () => {
        registerComponent('probe', {template: '<b data-bind-text="label"></b>'});

        const {host} = mount(`<div data-component="'probe'" data-param-label="who"></div>`, {who: 'Ada'});

        expect(host.querySelector('b').textContent).toBe('Ada');
    });

    it('renders a component with a view model', () => {
        registerComponent('probe', {
            template: '<b data-bind-text="shouted.value"></b>',
            create: (params) => ({shouted: observable(params.label.toUpperCase())})
        });

        const {host} = mount(`<div data-component="'probe'" data-param-label="who"></div>`, {who: 'Ada'});

        expect(host.querySelector('b').textContent).toBe('ADA');
    });

    it('gives the view model the host element as info.element', () => {
        let seen = null;
        registerComponent('probe', {
            template: '<b></b>',
            create: (params, info) => { seen = info.element; return {}; }
        });

        const {host} = mount(`<div id="slot" data-component="'probe'"></div>`, {});

        expect(seen).toBe(host.querySelector('#slot'));
        expect(seen.querySelector('b')).not.toBeNull();   // mounted inside its element
    });

    it('writes back to the parent through an observable param', () => {
        const name = observable('Ada');
        registerComponent('probe', {
            template: '<b></b>',
            create: (params) => { params.name.value = 'Grace'; return {}; }
        });

        mount(`<div data-component="'probe'" data-param-name="who"></div>`, {who: name});

        expect(name.value).toBe('Grace');
    });

    it('resolves $component inside a nested each in the component template', () => {
        registerComponent('probe', {
            template: '<ul data-each="rows key=id"><li data-bind-text="$component.title"></li></ul>',
            create: () => ({title: 'T', rows: [{id: 1}, {id: 2}]})
        });

        const {host} = mount(`<div data-component="'probe'"></div>`, {});
        flushSync();

        expect([...host.querySelectorAll('li')].map((li) => li.textContent)).toEqual(['T', 'T']);
    });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `npx vitest run src/components.test.js`
Expected: FAIL - nothing renders; there is no `component` binding kind yet.

- [ ] **Step 3: Implement the handler**

Add to `src/components.js`, importing what it needs:

```javascript
import {createInstance} from './reconciler.js';
import {registerBinding} from './handlers.js';
import {createComponentContext} from './context.js';
import {registerDisposer} from './lifecycle.js';

/** host element → what is mounted inside it. */
const states = new WeakMap();

/**
 * Build the view model, or fall back to the params when there is no `create`.
 *
 * A template-only component reads its params unqualified, which is what makes
 * the trivial case trivial. Anything that throws in `create` takes that instance
 * and nothing else - one warning, an empty host, and the rest of the page
 * carries on.
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

/** View model first, then the instance. The other way round loses the reference. */
function teardown(state) {
    if (state.instance === null) return;

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
                    state = {name: null, instance: null, viewModel: null};
                    states.set(element, state);
                    registerDisposer(element, () => teardown(state));
                }

                // Same component, already mounted: an unrelated update ran, and
                // rebuilding would throw away the instance's state for nothing.
                if (state.name === name && state.instance !== null) continue;

                teardown(state);
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

                // createInstance leaves its nodes in a fragment, anchors included.
                element.append(...state.instance.allNodes());
            }

            return true;
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
```

Nothing needs exporting from `reconciler.js` beyond what Task 5 already changed: `place()` orders instances after a region anchor, and this mounts into an element instead.

- [ ] **Step 4: Wire the factory builder**

At the bottom of `src/template-compiler.js`, beside the existing `registerEachHandler(eachFactory)`:

```javascript
const componentFactories = new WeakMap();

/** Compile once per definition, then clone per instance. */
function factoryForComponent(definition, name, render, options) {
    let factory = componentFactories.get(definition);
    if (factory === undefined) {
        factory = componentFactory(definition.template, `component ${name}`, render, options);
        componentFactories.set(definition, factory);
    }
    return factory;
}

registerComponentHandler(factoryForComponent);
```

Import `registerComponentHandler` from `./components.js`.

- [ ] **Step 5: Run**

Run: `npm run test:run`
Expected: PASS, including the five new mounting tests.

- [ ] **Step 6: Commit**

```bash
git add src/components.js src/template-compiler.js src/components.test.js
git commit -m "feat: mount components through data-component

A component instance is a reconciler instance with a component context: cloned
template, own effects, anchored region, node-scoped disposal. The handler takes
its factory builder by injection, as the each handler does, so this module
never learns that a template compiler exists.

No create() means template-only, with params as \$data."
```

---

### Task 7: Disposal, and swapping on a dynamic name

**Files:**
- Modify: `src/components.test.js`

The implementation is already in Task 6; these tests prove it and will catch the leaks that make a component model worthless.

- [ ] **Step 1: Write the failing tests**

```javascript
import {liveDisposers} from './lifecycle.js';

describe('lifecycle', () => {
    it('calls dispose() on the view model when the component goes away', () => {
        const disposed = vi.fn();
        registerComponent('probe', {template: '<b></b>', create: () => ({dispose: disposed})});

        const {controller} = mount(`<div data-component="'probe'"></div>`, {});
        controller.destroy();

        expect(disposed).toHaveBeenCalledOnce();
    });

    it('swaps the component when the name changes, disposing the old one exactly once', () => {
        const goneA = vi.fn();
        registerComponent('probe', {template: '<b>A</b>', create: () => ({dispose: goneA})});
        registerComponent('probe-b', {template: '<i>B</i>'});

        const which = observable('probe');
        const {host} = mount(`<div data-component="which.value"></div>`, {which});
        expect(host.querySelector('b')).not.toBeNull();

        which.value = 'probe-b';
        flushSync();

        expect(host.querySelector('b')).toBeNull();
        expect(host.querySelector('i').textContent).toBe('B');
        expect(goneA).toHaveBeenCalledOnce();

        unregisterComponent('probe-b');
    });

    it('does not rebuild when an unrelated update runs and the name is unchanged', () => {
        const created = vi.fn(() => ({}));
        registerComponent('probe', {template: '<b></b>', create: created});

        const which = observable('probe');
        mount(`<div data-component="which.value"></div>`, {which});

        which.value = 'probe';
        flushSync();

        expect(created).toHaveBeenCalledOnce();
    });

    it('leaves no disposers behind after teardown', () => {
        const before = liveDisposers();
        registerComponent('probe', {template: '<b data-bind-text="x.value"></b>', create: () => ({x: observable(1)})});

        const {controller} = mount(`<div data-component="'probe'"></div>`, {});
        controller.destroy();

        expect(liveDisposers()).toBe(before);
    });

    it('keeps its instance when a sibling row is removed from an enclosing list', () => {
        registerComponent('probe', {template: '<b data-bind-text="$data.id"></b>'});

        const rows = observableArray([{id: 1}, {id: 2}]);
        const {host} = mount(
            `<ul data-each="rows key=id"><li><div data-component="'probe'" data-params="$data"></div></li></ul>`,
            {rows}
        );
        flushSync();

        const first = host.querySelector('b');
        rows.remove((r) => r.id === 2);
        flushSync();

        expect(host.querySelector('b')).toBe(first);
    });
});
```

Import `observableArray` at the top of the file.

- [ ] **Step 2: Run**

Run: `npx vitest run src/components.test.js`
Expected: the swap and no-rebuild tests should pass from Task 6's implementation. If `liveDisposers()` does not return to baseline, the `registerDisposer` on `region.open` is not being run - check that `teardown` is registered once per region and that `controller.destroy()` reaches `disposeSubtree`.

- [ ] **Step 3: Fix whatever failed, then run the whole suite**

Run: `npm run test:run`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/components.test.js src/components.js
git commit -m "test: component disposal, swapping and leak checks

liveDisposers() returning to baseline is the test that matters - a component
model that leaks effects when its region closes is worse than no component
model, and the DOM looks correct either way."
```

---

### Task 8: The failure table

**Files:**
- Modify: `src/components.test.js`

Every row of the spec's failure table gets a test. The behaviour is implemented; this proves each warns exactly once and takes nothing else down with it.

- [ ] **Step 1: Write the tests**

```javascript
describe('failure is never fatal', () => {
    beforeEach(() => resetComponentWarnings());

    it('warns once for an unknown component and leaves the region empty', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const {host} = mount(`<div data-component="'nope'"></div><p>after</p>`, {});

        expect(warn).toHaveBeenCalledOnce();
        expect(warn.mock.calls[0][0]).toContain('nope');
        expect(host.querySelector('p').textContent).toBe('after');
    });

    it('warns once when the name is not a string', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        mount(`<div data-component="n"></div>`, {n: 42});
        expect(warn).toHaveBeenCalledOnce();
    });

    it('warns once when create() throws, and renders nothing', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        registerComponent('probe', {template: '<b>x</b>', create: () => { throw new Error('boom'); }});

        const {host} = mount(`<div data-component="'probe'"></div>`, {});

        expect(warn).toHaveBeenCalledOnce();
        expect(host.querySelector('b')).toBeNull();
    });

    it('warns but completes teardown when dispose() throws', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        registerComponent('probe', {
            template: '<b>x</b>',
            create: () => ({dispose() { throw new Error('boom'); }})
        });

        const {controller, host} = mount(`<div data-component="'probe'"></div>`, {});
        expect(() => controller.destroy()).not.toThrow();

        expect(warn).toHaveBeenCalled();
        expect(host.querySelector('b')).toBeNull();
    });

    it('warns once for data-param-* with no data-component', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        mount(`<div data-param-a="x"></div>`, {x: 1});
        expect(warn).toHaveBeenCalledOnce();
    });
});
```

- [ ] **Step 2: Run and implement the last row**

Run: `npx vitest run src/components.test.js`

The final test will fail: nothing currently notices `data-param-*` on an element with no `data-component`. Add a compile-time check. The cheapest correct place is `annotate` in `template-compiler.js`, where every attribute is already being walked - when an element carries a `data-param-` attribute and no `data-component`, warn once naming the attribute and the template.

- [ ] **Step 3: Run the whole suite**

Run: `npm run test:run`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/components.js src/components.test.js src/template-compiler.js
git commit -m "test: every row of the component failure table

Plus the one behaviour that was only specified: data-param-* with no
data-component now warns, because it is otherwise indistinguishable from a
typo in the component attribute and fails completely silently."
```

---

### Task 9: Public exports

**Files:**
- Modify: `src/index.js`
- Modify: `scripts/verify-dist.mjs`
- Modify: `src/index.test.js`

- [ ] **Step 1: Write the failing test**

In `src/index.test.js`, add both names to the `SURFACE` array (declared at the top of the file, currently 31 entries, alphabetical within its grouping) and add the import they are checked against:

```javascript
import {registerComponent, unregisterComponent} from './components.js';
```

```javascript
    'observable', 'observableArray', 'parseExpression', 'registerBinding',
    'registerComponent',
    'registerExtender', 'registerHelper', 'renderTemplate',
    'scanBlocks', 'trackingProxy', 'unregisterBinding', 'unregisterComponent',
    'unregisterExtender',
    'unregisterHelper', 'untracked'
```

- [ ] **Step 2: Run and watch it fail**

Run: `npx vitest run src/index.test.js`
Expected: FAIL - the names are not exported.

- [ ] **Step 3: Implement**

In `src/index.js`, beside the other registration exports, with a comment in the register of its neighbours explaining what a component is and what it deliberately is not:

```javascript
export {registerComponent, unregisterComponent} from './components.js';
```

In `scripts/verify-dist.mjs`, add both names to `EXPECTED`.

- [ ] **Step 4: Verify through all three module systems**

Run: `npm run test:dist`
Expected: PASS - build, then all 33 exports resolving through `require()`, `import()` and `<script>`.

- [ ] **Step 5: Commit**

```bash
git add src/index.js src/index.test.js scripts/verify-dist.mjs
git commit -m "feat: export registerComponent and unregisterComponent

Thirty-three names, verified through require(), import() and a script tag."
```

---

### Task 10: Full verification before documenting

- [ ] **Step 1: Run everything**

```bash
npm run test:run
npm run test:dist
```

Expected: all tests pass; dist verification passes.

- [ ] **Step 2: Measure the bundle, because the README will state it**

```bash
npm run build
gzip -c dist/domma-reactive.min.js | wc -c
stat -c%s dist/domma-reactive.min.js dist/domma-reactive.esm.js
```

Record the three numbers. They go into the README in Task 11, and the last time they were left stale they drifted twenty per cent.

- [ ] **Step 3: Commit nothing** - this task produces figures, not changes.

---

### Task 11: README

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Write the `## Components` section**

Place it after `## Keyed lists`. Cover, with runnable examples: `registerComponent` and both definition shapes; both param spellings and the merge rule; the by-reference table from the spec; `$component`; dynamic names and swapping; disposal; and the failure table. Match the surrounding prose - explain *why*, not only *what*.

- [ ] **Step 2: Update everything that referred to components as absent**

- `## Contents` - add Components.
- The migration table - `component:` / `ko.components` moves from **not yet** to the real spelling. `$parents[2]` stays **not yet**.
- `## Limits and non-goals` - components come out of the two-gaps paragraph, leaving `$parents[n]`. Add slots as the remaining component gap, with the `buildFactory` compile-once reasoning already written in the spec.
- `## What it does` - add a components item, with a line of proof like the other seven.
- `## What it isn't` - remove "no component model" from the list. It was flagged when that section was written as the first thing needing revisiting if components landed.
- The API reference - add both names, and change "Thirty-one names" to "Thirty-three names".
- The install table and the opening size line - the three figures from Task 10.

- [ ] **Step 3: Check every anchor still resolves**

```bash
grep -oE '\]\(#[a-z0-9-]+\)' README.md | sed 's/](#//; s/)//' | sort -u > /tmp/used.txt
grep -E '^#{1,4} ' README.md | sed -E 's/^#+ //' | tr 'A-Z' 'a-z' | sed -E 's/[^a-z0-9 -]//g; s/ +/-/g' | sort -u > /tmp/have.txt
comm -23 /tmp/used.txt /tmp/have.txt
```

Expected: no output.

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs: document components"
```

---

### Task 12: Tutorial

**Files:**
- Modify: `Tutorial.md`
- Modify: `src/tutorial.test.js`

The tutorial's promise is that its code runs, and `src/tutorial.test.js` transcribes it rather than paraphrasing it. Both move together or neither does.

- [ ] **Step 1: Write the transcribed test first**

In `src/tutorial.test.js`, extend `MARKUP` and the view model with a `contact-card` component that replaces the row body, and assert the behaviours the new step will claim: the card renders each contact, editing in place still works through the component, and removing a contact disposes exactly one card.

- [ ] **Step 2: Run and watch it fail**

Run: `npx vitest run src/tutorial.test.js`
Expected: FAIL - the component is not registered by the tutorial's `app.js` yet.

- [ ] **Step 3: Write the tutorial step**

A new `## Step 11 - make the row a component`, in the voice of the existing steps, with a `### What just happened`. The row is the right demonstration: it already has an item context, a two-way `data-model`, and an edit-in-place flag that wants to be private to the row rather than held on the list - which is the argument for a component making itself.

Update `## The finished files` so both listings match the test exactly.

- [ ] **Step 4: Verify the transcription is faithful**

Read `Tutorial.md`'s `### index.html` and `### app.js` against `MARKUP` and the view model in `src/tutorial.test.js`, line by line. A paraphrase here is the exact rot the test exists to prevent.

- [ ] **Step 5: Run the whole suite**

Run: `npm run test:run`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add Tutorial.md src/tutorial.test.js
git commit -m "docs: add a components step to the tutorial, transcribed into its test"
```

---

### Task 13: Changelog, and release 0.7.0

**Files:**
- Modify: `CHANGELOG.md`
- Modify: `package.json`, `package-lock.json` (via `make bump`)

The release process is scripted and its order matters. `preflight` runs *after* the bump is
committed, because it checks the version about to be published rather than the last one. npm will
not reuse a version number, so everything below is cheaper to get right now than after.

- [ ] **Step 1: Bump**

```bash
make bump V=0.7.0
```

Expected: `0.6.x → 0.7.0  (package.json, package-lock.json)`. It deliberately does not commit.

- [ ] **Step 2: Write the changelog entry**

`## [0.7.0] - YYYY-MM-DD` at the top of `CHANGELOG.md`, in the shape of the existing entries -
`### Added` / `### Changed`, prose that says why rather than only what. Cover `registerComponent`
and `unregisterComponent`, `data-component`, both param spellings and the merge rule, by-reference
versus by-value, `$component`, dynamic names and swapping, view-model `dispose()`, and the two
things still missing: slots and (if it has not shipped) `$parents[n]`.

- [ ] **Step 3: Commit the bump and the entry together**

```bash
git add package.json package-lock.json CHANGELOG.md
git commit -m "Release 0.7.0 - components"
```

The message should say what the release contains. A Makefile cannot write that, which is why
`bump` does not commit.

- [ ] **Step 4: Preflight**

```bash
make preflight
```

Expected: `preflight: clean, not behind origin, 0.7.0 unpublished, artefacts verified`, and
`all 33 exports verified across require(), import() and <script>`. Thirty-three, not thirty-one -
Task 9 added two. If it still says 31, `EXPECTED` in `scripts/verify-dist.mjs` was not updated.

- [ ] **Step 5: Re-measure the bundle and correct the README if it moved**

```bash
gzip -c dist/domma-reactive.min.js | wc -c
stat -c%s dist/domma-reactive.min.js dist/domma-reactive.esm.js
```

Components will grow the bundle. Nothing in the build asserts these figures - that is exactly how
they drifted 20% stale between 0.5.0 and 0.5.2 - so compare against the README's opening line and
its install table, and correct both if the rounded numbers changed. If they did, amend the release
commit rather than adding a second one, and run `make preflight` again.

- [ ] **Step 6: Publish, then tag - but ask first**

```bash
make release-npm    # publishes to npm; irreversible
make release-gh     # pushes main, creates and pushes the v0.7.0 tag
```

**Confirm with the author before `release-npm`.** A published version cannot be replaced, only
deprecated and superseded.

- [ ] **Step 7: Re-pin in the host**

```bash
cd ../domma && npm install domma-reactive@0.7.0 --save-exact && npm run build:js
```

Domma pins this package exactly, so a release is not finished until the host picks it up. The
Makefile's help text says the same.

## Out of scope

Per the spec, and each already documented as a gap:

- `$componentTemplateNodes` - slots and transclusion.
- Async or AMD template loading.
- `$parents[n]`.
