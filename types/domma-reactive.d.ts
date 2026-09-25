/**
 * Type declarations for domma-reactive.
 *
 * Hand-written, not generated. The sources are JavaScript with JSDoc, and what
 * JSDoc can express - `{Object}`, `{Function}`, `{*}` - is exactly the part a
 * TypeScript consumer gets nothing from. What matters here is the generics:
 * `observable(0)` is an `Observable<number>`, `computed(() => …)` carries its
 * result type, and a read-only computed refuses assignment at compile time
 * rather than warning at runtime.
 *
 * This file describes the public surface of src/index.js and nothing else. The
 * build copies it to dist/ twice - `.d.ts` for `import`, `.d.cts` for
 * `require()` - because under `"type": "module"` a single `.d.ts` would be read
 * as ESM types for the CommonJS entry point too. See rollup.config.js.
 *
 * types/test/ holds the compile-time tests that keep it honest; run them with
 * `npm run test:types`.
 */

/// <reference lib="dom" />

export as namespace DommaReactive;

// ── Equality ──────────────────────────────────────────────────────────────────

/**
 * Deep structural equality: Date, Array and plain objects compared by content,
 * everything else by reference. +0 and -0 are equal, NaN equals itself.
 */
export function isEqual(a: unknown, b: unknown): boolean;

// ── The dependency graph ──────────────────────────────────────────────────────

/** A single reactive slot - one data field, or the output of one computed. */
export class Dep {
    constructor(owner?: Computation<any> | null);
    /** Computations that read this slot during their last evaluation. */
    subs: Set<Computation<any>>;
    /** The Computation this Dep represents the output of, if any. */
    owner: Computation<any> | null;
    /** Record that the currently-evaluating computation read this slot. */
    track(): void;
    /** Queue every dependent computation and schedule a flush. */
    trigger(): void;
}

/** A lazily-populated keyed collection of Deps - one per data field. */
export class DepMap {
    constructor();
    /** Get, creating if needed, the Dep for a field. */
    for(key: string): Dep;
    /** Signal that a field changed. No-op when nothing has read it. */
    trigger(key: string): void;
    /** Drop every Dep. */
    clear(): void;
}

export interface ComputationOptions<T> {
    /** True for effects. */
    effect?: boolean;
    /** Debug label. */
    label?: string;
    /** Called after the value changes. */
    onNotify?: ((value: T, computation: Computation<T>) => void) | null;
    /** Makes the computation writable: where an assignment to `.value` lands. */
    write?: (next: T) => void;
}

/**
 * A tracked unit of work: a computed value or an effect.
 *
 * A body that throws is reported and yields `undefined` for that evaluation;
 * the type says `T` because that is the only case in which it is not one.
 */
export class Computation<T = unknown> {
    constructor(fn: () => T, options?: ComputationOptions<T>);

    fn: () => T;
    label: string;
    readonly isEffect: boolean;
    onNotify: ((value: T, computation: Computation<T>) => void) | null;
    /** Deps this computation read during its last evaluation. */
    deps: Set<Dep>;
    /** The Dep representing this computation's output. */
    dep: Dep;
    dirty: boolean;
    disposed: boolean;

    /** Pull the current value, recomputing only if dirty, and track the read. */
    get(): T;
    /** The same read as `get()`, spelled as a property. Assigning calls `write()`. */
    get value(): T;
    set value(next: T);
    /** Push a value back through the derivation. Warns on a read-only computed. */
    write(next: T): void;
    /** Imperative alias for assigning `.value`. */
    set(next: T): void;
    /** Force a re-evaluation and report whether the value changed. */
    recompute(): {changed: boolean; value: T};
    /** Mark stale without recomputing. */
    invalidate(): void;
    /** Computations that read this one's output during their last evaluation. */
    dependents(): Set<Computation<any>>;
    /** Fire the change callback. */
    notify(): void;
    /** Unlink from the graph. Safe to call more than once. */
    dispose(): void;
}

/**
 * What `computed(fn)` returns: a Computation with no `write` to receive an
 * assignment, so the assignment is refused here rather than ignored at runtime.
 */
export type ReadonlyComputed<T> =
    Omit<Computation<T>, 'value' | 'set' | 'write'> & {readonly value: T};

/** What `computed({read, write})` returns. */
export type WritableComputed<T> = Computation<T>;

export interface ComputedOptions<T> {
    /** Debug label. */
    label?: string;
    /** Called when the derived value changes. */
    onNotify?: ((value: T, computation: Computation<T>) => void) | null;
}

export interface WritableComputedDefinition<T> extends ComputedOptions<T> {
    read: () => T;
    write: (next: T) => void;
}

/** A writable computed: `computed({read, write})`. */
export function computed<T>(
    definition: WritableComputedDefinition<T>,
    options?: ComputedOptions<T>
): WritableComputed<T>;
/** A writable computed: `computed(read, {write})`. */
export function computed<T>(
    read: () => T,
    options: ComputedOptions<T> & {write: (next: T) => void}
): WritableComputed<T>;
/** A lazily-evaluated, read-only derived value. */
export function computed<T>(read: () => T, options?: ComputedOptions<T>): ReadonlyComputed<T>;

/**
 * Run `fn` now, collecting what it reads, and again whenever any of that
 * changes. The body must be synchronous. Stop it with `.dispose()`.
 */
export function effect(fn: () => unknown, options?: {label?: string}): ReadonlyComputed<unknown>;

/** Run `fn` with dependency tracking suspended. */
export function untracked<T>(fn: () => T): T;

export interface TrackingProxyOptions {
    /** Route writes here instead of mutating the target. */
    onSet?: ((key: string, value: unknown) => void) | null;
}

/** Wrap an object so that reading a field tracks the Dep `depFor(key)` returns. */
export function trackingProxy<T extends object>(
    target: T,
    depFor: (key: string) => Dep,
    options?: TrackingProxyOptions
): T;

/** Drain every pending recomputation now instead of on the next microtask. */
export function flushSync(): void;

// ── Observables ───────────────────────────────────────────────────────────────

/** What `subscribe()` returns: call it, or call its `.dispose()`. */
export interface Unsubscribe {
    (): void;
    dispose(): void;
}

export interface ObservableOptions<T> {
    /** The change gate. Defaults to `isEqual`. Gates notification, never the write. */
    equals?: (a: T, b: T) => boolean;
}

/** Hold notifications back; the write itself always lands immediately. */
export type RateLimit =
    | number
    | {timeout: number; method?: 'notifyWhenChangesStop' | 'notifyAtFixedRate'};

/**
 * The argument to `.extend()`. The built-ins are typed; any other key is an
 * extender added with `registerExtender`.
 */
export interface ExtenderSpec {
    rateLimit?: RateLimit;
    /** Knockout's older name for `rateLimit`, with `rateLimit`'s behaviour. */
    throttle?: RateLimit;
    /** Announce every write, including one the change gate would swallow. */
    notify?: 'always';
    [extender: string]: unknown;
}

export interface Observable<T> {
    /** Tracked on read; assigning writes, and notifies if the value changed. */
    value: T;
    /** Read without registering a dependency. */
    peek(): T;
    /** Imperative alias for assigning `.value`. */
    set(next: T): void;
    /** Called synchronously, at the write, with the new value. */
    subscribe(fn: (value: T) => void): Unsubscribe;
    /** Layer behaviour onto this observable. */
    extend(spec: ExtenderSpec): this;
}

/** A value to be tested against each item, or a test function. */
export type ItemMatch<T> = T | ((item: T, index: number) => boolean);

export interface ObservableArray<T> {
    /**
     * The live array, tracked on read. An assigned array is copied rather than
     * adopted; a non-array is coerced to an empty one.
     */
    value: T[];
    /** Tracked. */
    readonly length: number;
    /** The live array, untracked. */
    peek(): T[];
    /** Imperative alias for assigning `.value`. */
    set(next: readonly T[]): void;

    /** Remove every item equal to `match`, or every item the test accepts. */
    remove(match: ItemMatch<T>): this;
    /** Empty the array in place. */
    removeAll(): this;
    /** Tracked `indexOf`, by identity. */
    indexOf(item: T): number;
    /** Swap the first occurrence of `oldItem` for `newItem`. */
    replace(oldItem: T, newItem: T): this;
    /** Mark matching object items `_destroy: true` without removing them. */
    destroy(match: ItemMatch<T>): this;
    /** Mark every item deleted. */
    destroyAll(): this;

    /** Called synchronously on every change, with the live array. */
    subscribe(fn: (value: T[]) => void): Unsubscribe;
    /** Layer behaviour onto this array. A rate limit covers the mutators too. */
    extend(spec: ExtenderSpec): this;

    // The in-place mutators: the native method, run against the live array.
    push(...items: T[]): number;
    pop(): T | undefined;
    shift(): T | undefined;
    unshift(...items: T[]): number;
    splice(start: number, deleteCount?: number, ...items: T[]): T[];
    sort(compareFn?: (a: T, b: T) => number): T[];
    reverse(): T[];
    fill(value: T, start?: number, end?: number): T[];
    copyWithin(target: number, start: number, end?: number): T[];
}

/** Create an observable value. */
export function observable<T>(initial: T, options?: ObservableOptions<T>): Observable<T>;
export function observable<T = undefined>(): Observable<T | undefined>;

/** Create an observable array. The initial array is copied. */
export function observableArray<T = unknown>(
    initial?: readonly T[] | null,
    options?: ObservableOptions<T[]>
): ObservableArray<T>;

// ── Extenders ─────────────────────────────────────────────────────────────────

/**
 * What an extender is handed. It can replace the change gate and wrap the
 * announcement, and deliberately cannot touch the stored value.
 */
export interface ExtenderControl {
    /** The observable being extended. */
    readonly observable: Observable<any> | ObservableArray<any>;
    /** Replace the change gate. */
    setEquals(fn: (a: any, b: any) => boolean): void;
    /** Wrap the announcement: `next` delivers a value to the graph and subscribers. */
    intercept(wrap: (next: (value: any) => void) => (value: any) => void): void;
}

export type Extender<V = any> = (control: ExtenderControl, value: V) => void;

/** Register an extender usable as `.extend({[name]: value})`. */
export function registerExtender<F extends Extender>(name: string, fn: F): F;
/** Remove an extender. Built-ins are refused. */
export function unregisterExtender(name: string): boolean;

// ── Binding contexts ──────────────────────────────────────────────────────────

/** What an expression resolves names against. Frozen. */
export interface BindingContext<D = any> {
    readonly $data: D;
    readonly $root: any;
    /** The enclosing data, or null at the root. */
    readonly $parent: any;
    /** Every enclosing `$data`, nearest first. */
    readonly $parents: readonly any[];
    readonly $parentContext: BindingContext | null;
    /** Position within a list, or null outside one. */
    readonly $index: number | null;
    /** Size of the enclosing list, or null outside one. */
    readonly $length: number | null;
    /** The enclosing component's view model, or null outside one. */
    readonly $component: any;
}

/** The top-level context for a data object. */
export function createRootContext<D>(data: D): BindingContext<D>;

/** A context one level down: a list item, or the body of a `with`. */
export function createChildContext<D>(
    parent: unknown,
    data: D,
    index?: number | null,
    length?: number | null
): BindingContext<D>;

// ── Expressions ───────────────────────────────────────────────────────────────

/** A node of a parsed expression. Frozen. */
export type ExpressionAst =
    | {readonly type: 'Literal'; readonly value: string | number | boolean | null}
    | {readonly type: 'Identifier'; readonly name: string}
    | {
          readonly type: 'Member';
          readonly object: ExpressionAst;
          readonly property: string | ExpressionAst;
          readonly computed: boolean;
      }
    | {readonly type: 'Call'; readonly callee: string; readonly args: readonly ExpressionAst[]}
    | {readonly type: 'MethodCall'; readonly [key: string]: unknown}
    | {readonly type: 'Unary'; readonly [key: string]: unknown}
    | {readonly type: 'Binary'; readonly [key: string]: unknown}
    | {readonly type: 'Logical'; readonly [key: string]: unknown}
    | {
          readonly type: 'Conditional';
          readonly test: ExpressionAst;
          readonly consequent: ExpressionAst;
          readonly alternate: ExpressionAst;
      };

export interface ExpressionOptions {
    /** A name for the template, used in warnings. */
    template?: string;
    /** Permit `x.foo()` to parse. The evaluator still refuses to perform it. */
    methodCalls?: boolean;
}

/** A compiled expression: evaluate against a binding context or plain data. */
export type CompiledExpression = (context: unknown) => unknown;

/** Parse, cached by source. Null when the source does not parse. */
export function parseExpression(source: string, options?: ExpressionOptions): ExpressionAst | null;
/** Evaluate an AST. Never throws; an error yields `undefined`. */
export function evaluateAst(ast: ExpressionAst | null, context: unknown): unknown;
/** Parse and evaluate in one call. `undefined` if the source does not parse. */
export function evaluateExpression(source: string, context: unknown, options?: ExpressionOptions): unknown;
/** Source to a reusable evaluator. Null when the source does not parse. */
export function compileExpression(source: string, options?: ExpressionOptions): CompiledExpression | null;
/** The root names an expression reads. Empty when it does not parse. */
export function expressionDependencies(
    source: string | ExpressionAst | null,
    options?: ExpressionOptions
): Set<string>;
/** Register a helper - the only kind of function an expression may call. */
export function registerHelper<F extends (...args: any[]) => unknown>(name: string, fn: F): F;
/** Remove a helper. */
export function unregisterHelper(name: string): boolean;
/** Empty the parse cache, returning how many entries were dropped. */
export function clearExpressionCache(): number;

// ── Rendering ─────────────────────────────────────────────────────────────────

export interface RenderOptions {
    /** name → template, for `{{> name}}`. */
    partials?: Record<string, string>;
    /** A label for expression warnings. */
    template?: string;
}

/** A mustache renderer: `(template, data) => html`. */
export type RenderFn = (template: string, data: any) => string;

/** The default mustache renderer. HTML-escapes `{{ }}`; `{{{ }}}` is raw. */
export function renderTemplate(template: string, data?: object, options?: RenderOptions): string;

// ── Bindings ──────────────────────────────────────────────────────────────────

/** A comment-anchored region of DOM, owned by a region binding. */
export interface Region {
    open: Comment;
    close: Comment;
}

/**
 * A compiled binding record. Handlers read these fields; the compiler and the
 * runtime own them.
 */
export interface Binding {
    id: string;
    /** The registered name of the handler, e.g. 'model'. */
    kind: string;
    /** For an `attributePrefix` handler, the rest of the attribute name. */
    arg?: string | null;
    /** The source of the binding's expression. */
    expr: string;
    /** For a region handler, the annotated source of the region. */
    body?: string;
    /** Set when the handler declares `expression: true`. */
    ast?: ExpressionAst | null;
    evaluate?: CompiledExpression | null;
    /** Root names the expression reads. */
    deps: Set<string>;
    /** Elements for attribute bindings; regions for comment-anchored ones. */
    nodes: Array<Element | Region> | null;
    [key: string]: unknown;
}

export interface BindingUpdateArgs {
    binding: Binding;
    nodes: Array<Element | Region>;
    context: BindingContext;
    render: RenderFn;
    replaceRegion(open: Comment, close: Comment, html: string): void;
    /** Re-index after revealing new markup. */
    reindex(): void;
    controller: BindingController;
}

export interface BindingNodeArgs {
    binding: Binding;
    node: Element | Region;
    controller: BindingController;
}

/** The contract `registerBinding` accepts. Only `update` is required. */
export interface BindingHandler {
    /** An exact attribute name that asks for this binding, e.g. 'data-model'. */
    attribute?: string;
    /** An attribute prefix; the remainder becomes `binding.arg`. */
    attributePrefix?: string;
    /** Parse the value; sets `binding.ast` and `binding.evaluate`. */
    expression?: boolean;
    /** Contribute the expression's dependencies to `binding.deps`. */
    tracks?: boolean;
    /** Wrap the owning element in comment anchors. */
    region?: boolean;
    /** Fill `binding.body` with the region's annotated source. */
    capturesBody?: boolean;
    /** Run `update()` once immediately after the first paint. */
    primes?: boolean;
    /** Returns whether anything was written. */
    update(args: BindingUpdateArgs): boolean | void;
    /** Once per node, when it is indexed. */
    attach?(args: BindingNodeArgs): void;
    /** On teardown. */
    detach?(args: BindingNodeArgs): void;
}

/** Register a binding kind - the same function every built-in is registered with. */
export function registerBinding<H extends BindingHandler>(name: string, handler: H): H;
/** Remove a binding kind. */
export function unregisterBinding(name: string): boolean;

// ── The template compiler ─────────────────────────────────────────────────────

export interface BlockLocation {
    start: number;
    end: number;
    kind: string;
    expr: string;
}

export interface AnnotateOptions {
    /** A name for the template, used in warnings. */
    template?: string;
}

export interface AnnotateResult {
    annotated: string;
    bindings: Binding[];
}

export interface CompileOptions {
    /** A name for the template, used in warnings. */
    template?: string;
    /**
     * Own one effect per binding, so the DOM follows the data unaided. Off by
     * default; a standalone consumer almost certainly wants it on.
     */
    reactive?: boolean;
}

/** What `compile()` returns. Call `destroy()` when the markup is done with. */
export interface BindingController {
    readonly bindings: Binding[];
    /** Dependencies of one binding. */
    deps(id: string): Set<string>;
    /** The binding context in force. */
    context(): BindingContext;
    /** Re-point every binding at a different context, running nothing. */
    setContext(next: unknown): void;
    /** Re-run every binding that currently has nodes. */
    refresh(filter?: ((binding: Binding) => boolean) | null): void;
    /** Re-index from the current roots. */
    index(): void;
    /** Update one binding in place. True if anything was written. */
    update(id: string, fullData?: unknown): boolean;
    /** Update every binding. */
    updateAll(fullData?: unknown): void;
    /** Full re-render. */
    rerenderAll(fullData?: unknown): void;
    /** @deprecated Use `rerenderAll`. */
    rerender(fullData?: unknown): void;
    /** Detach listeners and dispose every effect. Leaves the nodes in place. */
    destroy(): void;
    /** Live effect count. */
    effectCount(): number;
}

/** Locate every block in a template, at any nesting depth. */
export function scanBlocks(template: string): BlockLocation[];

/** Annotate a template with anchors and build its binding list. Needs no DOM. */
export function annotate(template: string, options?: AnnotateOptions): AnnotateResult;

/** Compile a template into a container. Needs a DOM. */
export function compile(
    template: string,
    data: unknown,
    container: Element,
    renderFn?: RenderFn | null,
    options?: CompileOptions
): BindingController;

export const TemplateCompiler: {
    readonly annotate: typeof annotate;
    readonly compile: typeof compile;
    readonly scanBlocks: typeof scanBlocks;
    /** Resolve a dotted path against a data object. */
    readonly resolvePath: (data: unknown, path: string) => unknown;
};

// ── applyBindings ─────────────────────────────────────────────────────────────

export interface ApplyBindingsOptions {
    /** Renderer for `data-each` item templates. */
    render?: RenderFn;
    /** A name for this subtree, used in warnings. */
    template?: string;
}

/** What `applyBindings()` returns. Call `dispose()` when the markup is done with. */
export interface BindingsHandle {
    /** How many bindings this call activated. */
    readonly bindings: number;
    /** The binding context in force. */
    context(): BindingContext;
    /** Re-point at different data and re-run every binding. */
    update(next?: unknown): void;
    /** Tear down everything this call created. Safe to call twice. */
    dispose(): void;
}

/** Bring an existing DOM subtree, inclusive of the root, to life. */
export function applyBindings(data: unknown, rootElement: Element, options?: ApplyBindingsOptions): BindingsHandle;

// ── Components ────────────────────────────────────────────────────────────────

export interface ComponentDefinition<P = any, VM extends object = any> {
    /** Markup, bound against the view model - or against the params with no `create`. */
    template: string;
    /**
     * A plain factory: no `new`. Handed the frozen params and the host element.
     * A `dispose()` on the view model it returns runs on teardown.
     */
    create?: (params: P, info: {element: Element}) => VM;
}

/** Register a component, used as `data-component="'name'"`. */
export function registerComponent<D extends ComponentDefinition>(name: string, definition: D): D;
/** Remove a component. */
export function unregisterComponent(name: string): boolean;
