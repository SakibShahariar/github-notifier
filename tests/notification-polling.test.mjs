import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import {pollNotifications} from '../notification-polling.js';

const extensionSource = await readFile(new URL('../extension.js', import.meta.url), 'utf8');

function makeIndicator(responses) {
    const calls = [];
    return {
        calls,
        _notificationItems: [{id: 'cached'}],
        async _apiRequest(method, path, options) {
            calls.push({method, path, options});
            const response = responses[path];
            if (!response)
                throw new Error(`Unexpected API request: ${path}`);
            return response;
        },
        _reasonToKind(reason, subjectType) {
            return reason === 'mention' ? 'Mention' : subjectType || 'Notification';
        },
        _subjectHtmlUrl(subject, repository) {
            return `https://github.com/${repository}`;
        },
        _nextPageUrl(linkHeader) {
            const match = linkHeader?.match(/<([^>]+)>;\\s*rel="next"/);
            return match ? match[1] : null;
        },
        _pathFromAbsoluteUrl(url) {
            const parsed = new URL(url);
            return parsed.pathname + parsed.search;
        },
        _webBase() { return 'https://github.com'; },
    };
}

const inboxPath = '/notifications?per_page=50&participating=false';

test('indicator delegates inbox polling to the extracted implementation', () => {
    assert.ok(extensionSource.includes('async _pollNotifications(state) {'));
    assert.ok(extensionSource.includes('return pollNotifications(this, state, MAX_NOTIFICATION_PAGES);'));
});

test('initial inbox poll establishes a quiet toast baseline and saves conditional metadata', async () => {
    const indicator = makeIndicator({
        [inboxPath]: {
            data: [{id: 123, reason: 'mention', subject: {type: 'Issue', title: 'Hello'}, repository: {full_name: 'owner/repo'}, updated_at: '2026-10-23T00:00:00Z'}],
            linkHeader: null,
            lastModified: 'Fri, 23 Oct 2026 00:00:00 GMT',
            notModified: false,
        },
    });
    const state = {};
    const items = await pollNotifications(indicator, state);

    assert.equal(items.length, 1);
    assert.equal(items[0].id, 'notif-123');
    assert.equal(items[0].rawId, '123');
    assert.equal(items[0].isNewToast, false);
    assert.equal(items[0].title, 'Mention: Hello');
    assert.equal(state.notificationBaselineEstablished, true);
    assert.deepEqual(state.toastedNotificationIds, ['123']);
    assert.equal(state.notificationsLastModified, 'Fri, 23 Oct 2026 00:00:00 GMT');
});

test('subsequent inbox polls toast only unseen thread IDs and send If-Modified-Since', async () => {
    const indicator = makeIndicator({
        [inboxPath]: {
            data: [
                {id: '123', reason: 'mention', subject: {type: 'Issue', title: 'Old'}, repository: {full_name: 'owner/repo'}, updated_at: '2026-10-22T00:00:00Z'},
                {id: '456', reason: 'comment', subject: {type: 'Issue', title: 'New'}, repository: {full_name: 'owner/repo'}, updated_at: '2026-10-23T00:00:00Z'},
            ],
            linkHeader: null,
            lastModified: null,
            notModified: false,
        },
    });
    const state = {
        notificationBaselineEstablished: true,
        toastedNotificationIds: ['123'],
        notificationsLastModified: 'Thu, 22 Oct 2026 00:00:00 GMT',
    };
    const items = await pollNotifications(indicator, state);

    assert.deepEqual(items.map(item => item.isNewToast), [false, true]);
    assert.equal(indicator.calls[0].options.headers['If-Modified-Since'], 'Thu, 22 Oct 2026 00:00:00 GMT');
    assert.deepEqual(state.toastedNotificationIds, ['123', '456']);
});

test('malformed persisted toast baselines are normalized without breaking inbox polling', async () => {
    const indicator = makeIndicator({
        [inboxPath]: {
            data: [{id: '123', reason: 'mention', subject: {type: 'Issue', title: 'Hello'}, repository: {full_name: 'owner/repo'}, updated_at: '2026-10-23T00:00:00Z'}],
            linkHeader: null,
            lastModified: null,
            notModified: false,
        },
    });
    const state = {notificationBaselineEstablished: 'true', toastedNotificationIds: 'corrupt'};
    const items = await pollNotifications(indicator, state);

    assert.equal(items.length, 1);
    assert.equal(items[0].isNewToast, false);
    assert.deepEqual(state.toastedNotificationIds, ['123']);
    assert.equal(state.notificationBaselineEstablished, true);
});

test('a 304 inbox response preserves the cached notifications without rebuilding them', async () => {
    const cached = [{id: 'notif-123', rawId: '123'}];
    const indicator = makeIndicator({
        [inboxPath]: {data: null, linkHeader: null, lastModified: null, notModified: true},
    });
    indicator._notificationItems = cached;
    const result = await pollNotifications(indicator, {notificationsLastModified: 'Thu, 22 Oct 2026 00:00:00 GMT'});

    assert.deepEqual(result, cached);
    assert.notEqual(result, cached);
    assert.equal(indicator.calls[0].options.headers['If-Modified-Since'], 'Thu, 22 Oct 2026 00:00:00 GMT');
});


test('a 304 response reconstructs a corrupt toast baseline from cached inbox IDs', async () => {
    const indicator = makeIndicator({
        [inboxPath]: {data: null, linkHeader: null, lastModified: null, notModified: true},
    });
    const cached = [{id: 'notif-123', rawId: '123'}];
    indicator._notificationItems = cached;
    const state = {
        notificationBaselineEstablished: 'true',
        toastedNotificationIds: 'corrupt',
        notificationsLastModified: 'Thu, 22 Oct 2026 00:00:00 GMT',
    };

    const result = await pollNotifications(indicator, state);
    assert.deepEqual(result, cached);
    assert.equal(state.notificationBaselineEstablished, true);
    assert.deepEqual(state.toastedNotificationIds, ['123']);
    assert.equal(indicator.calls[0].options.headers['If-Modified-Since'], 'Thu, 22 Oct 2026 00:00:00 GMT');
});

test('a 304 with an established marker but no cached IDs resets the empty baseline safely', async () => {
    const indicator = makeIndicator({
        [inboxPath]: {data: null, linkHeader: null, lastModified: null, notModified: true},
    });
    indicator._notificationItems = [];
    const state = {
        notificationBaselineEstablished: true,
        toastedNotificationIds: [],
        notificationsLastModified: 'Thu, 22 Oct 2026 00:00:00 GMT',
    };

    assert.deepEqual(await pollNotifications(indicator, state), []);
    assert.equal(state.notificationsLastModified, null);
    assert.equal(state.notificationBaselineEstablished, false);
});

test('a 304 response without cached inbox data clears stale conditional metadata for a full baseline fetch', async () => {
    const indicator = makeIndicator({
        [inboxPath]: {data: null, linkHeader: null, lastModified: null, notModified: true},
    });
    indicator._notificationItems = [];
    const state = {
        notificationBaselineEstablished: 'true',
        toastedNotificationIds: 'corrupt',
        notificationsLastModified: 'Thu, 22 Oct 2026 00:00:00 GMT',
    };

    assert.deepEqual(await pollNotifications(indicator, state), []);
    assert.equal(state.notificationsLastModified, null);
    assert.equal(state.notificationBaselineEstablished, false);
    assert.deepEqual(state.toastedNotificationIds, []);
});


test('corrupt Last-Modified metadata is discarded instead of sent as a request header', async () => {
    const indicator = makeIndicator({
        [inboxPath]: {data: null, linkHeader: null, lastModified: null, notModified: true},
    });
    indicator._notificationItems = [{id: 'notif-123', rawId: '123'}];
    const state = {
        notificationBaselineEstablished: true,
        toastedNotificationIds: ['123'],
        notificationsLastModified: 'not-a-valid-http-date',
    };

    assert.deepEqual(await pollNotifications(indicator, state), indicator._notificationItems);
    assert.deepEqual(indicator.calls[0].options.headers, {});
    assert.equal(state.notificationsLastModified, null);
});
