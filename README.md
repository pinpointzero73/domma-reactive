# domma-reactive

Dependency-tracked reactivity: derivations discover which state they actually read, so a write re-runs exactly the work
that depends on it. On top of that, a fine-grained DOM binding layer — mustache blocks, `data-*` behaviour bindings, an
extensible binding registry and a CSP-safe expression language, with no `eval` and no `Function` constructor anywhere.

This is the reactive core of [Domma](https://github.com/pinpointzero73/domma), published separately so it can be used on
its own.

## Install

```bash
npm install domma-reactive
```

## Use

```javascript
import {observable, computed, effect} from 'domma-reactive';

const price = observable(10);
const qty   = observable(3);

const total = computed(() => price.value * qty.value);

effect(() => console.log('total is', total.get()));

qty.value = 4;   // effect re-runs on the next microtask
```

Updates are batched: several writes in one tick produce a single re-run.

### `subscribe`

```javascript
const count = observable(0);

const off = count.subscribe((value) => console.log('now', value));

count.value = 1;   // logs immediately — no flush needed
off();             // or off.dispose(), for Knockout muscle memory
```

Subscribers fire **synchronously, at the write**, not on the flush that follows. You subscribed to a value, not to a
graph settling. They are not `Computation`s, so a hundred subscriptions do not put a hundred nodes in the dependency
graph.

They follow the same change gate the graph does: assigning a deeply equal value notifies nobody. `observableArray`
mutators notify unconditionally, because an in-place mutation leaves the array equal to itself.

## Template bindings

The package ships a binding compiler that turns a mustache template into a set of *fine-grained* bindings, each owning a
small region of the DOM. A structural change re-renders only the block that changed — everything else keeps its node
identity, so focus, scroll position and unsaved input survive.

```javascript
import {compile} from 'domma-reactive';

const host = document.querySelector('#out');

const controller = compile('<p>Hello {{name}}</p>', {name: 'Ada'}, host);
//  → <p>Hello <span data-dm-t="0_txt">Ada</span></p>

controller.updateAll({name: 'Grace'});   // only the span is touched
```

Wire it to the graph by giving each binding its own effect:

```javascript
import {compile, observable, effect} from 'domma-reactive';

const name = observable('alice');
const controller = compile('<b>{{name}}</b>', {name: name.value}, host);

for (const binding of controller.bindings) {
    effect(() => controller.update(binding.id, {name: name.value}));
}

name.value = 'bob';   // only the <b> is touched
```

`controller.deps(id)` gives the root names a binding reads, which is what lets you subscribe an effect to exactly the
right state rather than re-rendering wholesale.

Or let the compiler wire them for you:

```javascript
const name = observable('alice');
const controller = compile('<b data-bind-text="name.value"></b>', {name}, host, undefined, {reactive: true});

name.value = 'bob';   // the <b> follows, with nothing else to do
```

`{reactive: true}` gives every binding its own effect, collected from what it actually reads. It is off by default
because Domma wires its own; a standalone consumer almost certainly wants it on. Either way, **list items always own
their effects** — nothing else is in a position to.

Call `controller.destroy()` when the markup goes away.

### Nine binding kinds

Five come from mustache syntax:

| Kind    | Template                       | Updated by                              |
|---------|--------------------------------|-----------------------------------------|
| `text`  | `{{name}}`                     | `textContent` on a `<span>` anchor       |
| `attr`  | `class="{{cls}}"`              | `setAttribute` on the owning element     |
| `block` | `{{#if x}}…{{/if}}`            | re-rendering a comment-delimited region  |
| `raw`   | `{{{html}}}`                   | re-rendering a comment-delimited region  |
| `each`  | `{{#each xs key=id}}…{{/each}}`| **reconciling**, per item — see below    |

Four come from `data-*` attributes. Attributes rather than `{{ }}` because `{{ }}` produces a *string*, and events and
two-way binding need a reference to a DOM element that survives rendering:

| Attribute          | Purpose                        | Example                              |
|--------------------|--------------------------------|--------------------------------------|
| `data-on-<event>`  | event binding, any DOM event   | `data-on-click="save"`               |
| `data-bind-<name>` | one-way to a property or attribute | `data-bind-text="user.name"`     |
| `data-model`       | **two-way**, control ↔ data    | `data-model="query"`                 |
| `data-if`          | conditional without a block    | `data-if="isOpen"`                   |

Every value on the right is an [expression](#expressions), not just a path.

### `data-on-<event>`

The expression is either a reference that evaluates to a function, or a call:

```html
<button data-on-click="save">Save</button>
<button data-on-click="remove(item, 2)">Delete</button>
```

Your declared arguments come first and the **event is always the last argument**, so a handler that wants only the event
and one that wants arguments are spelled the same way round. `this` is `$data`. Returning `false` calls
`preventDefault()`.

The callee of the call form is resolved against your data, not against the helper registry — an event handler is a
method on your data, and the evaluator is right to refuse to call one during a render.

Event bindings declare **no dependencies**: the listener is attached once and reads the context at dispatch time, so
there is nothing for an effect to re-run.

### `data-bind-<name>`

The suffix is the target:

| Suffix                                  | Effect                                                           |
|-----------------------------------------|------------------------------------------------------------------|
| `text`                                  | `textContent`                                                    |
| `class`                                 | adds/removes only the tokens this binding applied last time      |
| `value` `checked` `disabled` `readonly` `required` `selected` `multiple` `indeterminate` `open` `hidden` | the DOM **property** |
| anything else                           | an attribute of that name                                        |

For an attribute, `false` / `null` / `undefined` **removes** it and `true` sets it to the empty string, so
`data-bind-aria-hidden="collapsed"` behaves the way you would expect rather than rendering the string `"false"`.

`data-bind-class` is additive on purpose. `el.className = value` would delete every static class on the element, so the
handler remembers the tokens it applied and swaps only those:

```html
<p class="card" data-bind-class="isActive && 'on'"></p>
```

A falsy value contributes no classes at all, which is what makes that idiom work — `isActive && 'on'` is `false`, not
`''`, when it is off.

**There is no `data-bind-html`.** Assigning `innerHTML` from data is the shortest route to an XSS hole, and the template
already has an explicit, greppable opt-out for it: `{{{triple-stache}}}`. Using the attribute logs one warning and
writes nothing.

### `data-model`

Two-way. The expression must be a **settable path** — a bare name, or a member chain ending in one:

```html
<input data-model="query">
<input data-model="user.email">
<input data-model="rows[i]">
```

At write time the object part is evaluated and the last step is used as a key, so the write lands where the read came
from. Anything that is not a path (a comparison, a helper call, `$data`/`$root`/`$parent`/`$index`) logs one warning and
writes nothing, because a binding you cannot write through is not two-way. `__proto__`, `constructor` and `prototype`
are refused as keys, in every form, including `a[k]` where `k` holds one of them at runtime.

There is **no observable-unwrapping magic**. A tracking proxy is written as `data-model="name"`; a standalone observable
is written as `data-model="count.value"`, which is the same `.value` you read it through. Both are ordinary property
assignments:

```javascript
const count = observable(0);
compile('<input type="number" data-model="count.value">', {count}, host);
```

| Control            | Property                      | Listened events   |
|--------------------|-------------------------------|-------------------|
| checkbox           | `checked` (boolean)           | `change`          |
| radio              | `checked`, against its value  | `change`          |
| `select[multiple]` | an array of selected values   | `change`          |
| `select`           | `value`                       | `change`          |
| `number`, `range`  | `value` coerced to a Number, empty → `null` | `input`, `change` |
| everything else    | `value`                       | `input`, `change` |

An unchecked radio writes nothing, so the group's value is not cleared by the sibling that lost the selection. The
data → DOM direction writes only when the value actually differs, so re-rendering while someone is typing does not move
their caret.

### `data-if`

The element is in the DOM, or it is not — it is not hidden with CSS. A binding named after a conditional that leaves the
element focusable and read by a screen reader would be lying; use `data-bind-hidden` if that is what you want.

```html
<div data-if="isOpen">…</div>
```

Truthiness is mustache truthiness, so an **empty array is falsy** and `{{#if items}}` and `data-if="items"` cannot
disagree. Toggling re-renders the element rather than stashing and restoring it, so bindings inside it can never go
stale — at the cost of node identity across a toggle, exactly as `{{#if}}` has always behaved.

### Custom bindings

`registerBinding()` adds a kind. It is not a side door: **all eight built-ins are registered through this exact
function**, so anything a built-in does, a custom binding can do.

```javascript
import {registerBinding, compile} from 'domma-reactive';

registerBinding('shout', {
    attribute: 'data-shout',   // or attributePrefix: 'data-shout-'
    expression: true,          // parse the value; binding.evaluate is set
    tracks: true,              // contribute the expression's deps
    primes: true,              // run update() once after the first paint
    update({binding, nodes, context}) {
        const value = String(binding.evaluate(context) ?? '');
        for (const el of nodes) el.textContent = value.toUpperCase() + '!';
        return true;
    }
});

compile('<p data-shout="name"></p>', {name: 'ada'}, host);   // → <p>ADA!</p>
```

`update` is required; `attach({binding, node, controller})` and `detach(…)` are optional and are what `data-on-*` and
`data-model` use to add and remove listeners. `region: true` wraps the owning element in comment anchors and fills
`binding.body`, which is how `data-if` works. Register before compiling — a template already compiled does not pick up
a new kind. The full contract is documented at the top of `src/handlers.js`.

The one thing a custom binding cannot do is invent `{{ }}` syntax: mustache is a fixed grammar, attributes are
open-ended. Every handler is otherwise the same shape and dispatched by the same call.

### Binding context

Expressions resolve against a context, not a bare data object:

| Name      | Meaning                                              |
|-----------|------------------------------------------------------|
| `$data`   | the object names resolve against                     |
| `$root`   | the top-level data, however deep the nesting         |
| `$parent` | the enclosing **data** (not the enclosing context)    |
| `$index`  | position within a list                               |
| `$length` | size of the enclosing list                            |

All five resolve everywhere. Outside a list or `with` block, `$data` and `$root` are the top-level data, and `$parent`,
`$index` and `$length` are `null` — so a binding never has to ask where it is. Pass plain data anywhere a context is
accepted and it is promoted for you.

```javascript
import {createRootContext, createChildContext} from 'domma-reactive';

const root  = createRootContext({title: 'People'});
const child = createChildContext(root, {name: 'Ada'}, 0);

child.$parent.title;   // 'People'
child.$index;          // 0
```

There is no scope-chain walk: a bare name resolves against `$data` only. Reach a level up with `$parent.name`, which
says what it means.

### Known limits

Bindings inside an **unkeyed** `{{#each}}`, and inside `{{#with}}`, are not bound independently — the block re-renders as
a whole, and a behaviour binding inside one is skipped with a warning naming the attribute. Add `key=` and every one of
them works; see [Keyed lists](#keyed-lists).

`{{> partial}}` inside a keyed block is not expanded. The block body is compiled once into a `<template>`, before any
render pass exists to resolve a partial against. Inline it, and the compiler says so if you do not.

There is no `$parents[2]`: `$parent` reaches one level up, and no further.

## Keyed lists

`{{#each items key=id}}` **reconciles**. An item that stays in the collection keeps its DOM nodes and its effects across
any change to the list, so focus, half-typed input, scroll position, CSS transitions and media playback all survive.

```javascript
const data = {rows: [{id: 1, name: 'Ada'}, {id: 2, name: 'Grace'}]};

const controller = compile(
    '<ul>{{#each rows key=id}}<li>{{$index}}: {{name}}</li>{{/each}}</ul>',
    data, host
);

data.rows = [{id: 3, name: 'Katherine'}, ...data.rows];
controller.updateAll(data);
//  Ada's <li> is the same node object it was before. It was moved, not rebuilt.
```

`key=` names the property that identifies an item; a dotted path (`key=meta.ref`) works too. It must be an identity, not
a value — a key that changes when the item's *contents* change defeats the whole mechanism.

**Without `key=` the block falls back to re-rendering wholesale** and says so once, naming the template. That is the
Tier 3 behaviour every template written before this milestone relies on, so nothing breaks; it simply costs you node
identity. Pass `{warnUnkeyed: false}` in the compiler options to silence it.

### What works inside a keyed block

Everything. Each item gets its own binding context and its own effects:

```html
{{#each rows key=id}}
    <li data-bind-class="done && 'complete'">
        <input data-model="title">
        <button data-on-click="$root.remove">×</button>
        {{#if note}}<small>{{note}}</small>{{/if}}
        {{#each tags key=id}}<span>{{$parent.title}}/{{name}}</span>{{/each}}
    </li>
{{/each}}
```

An event binding's `this` is `$data` — the item — so `$root.remove` above receives the row it was clicked on as `this`.

The renderer's loop variables (`{{.}}`, `{{@index}}`, `{{@first}}`, `{{@last}}`) resolve inside a keyed block too, so
adding `key=` to an existing block never silently blanks anything.

### One place `key=` is refused

A keyed block **inside an unkeyed `{{#each}}` or a `{{#with}}`** is demoted to an ordinary re-rendered block, with a
warning. Its collection expression would otherwise be evaluated against the top-level data, where the name means
nothing, and the list would render empty on a page that looks finished.

Add `key=` to the *enclosing* block and both reconcile — nesting keyed lists inside keyed lists is fully supported, to
any depth.

### Lifecycle

Each item is an *instance*: a pair of comment anchors, the nodes between them, a context, and one effect per binding.
An instance is disposed — **effects first, then nodes** — when its key leaves the collection, when an enclosing region
re-renders over it, or when the controller is destroyed.

**Call `controller.destroy()`.** A list's effects are live nodes in the dependency graph and dropping the DOM does not
drop them.

### Deferred: minimal moves

Placement is **in order**. That is correct for append, prepend, insert, remove and reorder, and it performs more DOM
moves than strictly necessary — reversing n items costs n moves rather than n-1, and dragging one item from the end to
the front costs n rather than 1. The refinement is longest-increasing-subsequence move minimisation. Nothing about
correctness or node identity depends on it: an instance that is moved is the same instance, with the same nodes and the
same effects.

## `applyBindings(data, rootElement)`

The other direction from `compile()`. Point it at HTML that already exists — server-rendered, hand-written, whatever —
and it activates the binding attributes in place, leaving the markup otherwise as it found it. No build step, no second
source of truth for the markup.

```html
<div id="app">
    <h1 data-bind-text="title">Rendered by the server</h1>
    <button data-on-click="save">Save</button>
    <input data-model="query" value="rendered by the server">
    <p data-if="showHelp">Help text.</p>
    <ul data-each="rows key=id">
        <li data-bind-text="name">template row</li>
    </ul>
</div>
```

```javascript
import {applyBindings, observable, observableArray} from 'domma-reactive';

const handle = applyBindings({
    title: 'Live',
    query: observable(''),
    showHelp: false,
    rows: observableArray([{id: 1, name: 'Ada'}]),
    save() { /* … */ }
}, document.querySelector('#app'));
```

Every binding gets its own effect, so a view model built from observables updates itself. For a plain, untracked object,
`handle.update(data)` re-runs everything.

| | |
|---|---|
| **Returns** | `{bindings, context(), update(data), dispose()}` |
| **Idempotent** | applying twice skips elements already bound and warns once, naming the root |
| **Disposable** | `dispose()` drops every effect, listener, list instance and marker it created, restores a hidden `data-if` element, and leaves the markup as it was found |

### `{{ }}` in already-rendered DOM is not interpolated

Deliberately, and it says so once if it finds a token that looks like a binding.

There is nothing coherent to do with it. Either the server rendered the value — in which case the token is gone and
there is only text that happens to say "Ada" — or the server emitted the raw token, in which case the page was broken
until JavaScript ran, which is the thing server rendering exists to avoid. Guessing which text nodes are dynamic is not
possible, and rewriting every text node into anchored spans would mutate, destructively, the markup this function
promises to leave alone.

`data-bind-text="expr"` is the supported spelling. It is explicit, greppable, and the server can render the text and the
attribute together.

The one exception is the contents of a `data-each`, which are a *template* rather than rendered output: they are lifted
out of the document, compiled and cloned per item, so mustache works there because there it means something.

### `data-if` here detaches; in a template it re-renders

`applyBindings` implements `data-if` by removing the element and putting **the same node** back, so it keeps its
children, its listeners and its focus across a toggle. `compile()` cannot do that — while an element is detached, the
bindings inside it are invisible to re-indexing, so it would come back stale — and re-renders its region instead. This
is the one place the two entry points differ in behaviour rather than in input.

A custom binding declaring `region: true` is refused by `applyBindings`, with an explanation: a region handler
re-renders from a captured template body, and here the markup *is* the page.

## The renderer

`compile(template, data, container, renderFn)` still takes the mustache renderer as a parameter, and a caller who passes
one gets exactly that. **The parameter is optional.** It used to be mandatory, which meant that after
`npm install domma-reactive` this threw `renderFn is not a function`:

```javascript
compile('<p>{{name}}</p>', {name: 'Ada'}, host);
```

It now renders. The default is `renderTemplate`, which is exported so you can use it on its own:

```javascript
import {renderTemplate} from 'domma-reactive';

renderTemplate('{{#each xs}}<li>{{name}}</li>{{/each}}', {xs: [{name: 'a'}]});
renderTemplate('{{> row}}', {n: 1}, {partials: {row: '<i>{{n}}</i>'}});
```

It supports `{{x}}`, `{{{x}}}`, `{{#if}}` / `{{else}}`, `{{#unless}}`, `{{#each}}`, `{{#with}}`, `{{> partial}}`,
`{{.}}`, `{{@index}}`, `{{@first}}`, `{{@last}}` and `{{! comments }}`. Interpolations escape; triple-staches do not.

### Divergences from Domma's `utils.render`

Domma passes its own `utils.render` and is unaffected by any of this. But the two are **not** identical, and the
differences below were verified against `utils.render` at Domma v0.33.1 rather than assumed:

| Case | Domma's `utils.render` | `renderTemplate` |
|------|------------------------|------------------|
| Same-kind nesting — `{{#each}}` inside `{{#each}}` | matches the *inner* `{{/each}}`, producing broken output | counts depth; correct |
| `{{else}}` inside a nested `{{#if}}` | binds to the outer block | binds to its own block |
| `{{.}}` over a list of primitives | `[object Object]` | the item |
| Expressions — `{{ n > 1 ? 'many' : 'one' }}` | empty | evaluated |
| `{{#if n > 2}}` | always falsy | evaluated |
| `{{helper arg}}` (space-separated) | calls a registered helper | **not supported** — renders empty, no warning. Use `helper(arg)` |
| Escaping, missing values, `{{#each}}` item scope, `{{@index}}`, `{{#with}}`, kebab-case keys | | identical |

The first four rows are cases where Domma's renderer is broken and this one is not, so a template that works under
Domma works here. **The reverse is not guaranteed** — an expression or a nested same-kind block written against this
renderer will not survive a move to `utils.render`.

### Expressions in `{{ }}`, and what the compiler binds

A `{{ }}` becomes a live `text` binding when it is a dotted path, or when it contains unambiguous operator syntax and
parses. `{{.}}`, `{{@index}}` and `{{helper arg}}` are left to the renderer, and never warn.

`-` and `+` count as operators only with whitespace around them, so `{{first-name}}` reads a kebab-case key and
`{{ a - b }}` is arithmetic.

An expression interpolation is evaluated once immediately after the first paint, because the injected renderer may not
understand it — which is how `{{ n > 1 ? 'many' : 'one' }}` renders correctly even under a renderer that only
substitutes paths. `data-bind-*`, `data-model` and `data-if` are primed the same way, for the same reason: there is no
`{{ }}` token in an attribute for a renderer to substitute.

`{{{raw}}}` and `class="{{cls}}"` still go through the renderer and still accept dotted paths only. Use `data-bind-*`
for an expression-valued attribute.

## Expressions

Bindings need more than a dotted path, so the package ships a small expression language — parsed by hand, never by the
`Function` constructor.

```javascript
import {compileExpression, registerHelper} from 'domma-reactive';

registerHelper('upper', s => String(s).toUpperCase());

const evaluate = compileExpression("count > 0 ? upper(label) : 'none'");

evaluate({count: 3, label: 'items'});   // 'ITEMS'
evaluate({count: 0, label: 'items'});   // 'none'
```

`compileExpression` parses once and returns a function; call that per update. It returns `null` if the source does not
parse, so a caller can skip the binding rather than render a lie.

This is the engine every binding runs on: `data-bind-*`, `data-model`, `data-if`, `data-on-*`, non-path `{{ }}`
interpolations and the default renderer all evaluate through it. The other six entry points are `parseExpression`
(source → AST, or `null`), `evaluateAst` (AST → value), `evaluateExpression` (source → value in one call),
`expressionDependencies` (which names an expression reads), `unregisterHelper` and `clearExpressionCache`.

`expressionDependencies` is what lets you wire one effect per binding without guessing:

```javascript
expressionDependencies("label === 'name'");   // Set { 'label' } — not 'name'
expressionDependencies('user.profile.email'); // Set { 'user' }  — root names only
expressionDependencies('$parent.name');       // Set {} — position, not state
```

### What it supports

| Category      | Forms                                            |
|---------------|--------------------------------------------------|
| Paths         | `a`, `a.b.c`, `a[0]`, `a[key]`, `a['x']`         |
| Literals      | `'str'`, `"str"`, `1`, `1.5`, `1e3`, `true`, `false`, `null` |
| Arithmetic    | `+ - * / %` (`+` also concatenates)              |
| Comparison    | `=== !== < <= > >=`                              |
| Logical       | `&& \|\| !` — short-circuiting                    |
| Ternary       | `a ? b : c`                                      |
| Unary         | `- + !`                                          |
| Calls         | `helper(arg, …)` — **registered helpers only**   |
| Context       | `$data`, `$root`, `$parent`, `$index`            |

Precedence and associativity are JavaScript's. `1 + 2 * 3` is 7; `10 - 3 - 2` is 5.

### What it does not support, and will not

Assignment. `new`. Member calls — `user.toUpperCase()` does not work, and neither does `alert(1)`; the only callable
things are helpers you registered. Loose equality (`==`), nullish coalescing (`??`), regular expressions, object and
array literals, template literals, comma sequences. Reads of `__proto__`, `constructor` and `prototype`, in any form —
including `a[key]` where `key` holds `'__proto__'` at runtime.

Most of those are recognised specifically so they can be refused with a message that says what to do instead. Anything
more complicated than the grammar above belongs in a `computed`, not in a template.

There is no scope-chain walk: a bare name resolves against `$data` only. Reach a level up with `$parent.name`, which
says what it means.

### Failure is never fatal

A malformed expression logs one warning naming the source (and the template, if you passed
`{template: 'user-card'}`) and yields `null` from `parseExpression` / `undefined` from `evaluateExpression`. An
evaluation error — a helper that threw, a nesting depth beyond 64 — does the same. Nothing in this module throws on
expression input, so one bad binding cannot blank a page.

The exception is `registerHelper`, which throws a `TypeError` on a bad name or a non-function. That is a bug in your
code, not input, and it should be loud.

### It runs under a strict CSP

There is no `eval` and no `Function` constructor anywhere in the package — asserted against the source in the unit
suite and against all three built bundles in `npm run test:dist`. Bindings therefore work under
`script-src 'self'` without `unsafe-eval`, which is where Knockout's expression evaluation stops working.

## Licence

MIT.
