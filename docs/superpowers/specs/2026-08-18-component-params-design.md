# Component params — design

**Status:** agreed, not implemented
**Date:** 2026-08-18
**Scope:** how a component receives its inputs, and the minimum component shape that decision implies.
Slots (`$componentTemplateNodes`) and async template loading are explicitly out of scope; see
[Out of scope](#out-of-scope).

## Why this needed settling first

A component model was previously ruled out in `README.md` on the grounds that it is a framework
decision a host has already made. The goal has since been stated as **capability parity with
Knockout** — anything Knockout can do, this should be able to do — which makes components a gap
rather than a choice, and the README now says so.

Params were the blocker. Knockout spells them as an object literal:

```html
<div data-bind="component: {name: 'editor', params: {value: userName, mode: 'edit'}}"></div>
```

The expression language here refuses object literals, deliberately — that refusal is part of what
lets bindings parse without `eval` and run under `script-src 'self'`. So the spelling had to come
from somewhere else. It turns out it already exists.

## The precedent this follows

`data-bind-style` solved this exact problem, and `handlers.js` records why:

> `data-bind-style="look"` an object the view model already holds
> `data-bind-style-color="shade"` one property, named in the attribute
>
> The second is the common case, and it is the one Knockout makes awkward — a single colour there
> means inventing an object to carry it.

Params get the same pair, for the same reason. This is the third application of the pattern, after
`data-options-*` and `data-bind-style-*`.

## The design

### Spelling

```html
<!-- one param named in the attribute — the common case -->
<div data-component="'contact-card'"
     data-param-contact="$data"
     data-param-editable="canEdit"></div>

<!-- an object the view model already holds — many params, or inside a list -->
<div data-component="'contact-card'" data-params="cardParams"></div>
```

`data-param-` is an `attributePrefix` handler, so the remainder arrives as `binding.arg` through the
existing dispatch in `handlers.js:162–166`. No compiler change: adding a binding kind is a
`registerBinding()` call, exactly as `template-compiler.js:25` promises.

Both forms may appear together. They merge, and a name given in an attribute wins over the same key
in the object — the more specific spelling wins. A collision warns once per binding, keyed as
`warnOnce` already keys its messages, because it is almost always a mistake rather than an
intention; this follows `registerBinding`'s existing "replacing a built-in is allowed, but loud"
rule.

`data-param-*` on an element with no `data-component` is inert and warns once. It is otherwise
indistinguishable from a typo in the component attribute, which would leave the params silently
doing nothing.

### Casing

Kebab-case in the attribute, camelCase in the params object: `data-param-first-name` becomes
`params.firstName`. The reason is the one already written down for `data-bind-style-fontWeight` — an
HTML attribute name is lowercased by the parser, so a camelCase attribute cannot survive the round
trip. This is `cssProperty()` run in the opposite direction.

### The component name is an expression

`data-component` takes an expression, like every other binding value in the library. A literal name
is therefore written with inner quotes, as `data-bind-class="done.value && 'struck'"` already is.

The cost is one pair of quotes in the common case. What it buys is dynamic components at no extra
cost — `data-component="currentView.value"` swaps the rendered component when the observable
changes, which is how a great many Knockout applications route. Making this the one binding whose
value was not an expression would have bought slightly friendlier markup and cost both a special
case in the compiler and a documented exception to a rule the README currently states without one.

Changing the name disposes the existing instance — view model `dispose()`, then the instance
runtime, then `disposeSubtree` over the region — before building the replacement.

### Params pass by reference, and the markup says which

Nothing in the handler decides this. It falls out of reads being explicit:

| Markup | The view model receives | Can write back? |
|---|---|---|
| `data-param-contact="user.name"` | the observable itself | **yes** — the parent sees the write |
| `data-param-contact="user.name.value"` | a snapshot of the value | no |

Knockout needs a documented convention here and its users still get it wrong, because `params: {a:
x}` and `params: {a: x()}` look equally plausible at a glance. Here the two are different
expressions and the difference is the same `.value` the reader already knows.

### Params evaluate once, at instantiation

Each param expression is evaluated once, when the instance is created — a constructor argument, not
a live binding. Observables stay live because they are references; plain expressions are snapshots.
The `data-params` object form is evaluated once on the same terms: the expression runs once, and
the object it yields is read once.

"Once per instance", not once per element: a name change builds a new instance, so every param
expression is re-evaluated against the context in force at that moment.

The alternative, wrapping every param in a computed, was rejected: it would double-wrap the
reference case, so `params.contact` would be a computed *of* an observable, and the view model would
have to read `.value` on some params and not others with no way to tell which from its own code.

The params object is frozen. It is an input, not scratch space — the same reasoning that freezes a
binding context. Observables inside it remain writable through `.value`, which is the intended path.

### What a component is

```javascript
registerComponent('contact-card', {
    template: '<div class="card">…</div>',

    create(params, info) {
        const editing = observable(false);
        return {
            contact: params.contact,
            editing,
            save() { … },
            dispose() { /* optional */ }
        };
    }
});

// template-only — params become $data directly
registerComponent('badge', {template: '<b>{{label}}</b>'});
```

`create` is a plain factory: no `new`, no constructor form, no second `createViewModel` spelling. It
returns a view model object. If that object has a `dispose()`, it runs on teardown, before the
instance runtime is destroyed. There are no other lifecycle hooks — `dispose()` is the same contract
`handle.dispose()` and `controller.destroy()` already offer, and adding more would be inventing the
framework this package is not.

`info` is `{element}`, the host element. It gains `templateNodes` if and when slots are built.

A component with no `create` is template-only and its params become `$data`, so `{{label}}` in the
example above reads `params.label`. This keeps the trivial case trivial, which is where Knockout's
`viewModel`-or-constructor ambiguity does the most damage.

`unregisterComponent(name)` removes one, mirroring `unregisterBinding` and `unregisterExtender`.

### `$component`

A new context name, and the first addition to `CONTEXT_KEYS` since `$length`. It resolves to the
nearest enclosing component's view model, and — unlike `$parent` — is **inherited** by
`createChildContext`, exactly as `$root` is, so it still answers inside a list nested in a
component's template. `context.js` anticipates this: "it is an additive field on this object and
nothing else in the package changes."

It is `null` outside a component, so the rule that every context name resolves everywhere holds.

`createComponentContext` must also set `$parentContext` to the enclosing context, exactly as
`createChildContext` does, so `$parents` walks correctly across a component boundary. Both names
shipped in 0.6.0; see `2026-08-18-parents-and-parent-context-design.md`.

### Failure is never fatal

Consistent with every other binding: one warning, naming the expression and the template, and that
binding alone is skipped.

| Situation | Behaviour |
|---|---|
| Name expression does not parse | warn once, region left empty |
| Name evaluates to a non-string | warn once, region left empty |
| No component registered under that name | warn once naming the name, region left empty |
| A param expression does not parse | warn once, that param is absent from the object |
| `create()` throws | warn once, region left empty, no instance registered |
| `dispose()` throws | warn, teardown continues — as `disposeNode` already does |

## What this reuses

Almost all of it. The estimate that this is roughly a week of work rests on these already existing:

| Need | Exists as |
|---|---|
| Template string → cloneable factory | `buildFactory()`, `template-compiler.js:533` |
| Instantiate one, with its own effects and anchors | `createInstance()`, `reconciler.js` |
| Own and tear down per-instance effects | `createRuntime()`, `runtime.js:79` |
| Teardown when an ancestor removes the subtree | `lifecycle.js` |
| Child contexts | `context.js` |
| Dispatch, including `attributePrefix` | `registerBinding()`, `handlers.js` |

A keyed list item is already a component instance in everything but name: a cloned template, its own
child context, its own effects, an anchored region, and disposal that works when an ancestor removes
it without knowing it is there.

## Out of scope

- **`$componentTemplateNodes` (slots/transclusion).** `buildFactory` compiles a body once into a
  `<template>` before any render pass exists, which is the same constraint that makes
  `{{> partial}}` unsupported inside a keyed block (`template-compiler.js:546`). Slots meet the same
  wall and may force a change to how factories are built. Documented as a known gap, not attempted.
- **Async and AMD template loading.** Knockout supports it; this will not. Templates are strings or
  already-registered markup.
- **`$parents[n]`.** Unrelated to components, and separately listed as a gap.

## Documentation is part of the deliverable

Components are not finished when they pass their tests. Both documents that make a promise about
working code have to make it about components too, and both are on the test path — which is why
none of this can be written before the feature exists.

**`README.md`**

- A `## Components` section after [Keyed lists](#), covering both param spellings, the factory
  shape, `$component`, dynamic names, and disposal.
- Add it to the Contents list.
- The migration table: `component:` / `ko.components` moves from **not yet** to the real spelling.
- Limits and non-goals: components come out of the gap list; **slots stay**, restated as the one
  remaining piece.
- The opening: `## What it does` gains a components item, and `## What it isn't` loses "no component
  model" from its list — the line flagged when that section was written as the first thing needing
  revisiting if components landed.

**`Tutorial.md`**

- A new step extracting the contact row into a `contact-card` component, which is the natural
  demonstration: the row already has an item context, a two-way `data-model`, and an edit-in-place
  state that wants to be private to the row rather than held on the list.
- `## The finished files` updated to match.
- `src/tutorial.test.js` extended to transcribe it, exactly as it transcribes every other step. The
  tutorial is only allowed to claim what that file proves.

**`CHANGELOG.md`** — an entry, as every feature release has.

## Testing

At the ratio the repository already holds itself to (`reconciler.js`: 408 source, 1040 test), expect
roughly 600–900 test lines. The behaviours that must be covered:

- both spellings, separately and merged, including the collision warning
- kebab-to-camel conversion, including a single-word param and a three-word one
- an observable param written by the component and observed by the parent
- a `.value` param **not** observed by the parent
- a param that is a snapshot of an expression, unchanged when its inputs change
- dynamic name: swapping disposes the old view model exactly once and builds the new one
- `liveDisposers()` and the live `Computation` count both return to baseline after teardown
- a component inside a keyed list keeps its instance when a sibling is removed
- `$component` resolving inside a nested `{{#each}}` within a component template
- template-only component with params as `$data`
- every row of the failure table, each warning fired exactly once
