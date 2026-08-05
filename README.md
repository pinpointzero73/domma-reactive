# domma-reactive

Keep a page in step with your data, without a build step and without a framework. Change a value; the pieces of the page
that show it update, and nothing else does.

About **15 KB gzipped**, with **no dependencies** and **no `eval`**.

Under the surface: derivations discover at runtime which state they actually read, so a write re-runs exactly the work
that depends on it. Keyed lists *reconcile* — a row that stays in the collection keeps its actual DOM nodes, so its
focus, its half-typed input and its scroll position survive a change to the list around it.

The expression language is parsed by hand rather than compiled with the `Function` constructor, so bindings work under a
strict Content Security Policy — `script-src 'self'`, no `unsafe-eval`.

This is the reactive core of [Domma](https://github.com/pinpointzero73/domma), published separately so it can be used on
its own.

## Contents

- [Install](#install) · [Quick start](#quick-start) · [A complete small app](#a-complete-small-app)
- [Reactive core](#reactive-core) — [`observable`](#observable) · [`observableArray`](#observablearray) ·
  [`computed`](#computed) · [`effect`](#effect) · [`subscribe`](#subscribe) · [Batching](#batching-and-flushsync) ·
  [Disposal](#disposal)
- [Template bindings](#template-bindings) — [the nine kinds](#nine-binding-kinds) ·
  [`data-on-*`](#data-on-event) · [`data-bind-*`](#data-bind-name) · [`data-model`](#data-model) · [`data-if`](#data-if) ·
  [custom bindings](#custom-bindings) · [binding context](#binding-context)
- [Keyed lists](#keyed-lists) · [`applyBindings`](#applybindingsdata-rootelement) · [The renderer](#the-renderer) ·
  [Expressions](#expressions)
- [API reference](#api-reference) · [Coming from Knockout](#coming-from-knockout) ·
  [Things that will catch you](#things-that-will-catch-you) · [Limits and non-goals](#limits-and-non-goals)

## Install

```bash
npm install domma-reactive
```

```javascript
import {observable, computed, effect} from 'domma-reactive';        // ESM
const {observable} = require('domma-reactive');                     // CommonJS
```

Or as a plain script — the UMD bundle exposes the global `DommaReactive`:

```html
<script src="node_modules/domma-reactive/dist/domma-reactive.min.js"></script>
<script>
    const count = DommaReactive.observable(0);
</script>
```

| File | Format | Size |
|------|--------|------|
| `dist/domma-reactive.min.js` | UMD, minified — `browser`, `<script>` | 44 KB, **15 KB gzipped** |
| `dist/domma-reactive.cjs` | UMD — `require()` | 44 KB |
| `dist/domma-reactive.esm.js` | ES module, unminified — `import` | 235 KB (comments intact; your bundler minifies) |

The reactive core (`observable`, `computed`, `effect`, expressions, contexts, the renderer) needs **no DOM** and runs in
Node or a worker. Only the compiler functions touch `document`, and only when called.

## Quick start

```javascript
import {observable, computed, effect} from 'domma-reactive';

const price = observable(10);
const qty   = observable(3);

const total = computed(() => price.value * qty.value);

effect(() => console.log('total is', total.value));   // logs "total is 30"

qty.value = 4;                                        // logs "total is 40" on the next microtask
```

Wire it to a page with `applyBindings`, which activates binding attributes on HTML that already exists:

```html
<div id="app">
    <input type="number" data-model="qty.value">
    <p data-bind-text="total.value"></p>
</div>
```

```javascript
import {applyBindings} from 'domma-reactive';

applyBindings({price, qty, total}, document.querySelector('#app'));
```

Every binding gets its own effect, so typing in the input updates the paragraph and nothing else on the page is touched.

## A complete small app

Everything below is one working application, built from nothing but the public API. It is the shape of the smallest app
anyone actually writes: a list you add to, tick off, and delete from, with a derived summary and an empty state. This
exact code is a test in the repository (`src/apply-bindings.test.js`), so it is verified rather than illustrative.

```html
<div id="app">
    <input data-model="draft.value" placeholder="What needs doing?">
    <button data-on-click="add()">Add</button>

    <ul data-each="todos key=id">
        <li>
            <input type="checkbox" data-model="done.value">
            <span data-bind-class="done.value && 'struck'" data-bind-text="title"></span>
            <button data-on-click="$parent.remove($data)">×</button>
        </li>
    </ul>

    <p data-if="todos.length === 0">Nothing to do.</p>
    <p data-bind-text="summary.value"></p>
</div>
```

```javascript
import {applyBindings, observable, observableArray, computed} from 'domma-reactive';

const todos = observableArray([]);
const draft = observable('');
let nextId  = 1;

const app = {
    todos,
    draft,

    summary: computed(() => {
        const all = todos.value;
        return `${all.filter(t => !t.done.value).length} of ${all.length} left`;
    }),

    add() {
        if (draft.value.trim() === '') return;
        todos.push({id: nextId++, title: draft.value.trim(), done: observable(false)});
        draft.value = '';
    },

    remove(item) {
        todos.remove(item);
    }
};

const handle = applyBindings(app, document.querySelector('#app'));

// When the page or component goes away:
// handle.dispose();
```

Five things in there are worth pointing at:

- **`done: observable(false)`, not `done: false`.** A plain property on an item is not reactive. `observableArray`
  tracks the array — pushes, removes, reorders — not the fields inside its items. Make a field observable and it
  updates; leave it plain and ticking the box changes nothing. This is the single most common early surprise.
- **`$parent.remove($data)`** is how a row reaches the list that owns it. Inside a list `$data` is the *item*, so a bare
  `remove` would be looked for on the item and not found. This is the one place an expression may call a method — see
  [`data-on-<event>`](#data-on-event).
- **`key=id` is not optional for `data-each`.** With it, deleting the second row leaves the first row's actual DOM node
  in place, focus and all. Without it, `applyBindings` refuses the block and says so.
- **`.value` everywhere.** There is no unwrapping magic: an observable is read and written through `.value`, in
  JavaScript and in a template alike, so the two never disagree about what a name means.
- **`data-bind-text`, not `{{ }}`.** `applyBindings` deliberately does not interpolate mustache in DOM that already
  exists — [see why](#-in-already-rendered-dom-is-not-interpolated).

If you own the markup rather than the page, [`compile()`](#template-bindings) takes a template string instead and gives
you `{{ }}`, `{{#if}}` and `{{#each}}` as well.

## Reactive core

### `observable`

```javascript
const count = observable(0);

count.value;              // 0 — tracked: registers a dependency
count.value = 5;          // write
count.set(5);             // the same write, as a call
count.peek();             // read WITHOUT registering a dependency
count.subscribe(fn);      // see below
```

`peek()` and `set()` are closures, not methods, so they survive being destructured off the observable or handed straight
to a callback.

The `equals` comparator gates **notification, not the write**. A write always lands; the graph only hears about it when
the comparator reports a change, so a comparator that deliberately ignores part of the payload can never leave readers
serving stale data:

```javascript
const user = observable({id: 1, seenAt: 0}, {equals: (a, b) => a.id === b.id});
```

The default is deep equality. The corollary of gating at all: **mutating the held value in place and assigning it back
is invisible**, because old and new are the same reference. Derivations must produce new values, not edit old ones.

### `observableArray`

```javascript
const rows = observableArray([{id: 1}]);

rows.value;               // the underlying array — tracked
rows.length;              // tracked, so a rendered count updates
rows.peek();              // the live array, untracked
rows.value = [...];       // wholesale replacement — gated by `equals`

rows.push(item);          // and pop, shift, unshift, splice, sort, reverse, fill, copyWithin
rows.remove(item);        // every occurrence of that exact object
rows.remove(r => r.id > 2);   // every item the test accepts
rows.removeAll();
```

The in-place mutators run the native method and return exactly what it returns, so `pop()` gives you the item and
`splice()` gives you the removed slice.

**Two write paths, two rules, deliberately.** Mutators notify *unconditionally* — an in-place mutation leaves the array
equal to itself, so an equality gate could only be implemented by holding a copy and diffing it, at a full pass over the list per push.
Wholesale assignment *is* gated, exactly as `observable()` is. The accepted cost is a spurious notification from a
mutator that changed nothing (a no-op `sort()`), which errs towards notifying too often — the safe direction.

The initial array, and any array assigned wholesale, is **copied rather than adopted**. Holding your reference would
alias it: a push through the original would change what `.value` returns without ever reaching the graph, and the data
and the DOM would disagree silently and permanently. If you genuinely want the live array, take it from `peek()`.

`remove()` takes **either a value or a test**. A value matches by identity, which is what a reconciled list wants —
`$parent.remove($data)` hands over the very object the row was rendered from. A function is called with `(item, index)`
and everything it accepts goes.

The one case this gives up is an array of bare functions removing one of its own members by passing it; `peek()` plus
`splice()` still covers that.

### `computed`

```javascript
const total = computed(() => price.value * qty.value);

total.value;              // recompute if stale, then return — and register a dependency
total.get();              // identical; `.value` is the form a template can use
```

Computeds are **lazy**: the body runs on first read and then only when something it read has changed. Dependencies are
re-collected on every run, so a computed whose branch changed (`mode.value === 'a' ? x.value : y.value`) stops depending
on the branch not taken.

Prefer `.value`. It is the only spelling a template can use — an expression cannot call a method — and it means an
observable and a computed look the same at the point of use.

### `effect`

```javascript
const stop = effect(() => {
    document.title = `${unread.value} unread`;
});

stop.dispose();
```

An effect runs **immediately**, so its dependencies are collected up front, and re-runs on the microtask flush after any
of them changes. It sits at the leaves of the graph: nothing depends on an effect.

`untracked(fn)` suspends collection for the duration of `fn`, which is how an effect reads something it must not
subscribe to:

```javascript
effect(() => {
    const rows = list.value;                       // tracked
    untracked(() => analytics.send(rows.length));  // not
});
```

### `subscribe`

```javascript
const off = count.subscribe(value => console.log('now', value));

count.value = 1;   // logs immediately — no flush needed
off();             // or off.dispose(), for Knockout muscle memory
```

Subscribers fire **synchronously, at the write**, not on the flush that follows. You subscribed to a value, not to a
graph settling — so `count.value = 5` followed by an assertion about the callback needs no flush.

They are not `Computation`s, so a hundred subscriptions do not put a hundred nodes in the dependency graph. They follow
the same change gate: assigning a deeply equal value notifies nobody, and array mutators notify unconditionally.

A subscriber that throws is reported and skipped — one bad callback must not turn a write into an exception at an
unrelated call site.

### Batching and `flushSync`

Writes never recompute anything synchronously. They mark computations dirty, queue them, and schedule **one** microtask
flush, so a burst of writes collapses into a single propagation pass and a single render:

```javascript
first.value = 'Ada';
last.value  = 'Lovelace';
age.value   = 36;
// → one flush, one re-render
```

`flushSync()` drains the queue immediately and synchronously. It is what a test uses to assert on the DOM without
awaiting a microtask:

```javascript
import {flushSync} from 'domma-reactive';

rows.push({id: 2});
flushSync();
expect(host.querySelectorAll('li')).toHaveLength(2);
```

### Disposal

An effect is a live node in the dependency graph, and dropping the DOM does not drop it. Every entry point returns
something to tear down with, and **you must call it**:

| Created by | Torn down by |
|------------|--------------|
| `effect(fn)` | `.dispose()` on the returned `Computation` |
| `compile(…)` | `controller.destroy()` |
| `applyBindings(…)` | `handle.dispose()` |
| `observable.subscribe(fn)` | the returned `off()`, or `off.dispose()` |

`handle.dispose()` drops every effect, listener, list instance and marker it created, restores a hidden `data-if`
element, and leaves the markup as it found it. Both are safe to call twice.

## Template bindings

`compile()` turns a mustache template into a set of *fine-grained* bindings, each owning a small region of the DOM. A
structural change re-renders only the block that changed — everything else keeps its node identity, so focus, scroll
position and unsaved input survive.

```javascript
import {compile} from 'domma-reactive';

const host = document.querySelector('#out');

const controller = compile('<p>Hello {{name}}</p>', {name: 'Ada'}, host);
//  → <p>Hello <span data-dm-t="0_txt">Ada</span></p>

controller.updateAll({name: 'Grace'});   // only the span is touched
```

`compile(template, data, container, renderFn?, options?)`. Pass `{reactive: true}` and every binding gets its own
effect, collected from what it actually reads:

```javascript
const name = observable('alice');
const controller = compile('<b data-bind-text="name.value"></b>', {name}, host, undefined, {reactive: true});

name.value = 'bob';   // the <b> follows, with nothing else to do
```

It is off by default because Domma wires its own. A standalone consumer almost certainly wants it on. Either way,
**list items always own their effects** — nothing else is in a position to.

The controller:

| | |
|---|---|
| `bindings` | the binding records, each with `id`, `kind`, `expr`, `deps` |
| `deps(id)` | the root names one binding reads — how you subscribe an effect to exactly the right state |
| `update(id, data)` | re-run one binding |
| `updateAll(data)` | re-run all of them |
| `context()` | the binding context in force |
| `destroy()` | tear everything down |

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
<button data-on-click="$parent.remove($data)">Delete</button>
```

Your declared arguments come first and the **event is always the last argument**, so a handler that wants only the event
and one that wants arguments are spelled the same way round. Returning `false` calls `preventDefault()`.

The callee is resolved against your data, not against the helper registry — an event handler is a method on your data,
and the evaluator is right to refuse to call one during a render.

**A method call is allowed here and nowhere else.** Inside a list `$data` is the item, and a bare name resolves against
`$data` only, so `$parent.remove($data)` is how a row reaches the list that owns it. Everywhere else — `{{ }}`,
`data-if`, `data-bind-*` — `x.foo()` is still a parse error, because those are reads that run inside an effect and a
call during a read is a side effect. An event fires on a gesture, outside every effect.

`this` follows JavaScript's own rule, which is easier to remember than any rule this library could invent:

| Expression             | `this`     | Why                                     |
|------------------------|------------|-----------------------------------------|
| `save`                 | `$data`    | a reference; no receiver was named      |
| `save(x)`              | `$data`    | a bare callee is a name on `$data`      |
| `handlers.save`        | `$data`    | still a reference — nothing is called   |
| `handlers.save()`      | `handlers` | a method call keeps its receiver        |

The last two are exactly `const f = o.m; f()` versus `o.m()`.

The method name is read through the same guard as every other property read, so `$data.constructor()` is refused for the
same reason `{{ $data.constructor }}` is.

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

**There is no `data-bind-html`.** Assigning `innerHTML` from data is the shortest route to a cross-site scripting (XSS)
hole, and the template
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

**Without `key=` the block falls back to re-rendering wholesale** and says so once, naming the template. Nothing breaks;
it simply costs you node identity. Pass `{warnUnkeyed: false}` in the compiler options to silence it.

### What works inside a keyed block

Everything. Each item gets its own binding context and its own effects:

```html
{{#each rows key=id}}
    <li data-bind-class="done && 'complete'">
        <input data-model="title">
        <button data-on-click="$parent.remove($data)">×</button>
        {{#if note}}<small>{{note}}</small>{{/if}}
        {{#each tags key=id}}<span>{{$parent.title}}/{{name}}</span>{{/each}}
    </li>
{{/each}}
```

`$parent.remove($data)` calls `remove` on the parent view model with the clicked row as its argument. That is the one
place a method call is permitted in an expression — see [`data-on-<event>`](#data-on-event).

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

### Deferred: minimal moves

Placement is **in order**. That is correct for append, prepend, insert, remove and reorder, and it performs more DOM
moves than strictly necessary — reversing n items costs n moves rather than n-1, and dragging one item from the end to
the front costs n rather than 1. The refinement is longest-increasing-subsequence move minimisation — an algorithm that works out the smallest set
of moves that will do. Nothing about
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
    <input data-model="query.value" value="rendered by the server">
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

Note `data-model="query.value"`, not `data-model="query"` — `query` holds an observable, and the
[no-unwrapping rule](#data-model) applies in a binding exactly as it does in JavaScript. Binding the bare name would
show `[object Object]` in the input and replace the observable on the first keystroke.

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
one gets exactly that. **The parameter is optional**, and the default is `renderTemplate`, exported so you can use it on
its own:

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

The first four rows are cases Domma's renderer does not handle correctly and this one does, so a template that works
under Domma works here. **The reverse is not guaranteed** — an expression or a nested same-kind block written against
this renderer will not survive a move to `utils.render`.

### Expressions in `{{ }}`, and what the compiler binds

A `{{ }}` becomes a live `text` binding when it is a dotted path, or when it contains unambiguous operator syntax and
parses. `{{.}}`, `{{@index}}` and `{{helper arg}}` are left to the renderer, and never warn.

`-` and `+` count as operators only with whitespace around them, so `{{first-name}}` reads a kebab-case key and
`{{ a - b }}` is arithmetic.

An expression interpolation is evaluated once immediately after the first paint, because the injected renderer may not
understand it. `data-bind-*`, `data-model` and `data-if` are primed the same way, for the same reason: there is no
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
interpolations and the default renderer all evaluate through it.

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
| Context       | `$data`, `$root`, `$parent`, `$index`, `$length` |

Precedence and associativity are JavaScript's. `1 + 2 * 3` is 7; `10 - 3 - 2` is 5. Nesting is capped at 64 levels.

### What it does not support, and will not

Assignment. `new`. Member calls — `user.toUpperCase()` does not work, and neither does `alert(1)`; the only callable
things are helpers you registered. (`data-on-*` is the single exception, and only because an event fires outside every
effect — see [`data-on-<event>`](#data-on-event).) Loose equality (`==`), nullish coalescing (`??`), regular expressions,
object and array literals, template literals, comma sequences. Reads of `__proto__`, `constructor` and `prototype`, in
any form — including `a[key]` where `key` holds `'__proto__'` at runtime.

Most of those are recognised specifically so they can be refused with a message that says what to do instead. Anything
more complicated than the grammar above belongs in a `computed`, not in a template.

### Failure is never fatal

A malformed expression logs one warning naming the source (and the template, if you passed `{template: 'user-card'}`)
and yields `null` from `parseExpression` / `undefined` from `evaluateExpression`. An evaluation error — a helper that
threw, a nesting depth beyond 64 — does the same. Nothing in this module throws on expression input, so one bad binding
cannot blank a page.

The exception is `registerHelper`, which throws a `TypeError` on a bad name or a non-function. That is a bug in your
code, not input, and it should be loud.

### It runs under a strict Content Security Policy

There is no `eval` and no `Function` constructor anywhere in the package — asserted against the source in the unit
suite and against all three built bundles in `npm run test:dist`. Bindings therefore work under
`script-src 'self'` without `unsafe-eval`.

## API reference

Twenty-nine names. Anything not listed here is an internal detail and may change without a major version bump.

**State**

| Name | Signature |
|------|-----------|
| `observable` | `(initial, {equals?}) → {value, peek(), set(v), subscribe(fn)}` |
| `observableArray` | `(initial?, {equals?}) → {value, length, peek(), set(a), remove(valueOrTest), removeAll(), subscribe(fn), …mutators}` |
| `isEqual` | `(a, b) → boolean` — the deep comparison the change gate uses |

**Graph**

| Name | Signature |
|------|-----------|
| `computed` | `(fn, {label?}) → Computation` — read via `.value` or `.get()` |
| `effect` | `(fn, {label?}) → Computation` — runs immediately; `.dispose()` to stop |
| `untracked` | `(fn) → any` — run `fn` with dependency collection suspended |
| `flushSync` | `() → void` — drain the pending queue now, synchronously |
| `Dep` | class — one reactive slot; `track()`, `trigger()` |
| `DepMap` | class — lazily-populated keyed collection of `Dep`s |
| `Computation` | class — the node type behind `computed` and `effect` |
| `trackingProxy` | `(target, depFor, {onSet?}) → Proxy` — wrap a host store's data so reads are tracked |

**Bindings**

| Name | Signature |
|------|-----------|
| `compile` | `(template, data, container, renderFn?, options?) → controller` |
| `applyBindings` | `(data, rootElement) → handle` |
| `annotate` | `(template, options?) → {annotated, bindings}` — string-only; no DOM needed |
| `scanBlocks` | `(template) → block records` — string-only |
| `TemplateCompiler` | the above grouped as an object, plus `resolvePath` |
| `registerBinding` | `(name, handler) → handler` |
| `unregisterBinding` | `(name) → boolean` |
| `createRootContext` | `(data) → context` |
| `createChildContext` | `(parent, data, index?, length?) → context` |

**Expressions and rendering**

| Name | Signature |
|------|-----------|
| `parseExpression` | `(source, options?) → AST \| null` |
| `evaluateAst` | `(ast, context) → any` |
| `evaluateExpression` | `(source, context, options?) → any` |
| `compileExpression` | `(source, options?) → (context) => any \| null` |
| `expressionDependencies` | `(sourceOrAst, options?) → Set<string>` |
| `registerHelper` | `(name, fn) → fn` — throws on a bad name |
| `unregisterHelper` | `(name) → boolean` |
| `clearExpressionCache` | `() → number` — entries dropped |
| `renderTemplate` | `(template, data, {partials?}) → string` |

## Coming from Knockout

The concepts map closely; the spellings do not. Nothing here is a drop-in replacement, and the differences are
deliberate rather than incidental.

| Knockout | domma-reactive |
|----------|----------------|
| `ko.observable(1)` — read `o()`, write `o(2)` | `observable(1)` — read `o.value`, write `o.value = 2` |
| `ko.observableArray([])` | `observableArray([])` — `remove()` takes a value or a test, as Knockout's does |
| `ko.computed(fn)` / `ko.pureComputed(fn)` | `computed(fn)` — always lazy |
| `ko.applyBindings(vm, el)` | `applyBindings(vm, el)` |
| `ko.cleanNode(el)` | `handle.dispose()` |
| `data-bind="text: name"` | `data-bind-text="name"` |
| `data-bind="css: {on: isActive}"` | `data-bind-class="isActive && 'on'"` |
| `data-bind="value: query"` | `data-model="query"` |
| `data-bind="click: save"` | `data-on-click="save"` |
| `data-bind="if: isOpen"` | `data-if="isOpen"` |
| `data-bind="foreach: rows"` | `data-each="rows key=id"`, or `{{#each rows key=id}}` |
| `$data` `$root` `$parent` `$index` | identical |
| `$parents[2]` | **not available** — `$parent` reaches one level |
| `ko.utils.unwrapObservable(x)` | **none** — read `.value` explicitly |
| `sub.dispose()` | `off()` or `off.dispose()` |

The three differences worth knowing before you start:

- **Reads are properties, not calls.** `o.value`, never `o()`. That is what lets a template read an observable at all,
  since the expression language refuses method calls.
- **`key=` is how lists reconcile.** Knockout's `foreach` diffs by identity automatically; here you name the key, and
  `data-each` insists on one.
- **No `unsafe-eval` required.** Knockout compiles binding strings with the `Function` constructor, which a strict
  Content Security Policy blocks outright. This parses them instead.

## Things that will catch you

Every one of these was hit while building the example app above.

| Symptom | Cause | Fix |
|---------|-------|-----|
| Ticking a checkbox changes nothing | A plain field on a list item is not reactive | `done: observable(false)`, and bind `done.value` |
| `{{name}}` renders literally | `applyBindings` never interpolates mustache | `data-bind-text="name"` |
| `data-each` renders nothing, with a warning | No `key=` | `data-each="rows key=id"` |
| `{{total.get()}}` will not parse | An expression cannot call a method | `total.value`, which is the same read |
| A binding is silently skipped | Its expression did not parse; look for the warning | The warning names the source and the template |
| Effects keep running after the DOM is gone | Nothing disposed them | `handle.dispose()` / `controller.destroy()` |
| Mutating an object and reassigning it does nothing | The change gate compares old and new — the same reference | Produce a new value |

Nothing in the binding layer throws on bad input. Every failure above logs exactly one warning, naming the expression
and the template, and skips that binding alone — one broken binding does not take the rest of the page down with it.

## Limits and non-goals

This is a reactivity and binding layer. It is **not** a framework: there is no router, no component model, no
lifecycle hooks, no server-side-rendering hydration beyond `applyBindings`, and no devtools.

Deliberate omissions, each with its reasoning above: no scope-chain lookup, no `$parents[n]`, no `data-bind-html`, no
observable unwrapping, no `eval`-backed expressions, and no minimal-move list reconciliation yet.

## Development

```bash
npm test           # watch
npm run test:run   # once — 676 tests
npm run build      # dist/
npm run test:dist  # verify all 29 exports through require(), import() and <script>
```

## Licence

MIT.
