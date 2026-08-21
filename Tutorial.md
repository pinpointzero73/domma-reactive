# Tutorial - build a contacts system

A step-by-step build of a working contacts page: add, edit in place, search, filter, delete, remember
everything across a reload, and extract the row into a reusable component the page can pass markup into. About 120 lines of JavaScript and one HTML file.

Every listing below is real. The finished application is transcribed into [`src/tutorial.test.js`](src/tutorial.test.js)
and runs on every `npm test`, so if a change to the package breaks this page, something goes red.

**What it teaches**

| Step | Feature |
|------|---------|
| [1](#step-1---the-shape-of-a-contact) | `observable`, `observableArray` |
| [2](#step-2---show-the-list) | `applyBindings`, `data-each`, keyed reconciliation |
| [3](#step-3---add-a-contact) | `data-model`, `data-on-submit`, `computed` for validation |
| [4](#step-4---the-two-drop-downs) | `data-options`, `data-options-caption` |
| [5](#step-5---search-that-waits-for-you-to-stop-typing) | `.extend({rateLimit})` |
| [6](#step-6---edit-in-place) | `data-if`, `data-focus`, per-item bindings |
| [7](#step-7---delete) | `$parent`, `$data`, `observableArray.remove` |
| [8](#step-8---the-empty-state) | virtual bindings - `<!-- dm if: … -->` |
| [9](#step-9---remember-it) | `effect` + `localStorage` |
| [10](#step-10---tidying-up) | disposal |
| [11](#step-11---make-the-row-a-component) | `registerComponent`, `data-component`, params |
| [12](#step-12---let-the-page-supply-the-rows-actions) | `{{#slot}}`, `data-slot`, projected content |

---

## Before you start

```bash
npm install domma-reactive
```

Create two files next to each other: `index.html` and `app.js`. The styling below is plain inline CSS so the page
has no dependencies at all - swap in Tailwind or Bootstrap classes if you would rather, since nothing in this
tutorial depends on how it looks.

```html
<!doctype html>
<html lang="en-GB">
<head>
    <meta charset="utf-8">
    <title>Contacts</title>
    <style>
        body   { font: 16px/1.5 system-ui, sans-serif; max-width: 46rem; margin: 3rem auto; padding: 0 1rem; }
        h1     { margin-bottom: 0; }
        #summary { color: #666; margin-top: .25rem; }
        form, .filters { display: flex; gap: .5rem; margin: 1.5rem 0; }
        input, select, button { font: inherit; padding: .45rem .6rem; border: 1px solid #ccc; border-radius: .35rem; }
        input  { flex: 1; }
        button { cursor: pointer; background: #f4f4f5; }
        button[disabled] { opacity: .45; cursor: not-allowed; }
        ul     { list-style: none; padding: 0; }
        li     { display: flex; align-items: center; gap: .5rem; padding: .6rem .2rem; border-bottom: 1px solid #eee; }
        li .show, li .edit { flex: 1; }
        .group { font-size: .8rem; color: #555; background: #f0f0f2; padding: .1rem .5rem; border-radius: 1rem; }
        #none  { color: #666; font-style: italic; }
    </style>
</head>
<body>
    <div id="app">
        <h1>Contacts</h1>
        <!-- everything below arrives step by step -->
    </div>

    <script type="module" src="./app.js"></script>
</body>
</html>
```

A note on **which package this is**. `domma-reactive` is the reactive core on its own: observables, computeds,
bindings. It has no HTTP client, no storage helper, no form generator and no toasts. Inside the full Domma
framework you would reach for `S.set()` rather than `localStorage`, and `F.create()` rather than hand-written form
markup. Here we use the platform directly, because that is all this package assumes.

---

## Step 1 - the shape of a contact

Start `app.js` with the state. Everything that can change is an `observable`; the collection is an
`observableArray`.

```javascript
import {
    applyBindings, computed, effect, observable, observableArray, registerComponent
} from 'domma-reactive';

const GROUPS = ['Family', 'Friends', 'Work'];

let nextId = 1;

const make = ({name = '', email = '', group = GROUPS[0]} = {}) => ({
    id: nextId++,
    name: observable(name),
    email: observable(email),
    group: observable(group),
    editing: observable(false)
});

const contacts = observableArray([]);
const groups = observable(GROUPS);
```

Two things worth pausing on.

**`id` is a plain number, not an observable.** It is the item's identity, and an identity that can change is not
one. Step 2 hands it to `key=`, and the whole of keyed reconciliation rests on it being stable.

**`editing` lives on the contact.** Whether a row is being edited is per-row state, so it belongs to the row, not
to a "currently editing" field on the page. That is what makes Step 6 fall out in three lines.

Reading and writing an observable is a **property**, never a call:

```javascript
const ada = make({name: 'Ada'});

ada.name.value;              // 'Ada'
ada.name.value = 'Ada L.';   // write
ada.name.peek();             // read without registering a dependency
```

Coming from Knockout, this is the one thing to unlearn: `o.value`, not `o()`. It is what lets a template read an
observable at all, since the expression language in a binding refuses method calls.

---

## Step 2 - show the list

Add the list to `index.html`, inside `#app`:

```html
<ul id="list" data-each="visible.value key=id">
    <li>
        <span class="show">{{name.value}} - {{email.value}}</span>
        <span class="group">{{group.value}}</span>
    </li>
</ul>
```

And in `app.js`, the collection the list draws from, plus the call that brings the page to life:

```javascript
const visible = computed(() => contacts.value);

const vm = {contacts, groups, visible};

const handle = applyBindings(vm, document.querySelector('#app'));
```

Load the page and you get nothing - because `contacts` is empty. Add one from the console
(`contacts.push(make({name: 'Ada', email: 'ada@example.com'}))`) and the row appears.

### What just happened

`applyBindings` activates markup that already exists, in place. It does not generate the page; the page is the
page, and the binding attributes are instructions attached to it. That is why the styling above works on plain
elements with no framework classes.

`data-each="visible.value key=id"` is a **keyed list**. The element's initial contents are its item template: they
are lifted out, compiled once, and cloned per item. Inside that template `{{ }}` works and every expression
resolves against the item - `{{name.value}}` is *this contact's* name.

`key=id` is not decoration and not optional. It is how the list works out, on every change, which rows are the
same rows as before. Rows that survive a change **keep their exact DOM nodes** - so focus, a half-typed input, a
scroll position and a CSS transition all survive with them. Step 6 depends on this completely.

`visible` is a `computed` - a derived value that recomputes only when something it read has changed. Right now it
just passes `contacts` through, which looks pointless. Steps 4 and 5 are why it exists.

> **Why `visible.value` and not `visible`?** No unwrapping, anywhere. A binding reads through `.value` exactly as
> your JavaScript does. `data-each="visible"` would hand the list the computed object rather than an array.

---

## Step 3 - add a contact

The form, in `index.html`, above the list:

```html
<form id="new-contact" data-on-submit="save">
    <input id="draft-name"  data-model="draft.name.value"  placeholder="Name">
    <input id="draft-email" data-model="draft.email.value" placeholder="Email">
    <button id="add" data-bind-disabled="!valid.value">Add</button>
</form>
```

In `app.js`:

```javascript
const draft = {
    name: observable(''),
    email: observable(''),
    group: observable(GROUPS[0])
};

const valid = computed(() =>
    draft.name.value.trim() !== '' && draft.email.value.includes('@'));
```

and on the view model:

```javascript
save() {
    if (!valid.value) return false;

    contacts.push(make({
        name: draft.name.value.trim(),
        email: draft.email.value.trim(),
        group: draft.group.value
    }));

    draft.name.value = '';
    draft.email.value = '';
    return false;
}
```

Remember to add `draft` and `valid` to the `vm` object, or the bindings have nothing to resolve against.

### What just happened

`data-model` is **two-way**: the input shows the value, and typing writes back. It needs a *settable path* -
`draft.name.value` is one, because the binding can evaluate `draft.name` and assign `value` on it. An expression
like `a && b` is not, and would be refused with a warning, because a control you cannot write through is not
two-way.

`data-bind-disabled="!valid.value"` is one-way, into a DOM **property**. Because `valid` is a computed over the two
draft fields, the button enables and disables itself with no code saying so anywhere.

`data-on-submit="save"` calls `vm.save()`. Two details of the event contract earn their keep here:

- The DOM event is passed as the **last** argument, so `save(event)` works, and so does
  `remove(item)` → `remove(item, event)`.
- **Returning `false` calls `preventDefault()`** - which is why the form does not reload the page.

The validation lives in a `computed`, not in the submit handler. The handler still checks it, because a form can be
submitted by pressing Enter in a field, but the *button* and the *check* are now the same single expression rather
than two rules that can drift apart.

---

## Step 4 - the two drop-downs

Add a group picker to the form, and a filter above the list:

```html
<!-- inside the form, before the button -->
<select id="draft-group" data-model="draft.group.value" data-options="groups.value"></select>
```

```html
<div class="filters">
    <select id="filter" data-model="filter.value"
            data-options="groups.value"
            data-options-caption="'All groups'"></select>
</div>
```

```javascript
const filter = observable('');
```

Then widen `visible` so the filter does something:

```javascript
const visible = computed(() => {
    const group = filter.value;
    return contacts.value.filter((c) => group === '' || c.group.value === group);
});
```

### What just happened

`data-options` fills a `<select>` from a collection. `{{#each}}<option>` would produce the same markup - what it
would not produce is the *selection*, which is the whole difficulty: rebuilding a select's options resets it, and
the selection lives on the select rather than on any option. This binding rebuilds and puts the selection back.

`data-options-caption="'All groups'"` adds a leading option whose value is the empty string - which is why `visible`
tests `group === ''` for "no filter". Note the **quotes inside the quotes**: every binding value here is an
expression, so a literal string needs to look like one. `data-options-caption="All groups"` would look for a
variable called `All`.

Two companions you do not need yet, but will:

```html
<select data-options="people.value"
        data-options-text="first + ' ' + last"
        data-options-value="id"></select>
```

Both are expressions evaluated against each item, so `$index` resolves and a label can be computed. Knockout takes a
property *name* here and cannot do that. And when `data-options-value` yields something that is not a string - a
number, or the item object itself - `data-model` reads back **that value**, not `"[object Object]"`.

---

## Step 5 - search that waits for you to stop typing

```html
<!-- in .filters, before the select -->
<input id="query" data-model="query.value" placeholder="Search">
```

```javascript
const query = observable('').extend({rateLimit: 200});
```

and fold it into `visible`:

```javascript
const visible = computed(() => {
    const needle = query.value.trim().toLowerCase();
    const group = filter.value;

    return contacts.value.filter((c) => {
        if (group !== '' && c.group.value !== group) return false;
        if (needle === '') return true;
        return c.name.value.toLowerCase().includes(needle)
            || c.email.value.toLowerCase().includes(needle);
    });
});
```

### What just happened

`.extend({rateLimit: 200})` holds the **notification** back until 200ms after the typing stops. Filtering a list is
cheap here; against a server it would not be, and this is the line that turns eight keystrokes into one query.

The important half is what it does *not* do:

```javascript
query.value = 'ada';
query.value;          // 'ada' - immediately
```

**The write is never delayed, only the announcement.** Knockout's original `throttle` delayed the write itself,
which is why reading a throttled observable used to give you a value that was already out of date, and why they
deprecated it. `throttle` is accepted here as a name and given this behaviour.

The default measures *quiet*: the window restarts on every change, so continuous typing announces nothing until it
stops. If you want "at most once per 200ms, whatever happens", ask for it:

```javascript
observable('').extend({rateLimit: {timeout: 200, method: 'notifyAtFixedRate'}});
```

Because the rate limit is on a timer rather than on the graph's flush, `flushSync()` will not deliver a held
notification - in a test, advance the clock.

---

## Step 6 - edit in place

Replace the row template in `index.html`:

```html
<ul id="list" data-each="visible.value key=id">
    <li>
        <span class="show" data-if="!editing.value">{{name.value}} - {{email.value}}</span>
        <input class="edit" data-if="editing.value" data-model="name.value" data-focus="editing.value">
        <span class="group">{{group.value}}</span>
        <button class="edit-btn" data-on-click="$parent.edit($data)">Edit</button>
    </li>
</ul>
```

```javascript
edit(item) {
    item.editing.value = true;
}
```

Click **Edit** and the row becomes an input, already focused, with the caret in it. Click away and it turns back
into text, with the change kept.

### What just happened

This is the step that pays for `key=id`.

`data-if` puts the element in the document or takes it out - it does not hide it with CSS, because an element
hidden with CSS is still focusable and still read aloud by a screen reader, and a binding named after a conditional
that leaves it there would be lying.

`data-focus` is two-way, like `data-model`, but for focus: setting `editing.value = true` moves the caret into the
field, and the field losing focus writes `false` back. That single binding is the whole "click away to finish
editing" behaviour - there is no blur handler anywhere. (Knockout calls this `hasFocus`.)

`$parent.edit($data)` is how a row reaches the page it lives on. Inside a list `$data` is the *item*, so `$parent`
is the view model and `$data` is the contact that was clicked. This is also the one place a binding may **call** a
method: an event fires outside every effect, so a call there cannot cause a render to have side effects.

And the reason it all holds together: because the list is keyed, typing in that input survives anything happening
to the collection. Add a contact from another tab, sort the list, let a search re-run - the row being edited is the
same DOM node it was, so the caret does not move and the half-typed name is not lost. Without `key=`, every one of
those events would rebuild the row and throw the edit away.

---

## Step 7 - delete

```html
<!-- after the Edit button -->
<button class="del" data-on-click="$parent.remove($data)">Delete</button>
```

```javascript
remove(item) {
    contacts.remove(item);
}
```

`observableArray.remove()` takes **either a value or a test**:

```javascript
contacts.remove(ada);                       // that exact object, by identity
contacts.remove((c) => c.group.value === 'Work');   // everything the test accepts
```

The row disappears and its instance is disposed - nodes *and* the effects behind its bindings. That second half
matters: an effect is a live node in the dependency graph and dropping the DOM does not drop it.

There is also `destroy()`, which **marks** an item `_destroy: true` and leaves it in the collection. That is for
servers that delete on a flag in the payload (Rails' `accepts_nested_attributes_for`), so the array must still
carry the item at submit time while no longer showing it - every render path here skips a marked one. Unless you
are talking to such a server, `remove()` is the one you want.

---

## Step 8 - the empty state

After the `<ul>`:

```html
<!-- dm if: empty.value -->
    <p id="none">No contacts match.</p>
<!-- /dm -->
```

```javascript
const empty = computed(() => visible.value.length === 0);
```

### What just happened

That is a **virtual binding** - a binding delimited by comments rather than attached to an element. Here it is
merely tidy, but the reason it exists is the case where there is no element to spare: a run of `<li>`s, three
`<td>`s in a row. Wrapping them in a `<div>` to carry a `data-if` changes the layout, and inside a table it is not
even valid HTML that a browser will keep.

Every closer is `<!-- /dm -->`, whatever it opened. `if`, `each` and `text` all work:

```html
<p>Signed in as <!-- dm text: user.name.value -->…<!-- /dm -->.</p>
```

They nest, and a block held out of the document keeps its nodes together, so a nested block that changes while its
parent is closed still lands correctly when the parent reopens.

Knockout spells this `<!-- ko if: x --> … <!-- /ko -->`.

---

## Step 9 - remember it

```javascript
const KEY = 'contacts';

const snapshot = () => contacts.value.map((c) => ({
    id: c.id,
    name: c.name.value,
    email: c.email.value,
    group: c.group.value
}));

const saved = effect(() => {
    localStorage.setItem(KEY, JSON.stringify(snapshot()));
});
```

and to load, before `applyBindings`:

```javascript
const stored = JSON.parse(localStorage.getItem(KEY) || '[]');
for (const row of stored) contacts.push(make(row));
```

### What just happened

An `effect` runs immediately, collects whatever it read, and re-runs when any of it changes. `snapshot()` reads
`contacts.value` **and** `.value` on every field of every contact - so the effect depends on all of them, and an
edit made in Step 6 persists just as an addition does. Nothing had to say "also save when a name changes".

Note that `nextId` restarts at 1 on reload while the stored rows already have ids. Give `make` the stored id when
there is one, and keep the counter ahead of it:

```javascript
const make = ({id, name = '', email = '', group = GROUPS[0]} = {}) => {
    if (id !== undefined) nextId = Math.max(nextId, id + 1);
    return {
        id: id ?? nextId++,
        name: observable(name),
        // …
    };
};
```

Two ids that collide would give two rows the same key, which the list warns about and then keeps apart by
position - correct on screen, but with reconciliation quietly switched off for them.

---

## Step 10 - tidying up

`applyBindings` returns a handle:

```javascript
const handle = applyBindings(vm, document.querySelector('#app'));

// later, when the page or component goes away
handle.dispose();
saved.dispose();
```

`dispose()` drops every effect, listener, list instance and marker it created, and leaves the markup as it found
it. Effects you created yourself - `saved`, above - are yours to stop.

On a page that lives until the tab closes this is academic. In a single-page application that swaps views, skipping
it is a leak that is invisible in the DOM: the markup looks right while the dependency graph grows without bound
and effects go on recomputing against nodes no document contains.

| Created by | Torn down by |
|------------|--------------|
| `effect(fn)` | `.dispose()` on what it returned |
| `applyBindings(…)` | `handle.dispose()` |
| `compile(…)` | `controller.destroy()` |
| `observable.subscribe(fn)` | the returned `off()` |

---

## Step 11 - make the row a component

The row works, but look at where its state lives. `editing` is a field on the *contact*, sitting alongside `name` and
`email` as though whether you happen to be editing someone were a fact about them. And `edit()` is a method on the page,
reached from the row as `$parent.edit($data)`.

Both are there because a `data-each` body has nowhere else to put them. A component does.

Register one in `app.js`:

```javascript
import {registerComponent} from 'domma-reactive';

registerComponent('contact-row', {
    template: `
        <span class="show" data-if="!editing.value">{{contact.name.value}} - {{contact.email.value}}</span>
        <input class="edit" data-if="editing.value"
               data-model="contact.name.value" data-focus="editing.value">
        <span class="group">{{contact.group.value}}</span>
        <button class="edit-btn" data-on-click="edit">Edit</button>
        <button class="del" data-on-click="remove">Delete</button>`,

    create({contact, remove}) {
        const editing = observable(false);

        return {
            contact,
            editing,
            edit() { editing.value = true; },
            remove() { remove(contact); }
        };
    }
});
```

Then shrink the row in `index.html` to the one line that says what it is:

```html
<ul id="list" data-each="visible.value key=id">
    <li data-component="'contact-row'"
        data-param-contact="$data"
        data-param-remove="$parent.remove"></li>
</ul>
```

Two things come out of `app.js` and do not go back. `make()` loses `editing`:

```javascript
return {
    id: id ?? nextId++,
    name: observable(name),
    email: observable(email),
    group: observable(group)
};
```

and the view model loses `edit()` entirely.

The page behaves exactly as it did.

### What just happened

**`editing` became private.** Each card creates its own, in its own `create()`. Ten rows have ten of them and none can
see the others - which was already true in spirit, and is now true in the code. A contact is once again just a contact:
`name`, `email`, `group`, `id`. Nothing about the interface is stored on the data any more.

**The card was given what it needs and nothing else.** `data-param-contact="$data"` hands it the contact;
`data-param-remove="$parent.remove"` hands it a way to say "delete me". It cannot reach the search box, the filter or
the rest of the list, because it was never given them. `$parent.edit($data)` could reach all of it.

**The edit still writes through to the page**, because `data-param-contact="$data"` passes the contact *by reference* -
so `contact.name` inside the card is the same observable `visible` reads. That is the rule worth remembering:

| Markup | The card receives | Can it write back? |
|--------|-------------------|--------------------|
| `data-param-contact="$data"` | the contact itself | **yes** |
| `data-param-name="name.value"` | a copy of the string | no |

Nothing decides this - they are different expressions, and the difference is the same `.value` you have been reading
through since Step 1.

**The name is in quotes** - `data-component="'contact-row'"` - because every binding value here is an expression, and
without them it would name a *variable* called `contact-row`. The cost is a pair of quotes. What it buys is that
`data-component="whichRow.value"` would swap the component when the observable changed, which is worth far more than
the quotes cost.

**Keyed reconciliation still holds.** The card mid-edit keeps its DOM node when another contact is deleted, with the
caret where it was and the half-typed name intact - the same guarantee `key=id` bought in Step 6, now with the
component's own state riding along inside it. Delete a row and its card is disposed with it: view model first, then its
effects, then its nodes.

If the card needed to clean something up - a timer, a subscription, a listener on `window` - it would return a
`dispose()` and that would be called at exactly that moment. That is the only lifecycle hook there is, which is
deliberate.

---

## Step 12 - let the page supply the row's actions

Look at what Step 11 had to do to make Delete work. The card renders the button:

```html
<button class="del" data-on-click="remove">Delete</button>
```

but the card cannot delete anything - the list is not its to change. So the page passes a function in:

```html
<li data-component="'contact-row'"
    data-param-contact="$data"
    data-param-remove="$parent.remove"></li>
```

and the card wraps it back up again:

```javascript
remove() { remove(contact); }
```

Three pieces of machinery, all so a button the card does not own can appear inside it. Let the page write the button
instead.

Give the card a slot in `app.js`:

```javascript
        <button class="edit-btn" data-on-click="edit">Edit</button>
        {{#slot actions}}{{/slot}}`,

    create({contact}) {
        const editing = observable(false);

        return {
            contact,
            editing,
            edit() { editing.value = true; }
        };
    }
```

and put the button in `index.html`, inside the row:

```html
<ul id="list" data-each="visible.value key=id">
    <li data-component="'contact-row'" data-param-contact="$data">
        <button class="del" data-slot="actions"
                data-on-click="$parent.remove($data)">Delete</button>
    </li>
</ul>
```

`data-param-remove` and the card's `remove()` both disappear. The page behaves exactly as it did.

### What just happened

**The button went where its behaviour already was.** `$parent.remove($data)` is the same expression Step 7 used before
there was a component at all. It works here because projected content is compiled by the *page*, in the row context it
is written in - so `$data` is still the contact and `$parent` is still the view model. The card is not involved.

**The card stopped deciding what a row can do.** Adding an Archive button now means editing `index.html`, not the
component. That is the difference a slot makes: `{{#slot actions}}` says *something goes here* without saying what.

**Two scopes, one hole.** Everything inside `{{#slot actions}}` in the template would read the card's view model;
everything the page projects reads the page. Here the slot is empty and the page fills it, so `$parent.remove` resolves
against the page - which is why no callback was needed.

If the card wanted a sensible default it would put one between the tags:

```html
{{#slot actions}}<button data-on-click="edit">Edit</button>{{/slot}}
```

and that button, being the card's own markup, would call the card's `edit()`.

**The keyed list still holds.** Delete a contact and the card being edited keeps its DOM node, its caret and its
half-typed name - now with the page's own button riding along inside it. The projected content is moved, never rebuilt,
so it survives everything the reconciler does around it.

---

## The finished files

### `index.html`

```html
<div id="app">
    <h1>Contacts</h1>
    <p id="summary"><!-- dm text: summary.value -->loading&hellip;<!-- /dm --></p>

    <form id="new-contact" data-on-submit="save">
        <input id="draft-name"  data-model="draft.name.value"  placeholder="Name">
        <input id="draft-email" data-model="draft.email.value" placeholder="Email">
        <select id="draft-group" data-model="draft.group.value" data-options="groups.value"></select>
        <button id="add" data-bind-disabled="!valid.value">Add</button>
    </form>

    <div class="filters">
        <input id="query" data-model="query.value" placeholder="Search">
        <select id="filter" data-model="filter.value"
                data-options="groups.value"
                data-options-caption="'All groups'"></select>
    </div>

    <ul id="list" data-each="visible.value key=id">
        <li data-component="'contact-row'" data-param-contact="$data">
            <button class="del" data-slot="actions"
                    data-on-click="$parent.remove($data)">Delete</button>
        </li>
    </ul>

    <!-- dm if: empty.value -->
        <p id="none">No contacts match.</p>
    <!-- /dm -->
</div>
```

### `app.js`

```javascript
import {
    applyBindings, computed, effect, observable, observableArray
} from 'domma-reactive';

const GROUPS = ['Family', 'Friends', 'Work'];
const KEY = 'contacts';

let nextId = 1;

const make = ({id, name = '', email = '', group = GROUPS[0]} = {}) => {
    if (id !== undefined) nextId = Math.max(nextId, id + 1);
    return {
        id: id ?? nextId++,
        name: observable(name),
        email: observable(email),
        group: observable(group)
    };
};

// ── The row component ────────────────────────────────────────────────────────

registerComponent('contact-row', {
    template: `
        <span class="show" data-if="!editing.value">{{contact.name.value}} - {{contact.email.value}}</span>
        <input class="edit" data-if="editing.value"
               data-model="contact.name.value" data-focus="editing.value">
        <span class="group">{{contact.group.value}}</span>
        <button class="edit-btn" data-on-click="edit">Edit</button>
        {{#slot actions}}{{/slot}}`,

    create({contact}) {
        const editing = observable(false);

        return {
            contact,
            editing,
            edit() { editing.value = true; }
        };
    }
});

// ── State ────────────────────────────────────────────────────────────────────

const contacts = observableArray([]);
const groups   = observable(GROUPS);
const query    = observable('').extend({rateLimit: 200});
const filter   = observable('');

const draft = {
    name:  observable(''),
    email: observable(''),
    group: observable(GROUPS[0])
};

// ── Derived ──────────────────────────────────────────────────────────────────

const visible = computed(() => {
    const needle = query.value.trim().toLowerCase();
    const group = filter.value;

    return contacts.value.filter((c) => {
        if (group !== '' && c.group.value !== group) return false;
        if (needle === '') return true;
        return c.name.value.toLowerCase().includes(needle)
            || c.email.value.toLowerCase().includes(needle);
    });
});

const valid = computed(() =>
    draft.name.value.trim() !== '' && draft.email.value.includes('@'));

const summary = computed(() =>
    `${contacts.length} contact(s), ${visible.value.length} shown`);

const empty = computed(() => visible.value.length === 0);

// ── View model ───────────────────────────────────────────────────────────────

const vm = {
    contacts, groups, query, filter, draft, visible, valid, summary, empty,

    save() {
        if (!valid.value) return false;

        contacts.push(make({
            name: draft.name.value.trim(),
            email: draft.email.value.trim(),
            group: draft.group.value
        }));

        draft.name.value = '';
        draft.email.value = '';
        return false;
    },

    remove(item) {
        contacts.remove(item);
    }
};

// ── Go ───────────────────────────────────────────────────────────────────────

for (const row of JSON.parse(localStorage.getItem(KEY) || '[]')) {
    contacts.push(make(row));
}

const saved = effect(() => {
    localStorage.setItem(KEY, JSON.stringify(contacts.value.map((c) => ({
        id: c.id, name: c.name.value, email: c.email.value, group: c.group.value
    }))));
});

const handle = applyBindings(vm, document.querySelector('#app'));
```

---

## Things that will catch you

| Symptom | Cause | Fix |
|---------|-------|-----|
| A field shows `[object Object]` | Bound the observable, not its value | `data-model="name.value"` |
| Ticking a checkbox changes nothing | The field on the item is not reactive | `done: observable(false)`, bind `done.value` |
| `{{name}}` appears literally on the page | `applyBindings` never interpolates mustache, except inside a `data-each` body | `data-bind-text="name.value"` |
| The list renders nothing, with a warning | No `key=` | `data-each="rows.value key=id"` |
| `data-options` renders nothing | Handed the observable rather than the array | `data-options="groups.value"` |
| The caption looks for a variable | A binding value is an expression | `data-options-caption="'All groups'"` |
| `{{total.get()}}` will not parse | An expression cannot call a method | `total.value` |
| A binding is silently skipped | Its expression did not parse - look for the warning | The warning names the expression |
| Editing an object in place changes nothing | The change gate compares old and new, which are the same reference | Produce a new value |
| `data-component` warns that the name is not a string | A binding value is an expression, so it read a *variable* | `data-component="'contact-row'"` |
| A card's params are all `undefined` | `data-param-*` on an element with no `data-component` | Check the component attribute is there and spelled right |
| Projected markup does not appear | The component has no `{{#slot}}`, or the names do not match | Look for the warning - it names the slot it could not find |
| Projected content reads the wrong data | It resolves against the **page**, not the card | That is the rule; pass a param if the card must supply it |
| An edit inside a card does not reach the page | The param passed a copy: `data-param-name="name.value"` | Pass the observable: `data-param-contact="$data"` |

Nothing in the binding layer throws on bad input. Every failure above logs exactly one warning naming the
expression, and skips that binding alone.

---

## Where next

- [README](README.md) - the full API, and the reasoning behind each decision
- [Coming from Knockout](README.md#coming-from-knockout) - a spelling-by-spelling map
- [Keyed lists](README.md#keyed-lists) - what reconciliation guarantees, and what it does not
- [Components](README.md#components) - both param spellings, `$component`, swapping and disposal
- [Slots](README.md#slots) - fallback content, the two-scopes rule, and why it is a block not an element
- [Expressions](README.md#expressions) - exactly what a binding value may contain, and why the list stops there

If you would rather generate the markup than annotate it, `compile()` is the same machinery pointed the other way:
it turns a mustache template into DOM. `applyBindings` was the right choice here because the page owns its
markup - a server-rendered contacts page would work unchanged.
