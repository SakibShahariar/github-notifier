import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('../ui-indicator.js', import.meta.url), 'utf8');
const extensionSource = await readFile(new URL('../extension.js', import.meta.url), 'utf8');

test('repository activity footer opens the correct tab for issue-only and PR-only sections', () => {
    assert.match(source, /issuePrItems\[0\]\.kind === 'pr' \? 'pulls'/);
    assert.match(source, /issuePrItems\[0\]\.kind === 'issue' \? 'issues'/);
    assert.match(source, /issuePrItems\.map\(item => item\.kind\)\)\.size === 1/);
});

test('panel tooltip updates target the indicator actor, not module this', () => {
    assert.match(source, /indicator\._setTooltip\(indicator, 'GitHub Notifier — attention needed'\)/);
    assert.match(source, /indicator\._setTooltip\(indicator,.*unread/);
    assert.match(source, /indicator\._setTooltip\(indicator, 'GitHub Notifier'\)/);
    assert.doesNotMatch(source, /indicator\._setTooltip\(this,/);
});

test('icon-only menu controls retain tooltip/accessibility labels', () => {
    for (const label of ['Previous page', 'Next page', 'Settings', 'Open with GitHub CLI', 'Mark read', 'Dismiss'])
        assert.ok(source.includes(label), `missing accessible control label: ${label}`);
});

test('panel and status actions expose stable accessible names and keyboard activation', () => {
    assert.match(extensionSource, /this\.accessible_name = 'GitHub Notifier'/);
    assert.match(source, /indicator\._setTooltip\(gearButton, 'Settings'\)/);
    assert.match(source, /indicator\._statusActionItem\.connect\('activate'/);
    assert.match(source, /indicator\._statusActionItem\.visible = indicator\._statusAction !== null/);
});


test('action status generation prevents stale transient timers from hiding newer messages', () => {
    assert.match(source, /indicator\._actionStatusGeneration = generation/);
    assert.match(source, /statusGeneration === indicator\._actionStatusGeneration/);
});


test('icon-only controls have explicit accessible names, not just tooltips', () => {
    for (const line of [
        'btn.accessible_name = accessibleLabel;',
        'watchButton.accessible_name = `Watch ${repository}`;',
        'muteButton.accessible_name = muted ? `Unmute ${repositoryForMute}` : `Mute ${repositoryForMute}`;',
        "cliButton.accessible_name = 'Open with GitHub CLI';",
        "btn.accessible_name = item.kind === 'notification' ? 'Mark read' : 'Dismiss';",
        "gearButton.accessible_name = 'Settings';",
    ]) assert.ok(source.includes(line), `missing accessible name assignment: ${line}`);
});

test('pagination position is announced as a page number to assistive technology', () => {
    assert.ok(source.includes('lab.accessible_name = `Page ${opts.page + 1} of ${opts.pageCount}`;'));
});

test('disabled pagination buttons are excluded from keyboard focus', () => {
    assert.ok(source.includes('prev.reactive = !previousDisabled;'));
    assert.ok(source.includes('prev.can_focus = !previousDisabled;'));
    assert.ok(source.includes('next.reactive = !nextDisabled;'));
    assert.ok(source.includes('next.can_focus = !nextDisabled;'));
});


test('empty-state rendering supplies credential, fetch, error, and cache context', () => {
    assert.match(source, /getNotificationEmptyState\(\{/);
    assert.match(source, /tokenLoading: indicator\._tokenLoading/);
    assert.match(source, /hasToken: Boolean\(indicator\._token\)/);
    assert.match(source, /tokenWarning: indicator\._tokenWarning/);
    assert.match(source, /statusIsError: indicator\._statusIsError/);
    assert.match(source, /hasFetched: Boolean\(indicator\._lastFetchedAt\)/);
    assert.match(source, /hasCachedNotifications: indicator\._notificationItems\.length > 0/);
});
