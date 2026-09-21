import {describe, expect, it, vi} from 'vitest';
import {effect, flushSync} from './graph.js';
import {observable} from './observable.js';

describe('an effect that throws', () => {
    it('does not stop the effects after it in the same flush', () => {
        const source = observable(1);
        const ran = [];
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

        effect(() => { ran.push(['first', source.value]); });
        effect(() => { source.value; throw new Error('broken'); });
        effect(() => { ran.push(['third', source.value]); });

        ran.length = 0;
        source.value = 2;
        flushSync();

        expect(ran).toEqual([['first', 2], ['third', 2]]);
        warn.mockRestore();
    });

    it('recovers once it stops throwing - IF it read its dependency first', () => {
        const source = observable(1);
        const seen = [];
        let broken = true;
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

        effect(() => { source.value; if (broken) throw new Error('broken'); });
        effect(() => { seen.push(source.value); });

        seen.length = 0;
        source.value = 2;
        flushSync();
        broken = false;
        source.value = 3;
        flushSync();

        expect(seen).toEqual([2, 3]);
        warn.mockRestore();
    });

    it('stays on the graph when it throws BEFORE its tracked read', () => {
        const source = observable(1);
        const runs = [];
        let broken = false;
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

        // Runs cleanly first, which is how every binding starts: it applied
        // its initial value, so it has a dependency. THEN something upstream
        // goes wrong for one evaluation - a value briefly absent mid-load, a
        // component mid-render - and the body throws before reaching its read.
        effect(() => {
            runs.push('run');
            if (broken) throw new Error('broken before the read');
            source.value;
        });

        runs.length = 0;
        broken = true;
        source.value = 2;
        flushSync();
        broken = false;
        source.value = 3;
        flushSync();
        source.value = 4;
        flushSync();

        // A throw must cost ONE evaluation, not the rest of the session. The
        // old dependencies are restored when the body fails, so the effect is
        // still on the graph and wakes on the next write - twice here, once
        // for 3 and once for 4.
        expect(runs.length).toBe(3);
        warn.mockRestore();
    });
});
