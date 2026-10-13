/**
 * Entity decoding for attribute values - shared by the compiler (expression attributes) and the attr
 * handler (placeholders in ordinary attributes, written with setAttribute). Leaf module: no imports.
 *
 * @module domma-reactive/entities
 */

/**
 * The entities a serialiser can put into an attribute value, and their text.
 *
 * `&amp;` is in the same alternation as the rest rather than applied afterwards,
 * because ONE pass is what makes the order safe: scanning left to right, the
 * `&amp;` in `&amp;lt;` is consumed and the scan resumes after it, so the
 * remaining `lt;` is plain text and the result is the literal `&lt;`. Decoding
 * in two passes - entities, then `&amp;` - would turn it into `<`, which is the
 * classic double-decode and a real bug in a template compiler.
 */
const ENTITY = /&(?:lt|gt|quot|apos|nbsp|amp|#39|#x27|#47|#x2[Ff]|#96|#x60);/g;
const ENTITY_TEXT = {
    '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'",
    '&#39;': "'", '&#x27;': "'", '&nbsp;': ' ', '&amp;': '&',
    '&#47;': '/', '&#x2F;': '/', '&#x2f;': '/', '&#96;': '`', '&#x60;': '`'
};

/**
 * An attribute value, as the DOM would have given it to getAttribute().
 *
 * An HTML attribute value is entity-encoded text, so `data-bind-class="a &amp;&amp;
 * b"` and `data-bind-class="a && b"` are the same attribute and a browser hands
 * both to getAttribute() as `a && b`. This compiler reads attributes out of a
 * STRING and so has to do that decoding itself; without it the two spellings
 * behave differently, which is the one thing HTML says they cannot.
 *
 * It is not a corner case reached only by typing an entity on purpose.
 * Serialising DOM back to HTML escapes every `&` it writes, and `el.innerHTML`
 * is exactly how applyBindings captures a `data-each` body - so an ordinary
 * `data-bind-class="done && 'struck'"`, the documented idiom, came back out as
 * `&amp;&amp;` and failed to parse, with no entity anywhere in the author's page.
 *
 * Applied ONLY to values that are parsed as expressions. An ordinary attribute's
 * value is written back into the annotated template, where `&amp;` is correct
 * markup and `&quot;` inside a double-quoted value is load-bearing.
 */
export function decodeAttribute(value) {
    return value.includes('&') ? value.replace(ENTITY, (m) => ENTITY_TEXT[m]) : value;
}

