import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gio from 'gi://Gio';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

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
            description: 'PAT needs notifications + repo scopes.',
        });
        accountPage.add(accountGroup);

        const tokenRow = new Adw.PasswordEntryRow({title: 'Personal access token'});
        tokenRow.add_prefix(new Gtk.Image({icon_name: 'dialog-password-symbolic', pixel_size: 16}));
        tokenRow.set_text(settings.get_string('github-token'));
        tokenRow.connect('notify::text', () => settings.set_string('github-token', tokenRow.get_text()));
        accountGroup.add(tokenRow);

        const userRow = new Adw.EntryRow({title: 'GitHub username'});
        userRow.add_prefix(new Gtk.Image({icon_name: 'system-users-symbolic', pixel_size: 16}));
        userRow.set_text(settings.get_string('github-username'));
        userRow.connect('notify::text', () => settings.set_string('github-username', userRow.get_text()));
        accountGroup.add(userRow);

        const hostRow = new Adw.EntryRow({title: 'API host'});
        hostRow.add_prefix(new Gtk.Image({icon_name: 'network-server-symbolic', pixel_size: 16}));
        hostRow.set_text(settings.get_string('github-host'));
        hostRow.connect('notify::text', () => settings.set_string('github-host', hostRow.get_text().trim()));
        accountGroup.add(hostRow);

        // Page 2: Watching
        const watchPage = new Adw.PreferencesPage({
            title: 'Watching',
            icon_name: 'view-reveal-symbolic',
        });
        window.add(watchPage);

        const watchGroup = new Adw.PreferencesGroup({title: 'What to watch'});
        watchPage.add(watchGroup);

        const mentionsRow = new Adw.SwitchRow({
            title: 'Mentions &amp; review requests',
            subtitle: 'Inbox notifications',
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

        const REPO_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?\/[A-Za-z0-9._-]+$/;

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
                const isInvalid = txt.length > 0 && !REPO_RE.test(txt);
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
            const isInvalid = txt.length > 0 && !REPO_RE.test(txt);
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

        const pollGroup = new Adw.PreferencesGroup({title: 'Polling'});
        settingsPage.add(pollGroup);

        const intervalRow = new Adw.SpinRow({
            title: 'Interval',
            subtitle: 'Seconds, min 30s',
            adjustment: new Gtk.Adjustment({lower: 30, upper: 3600, step_increment: 30}),
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
