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
| `template-compiler.js` | `compile()` yes; `annotate()` and `scanBlocks()` no           |

Importing the package has no DOM side effects. If you only want reactivity, `observable` / `computed` / `effect` run
anywhere — Node, a worker, a test runner with no DOM.

## Licence

MIT.
