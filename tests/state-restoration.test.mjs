import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

const utilsSource = await readFile(new URL('../repo-utils.js', import.meta.url), 'utf8');
const stateSource = await readFile(new URL('../state.js', import.meta.url), 'utf8');
const extensionSource = await readFile(new URL('../extension.js', import.meta.url), 'utf8');
const utilsUrl = `data:text/javascript;base64,${Buffer.from(utilsSource).toString('base64')}`;
const executableStateSource = stateSource
    .replace("import GLib from 'gi://GLib';", 'const GLib = {};')
    .replace("import {updateDailyStats} from './repo-utils.js';", `const {updateDailyStats} = await import('${utilsUrl}');`);
const stateUrl = `data:text/javascript;base64,${Buffer.from(executableStateSource).toString('base64')}`;
const {restoreCachedState} = await import(stateUrl);

test('restores cached records defensively and applies retention caps', () => {
    const state = {
        dailyStats: {'2026-10-23': {notifications: 4, activity: 2}},
        lastFetchedAt: '2026-10-23T08:30:00Z',
        notificationItems: [...Array.from({length: 155}, (_, i) => ({id: String(i)})), {id: 2}, null, {id: 3}],
        activityItems: [...Array.from({length: 45}, (_, i) => ({id: String(i)})), {title: 'missing id'}, null],
        pendingReadItems: [{id: 'n1', rawId: 'r1'}, {id: 'bad'}, {id: 'n2', rawId: 'r2'}],
        pendingMarkAllRead: {lastReadAt: '2026-10-23T00:00:00Z', notificationIds: ['n1'], activityIds: ['a1']},
    };
    const indicator = {
        _loadState: () => state,
        _localDateKey: () => '2026-10-23',
        _isValidPendingMarkAll: value => !!value && typeof value.lastReadAt === 'string' &&
            Array.isArray(value.notificationIds) && value.notificationIds.every(id => typeof id === 'string') &&
            Array.isArray(value.activityIds) && value.activityIds.every(id => typeof id === 'string'),
    };
    restoreCachedState(indicator);
    assert.equal(indicator._notificationItems.length, 150);
    assert.equal(indicator._activityItems.length, 40);
    assert.ok(indicator._notificationItems.every(item => typeof item.id === 'string'));
    assert.ok(indicator._activityItems.every(item => typeof item.id === 'string'));
    assert.deepEqual(indicator._pendingReadItems, [{id: 'n1', rawId: 'r1'}, {id: 'n2', rawId: 'r2'}]);
    assert.equal(indicator._pendingMarkAllRead, state.pendingMarkAllRead);
    assert.equal(indicator._lastFetchedAt, '2026-10-23T08:30:00Z');
    assert.deepEqual(indicator._dailyStats['2026-10-23'], {notifications: 4, activity: 2});
});

test('drops malformed pending mark-all state during restoration', () => {
    const indicator = {
        _loadState: () => ({pendingMarkAllRead: {lastReadAt: 'now', notificationIds: ['x'], activityIds: [null]}}),
        _localDateKey: () => '2026-10-23',
        _isValidPendingMarkAll: value => !!value && typeof value.lastReadAt === 'string' &&
            Array.isArray(value.notificationIds) && value.notificationIds.every(id => typeof id === 'string') &&
            Array.isArray(value.activityIds) && value.activityIds.every(id => typeof id === 'string'),
    };
    restoreCachedState(indicator);
    assert.equal(indicator._pendingMarkAllRead, null);
    assert.deepEqual(indicator._notificationItems, []);
    assert.deepEqual(indicator._activityItems, []);
    assert.deepEqual(indicator._pendingReadItems, []);
});

test('extension initialization does not reference state restoration locals', () => {
    assert.doesNotMatch(extensionSource, /\bpersistedState\b/);
});
