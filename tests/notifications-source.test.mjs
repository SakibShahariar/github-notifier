import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('../notifications.js', import.meta.url), 'utf8');

test('DND and quiet hours suppress desktop notification creation before allocating a source', () => {
    for (const name of ['notify', 'notifyBaseline']) {
        const start = source.indexOf(`export function ${name}(`);
        assert.notEqual(start, -1, `missing ${name}`);
        const end = source.indexOf('\nexport function ', start + 1);
        const body = source.slice(start, end < 0 ? source.length : end);
        const guard = body.indexOf('if (indicator._shouldSuppressDesktopNotifications())');
        const createSource = body.indexOf('indicator._ensureSource()');
        assert.notEqual(guard, -1, `${name} must check suppression`);
        assert.ok(createSource === -1 || guard < createSource, `${name} must suppress before creating a source`);
        assert.match(body.slice(guard, guard + 120), /return/);
    }
});

test('suppression only affects desktop notifications; polling remains responsible for badge refresh', async () => {
    const poll = await readFile(new URL('../poll-controller.js', import.meta.url), 'utf8');
    assert.match(poll, /indicator\._afterPoll\(notificationItems, activityItems/);
    assert.match(poll, /indicator\._updatePanel\(\)/);
});
