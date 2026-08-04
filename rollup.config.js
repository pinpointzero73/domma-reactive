import terser from '@rollup/plugin-terser';

/**
 * Three artefacts, because three consumers ask for the code three ways.
 *
 * The `.cjs` extension on the require target is load-bearing, not cosmetic.
 * This package declares `"type": "module"`, which makes Node treat every `.js`
 * file inside it as ESM — including a UMD bundle. A UMD file parsed as ESM has
 * no `export` statements, so `require('domma-reactive')` resolves to an *empty*
 * namespace object rather than throwing: a silent failure for every CommonJS
 * consumer. The `.cjs` extension overrides the `type` field and restores the
 * CommonJS parse.
 */
export default {
    input: 'src/index.js',
    output: [
        {
            // Browser <script> — defines window.DommaReactive.
            file: 'dist/domma-reactive.min.js',
            format: 'umd',
            name: 'DommaReactive',
            plugins: [terser()]
        },
        {
            // Node require() — see the note above on the extension.
            file: 'dist/domma-reactive.cjs',
            format: 'umd',
            name: 'DommaReactive',
            plugins: [terser()]
        },
        {
            // Bundlers and Node import().
            file: 'dist/domma-reactive.esm.js',
            format: 'es'
        }
    ]
};
