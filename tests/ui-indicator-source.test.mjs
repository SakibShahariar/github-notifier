import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('../ui-indicator.js', import.meta.url), 'utf8');
const extensionSource = await readFile(new URL('../extension.js', import.meta.url), 'utf8');
const stylesheet = await readFile(new URL('../stylesheet.css', import.meta.url), 'utf8');

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

test('repository action icons are consistently sized and can be hidden from preferences', async () => {
    const prefsSource = await readFile(new URL('../prefs.js', import.meta.url), 'utf8');
    const schema = await readFile(new URL('../schemas/org.gnome.shell.extensions.github-notifier.gschema.xml', import.meta.url), 'utf8');
    assert.equal((source.match(/icon_size: 16/g) || []).length >= 4, true);
    assert.match(source, /showRepositoryActions && repository/);
    assert.match(source, /showRepositoryActions && repositoryForMute/);
    assert.match(source, /showRepositoryActions && githubCliConfig/);
    assert.match(prefsSource, /settings\.bind\('show-repository-actions', repositoryActionsRow/);
    assert.match(schema, /<key name="show-repository-actions" type="b">\s*<default>true<\/default>/);
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

test('box layout spacing uses CSS because GNOME Shell 51 removed the spacing property', () => {
    assert.doesNotMatch(source, /new St\.BoxLayout\(\{[^}]*[,{]\s*spacing:/,
        'St.BoxLayout({spacing: ...}) throws "No property spacing on StBoxLayout" on Shell 51');
    assert.ok(source.includes("new St.BoxLayout({style: 'spacing: 6px;'"));
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


test('notification and activity rows expose concise descriptive accessible names', () => {
    assert.match(source, /const rowKind = \(\{[\s\S]*?notification: 'Notification'[\s\S]*?issue: 'Issue'[\s\S]*?pr: 'Pull request'[\s\S]*?star: 'New star'/);
    assert.match(source, /menuItem\.accessible_name = indicator\._truncate\(\[\.\.\.new Set\(rowParts\)\]\.join\(', '\), 180\)/);
    assert.match(source, /indicator\._detailForItem\(item\)/);
});


test('cached notification search is accessible, resets pagination, and provides a no-match state', () => {
    assert.match(source, /hint_text: 'Search notifications…'/);
    assert.match(source, /accessible_name = 'Search cached notifications'/);
    assert.match(source, /indicator\._notificationSearchQuery = indicator\._notificationSearchEntry\.get_text\(\)/);
    assert.match(source, /indicator\._notificationsPage = 0/);
    assert.match(source, /No cached notifications match your search\./);
    assert.match(source, /notificationSearchQuery: indicator\._notificationSearchQuery/);
});


test('render cache invalidates when an existing item changes its visible details or destination', () => {
    assert.match(source, /notifications: indicator\._notificationItems\.map\(i => \[i\.id, i\.title, i\.subtitle, i\.ts, i\.url, i\.kind, i\.rawId\]\)/);
    assert.match(source, /activity: indicator\._activityItems\.map\(i => \[i\.id, i\.title, i\.subtitle, i\.ts, i\.url, i\.kind\]\)/);
});


test('render cache invalidates when empty-state credential or fetch context changes', () => {
    for (const field of [
        "watchEnabled: indicator._settings.get_boolean('watch-mentions')",
        'tokenLoading: indicator._tokenLoading',
        'hasToken: Boolean(indicator._token)',
        'tokenWarning: indicator._tokenWarning',
        'hasFetched: Boolean(indicator._lastFetchedAt)',
    ]) assert.ok(source.includes(field), `missing empty-state render-cache input: ${field}`);
});

test('bundled SVG icons use Gio.FileIcon for panel and menu rendering', () => {
    assert.equal((source.match(/new Gio\.FileIcon\(\{file: Gio\.File\.new_for_path\(iconPath\)\}\)/g) || []).length, 2);
    assert.doesNotMatch(source, /Gio\.icon_new_for_string\(iconPath\)/);
});


test('panel icon has an explicit size and a dedicated styling hook', () => {
    assert.match(source, /style_class: 'system-status-icon github-notifier-panel-icon'[\s\S]*?icon_size: 16/);
    assert.match(stylesheet, /\.github-notifier-panel-icon\s*\{\s*icon-size:\s*16px;\s*-st-icon-style:\s*symbolic;/);
});

test('notification menu is compact and row text cannot force excessive width', () => {
    assert.match(stylesheet, /\.github-notifier-menu\s*\{\s*min-width:\s*360px;\s*max-width:\s*420px;/);
    assert.doesNotMatch(stylesheet, /min-width:\s*440px/);
    assert.match(stylesheet, /\.github-notifier-row-title\s*\{[^}]*max-width:\s*250px;/s);
    assert.match(stylesheet, /\.github-notifier-row-detail\s*\{[^}]*max-width:\s*250px;/s);
});

test('row action strip sizes to its actions and keeps a right inset', () => {
    assert.match(stylesheet, /\.github-notifier-read-strip\s*\{\s*spacing:\s*2px;\s*padding:\s*0 8px 0 4px;/);
    assert.doesNotMatch(source, /if \(indicator\.hasMotion\(\)\) indicator\._addButtonHoverScale\(btn\);\s*\}\s*\n\s*\/\/ Construct the menu's stable skeleton/);
});

test('base stylesheet has no dangling hover selector commas', () => {
    assert.doesNotMatch(stylesheet, /:\s*(?:hover|focus|selected|insensitive),\s*(?:\/\*|\n\s*\})/);
});
