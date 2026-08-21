/**
 * The finished contacts app from Tutorial.md, run for real.
 *
 * A tutorial is a promise that the code in it works. That promise rots silently:
 * a rename here, a changed default there, and the page a reader copies out no
 * longer does what the prose says it does - and nothing goes red, because
 * documentation is not on the test path.
 *
 * So it is, here. The markup below is Tutorial.md's `index.html` body and the
 * view model is its `app.js`, both transcribed rather than paraphrased. If a
 * change to the package breaks the tutorial, this file is what says so.
 */

import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {applyBindings} from './apply-bindings.js';
import {registerComponent, unregisterComponent} from './components.js';
import {computed, effect, flushSync} from './graph.js';
import {observable, observableArray} from './observable.js';
import {parseFragment} from './nodes.js';

const GROUPS = ['Family', 'Friends', 'Work'];

/** Tutorial.md - index.html, the body of #app. */
const MARKUP = `
<div id="app">
    <p id="summary"><!-- dm text: summary.value -->loading&hellip;<!-- /dm --></p>

    <form id="new-contact" data-on-submit="save">
        <input id="draft-name"  data-model="draft.name.value"  placeholder="Name">
        <input id="draft-email" data-model="draft.email.value" placeholder="Email">
        <select id="draft-group" data-model="draft.group.value" data-options="groups.value"></select>
        <button id="add" data-bind-disabled="!valid.value">Add</button>
    </form>

    <input id="query" data-model="query.value" placeholder="Search">
    <select id="filter" data-model="filter.value"
            data-options="groups.value"
            data-options-caption="'All groups'"></select>

    <ul id="list" data-each="visible.value key=id">
        <li data-component="'contact-row'"
            data-param-contact="$data"
            data-param-remove="$parent.remove"></li>
    </ul>

    <!-- dm if: empty.value -->
        <p id="none">No contacts match.</p>
    <!-- /dm -->
</div>`;

/** Tutorial.md - app.js, the contact-row component. */
function registerContactRow() {
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
}

/** Tutorial.md - app.js. */
function createApp() {
    registerContactRow();

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

    const contacts = observableArray([]);
    const groups = observable(GROUPS);
    const query = observable('').extend({rateLimit: 200});
    const filter = observable('');

    const draft = {
        name: observable(''),
        email: observable(''),
        group: observable(GROUPS[0])
    };

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

    return {vm, make, contacts};
}

let host;
let handle;

beforeEach(() => {
    host = document.createElement('div');
    host.appendChild(parseFragment(MARKUP));
    document.body.appendChild(host);
});

afterEach(() => {
    handle?.dispose();
    handle = null;
    host.remove();
    unregisterComponent('contact-row');
    localStorage.clear();
});

const one = (sel) => host.querySelector(sel);
const all = (sel) => [...host.querySelectorAll(sel)];
const fire = (el, type) => el.dispatchEvent(new window.Event(type, {bubbles: true, cancelable: true}));

/** Type into a control the way a person does: set it, then tell the page. */
const type = (el, value) => {
    el.value = value;
    fire(el, 'input');
};

describe('Tutorial.md - the contacts app', () => {
    it('starts empty and says so', () => {
        const {vm} = createApp();
        handle = applyBindings(vm, one('#app'));

        expect(one('#summary').textContent.trim()).toBe('0 contact(s), 0 shown');
        expect(one('#none')).not.toBeNull();
        expect(all('#list li')).toHaveLength(0);
    });

    it('fills both selects from the group list, the filter with a caption', () => {
        const {vm} = createApp();
        handle = applyBindings(vm, one('#app'));

        expect(all('#draft-group option').map((o) => o.textContent))
            .toEqual(['Family', 'Friends', 'Work']);
        expect(all('#filter option').map((o) => o.textContent))
            .toEqual(['All groups', 'Family', 'Friends', 'Work']);
    });

    it('keeps Add disabled until the draft is valid', () => {
        const {vm} = createApp();
        handle = applyBindings(vm, one('#app'));

        expect(one('#add').disabled).toBe(true);

        type(one('#draft-name'), 'Ada');
        flushSync();
        expect(one('#add').disabled).toBe(true);         // no email yet

        type(one('#draft-email'), 'ada@example.com');
        flushSync();
        expect(one('#add').disabled).toBe(false);
    });

    it('adds a contact and clears the draft', () => {
        const {vm} = createApp();
        handle = applyBindings(vm, one('#app'));

        type(one('#draft-name'), 'Ada');
        type(one('#draft-email'), 'ada@example.com');
        fire(one('#new-contact'), 'submit');
        flushSync();

        expect(all('#list li')).toHaveLength(1);
        expect(one('#list li .show').textContent).toBe('Ada - ada@example.com');
        expect(one('#draft-name').value).toBe('');
        expect(one('#summary').textContent.trim()).toBe('1 contact(s), 1 shown');
        expect(one('#none')).toBeNull();
    });

    it('keeps a row node when another is added above it', () => {
        const {vm, make, contacts} = createApp();
        contacts.push(make({name: 'Ada', email: 'ada@example.com'}));
        handle = applyBindings(vm, one('#app'));

        const ada = one('#list li');
        contacts.unshift(make({name: 'Grace', email: 'grace@example.com'}));
        flushSync();

        expect(all('#list li')).toHaveLength(2);
        expect(all('#list li')[1]).toBe(ada);
    });

    it('filters by group', () => {
        const {vm, make, contacts} = createApp();
        contacts.push(make({name: 'Ada', email: 'a@x.com', group: 'Work'}));
        contacts.push(make({name: 'Grace', email: 'g@x.com', group: 'Family'}));
        handle = applyBindings(vm, one('#app'));

        expect(all('#list li')).toHaveLength(2);

        one('#filter').value = 'Work';
        fire(one('#filter'), 'change');
        flushSync();

        expect(all('#list li')).toHaveLength(1);
        expect(one('#list li .show').textContent).toContain('Ada');
    });

    it('holds the search back until typing stops, then filters', () => {
        vi.useFakeTimers();
        try {
            const {vm, make, contacts} = createApp();
            contacts.push(make({name: 'Ada', email: 'a@x.com'}));
            contacts.push(make({name: 'Grace', email: 'g@x.com'}));
            handle = applyBindings(vm, one('#app'));

            type(one('#query'), 'gra');
            flushSync();
            expect(all('#list li')).toHaveLength(2);      // nothing announced yet

            vi.advanceTimersByTime(200);
            flushSync();
            expect(all('#list li')).toHaveLength(1);
            expect(one('#list li .show').textContent).toContain('Grace');
        } finally {
            vi.useRealTimers();
        }
    });

    it('swaps a row into an editor and focuses it', () => {
        const {vm, make, contacts} = createApp();
        contacts.push(make({name: 'Ada', email: 'a@x.com'}));
        handle = applyBindings(vm, one('#app'));

        expect(one('#list li .show')).not.toBeNull();
        expect(one('#list li .edit')).toBeNull();

        fire(one('#list li .edit-btn'), 'click');
        flushSync();

        const input = one('#list li .edit');
        expect(input).not.toBeNull();
        expect(document.activeElement).toBe(input);
    });

    it('writes an edit straight through to the row', () => {
        const {vm, make, contacts} = createApp();
        contacts.push(make({name: 'Ada', email: 'a@x.com'}));
        handle = applyBindings(vm, one('#app'));

        fire(one('#list li .edit-btn'), 'click');
        flushSync();

        type(one('#list li .edit'), 'Ada Lovelace');
        flushSync();

        expect(contacts.peek()[0].name.peek()).toBe('Ada Lovelace');
    });

    it('leaves the editor when the field loses focus', () => {
        const {vm, make, contacts} = createApp();
        contacts.push(make({name: 'Ada', email: 'a@x.com'}));
        handle = applyBindings(vm, one('#app'));

        fire(one('#list li .edit-btn'), 'click');
        flushSync();

        one('#list li .edit').blur();
        flushSync();

        expect(one('#list li .edit')).toBeNull();
        expect(one('#list li .show')).not.toBeNull();
    });

    it('deletes a contact', () => {
        const {vm, make, contacts} = createApp();
        contacts.push(make({name: 'Ada', email: 'a@x.com'}));
        contacts.push(make({name: 'Grace', email: 'g@x.com'}));
        handle = applyBindings(vm, one('#app'));

        fire(all('#list li .del')[0], 'click');
        flushSync();

        expect(all('#list li')).toHaveLength(1);
        expect(one('#list li .show').textContent).toContain('Grace');
    });

    it('shows the empty note when a search matches nothing', () => {
        vi.useFakeTimers();
        try {
            const {vm, make, contacts} = createApp();
            contacts.push(make({name: 'Ada', email: 'a@x.com'}));
            handle = applyBindings(vm, one('#app'));

            type(one('#query'), 'zzz');
            vi.advanceTimersByTime(200);
            flushSync();

            expect(all('#list li')).toHaveLength(0);
            expect(one('#none')).not.toBeNull();
        } finally {
            vi.useRealTimers();
        }
    });

    it('reloads stored contacts without colliding on an id', () => {
        localStorage.setItem('contacts', JSON.stringify([
            {id: 4, name: 'Ada', email: 'a@x.com', group: 'Work'},
            {id: 7, name: 'Grace', email: 'g@x.com', group: 'Family'}
        ]));

        const {vm, make, contacts} = createApp();
        for (const row of JSON.parse(localStorage.getItem('contacts') || '[]')) {
            contacts.push(make(row));
        }
        handle = applyBindings(vm, one('#app'));

        expect(all('#list li')).toHaveLength(2);
        expect(contacts.peek().map((c) => c.id)).toEqual([4, 7]);

        // The counter has to clear the stored ids, or a new contact reuses one
        // and two rows share a key.
        contacts.push(make({name: 'Katherine', email: 'k@x.com'}));
        expect(contacts.peek()[2].id).toBe(8);
    });

    it('persists to localStorage, including an edit made in place', () => {
        const {vm, make, contacts} = createApp();

        const save = effect(() => {
            localStorage.setItem('contacts', JSON.stringify(
                contacts.value.map((c) => ({
                    id: c.id, name: c.name.value, email: c.email.value, group: c.group.value
                }))
            ));
        });

        handle = applyBindings(vm, one('#app'));

        contacts.push(make({name: 'Ada', email: 'a@x.com', group: 'Work'}));
        flushSync();
        expect(JSON.parse(localStorage.getItem('contacts'))).toEqual([
            {id: 1, name: 'Ada', email: 'a@x.com', group: 'Work'}
        ]);

        contacts.peek()[0].name.value = 'Ada Lovelace';
        flushSync();
        expect(JSON.parse(localStorage.getItem('contacts'))[0].name).toBe('Ada Lovelace');

        save.dispose();
    });
});

describe('Tutorial.md - step 11, the row as a component', () => {
    /** Two contacts, bound, ready to edit. */
    function twoRows() {
        const {vm, make, contacts} = createApp();
        contacts.push(make({name: 'Ada', email: 'ada@example.com'}));
        contacts.push(make({name: 'Grace', email: 'grace@example.com'}));
        handle = applyBindings(vm, one('#app'));
        flushSync();
        return {vm, contacts};
    }

    it('renders one card per contact', () => {
        twoRows();

        expect(all('#list li')).toHaveLength(2);
        expect(all('#list .show').map((s) => s.textContent.trim()))
            .toEqual(['Ada - ada@example.com', 'Grace - grace@example.com']);
    });

    it('keeps editing private to the row, so one card at a time is an input', () => {
        twoRows();

        fire(all('#list .edit-btn')[0], 'click');
        flushSync();

        expect(all('#list .edit')).toHaveLength(1);
        expect(all('#list .show')).toHaveLength(1);
        expect(all('#list li')[1].querySelector('.show')).not.toBeNull();
    });

    it('no longer holds an editing flag on the contact itself', () => {
        const {contacts} = twoRows();

        expect(contacts.value[0].editing).toBeUndefined();
        expect(Object.keys(contacts.value[0]).sort())
            .toEqual(['email', 'group', 'id', 'name']);
    });

    it('writes an edit back through the observable it was passed', () => {
        const {contacts} = twoRows();

        fire(all('#list .edit-btn')[0], 'click');
        flushSync();
        type(one('#list li .edit'), 'Ada Lovelace');
        flushSync();

        expect(contacts.value[0].name.value).toBe('Ada Lovelace');
    });

    it('deletes through the callback the card was given', () => {
        const {contacts} = twoRows();

        fire(all('#list .del')[0], 'click');
        flushSync();

        expect(contacts.value.map((c) => c.name.value)).toEqual(['Grace']);
        expect(all('#list li')).toHaveLength(1);
    });

    it('leaves the surviving card the same DOM node, mid-edit', () => {
        const {contacts} = twoRows();

        fire(all('#list .edit-btn')[1], 'click');
        flushSync();
        const input = all('#list li')[1].querySelector('.edit');
        type(input, 'Grace H');
        flushSync();

        contacts.remove(contacts.value[0]);
        flushSync();

        const rows = all('#list li');
        expect(rows).toHaveLength(1);
        expect(rows[0].querySelector('.edit')).toBe(input);
        expect(input.value).toBe('Grace H');
    });
});
