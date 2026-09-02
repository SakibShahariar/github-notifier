import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Soup from 'gi://Soup';
import Pango from 'gi://Pango';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';

const MAX_RECENT = 40;
const MAX_BADGE = 99;
const MAX_NOTIFICATION_PAGES = 3;
const ACTIVITY_PREVIEW = 5;
const ACTIVITY_EXPANDED = 25;
const NOTIF_PAGE_SIZE = 5;
const REPO_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?\/[A-Za-z0-9._-]+$/;

class ApiError extends Error {
    constructor(message, status) {
        super(message);
        this.status = status;
    }
}

const Indicator = GObject.registerClass(
class Indicator extends PanelMenu.Button {
    _init(extensionObject) {
        super._init(0.0, 'GitHub Notifier');

        this._ext = extensionObject;
        this._settings = extensionObject.getSettings();
        this._session = new Soup.Session();
        this._session.timeout = 15;
        this._notificationItems = []; // live mirror of GitHub's current unread inbox
        this._activityItems = []; // accumulated issue/PR/star events, cleared on mark-all-read
        this._unread = 0;
        this._timeoutId = null;
        this._source = null; // MessageTray.Source, created lazily
        this._destroyed = false;
        this._paused = false;
        this._rateLimitResetEpoch = 0; // unix seconds; 0 = not rate-limited
        this._polling = false; // prevents overlapping poll cycles
        this._statusIsError = false; // keeps the indicator visible while a problem is showing
        this._notificationsPage = 0;
        this._issuesExpanded = false;
        this._starsExpanded = false;
        this._markAllArmed = false;
        this._markAllTimer = null;
        this._markingAllRead = false; // true while PUT /notifications is in flight
        this._lastFetchedAt = null;

        // --- panel button contents ---
        const box = new St.BoxLayout({style_class: 'panel-status-menu-box'});
        const iconPath = GLib.build_filenamev([this._ext.path, 'icons', 'github-symbolic.svg']);
        this._icon = new St.Icon({
            gicon: Gio.icon_new_for_string(iconPath),
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

        this._settingsChangedId = this._settings.connect('changed::poll-interval', () => this._restartTimer());
        this._hideEmptyChangedId = this._settings.connect('changed::hide-when-empty', () => this._updatePanel());
        this._unlitChangedId = this._settings.connect('changed::icon-always-unlit', () => this._updatePanel());
        // live hero update when username changes
        this._usernameChangedId = this._settings.connect('changed::github-username', () => this._updateHero());

        this._networkMonitor = Gio.NetworkMonitor.get_default();
        this._networkChangedId = this._networkMonitor.connect('network-changed', (monitor, available) => {
            if (available && !this._destroyed)
                this._poll();
        });

        this._restartTimer();
        this._poll(); // kick off immediately
    }

    _buildMenuSkeleton() {
        // --- hero ---
        const iconPath = GLib.build_filenamev([this._ext.path, 'icons', 'github-symbolic.svg']);
        const heroItem = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        heroItem.style_class = 'github-notifier-hero';
        const heroBox = new St.BoxLayout({x_expand: true, style_class: 'github-notifier-hero'});
        const heroIcon = new St.Icon({
            gicon: Gio.icon_new_for_string(iconPath),
            style_class: 'system-status-icon github-notifier-hero-icon',
            icon_size: 24,
        });
        const textBox = new St.BoxLayout({vertical: true, x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        this._heroTitle = new St.Label({text: 'GitHub', style_class: 'github-notifier-hero-title'});
        this._heroMeta = new St.Label({text: 'Checking…', style_class: 'github-notifier-hero-meta'});
        // ellipsize meta so it fits ~420px
        this._heroMeta.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        textBox.add_child(this._heroTitle);
        textBox.add_child(this._heroMeta);
        const gearButton = new St.Button({
            style_class: 'github-notifier-hero-gear',
            can_focus: true,
            child: new St.Icon({icon_name: 'preferences-system-symbolic', style_class: 'popup-menu-icon'}),
        });
        gearButton.connect('clicked', () => this._ext.openPreferences());
        heroBox.add_child(heroIcon);
        heroBox.add_child(textBox);
        heroBox.add_child(gearButton);
        heroItem.add_child(heroBox);
        this.menu.addMenuItem(heroItem);

        // status / warning banner (hidden unless needed)
        this._statusItem = new PopupMenu.PopupMenuItem('Checking GitHub…', {reactive: false});
        this._statusItem.style_class = 'github-notifier-banner';
        this._statusItem.label.clutter_text.line_wrap = true;
        this._statusItem.label.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        this.menu.addMenuItem(this._statusItem);
        this._statusItem.visible = false;

        // action status (marking …) centered dim text
        this._actionStatusItem = new PopupMenu.PopupMenuItem('', {reactive: false});
        this._actionStatusItem.style_class = 'github-notifier-action-status';
        this._actionStatusItem.visible = false;
        this.menu.addMenuItem(this._actionStatusItem);

        // sections
        this._notifSection = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._notifSection);
        this._issuesSection = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._issuesSection);
        this._starsSection = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._starsSection);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // footer controls + rate limit
        this._footerSection = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._footerSection);
        this._rateItem = new PopupMenu.PopupMenuItem('', {reactive: false});
        this._rateItem.style_class = 'github-notifier-rate';
        this._rateItem.label.clutter_text.line_wrap = true;
        this.menu.addMenuItem(this._rateItem);
        this._rateItem.visible = false;

        this._updateHero();
        this._renderList();
    }

    _togglePause() {
        this._paused = !this._paused;
        // update footer pause button if exists via re-render
        this._renderList();
        if (!this._paused)
            this._poll();
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

    // ---------- helpers borrowed from omarchy Panel.qml ----------
    _relativeTime(value) {
        const then = new Date(String(value || '')).getTime();
        if (!isFinite(then)) return '';
        const seconds = Math.max(0, Math.floor((Date.now() - then) / 1000));
        if (seconds < 60) return 'just now';
        if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
        if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
        if (seconds < 2592000) return `${Math.floor(seconds / 86400)}d ago`;
        return `${Math.floor(seconds / 2592000)}mo ago`;
    }

    _iconForItem(item) {
        // Adwaita-only mapping: branch/bug/git are Breeze-only and missing on vanilla GNOME
        if (item.kind === 'notification') {
            const t = item.subjectType || '';
            if (t === 'PullRequest') return 'insert-link-symbolic';
            if (t === 'Issue') return 'chat-message-new-symbolic';
            if (t === 'Commit') return 'document-edit-symbolic';
            return 'mail-unread-symbolic';
        }
        if (item.kind === 'pr') return 'insert-link-symbolic';
        if (item.kind === 'issue') return 'chat-message-new-symbolic';
        if (item.kind === 'star') return 'starred-symbolic';
        return 'mail-unread-symbolic';
    }
    // kept for compat if stylesheet still references glyph class
    _glyphForItem(item) { return this._iconForItem(item); }

    _detailForItem(item) {
        const repo = item.subtitle || '';
        const time = this._relativeTime(item.ts);
        if (item.kind === 'notification') {
            // item.title is "Kind: subject" – extract kind part already?
            // Use stored reasonLabel if available
            const reason = item.reasonLabel || item.kind;
            return `${repo} · ${reason} · ${time}`.trim();
        }
        if (item.kind === 'pr') return `${repo} · PR · ${time}`;
        if (item.kind === 'issue') return `${repo} · issue · ${time}`;
        if (item.kind === 'star') return `${repo} · star · ${time}`;
        return `${repo} · ${time}`;
    }

    _updateHero() {
        if (!this._heroTitle || !this._heroMeta) return;
        const username = this._settings.get_string('github-username').trim();
        this._heroTitle.text = username ? `GitHub · ${username}` : 'GitHub';
        const n = this._notificationItems.length;
        const issuesPrCount = this._activityItems.filter(i => i.kind === 'issue' || i.kind === 'pr').length;
        const starsCount = this._activityItems.filter(i => i.kind === 'star').length;
        const parts = [];
        if (this._polling) parts.push('Refreshing…');
        else if (n > 0) parts.push(`${n} unread`);
        if (issuesPrCount > 0) parts.push(`${issuesPrCount} issues/PRs`);
        if (starsCount > 0) parts.push(`${starsCount} stars`);
        if (parts.length === 0) {
            if (this._statusIsError) parts.push('Attention needed');
            else parts.push('All caught up');
        }
        // also show paused
        if (this._paused) parts.unshift('Paused');
        this._heroMeta.text = parts.join(' · ');
    }

    _setActionStatus(text) {
        if (!this._actionStatusItem) return;
        if (text) {
            this._actionStatusItem.label.text = text;
            this._actionStatusItem.visible = true;
        } else {
            this._actionStatusItem.visible = false;
        }
    }

    _disarmMarkAll() {
        this._markAllArmed = false;
        if (this._markAllTimer) {
            GLib.source_remove(this._markAllTimer);
            this._markAllTimer = null;
        }
        this._renderList();
    }

    // ---------- state persistence ----------
    _loadState() {
        try {
            const parsed = JSON.parse(this._settings.get_string('last-state') || '{}');
            return typeof parsed === 'object' && parsed !== null ? parsed : {};
        } catch (e) {
            logError(e, 'github-notifier: corrupt last-state, resetting');
            return {};
        }
    }

    _saveState(state) {
        try {
            this._settings.set_string('last-state', JSON.stringify(state));
        } catch (e) {
            logError(e, 'github-notifier: failed to save state');
        }
    }

    // ---------- HTTP helper ----------
    _sleep(ms) {
        return new Promise(resolve => {
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
                resolve();
                return GLib.SOURCE_REMOVE;
            });
        });
    }

    _buildMessage(method, uri, token, body) {
        const msg = new Soup.Message({method, uri});
        msg.request_headers.append('Accept', 'application/vnd.github+json');
        msg.request_headers.append('X-GitHub-Api-Version', '2022-11-28');
        msg.request_headers.append('User-Agent', 'gnome-shell-github-notifier');
        if (token)
            msg.request_headers.append('Authorization', `Bearer ${token}`);
        if (body !== null) {
            const bodyBytes = new TextEncoder().encode(JSON.stringify(body));
            msg.set_request_body_from_bytes('application/json', new GLib.Bytes(bodyBytes));
        }
        return msg;
    }

    async _sendOnce(method, uri, token, body) {
        const msg = this._buildMessage(method, uri, token, body);
        const bytes = await this._session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, null);
        return {bytes, msg};
    }

    _apiBase() {
        const host = this._settings.get_string('github-host').trim() || 'api.github.com';
        if (host === 'api.github.com')
            return `https://${host}`;
        if (host.includes('/'))
            return `https://${host.replace(/\/+$/, '')}`;
        return `https://${host}/api/v3`;
    }

    async _apiRequest(method, path, {body = null} = {}) {
        const token = this._settings.get_string('github-token');
        const uri = GLib.Uri.parse(`${this._apiBase()}${path}`, GLib.UriFlags.NONE);

        let bytes, msg;
        try {
            ({bytes, msg} = await this._sendOnce(method, uri, token, body));
        } catch (firstError) {
            if (this._destroyed)
                throw new ApiError(`Network error: ${firstError.message}`, 0);
            await this._sleep(3000);
            if (this._destroyed)
                throw new ApiError(`Network error: ${firstError.message}`, 0);
            try {
                ({bytes, msg} = await this._sendOnce(method, uri, token, body));
            } catch (secondError) {
                throw new ApiError(`Network error: ${secondError.message}`, 0);
            }
        }

        const status = msg.get_status();
        const remaining = msg.response_headers.get_one('X-RateLimit-Remaining');
        const reset = msg.response_headers.get_one('X-RateLimit-Reset');
        if (remaining === '0' && reset)
            this._rateLimitResetEpoch = parseInt(reset, 10);
        else if (status >= 200 && status < 300)
            this._rateLimitResetEpoch = 0;

        if (status === 401)
            throw new ApiError('Invalid or expired token', 401);
        if (status === 403 && remaining === '0')
            throw new ApiError('Rate limited by GitHub API', 403);
        if (status === 404)
            throw new ApiError(`Not found: ${path}`, 404);
        if (status < 200 || status >= 300)
            throw new ApiError(`GitHub API ${path} returned ${status}`, status);

        const linkHeader = msg.response_headers.get_one('Link');
        const data = bytes.get_size() > 0
            ? JSON.parse(new TextDecoder('utf-8').decode(bytes.get_data()))
            : null;
        return {data, linkHeader};
    }

    async _apiGet(path) {
        const {data} = await this._apiRequest('GET', path);
        return data;
    }

    _nextPageUrl(linkHeader) {
        if (!linkHeader)
            return null;
        for (const part of linkHeader.split(',')) {
            const match = part.match(/<([^>]+)>;\s*rel="next"/);
            if (match)
                return match[1];
        }
        return null;
    }

    /** Turn an absolute GitHub Link URL into a path for _apiRequest (leading / + query). */
    _pathFromAbsoluteUrl(absoluteUrl) {
        if (!absoluteUrl)
            return null;
        try {
            const uri = GLib.Uri.parse(absoluteUrl, GLib.UriFlags.NONE);
            const path = uri.get_path() || '/';
            const query = uri.get_query();
            return query ? `${path}?${query}` : path;
        } catch (e) {
            // Fallback: strip known api base prefix if parse fails
            const base = this._apiBase();
            if (absoluteUrl.startsWith(base))
                return absoluteUrl.slice(base.length) || '/';
            logError(e, 'github-notifier: failed to parse next-page URL');
            return null;
        }
    }

    // ---------- polling ----------
    async _poll() {
        if (this._paused || this._destroyed || this._polling || this._markingAllRead)
            return;

        const token = this._settings.get_string('github-token');
        if (!token) {
            this._statusItem.label.text = 'Add a GitHub token in Settings';
            this._statusItem.visible = true;
            this._statusIsError = true;
            this._updateHero();
            this._updatePanel();
            return;
        }

        if (this._networkMonitor.get_connectivity() !== Gio.NetworkConnectivity.FULL) {
            this._statusItem.label.text = 'No internet connection';
            this._statusItem.visible = true;
            this._statusIsError = false;
            this._updateHero();
            this._updatePanel();
            return;
        }

        const nowEpoch = Math.floor(Date.now() / 1000);
        if (this._rateLimitResetEpoch > nowEpoch) {
            const waitMin = Math.ceil((this._rateLimitResetEpoch - nowEpoch) / 60);
            this._statusItem.label.text = `Rate limited — retrying in ~${waitMin} min`;
            this._statusItem.visible = true;
            this._statusIsError = true;
            this._updateHero();
            this._updatePanel();
            return;
        }

        this._polling = true;
        this._updateHero();
        const state = this._loadState();
        let notificationItems = [];
        let activityItems = [];
        const errors = [];
        const baselineNotes = [];

        try {
            if (this._settings.get_boolean('watch-mentions')) {
                try {
                    notificationItems = await this._pollNotifications(state);
                } catch (e) {
                    if (e instanceof ApiError && (e.status === 401 || e.status === 403))
                        throw e;
                    errors.push(`Notifications: ${e.message}`);
                    logError(e, 'github-notifier: notifications poll failed');
                }
            }

            // Always prune last-state.repos to the current watch list (or empty)
            {
                const reposStr = this._settings.get_string('watched-repos');
                const rawRepos = reposStr.split(',').map(r => r.trim()).filter(r => r.length > 0);
                const watched = new Set(Array.from(new Set(rawRepos)));
                if (state.repos && typeof state.repos === 'object') {
                    for (const key of Object.keys(state.repos)) {
                        if (!watched.has(key))
                            delete state.repos[key];
                    }
                }
            }

            if (this._settings.get_boolean('watch-issues-prs') || this._settings.get_boolean('watch-stars')) {
                const reposStr = this._settings.get_string('watched-repos');
                const rawRepos = reposStr.split(',').map(r => r.trim()).filter(r => r.length > 0);
                const repos = Array.from(new Set(rawRepos));

                for (const repo of repos) {
                    if (!REPO_RE.test(repo)) {
                        errors.push(`Skipped invalid repo "${repo}" (expected owner/repo)`);
                        continue;
                    }
                    if (this._settings.get_boolean('watch-issues-prs')) {
                        try {
                            activityItems = activityItems.concat(await this._pollRepoIssues(repo, state, baselineNotes));
                        } catch (e) {
                            if (e instanceof ApiError && (e.status === 401 || e.status === 403))
                                throw e;
                            errors.push(`${repo} issues: ${e.message}`);
                            logError(e, `github-notifier: issues poll failed for ${repo}`);
                        }
                    }
                    if (this._destroyed)
                        return;
                    if (this._settings.get_boolean('watch-stars')) {
                        try {
                            activityItems = activityItems.concat(await this._pollRepoStars(repo, state, baselineNotes));
                        } catch (e) {
                            if (e instanceof ApiError && (e.status === 401 || e.status === 403))
                                throw e;
                            errors.push(`${repo} stars: ${e.message}`);
                            logError(e, `github-notifier: stars poll failed for ${repo}`);
                        }
                    }
                    if (this._destroyed)
                        return;
                }
            }

            if (this._destroyed)
                return;

            this._saveState(state);
            this._afterPoll(notificationItems, activityItems);

            if (baselineNotes.length > 0)
                this._notifyBaseline(baselineNotes);

            if (errors.length > 0) {
                this._statusItem.label.text = `Updated with ${errors.length} issue(s) — see logs`;
                this._statusItem.visible = true;
                this._statusIsError = true;
            } else if (baselineNotes.length > 0) {
                this._statusItem.label.text = `Started tracking ${baselineNotes.length} new watch(es)`;
                this._statusItem.visible = true;
                this._statusIsError = false;
                // auto-hide after 4s like omarchy banner
                GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 4, () => {
                    if (!this._destroyed && this._statusItem.label.text.startsWith('Started tracking')) {
                        this._statusItem.visible = false;
                        this._statusIsError = false;
                        this._updatePanel();
                    }
                    return GLib.SOURCE_REMOVE;
                });
            } else {
                this._statusItem.visible = false;
                this._statusIsError = false;
                this._lastFetchedAt = new Date().toISOString();
                this._updateRateFooter();
            }
            this._updateHero();
            this._updatePanel();
        } catch (e) {
            if (this._destroyed)
                return;
            logError(e, 'github-notifier poll failed');
            if (e instanceof ApiError && e.status === 401)
                this._statusItem.label.text = 'Invalid token — check Settings';
            else if (e instanceof ApiError && e.status === 403)
                this._statusItem.label.text = 'Rate limited by GitHub — will retry later';
            else
                this._statusItem.label.text = `Error: ${e.message}`;
            this._statusItem.visible = true;
            this._statusIsError = true;
            this._updateHero();
            this._updatePanel();
        } finally {
            this._polling = false;
            this._updateHero();
        }
    }

    _updateRateFooter() {
        if (!this._rateItem) return;
        const parts = [];
        if (this._rateLimitResetEpoch > 0)
            parts.push(`Rate limit resets in ${Math.max(1, Math.ceil((this._rateLimitResetEpoch - Date.now()/1000)/60))}m`);
        if (this._lastFetchedAt)
            parts.push(`updated ${this._relativeTime(this._lastFetchedAt)}`);
        if (parts.length > 0) {
            this._rateItem.label.text = parts.join(' · ');
            this._rateItem.visible = true;
        } else {
            this._rateItem.visible = false;
        }
    }

    async _pollNotifications(state) {
        state.toastedNotificationIds ||= [];
        const toasted = new Set(state.toastedNotificationIds);
        const items = [];

        let path = '/notifications?per_page=50&participating=false';
        let pagesFetched = 0;

        while (path && pagesFetched < MAX_NOTIFICATION_PAGES) {
            const {data, linkHeader} = await this._apiRequest('GET', path);
            pagesFetched += 1;

            for (const n of data) {
                const kind = this._reasonToKind(n.reason, n.subject.type);
                const reasonLabel = n.reason || n.subject.type || 'notification';
                items.push({
                    id: `notif-${n.id}`,
                    rawId: n.id,
                    title: `${kind}: ${n.subject.title}`,
                    subtitle: n.repository.full_name,
                    url: this._subjectHtmlUrl(n.subject, n.repository.full_name),
                    kind: 'notification',
                    ts: n.updated_at,
                    isNewToast: !toasted.has(n.id),
                    reasonLabel: kind,
                    subjectType: n.subject.type,
                });
                toasted.add(n.id);
            }

            const nextUrl = data.length === 50 ? this._nextPageUrl(linkHeader) : null;
            path = nextUrl ? this._pathFromAbsoluteUrl(nextUrl) : null;
        }

        state.toastedNotificationIds = Array.from(toasted).slice(-500);
        if (pagesFetched === MAX_NOTIFICATION_PAGES && items.length === MAX_NOTIFICATION_PAGES * 50) {
            const inboxUrl = `${this._webBase()}/notifications`;
            items.push({
                id: `notif-more-${Date.now()}`,
                title: 'More notifications than shown — check GitHub inbox directly',
                subtitle: inboxUrl,
                url: inboxUrl,
                kind: 'notification',
                ts: new Date().toISOString(),
                isNewToast: false,
                reasonLabel: 'more',
                subjectType: '',
            });
        }
        return items;
    }

    _reasonToKind(reason, subjectType) {
        const typeLabels = {
            Release: 'New release',
            Commit: 'New commit',
            CheckSuite: 'CI run',
            WorkflowRun: 'CI run',
        };
        if (typeLabels[subjectType])
            return typeLabels[subjectType];

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

    _webBase() {
        const host = this._settings.get_string('github-host').trim() || 'api.github.com';
        if (host === 'api.github.com')
            return 'https://github.com';
        return `https://${host.split('/')[0]}`;
    }

    _subjectHtmlUrl(subject, repoFullName) {
        const webBase = this._webBase();
        const repoUrl = `${webBase}/${repoFullName}`;
        if (!subject.url)
            return repoUrl;

        // Case-insensitive replace of API base + /repos → web base (GHES / proxies)
        const apiReposPrefix = `${this._apiBase()}/repos`;
        const escaped = apiReposPrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const url = subject.url.replace(new RegExp(escaped, 'i'), webBase);

        switch (subject.type) {
            case 'Issue':
            case 'Discussion':
                return url;
            case 'PullRequest':
                return url.replace(/\/pulls\//i, '/pull/');
            case 'Commit':
                return url.replace(/\/commits\//i, '/commit/');
            case 'Release':
                return `${repoUrl}/releases`;
            case 'CheckSuite':
            case 'WorkflowRun':
                return `${repoUrl}/actions`;
            default:
                return repoUrl;
        }
    }

    _encodeRepo(repo) {
        const [owner, name] = repo.split('/');
        return `${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
    }

    async _pollRepoIssues(repo, state, baselineNotes) {
        state.repos ||= {};
        state.repos[repo] ||= {};
        const repoState = state.repos[repo];

        const data = await this._apiGet(`/repos/${this._encodeRepo(repo)}/issues?state=open&sort=created&direction=desc&per_page=20`);
        const items = [];
        let maxId = repoState.lastIssueNumber || 0;
        const seenAnyBefore = !!repoState.lastIssueNumber;

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

        if (seenAnyBefore && items.length === 20) {
            try {
                const data2 = await this._apiGet(`/repos/${this._encodeRepo(repo)}/issues?state=open&sort=created&direction=desc&per_page=20&page=2`);
                for (const issue of data2) {
                    if (issue.number > maxId)
                        maxId = issue.number;
                }
                const hasMoreNew = data2.some(issue => issue.number > repoState.lastIssueNumber);
                if (hasMoreNew || data2.length === 20) {
                    items.push({
                        id: `${repo}-more-${maxId}`,
                        title: 'More new issues/PRs than shown — check the repo directly',
                        subtitle: repo,
                        url: `${this._webBase()}/${repo}/issues`,
                        kind: 'issue',
                        ts: new Date().toISOString(),
                    });
                }
            } catch (e) {
                items.push({
                    id: `${repo}-more-${maxId}`,
                    title: 'More new issues/PRs than shown — check the repo directly',
                    subtitle: repo,
                    url: `${this._webBase()}/${repo}/issues`,
                    kind: 'issue',
                    ts: new Date().toISOString(),
                });
            }
        }

        if (!seenAnyBefore) {
            baselineNotes.push(`${repo}: now tracking issues/PRs (${data.length} currently open)`);
        }

        repoState.lastIssueNumber = maxId;
        return items;
    }

    async _pollRepoStars(repo, state, baselineNotes) {
        state.repos ||= {};
        state.repos[repo] ||= {};
        const repoState = state.repos[repo];

        const data = await this._apiGet(`/repos/${this._encodeRepo(repo)}`);
        const count = data.stargazers_count;
        const items = [];
        const hadBaseline = typeof repoState.stars === 'number';

        if (hadBaseline && count > repoState.stars) {
            const gained = count - repoState.stars;
            items.push({
                id: `${repo}-stars-${count}`,
                title: `+${gained} new star${gained > 1 ? 's' : ''} (${count} total)`,
                subtitle: repo,
                url: `${this._webBase()}/${repo}/stargazers`,
                kind: 'star',
                ts: new Date().toISOString(),
            });
        }

        if (!hadBaseline)
            baselineNotes.push(`${repo}: now tracking stars (currently ${count})`);

        repoState.stars = count;
        return items;
    }

    // ---------- actions on items ----------
    async _markThreadRead(item) {
        if (!item.rawId)
            return;
        this._setActionStatus('Marking notification read…');
        try {
            await this._apiRequest('PATCH', `/notifications/threads/${item.rawId}`);
        } catch (e) {
            logError(e, 'github-notifier: failed to mark thread read on GitHub');
            this._setActionStatus('Could not mark read');
            GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 3, () => { this._setActionStatus(''); return GLib.SOURCE_REMOVE; });
            return;
        }
        this._notificationItems = this._notificationItems.filter(i => i.id !== item.id);
        this._setActionStatus('');
        this._renderList();
        this._updatePanel();
        this._updateHero();
    }

    _dismissActivityItem(item) {
        this._activityItems = this._activityItems.filter(i => i.id !== item.id);
        this._renderList();
        this._updatePanel();
        this._updateHero();
    }

    // ---------- UI update ----------
    _afterPoll(notificationItems, newActivityItems) {
        this._notificationItems = notificationItems.map(({isNewToast, ...rest}) => rest);
        const toToast = notificationItems.filter(n => n.isNewToast);

        if (newActivityItems.length > 0)
            this._activityItems = newActivityItems.concat(this._activityItems).slice(0, MAX_RECENT);

        this._lastFetchedAt = new Date().toISOString();
        this._renderList();
        this._updatePanel();
        this._updateHero();
        this._updateRateFooter();

        const toNotify = toToast.concat(newActivityItems);
        if (toNotify.length > 0)
            this._notify(toNotify);
    }

    _markAllRead() {
        // 2-step confirm like omarchy DashboardSection: first click arms, second executes
        if (!this._markAllArmed) {
            if (this._notificationItems.length === 0 && this._activityItems.length === 0)
                return;
            this._markAllArmed = true;
            this._setActionStatus('Confirm mark all read? Click again.');
            this._renderList();
            if (this._markAllTimer) GLib.source_remove(this._markAllTimer);
            this._markAllTimer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 4, () => {
                this._disarmMarkAll();
                this._setActionStatus('');
                return GLib.SOURCE_REMOVE;
            });
            return;
        }
        // confirmed
        this._disarmMarkAll();
        this._markingAllRead = true;
        this._notificationItems = [];
        this._activityItems = [];
        this._notificationsPage = 0;
        this._renderList();
        this._updatePanel();
        this._updateHero();
        this._setActionStatus('Marking all read…');
        if (this._settings.get_string('github-token')) {
            this._apiRequest('PUT', '/notifications', {body: {last_read_at: new Date().toISOString()}}).then(() => {
                this._markingAllRead = false;
                this._setActionStatus('All marked read');
                GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 2, () => { this._setActionStatus(''); return GLib.SOURCE_REMOVE; });
            }).catch(e => {
                this._markingAllRead = false;
                logError(e, 'github-notifier: failed to mark all read on GitHub');
                this._setActionStatus('Could not mark all read');
                GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 3, () => { this._setActionStatus(''); return GLib.SOURCE_REMOVE; });
                // Refill from GitHub so local state matches reality after failed mark-all
                this._poll();
            });
        } else {
            this._markingAllRead = false;
            this._setActionStatus('');
        }
    }

    _updatePanel() {
        const unread = this._notificationItems.length + this._activityItems.length;
        const alwaysUnlit = this._settings.get_boolean('icon-always-unlit');
        if (unread > 0) {
            this._label.text = unread > MAX_BADGE ? `${MAX_BADGE}+` : String(unread);
            this._label.show();
            if (alwaysUnlit) this._label.remove_style_class_name('urgent');
            else this._label.add_style_class_name('urgent');
        } else {
            this._label.hide();
            this._label.remove_style_class_name('urgent');
        }

        // Dim the Octocat itself when "keep icon unlit" is on (even with unread)
        if (this._icon) {
            if (alwaysUnlit)
                this._icon.add_style_class_name('github-notifier-icon-unlit');
            else
                this._icon.remove_style_class_name('github-notifier-icon-unlit');
        }

        const hideWhenEmpty = this._settings.get_boolean('hide-when-empty');
        this.visible = !(hideWhenEmpty && unread === 0 && !this._statusIsError);
    }

    _truncate(text, maxLen) {
        if (!text || text.length <= maxLen)
            return text;
        return `${text.slice(0, maxLen - 1)}…`;
    }

    // --- section helpers ---
    _addSectionHeader(section, title, count) {
        const headerItem = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        const box = new St.BoxLayout({x_expand: true});
        const label = new St.Label({text: `${title}  ${count}`, style_class: 'github-notifier-section-header', x_expand: true});
        box.add_child(label);
        headerItem.add_child(box);
        section.addMenuItem(headerItem);
    }

    _addSeparator(section) {
        const sepItem = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        const sep = new St.Widget({style_class: 'github-notifier-separator', x_expand: true});
        sepItem.add_child(sep);
        section.addMenuItem(sepItem);
    }

    _addEmpty(section, text) {
        const item = new PopupMenu.PopupMenuItem(text, {reactive: false});
        item.style_class = 'github-notifier-empty';
        item.label.style_class = 'github-notifier-empty';
        section.addMenuItem(item);
    }

    _addRow(section, item) {
        const menuItem = new PopupMenu.PopupBaseMenuItem({style_class: 'github-notifier-row'});
        menuItem.connect('activate', () => {
            Gio.AppInfo.launch_default_for_uri(item.url, null);
            if (item.kind === 'notification' && item.rawId)
                this._markThreadRead(item);
            else
                this._dismissActivityItem(item);
        });

        const rowBox = new St.BoxLayout({x_expand: true, style_class: 'github-notifier-row-inner', y_align: Clutter.ActorAlign.CENTER});
        // GNOME-native symbolic icon (replaces nerd-font glyph)
        const iconName = this._iconForItem(item);
        const glyph = new St.Icon({
            icon_name: iconName,
            style_class: 'popup-menu-icon github-notifier-glyph' + (item.kind === 'star' ? ' urgent' : ' dim'),
            y_align: Clutter.ActorAlign.CENTER,
            icon_size: 18,
        });
        rowBox.add_child(glyph);

        const textBox = new St.BoxLayout({vertical: true, x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        const titleLabel = new St.Label({text: this._truncate(item.title, 68), style_class: 'github-notifier-row-title', x_expand: true});
        titleLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        titleLabel.clutter_text.line_wrap = false;
        const detailLabel = new St.Label({text: this._detailForItem(item), style_class: 'github-notifier-row-detail', x_expand: true});
        detailLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        textBox.add_child(titleLabel);
        textBox.add_child(detailLabel);
        rowBox.add_child(textBox);

        const chevron = new St.Icon({icon_name: 'go-next-symbolic', style_class: 'popup-menu-icon github-notifier-chevron', y_align: Clutter.ActorAlign.CENTER, icon_size: 14});
        rowBox.add_child(chevron);

        // combine row and read-strip in single container (PopupBaseMenuItem is a Bin)
        const container = new St.BoxLayout({x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        container.add_child(rowBox);
        const strip = new St.BoxLayout({style_class: 'github-notifier-read-strip', y_align: Clutter.ActorAlign.CENTER});
        const btn = new St.Button({
            style_class: 'github-notifier-read-button',
            can_focus: true,
            child: new St.Icon({icon_name: 'object-select-symbolic', style_class: 'popup-menu-icon'}),
        });
        btn.connect('clicked', () => {
            if (item.kind === 'notification' && item.rawId)
                this._markThreadRead(item);
            else
                this._dismissActivityItem(item);
            return Clutter.EVENT_STOP;
        });
        strip.add_child(btn);
        container.add_child(strip);
        menuItem.add_child(container);

        section.addMenuItem(menuItem);
    }

    _addFooter(section, opts) {
        // opts: {expandable, expanded, count, onToggle, paginated, page, pageCount, onPrev, onNext, showOpen, openUrl, showMarkAll, markAllArmed, onMarkAll, showRefresh, onRefresh, isPaused}
        const footerItem = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        const box = new St.BoxLayout({style_class: 'github-notifier-footer', x_align: Clutter.ActorAlign.CENTER, x_expand: true});
        const makeBtn = (text, cb, urgent) => {
            const btn = new St.Button({label: text, style_class: 'github-notifier-footer-button' + (urgent ? ' urgent' : ''), can_focus: true});
            btn.connect('clicked', cb);
            box.add_child(btn);
            return btn;
        };
        const makeIconBtn = (iconName, cb, tooltip) => {
            const btn = new St.Button({
                style_class: 'github-notifier-footer-button github-notifier-footer-icon-button',
                can_focus: true,
                child: new St.Icon({icon_name: iconName, icon_size: 14, style_class: 'popup-menu-icon'}),
            });
            if (tooltip) btn.set_tooltip_text(tooltip);
            btn.connect('clicked', cb);
            box.add_child(btn);
            return btn;
        };
        if (opts.expandable) {
            const label = opts.expanded ? 'Show less' : (opts.count > ACTIVITY_EXPANDED ? 'Show 25' : `Show all ${opts.count}`);
            makeBtn(label, opts.onToggle);
        }
        if (opts.showMarkAll) {
            const label = opts.markAllArmed ? 'Confirm?' : 'Mark all read';
            makeBtn(label, opts.onMarkAll, opts.markAllArmed);
        }
        if (opts.paginated) {
            const prev = makeIconBtn('go-previous-symbolic', opts.onPrev, 'Previous page');
            prev.can_focus = true;
            if (opts.page <= 0) prev.reactive = false;
            const lab = new St.Label({text: `${opts.page + 1} / ${opts.pageCount}`, y_align: Clutter.ActorAlign.CENTER, style_class: 'github-notifier-hero-meta'});
            lab.set_style('padding: 0 6px; opacity: 1;');
            box.add_child(lab);
            const next = makeIconBtn('go-next-symbolic', opts.onNext, 'Next page');
            if (opts.page + 1 >= opts.pageCount) next.reactive = false;
        }
        if (opts.showOpen) {
            const openBox = new St.BoxLayout({style: 'spacing: 6px;', x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER});
            openBox.add_child(new St.Label({text: 'Open in GitHub'}));
            openBox.add_child(new St.Icon({icon_name: 'go-next-symbolic', icon_size: 14, style_class: 'popup-menu-icon', y_align: Clutter.ActorAlign.CENTER}));
            const openBtn = new St.Button({style_class: 'github-notifier-footer-button', can_focus: true, child: openBox});
            openBtn.connect('clicked', () => Gio.AppInfo.launch_default_for_uri(opts.openUrl, null));
            box.add_child(openBtn);
        }
        // refresh / pause controls only when handlers provided (global footer)
        if (opts.onPauseToggle && opts.onRefresh) {
            makeBtn(opts.isPaused ? 'Resume' : 'Pause', opts.onPauseToggle);
            makeBtn('Refresh', opts.onRefresh);
        }

        footerItem.add_child(box);
        section.addMenuItem(footerItem);
    }

    _renderList() {
        // clear sections
        this._notifSection.removeAll();
        this._issuesSection.removeAll();
        this._starsSection.removeAll();
        this._footerSection.removeAll();

        const hasAny = this._notificationItems.length > 0 || this._activityItems.length > 0;

        // status banner visibility already handled in _poll; keep hidden when no error unless empty?
        if (!hasAny && !this._statusIsError) {
            // show hero already, but ensure empty state still renders sections
        }

        // ---- Unread Notifications (GNOME HIG: Title Case) ----
        // No leading separator: hero (and optional banner) already separate the section.
        const notifCount = this._notificationItems.length;
        this._addSectionHeader(this._notifSection, 'Unread Notifications', notifCount);
        if (notifCount === 0) {
            this._addEmpty(this._notifSection, this._statusIsError ? 'No notifications loaded.' : "You're all caught up.");
        } else {
            const pageCount = Math.max(1, Math.ceil(notifCount / NOTIF_PAGE_SIZE));
            if (this._notificationsPage >= pageCount) this._notificationsPage = pageCount - 1;
            if (this._notificationsPage < 0) this._notificationsPage = 0;
            const start = this._notificationsPage * NOTIF_PAGE_SIZE;
            const slice = this._notificationItems.slice(start, start + NOTIF_PAGE_SIZE);
            for (const item of slice) this._addRow(this._notifSection, item);
            const paginated = pageCount > 1;
            const showMarkAll = notifCount > 0;
            this._addFooter(this._notifSection, {
                expandable: false,
                paginated,
                page: this._notificationsPage,
                pageCount,
                onPrev: () => { this._notificationsPage = Math.max(0, this._notificationsPage - 1); this._renderList(); },
                onNext: () => { this._notificationsPage = Math.min(pageCount - 1, this._notificationsPage + 1); this._renderList(); },
                showOpen: false,
                showMarkAll,
                markAllArmed: this._markAllArmed,
                onMarkAll: () => this._markAllRead(),
            });
        }

        // ---- ISSUES / PRS ---- (hidden when empty to reduce whitespace)
        const issuePrItems = this._activityItems.filter(i => i.kind === 'issue' || i.kind === 'pr')
            .sort((a,b)=> new Date(b.ts)-new Date(a.ts));
        if (issuePrItems.length > 0) {
            this._addSeparator(this._issuesSection);
            this._addSectionHeader(this._issuesSection, 'New Issues & Pull Requests', issuePrItems.length);
            const expandable = issuePrItems.length > ACTIVITY_PREVIEW;
            const shown = issuePrItems.slice(0, this._issuesExpanded ? ACTIVITY_EXPANDED : ACTIVITY_PREVIEW);
            for (const item of shown) this._addRow(this._issuesSection, item);
            this._addFooter(this._issuesSection, {
                expandable,
                expanded: this._issuesExpanded,
                count: issuePrItems.length,
                onToggle: () => { this._issuesExpanded = !this._issuesExpanded; this._renderList(); },
                showOpen: true,
                openUrl: `${this._webBase()}/${issuePrItems[0].subtitle}/issues`,
            });
        }

        // ---- STARS ---- (hidden when empty)
        const starItems = this._activityItems.filter(i => i.kind === 'star')
            .sort((a,b)=> new Date(b.ts)-new Date(a.ts));
        if (starItems.length > 0) {
            this._addSeparator(this._starsSection);
            this._addSectionHeader(this._starsSection, 'New Stars', starItems.length);
            const expandable = starItems.length > ACTIVITY_PREVIEW;
            const shown = starItems.slice(0, this._starsExpanded ? ACTIVITY_EXPANDED : ACTIVITY_PREVIEW);
            for (const item of shown) this._addRow(this._starsSection, item);
            this._addFooter(this._starsSection, {
                expandable,
                expanded: this._starsExpanded,
                count: starItems.length,
                onToggle: () => { this._starsExpanded = !this._starsExpanded; this._renderList(); },
                showOpen: true,
                openUrl: `${this._webBase()}/${starItems[0].subtitle}/stargazers`,
            });
        }

        // global footer — always for pause/refresh + rate
        this._addFooter(this._footerSection, {
            showOpen: true,
            openUrl: `${this._webBase()}/notifications`,
            showMarkAll: false,
            isPaused: this._paused,
            onPauseToggle: () => this._togglePause(),
            onRefresh: () => this._poll(),
        });

        // when truly empty
        if (!hasAny) {
            // already showed per-section empties, ensure at least one indicator
            if (issuePrItems.length === 0 && starItems.length === 0 && notifCount === 0) {
                // footer already added
            }
        }
        // update rate footer after sections
        this._updateRateFooter();
    }

    _ensureSource() {
        if (!this._source) {
            const iconPath = GLib.build_filenamev([this._ext.path, 'icons', 'github-symbolic.svg']);
            this._source = new MessageTray.Source({
                title: 'GitHub Notifier',
                icon: Gio.icon_new_for_string(iconPath),
            });
            Main.messageTray.add(this._source);
        }
        return this._source;
    }

    _notify(newItems) {
        const source = this._ensureSource();
        if (newItems.length > 3) {
            const inboxUrl = `${this._webBase()}/notifications`;
            const notification = new MessageTray.Notification({
                source,
                title: 'GitHub Notifier',
                body: `${newItems.length} new updates`,
            });
            notification.addAction('Open Inbox', () => Gio.AppInfo.launch_default_for_uri(inboxUrl, null));
            notification.connect('activated', () => Gio.AppInfo.launch_default_for_uri(inboxUrl, null));
            source.addNotification(notification);
            return;
        }
        for (const item of newItems) {
            const notification = new MessageTray.Notification({
                source,
                title: item.title,
                body: item.subtitle,
            });
            notification.connect('activated', () => {
                Gio.AppInfo.launch_default_for_uri(item.url, null);
                if (item.kind === 'notification' && item.rawId)
                    this._markThreadRead(item);
                else
                    this._dismissActivityItem(item);
            });
            notification.addAction('Open', () => {
                Gio.AppInfo.launch_default_for_uri(item.url, null);
                if (item.kind === 'notification' && item.rawId)
                    this._markThreadRead(item);
                else
                    this._dismissActivityItem(item);
            });
            const dismissLabel = item.kind === 'notification' ? 'Mark read' : 'Dismiss';
            notification.addAction(dismissLabel, () => {
                if (item.kind === 'notification' && item.rawId)
                    this._markThreadRead(item);
                else
                    this._dismissActivityItem(item);
            });
            if (this._rateLimitResetEpoch > Math.floor(Date.now() / 1000)) {
                notification.addAction('Retry now', () => this._poll());
            }
            source.addNotification(notification);
        }
    }

    _notifyBaseline(notes) {
        const source = this._ensureSource();
        const notification = new MessageTray.Notification({
            source,
            title: 'GitHub Notifier',
            body: notes.join('\n'),
        });
        source.addNotification(notification);
    }

    destroy() {
        this._destroyed = true;
        if (this._timeoutId) {
            GLib.source_remove(this._timeoutId);
            this._timeoutId = null;
        }
        if (this._markAllTimer) {
            GLib.source_remove(this._markAllTimer);
            this._markAllTimer = null;
        }
        if (this._settingsChangedId) {
            this._settings.disconnect(this._settingsChangedId);
            this._settingsChangedId = null;
        }
        if (this._hideEmptyChangedId) {
            this._settings.disconnect(this._hideEmptyChangedId);
            this._hideEmptyChangedId = null;
        }
        if (this._unlitChangedId) {
            this._settings.disconnect(this._unlitChangedId);
            this._unlitChangedId = null;
        }
        if (this._usernameChangedId) {
            this._settings.disconnect(this._usernameChangedId);
            this._usernameChangedId = null;
        }
        if (this._networkChangedId) {
            this._networkMonitor.disconnect(this._networkChangedId);
            this._networkChangedId = null;
        }
        if (this._source) {
            this._source.destroy();
            this._source = null;
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
