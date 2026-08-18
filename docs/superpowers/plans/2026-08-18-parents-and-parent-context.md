# `$parents[n]` and `$parentContext` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Ships as:** 0.6.0. Roadmap: 0.6.0 this, 0.7.0 components, 0.8.0 slots, 1.0.0 Knockout parity complete.

**Goal:** Add `$parents` (ancestor data, nearest first) and `$parentContext` (the enclosing context) to the binding context, closing the ancestor gap against Knockout.

**Architecture:** `$parentContext` is a plain reference stored at context creation. `$parents` is a memoised getter that walks that chain on first read, so nothing is allocated unless a template mentions it. Both names join `CONTEXT_KEYS`, which is enough for resolution, write-refusal and dependency analysis to follow automatically. Freezing `$parents` forces a pre-existing latent throw into the open, fixed with one `Object.isFrozen` guard.

**Tech Stack:** Vanilla ES modules, Vitest + jsdom. No new dependencies.

---

## Read first

- `docs/superpowers/specs/2026-08-18-parents-and-parent-context-design.md` — the agreed design. Where this plan disagrees with it, the spec wins.
- `src/context.js` — the whole file. It is 140 lines and its header explains every decision this touches. **It has no imports and must keep it that way.**
- `src/expression.js:675` — `resolveIdentifier`, three lines, the entire resolution mechanism.
- `src/handlers.js:199-220` — `resolveWriteTarget`, which Task 4 changes.

## File structure

| File | Responsibility |
|---|---|
| `src/context.js` | Both new names. All construction logic. |
| `src/context.test.js` | Semantics, laziness, freezing. |
| `src/handlers.js` | The `Object.isFrozen` write guard. |
| `src/handlers.test.js` | That a frozen target warns rather than throwing. |
| `src/expression.test.js` | That both names resolve in a real expression. |
| `src/reconciler.test.js` | End to end through nested keyed lists. |
| `README.md`, `CHANGELOG.md` | Task 6, Task 7. |
| `docs/superpowers/specs/2026-08-18-component-params-design.md` | One amended line, Task 6. |

## Conventions

- **Nothing in the binding layer throws.** One `warnOnce`, naming the expression and the template, and that binding alone is skipped.
- **British English** in prose and comments.
- **`context.js` has no imports.** Nothing here changes that.
- Run `npm run test:run` before every commit.

---

### Task 1: `$parentContext`

**Files:**
- Modify: `src/context.js`
- Test: `src/context.test.js`

- [ ] **Step 1: Write the failing tests**

```javascript
describe('$parentContext', () => {
    it('is null at the root', () => {
        expect(createRootContext({a: 1}).$parentContext).toBeNull();
    });

    it('is the enclosing context one level down', () => {
        const root = createRootContext({a: 1});
        expect(createChildContext(root, {b: 2}).$parentContext).toBe(root);
    });

    it('promotes plain data to a root context first', () => {
        const child = createChildContext({a: 1}, {b: 2});
        expect(child.$parentContext.$data).toEqual({a: 1});
        expect(child.$parentContext.$parentContext).toBeNull();
    });

    it('chains, so two levels are reachable', () => {
        const root = createRootContext({a: 1});
        const one = createChildContext(root, {b: 2});
        const two = createChildContext(one, {c: 3});

        expect(two.$parentContext).toBe(one);
        expect(two.$parentContext.$parentContext).toBe(root);
    });

    it('is a context key, so an expression may not be written through it', () => {
        expect(CONTEXT_KEYS.has('$parentContext')).toBe(true);
    });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `npx vitest run src/context.test.js`
Expected: FAIL — `$parentContext` is `undefined`.

- [ ] **Step 3: Implement**

In `src/context.js`, add `'$parentContext'` to the set:

```javascript
export const CONTEXT_KEYS = new Set([
    '$data', '$root', '$parent', '$index', '$length', '$parentContext'
]);
```

Add `$parentContext: null` to the object `createRootContext` returns, and `$parentContext: base` to the object `createChildContext` returns.

Update the module header. The paragraph beginning "The cost is that there is no `$parents[2]`" is now wrong — replace it with a note that the chain is reachable through `$parentContext`, and that `$parent` remains data on purpose.

- [ ] **Step 4: Run the whole suite**

Run: `npm run test:run`
Expected: PASS. If a test asserts a context's exact shape it will fail on the new key — update it; the addition is intended.

- [ ] **Step 5: Commit**

```bash
git add src/context.js src/context.test.js
git commit -m "feat: add \$parentContext to the binding context

The enclosing context, or null at the root. \$parent stays data — making it a
context would force \$parent.\$data.name everywhere, which is why it is data in
the first place — so positional information one level up needed its own name.
Knockout reached the same conclusion."
```

---

### Task 2: `$parents`

**Files:**
- Modify: `src/context.js`
- Test: `src/context.test.js`

- [ ] **Step 1: Write the failing tests**

```javascript
describe('$parents', () => {
    it('is empty at the root', () => {
        expect(createRootContext({a: 1}).$parents).toEqual([]);
    });

    it('holds the parent data one level down', () => {
        const root = createRootContext({a: 1});
        const child = createChildContext(root, {b: 2});
        expect(child.$parents).toEqual([{a: 1}]);
    });

    it('is nearest-first, three levels deep', () => {
        const root = createRootContext({n: 'root'});
        const one = createChildContext(root, {n: 'one'});
        const two = createChildContext(one, {n: 'two'});
        const three = createChildContext(two, {n: 'three'});

        expect(three.$parents.map((d) => d.n)).toEqual(['two', 'one', 'root']);
    });

    it('agrees with $parent below the root', () => {
        const root = createRootContext({a: 1});
        const one = createChildContext(root, {b: 2});
        const two = createChildContext(one, {c: 3});

        expect(one.$parents[0]).toBe(one.$parent);
        expect(two.$parents[0]).toBe(two.$parent);
    });

    it('is the one place the two disagree at the root', () => {
        const root = createRootContext({a: 1});
        expect(root.$parent).toBeNull();
        expect(root.$parents[0]).toBeUndefined();
    });

    it('reaches $root data at the far end', () => {
        const root = createRootContext({n: 'root'});
        const two = createChildContext(createChildContext(root, {n: 'one'}), {n: 'two'});
        expect(two.$parents[two.$parents.length - 1]).toBe(two.$root);
    });

    it('yields undefined past the end rather than throwing', () => {
        const child = createChildContext(createRootContext({}), {});
        expect(child.$parents[99]).toBeUndefined();
    });

    it('is frozen', () => {
        const child = createChildContext(createRootContext({}), {});
        expect(Object.isFrozen(child.$parents)).toBe(true);
        expect(Object.isFrozen(createRootContext({}).$parents)).toBe(true);
    });

    it('is memoised — the same context returns the same array', () => {
        const child = createChildContext(createRootContext({}), {});
        expect(child.$parents).toBe(child.$parents);
    });

    it('does not share an array between sibling contexts', () => {
        const root = createRootContext({});
        const a = createChildContext(root, {n: 'a'});
        const b = createChildContext(root, {n: 'b'});
        expect(a.$parents).not.toBe(b.$parents);
    });

    it('is lazy — a getter, not an eager field', () => {
        const child = createChildContext(createRootContext({}), {});
        const descriptor = Object.getOwnPropertyDescriptor(child, '$parents');
        expect(typeof descriptor.get).toBe('function');
        expect(descriptor.enumerable).toBe(true);
    });

    it('is a context key, so an expression may not be written through it', () => {
        expect(CONTEXT_KEYS.has('$parents')).toBe(true);
    });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `npx vitest run src/context.test.js`
Expected: FAIL — `$parents` is `undefined`.

- [ ] **Step 3: Implement**

Add `'$parents'` to `CONTEXT_KEYS`. Then, above `createRootContext`:

```javascript
/**
 * The root's `$parents`, which is always empty.
 *
 * Shared across every root context, which is safe precisely because it is both
 * empty and frozen — there is nothing to tell two of them apart, and nothing
 * that could write to one.
 */
const NO_PARENTS = Object.freeze([]);

/**
 * Ancestor data, nearest first.
 *
 * Walks the `$parentContext` chain rather than being accumulated on the way
 * down, so a context that is never asked for its ancestry never builds one. Most
 * are not: `$parents` is a name for the awkward case, and a keyed list creates a
 * context per item per render whether or not any template mentions it.
 *
 * Frozen for the reason contexts are frozen — it is a statement about where an
 * expression sits, not scratch space. `resolveWriteTarget` refuses to write
 * through anything frozen, so `$parents[0] = x` warns rather than throwing.
 *
 * @param {Object} ctx
 * @returns {Array} frozen
 */
function buildParents(ctx) {
    const out = [];
    for (let c = ctx.$parentContext; c !== null; c = c.$parentContext) out.push(c.$data);
    return Object.freeze(out);
}
```

`createRootContext` gains `$parents: NO_PARENTS`. `createChildContext` and `createComponentContext` (when it exists) build the object, define the getter, then freeze:

```javascript
export function createChildContext(parent, data, index = null, length = null) {
    const base = toContext(parent);
    let parents = null;

    const ctx = {
        $data: data,
        $root: base.$root,
        $parent: base.$data,
        $index: index === undefined ? null : index,
        $length: length === undefined ? null : length,
        $parentContext: base
    };

    // Defined rather than assigned so it can be a getter, and enumerable so a
    // context still spreads and serialises exactly as it did.
    Object.defineProperty(ctx, '$parents', {
        enumerable: true,
        get() {
            return parents ??= buildParents(ctx);
        }
    });

    return Object.freeze(ctx);
}
```

`Object.freeze` does not stop the closure variable being assigned, so memoisation survives it.

- [ ] **Step 4: Run the whole suite**

Run: `npm run test:run`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/context.js src/context.test.js
git commit -m "feat: add \$parents to the binding context

Ancestor data, nearest first, matching Knockout. A memoised getter over the
\$parentContext chain rather than an array accumulated on the way down, so a
context that is never asked for its ancestry never builds one — and a keyed
list creates a context per item per render whether or not any template mentions
the name.

\$parents[0] is \$parent everywhere below the root. At the root they disagree:
\$parent is null because every context name must resolve everywhere, and
\$parents[0] is undefined because that is what indexing an empty array gives."
```

---

### Task 3: Both names resolve in a real expression

**Files:**
- Test: `src/expression.test.js`

No implementation. `resolveIdentifier` is `if (CONTEXT_KEYS.has(name)) return context[name]`, so Tasks 1 and 2 already did this. These tests prove it and guard against a future change to the resolution path.

- [ ] **Step 1: Write the tests**

```javascript
describe('ancestor context names', () => {
    const root = createRootContext({n: 'root', title: 'T'});
    const one = createChildContext(root, {n: 'one'});
    const two = createChildContext(one, {n: 'two'}, 3, 9);

    it('reads $parents by index', () => {
        expect(evaluateExpression('$parents[0].n', two)).toBe('one');
        expect(evaluateExpression('$parents[1].n', two)).toBe('root');
    });

    it('reads $parents.length', () => {
        expect(evaluateExpression('$parents.length', two)).toBe(2);
    });

    it('reads through $parentContext', () => {
        expect(evaluateExpression('$parentContext.$data.n', two)).toBe('one');
        expect(evaluateExpression('$parentContext.$parent.n', two)).toBe('root');
    });

    it('reaches the enclosing position, which is the point of $parentContext', () => {
        const inner = createChildContext(two, {n: 'inner'}, 0, 1);
        expect(evaluateExpression('$parentContext.$index', inner)).toBe(3);
        expect(evaluateExpression('$parentContext.$length', inner)).toBe(9);
    });

    it('yields undefined past the end rather than throwing', () => {
        expect(evaluateExpression('$parents[99]', two)).toBeUndefined();
        expect(() => evaluateExpression('$parents[99].n', two)).not.toThrow();
    });

    it('does not count either name as a data dependency', () => {
        expect([...expressionDependencies('$parents[1].n')]).toEqual([]);
        expect([...expressionDependencies('$parentContext.$index')]).toEqual([]);
    });
});
```

- [ ] **Step 2: Run**

Run: `npx vitest run src/expression.test.js`
Expected: PASS with no implementation change. If `expressionDependencies` returns a name, check that both were added to `CONTEXT_KEYS` in Tasks 1 and 2 — that set is what excludes them.

- [ ] **Step 3: Commit**

```bash
git add src/expression.test.js
git commit -m "test: \$parents and \$parentContext through the expression layer

No implementation: resolveIdentifier returns context[name] for anything in
CONTEXT_KEYS, and Member with computed: true already parsed \$parents[2]. These
tests pin that down so a change to the resolution path cannot quietly drop it."
```

---

### Task 4: Writing to a frozen target warns instead of throwing

**Files:**
- Modify: `src/handlers.js` (`resolveWriteTarget`, around line 199)
- Test: `src/handlers.test.js`

- [ ] **Step 1: Write the failing tests**

```javascript
describe('resolveWriteTarget refuses a frozen target', () => {
    const root = createRootContext({});
    const child = createChildContext(root, {name: 'ada'});

    it('refuses to write into $parents', () => {
        expect(resolveWriteTarget(parseExpression('$parents[0]'), child)).toBeNull();
    });

    it('refuses to write into a context reached through $parentContext', () => {
        expect(resolveWriteTarget(parseExpression('$parentContext.$index'), child)).toBeNull();
    });

    it('still allows writing to ancestor data', () => {
        const target = resolveWriteTarget(parseExpression('$parent.title'), child);
        expect(target).not.toBeNull();
        expect(target.key).toBe('title');
    });

    it('refuses frozen view-model data rather than throwing', () => {
        const frozen = createRootContext(Object.freeze({x: 1}));
        expect(resolveWriteTarget(parseExpression('x'), frozen)).toBeNull();
    });

    it('refuses a frozen object reached through a member chain', () => {
        const ctx = createRootContext({inner: Object.freeze({x: 1})});
        expect(resolveWriteTarget(parseExpression('inner.x'), ctx)).toBeNull();
    });
});
```

Import `resolveWriteTarget` from `./handlers.js`, `parseExpression` from `./expression.js`, and both context builders if absent.

- [ ] **Step 2: Run and watch it fail**

Run: `npx vitest run src/handlers.test.js`
Expected: FAIL — the frozen cases return a target rather than `null`.

- [ ] **Step 3: Implement**

In `resolveWriteTarget`, in the `Identifier` branch after `const object = context.$data;`, and in the `Member` branch after `const object = evaluateAst(ast.object, context);`, add the same guard:

```javascript
        if (Object.isFrozen(object)) return null;
```

Add a note above the function explaining why:

```
 * ── Frozen targets are not settable paths ────────────────────────────────────
 *
 * These are strict-mode modules, so `object[key] = value` on a frozen object
 * throws a TypeError — and a binding that throws takes the page with it, which
 * is the one thing this layer promises never to do. A frozen target is refused
 * here instead, so the caller warns and skips exactly as it does for any other
 * unsettable path.
 *
 * That covers `$parents` and every context reached through `$parentContext`,
 * both of which are frozen on purpose, and it covers a frozen view model, which
 * could always reach this line and would always have thrown.
```

- [ ] **Step 4: Run the whole suite**

Run: `npm run test:run`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/handlers.js src/handlers.test.js
git commit -m "fix: refuse a frozen write target instead of throwing

resolveWriteTarget hands back {object, key} and the callers assign to it
unguarded. These are strict-mode modules, so a frozen target threw a TypeError
— and a binding that throws takes the page with it, which is the one thing this
layer promises never to do.

Reachable before this change with data-model on a frozen view model. \$parents
and \$parentContext make it easy to reach rather than obscure, so it is fixed
here. null is already the not-a-settable-path signal, so every caller warns and
skips without further change."
```

---

### Task 5: End to end through nested keyed lists

**Files:**
- Test: `src/reconciler.test.js`

The unit tests prove the context is built correctly. This proves it survives a real render, which is where `createChildContext` is actually called.

- [ ] **Step 1: Write the tests**

```javascript
it('reaches ancestor data and ancestor position from a nested keyed list', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);

    const data = {
        groups: [
            {id: 1, name: 'Family', members: [{id: 11, name: 'Ada'}]},
            {id: 2, name: 'Work',   members: [{id: 21, name: 'Grace'}, {id: 22, name: 'Alan'}]}
        ]
    };

    compile(
        `<ul data-each="groups key=id"><li>` +
        `<ol data-each="members key=id"><li>` +
        `<b data-bind-text="$parents[1].name"></b>` +
        `<i data-bind-text="$parentContext.$index"></i>` +
        `<u data-bind-text="$parents.length"></u>` +
        `</li></ol>` +
        `</li></ul>`,
        data, host, undefined, {reactive: true}
    );
    flushSync();

    expect([...host.querySelectorAll('b')].map((n) => n.textContent))
        .toEqual(['Family', 'Work', 'Work']);
    expect([...host.querySelectorAll('i')].map((n) => n.textContent))
        .toEqual(['0', '1', '1']);
    expect([...host.querySelectorAll('u')].map((n) => n.textContent))
        .toEqual(['2', '2', '2']);
});
```

`$parents.length` is 2 in the inner rows: the group, then the root data.

- [ ] **Step 2: Run**

Run: `npx vitest run src/reconciler.test.js`
Expected: PASS. If `$parentContext.$index` renders empty, the inner list's context was built from the group *data* rather than the group *context* — check what `reconcile` passes as `parentContext`.

- [ ] **Step 3: Run the whole suite and commit**

```bash
npm run test:run
git add src/reconciler.test.js
git commit -m "test: ancestor names through a real nested keyed render"
```

---

### Task 6: Documentation

**Files:**
- Modify: `README.md`
- Modify: `docs/superpowers/specs/2026-08-18-component-params-design.md`

- [ ] **Step 1: README — the binding context section**

Document both names where `$data` `$root` `$parent` `$index` are described: what each is, that `$parents` is nearest-first, that `$parents[0]` is `$parent` below the root, and that `$parentContext` is how you reach an enclosing list's `$index`. Include the nested-list example from the spec.

- [ ] **Step 2: README — everything that called this missing**

- `### Known limits` — delete "There is no `$parents[2]` yet: `$parent` reaches one level up, and no further — see Limits and non-goals."
- The migration table — `$parents[2]` becomes **identical**; add a `$parentContext` row, also identical.
- `## Limits and non-goals` — `$parents[n]` comes out of the two-gaps paragraph, leaving components as the only entry. Reword the lead-in, which currently says "Two things are gaps rather than choices".
- The `Things that will catch you` table — add a row: writing to `$parents[0]` or a context warns and does nothing, because both are frozen; write to ancestor *data* instead.

- [ ] **Step 3: Amend the components spec so the two cannot drift**

In `docs/superpowers/specs/2026-08-18-component-params-design.md`, in the `$component` section, add:

```markdown
`createComponentContext` must also set `$parentContext` to the enclosing context, exactly as
`createChildContext` does, so `$parents` walks correctly across a component boundary. Added in
0.6.0; see the ancestors spec.
```

- [ ] **Step 4: Check every anchor still resolves**

```bash
grep -oE '\]\(#[a-z0-9-]+\)' README.md | sed 's/](#//; s/)//' | sort -u > /tmp/used.txt
grep -E '^#{1,4} ' README.md | sed -E 's/^#+ //' | tr 'A-Z' 'a-z' | sed -E 's/[^a-z0-9 -]//g; s/ +/-/g' | sort -u > /tmp/have.txt
comm -23 /tmp/used.txt /tmp/have.txt
```

Expected: no output.

- [ ] **Step 5: Commit**

```bash
git add README.md docs
git commit -m "docs: document \$parents and \$parentContext"
```

---

### Task 7: Release 0.6.0

**Files:**
- Modify: `CHANGELOG.md`, `package.json`, `package-lock.json`

`preflight` runs *after* the bump is committed, because it checks the version about to be published rather than the last one. npm will not reuse a version number.

- [ ] **Step 1: Bump**

```bash
make bump V=0.6.0
```

Expected: `0.5.2 → 0.6.0  (package.json, package-lock.json)`. It deliberately does not commit.

- [ ] **Step 2: Changelog**

`## [0.6.0] - YYYY-MM-DD` at the top, in the shape of the existing entries. `### Added` for both names, with the nested-list example. `### Fixed` for the frozen-write guard, noting it changes a throw into a warning.

- [ ] **Step 3: Commit the bump and the entry together**

```bash
git add package.json package-lock.json CHANGELOG.md
git commit -m "Release 0.6.0 — \$parents[n] and \$parentContext"
```

- [ ] **Step 4: Preflight**

```bash
make preflight
```

Expected: `preflight: clean, not behind origin, 0.6.0 unpublished, artefacts verified` and `all 31 exports verified`. Thirty-one is correct — these are context names, not exports.

- [ ] **Step 5: Re-measure the bundle**

```bash
gzip -c dist/domma-reactive.min.js | wc -c
stat -c%s dist/domma-reactive.min.js dist/domma-reactive.esm.js
```

Compare against the README's opening line (`18 KB gzipped`) and its install table (54 KB / 54 KB / 280 KB). This change is tiny, but nothing in the build asserts these figures — which is exactly how they drifted 20% stale between 0.5.0 and 0.5.2. If a rounded number moved, amend the release commit and re-run `preflight`.

- [ ] **Step 6: Publish, then tag — but ask first**

```bash
make release-npm    # publishes to npm; irreversible
make release-gh     # pushes main, creates and pushes the v0.6.0 tag
```

**Confirm with the author before `release-npm`.** A published version cannot be replaced, only deprecated and superseded.

- [ ] **Step 7: Re-pin in the host**

```bash
cd ../domma && npm install domma-reactive@0.6.0 --save-exact && npm run build:js
```

Domma pins this package exactly, so a release is not finished until the host picks it up.
