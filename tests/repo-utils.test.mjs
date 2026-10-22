import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

// Load the exact helper source as an ES module without requiring a package.json
// change that could affect GNOME Shell's extension module loading.
const helperSource = await readFile(new URL('../repo-utils.js', import.meta.url), 'utf8');
const helperUrl = `data:text/javascript;base64,${Buffer.from(helperSource).toString('base64')}`;
const {createNotificationSummary, getApiBase, getApiPathFromAbsoluteUrl, getDailyStatsTotals, getGitHubCliArguments, getNotificationCategory, getNotificationIconName, formatRelativeTime, getItemDetail, getNotificationReasonLabel, formatLocalDateKey, getWebBase, getSubjectHtmlUrl, isRepositoryMuted, isValidClockTime, isValidRepository, setRepositoryMembership, isWithinQuietHours, parseRepositoryList, shouldSuppressDesktopNotifications, updateDailyStats} = await import(helperUrl);

test('accepts ordinary GitHub owner/repository names', () => {
    for (const value of [
        'owner/repo',
        'gnome/gnome-shell',
        'owner.name/repo_name',
        'A1/B2',
        'owner/repo-name',
        'owner/repo.name',
    ]) {
        assert.equal(isValidRepository(value), true, value);
    }
});

test('rejects malformed repository paths', () => {
    for (const value of [
        '',
        'owner',
        '/repo',
        'owner/',
        'owner/repo/extra',
        ' owner/repo',
        'owner/repo ',
        'owner with space/repo',
        'owner/repo name',
        'owner//repo',
    ]) {
        assert.equal(isValidRepository(value), false, JSON.stringify(value));
    }
});

test('rejects non-string inputs', () => {
    for (const value of [null, undefined, 12, {}, ['owner/repo']]) {
        assert.equal(isValidRepository(value), false);
    }
});

test('maps GitHub notification reasons to filter categories', () => {
    const cases = [
        [{notificationReason: 'mention'}, 'mentions'],
        [{notificationReason: 'team_mention'}, 'mentions'],
        [{notificationReason: 'review_requested'}, 'reviews'],
        [{notificationReason: 'approval_requested'}, 'reviews'],
        [{notificationReason: 'assign'}, 'assignments'],
        [{notificationReason: 'comment'}, 'conversation'],
        [{notificationReason: 'subscribed'}, 'conversation'],
        [{notificationReason: 'ci_activity'}, 'checks'],
        [{subjectType: 'WorkflowRun'}, 'checks'],
        [{subjectType: 'CheckSuite'}, 'checks'],
        [{notificationReason: 'security_alert'}, 'other'],
        [{reasonLabel: 'Review requested'}, 'reviews'],
        [{reasonLabel: 'Team mention'}, 'mentions'],
        [{}, 'other'],
    ];
    for (const [item, expected] of cases) {
        assert.equal(getNotificationCategory(item), expected, JSON.stringify(item));
    }
});

test('parses and normalizes a comma-separated muted repository list', () => {
    assert.deepEqual(
        parseRepositoryList(' Gnome/gnome-shell, owner/repo, gnome/GNOME-SHELL, invalid, ,owner/repo '),
        ['gnome/gnome-shell', 'owner/repo']
    );
    assert.deepEqual(parseRepositoryList(null), []);
    assert.deepEqual(parseRepositoryList('not-a-repo, owner/'), []);
});

test('matches muted repositories case-insensitively', () => {
    const muted = new Set(parseRepositoryList('GNOME/gnome-shell, owner/repo'));
    assert.equal(isRepositoryMuted('gnome/GNOME-SHELL', muted), true);
    assert.equal(isRepositoryMuted('OWNER/REPO', muted), true);
    assert.equal(isRepositoryMuted('gnome/mutter', muted), false);
    assert.equal(isRepositoryMuted(undefined, muted), false);
});

test('builds GitHub CLI arguments for issue and pull-request links', () => {
    assert.deepEqual(
        getGitHubCliArguments({
            kind: 'issue',
            subtitle: 'owner/repo',
            url: 'https://github.com/owner/repo/issues/123',
        }),
        ['issue', 'view', '123', '--repo', 'owner/repo']
    );
    assert.deepEqual(
        getGitHubCliArguments({
            kind: 'notification',
            subtitle: 'gnome/gnome-shell',
            url: 'https://github.com/gnome/gnome-shell/pull/456',
        }),
        ['pr', 'view', '456', '--repo', 'gnome/gnome-shell']
    );
    assert.deepEqual(
        getGitHubCliArguments({
            kind: 'issue',
            subtitle: 'owner/repo',
            url: 'https://git.example.com/owner/repo/issues/789',
        }),
        ['issue', 'view', '789', '--repo', 'git.example.com/owner/repo']
    );
});

test('does not create GitHub CLI commands for non-issue links or invalid data', () => {
    for (const item of [
        {kind: 'star', subtitle: 'owner/repo', url: 'https://github.com/owner/repo/stargazers'},
        {kind: 'issue', subtitle: 'owner/repo', url: 'https://github.com/owner/repo/issues'},
        {kind: 'issue', subtitle: 'owner/repo', url: 'not a URL'},
        {kind: 'issue', subtitle: 'invalid', url: 'https://github.com/owner/repo/issues/1'},
        null,
    ]) {
        assert.equal(getGitHubCliArguments(item), null);
    }
});

test('converts absolute pagination links to paths relative to the API base', () => {
    assert.equal(getApiPathFromAbsoluteUrl('https://api.github.com', 'https://api.github.com/notifications?page=2'), '/notifications?page=2');
    assert.equal(getApiPathFromAbsoluteUrl('https://git.example.com/api/v3', 'https://git.example.com/api/v3/notifications?page=2'), '/notifications?page=2');
    assert.equal(getApiPathFromAbsoluteUrl('https://git.example.com/github/api/v3', 'https://git.example.com/github/api/v3/notifications?page=2'), '/notifications?page=2');
});

test('rejects pagination links outside the configured API origin or base path', () => {
    assert.equal(getApiPathFromAbsoluteUrl('https://git.example.com/api/v3', 'https://evil.example/api/v3/notifications?page=2'), null);
    assert.equal(getApiPathFromAbsoluteUrl('https://git.example.com/api/v3', 'https://git.example.com/notifications?page=2'), null);
    assert.equal(getApiPathFromAbsoluteUrl('https://git.example.com/api/v3', 'http://git.example.com/api/v3/notifications?page=2'), null);
    assert.equal(getApiPathFromAbsoluteUrl('https://git.example.com/api/v3', 'not a url'), null);
});

test('validates 24-hour clock times strictly', () => {
    assert.equal(isValidClockTime('00:00'), true);
    assert.equal(isValidClockTime('23:59'), true);
    for (const value of ['', '7:00', '24:00', '12:60', '12:3', '12:00 ', null, 1200])
        assert.equal(isValidClockTime(value), false, String(value));
});

test('handles daytime quiet-hours intervals with inclusive start and exclusive end', () => {
    const date = (hour, minute = 0) => new Date(2026, 0, 1, hour, minute);
    assert.equal(isWithinQuietHours(date(21, 59), '22:00', '23:00'), false);
    assert.equal(isWithinQuietHours(date(22, 0), '22:00', '23:00'), true);
    assert.equal(isWithinQuietHours(date(22, 59), '22:00', '23:00'), true);
    assert.equal(isWithinQuietHours(date(23, 0), '22:00', '23:00'), false);
});

test('handles overnight quiet-hours intervals and equal endpoints', () => {
    const date = (hour, minute = 0) => new Date(2026, 0, 1, hour, minute);
    assert.equal(isWithinQuietHours(date(23, 0), '22:00', '07:00'), true);
    assert.equal(isWithinQuietHours(date(6, 59), '22:00', '07:00'), true);
    assert.equal(isWithinQuietHours(date(7, 0), '22:00', '07:00'), false);
    assert.equal(isWithinQuietHours(date(12, 0), '22:00', '07:00'), false);
    assert.equal(isWithinQuietHours(date(12, 0), '12:00', '12:00'), false);
    assert.equal(isWithinQuietHours(date(12, 0), 'invalid', '12:00'), false);
});

test('publishes a versioned non-secret notification summary with consistent totals', () => {
    const summary = createNotificationSummary(4, 3, true, '2026-10-22T10:00:00.000Z');
    assert.deepEqual(summary, {
        version: 1,
        enabled: true,
        unreadNotifications: 4,
        activityItems: 3,
        totalCount: 7,
        updatedAt: '2026-10-22T10:00:00.000Z',
    });
    assert.equal(Object.hasOwn(summary, 'token'), false);
    assert.equal(Object.hasOwn(summary, 'username'), false);
});

test('normalizes invalid public summary counts to zero and reports disabled state', () => {
    assert.deepEqual(createNotificationSummary(-1, Number.NaN, false, 'timestamp'), {
        version: 1,
        enabled: false,
        unreadNotifications: 0,
        activityItems: 0,
        totalCount: 0,
        updatedAt: 'timestamp',
    });
});

test('suppresses desktop alerts for quiet hours or GNOME Do Not Disturb without conflating polling state', () => {
    assert.equal(shouldSuppressDesktopNotifications(true, true), true);
    assert.equal(shouldSuppressDesktopNotifications(false, false), true);
    assert.equal(shouldSuppressDesktopNotifications(false, true), false);
    assert.equal(shouldSuppressDesktopNotifications(false, undefined), false);
});


test('daily statistics accumulate local counts and report today and seven-day totals', () => {
    const yesterday = updateDailyStats({}, '2026-10-21', 9, 1);
    const stats = updateDailyStats(yesterday, '2026-10-22', 3, 2);
    const later = updateDailyStats(stats, '2026-10-22', 1, 4);
    assert.deepEqual(getDailyStatsTotals(later, '2026-10-22'), {
        todayNotifications: 4, todayActivity: 6, weekNotifications: 13, weekActivity: 7,
    });
});

test('daily statistics discard invalid, future, and older-than-seven-day entries', () => {
    const stats = updateDailyStats({
        '2026-10-01': {notifications: 99, activity: 99},
        '2026-10-16': {notifications: 2, activity: 3},
        '2026-10-23': {notifications: 80, activity: 80},
        'bad-date': {notifications: 100, activity: 100},
        '2026-10-20': {notifications: -2, activity: Number.NaN},
    }, '2026-10-22', 1, 2);
    assert.deepEqual(stats, {
        '2026-10-16': {notifications: 2, activity: 3},
        '2026-10-20': {notifications: 0, activity: 0},
        '2026-10-22': {notifications: 1, activity: 2},
    });
    assert.throws(() => updateDailyStats({}, '2026-02-30', 1, 1), /valid YYYY-MM-DD/);
});


test('builds HTTPS API bases for GitHub.com and Enterprise deployments', () => {
    assert.equal(getApiBase('api.github.com'), 'https://api.github.com');
    assert.equal(getApiBase('git.example.com'), 'https://git.example.com/api/v3');
    assert.equal(getApiBase('git.example.com/enterprise/api/v3/'), 'https://git.example.com/enterprise/api/v3');
    assert.equal(getApiBase('git.example.com:8443/enterprise/api/v3'), 'https://git.example.com:8443/enterprise/api/v3');
});

test('rejects API host values that could redirect credentials or form malformed URLs', () => {
    for (const value of [
        '', 'https://evil.example', 'http://git.example.com', 'user@evil.example',
        'git.example.com?next=evil.example', 'git.example.com#fragment',
        'git.example.com\\\\evil.example', 'git.example.com/../other',
        'git.example.com/%2e%2e/other', 'git.example.com/%2E./other', 'git.example.com/%2e/other',
        'git.example.com/%252e%252e/other', 'git.example.com/%25252e%25252e/other',
        'git.example.com/%2fadmin', 'git.example.com/%5cadmin',
        'git.example.com/%252fadmin', 'git.example.com/%255cadmin', 'git.example.com/%ZZ/other',
        'git example.com', null, 42,
    ]) {
        assert.throws(() => getApiBase(value), TypeError, String(value));
    }
});


test('maps notification and activity items to installed Adwaita symbolic icons', () => {
    const cases = [
        [{kind: 'notification', subjectType: 'PullRequest'}, 'insert-link-symbolic'],
        [{kind: 'notification', subjectType: 'Issue'}, 'chat-message-new-symbolic'],
        [{kind: 'notification', subjectType: 'Commit'}, 'document-edit-symbolic'],
        [{kind: 'notification', subjectType: 'Release'}, 'tag-symbolic'],
        [{kind: 'notification', subjectType: 'CheckSuite'}, 'emblem-ok-symbolic'],
        [{kind: 'notification', subjectType: 'WorkflowRun'}, 'media-playback-start-symbolic'],
        [{kind: 'notification', subjectType: 'Discussion'}, 'chat-bubbles-symbolic'],
        [{kind: 'notification', subjectType: 'Unknown'}, 'mail-unread-symbolic'],
        [{kind: 'pr'}, 'insert-link-symbolic'],
        [{kind: 'issue'}, 'chat-message-new-symbolic'],
        [{kind: 'star'}, 'starred-symbolic'],
        [{kind: 'other'}, 'mail-unread-symbolic'],
        [null, 'mail-unread-symbolic'],
    ];
    for (const [item, expected] of cases)
        assert.equal(getNotificationIconName(item), expected, JSON.stringify(item));
});


test('formats relative ages at boundaries and handles invalid or future timestamps', () => {
    const now = Date.parse('2026-10-23T00:00:00Z');
    const ago = seconds => new Date(now - seconds * 1000).toISOString();
    for (const [seconds, expected] of [
        [0, 'just now'], [59, 'just now'], [60, '1m ago'], [3599, '59m ago'],
        [3600, '1h ago'], [86399, '23h ago'], [86400, '1d ago'],
        [2591999, '29d ago'], [2592000, '1mo ago'],
    ]) assert.equal(formatRelativeTime(ago(seconds), now), expected, String(seconds));
    assert.equal(formatRelativeTime('not a timestamp', now), '');
    assert.equal(formatRelativeTime('', now), '');
    assert.equal(formatRelativeTime(ago(-300), now), 'just now');
});


test('composes compact secondary detail text for each item kind', () => {
    assert.equal(getItemDetail({kind: 'notification', subtitle: 'owner/repo', reasonLabel: 'Mention'}, '5m ago'), 'owner/repo · Mention · 5m ago');
    assert.equal(getItemDetail({kind: 'notification', subtitle: 'owner/repo'}, '1h ago'), 'owner/repo · notification · 1h ago');
    assert.equal(getItemDetail({kind: 'pr', subtitle: 'owner/repo'}, '2d ago'), 'owner/repo · PR · 2d ago');
    assert.equal(getItemDetail({kind: 'issue', subtitle: 'owner/repo'}, 'just now'), 'owner/repo · issue · just now');
    assert.equal(getItemDetail({kind: 'star', subtitle: 'owner/repo'}, '3d ago'), 'owner/repo · star · 3d ago');
    assert.equal(getItemDetail({kind: 'other', subtitle: 'owner/repo'}, ''), 'owner/repo · ');
    assert.equal(getItemDetail(null, ''), ' · ');
});


test('labels GitHub notification reasons and subject types consistently', () => {
    for (const [reason, expected] of [
        ['mention', 'Mention'], ['review_requested', 'Review requested'],
        ['assign', 'Assigned'], ['author', 'Update on your thread'],
        ['comment', 'New comment'], ['state_change', 'State changed'],
        ['subscribed', 'Activity'], ['team_mention', 'Team mention'],
        ['unknown', 'Notification'], ['', 'Notification'],
    ]) assert.equal(getNotificationReasonLabel(reason, ''), expected, reason);
    for (const [type, expected] of [
        ['Release', 'New release'], ['Commit', 'New commit'],
        ['CheckSuite', 'CI run'], ['WorkflowRun', 'CI run'],
    ]) assert.equal(getNotificationReasonLabel('mention', type), expected, type);
});


test('formats local calendar dates with stable zero padding', () => {
    assert.equal(formatLocalDateKey(new Date(2026, 0, 2, 23, 59)), '2026-01-02');
    assert.equal(formatLocalDateKey(new Date(2026, 9, 23)), '2026-10-23');
    assert.equal(formatLocalDateKey(new Date(2000, 11, 31)), '2000-12-31');
});


test('updates repository membership safely and handles rejected settings writes', () => {
    const values = new Map([['muted-repos', 'Owner/Repo, other/project']]);
    let rejectWrites = false;
    const settings = {
        get_string(key) { return values.get(key) ?? ''; },
        set_string(key, value) { if (rejectWrites) return false; values.set(key, value); return true; },
    };
    assert.equal(setRepositoryMembership(settings, 'muted-repos', 'OWNER/REPO', true), true);
    assert.equal(values.get('muted-repos'), 'owner/repo, other/project');
    assert.equal(setRepositoryMembership(settings, 'muted-repos', 'New/Repo', true), true);
    assert.equal(values.get('muted-repos'), 'owner/repo, other/project, new/repo');
    assert.equal(setRepositoryMembership(settings, 'muted-repos', 'OTHER/PROJECT', false), true);
    assert.equal(values.get('muted-repos'), 'owner/repo, new/repo');
    assert.equal(setRepositoryMembership(settings, 'muted-repos', 'invalid', true), false);
    rejectWrites = true;
    assert.equal(setRepositoryMembership(settings, 'muted-repos', 'new/another', true), false);
});


test('resolves browser base URLs for GitHub.com and GitHub Enterprise hosts', () => {
    assert.equal(getWebBase(''), 'https://github.com');
    assert.equal(getWebBase('api.github.com'), 'https://github.com');
    assert.equal(getWebBase('git.example.com/api/v3'), 'https://git.example.com');
    assert.equal(getWebBase('git.example.com/github/api/v3/'), 'https://git.example.com/github');
});

test('converts GitHub API subject URLs into browser-facing issue, PR, commit and action links', () => {
    const api = 'https://git.example.com/github/api/v3';
    const web = 'https://git.example.com/github';
    const repo = 'owner/project';
    assert.equal(getSubjectHtmlUrl({type: 'Issue', url: `${api}/repos/${repo}/issues/7`}, repo, api, web), `${web}/${repo}/issues/7`);
    assert.equal(getSubjectHtmlUrl({type: 'Discussion', url: `${api}/repos/${repo}/discussions/9`}, repo, api, web), `${web}/${repo}/discussions/9`);
    assert.equal(getSubjectHtmlUrl({type: 'PullRequest', url: `${api}/repos/${repo}/pulls/8`}, repo, api, web), `${web}/${repo}/pull/8`);
    assert.equal(getSubjectHtmlUrl({type: 'Commit', url: `${api}/repos/${repo}/commits/abc`}, repo, api, web), `${web}/${repo}/commit/abc`);
    assert.equal(getSubjectHtmlUrl({type: 'Release', url: `${api}/repos/${repo}/releases/3`}, repo, api, web), `${web}/${repo}/releases`);
    assert.equal(getSubjectHtmlUrl({type: 'WorkflowRun', url: `${api}/repos/${repo}/actions/runs/2`}, repo, api, web), `${web}/${repo}/actions`);
    assert.equal(getSubjectHtmlUrl({type: 'Unknown', url: `${api}/repos/${repo}/x`}, repo, api, web), `${web}/${repo}`);
    assert.equal(getSubjectHtmlUrl({}, repo, api, web), `${web}/${repo}`);
});
