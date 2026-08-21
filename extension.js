import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Soup from 'gi://Soup';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';

const MAX_RECENT = 40;

const Indicator = GObject.registerClass(
class Indicator extends PanelMenu.Button {
    _init(extensionObject) {
        super._init(0.0, 'GitHub Notifier');

        this._ext = extensionObject;
        this._settings = extensionObject.getSettings();
        this._session = new Soup.Session();
        this._session.timeout = 15;
        this._recent = []; // [{id, title, url, kind, ts}]
        this._unread = 0;
        this._timeoutId = null;
        this._source = null; // MessageTray.Source, created lazily

        // --- panel button contents ---
        const box = new St.BoxLayout({style_class: 'panel-status-menu-box'});
        this._icon = new St.Icon({
            icon_name: 'emblem-default-symbolic',
            style_class: 'system-status-icon',
        });
        this._label = new St.Label({
            text: '',
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'github-notifier-label',
        });
        box.add_child(this._icon);
        box.add_child(this._label);
        this.add_child(box);
        this._label.hide();

        // --- menu ---
        this._buildMenuSkeleton();

        this._settings.connect('changed::poll-interval', () => this._restartTimer());

        this._restartTimer();
        this._poll(); // kick off immediately
    }

    _buildMenuSkeleton() {
        this._statusItem = new PopupMenu.PopupMenuItem('Checking GitHub…', {reactive: false});
        this.menu.addMenuItem(this._statusItem);
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._listSection = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._listSection);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        const refreshItem = new PopupMenu.PopupMenuItem('Refresh now');
        refreshItem.connect('activate', () => this._poll());
        this.menu.addMenuItem(refreshItem);

        const markReadItem = new PopupMenu.PopupMenuItem('Mark all as read');
        markReadItem.connect('activate', () => this._markAllRead());
        this.menu.addMenuItem(markReadItem);

        const settingsItem = new PopupMenu.PopupMenuItem('Settings…');
        settingsItem.connect('activate', () => this._ext.openPreferences());
        this.menu.addMenuItem(settingsItem);
    }

    _restartTimer() {
        if (this._timeoutId) {
            GLib.source_remove(this._timeoutId);
            this._timeoutId = null;
        }
        const interval = Math.max(30, this._settings.get_int('poll-interval'));
        this._timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, interval, () => {
            this._poll();
            return GLib.SOURCE_CONTINUE;
        });
    }

    // ---------- state persistence ----------
    _loadState() {
        try {
            return JSON.parse(this._settings.get_string('last-state') || '{}');
        } catch (e) {
            return {};
        }
    }

    _saveState(state) {
        this._settings.set_string('last-state', JSON.stringify(state));
    }

    // ---------- HTTP helper ----------
    async _apiGet(path) {
        const token = this._settings.get_string('github-token');
        const uri = GLib.Uri.parse(`https://api.github.com${path}`, GLib.UriFlags.NONE);
        const msg = new Soup.Message({method: 'GET', uri});
        msg.request_headers.append('Accept', 'application/vnd.github+json');
        msg.request_headers.append('X-GitHub-Api-Version', '2022-11-28');
        msg.request_headers.append('User-Agent', 'gnome-shell-github-notifier');
        if (token)
            msg.request_headers.append('Authorization', `Bearer ${token}`);

        const bytes = await this._session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, null);
        const status = msg.get_status();
        if (status < 200 || status >= 300) {
            throw new Error(`GitHub API ${path} returned ${status}`);
        }
        const text = new TextDecoder('utf-8').decode(bytes.get_data());
        return JSON.parse(text);
    }

    // ---------- polling ----------
    async _poll() {
        const token = this._settings.get_string('github-token');
        if (!token) {
            this._statusItem.label.text = 'Add a GitHub token in Settings';
            return;
        }

        const state = this._loadState();
        let newItems = [];

        try {
            if (this._settings.get_boolean('watch-mentions'))
                newItems = newItems.concat(await this._pollNotifications(state));

            if (this._settings.get_boolean('watch-issues-prs') || this._settings.get_boolean('watch-stars')) {
                const reposStr = this._settings.get_string('watched-repos');
                const repos = reposStr.split(',').map(r => r.trim()).filter(r => r.length > 0);
                for (const repo of repos) {
                    if (this._settings.get_boolean('watch-issues-prs'))
                        newItems = newItems.concat(await this._pollRepoIssues(repo, state));
                    if (this._settings.get_boolean('watch-stars'))
                        newItems = newItems.concat(await this._pollRepoStars(repo, state));
                }
            }

            this._saveState(state);
            this._applyNewItems(newItems);
            this._statusItem.label.text = `Updated ${new Date().toLocaleTimeString()}`;
        } catch (e) {
            logError(e, 'github-notifier poll failed');
            this._statusItem.label.text = `Error: ${e.message}`;
        }
    }

    async _pollNotifications(state) {
        const data = await this._apiGet('/notifications?per_page=50&participating=false');
        state.seenNotificationIds ||= [];
        const seen = new Set(state.seenNotificationIds);
        const items = [];

        for (const n of data) {
            if (seen.has(n.id))
                continue;
            seen.add(n.id);

            const kind = this._reasonToKind(n.reason);
            items.push({
                id: `notif-${n.id}`,
                title: `${kind}: ${n.subject.title}`,
                subtitle: n.repository.full_name,
                url: this._apiUrlToHtmlUrl(n.subject.url) || `https://github.com/${n.repository.full_name}`,
                kind: 'notification',
                ts: n.updated_at,
            });
        }

        // Keep the seen-set from growing forever: cap to last 500 ids.
        state.seenNotificationIds = Array.from(seen).slice(-500);
        return items;
    }

    _reasonToKind(reason) {
        const map = {
            mention: 'Mention',
            review_requested: 'Review requested',
            assign: 'Assigned',
            author: 'Update on your thread',
            comment: 'New comment',
            state_change: 'State changed',
            subscribed: 'Activity',
            team_mention: 'Team mention',
        };
        return map[reason] || 'Notification';
    }

    _apiUrlToHtmlUrl(apiUrl) {
        if (!apiUrl)
            return null;
        // e.g. https://api.github.com/repos/o/r/issues/123 -> https://github.com/o/r/issues/123
        return apiUrl
            .replace('api.github.com/repos', 'github.com')
            .replace('/pulls/', '/pull/');
    }

    async _pollRepoIssues(repo, state) {
        state.repos ||= {};
        state.repos[repo] ||= {};
        const repoState = state.repos[repo];

        const data = await this._apiGet(`/repos/${repo}/issues?state=open&sort=created&direction=desc&per_page=20`);
        const items = [];
        let maxId = repoState.lastIssueNumber || 0;
        let seenAnyBefore = !!repoState.lastIssueNumber;

        for (const issue of data) {
            const isPR = !!issue.pull_request;
            if (seenAnyBefore && issue.number > repoState.lastIssueNumber) {
                items.push({
                    id: `${repo}-${issue.number}`,
                    title: `${isPR ? 'New PR' : 'New issue'}: ${issue.title}`,
                    subtitle: repo,
                    url: issue.html_url,
                    kind: isPR ? 'pr' : 'issue',
                    ts: issue.created_at,
                });
            }
            if (issue.number > maxId)
                maxId = issue.number;
        }

        repoState.lastIssueNumber = maxId;
        return items;
    }

    async _pollRepoStars(repo, state) {
        state.repos ||= {};
        state.repos[repo] ||= {};
        const repoState = state.repos[repo];

        const data = await this._apiGet(`/repos/${repo}`);
        const count = data.stargazers_count;
        const items = [];

        if (typeof repoState.stars === 'number' && count > repoState.stars) {
            const gained = count - repoState.stars;
            items.push({
                id: `${repo}-stars-${count}`,
                title: `+${gained} new star${gained > 1 ? 's' : ''} (${count} total)`,
                subtitle: repo,
                url: `https://github.com/${repo}/stargazers`,
                kind: 'star',
                ts: new Date().toISOString(),
            });
        }
        repoState.stars = count;
        return items;
    }

    // ---------- UI update ----------
    _applyNewItems(newItems) {
        if (newItems.length === 0)
            return;

        this._recent = newItems.concat(this._recent).slice(0, MAX_RECENT);
        this._unread += newItems.length;
        this._renderList();
        this._updatePanel();
        this._notify(newItems);
    }

    _markAllRead() {
        this._unread = 0;
        this._updatePanel();
    }

    _updatePanel() {
        if (this._unread > 0) {
            this._label.text = String(this._unread);
            this._label.show();
            this._icon.icon_name = 'mail-unread-symbolic';
        } else {
            this._label.hide();
            this._icon.icon_name = 'emblem-default-symbolic';
        }
    }

    _renderList() {
        this._listSection.removeAll();
        if (this._recent.length === 0) {
            this._listSection.addMenuItem(new PopupMenu.PopupMenuItem('Nothing yet', {reactive: false}));
            return;
        }
        for (const item of this._recent.slice(0, 15)) {
            const menuItem = new PopupMenu.PopupMenuItem(`${item.title}  —  ${item.subtitle}`);
            menuItem.connect('activate', () => {
                Gio.AppInfo.launch_default_for_uri(item.url, null);
            });
            this._listSection.addMenuItem(menuItem);
        }
    }

    _notify(newItems) {
        if (!this._source) {
            this._source = new MessageTray.Source({
                title: 'GitHub Notifier',
                iconName: 'emblem-default-symbolic',
            });
            Main.messageTray.add(this._source);
        }
        // Avoid a notification storm: summarize if there are many at once.
        if (newItems.length > 3) {
            const notification = new MessageTray.Notification({
                source: this._source,
                title: 'GitHub Notifier',
                body: `${newItems.length} new updates`,
            });
            this._source.addNotification(notification);
            return;
        }
        for (const item of newItems) {
            const notification = new MessageTray.Notification({
                source: this._source,
                title: item.title,
                body: item.subtitle,
            });
            this._source.addNotification(notification);
        }
    }

    destroy() {
        if (this._timeoutId) {
            GLib.source_remove(this._timeoutId);
            this._timeoutId = null;
        }
        if (this._session)
            this._session.abort();
        super.destroy();
    }
});

export default class GithubNotifierExtension extends Extension {
    enable() {
        this._indicator = new Indicator(this);
        Main.panel.addToStatusArea(this.uuid, this._indicator);
    }

    disable() {
        this._indicator?.destroy();
        this._indicator = null;
    }
}
