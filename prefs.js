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
            icon_name: 'eye-open-negative-filled-symbolic',
        });
        window.add(watchPage);

        const watchGroup = new Adw.PreferencesGroup({title: 'What to watch'});
        watchPage.add(watchGroup);

        const mentionsRow = new Adw.SwitchRow({
            title: 'Mentions & review requests',
            subtitle: 'Inbox notifications',
        });
        mentionsRow.add_prefix(new Gtk.Image({icon_name: 'mail-unread-symbolic', pixel_size: 16}));
        settings.bind('watch-mentions', mentionsRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        watchGroup.add(mentionsRow);

        const issuesRow = new Adw.SwitchRow({
            title: 'New issues & pull requests',
            subtitle: 'On watched repos',
        });
        issuesRow.add_prefix(new Gtk.Image({icon_name: 'bug-symbolic', pixel_size: 16}));
        settings.bind('watch-issues-prs', issuesRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        watchGroup.add(issuesRow);

        const starsRow = new Adw.SwitchRow({
            title: 'New stars',
            subtitle: 'On watched repos',
        });
        starsRow.add_prefix(new Gtk.Image({icon_name: 'starred-symbolic', pixel_size: 16}));
        settings.bind('watch-stars', starsRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        watchGroup.add(starsRow);

        const reposGroup = new Adw.PreferencesGroup({
            title: 'Watched repositories',
            description: 'Comma-separated owner/repo',
        });
        watchPage.add(reposGroup);

        const reposRow = new Adw.EntryRow({title: 'owner/repo, …'});
        reposRow.add_prefix(new Gtk.Image({icon_name: 'system-software-install-symbolic', pixel_size: 16}));
        reposRow.set_text(settings.get_string('watched-repos'));
        reposRow.connect('notify::text', () => settings.set_string('watched-repos', reposRow.get_text()));
        const reposBanner = new Adw.Banner({
            title: 'No repos — add one or disable watches.',
            revealed: false,
        });
        const updateReposBanner = () => {
            const hasWatch = settings.get_boolean('watch-issues-prs') || settings.get_boolean('watch-stars');
            const hasRepos = settings.get_string('watched-repos').trim().length > 0;
            reposBanner.set_revealed(hasWatch && !hasRepos);
        };
        updateReposBanner();
        settings.connect('changed::watched-repos', updateReposBanner);
        settings.connect('changed::watch-issues-prs', updateReposBanner);
        settings.connect('changed::watch-stars', updateReposBanner);
        reposGroup.add(reposBanner);
        reposGroup.add(reposRow);

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
        hideEmptyRow.add_prefix(new Gtk.Image({icon_name: 'view-visible-symbolic', pixel_size: 16}));
        settings.bind('hide-when-empty', hideEmptyRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        displayGroup.add(hideEmptyRow);

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
    }
}
