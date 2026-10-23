import assert from 'node:assert/strict';
import test from 'node:test';

import {runBoundedWorkers} from '../bounded-workers.js';

test('bounds active workers and preserves input-order results', async () => {
    const items = Array.from({length: 12}, (_, index) => index);
    let active = 0;
    let maximumActive = 0;
    const results = await runBoundedWorkers(items, 3, async (item) => {
        active++;
        maximumActive = Math.max(maximumActive, active);
        await new Promise(resolve => setTimeout(resolve, (items.length - item) % 4));
        active--;
        return item * 10;
    });

    assert.equal(maximumActive, 3);
    assert.deepEqual(results, items.map(item => item * 10));
});

test('does not assign more work after the stop condition is observed', async () => {
    const assigned = [];
    let stopped = false;
    const results = await runBoundedWorkers([1, 2, 3, 4], 1, async item => {
        assigned.push(item);
        if (item === 2)
            stopped = true;
        return item;
    }, () => stopped);

    assert.deepEqual(assigned, [1, 2]);
    assert.deepEqual(Array.from(results), [1, 2, undefined, undefined]);
});

test('handles empty input without creating workers', async () => {
    let called = false;
    assert.deepEqual(await runBoundedWorkers([], 3, async () => { called = true; }), []);
    assert.equal(called, false);
});
