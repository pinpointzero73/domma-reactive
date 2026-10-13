// @vitest-environment jsdom
/**
 * Placeholders in ordinary attributes are written as text (setAttribute), so they
 * must not carry the HTML escaping the renderer applies for innerHTML (2026-10-13:
 * "Tom & Jerry" read "Tom &amp; Jerry" in every title/aria-label of a data-each row).
 */
import {test, expect} from 'vitest';
import * as M from './index.js';
import {decodeAttribute} from './entities.js';

const tick = () => new Promise((r) => setTimeout(r, 20));

test('a data-each row attribute shows the value as typed', async () => {
    document.body.innerHTML = '<div id="r"><ul data-each="rows.value key=id"><li data-id="{{id}}" title="T &amp; {{title}}" aria-label="Actions for {{title}}"><b>{{title}}</b></li></ul></div>';
    const rows = M.observable([{id: 'a', title: 'Tom & Jerry <x> "q" \'s/'}]);
    M.applyBindings({rows}, document.getElementById('r'));
    await tick();
    const li = document.querySelector('li');
    expect(li.getAttribute('aria-label')).toBe('Actions for Tom & Jerry <x> "q" \'s/');
    expect(li.getAttribute('title')).toBe('T & Tom & Jerry <x> "q" \'s/');
    expect(li.querySelector('b').textContent).toBe('Tom & Jerry <x> "q" \'s/');
    rows.value = [{id: 'a', title: 'A&amp;B'}];
    await tick();
    expect(document.querySelector('li').getAttribute('aria-label')).toBe('Actions for A&amp;B', 'an entity typed by a user stays literal: decoded once only');
});

test('decodeAttribute decodes one level, left to right', () => {
    expect(decodeAttribute('a &amp;lt; b')).toBe('a &lt; b');
    expect(decodeAttribute('&lt;&#39;&#x27;&#47;&#x2F;&quot;')).toBe('<\'\'//"');
    expect(decodeAttribute('plain')).toBe('plain');
});
