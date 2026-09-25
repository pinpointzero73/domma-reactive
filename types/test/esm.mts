// Compile-time tests for the declarations. Each `@ts-expect-error` is an
// assertion that something is REFUSED - if the declaration ever loosens, the
// directive becomes unused and that is itself a compile error.

import {
    type BindingContext,
    type BindingController,
    type BindingsHandle,
    type Computation,
    type ExpressionAst,
    type Observable,
    type ObservableArray,
    type ReadonlyComputed,
    type Unsubscribe,
    type WritableComputed,
    Dep,
    DepMap,
    TemplateCompiler,
    annotate,
    applyBindings,
    clearExpressionCache,
    compile,
    compileExpression,
    computed,
    createChildContext,
    createRootContext,
    effect,
    evaluateAst,
    evaluateExpression,
    expressionDependencies,
    flushSync,
    isEqual,
    observable,
    observableArray,
    parseExpression,
    registerBinding,
    registerComponent,
    registerExtender,
    registerHelper,
    renderTemplate,
    scanBlocks,
    trackingProxy,
    untracked,
    unregisterBinding,
    unregisterComponent,
    unregisterExtender,
    unregisterHelper
} from 'domma-reactive';

/** Exact type equality, not mere assignability. */
type Equals<A, B> =
    (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
function expectType<T>(_value: T): void {}
function assertType<_T extends true>(): void {}

// ── observable ────────────────────────────────────────────────────────────────

const count = observable(0);
assertType<Equals<typeof count, Observable<number>>>();
count.value = 5;
count.set(6);
expectType<number>(count.peek());
// @ts-expect-error - the value type is inferred from the initial value
count.value = 'five';

const name = observable<string | null>(null);
name.value = 'Ada';

const empty = observable();
assertType<Equals<typeof empty.value, undefined>>();

const off: Unsubscribe = count.subscribe((v) => expectType<number>(v));
off();
off.dispose();

const limited: Observable<string> = observable('').extend({rateLimit: 300});
limited.extend({rateLimit: {timeout: 50, method: 'notifyAtFixedRate'}});
limited.extend({notify: 'always', throttle: 10, trace: 'custom extenders are open-ended'});
// @ts-expect-error - notify accepts only 'always'
limited.extend({notify: 'sometimes'});
// @ts-expect-error - an unknown rate-limit method
limited.extend({rateLimit: {timeout: 50, method: 'eventually'}});

observable({id: 1}, {equals: (a, b) => a.id === b.id});

// ── observableArray ───────────────────────────────────────────────────────────

interface Todo {
    id: number;
    title: string;
}

const todos = observableArray<Todo>([{id: 1, title: 'write types'}]);
assertType<Equals<typeof todos, ObservableArray<Todo>>>();
expectType<number>(todos.push({id: 2, title: 'test them'}));
expectType<Todo | undefined>(todos.pop());
expectType<number>(todos.length);
expectType<Todo[]>(todos.value);
todos.remove((t) => t.id === 1).removeAll();
todos.remove({id: 3, title: 'by identity'});
todos.destroy((t, i) => i > 0 && t.title !== '');
todos.value = [];
todos.set([{id: 4, title: 'set'}]);
todos.subscribe((all) => expectType<Todo[]>(all));
// @ts-expect-error - wrong item type
todos.push('not a todo');
// @ts-expect-error - length is read-only
todos.length = 0;

const inferred = observableArray([1, 2, 3]);
assertType<Equals<typeof inferred, ObservableArray<number>>>();

// ── computed / effect / untracked ─────────────────────────────────────────────

const doubled = computed(() => count.value * 2);
assertType<Equals<typeof doubled, ReadonlyComputed<number>>>();
expectType<number>(doubled.value);
expectType<number>(doubled.get());
doubled.dispose();
// @ts-expect-error - a read-only computed has nowhere for a write to land
doubled.value = 3;
// @ts-expect-error - nor an imperative one
doubled.set(3);

const celsius = observable(20);
const fahrenheit = computed({
    read: () => celsius.value * 9 / 5 + 32,
    write: (f) => { celsius.value = (f - 32) * 5 / 9; }
});
assertType<Equals<typeof fahrenheit, WritableComputed<number>>>();
fahrenheit.value = 212;
fahrenheit.set(32);

const writableByOption = computed(() => celsius.value, {write: (v) => { celsius.value = v; }});
writableByOption.value = 1;

// A writable computed may be passed where a read-only one is expected.
const narrowed: ReadonlyComputed<number> = fahrenheit;
expectType<number>(narrowed.value);

const stop = effect(() => { void count.value; }, {label: 'log'});
stop.dispose();

expectType<string>(untracked(() => 'x'));
flushSync();

const {changed, value} = (fahrenheit as Computation<number>).recompute();
expectType<boolean>(changed);
expectType<number>(value);

// ── graph primitives ──────────────────────────────────────────────────────────

const deps = new DepMap();
const dep: Dep = deps.for('field');
dep.track();
deps.trigger('field');

const store = trackingProxy({a: 1, b: 'two'}, (key) => deps.for(key), {onSet: (k, v) => void [k, v]});
expectType<number>(store.a);

expectType<boolean>(isEqual({a: 1}, {a: 1}));

// ── expressions ───────────────────────────────────────────────────────────────

const ast: ExpressionAst | null = parseExpression('a + b', {template: 'demo'});
if (ast !== null && ast.type === 'Identifier') expectType<string>(ast.name);
expectType<unknown>(evaluateAst(ast, {a: 1, b: 2}));
expectType<unknown>(evaluateExpression('a', {a: 1}));
const evaluate = compileExpression('n > 1');
if (evaluate !== null) expectType<unknown>(evaluate({n: 2}));
expectType<Set<string>>(expressionDependencies('a.b + c'));

const upper = registerHelper('upper', (s: unknown) => String(s).toUpperCase());
expectType<string>(upper('a'));
expectType<boolean>(unregisterHelper('upper'));
expectType<number>(clearExpressionCache());

// ── contexts ──────────────────────────────────────────────────────────────────

const root = createRootContext({items: [1, 2]});
expectType<{items: number[]}>(root.$data);
const child: BindingContext<number> = createChildContext(root, 1, 0, 2);
expectType<number | null>(child.$index);
// @ts-expect-error - contexts are frozen
child.$index = 3;

// ── extenders ─────────────────────────────────────────────────────────────────

registerExtender('trace', (control, label: string) => {
    control.intercept((next) => (v) => {
        console.log(label, v);
        next(v);
    });
    control.setEquals(() => false);
});
expectType<boolean>(unregisterExtender('trace'));

// ── rendering and the compiler ────────────────────────────────────────────────

expectType<string>(renderTemplate('{{> row}}', {n: 1}, {partials: {row: '<b>{{n}}</b>'}}));

const {annotated, bindings} = annotate('<p>{{a}}</p>', {template: 'demo'});
expectType<string>(annotated);
expectType<string>(bindings[0]!.kind);
expectType<string>(scanBlocks('{{#if a}}x{{/if}}')[0]!.kind);
expectType<unknown>(TemplateCompiler.resolvePath({a: {b: 1}}, 'a.b'));

declare const host: Element;
const controller: BindingController = compile('<p>{{name}}</p>', {name}, host, null, {reactive: true});
controller.update(controller.bindings[0]!.id);
controller.refresh((b) => b.kind === 'text');
controller.destroy();
// @ts-expect-error - a container is required
compile('<p></p>', {});

const handle: BindingsHandle = applyBindings({count}, host, {template: 'page'});
expectType<number>(handle.bindings);
handle.update();
handle.dispose();

registerBinding('shout', {
    attribute: 'data-shout',
    expression: true,
    tracks: true,
    primes: true,
    update({binding, nodes, context}) {
        const text = String(binding.evaluate?.(context) ?? '');
        for (const node of nodes) if (node instanceof Element) node.textContent = text;
        return true;
    },
    detach({node}) { void node; }
});
// @ts-expect-error - update() is the one required member
registerBinding('broken', {attribute: 'data-broken'});
expectType<boolean>(unregisterBinding('shout'));

// ── components ────────────────────────────────────────────────────────────────

registerComponent('badge', {template: '<b data-bind-text="label"></b>'});
registerComponent('ticker', {
    template: '<span data-bind-text="n.value"></span>',
    create: (params: {start: number}, {element}) => {
        expectType<Element>(element);
        const n = observable(params.start);
        const timer = setInterval(() => { n.value++; }, 1000);
        return {n, dispose: () => clearInterval(timer)};
    }
});
// @ts-expect-error - a template is required
registerComponent('no-template', {create: () => ({})});
expectType<boolean>(unregisterComponent('badge'));
