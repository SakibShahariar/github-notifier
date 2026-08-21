import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class GithubNotifierPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const page = new Adw.PreferencesPage();
        window.add(page);

        // --- Account group ---
        const accountGroup = new Adw.PreferencesGroup({
            title: 'GitHub account',
            description: 'A classic PAT needs the "notifications" and "repo" (or "public_repo") scopes. ' +
                'Fine-grained tokens need read access to Issues, Pull requests, and Metadata.',
        });
        page.add(accountGroup);

        const tokenRow = new Adw.PasswordEntryRow({title: 'Personal access token'});
        tokenRow.set_text(settings.get_string('github-token'));
        tokenRow.connect('notify::text', () => settings.set_string('github-token', tokenRow.get_text()));
        accountGroup.add(tokenRow);

        const userRow = new Adw.EntryRow({title: 'GitHub username'});
        userRow.set_text(settings.get_string('github-username'));
        userRow.connect('notify::text', () => settings.set_string('github-username', userRow.get_text()));
        accountGroup.add(userRow);

        // --- Display group ---
        const displayGroup = new Adw.PreferencesGroup({
            title: 'Display',
        });
        page.add(displayGroup);

        const hideEmptyRow = new Adw.SwitchRow({
            title: 'Hide panel icon when there\'s nothing unread',
            subtitle: 'The icon reappears as soon as something new comes in',
        });
        settings.bind('hide-when-empty', hideEmptyRow, 'active', 0);
        displayGroup.add(hideEmptyRow);

        // --- Watch group ---
        const watchGroup = new Adw.PreferencesGroup({
            title: 'What to watch',
        });
        page.add(watchGroup);

        const mentionsRow = new Adw.SwitchRow({
            title: 'Mentions & review requests',
            subtitle: 'Polls your GitHub notifications inbox',
        });
        settings.bind('watch-mentions', mentionsRow, 'active', 0);
        watchGroup.add(mentionsRow);

        const issuesRow = new Adw.SwitchRow({
            title: 'New issues & pull requests',
            subtitle: 'On the repos listed below',
        });
        settings.bind('watch-issues-prs', issuesRow, 'active', 0);
        watchGroup.add(issuesRow);

        const starsRow = new Adw.SwitchRow({
            title: 'New stars',
            subtitle: 'On the repos listed below',
        });
        settings.bind('watch-stars', starsRow, 'active', 0);
        watchGroup.add(starsRow);

        // --- Repos group ---
        const reposGroup = new Adw.PreferencesGroup({
            title: 'Watched repositories',
            description: 'Comma-separated, e.g. gnome/gnome-shell, torvalds/linux',
        });
        page.add(reposGroup);

        const reposRow = new Adw.EntryRow({title: 'owner/repo, owner/repo, …'});
        reposRow.set_text(settings.get_string('watched-repos'));
        reposRow.connect('notify::text', () => settings.set_string('watched-repos', reposRow.get_text()));
        reposGroup.add(reposRow);

        // --- Polling group ---
        const pollGroup = new Adw.PreferencesGroup({title: 'Polling'});
        page.add(pollGroup);

        const intervalRow = new Adw.SpinRow({
            title: 'Interval (seconds)',
            subtitle: 'Minimum 30s — be mindful of GitHub API rate limits',
            adjustment: new Gtk.Adjustment({lower: 30, upper: 3600, step_increment: 30}),
        });
        settings.bind('poll-interval', intervalRow, 'value', 0);
        pollGroup.add(intervalRow);
    }
}
