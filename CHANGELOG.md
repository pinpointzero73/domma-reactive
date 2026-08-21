# Changelog

All notable changes to `domma-reactive`.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Entries before 0.4.2 were reconstructed from the tag history and are summaries rather than
contemporaneous notes.

## [1.0.0] - 2026-08-21

The same code as 0.8.0, with a promise attached.

0.8.0 closed the last capability gap against Knockout. This release does not add to it; it declares
that the surface is stable. The version number is the only thing that changed, and that is
deliberate - a 1.0.0 that also changed behaviour would be asking you to trust a promise and absorb a
change at the same time.

### What 1.0.0 means

- **The thirty-three exported names are the public API.** Anything not in the README's API reference
  is an internal detail and may change in a minor release. That was already written down; it is now
  binding.
- **Breaking changes need a major version.** Removing an export, changing a signature, or changing
  what a binding does to working markup are all 2.0.0 events.
- **The binding spellings are settled.** `data-bind-text`, `data-model`, `data-each`, `{{#each}}`,
  `data-component`, `data-param-*`, `{{#slot}}`, `data-slot`, and the eight binding-context names.
  They differ from Knockout's on purpose and will go on differing.
- **The guarantees hold or it is a bug**: no `eval` and no `Function` constructor, so it runs under
  `script-src 'self'`; one broken binding never takes the page down; keyed lists preserve DOM node
  identity; and nothing in the binding layer throws on bad input.

### How it got here

| | |
|---|---|
| 0.5.x | the reactive core, bindings, keyed lists, `applyBindings` |
| 0.6.0 | `$parents[n]`, `$parentContext` |
| 0.7.0 | components |
| 0.8.0 | slots - capability parity complete |
| 1.0.0 | the same code, declared stable |

961 tests, 33 exports verified through `require()`, `import()` and a `<script>` tag, 20 KB gzipped,
no dependencies.

### Changed

- `README.md` no longer describes minimal-move list reconciliation as an omission "yet". It is a
  refinement to placement, not a missing capability: correctness and node identity do not depend on
  it, so it can land in any 1.x release.

### Not in 1.0.0, and not owed

- **Scoped slots** - a component exposing values its own slot content reads, as Vue's `v-slot` does.
  The one thing that genuinely meets the compile-once wall. Knockout has no equivalent.
- **Minimal-move list reconciliation.** Placement is in order; reversing n items costs n moves rather
  than n-1. A performance refinement with no API consequence.
- **Async or AMD template loading.** Templates are strings.

## [0.8.0] - 2026-08-21

Slots, which completes capability parity with Knockout. A component can now leave holes for the page
to fill, with fallback content for the ones it does not.

### Added

- **`{{#slot}}` and `{{#slot name}}`** in a component's template, and **`data-slot`** at the usage
  site. Anything without a `data-slot` goes to the default slot, text included; several elements may
  share a name and arrive in document order.

  A mustache block rather than an element because an element does not survive the HTML parser:
  `<dm-slot>` is hoisted out of a `<tbody>` and deleted outright inside a `<select>`, and a table
  shell is exactly the kind of component slots exist for. A block compiles to comment anchors, which
  sit anywhere - the same reason `{{#each}}` already works inside a table.

- **Fallback content.** The block body renders only when nothing is projected into that slot.

- **Two scopes, one hole.** Fallback content resolves against the component's view model, because the
  component's template supplied it. Projected content resolves against the outer context, because the
  page did. A component cannot inject values into its slot content and does not need to - to hand
  something outward it takes a callback param, as before.

- **Projected content survives a swap.** Changing a dynamic component's name carries the same DOM
  nodes into the replacement rather than rebuilding them, so a half-typed input inside a slot is not
  lost. The nodes belong to the outer runtime throughout; the component only relocates them.

### Corrected

0.7.0's entry, and the README alongside it, said slots were blocked by the compile-once wall - that a
template is compiled into a `<template>` before any render pass exists, the same wall `{{> partial}}`
meets inside a keyed block.

**That was wrong.** It blocks one implementation, compiling slot content into the component's
factory, and slots do not need that. Slot content is written at the usage site, so the enclosing
template has already annotated it, painted it and bound it to the outer context. An effect holds a
direct node reference and `indexRoots` matches bindings by marker id anywhere in the subtree, so
moving a node does not disturb its binding. Slots are a placement problem, and the component handler
already owned placement.

What genuinely meets that wall is **scoped slots** - a component exposing values its own slot content
reads, as Vue's `v-slot` does. Knockout has no equivalent, so parity does not require it.

`{{> partial}}` inside a keyed block does meet the wall, and its own note stands.

### Fixed

- Twelve anchor links in `Tutorial.md` pointed at headings that no longer generated those anchors.
  0.6.1 replaced the em dash in each step heading with `" - "`, which adds a third dash to the
  generated anchor, and the contents table still used the two-dash form. Every link in the tutorial's
  own contents went nowhere.

### Still missing

- Scoped slots, as above.
- Async or AMD template loading. Templates are strings.

## [0.7.0] - 2026-08-21

Components - the last substantial capability Knockout had and this did not, apart from slots. A
component is a template plus an optional factory for the view model it renders against: reusable
markup that owns some state and knows how to clean it up.

The implementation is small because a component instance is not a new kind of thing. It is a
reconciler instance, exactly as a keyed list item is - cloned template, its own binding records, its
own effects, an anchored range, and disposal that works when an ancestor removes the subtree without
knowing a component was there. All of that already existed for lists, which is why the whole feature
costs about 1.2 KB gzipped.

### Added

- **`registerComponent(name, {template, create?})`** and **`unregisterComponent(name)`**. `create`
  is a plain factory - no `new`, no constructor form, no second `createViewModel` spelling. It
  receives `(params, {element})` and returns the view model. Leave it out and the component is
  template-only, with the params themselves as `$data`, which keeps the trivial case trivial.
  Registration **throws** on a bad definition, as `registerExtender` does: a bad registration is a
  programming error at startup, where a bad expression is authored data met halfway through a paint.

- **`data-component`**, a twelfth binding kind. It renders inside its element rather than replacing
  it, as Knockout's `component:` does, so the host keeps its own attributes, classes and identity.
  It is an element binding rather than a region one, because a region is anchored around the whole
  element and would bury the `data-param-*` attributes the binding needs to read.

- **Params in two spellings.** `data-param-<name>="expr"` for one param named in the attribute, and
  `data-params="obj"` for an object the view model already holds. Both may appear together; they
  merge, and a named attribute beats the same key in the object, with a warning. This is the pair
  `data-bind-style` established and `data-options-*` followed, and it exists for the same reason:
  Knockout spells params as an object literal, and object literals are exactly what this expression
  language refuses - which is what lets bindings parse without `eval`.

  Names are kebab-case in the attribute and camelCase in the object, because an HTML attribute name
  is lowercased by the parser and `data-param-firstName` could not survive the round trip.

- **Params pass by reference, and the markup says which.** `data-param-x="thing"` passes the
  observable, so the component can write back and the parent sees it; `data-param-x="thing.value"`
  passes a snapshot. Nothing decides this - they are different expressions, and the difference is
  the same `.value` the author already reads through. Params are evaluated once, at instantiation,
  and the object is frozen.

- **`$component`**, the eighth binding-context name. It is the enclosing component's view model, and
  it is **inherited** by child contexts exactly as `$root` is, so it still answers inside a
  `{{#each}}` in a component's template - which is the only reason the name exists, since `$data`
  already reaches the view model at the top level. `null` outside a component.

  `createComponentContext` sets `$parentContext`, so `$parents` walks straight out of a component
  and on up the page: a component is a boundary for `$data` and nothing else.

- **Dynamic components.** The name is an expression, like every other binding value, so
  `data-component="currentView.value"` swaps the rendered component when the observable changes -
  which is how a great many Knockout applications route. A literal name therefore takes inner
  quotes. Changing the name disposes the old instance (view model `dispose()`, then its effects,
  then its nodes) and re-evaluates every param against the context in force at that moment. Setting
  the name to what it already is does nothing, so an unrelated update never costs a half-typed
  input.

- **View-model `dispose()`**, run on teardown before the instance's effects are destroyed. It is the
  only lifecycle hook, and the same contract `handle.dispose()` and `controller.destroy()` already
  offer; more would be inventing the framework this package is not.

### Fixed

- `applyBindings` registered a handler's `detach` teardown only when that handler also had an
  `attach`, so a handler owning something to tear down without needing a per-node attach never heard
  about disposal. `runtime.js` has always called the two independently and the documented contract
  lists them as separate hooks - this path was the odd one out. Found by components: one activated
  through `applyBindings` disposed correctly under `compile()` and leaked its view model here.

- `data-param-*` on an element with no `data-component` now warns at compile time. Nothing
  downstream would ever look at that element, and the symptom - a component whose every param is
  `undefined` - is indistinguishable from a typo in the component name.

### Changed

- `createInstance` takes an optional `{context}`, so a caller can supply the context an instance
  resolves against. Lists are untouched.
- One factory builder is now shared between `{{#each}}` block bodies and component templates. The
  two differ only in their source, their label and their id prefix.
- The bundle grew to 20 KB gzipped (from 18), 58 KB minified (from 54).

### Still missing

- **Slots** - Knockout's `$componentTemplateNodes`, and transclusion generally. A component's host
  element has its children replaced on mount. The obstacle is structural: a template is compiled
  once into a `<template>` before any render pass exists, which is what makes an instance cheap to
  clone, and slots need the host's children compiled into a body only known at mount time. It is the
  same wall `{{> partial}}` meets inside a keyed block, and it is the one remaining item on the
  parity list.
- Async or AMD template loading. Templates are strings.

## [0.6.1] - 2026-08-21

Never published to npm on its own - the sweep below shipped inside 0.7.0. The entry stays because
the version existed in the repository and the change is worth recording where it happened.

### Changed
- Em and en dashes replaced with plain hyphens throughout: source comments,
  the console warnings the runtime emits, README, Tutorial and the docs. 759
  of them across 41 files. No behaviour change - the library never used a long
  dash as a value or a separator, only as punctuation in prose and messages.
  Consumers see it in the three runtime warnings (read-only computed, flush
  re-entry, notify option) and nowhere else.

## [0.6.0] - 2026-08-18

Two new binding-context names, closing the ancestor gap against Knockout. The only capability
Knockout still has and this does not is components, which are next.

### Added

- **`$parents`** - ancestor data, nearest first, so `$parents[1]` is a grandparent.
  `$parents[0]` is `$parent` everywhere below the root; at the root `$parent` is `null` and
  `$parents` is empty.

  It is built only if a template asks for it, by walking the parent chain on first read and
  caching the result. A keyed list creates a context per item per render whether or not any
  template mentions the name, so a list that never uses it pays nothing.

- **`$parentContext`** - the enclosing context, and the one context name that *is* a context.
  Ancestor data cannot answer "which row of the **outer** list am I in?", because position lives
  on the context rather than on the data. `$parentContext.$index` answers it, and nothing could
  before:

  ```html
  <ol>{{#each members key=id}}
      <li>
          {{name}}
          - in {{$parents[0].name}}          <!-- the group -->
          - of {{$parents[1].title}}         <!-- the root -->
          - group {{$parentContext.$index}}  <!-- the OUTER list's position -->
      </li>
  {{/each}}</ol>
  ```

  `$parent` remains **data**, not a context. Making it one would force `$parent.$data.name`
  everywhere, which is why it is data in the first place. Knockout draws the line in the same
  place and added `$parentContext` for the same reason.

### Fixed

- **Writing to a frozen target warns instead of throwing.** `resolveWriteTarget` hands back an
  object and a key, and its callers assigned to it unguarded - so a frozen target threw a
  `TypeError`, and a binding that throws takes the page down with it, which is the one thing this
  layer promises never to do.

  It was reachable before this release: `data-model` against a frozen view model has always landed
  there. `$parents` and `$parentContext` are frozen too, which made it easy to reach rather than
  obscure. Both now warn and skip, like every other unsettable path.

- **An inert `data-each` now says so.** `data-each` is an `applyBindings` spelling; the compiler
  discovers lists from `{{#each}}` only. A list's item template *is* compiled markup, so a
  `data-each` nested inside another list was left exactly as written - its item template rendered
  once as ordinary markup, and the bindings inside it resolved against the **outer** item. It
  looked close enough to working to survive review.

  The capability was never absent: `{{#each}}` nests to any depth and works inside a `data-each`
  body, both new context names included. What was absent was any sign the attribute had done
  nothing. `annotate()` now warns once, quoting the expression back and naming the form to write:

  ```html
  <ul data-each="groups key=id">
      <li>
          {{#each members key=id}}<b>{{name}} - {{$parentContext.$index}}</b>{{/each}}
      </li>
  </ul>
  ```

  Found while testing this release, and verified to predate it.

## [0.5.2] - 2026-08-18

Documentation, and one internal fix. No change to the public API.

### Added

- The README now says **what the library is** before it says how to use it. It opened on
  mechanism - derivations discovering their own reads, keyed reconciliation, the hand-written
  parser - which only lands for someone who already knows what the library is for. There is now
  a definition, a `What it does` section of seven capabilities each carrying the line that proves
  it, and a short `What it isn't`, so a reader can rule themselves out in seconds rather than
  after 1100 lines. The mechanism paragraphs are not gone; they are re-sited as three of the
  seven, where there is a frame to hang them on.

- `docs/superpowers/specs/` and `docs/superpowers/plans/` - the agreed design for component
  params, and the implementation plan that follows from it. Repo only; not packaged.

### Changed

- **`Limits and non-goals` now separates settled differences from real gaps.** The spellings here
  differ from Knockout's on purpose and will go on differing; a capability Knockout has and this
  does not is a to-do. `$parents[n]` and components are named as gaps and read **not yet** in the
  migration table, where `html:` and observable unwrapping stay **none**, since triple-stache and
  an explicit `.value` already cover them.

  The argument against a component model is kept, but it is now why the problem is hard rather
  than why it will not be solved. Components are on the roadmap: capability parity with Knockout
  is the goal, and 1.0 is where that is complete.

### Fixed

- **The bundle size figures, which had drifted about 20% stale.** 0.5.0 grew the bundle and
  nothing in the build asserts these numbers, so nothing caught it. `min.js` gzipped is 18 KB,
  not 15 KB; `min.js` and `cjs` are 54 KB, not 44 KB; `esm.js` is 280 KB, not 235 KB.

- **The key sentinel is written as `\0` rather than a literal NUL byte.** The synthetic keys the
  reconciler mints for unkeyed and duplicate items, and the placeholder values `data-options`
  gives options with no value, are prefixed with NUL so they cannot collide with anything an
  author supplies - that part was right. Embedding it as a raw `0x00` was not: it made `file(1)`
  report `handlers.js` and `reconciler.js` as `data` rather than JavaScript, and grep and ripgrep
  skip binary files silently. A search for `registerBinding` across `src/` returned every module
  except the one that defines it. The escape produces the identical string; only the bytes on
  disk differ.

## [0.5.1] - 2026-08-09

Documentation only. No change to any bundle beyond its version banner.

### Added

- **`Tutorial.md`** - a contacts page built in ten steps: add, edit in place, search, filter
  by group, delete, empty state, `localStorage`, disposal. It meets each of 0.5.0's features
  at the point someone building something would reach for it.

  Its listings are not illustrative. `src/tutorial.test.js` is the finished `index.html` body
  and `app.js` transcribed rather than paraphrased, driven through `applyBindings` against
  jsdom - so a change to the package that breaks the tutorial goes red like anything else.

- The tutorial now ships in the package rather than living on GitHub alone. Adding it to
  `files` is why this release exists: 0.5.0's tarball was already published, and npm does not
  allow a republish.

## [0.5.0] - 2026-08-09

Closes the remaining functional gaps against Knockout. Everything below was reachable
before only by writing it yourself; nothing that already worked has changed.

### Added

- **Extenders.** `observable().extend({…})` and the same on `observableArray`, with
  `rateLimit` (both of Knockout's methods - `notifyWhenChangesStop` and
  `notifyAtFixedRate`), `throttle` as Knockout's older name for it, and
  `notify: 'always'`. `registerExtender()` / `unregisterExtender()` open the same
  mechanism to consumers, exactly as `registerBinding()` does for bindings.

  Unlike Knockout's original `throttle`, **the write is never delayed** - only the
  notification. A rate-limited observable always reads back what was last written to it,
  which is the bug that made Knockout deprecate `throttle` in the first place.

- **Writable computeds.** `computed({read, write})`. This is what lets `data-model` bind
  a derived value; assigning to a computed without a `write` now warns and names it,
  rather than storing into the read cache where the next recompute would drop it.

- **`observableArray.indexOf`, `.replace`, `.destroy`, `.destroyAll`** - the rest of
  Knockout's array vocabulary. `destroy()` marks an item `_destroy: true` and leaves it
  in the collection, for servers that delete on that flag; `{{#each}}`, `data-each` and
  `data-options` all skip a marked item, so the collection and what is on screen agree.

- **`data-bind-style`**, in two spellings: `data-bind-style-color="shade"` for one
  property (kebab-cased, custom properties included) and `data-bind-style="look"` for an
  object of them. Ownership works as `data-bind-class` does - only the properties this
  binding set last time are removed, so a static `style=` attribute survives.

- **`data-options`**, with `data-options-text`, `data-options-value` and
  `data-options-caption`, for populating a `<select>`. The three companions are
  expressions against the item rather than property names, so a computed label works.
  Option values that are not strings round-trip through `data-model` by identity instead
  of arriving back as `"[object Object]"`, and a value the model chose before its option
  existed is applied by the rebuild that brings it - so attribute order does not matter,
  and neither does a collection that arrives from a fetch.

- **`data-focus`** - Knockout's `hasFocus`, two-way. An expression it cannot write
  through still drives focus, and warns about only the write-back.

- **Virtual bindings in `applyBindings`** - `<!-- dm if: x -->` … `<!-- /dm -->`, plus
  `each` and `text`. Knockout's `<!-- ko -->`, and the one thing `applyBindings` could
  not express: a run of `<li>`s or `<td>`s with no spare element to hang an attribute on.
  They nest, and an `if` holds its nodes aside as a fragment rather than as a list, so a
  nested block that changes while its parent is closed still lands correctly when the
  parent reopens.

### Changed

- `readFromControl` on a `<select>` now returns the option's underlying value where
  `data-options` supplied one. A hand-written `<option value="a">` still reads back the
  string `"a"`, so this is additive.

## [0.4.2] - 2026-08-06

### Added

- Every built artefact now carries a banner naming its version
  (`/*! domma-reactive v0.4.2 | MIT | … */`), kept through minification, so a bundle is no longer
  anonymous - handed one, you can tell which release it is.

### Fixed

- `verify-dist` asserts the banner matches `package.json`, so a stale `dist/` can no longer be
  published under a new version number. It runs in `prepublishOnly`, so it gates every route to npm.

## [0.4.1] - 2026-08-05

### Fixed

- `applyBindings` warned *"does not interpolate `{{ }}`"* about mustache inside a `data-each` body -
  which is the one place in already-rendered DOM where mustache **does** work, because a list's
  contents are a template that is lifted out, compiled and cloned per item. The scan ran before the
  list body was recognised as a template, so the advice was backwards: it told authors to replace
  working markup. The rendering was always correct; only the warning was wrong.
- The `applyBindings` example in the README bound `data-model="query"` against a raw `observable`,
  which shows `[object Object]` in the input and drops the write on the first keystroke. Corrected to
  `query.value` - the no-unwrapping rule applies in a binding exactly as it does in JavaScript.

## [0.4.0] - 2026-08-05

### Added

- **`applyBindings(data, rootElement)`** - the other direction from `compile()`. Activates binding
  attributes on DOM that already exists, in place, leaving the markup otherwise as it found it. No
  build step and no second source of truth for the markup.
- **Keyed list reconciliation.** `{{#each items key=id}}` keeps the DOM nodes of items that survive a
  change, so focus, uncommitted input, scroll position and animation state survive with them.
- **Instance lifecycle** - `dispose()` on the `applyBindings` handle and `destroy()` on the `compile`
  controller drop every effect, listener, list instance and marker they created.
- `renderTemplate` is exported, and `compile()`'s renderer parameter became optional, so the package
  can render without a template engine being supplied.

### Fixed

- **A list's rows could not act on the list.** Inside a list `$data` is the item, so
  `$parent.remove($data)` was the only way for a row to name the collection that owns it - and it did
  not parse. `data-on-*` may now call a method; the restriction is scoped rather than lifted, since
  the evaluator still refuses to perform a method call, so `{{ }}`, `data-if` and `data-bind-*` remain
  reads with no side effects.
- **`&&` broke a binding inside a keyed block.** A keyed block's body is captured by serialising DOM
  back to HTML, which escapes every `&`, so the documented `data-bind-class="done && 'struck'"` idiom
  came back as an entity and failed to parse. Expression-valued attributes are now decoded in a single
  pass, so `&amp;lt;` cannot double-decode.
- **`computed().value` was a stale field** - neither recomputed nor tracked. It is now a getter, which
  also makes a computed readable from a template expression, where a method cannot be called.
- **`observableArray().remove()` accepts a value or a predicate.** A function used to be compared
  against each item by identity, never matched, and removed nothing without a word.

## [0.3.0] - 2026-08-05

### Added

- **A CSP-safe expression evaluator** - tokeniser, Pratt parser, AST walker and helper registry,
  supporting property paths, indexing, comparison, logical operators, ternaries, arithmetic and
  literals. **No `eval` and no `Function` constructor**, in the source or in any built bundle, so
  expressions work under `script-src 'self'`. Access through `__proto__`, `constructor` or `prototype`
  is refused in every form, including a computed key whose value is only `'__proto__'` at runtime.
- **A binding registry** - `registerBinding()` / `unregisterBinding()`, plus four behaviour bindings:
  `data-on-*`, `data-bind-*`, `data-model` and `data-if`, the last of which removes the element rather
  than hiding it. The existing mustache kinds register through the same public function, so a custom
  binding is not a second-class citizen. There is deliberately no `data-bind-html`.

## [0.2.0] - 2026-08-05

### Added

- The **template binding compiler** moved into the package: `compile()`, `annotate()`, `scanBlocks()`
  and `TemplateCompiler`, with the mustache renderer as a replaceable parameter.

## [0.1.0] - 2026-08-04

### Added

- First release. The **reactive graph** extracted from Domma: `observable`, `observableArray`,
  `computed`, `effect`, `untracked`, `flushSync`, `trackingProxy` and the `Dep` / `DepMap` /
  `Computation` primitives, with dependency tracking, laziness and a batched microtask flush.
- A deep-equality helper (`isEqual`) as the change gate.
- Packaged as UMD, CommonJS and ESM, with `verify-dist` checking every declared entry point loads the
  way a real consumer would before publishing.

[1.0.0]: https://github.com/pinpointzero73/domma-reactive/releases/tag/v1.0.0
[0.8.0]: https://github.com/pinpointzero73/domma-reactive/releases/tag/v0.8.0
[0.7.0]: https://github.com/pinpointzero73/domma-reactive/releases/tag/v0.7.0
[0.6.0]: https://github.com/pinpointzero73/domma-reactive/releases/tag/v0.6.0
[0.5.2]: https://github.com/pinpointzero73/domma-reactive/releases/tag/v0.5.2
[0.5.1]: https://github.com/pinpointzero73/domma-reactive/releases/tag/v0.5.1
[0.5.0]: https://github.com/pinpointzero73/domma-reactive/releases/tag/v0.5.0
[0.4.2]: https://github.com/pinpointzero73/domma-reactive/releases/tag/v0.4.2
[0.4.1]: https://github.com/pinpointzero73/domma-reactive/releases/tag/v0.4.1
[0.4.0]: https://github.com/pinpointzero73/domma-reactive/releases/tag/v0.4.0
[0.3.0]: https://github.com/pinpointzero73/domma-reactive/releases/tag/v0.3.0
[0.2.0]: https://github.com/pinpointzero73/domma-reactive/releases/tag/v0.2.0
[0.1.0]: https://github.com/pinpointzero73/domma-reactive/releases/tag/v0.1.0
