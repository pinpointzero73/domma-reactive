# domma-reactive

Dependency-tracked reactivity: derivations discover which state they actually read, so a write re-runs exactly the work
that depends on it. This is the reactive core of [Domma](https://github.com/pinpointzero73/domma), published separately
so it can be used on its own.

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

## Template bindings

The package also ships the binding compiler that turns a mustache template into a set of *fine-grained* bindings, each
owning a small region of the DOM. A structural change re-renders only the block that changed — everything else keeps its
node identity, so focus, scroll position and unsaved input survive.

```javascript
import {compile, observable, effect, flushSync} from 'domma-reactive';

const name = observable('alice');
const host = document.querySelector('#out');

// The renderer is YOURS to supply — see below.
const controller = compile('<b>{{name}}</b>', {name: name.value}, host, myRenderer);

const textBinding = controller.bindings.find(b => b.kind === 'text');
effect(() => controller.update(textBinding.id, {name: name.value}));

name.set('bob');   // only the <b> is touched
```

Four binding kinds are recognised:

| Kind    | Template            | Updated by                             |
|---------|---------------------|----------------------------------------|
| `text`  | `{{name}}`          | `textContent` on a `<span>` anchor      |
| `attr`  | `class="{{cls}}"`   | `setAttribute` on the owning element    |
| `block` | `{{#if x}}…{{/if}}` | re-rendering a comment-delimited region |
| `raw`   | `{{{html}}}`        | re-rendering a comment-delimited region |

Every binding declares which root fields it depends on (`controller.deps(id)`), which is what lets you wire one effect
per binding rather than re-rendering wholesale.

### It brings no template engine

`compile(template, data, container, renderFn)` takes the renderer as a **parameter**. This package contributes the
anchor and binding machinery — which region belongs to which expression, and what re-renders when — and you inject the
evaluation. Any `(template, data) => string` function will do; Domma passes its own `utils.render`.

Interpolated data is expected to be HTML-escaped **by your renderer**, with `{{{triple-stache}}}` as the explicit
opt-out. The compiler does not escape on your behalf.

### DOM requirements

| Module                 | Needs a `document`?                                          |
|------------------------|--------------------------------------------------------------|
| `observable.js`        | No                                                            |
| `graph.js`, `equal.js` | No                                                            |
| `expression.js`        | No                                                            |
| `template-compiler.js` | `compile()` yes; `annotate()` and `scanBlocks()` no           |

Importing the package has no DOM side effects. If you only want reactivity, `observable` / `computed` / `effect` run
anywhere — Node, a worker, a test runner with no DOM.

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

**The binding compiler above does not use this yet.** Wiring expressions into `{{ }}` and `data-*` bindings is the next
milestone; today this is a standalone evaluator you call yourself. The other five entry points are `parseExpression`
(source → AST, or `null`), `evaluateAst` (AST → value), `evaluateExpression` (source → value in one call),
`unregisterHelper` and `clearExpressionCache`.

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
