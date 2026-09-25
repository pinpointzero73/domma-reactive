import {readFileSync} from 'node:fs';
import terser from '@rollup/plugin-terser';

const {version} = JSON.parse(readFileSync('./package.json', 'utf8'));

/**
 * A banner naming the version, on every artefact.
 *
 * Without it a built file is anonymous: handed `domma-reactive.min.js` there is
 * no way to tell which release it is, and a stale `dist/` is indistinguishable
 * from a fresh one. terser's `comments: 'some'` keeps a bang-comment banner
 * through minification, so the two minified bundles carry it as well as the
 * ESM one.
 *
 * scripts/verify-dist.mjs asserts this matches package.json, which is what
 * turns the banner from a nicety into a check.
 */
const banner =
    `/*! domma-reactive v${version} | MIT | https://github.com/pinpointzero73/domma-reactive */`;

/**
 * The type declarations, shipped beside the bundles.
 *
 * One hand-written source, two copies, and the second copy is not redundant.
 * Under `"type": "module"` TypeScript reads a `.d.ts` as describing an ES
 * module, so the same file offered to a `require()` consumer claims the CJS
 * bundle is ESM - and a `node16`/`nodenext` project then rejects a require that
 * works perfectly well at runtime. The `.d.cts` copy says CommonJS, which is
 * what the `require` condition actually resolves to.
 *
 * The banner is prepended to both, so a declaration file is no more anonymous
 * than a bundle is.
 */
const types = readFileSync('./types/domma-reactive.d.ts', 'utf8');

function declarations() {
    return {
        name: 'declarations',
        generateBundle() {
            for (const fileName of ['domma-reactive.d.ts', 'domma-reactive.d.cts']) {
                this.emitFile({type: 'asset', fileName, source: `${banner}\n${types}`});
            }
        }
    };
}

/**
 * Three artefacts, because three consumers ask for the code three ways.
 *
 * The `.cjs` extension on the require target is load-bearing, not cosmetic.
 * This package declares `"type": "module"`, which makes Node treat every `.js`
 * file inside it as ESM - including a UMD bundle. A UMD file parsed as ESM has
 * no `export` statements, so `require('domma-reactive')` resolves to an *empty*
 * namespace object rather than throwing: a silent failure for every CommonJS
 * consumer. The `.cjs` extension overrides the `type` field and restores the
 * CommonJS parse.
 */
export default {
    input: 'src/index.js',
    output: [
        {
            // Browser <script> - defines window.DommaReactive.
            file: 'dist/domma-reactive.min.js',
            format: 'umd',
            name: 'DommaReactive',
            banner,
            plugins: [terser({format: {comments: 'some'}})]
        },
        {
            // Node require() - see the note above on the extension.
            file: 'dist/domma-reactive.cjs',
            format: 'umd',
            name: 'DommaReactive',
            banner,
            plugins: [terser({format: {comments: 'some'}})]
        },
        {
            // Bundlers and Node import().
            file: 'dist/domma-reactive.esm.js',
            format: 'es',
            banner,
            plugins: [declarations()]
        }
    ]
};
