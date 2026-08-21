/**
 * The README's component examples, transcribed.
 *
 * README.md claims these run. This is where that claim is kept honest — the
 * same reason src/tutorial.test.js exists. A paraphrase here would defeat the
 * point, so the markup and the definitions are copied rather than adapted.
 */

import {afterEach, describe, expect, it} from 'vitest';

import {compile} from './template-compiler.js';
import {computed} from './graph.js';
import {flushSync} from './graph.js';
import {observable} from './observable.js';
import {registerComponent, unregisterComponent} from './components.js';

afterEach(() => {
    unregisterComponent('contact-card');
    unregisterComponent('badge');
});

function mount(markup, data) {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const controller = compile(markup, data, host, undefined, {reactive: true});
    return {host, controller};
}

describe('the README contact-card example', () => {
    function register() {
        registerComponent('contact-card', {
            template: `
                <div class="card">
                    <b data-bind-text="contact.name.value"></b>
                    <button data-on-click="toggle" data-bind-text="label.value"></button>
                    <input data-if="editing.value" data-model="contact.name.value">
                </div>`,

            create(params) {
                const editing = observable(false);

                return {
                    contact: params.contact,
                    editing,
                    label: computed(() => (editing.value ? 'done' : 'edit')),
                    toggle() { editing.value = !editing.value; }
                };
            }
        });
    }

    it('renders the contact passed as a param', () => {
        register();
        const {host} = mount(
            `<div data-component="'contact-card'" data-param-contact="$data"></div>`,
            {name: observable('Ada')}
        );

        expect(host.querySelector('b').textContent).toBe('Ada');
        expect(host.querySelector('button').textContent).toBe('edit');
    });

    it('toggles its own editing state, revealing the input', () => {
        register();
        const {host} = mount(
            `<div data-component="'contact-card'" data-param-contact="$data"></div>`,
            {name: observable('Ada')}
        );

        expect(host.querySelector('input')).toBeNull();

        host.querySelector('button').click();
        flushSync();

        expect(host.querySelector('input')).not.toBeNull();
        expect(host.querySelector('button').textContent).toBe('done');
    });

    it('gives each card its own editing state', () => {
        register();
        const rows = [{id: 1, name: observable('Ada')}, {id: 2, name: observable('Grace')}];
        const {host} = mount(
            `{{#each rows key=id}}<div data-component="'contact-card'" data-param-contact="$data"></div>{{/each}}`,
            {rows}
        );
        flushSync();

        const buttons = [...host.querySelectorAll('button')];
        expect(buttons.length).toBe(2);

        buttons[0].click();
        flushSync();

        expect(host.querySelectorAll('input').length).toBe(1);
        expect(buttons[0].textContent).toBe('done');
        expect(buttons[1].textContent).toBe('edit');
    });

    it('writes the edited name back to the parent, because the param is an observable', () => {
        register();
        const contact = {name: observable('Ada')};
        const {host} = mount(
            `<div data-component="'contact-card'" data-param-contact="$data"></div>`,
            contact
        );

        host.querySelector('button').click();
        flushSync();

        const input = host.querySelector('input');
        input.value = 'Grace';
        input.dispatchEvent(new Event('input', {bubbles: true}));
        flushSync();

        expect(contact.name.value).toBe('Grace');
    });
});

describe('the README badge example', () => {
    it('renders a template-only component with params as $data', () => {
        registerComponent('badge', {template: '<b class="badge" data-bind-text="label"></b>'});

        const {host} = mount(
            `<span data-component="'badge'" data-param-label="status"></span>`,
            {status: 'active'}
        );

        expect(host.querySelector('b').textContent).toBe('active');
        expect(host.querySelector('b').className).toBe('badge');
    });
});
