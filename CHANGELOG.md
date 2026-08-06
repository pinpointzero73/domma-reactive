# Changelog

All notable changes to `domma-reactive`.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Entries before 0.4.2 were reconstructed from the tag history and are summaries rather than
contemporaneous notes.

## [0.4.2] - 2026-08-06

### Added

- Every built artefact now carries a banner naming its version
  (`/*! domma-reactive v0.4.2 | MIT | … */`), kept through minification, so a bundle is no longer
  anonymous — handed one, you can tell which release it is.

### Fixed

- `verify-dist` asserts the banner matches `package.json`, so a stale `dist/` can no longer be
  published under a new version number. It runs in `prepublishOnly`, so it gates every route to npm.

## [0.4.1] - 2026-08-05

### Fixed

- `applyBindings` warned *"does not interpolate `{{ }}`"* about mustache inside a `data-each` body —
  which is the one place in already-rendered DOM where mustache **does** work, because a list's
  contents are a template that is lifted out, compiled and cloned per item. The scan ran before the
  list body was recognised as a template, so the advice was backwards: it told authors to replace
  working markup. The rendering was always correct; only the warning was wrong.
- The `applyBindings` example in the README bound `data-model="query"` against a raw `observable`,
  which shows `[object Object]` in the input and drops the write on the first keystroke. Corrected to
  `query.value` — the no-unwrapping rule applies in a binding exactly as it does in JavaScript.

## [0.4.0] - 2026-08-05

### Added

- **`applyBindings(data, rootElement)`** — the other direction from `compile()`. Activates binding
  attributes on DOM that already exists, in place, leaving the markup otherwise as it found it. No
  build step and no second source of truth for the markup.
- **Keyed list reconciliation.** `{{#each items key=id}}` keeps the DOM nodes of items that survive a
  change, so focus, uncommitted input, scroll position and animation state survive with them.
- **Instance lifecycle** — `dispose()` on the `applyBindings` handle and `destroy()` on the `compile`
  controller drop every effect, listener, list instance and marker they created.
- `renderTemplate` is exported, and `compile()`'s renderer parameter became optional, so the package
  can render without a template engine being supplied.

### Fixed

- **A list's rows could not act on the list.** Inside a list `$data` is the item, so
  `$parent.remove($data)` was the only way for a row to name the collection that owns it — and it did
  not parse. `data-on-*` may now call a method; the restriction is scoped rather than lifted, since
  the evaluator still refuses to perform a method call, so `{{ }}`, `data-if` and `data-bind-*` remain
  reads with no side effects.
- **`&&` broke a binding inside a keyed block.** A keyed block's body is captured by serialising DOM
  back to HTML, which escapes every `&`, so the documented `data-bind-class="done && 'struck'"` idiom
  came back as an entity and failed to parse. Expression-valued attributes are now decoded in a single
  pass, so `&amp;lt;` cannot double-decode.
- **`computed().value` was a stale field** — neither recomputed nor tracked. It is now a getter, which
  also makes a computed readable from a template expression, where a method cannot be called.
- **`observableArray().remove()` accepts a value or a predicate.** A function used to be compared
  against each item by identity, never matched, and removed nothing without a word.

## [0.3.0] - 2026-08-05

### Added

- **A CSP-safe expression evaluator** — tokeniser, Pratt parser, AST walker and helper registry,
  supporting property paths, indexing, comparison, logical operators, ternaries, arithmetic and
  literals. **No `eval` and no `Function` constructor**, in the source or in any built bundle, so
  expressions work under `script-src 'self'`. Access through `__proto__`, `constructor` or `prototype`
  is refused in every form, including a computed key whose value is only `'__proto__'` at runtime.
- **A binding registry** — `registerBinding()` / `unregisterBinding()`, plus four behaviour bindings:
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

[0.4.2]: https://github.com/pinpointzero73/domma-reactive/releases/tag/v0.4.2
[0.4.1]: https://github.com/pinpointzero73/domma-reactive/releases/tag/v0.4.1
[0.4.0]: https://github.com/pinpointzero73/domma-reactive/releases/tag/v0.4.0
[0.3.0]: https://github.com/pinpointzero73/domma-reactive/releases/tag/v0.3.0
[0.2.0]: https://github.com/pinpointzero73/domma-reactive/releases/tag/v0.2.0
[0.1.0]: https://github.com/pinpointzero73/domma-reactive/releases/tag/v0.1.0
