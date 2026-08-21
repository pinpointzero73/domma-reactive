# Slots - design

**Status:** agreed, not implemented
**Date:** 2026-08-21
**Ships as:** 0.8.0
**Scope:** passing markup into a component from its usage site - a default slot, named slots, and
fallback content. Scoped slots are explicitly out; see [Out of scope](#out-of-scope).

## The obstacle that turned out not to be there

`README.md`, `CHANGELOG.md` and the components spec all say the same thing: slots are blocked
because a template is compiled once into a `<template>` before any render pass exists, which is the
same wall `{{> partial}}` meets inside a keyed block.

That is true of one implementation and only one: compiling the slot content into the component's
factory. It is not true of slots.

Slot content is written at the **usage site**. By the time a component mounts, that markup has
already been annotated and painted by the enclosing template, and its bindings are already wired to
the outer context. Nothing about it needs compiling again. Two properties of the existing code make
relocation safe:

- `indexRoots` (`nodes.js:167`) walks the full subtree with a `TreeWalker` and matches bindings to
  nodes by marker id, so a node stays indexed wherever it sits within the container.
- An effect holds a **direct node reference**, so moving a node does not break its binding.

Both were verified by experiment before this document was written: a `data-bind-text` node moved
into a different element - including one created after the fact - went on updating from the outer
observable.

So slots are not a compiler problem. They are a placement problem, and the component handler already
owns placement. The one line that has to change is the one that currently destroys the content:

```javascript
teardown(state);
element.replaceChildren();      // <- slot content dies here
```

**The documents named above are wrong and are corrected as part of this work.** What genuinely meets
the compile-once wall is *scoped* slots, which is why they are out of scope rather than deferred for
effort reasons.

## The design

### Two spellings

In the component's template, a sixth mustache block beside `if`, `unless`, `each` and `with`:

```javascript
registerComponent('card', {
    template: `
        <div class="card">
            <header>{{#slot header}}<h2>Untitled</h2>{{/slot}}</header>
            <div class="body">{{#slot}}{{/slot}}</div>
            <footer>
                {{#slot footer}}<button data-on-click="close">Close</button>{{/slot}}
            </footer>
        </div>`
});
```

At the usage site, a `data-slot` attribute names the destination. Anything unlabelled goes to the
default slot - including text nodes, which cannot carry an attribute and therefore always do. The
whitespace between labelled elements lands in the default slot too, which is harmless: HTML collapses
it, and a default slot that receives nothing but whitespace counts as empty for the purpose of
choosing fallback content.

```html
<div data-component="'card'">
    <h2 data-slot="header">Ada Lovelace</h2>
    <p>Mathematician.</p>
    <button data-slot="footer" data-on-click="save">Save</button>
</div>
```

`{{#slot}}` rather than an element because an element does not survive the HTML parser. Measured:

| Written | Parsed as |
|---|---|
| `<tr><dm-slot></dm-slot></tr>` | `<dm-slot></dm-slot><table>...` - **hoisted out of the table** |
| `<tbody><dm-slot></dm-slot></tbody>` | `<dm-slot></dm-slot><table>...` - **hoisted out** |
| `<select><dm-slot></dm-slot></select>` | `<select></select>` - **deleted** |
| `<tr><!--dm:slot--><!--/dm:slot--></tr>` | survives intact |

A table shell is exactly the kind of component slots exist for, so a spelling that cannot sit inside
`<tbody>` is not a spelling. A mustache block compiles to comment anchors, which survive anywhere -
the same reason `{{#each}}` already works inside a table. `data-slot` at the usage site is an
attribute on an element the author already has, so it has no such problem, and it works unchanged on
both the `compile()` and `applyBindings` paths.

### Fallback content

The block body is the fallback, used only when nothing is projected into that slot. This is what
Vue, Svelte and web components all do, and it comes free: the body is already compiled into the
factory.

**The two scopes differ, and that is the point.** Fallback content resolves against the **component's**
view model, because it was compiled with the component's template. Projected content resolves
against the **outer** context, because it was compiled with the page. One hole, two scopes, decided
by which of the two supplied the markup. This is the single thing most worth documenting clearly.

### Slot content binds to where it was written

There is no way for a component to inject values into its slot content. `data-bind-text="user.name"`
inside a component's host element reads the *page's* `user`, always.

This is Knockout's model and it is what parity requires. It also falls out of the implementation at
zero cost - the nodes are already bound to the outer context, so no work makes it true. A component
that needs to hand something outward takes a callback param:

```html
<div data-component="'list'" data-param-on-select="choose"></div>
```

## Architecture

`{{#slot}}` is **not a binding kind**. It compiles to inert comment anchors and creates no binding
record, no expression and no effect. The component handler finds the anchors in the instance it has
just built and fills them. The whole feature lives in `components.js` and the compiler; `handlers.js`
gains nothing and no new kind appears in the registry.

`indexRoots` already tolerates an unknown anchor id: it pairs the comments, looks the id up, finds no
binding and moves on. So the markers are invisible to every other layer.

### Data flow, per mount

```
host element's children
   |  harvest, keyed by data-slot; unlabelled -> default
slot map:  {default: [nodes...], header: [nodes...]}
   |  createInstance() clones the factory, fallbacks included
instance DOM containing <!--dm:slot:header-->fallback<!--/dm:slot:header-->
   |  fill: where the map has content, replace the fallback with it
mounted component
```

Harvested nodes are moved into a holding fragment. They are **detached, never disposed** - they
belong to the outer runtime.

### Files

| File | Change |
|---|---|
| `template-compiler.js` | `slot` joins `if\|unless\|each\|with` in `BLOCK_TOKEN`; emits anchors around the body and creates no binding |
| `components.js` | harvest, fill, re-harvest on teardown |
| `reconciler.js` | none |
| `handlers.js` | none |

## Ownership and lifecycle

**Slot nodes belong to the outer runtime.** The component relocates them and nothing else. On
teardown it **re-harvests** them back into the holding fragment *before* disposing the instance, so
a component swap carries the content into the replacement rather than destroying it.

The slot map is **retained in the binding's state** for the life of the mount, so re-harvesting is
not a search: it moves back exactly the nodes it placed, by reference. Nothing has to distinguish
projected content from component-generated content by inspection, which would be guesswork the moment
a component moved a node itself.

Order on teardown, extending what components already do:

1. re-harvest slot nodes out of the instance, back to the holding fragment
2. view model `dispose()`
3. instance runtime disposed
4. instance nodes removed

The holding fragment is dropped when the host element itself is disposed, at which point the outer
runtime's next `index()` finds those nodes gone and disposes their effects - the existing behaviour
for any node a region has closed over.

### Both render paths

`compile()`: the host's children are painted before the component binding primes, so they exist to
be harvested.

`applyBindings()`: verified against the real code rather than assumed. Pass 1 walks the tree and
collects into `work`; Pass 3 wires. The walk therefore completes before any handler runs, and
`wireClaim` binds by **element reference**, so a child relocated during Pass 3 still binds correctly
in its new position. `work` is in document order, which puts the component host before its children -
the order the projection needs.

## Failure is never fatal

As everywhere else: one warning naming the slot and the template, and nothing else is affected.

| Situation | Behaviour |
|---|---|
| `data-slot="x"` where the component has no slot `x` | warn once naming `x`, that content is left out |
| Two `{{#slot x}}` blocks with the same name in one template | warn once, the first wins, the second keeps its fallback |
| `{{#slot}}` used more than once (two default slots) | warn once, the first wins |
| A component with slot content but no `{{#slot}}` at all | warn once - the content would vanish silently otherwise |
| `{{#slot}}` with no closing `{{/slot}}` | the tokens survive into the output as literal text |
| Slot content on a component that fails to build | host left empty, content stays in the holding fragment, released on teardown |

An unclosed `{{#slot}}` is **not** slot-specific and is not fixed here: `scanBlocks` drops any
unmatched opening token, so an unclosed `{{#if}}` behaves identically today and has since the
compiler was written. Worth a warning; worth it as its own change, covering every block kind, rather
than smuggled in beside a feature.

Unmatched content keeps its bindings alive while detached, until the host is disposed. That is a
bounded cost on a path that has already warned, and the alternative - disposing effects the component
does not own - is worse.

## Testing

At the ratio this repository holds to, expect 350-500 test lines. The behaviours that must be
covered:

- default slot, named slots, and both together
- fallback rendered when nothing is projected; **not** rendered when something is
- fallback resolves against the component's view model
- projected content resolves against the **outer** context, and goes on updating after projection
- a projected `data-model` writes back to the page's observable
- `{{#slot}}` inside `<tbody>` places real `<tr>`s - the case an element spelling cannot do
- a swap carries slot content into the replacement, with the **same DOM nodes**
- a swap does not dispose the outer bindings on that content
- `liveDisposers()` and the live `Computation` count return to baseline after teardown
- a component with slots inside a keyed list: each row keeps its own content, and a sibling removal
  leaves the others' nodes identical
- a component nested inside another component's slot content
- both render paths, `compile()` and `applyBindings()`
- every row of the failure table, each warning fired exactly once

## Documentation is part of the deliverable

- **`README.md`** - a `## Slots` subsection under Components covering both spellings, fallback, the
  two-scopes rule and the failure table. The migration table's `$componentTemplateNodes` row moves
  from **not yet** to the real spelling. **Limits and non-goals loses the slots paragraph entirely**,
  which empties the Knockout gap list and completes the parity claim. The paragraph asserting the
  compile-once wall is deleted, not softened - it was wrong.
- **`Tutorial.md`** - the contact row already wants a slot. Step 11 passes deletion in as a callback
  param (`data-param-remove="$parent.remove"`) purely so the card can render a Delete button it does
  not own. As projected content the page writes that button itself, in the row context it is already
  in:

  ```html
  <li data-component="'contact-row'" data-param-contact="$data">
      <button data-slot="actions" data-on-click="$parent.remove($data)">Delete</button>
  </li>
  ```

  The callback param disappears, the card stops deciding what actions a row has, and the step
  demonstrates a slot on markup the reader already knows. Transcribed into `src/tutorial.test.js` as
  every other step is.
- **`CHANGELOG.md`** - an entry, including a correction noting that the wall described in 0.7.0's
  entry does not exist for slots as designed here.

## Out of scope

- **Scoped slots** - a component exposing values its slot content can read, as Vue's `v-slot` does.
  This is the one that genuinely meets the compile-once wall: the content would have to be compiled
  against a context that does not exist until mount. Knockout has no equivalent, so parity does not
  require it. The `{{#slot name}}` spelling leaves room for a later `bind=` argument, so nothing here
  forecloses it.
- **Async or AMD template loading.** Unchanged from 0.7.0: templates are strings.
