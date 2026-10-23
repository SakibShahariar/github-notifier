import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('../notification-actions.js', import.meta.url), 'utf8');

test('opened notification rows respect mark-read-on-open while activity rows are dismissed', () => {
    assert.match(source, /export function handleOpenedItem\(indicator, item\)/);
    assert.match(source, /item\.kind === 'notification' && item\.rawId/);
    assert.match(source, /indicator\._settings\.get_boolean\('mark-read-on-open'\)/);
    assert.match(source, /return indicator\._markThreadRead\(item\)/);
    assert.match(source, /return indicator\._dismissActivityItem\(item\)/);
});

test('notification summary publisher avoids redundant writes and preserves failed writes for retry', () => {
    assert.match(source, /export function publishNotificationSummary\(indicator, unreadNotifications, activityItems, enabled = true\)/);
    assert.match(source, /indicator\._summaryPublished && sameCounts/);
    assert.match(source, /previousText !== serialized && !indicator\._settings\.set_string\('notification-summary', serialized\)/);
    assert.match(source, /indicator\._summaryPublished = true/);
});


test('read and mark-all status timers only clear the status generation they created', () => {
    assert.ok((source.match(/statusGeneration === indicator\._actionStatusGeneration/g) || []).length >= 7);
});


test('mark-read requests and queued retries accept only numeric GitHub thread IDs', () => {
    assert.ok(source.includes("const rawId = String(item.rawId || '');"));
    assert.ok(source.includes('if (!/^\\d{1,20}$/.test(rawId))'));
    assert.ok(source.includes('`/notifications/threads/${rawId}`'));
});
