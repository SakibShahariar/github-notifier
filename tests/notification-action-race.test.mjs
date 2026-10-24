import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

const actionsSource = await readFile(new URL('../notification-actions.js', import.meta.url), 'utf8');

test('mark-all-read ignores repeat clicks while the GitHub request is in flight', () => {
    const start = actionsSource.indexOf('export function markAllRead(indicator) {');
    assert.notEqual(start, -1, 'markAllRead implementation exists');
    const end = actionsSource.indexOf('\nexport function disarmMarkAll', start);
    assert.notEqual(end, -1, 'markAllRead implementation has a clear boundary');
    const implementation = actionsSource.slice(start, end);

    const inFlightGuard = implementation.indexOf('if (indicator._markingAllRead)');
    const confirmationBranch = implementation.indexOf('if (!indicator._markAllArmed)');
    const requestStart = implementation.indexOf("indicator._apiRequest('PUT', '/notifications'");
    assert.notEqual(inFlightGuard, -1, 'an in-flight guard exists');
    assert.notEqual(confirmationBranch, -1, 'the confirmation branch exists');
    assert.notEqual(requestStart, -1, 'the mark-all request exists');
    assert.ok(inFlightGuard < confirmationBranch, 'the guard runs before a click can arm another confirmation');
    assert.ok(inFlightGuard < requestStart, 'the in-flight guard runs before a request can be sent');
    assert.match(implementation, /indicator\._markingAllRead = true;/);
    assert.match(implementation, /indicator\._markingAllRead = false;/);
});
