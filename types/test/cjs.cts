// A CommonJS consumer resolves the `require` condition, and so the `.d.cts`.
// If the package ever shipped only a `.d.ts`, this file would fail to compile.

import reactive = require('domma-reactive');

const count: reactive.Observable<number> = reactive.observable(0);
const doubled: reactive.ReadonlyComputed<number> = reactive.computed(() => count.value * 2);
reactive.flushSync();

export const n: number = doubled.value;
