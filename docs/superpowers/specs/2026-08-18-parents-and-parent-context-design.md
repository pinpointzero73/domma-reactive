# `$parents[n]` and `$parentContext` — design

**Status:** agreed, not implemented
**Ships as:** 0.6.0
**Date:** 2026-08-18

## Goal

Close the ancestor gap against Knockout. Two names join the binding context:

- **`$parents`** — ancestor *data*, nearest first. Reaches a grandparent's fields.
- **`$parentContext`** — the enclosing *context*. Reaches a grandparent's position.

They are companions rather than alternatives, and Knockout has both for the reason described below.

## Why both

`context.js` decided that `$parent` is **data**, not a context, and argued it well: making it a
context would force every template that used it to write `$parent.$data.name`. Knockout made the
same call.

The cost of that call is that positional information gets stranded. `$index` is yours; `$parent` is
data and has no `$index`. So from inside a list nested in a list, "which row of the *outer* list am
I in?" is currently unanswerable. Knockout added `$parentContext` precisely to answer it, and this
does the same.

```html
<ul data-each="groups key=id">
    <li>
        <h3 data-bind-text="name"></h3>

        <ol data-each="members key=id">
            <li>
                <span data-bind-text="$parents[1].name"></span>       <!-- ancestor DATA -->
                <span data-bind-text="$parentContext.$index"></span>  <!-- ancestor POSITION -->
            </li>
        </ol>
    </li>
</ul>
```

## Semantics

### `$parentContext`

The enclosing context object, or `null` at the root. Not inherited — it is the *immediate* parent,
set once at creation, which is what makes it a chain rather than a shortcut.

### `$parents`

Ancestor data, nearest first, matching Knockout exactly:

| Expression | Value |
|---|---|
| `$parents[0]` | identical to `$parent`, at every depth below the root |
| `$parents` at the root | `[]` |
| `$parents[0]` at the root | `undefined`, where `$parent` is `null` |
| `$parents[$parents.length - 1]` | `$root`'s data, at depth ≥ 1 |
| `$parents[99]` | `undefined` — ordinary array indexing, which never throws |

The root is the one place the two disagree, and neither value is worth changing to make them
agree: `$parent` is `null` there because §5 requires every context name to resolve everywhere, and
`$parents[0]` is `undefined` because that is what indexing past the end of an empty array gives.
Knockout has the same seam. A template that cares should test `$parents.length`.

Both are frozen. Both join `CONTEXT_KEYS`.

`$parent` is **not** redefined as `$parents[0]`. It stays an independent field: it is the common
case, and reading it should not build an array.

## Construction

`$parents` is a memoised getter over the `$parentContext` chain, so nothing is allocated unless a
template actually mentions the name. This follows the pattern `lifecycle.js`'s `live` counter and
the factory's `usesLength` already set — do not pay for what the template did not ask for.

```javascript
/** Ancestor data, nearest first. Frozen: a context is a statement, not scratch space. */
function buildParents(ctx) {
    const out = [];
    for (let c = ctx.$parentContext; c !== null; c = c.$parentContext) out.push(c.$data);
    return Object.freeze(out);
}
```

The context object stops being a plain literal, gaining a getter defined before the freeze:

```javascript
    let parents = null;

    const ctx = {
        $data: data,
        $root: base.$root,
        $parent: base.$data,
        $index: index === undefined ? null : index,
        $length: length === undefined ? null : length,
        $parentContext: base
    };

    Object.defineProperty(ctx, '$parents', {
        enumerable: true,
        get() { return parents ??= buildParents(ctx); }
    });

    return Object.freeze(ctx);
```

`Object.freeze` does not prevent the closure variable being assigned, so memoisation survives it.

`createRootContext` gets `$parentContext: null` and `$parents: []` — frozen, shared, and constant,
so the root needs no getter.

## Writes, and the latent throw this fixes

`resolveWriteTarget` returns `{object, key}` and `handlers.js` then performs `target.object[target.key] = value`
unguarded. These are strict-mode modules, so **assigning to a frozen object throws a TypeError** —
which would break the rule that nothing in the binding layer throws on bad input.

This is already reachable: `data-model="frozen.x"` on frozen view-model data throws today. Freezing
`$parents` and exposing contexts through `$parentContext` makes it easy to hit rather than obscure,
so it is fixed here rather than left.

One line, in `resolveWriteTarget`, in both the `Identifier` and `Member` branches after `object` is
resolved:

```javascript
    if (Object.isFrozen(object)) return null;
```

`null` is already the established "not a settable path" signal, so every caller warns properly
instead of throwing — `data-model` and `data-focus` both already handle it.

What this yields:

| Expression | Result |
|---|---|
| `$parents = x` | refused — bare context key, already refused by `CONTEXT_KEYS` |
| `$parentContext = x` | refused, same route |
| `$parents[0] = x` | refused, one warning — the array is frozen |
| `$parentContext.$index = 1` | refused — a context is a statement, not scratch space |
| `$parents[1].name = x` | **allowed** — ancestor data, exactly as `$parent.name` is today |
| `data-model="frozenUserData.x"` | refused with a warning, where it previously threw |

The last row is a behaviour change: a thrown TypeError becomes a warning and a skipped binding. That
is the direction every other failure in this layer already goes.

## What needs no work

Adding both names to `CONTEXT_KEYS` is sufficient for all of:

- **Resolution.** `resolveIdentifier` is `if (CONTEXT_KEYS.has(name)) return context[name]`.
- **Write refusal for the bare names.** `resolveWriteTarget`'s `Identifier` branch already returns
  `null` for anything in the set.
- **Dependency analysis.** `expressionDependencies` excludes context keys from `deps`, so neither
  name is mistaken for a root data name.
- **Parsing.** `Member` with `computed: true` already handles `$parents[2]`; no grammar change.

Reactivity is unaffected. Effects discover their reads at runtime, so `$parents[1].name.value`
tracks the observable it lands on exactly as any other read does.

## Interaction with components (0.7.0)

`createComponentContext` does not exist yet, but when it does it must set `$parentContext` to the
enclosing context like any other child context, so `$parents` walks correctly through a component
boundary. The components spec is amended to say so, so the two cannot drift.

`$component` is inherited by child contexts; `$parentContext` is not. That is not an inconsistency:
`$component` names the nearest enclosing component however deep you are, and `$parentContext` names
exactly one link. Different jobs.

## Failure modes

Nothing new can throw. Out-of-range indexing yields `undefined`, as any array does, and a binding
that renders `undefined` renders empty — existing behaviour, unchanged.

## Testing

At this repository's ratio, roughly 150–250 test lines.

- `$parentContext` is `null` at the root, and the enclosing context one level down
- `$parents` is `[]` at the root
- `$parents[0]` is identical to `$parent`, at every depth
- three levels deep: `$parents` is `[level2, level1, root]` in that order
- `$parents` is frozen, and so is the root's
- the getter is memoised — `ctx.$parents === ctx.$parents` for the same context
- two sibling contexts do not share an array — `a.$parents !== b.$parents` where both are `[root]`
- the root's `$parents` is the shared frozen empty constant, which is safe precisely because it is
  both empty and frozen
- `Object.getOwnPropertyDescriptor(ctx, '$parents').get` is a function, proving it is not eagerly
  built, and `enumerable` is true so a context still spreads and serialises as it did
- end to end through a nested keyed list: `$parents[1].name` and `$parentContext.$index` both render
- `$parents[99]` renders empty rather than throwing
- every row of the writes table above, each warning fired exactly once
- `data-model="frozen.x"` warns rather than throwing — the regression this fixes

## Documentation

- **`README.md`** — the `Binding context` section gains both names; `Known limits` loses "There is
  no `$parents[2]` yet"; the migration table's `$parents[2]` row becomes **identical**, and a
  `$parentContext` row is added; `Limits and non-goals` loses `$parents[n]` from the gap list,
  leaving components and slots. The `What it does` opening does not change — this is a refinement,
  not a headline capability.
- **`CHANGELOG.md`** — a `## [0.6.0]` entry.
- **`Tutorial.md`** — no change. The contacts app has no nested list, and inventing one to
  demonstrate this would make the tutorial worse.

## Out of scope

- `$rawData`. It exists in Knockout because Knockout unwraps observables; here `$data` *is* the raw
  data, so it is a spelling difference rather than a gap.
- `$parentContext` on `applyBindings`' server-rendered path beyond what child contexts already give
  it — the same `createChildContext` is used, so it follows without special work, and no separate
  design is needed.
