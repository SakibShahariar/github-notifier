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

        this._networkMonitor = Gio.NetworkMonitor.get_default();
        this._networkChangedId = this._networkMonitor.connect('network-changed', (monitor, available) => {
            if (available && !this._destroyed)
                this._poll();
        });

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

        this._refreshItem = new PopupMenu.PopupMenuItem('Refresh now');
        this._refreshItem.connect('activate', () => this._poll());
        this.menu.addMenuItem(this._refreshItem);

        this._pauseItem = new PopupMenu.PopupMenuItem('Pause polling');
        this._pauseItem.connect('activate', () => this._togglePause());
        this.menu.addMenuItem(this._pauseItem);

        const markReadItem = new PopupMenu.PopupMenuItem('Mark all as read');
        markReadItem.connect('activate', () => this._markAllRead());
        this.menu.addMenuItem(markReadItem);

        const openInboxItem = new PopupMenu.PopupMenuItem('Open GitHub notifications');
        openInboxItem.connect('activate', () => {
            Gio.AppInfo.launch_default_for_uri('https://github.com/notifications', null);
        });
        this.menu.addMenuItem(openInboxItem);

        const settingsItem = new PopupMenu.PopupMenuItem('Settings…');
        settingsItem.connect('activate', () => this._ext.openPreferences());
        this.menu.addMenuItem(settingsItem);
    }

    _togglePause() {
        this._paused = !this._paused;
        this._pauseItem.label.text = this._paused ? 'Resume polling' : 'Pause polling';
        this._statusItem.label.text = this._paused ? 'Polling paused' : 'Resuming…';
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

    // A single send attempt. Throws the raw Soup/GLib error on transport
    // failure (DNS, no route, timeout) — the caller decides whether that's
    // worth retrying.
    async _sendOnce(method, uri, token, body) {
        const msg = this._buildMessage(method, uri, token, body);
        const bytes = await this._session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, null);
        return {bytes, msg};
    }

    _apiBase() {
        const host = this._settings.get_string('github-host').trim() || 'api.github.com';
        // GHES: host like github.example.com -> https://host/api/v3, else api.github.com direct
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
            // Transport-level failure only (not an HTTP error response — those
            // don't throw here). Often just a dead IPv6 route or a momentary
            // blip, so one quick retry clears most of these within the same
            // poll cycle instead of leaving a stale error until the next one.
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

        // Track rate limit state regardless of outcome.
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

    // ---------- polling ----------
    async _poll() {
        if (this._paused || this._destroyed || this._polling)
            return;

        const token = this._settings.get_string('github-token');
        if (!token) {
            this._statusItem.label.text = 'Add a GitHub token in Settings';
            this._statusIsError = true;
            this._updatePanel();
            return;
        }

        // No point attempting any request if there's clearly no internet
        // (airplane mode, portal, LOCAL only) — use FULL connectivity like
        // update-checker does, not just get_network_available() which is
        // true even on LOCAL. This avoids per-repo timeout storms.
        if (this._networkMonitor.get_connectivity() !== Gio.NetworkConnectivity.FULL) {
            this._statusItem.label.text = 'No internet connection';
            // Deliberately NOT treated as an "error" for hide-when-empty
            // purposes — you already know you're offline (there's a system
            // indicator for that), so this shouldn't force the icon to stay
            // visible the way a bad token or rate limit genuinely should.
            this._statusIsError = false;
            this._updatePanel();
            return;
        }

        const nowEpoch = Math.floor(Date.now() / 1000);
        if (this._rateLimitResetEpoch > nowEpoch) {
            const waitMin = Math.ceil((this._rateLimitResetEpoch - nowEpoch) / 60);
            this._statusItem.label.text = `Rate limited — retrying in ~${waitMin} min`;
            this._statusIsError = true;
            this._updatePanel();
            return;
        }

        this._polling = true;
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
                        throw e; // fatal for this cycle, no point continuing
                    errors.push(`Notifications: ${e.message}`);
                    logError(e, 'github-notifier: notifications poll failed');
                }
            }

            if (this._settings.get_boolean('watch-issues-prs') || this._settings.get_boolean('watch-stars')) {
                const reposStr = this._settings.get_string('watched-repos');
                const rawRepos = reposStr.split(',').map(r => r.trim()).filter(r => r.length > 0);
                const repos = Array.from(new Set(rawRepos)); // dedupe

                for (const repo of repos) {
                    if (!REPO_RE.test(repo)) {
                        errors.push(`Skipped invalid repo "${repo}" (expected owner/repo)`);
                        continue;
                    }
                    // Isolate each repo: one failing repo must not block the rest.
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
                this._statusIsError = true;
            } else if (baselineNotes.length > 0) {
                this._statusItem.label.text = `Started tracking ${baselineNotes.length} new watch(es)`;
                this._statusIsError = false;
            } else {
                this._statusItem.label.text = `Updated ${new Date().toLocaleTimeString()}`;
                this._statusIsError = false;
            }
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
            this._statusIsError = true;
            this._updatePanel();
        } finally {
            this._polling = false;
        }
    }

    async _pollNotifications(state) {
        // We deliberately do NOT filter out already-seen ids here — this list
        // should always mirror what GitHub currently considers unread, so it
        // survives shell/extension restarts and never silently drops an item
        // that's still sitting unread in your GitHub inbox. The toasted-id set
        // is only used to avoid re-notifying you for the same thread twice.
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
                items.push({
                    id: `notif-${n.id}`,
                    rawId: n.id,
                    title: `${kind}: ${n.subject.title}`,
                    subtitle: n.repository.full_name,
                    url: this._subjectHtmlUrl(n.subject, n.repository.full_name),
                    kind: 'notification',
                    ts: n.updated_at,
                    isNewToast: !toasted.has(n.id),
                });
                toasted.add(n.id);
            }

            const nextUrl = data.length === 50 ? this._nextPageUrl(linkHeader) : null;
            path = nextUrl ? nextUrl.replace(this._apiBase(), '') : null;
        }

        // Keep the toasted-set from growing forever: cap to last 500 ids.
        state.toastedNotificationIds = Array.from(toasted).slice(-500);
        // Sentinel when we hit the page cap with a full page — there may be more beyond 150
        if (pagesFetched === MAX_NOTIFICATION_PAGES && items.length === MAX_NOTIFICATION_PAGES * 50) {
            items.push({
                id: `notif-more-${Date.now()}`,
                title: 'More notifications than shown — check GitHub inbox directly',
                subtitle: 'https://github.com/notifications',
                url: 'https://github.com/notifications',
                kind: 'notification',
                ts: new Date().toISOString(),
                isNewToast: false,
            });
        }
        return items;
    }

    _reasonToKind(reason, subjectType) {
        // Some subject types are more informative than the notification
        // reason alone — e.g. reason "subscribed" on a Release just says
        // "Activity", which tells you nothing. Prefer the type when it adds
        // real information.
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

    // GitHub's notification `subject.url` is an API url, and for several
    // subject types the API path shape doesn't match the web path shape at
    // all (e.g. commits are /commits/SHA on the API but /commit/SHA —
    // singular — on the web; releases and CI runs aren't derivable from the
    // API url without an extra fetch). Map what we can reliably resolve
    // without another request, and fall back to a repo-level page — never a
    // guess that 404s.
    _webBase() {
        const host = this._settings.get_string('github-host').trim() || 'api.github.com';
        if (host === 'api.github.com')
            return 'https://github.com';
        // GHES web host is same as API host without /api/v3
        return `https://${host.split('/')[0]}`;
    }

    _subjectHtmlUrl(subject, repoFullName) {
        const webBase = this._webBase();
        const repoUrl = `${webBase}/${repoFullName}`;
        if (!subject.url)
            return repoUrl;

        const url = subject.url.replace(`${this._apiBase()}/repos`, webBase);

        switch (subject.type) {
            case 'Issue':
            case 'Discussion':
                return url;
            case 'PullRequest':
                return url.replace('/pulls/', '/pull/');
            case 'Commit':
                return url.replace('/commits/', '/commit/');
            case 'Release':
                // The API only gives us a release id here, not its tag, so we
                // can't build the exact /releases/tag/<name> URL without an
                // extra request — link to the releases list instead of 404ing.
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

        // If we filled a full page of new items, verify there's more beyond
        // by fetching page 2 once — avoids false sentinel when exactly 20 new.
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
                        url: `https://github.com/${repo}/issues`,
                        kind: 'issue',
                        ts: new Date().toISOString(),
                    });
                }
            } catch (e) {
                // Fallback: keep sentinel if page 2 fails, better noisy than silent drop
                items.push({
                    id: `${repo}-more-${maxId}`,
                    title: 'More new issues/PRs than shown — check the repo directly',
                    subtitle: repo,
                    url: `https://github.com/${repo}/issues`,
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
                url: `https://github.com/${repo}/stargazers`,
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
        try {
            await this._apiRequest('PATCH', `/notifications/threads/${item.rawId}`);
        } catch (e) {
            logError(e, 'github-notifier: failed to mark thread read on GitHub');
            return; // don't remove locally if GitHub didn't actually confirm it
        }
        this._notificationItems = this._notificationItems.filter(i => i.id !== item.id);
        this._renderList();
        this._updatePanel();
    }

    // Star/issue/PR activity has no "read" concept on GitHub's side — it's
    // purely local bookkeeping, so dismissing one is just a local removal.
    _dismissActivityItem(item) {
        this._activityItems = this._activityItems.filter(i => i.id !== item.id);
        this._renderList();
        this._updatePanel();
    }

    // ---------- UI update ----------
    _afterPoll(notificationItems, newActivityItems) {
        // Notifications: always replace with the live unread set from GitHub.
        this._notificationItems = notificationItems.map(({isNewToast, ...rest}) => rest);
        const toToast = notificationItems.filter(n => n.isNewToast);

        // Activity (issues/PRs/stars): keep accumulating until dismissed.
        if (newActivityItems.length > 0)
            this._activityItems = newActivityItems.concat(this._activityItems).slice(0, MAX_RECENT);

        this._renderList();
        this._updatePanel();

        const toNotify = toToast.concat(newActivityItems);
        if (toNotify.length > 0)
            this._notify(toNotify);
    }

    _markAllRead() {
        this._notificationItems = [];
        this._activityItems = [];
        this._renderList();
        this._updatePanel();

        // Best-effort: also mark read on GitHub's side so the web inbox matches.
        if (this._settings.get_string('github-token')) {
            this._apiRequest('PUT', '/notifications', {body: {last_read_at: new Date().toISOString()}}).catch(e => {
                logError(e, 'github-notifier: failed to mark all read on GitHub');
            });
        }
    }

    _updatePanel() {
        const unread = this._notificationItems.length + this._activityItems.length;
        if (unread > 0) {
            this._label.text = unread > MAX_BADGE ? `${MAX_BADGE}+` : String(unread);
            this._label.show();
        } else {
            this._label.hide();
        }

        // Hiding the whole indicator is opt-in and only ever applies when
        // there's genuinely nothing to show — a pending error/status message
        // (bad token, rate limit, etc.) always keeps it visible so it doesn't
        // vanish silently on a problem.
        const hideWhenEmpty = this._settings.get_boolean('hide-when-empty');
        this.visible = !(hideWhenEmpty && unread === 0 && !this._statusIsError);
    }

    _truncate(text, maxLen) {
        if (!text || text.length <= maxLen)
            return text;
        return `${text.slice(0, maxLen - 1)}…`;
    }

    _renderList() {
        this._listSection.removeAll();
        const combined = this._notificationItems.concat(this._activityItems)
            .sort((a, b) => new Date(b.ts) - new Date(a.ts));

        if (combined.length === 0) {
            this._listSection.addMenuItem(new PopupMenu.PopupMenuItem('Nothing unread', {reactive: false}));
            return;
        }
        // Group by repo (subtitle) while keeping time order
        let lastRepo = null;
        for (const item of combined.slice(0, 15)) {
            if (item.subtitle !== lastRepo) {
                const header = new PopupMenu.PopupMenuItem(item.subtitle, {reactive: false});
                header.label.add_style_class_name('github-notifier-repo-header');
                header.label.style = 'font-weight: bold; opacity: 0.85;';
                this._listSection.addMenuItem(header);
                lastRepo = item.subtitle;
            }
            const menuItem = new PopupMenu.PopupBaseMenuItem();
            const text = `${this._truncate(item.title, 70)}  —  ${item.subtitle}`;
            const label = new St.Label({
                text,
                x_expand: true,
                y_align: Clutter.ActorAlign.CENTER,
                style_class: 'github-notifier-item-label',
            });
            // Belt-and-braces: truncate the string itself (above) for a
            // reasonable default, and also ellipsize on the actor so it can
            // never blow out the menu width regardless of font/DPI.
            label.clutter_text.set_line_wrap(false);
            label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            menuItem.add_child(label);

            menuItem.connect('activate', () => {
                Gio.AppInfo.launch_default_for_uri(item.url, null);
                // Opening it is treated the same as reading it, same as GitHub's
                // own notification inbox — no need to also hit the checkmark.
                if (item.kind === 'notification' && item.rawId)
                    this._markThreadRead(item);
                else
                    this._dismissActivityItem(item);
            });

            if (item.kind === 'notification' && item.rawId) {
                // Real GitHub notification-inbox items: mark read remotely too.
                const readButton = new St.Button({
                    style_class: 'github-notifier-mark-read',
                    child: new St.Icon({icon_name: 'object-select-symbolic', style_class: 'popup-menu-icon'}),
                    can_focus: true,
                });
                readButton.connect('clicked', () => {
                    this._markThreadRead(item);
                });
                menuItem.add_child(readButton);
            } else {
                // Issue/PR/star activity has no "read" state on GitHub's side —
                // this just removes it from the local list without opening it.
                const dismissButton = new St.Button({
                    style_class: 'github-notifier-mark-read',
                    child: new St.Icon({icon_name: 'object-select-symbolic', style_class: 'popup-menu-icon'}),
                    can_focus: true,
                });
                dismissButton.connect('clicked', () => {
                    this._dismissActivityItem(item);
                });
                menuItem.add_child(dismissButton);
            }

            this._listSection.addMenuItem(menuItem);
        }
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
        // Avoid a notification storm: summarize if there are many at once.
        if (newItems.length > 3) {
            const notification = new MessageTray.Notification({
                source,
                title: 'GitHub Notifier',
                body: `${newItems.length} new updates`,
            });
            notification.addAction('Open Inbox', () => Gio.AppInfo.launch_default_for_uri('https://github.com/notifications', null));
            notification.connect('activated', () => Gio.AppInfo.launch_default_for_uri('https://github.com/notifications', null));
            source.addNotification(notification);
            return;
        }
        for (const item of newItems) {
            const notification = new MessageTray.Notification({
                source,
                title: item.title,
                body: item.subtitle,
            });
            // Clicking the toast itself opens the item, same as clicking it in the menu.
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
            // Rate limit retry action for any 403 sentinel (if present)
            if (this._rateLimitResetEpoch > Math.floor(Date.now() / 1000)) {
                notification.addAction('Retry now', () => this._poll());
            }
            source.addNotification(notification);
        }
    }

    // Fired once per repo the first time it's polled, so adding a repo to the
    // watch list doesn't look identical to "nothing happened" — without this,
    // silently recording a baseline count is indistinguishable from a bug.
    // Not added to the badge/dropdown since it isn't unread activity.
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
        if (this._settingsChangedId) {
            this._settings.disconnect(this._settingsChangedId);
            this._settingsChangedId = null;
        }
        if (this._hideEmptyChangedId) {
            this._settings.disconnect(this._hideEmptyChangedId);
            this._hideEmptyChangedId = null;
        }
        if (this._networkChangedId) {
            this._networkMonitor.disconnect(this._networkChangedId);
            this._networkChangedId = null;
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
