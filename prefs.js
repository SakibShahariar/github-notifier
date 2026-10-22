import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';
import {isValidClockTime, isValidRepository} from './repo-utils.js';
import {clearGithubToken, loadGithubToken, storeGithubToken} from './secret-store.js';

function signalTokenChanged(settings) {
    const current = settings.get_int('token-generation');
    settings.set_int('token-generation', current >= 2147483647 ? 0 : current + 1);
}

export default class GithubNotifierPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        // Page 1: Account
        const accountPage = new Adw.PreferencesPage({
            title: 'Account',
            icon_name: 'avatar-default-symbolic',
        });
        window.add(accountPage);

        const accountGroup = new Adw.PreferencesGroup({
            title: 'GitHub account',
            description: 'Use a classic personal access token. The inbox needs the notifications scope; repo scope is only needed for private repositories you watch.',
        });
        accountPage.add(accountGroup);

        const tokenRow = new Adw.PasswordEntryRow({title: 'Personal access token', show_apply_button: true});
        tokenRow.add_prefix(new Gtk.Image({icon_name: 'dialog-password-symbolic', pixel_size: 16}));
        tokenRow.set_text('');
        tokenRow.connect('apply', async () => {
            const token = tokenRow.get_text().trim();
            if (!token) {
                testRow.subtitle = 'Enter a token to save or use Remove saved token to delete the stored credential';
                return;
            }
            tokenRow.set_sensitive(false);
            try {
                const host = settings.get_string('github-host').trim() || 'api.github.com';
                await storeGithubToken(host, token);
                // Clear legacy plaintext only after Secret Service confirms storage.
                if (settings.get_string('github-token'))
                    settings.set_string('github-token', '');
                signalTokenChanged(settings);
                tokenRow.set_text('');
                testRow.subtitle = 'Token saved in Secret Service';
            } catch (error) {
                testRow.subtitle = 'Could not save token: ' + error.message;
            } finally {
                tokenRow.set_sensitive(true);
            }
        });
        accountGroup.add(tokenRow);

        const userRow = new Adw.EntryRow({title: 'GitHub username', show_apply_button: true});
        userRow.add_prefix(new Gtk.Image({icon_name: 'system-users-symbolic', pixel_size: 16}));
        userRow.set_text(settings.get_string('github-username'));
        userRow.connect('apply', () => settings.set_string('github-username', userRow.get_text().trim()));
        accountGroup.add(userRow);

        const hostRow = new Adw.EntryRow({title: 'API host', show_apply_button: true});
        hostRow.add_prefix(new Gtk.Image({icon_name: 'network-server-symbolic', pixel_size: 16}));
        hostRow.set_text(settings.get_string('github-host'));
        hostRow.connect('apply', () => settings.set_string('github-host', hostRow.get_text().trim()));
        accountGroup.add(hostRow);

        // Test connection against /user (or /rate_limit as fallback messaging)
        const testRow = new Adw.ActionRow({
            title: 'Test connection',
            subtitle: 'Validate token and API host',
        });
        testRow.add_prefix(new Gtk.Image({icon_name: 'network-transmit-receive-symbolic', pixel_size: 16}));
        const testBtn = new Gtk.Button({label: 'Test', valign: Gtk.Align.CENTER});
        testBtn.add_css_class('pill');
        testRow.add_suffix(testBtn);
        testRow.set_activatable_widget(testBtn);
        accountGroup.add(testRow);

        const removeTokenRow = new Adw.ActionRow({
            title: 'Remove saved token',
            subtitle: 'Delete this API host’s token from Secret Service and clear any legacy setting.',
        });
        removeTokenRow.add_prefix(new Gtk.Image({icon_name: 'user-trash-symbolic', pixel_size: 16}));
        const removeTokenBtn = new Gtk.Button({label: 'Remove', valign: Gtk.Align.CENTER});
        removeTokenBtn.add_css_class('pill');
        removeTokenRow.add_suffix(removeTokenBtn);
        removeTokenRow.set_activatable_widget(removeTokenBtn);
        accountGroup.add(removeTokenRow);
        removeTokenBtn.connect('clicked', async () => {
            removeTokenBtn.set_sensitive(false);
            try {
                const host = settings.get_string('github-host').trim() || 'api.github.com';
                await clearGithubToken(host);
                if (settings.get_string('github-token'))
                    settings.set_string('github-token', '');
                signalTokenChanged(settings);
                tokenRow.set_text('');
                testRow.subtitle = 'Saved token removed for this API host';
            } catch (error) {
                testRow.subtitle = 'Could not remove token: ' + error.message;
            } finally {
                removeTokenBtn.set_sensitive(true);
            }
        });

        let testing = false;
        testBtn.connect('clicked', async () => {
            if (testing)
                return;
            let token = tokenRow.get_text().trim();
            if (!token) {
                try {
                    token = (await loadGithubToken(settings)).token;
                } catch (_error) {
                    testRow.subtitle = 'Secret Service is unavailable. Unlock or install a compatible keyring, then try again.';
                    return;
                }
            }
            if (!token) {
                testRow.subtitle = 'Add a token first';
                return;
            }
            testing = true;
            testBtn.set_sensitive(false);
            const configuredHost = settings.get_string('github-host').trim() || 'api.github.com';
            testRow.subtitle = configuredHost === 'api.github.com'
                ? 'Checking…'
                : `Checking… your token will be sent to ${configuredHost}`;

            let host = settings.get_string('github-host').trim() || 'api.github.com';
            let apiBase;
            if (host === 'api.github.com')
                apiBase = `https://${host}`;
            else if (host.includes('/'))
                apiBase = `https://${host.replace(/\/+$/, '')}`;
            else
                apiBase = `https://${host}/api/v3`;

            const session = new Soup.Session({timeout: 15});
            const uri = GLib.Uri.parse(`${apiBase}/user`, GLib.UriFlags.NONE);
            const msg = new Soup.Message({method: 'GET', uri});
            msg.request_headers.append('Accept', 'application/vnd.github+json');
            msg.request_headers.append('X-GitHub-Api-Version', '2022-11-28');
            msg.request_headers.append('User-Agent', 'gnome-shell-github-notifier');
            msg.request_headers.append('Authorization', `Bearer ${token}`);

            session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, null, (_s, res) => {
                testing = false;
                testBtn.set_sensitive(true);
                try {
                    const bytes = session.send_and_read_finish(res);
                    const status = msg.get_status();
                    if (status === 401) {
                        testRow.subtitle = 'Invalid or expired token';
                        return;
                    }
                    if (status === 403) {
                        testRow.subtitle = 'Forbidden — check scopes or rate limit';
                        return;
                    }
                    if (status < 200 || status >= 300) {
                        testRow.subtitle = `API returned ${status}`;
                        return;
                    }
                    let login = '';
                    try {
                        const data = JSON.parse(new TextDecoder('utf-8').decode(bytes.get_data()));
                        login = data.login || '';
                    } catch (_e) {
                        /* ignore parse errors; status already OK */
                    }
                    const scopes = msg.response_headers.get_one('X-OAuth-Scopes');
                    const remaining = msg.response_headers.get_one('X-RateLimit-Remaining');
                    const details = [];
                    if (scopes)
                        details.push(`scopes: ${scopes}`);
                    if (remaining !== null && remaining !== undefined)
                        details.push(`${remaining} API requests remaining`);
                    const summary = details.length ? ` · ${details.join(' · ')}` : '';
                    const hostWarning = configuredHost === 'api.github.com'
                        ? ''
                        : ` · token sent to ${configuredHost}`;
                    if (login) {
                        testRow.subtitle = `Connected as ${login}${summary}${hostWarning}`;
                        const curUser = settings.get_string('github-username').trim();
                        if (!curUser)
                            settings.set_string('github-username', login);
                    } else {
                        testRow.subtitle = `Connected${summary}${hostWarning}`;
                    }
                } catch (e) {
                    testRow.subtitle = `Network error: ${e.message}`;
                }
            });
        });

        // Page 2: Watching
        const watchPage = new Adw.PreferencesPage({
            title: 'Watching',
            icon_name: 'view-reveal-symbolic',
        });
        window.add(watchPage);

        const watchGroup = new Adw.PreferencesGroup({title: 'What to watch'});
        watchPage.add(watchGroup);

        const mentionsRow = new Adw.SwitchRow({
            title: 'Unread notifications',
            subtitle: 'Full inbox mirror (mentions, reviews, subscribed threads)',
        });
        mentionsRow.add_prefix(new Gtk.Image({icon_name: 'mail-unread-symbolic', pixel_size: 16}));
        settings.bind('watch-mentions', mentionsRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        watchGroup.add(mentionsRow);

        const issuesRow = new Adw.SwitchRow({
            title: 'New issues &amp; pull requests',
            subtitle: 'On watched repos',
        });
        issuesRow.add_prefix(new Gtk.Image({icon_name: 'view-list-symbolic', pixel_size: 16}));
        settings.bind('watch-issues-prs', issuesRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        watchGroup.add(issuesRow);

        const starsRow = new Adw.SwitchRow({
            title: 'New stars',
            subtitle: 'On watched repos',
        });
        starsRow.add_prefix(new Gtk.Image({icon_name: 'starred-symbolic', pixel_size: 16}));
        settings.bind('watch-stars', starsRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        watchGroup.add(starsRow);

        const filterGroup = new Adw.PreferencesGroup({
            title: 'Notification filters',
            description: 'Choose which inbox categories appear in the list, badge, and desktop notifications.',
        });
        watchPage.add(filterGroup);

        const filterRows = [
            ['filter-mentions', 'Mentions', 'Direct and team mentions', 'user-available-symbolic'],
            ['filter-reviews', 'Reviews', 'Review requests and reviewer changes', 'document-edit-symbolic'],
            ['filter-assignments', 'Assignments', 'Issues and pull requests assigned to you', 'checkbox-checked-symbolic'],
            ['filter-conversation', 'Conversation', 'Comments and subscribed-thread activity', 'chat-message-new-symbolic'],
            ['filter-checks', 'CI and checks', 'Workflow runs and check activity', 'emblem-ok-symbolic'],
            ['filter-other', 'Other notifications', 'Security alerts, invitations, and unmapped reasons', 'view-more-symbolic'],
        ];
        for (const [key, title, subtitle, iconName] of filterRows) {
            const row = new Adw.SwitchRow({title, subtitle});
            row.add_prefix(new Gtk.Image({icon_name: iconName, pixel_size: 16}));
            settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
            filterGroup.add(row);
        }

        const mutedGroup = new Adw.PreferencesGroup({
            title: 'Muted repositories',
            description: 'Muted repositories are skipped by issue/star polling and hidden from the inbox list, badge, and desktop banners. GitHub notifications remain unread.',
        });
        watchPage.add(mutedGroup);

        const mutedRow = new Adw.EntryRow({
            title: 'Repositories to mute (comma-separated)',
            show_apply_button: true,
        });
        mutedRow.set_text(settings.get_string('muted-repos'));
        mutedGroup.add(mutedRow);

        const mutedError = new Adw.Banner({
            title: 'Invalid repository — use owner/repo, separated by commas',
            revealed: false,
        });
        mutedGroup.add(mutedError);

        mutedRow.connect('apply', () => {
            const values = Array.from(new Set(
                mutedRow.get_text().split(',').map(value => value.trim()).filter(Boolean)
            ));
            const invalid = values.filter(value => !isValidRepository(value));
            if (invalid.length > 0) {
                mutedError.set_title(`Invalid repository: ${invalid[0]}`);
                mutedError.set_revealed(true);
                return;
            }
            mutedError.set_revealed(false);
            settings.set_string('muted-repos', values.join(', '));
            mutedRow.set_text(values.join(', '));
        });

        settings.connect('changed::muted-repos', () => {
            if (mutedRow.get_text() !== settings.get_string('muted-repos'))
                mutedRow.set_text(settings.get_string('muted-repos'));
        });

        const reposGroup = new Adw.PreferencesGroup({
            title: 'Watched repositories',
            description: 'One owner/repo per row — verified as owner/repo',
        });
        watchPage.add(reposGroup);

        const invalidBanner = new Adw.Banner({
            title: 'Invalid repo — expected owner/repo (e.g. torvalds/linux)',
            revealed: false,
        });
        const emptyBanner = new Adw.Banner({
            title: 'No repos — add one or disable watches.',
            revealed: false,
        });
        reposGroup.add(invalidBanner);
        reposGroup.add(emptyBanner);

        const repoRows = [];
        let syncing = false;

        const syncRepos = () => {
            if (syncing) return;
            const values = repoRows.map(r => r.get_text().trim()).filter(t => t.length > 0);
            syncing = true;
            settings.set_string('watched-repos', values.join(', '));
            syncing = false;
            let hasInvalid = false;
            for (const row of repoRows) {
                const txt = row.get_text().trim();
                const isInvalid = txt.length > 0 && !isValidRepository(txt);
                if (isInvalid) hasInvalid = true;
                if (isInvalid) row.add_css_class('error');
                else row.remove_css_class('error');
                // suffix warning icon is second suffix; toggle visibility via row._warnIcon
                if (row._warnIcon) row._warnIcon.set_visible(isInvalid);
            }
            invalidBanner.set_revealed(hasInvalid);
            const hasWatch = settings.get_boolean('watch-issues-prs') || settings.get_boolean('watch-stars');
            emptyBanner.set_revealed(hasWatch && values.length === 0);
        };

        const createRepoRow = (initialText) => {
            const row = new Adw.EntryRow({title: 'Repository'});
            row.set_text(initialText);
            row.add_prefix(new Gtk.Image({icon_name: 'system-software-install-symbolic', pixel_size: 16}));
            const warnIcon = new Gtk.Image({icon_name: 'dialog-warning-symbolic', pixel_size: 16, tooltip_text: 'Invalid — use owner/repo'});
            warnIcon.set_visible(false);
            row._warnIcon = warnIcon;
            row.add_suffix(warnIcon);
            const delBtn = new Gtk.Button({icon_name: 'edit-delete-symbolic', valign: Gtk.Align.CENTER, tooltip_text: 'Remove repository'});
            delBtn.add_css_class('flat');
            delBtn.connect('clicked', () => {
                const idx = repoRows.indexOf(row);
                if (idx >= 0) repoRows.splice(idx, 1);
                reposGroup.remove(row);
                syncRepos();
            });
            row.add_suffix(delBtn);
            row.connect('notify::text', () => syncRepos());
            // insert before the Add row (last child)
            // find Add row reference
            const addRow = reposGroup._addRowRef;
            if (addRow && addRow.get_parent() === reposGroup) {
                // remove addRow, add new row, re-add addRow to keep it last
                reposGroup.remove(addRow);
                reposGroup.add(row);
                reposGroup.add(addRow);
            } else {
                reposGroup.add(row);
            }
            repoRows.push(row);
            // initial validation without double-sync
            const txt = row.get_text().trim();
            const isInvalid = txt.length > 0 && !isValidRepository(txt);
            if (isInvalid) row.add_css_class('error');
            warnIcon.set_visible(isInvalid);
            return row;
        };

        // Add row (always last)
        const addRow = new Adw.ActionRow({title: 'Add repository', subtitle: 'owner/repo — e.g. gnome/gnome-shell'});
        addRow.add_prefix(new Gtk.Image({icon_name: 'list-add-symbolic', pixel_size: 16}));
        const addButton = new Gtk.Button({label: 'Add', valign: Gtk.Align.CENTER});
        addButton.add_css_class('suggested-action');
        addButton.add_css_class('pill');
        addRow.add_suffix(addButton);
        addButton.connect('clicked', () => {
            const r = createRepoRow('');
            syncRepos();
            // focus new row's entry
            r.grab_focus();
        });
        addRow.set_activatable_widget(addButton);
        reposGroup._addRowRef = addRow;
        reposGroup.add(addRow);

        // populate from existing setting
        const initial = settings.get_string('watched-repos').split(',').map(s => s.trim()).filter(s => s.length > 0);
        for (const repo of initial) createRepoRow(repo);
        // if none, keep empty (user will click Add)
        syncRepos();

        // external change -> rebuild
        settings.connect('changed::watched-repos', () => {
            if (syncing) return;
            const vals = settings.get_string('watched-repos').split(',').map(s => s.trim()).filter(s => s.length > 0);
            const current = repoRows.map(r => r.get_text().trim()).filter(s => s.length > 0).join(',');
            if (vals.join(',') === current) {
                // just re-validate banners
                syncRepos();
                return;
            }
            // rebuild
            for (const r of [...repoRows]) {
                reposGroup.remove(r);
            }
            repoRows.length = 0;
            for (const v of vals) createRepoRow(v);
            syncRepos();
        });
        settings.connect('changed::watch-issues-prs', () => syncRepos());
        settings.connect('changed::watch-stars', () => syncRepos());

        // Page 3: Settings
        const settingsPage = new Adw.PreferencesPage({
            title: 'Settings',
            icon_name: 'preferences-system-symbolic',
        });
        window.add(settingsPage);

        const displayGroup = new Adw.PreferencesGroup({title: 'Display'});
        settingsPage.add(displayGroup);

        const hideEmptyRow = new Adw.SwitchRow({
            title: 'Hide when empty',
            subtitle: 'Show only when unread',
        });
        hideEmptyRow.add_prefix(new Gtk.Image({icon_name: 'view-reveal-symbolic', pixel_size: 16}));
        settings.bind('hide-when-empty', hideEmptyRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        displayGroup.add(hideEmptyRow);

        const unlitRow = new Adw.SwitchRow({
            title: 'Keep icon unlit',
            subtitle: 'Leave Octocat dim even when unread',
        });
        unlitRow.add_prefix(new Gtk.Image({icon_name: 'weather-clear-night-symbolic', pixel_size: 16}));
        settings.bind('icon-always-unlit', unlitRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        displayGroup.add(unlitRow);

        const markReadRow = new Adw.SwitchRow({
            title: 'Mark notifications read when opened',
            subtitle: 'Keep notifications unread when you open their links if disabled',
        });
        markReadRow.add_prefix(new Gtk.Image({icon_name: 'mail-read-symbolic', pixel_size: 16}));
        settings.bind('mark-read-on-open', markReadRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        displayGroup.add(markReadRow);

        const quietGroup = new Adw.PreferencesGroup({
            title: 'Quiet hours',
            description: 'Suppress desktop alerts during a local-time window. GNOME Do Not Disturb is handled by GNOME itself.',
        });
        settingsPage.add(quietGroup);

        const quietEnabledRow = new Adw.SwitchRow({
            title: 'Enable quiet hours',
            subtitle: 'Keep inbox and badge updated without desktop alerts',
        });
        quietEnabledRow.add_prefix(new Gtk.Image({icon_name: 'weather-clear-night-symbolic', pixel_size: 16}));
        settings.bind('quiet-hours-enabled', quietEnabledRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        quietGroup.add(quietEnabledRow);

        const quietStatusRow = new Adw.ActionRow({
            title: 'Quiet-hours time format',
            subtitle: 'Use 24-hour local time (HH:MM); start inclusive, end exclusive.',
        });
        quietGroup.add(quietStatusRow);

        const quietStartRow = new Adw.EntryRow({title: 'Start time (HH:MM)', show_apply_button: true});
        quietStartRow.set_text(settings.get_string('quiet-hours-start'));
        quietStartRow.add_prefix(new Gtk.Image({icon_name: 'go-previous-symbolic', pixel_size: 16}));
        quietStartRow.connect('apply', () => {
            const value = quietStartRow.get_text().trim();
            if (!isValidClockTime(value)) {
                quietStatusRow.subtitle = 'Invalid start time. Use a valid 24-hour time such as 22:00.';
                quietStartRow.set_text(settings.get_string('quiet-hours-start'));
                return;
            }
            settings.set_string('quiet-hours-start', value);
            quietStatusRow.subtitle = 'Quiet-hours start saved.';
        });
        quietGroup.add(quietStartRow);

        const quietEndRow = new Adw.EntryRow({title: 'End time (HH:MM)', show_apply_button: true});
        quietEndRow.set_text(settings.get_string('quiet-hours-end'));
        quietEndRow.add_prefix(new Gtk.Image({icon_name: 'go-next-symbolic', pixel_size: 16}));
        quietEndRow.connect('apply', () => {
            const value = quietEndRow.get_text().trim();
            if (!isValidClockTime(value)) {
                quietStatusRow.subtitle = 'Invalid end time. Use a valid 24-hour time such as 07:00.';
                quietEndRow.set_text(settings.get_string('quiet-hours-end'));
                return;
            }
            settings.set_string('quiet-hours-end', value);
            quietStatusRow.subtitle = 'Quiet-hours end saved.';
        });
        quietGroup.add(quietEndRow);

        const pauseQuietPollingRow = new Adw.SwitchRow({
            title: 'Pause polling during quiet hours',
            subtitle: 'When off, inbox and badge continue updating silently',
        });
        pauseQuietPollingRow.add_prefix(new Gtk.Image({icon_name: 'media-playback-pause-symbolic', pixel_size: 16}));
        settings.bind('pause-polling-during-quiet-hours', pauseQuietPollingRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        quietGroup.add(pauseQuietPollingRow);

        const pollGroup = new Adw.PreferencesGroup({title: 'Polling'});
        settingsPage.add(pollGroup);

        const intervalRow = new Adw.SpinRow({
            title: 'Interval',
            subtitle: 'Seconds, min 60s',
            adjustment: new Gtk.Adjustment({lower: 60, upper: 3600, step_increment: 30}),
        });
        intervalRow.add_prefix(new Gtk.Image({icon_name: 'alarm-symbolic', pixel_size: 16}));
        settings.bind('poll-interval', intervalRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        pollGroup.add(intervalRow);
        // quick presets like omarchy refreshIntervalOptions
        const presetGroup = new Adw.PreferencesGroup({title: 'Quick presets'});
        settingsPage.add(presetGroup);
        const intervalPresets = [
            {label: 'Every 5 minutes', value: 300},
            {label: 'Every 10 minutes', value: 600},
            {label: 'Every 15 minutes', value: 900},
            {label: 'Every 30 minutes', value: 1800},
            {label: 'Every hour', value: 3600},
        ];
        for (const p of intervalPresets) {
            const r = new Adw.ActionRow({title: p.label});
            r.add_prefix(new Gtk.Image({icon_name: 'alarm-symbolic', pixel_size: 16}));
            const btn = new Gtk.Button({label: 'Apply', valign: Gtk.Align.CENTER});
            btn.add_css_class('pill');
            btn.connect('clicked', () => settings.set_int('poll-interval', p.value));
            r.add_suffix(btn);
            r.set_activatable_widget(btn);
            presetGroup.add(r);
        }
    }
}
