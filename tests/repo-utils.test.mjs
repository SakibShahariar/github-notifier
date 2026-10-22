import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

// Load the exact helper source as an ES module without requiring a package.json
// change that could affect GNOME Shell's extension module loading.
const helperSource = await readFile(new URL('../repo-utils.js', import.meta.url), 'utf8');
const helperUrl = `data:text/javascript;base64,${Buffer.from(helperSource).toString('base64')}`;
const {getApiPathFromAbsoluteUrl, getGitHubCliArguments, getNotificationCategory, isRepositoryMuted, isValidClockTime, isValidRepository, isWithinQuietHours, parseRepositoryList} = await import(helperUrl);

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
