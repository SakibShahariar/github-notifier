import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Soup from 'gi://Soup';
import Pango from 'gi://Pango';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import {createNotificationSummary, getApiBase, getApiPathFromAbsoluteUrl, getDailyStatsTotals, getGitHubCliArguments, getNotificationCategory, isRepositoryMuted, isValidRepository, isWithinQuietHours, parseRepositoryList, shouldSuppressDesktopNotifications, updateDailyStats} from './repo-utils.js';
import {loadGithubToken} from './secret-store.js';
import {ApiError, apiRequest} from './api.js';
import {isValidPendingMarkAll, loadState, persistCurrentItems, saveState, stateScope} from './state.js';
import {HoverTooltipController} from './ui-utils.js';
import {addEmpty, addFooter, addRow, addSectionHeader, addSeparator, renderList} from './ui-indicator.js';
import {_createMessageTrayNotification, _createMessageTraySource, notify, notifyBaseline} from './notifications.js';
import {buildMatugenCss, loadMatugenColors} from './ui-theme.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const MAX_RECENT = 40;
const MAX_BADGE = 99;
const MAX_NOTIFICATION_PAGES = 3;
const ACTIVITY_PREVIEW = 5;
const ACTIVITY_EXPANDED = MAX_RECENT;
const NOTIF_PAGE_SIZE = 5;
const NOTIFICATION_FILTER_CATEGORIES = ['mentions', 'reviews', 'assignments', 'conversation', 'checks', 'other'];

const Indicator = GObject.registerClass(
class Indicator extends PanelMenu.Button {
    _init(extensionObject) {
        super._init(0.0, 'GitHub Notifier');

        this._ext = extensionObject;
        this._settings = extensionObject.getSettings();
        this._tooltipController = new HoverTooltipController();
        // The panel indicator can be icon-only; expose a stable accessible name
        // independently of the visible notification count or hidden-label mode.
        try {
            this.accessible_name = 'GitHub Notifier';
        } catch (_error) {
            // Older Shell/Clutter versions may not expose this actor property.
        }
        // GNOME's Quick Settings Do Not Disturb toggle is backed by show-banners.
        // Read it when notifications are emitted so changes apply immediately.
        this._desktopNotificationSettings = new Gio.Settings({schema_id: 'org.gnome.desktop.notifications'});
        this._session = new Soup.Session();
        // Fail faster when the network is unavailable; one short retry below
        // prevents a single request from stalling the entire poll cycle.
        this._session.timeout = 8;
        // The legacy setting is read only as a migration source. New credentials
        // are kept in Secret Service and cached in memory for request use.
        this._token = this._settings.get_string('github-token');
        this._tokenLoading = true;
        this._tokenWarning = '';
        this._summaryPublished = false;
        const persistedState = this._loadState();
        this._dailyStats = updateDailyStats(persistedState.dailyStats, this._localDateKey());
        this._notificationItems = Array.isArray(persistedState.notificationItems)
            ? persistedState.notificationItems.filter(item => item && typeof item.id === 'string').slice(0, MAX_NOTIFICATION_PAGES * 50)
            : []; // cached inbox, restored when GitHub is temporarily unavailable
        this._activityItems = Array.isArray(persistedState.activityItems)
            ? persistedState.activityItems.filter(item => item && typeof item.id === 'string').slice(0, MAX_RECENT)
            : []; // accumulated issue/PR/star events, restored across shell restarts
        this._pendingReadItems = Array.isArray(persistedState.pendingReadItems)
            ? persistedState.pendingReadItems.filter(item => item && typeof item.id === 'string' && typeof item.rawId === 'string')
                .slice(0, MAX_NOTIFICATION_PAGES * 50)
            : [];
        this._pendingMarkAllRead = this._isValidPendingMarkAll(persistedState.pendingMarkAllRead)
            ? persistedState.pendingMarkAllRead
            : null;
        this._retryingPendingReadItems = false;
        this._timeoutId = null;
        this._networkDebounceId = null;
        this._transientTimeouts = new Set();
        this._sleepTimerIds = new Set();
        this._pendingSleepResolvers = new Set();
        this._source = null; // MessageTray.Source, created lazily
        this._destroyed = false;
        this._paused = false;
        this._rateLimitResetEpoch = 0; // unix seconds; 0 = not rate-limited
        this._retryAfterEpoch = 0; // server-directed retry delay (Retry-After)
        this._networkFailureCount = 0;
        this._networkRetryAfterEpoch = 0;
        this._pollCancellable = null;
        this._pollDeadlineId = null;
        this._restartPollRequested = false;
        this._manualRefreshPending = false;
        this._serverPollIntervalSeconds = 0; // X-Poll-Interval from /notifications
        this._polling = false; // prevents overlapping poll cycles
        this._accountRefreshPending = false; // rerun after an in-flight poll when host/token changes
        this._statusIsError = false; // keeps the indicator visible while a problem is showing
        this._notificationsPage = 0;
        this._issuesExpanded = false;
        this._starsExpanded = false;
        this._markAllArmed = false;
        this._markAllTimer = null;
        this._markingAllRead = false; // true while PUT /notifications is in flight
        this._lastFetchedAt = typeof persistedState.lastFetchedAt === 'string'
            ? persistedState.lastFetchedAt
            : null;

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
        this._setTooltip(this, 'GitHub Notifier');
        
        // Scope menu styling to this extension to match update-checker
        this.menu.box.add_style_class_name('github-notifier-menu');

        this._matugenColors = null;
        this._matugenThemeFile = null;
        this._matugenCss = null; // last applied CSS content (avoid reload when unchanged)
        this._matugenMtime = 0;
        this._heroBox = null;
        this._heroItem = null;
        this._heroIcon = null;
        this._heroGear = null;
        this._refreshIcon = null;
        this._menuBuilt = false;
        this._lastRenderHash = '';
        this._matugenMonitor = null;

        // --- menu ---
        this._buildMenuSkeleton();

        this._settingsChangedId = this._settings.connect('changed::poll-interval', () => this._restartTimer());
        this._hideEmptyChangedId = this._settings.connect('changed::hide-when-empty', () => this._updatePanel());
        this._unlitChangedId = this._settings.connect('changed::icon-always-unlit', () => this._updatePanel());
        this._statsChangedId = this._settings.connect('changed::show-daily-stats', () => this._updateDailyStatsItem());
        // live hero update when username changes
        this._usernameChangedId = this._settings.connect('changed::github-username', () => this._updateHero());
        this._filterChangedIds = NOTIFICATION_FILTER_CATEGORIES.map(category =>
            this._settings.connect(`changed::filter-${category}`, () => {
                if (this._destroyed)
                    return;
                this._lastRenderHash = '';
                this._renderList();
                this._updatePanel();
                this._updateHero();
            }));
        const refreshIfMenuOpen = () => {
            if (this._destroyed || !this.menu?.isOpen)
                return;
            this._lastRenderHash = '';
            this._renderList();
        };
        const refreshAccountScope = () => {
            if (this._destroyed)
                return;
            // A poll already in flight may still hold the previous account's data.
            // Queue a fresh poll; the old result is discarded before it can be saved.
            if (this._polling)
                this._accountRefreshPending = true;
            // Rate-limit headers are host/account-specific; do not carry the old
            // account's API backoff into the newly selected account.
            this._rateLimitResetEpoch = 0;
            this._retryAfterEpoch = 0;
            this._serverPollIntervalSeconds = 0;
            const state = this._loadState();
            this._notificationItems = Array.isArray(state.notificationItems)
                ? state.notificationItems.filter(item => item && typeof item.id === 'string').slice(0, MAX_NOTIFICATION_PAGES * 50)
                : [];
            this._activityItems = Array.isArray(state.activityItems)
                ? state.activityItems.filter(item => item && typeof item.id === 'string').slice(0, MAX_RECENT)
                : [];
            this._pendingReadItems = Array.isArray(state.pendingReadItems)
                ? state.pendingReadItems.filter(item => item && typeof item.id === 'string' && typeof item.rawId === 'string')
                    .slice(0, MAX_NOTIFICATION_PAGES * 50)
                : [];
            this._pendingMarkAllRead = this._isValidPendingMarkAll(state.pendingMarkAllRead)
                ? state.pendingMarkAllRead
                : null;
            this._lastFetchedAt = typeof state.lastFetchedAt === 'string' ? state.lastFetchedAt : null;
            this._dailyStats = updateDailyStats(state.dailyStats, this._localDateKey());
            this._lastRenderHash = '';
            this._updateHero();
            this._updatePanel();
            this._poll();
        };
        let tokenRefreshGeneration = 0;
        const refreshToken = async () => {
            const generation = ++tokenRefreshGeneration;
            this._tokenLoading = true;
            try {
                const credential = await loadGithubToken(this._settings);
                if (this._destroyed || generation !== tokenRefreshGeneration)
                    return;
                this._token = credential.token;
                this._tokenWarning = credential.warning || '';
                if (this._tokenWarning)
                    log('github-notifier: Secret Service credential migration needs attention');
            } catch (e) {
                if (this._destroyed || generation !== tokenRefreshGeneration)
                    return;
                this._token = '';
                this._tokenWarning = e.message;
                logError(e, 'github-notifier: unable to retrieve GitHub token from Secret Service');
            } finally {
                if (!this._destroyed && generation === tokenRefreshGeneration) {
                    this._tokenLoading = false;
                    refreshAccountScope();
                }
            }
        };
        this._tokenChangedId = this._settings.connect('changed::token-generation', refreshToken);
        this._reposChangedId = this._settings.connect('changed::watched-repos', () => {
            if (this._destroyed)
                return;
            refreshIfMenuOpen();
            // Establish the new repository's baseline immediately rather than
            // waiting for the next scheduled poll interval.
            this._poll();
        });
        this._mutedReposChangedId = this._settings.connect('changed::muted-repos', () => {
            if (this._destroyed)
                return;
            this._lastRenderHash = '';
            this._renderList();
            this._updatePanel();
            this._updateHero();
            this._poll();
        });
        this._hostChangedId = this._settings.connect('changed::github-host', refreshToken);
        // Secret Service access is asynchronous so it cannot block GNOME Shell.
        refreshToken();

        this._networkMonitor = Gio.NetworkMonitor.get_default();
        const scheduleNetworkRecoveryPoll = () => {
            if (this._destroyed ||
                this._networkMonitor.get_connectivity() !== Gio.NetworkConnectivity.FULL)
                return;

            // A real network recovery is a new opportunity; don't carry the
            // exponential delay from the previous failed connection forward.
            this._networkFailureCount = 0;
            this._networkRetryAfterEpoch = 0;

            // Network and connectivity signals can fire in bursts during a
            // Wi-Fi/VPN transition. Share one debounce window between both.
            if (this._networkDebounceId)
                GLib.source_remove(this._networkDebounceId);
            this._networkDebounceId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 5, () => {
                this._networkDebounceId = null;
                if (!this._destroyed &&
                    this._networkMonitor.get_connectivity() === Gio.NetworkConnectivity.FULL)
                    this._poll();
                return GLib.SOURCE_REMOVE;
            });
        };
        this._networkChangedId = this._networkMonitor.connect('network-changed', (monitor, available) => {
            if (available)
                scheduleNetworkRecoveryPoll();
        });
        // Connectivity can become FULL after a captive-portal sign-in without
        // an availability transition, so listen for the property notification too.
        this._connectivityChangedId = this._networkMonitor.connect('notify::connectivity', scheduleNetworkRecoveryPoll);

        this._setupMatugenMonitor();

        // Theme changes only happen while the menu is closed (focus leaves the
        // popup). Skip Matugen on open — colors already applied at launch / by
        // the file monitor. Still build/render + entrance animation.
        this.menu.connect('open-state-changed', (menu, open) => {
            if (open) {
                GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                    if (this._destroyed)
                        return GLib.SOURCE_REMOVE;
                    if (!this._menuBuilt) {
                        this._buildMenuContent();
                        this._menuBuilt = true;
                    }
                    // Force re-render in case data changed while menu was closed
                    this._lastRenderHash = '';
                    this._animateHeaderEntrance();
                    this._renderList();
                    return GLib.SOURCE_REMOVE;
                });
            } else {
                this._stopRefreshSpin();
            }
        });

        this._restartTimer();
        // Defer first poll until shell startup completes (or ~5–8s).
        const startPoll = () => {
            if (this._destroyed)
                return;
            if (this._startupId) {
                GLib.source_remove(this._startupId);
                this._startupId = null;
            }
            if (this._startupCompleteId) {
                try { Main.layoutManager.disconnect(this._startupCompleteId); } catch (e) {}
                this._startupCompleteId = null;
            }
            this._poll();
        };
        this._startupId = null;
        this._startupCompleteId = null;
        if (Main.layoutManager._startingUp) {
            this._startupCompleteId = Main.layoutManager.connect('startup-complete', () => startPoll());
            this._startupId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 8, () => {
                startPoll();
                return GLib.SOURCE_REMOVE;
            });
        } else {
            this._startupId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 5, () => {
                startPoll();
                return GLib.SOURCE_REMOVE;
            });
        }
        // Defer Matugen stylesheet load so the panel settles first
        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            if (!this._destroyed)
                this._applyMatugenTheme();
            return GLib.SOURCE_REMOVE;
        });
    }

    _buildMenuSkeleton() {
        // --- hero ---
        const iconPath = GLib.build_filenamev([this._ext.path, 'icons', 'github-symbolic.svg']);
        const heroItem = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        heroItem.style_class = 'github-notifier-hero-item';
        const heroBox = new St.BoxLayout({x_expand: true, style_class: 'github-notifier-hero'});
        const heroIcon = new St.Icon({
            gicon: Gio.icon_new_for_string(iconPath),
            style_class: 'system-status-icon github-notifier-hero-icon',
            icon_size: 24,
        });
        const textBox = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true, y_align: Clutter.ActorAlign.CENTER});
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
        this._heroBox = heroBox;
        this._heroItem = heroItem;
        this._heroIcon = heroIcon;
        this._heroGear = gearButton;
        this._setTooltip(gearButton, 'Settings');
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

        // Give token and credential errors a direct, keyboard-accessible route
        // to Preferences instead of leaving users to hunt for the settings gear.
        this._statusAction = null;
        this._statusActionItem = new PopupMenu.PopupMenuItem('Open Settings');
        this._statusActionItem.connect('activate', () => {
            if (this._statusAction === 'refresh')
                this._refreshNow();
            else if (this._statusAction === 'settings')
                this._ext.openPreferences();
        });
        this._statusActionItem.visible = false;
        this.menu.addMenuItem(this._statusActionItem);

        // action status (marking …) centered dim text
        this._statsItem = new PopupMenu.PopupMenuItem('', {reactive: false});
        this._statsItem.style_class = 'github-notifier-rate';
        this.menu.addMenuItem(this._statsItem);
        this._statsItem.visible = false;

        this._repositoryActionStatusGeneration = 0;
        this._actionStatusItem = new PopupMenu.PopupMenuItem('', {reactive: false});
        this._actionStatusItem.style_class = 'github-notifier-action-status';
        this._actionStatusItem.visible = false;
        this.menu.addMenuItem(this._actionStatusItem);

        // Muting hides every row for that repository, so provide a short-lived
        // undo action here rather than leaving the row's future Unmute control
        // unreachable after the first click.
        this._pendingMuteUndoRepository = null;
        this._repositoryUndoItem = new PopupMenu.PopupMenuItem('Undo mute');
        this._repositoryUndoItem.connect('activate', () => {
            const repository = this._pendingMuteUndoRepository;
            this._pendingMuteUndoRepository = null;
            this._repositoryUndoItem.visible = false;
            if (!repository)
                return;
            if (this._setRepositoryMembership('muted-repos', repository, false)) {
                this._showRepositoryActionStatus(`Unmuted ${repository}`);
                this._lastRenderHash = '';
                this._renderList();
            } else {
                this._showRepositoryActionStatus('Could not unmute repository');
            }
        });
        this._repositoryUndoItem.visible = false;
        this.menu.addMenuItem(this._repositoryUndoItem);

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
        this._updateDailyStatsItem();
    }

    _buildMenuContent() {
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
        const configuredInterval = Math.max(60, this._settings.get_int('poll-interval'));
        const nowEpoch = Math.floor(Date.now() / 1000);
        const backoffSeconds = Math.max(0, this._networkRetryAfterEpoch - nowEpoch);
        const retryAfterSeconds = Math.max(0, this._retryAfterEpoch - nowEpoch);
        const interval = Math.max(configuredInterval, this._serverPollIntervalSeconds, backoffSeconds, retryAfterSeconds);
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

    _notificationCategory(item) {
        return getNotificationCategory(item);
    }

    _isNotificationTypeEnabled(item) {
        return this._settings.get_boolean(`filter-${this._notificationCategory(item)}`);
    }

    _mutedRepositories() {
        return new Set(parseRepositoryList(this._settings.get_string('muted-repos')));
    }

    _watchedRepositories() {
        return new Set(parseRepositoryList(this._settings.get_string('watched-repos')));
    }

    _setRepositoryMembership(settingKey, repository, shouldContain) {
        if (!isValidRepository(repository))
            return false;

        const normalized = repository.trim().toLowerCase();
        const repositories = parseRepositoryList(this._settings.get_string(settingKey));
        const next = shouldContain
            ? Array.from(new Set([...repositories, normalized]))
            : repositories.filter(value => value !== normalized);
        const serialized = next.join(', ');
        if (this._settings.get_string(settingKey) !== serialized &&
            !this._settings.set_string(settingKey, serialized))
            return false;
        return true;
    }

    _showRepositoryActionStatus(message, undoMuteRepository = null) {
        const generation = ++this._repositoryActionStatusGeneration;
        this._setActionStatus(message);
        this._pendingMuteUndoRepository = undoMuteRepository;
        if (this._repositoryUndoItem) {
            this._repositoryUndoItem.label.text = undoMuteRepository
                ? `Undo mute for ${undoMuteRepository}`
                : 'Undo mute';
            this._repositoryUndoItem.visible = Boolean(undoMuteRepository);
        }
        this._addTransientTimeout(3, () => {
            if (generation !== this._repositoryActionStatusGeneration)
                return GLib.SOURCE_REMOVE;
            this._setActionStatus('');
            this._pendingMuteUndoRepository = null;
            if (this._repositoryUndoItem)
                this._repositoryUndoItem.visible = false;
            return GLib.SOURCE_REMOVE;
        });
    }

    _isItemMuted(item, mutedRepositories = this._mutedRepositories()) {
        return isRepositoryMuted(item?.subtitle, mutedRepositories);
    }

    _visibleNotificationItems() {
        const mutedRepositories = this._mutedRepositories();
        return this._notificationItems.filter(item =>
            this._isNotificationTypeEnabled(item) && !this._isItemMuted(item, mutedRepositories));
    }

    _visibleActivityItems() {
        const mutedRepositories = this._mutedRepositories();
        return this._activityItems.filter(item => !this._isItemMuted(item, mutedRepositories));
    }

    _iconForItem(item) {
        // Adwaita-only mapping: branch/bug/git are Breeze-only and missing on vanilla GNOME
        if (item.kind === 'notification') {
            const t = item.subjectType || '';
            if (t === 'PullRequest') return 'insert-link-symbolic';
            if (t === 'Issue') return 'chat-message-new-symbolic';
            if (t === 'Commit') return 'document-edit-symbolic';
            if (t === 'Release') return 'tag-symbolic';
            if (t === 'CheckSuite') return 'emblem-ok-symbolic';
            if (t === 'WorkflowRun') return 'media-playback-start-symbolic';
            if (t === 'Discussion') return 'chat-bubbles-symbolic';
            return 'mail-unread-symbolic';
        }
        if (item.kind === 'pr') return 'insert-link-symbolic';
        if (item.kind === 'issue') return 'chat-message-new-symbolic';
        if (item.kind === 'star') return 'starred-symbolic';
        return 'mail-unread-symbolic';
    }
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

    _localDateKey(date = new Date()) {
        return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-');
    }

    _updateDailyStatsItem() {
        if (!this._statsItem)
            return;
        if (!this._settings.get_boolean('show-daily-stats')) {
            this._statsItem.visible = false;
            return;
        }
        this._dailyStats = updateDailyStats(this._dailyStats, this._localDateKey());
        const totals = getDailyStatsTotals(this._dailyStats, this._localDateKey());
        this._statsItem.label.text = `Today: ${totals.todayNotifications} notifications · ${totals.todayActivity} activity | 7 days: ${totals.weekNotifications} notifications · ${totals.weekActivity} activity`;
        this._statsItem.visible = true;
    }

    _updateHero() {
        if (!this._heroTitle || !this._heroMeta) return;
        this._updateDailyStatsItem();
        const username = this._settings.get_string('github-username').trim();
        this._heroTitle.text = username ? `GitHub · ${username}` : 'GitHub';
        const n = this._visibleNotificationItems().length;
        const visibleActivityItems = this._visibleActivityItems();
        const issuesPrCount = visibleActivityItems.filter(i => i.kind === 'issue' || i.kind === 'pr').length;
        const starsCount = visibleActivityItems.filter(i => i.kind === 'star').length;
        const parts = [];
        if (this._polling) parts.push('Refreshing…');
        else if (n > 0) parts.push(`${n} unread`);
        if (issuesPrCount > 0) parts.push(`${issuesPrCount} issues/PRs`);
        if (starsCount > 0) parts.push(`${starsCount} stars`);
        if (parts.length === 0) {
            const statusText = this._statusItem?.label?.text || '';
            if (this._statusIsError && /offline|internet|wi-fi|network|unreachable/i.test(statusText)) {
                parts.push(this._lastFetchedAt
                    ? `Offline · last updated ${this._relativeTime(this._lastFetchedAt)}`
                    : 'Offline · no cached data yet');
            } else if (this._statusIsError) {
                parts.push('Attention needed');
            } else {
                parts.push('All caught up');
            }
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

    /** Add a Shell tooltip and an accessible name to an interactive actor. */
    _setTooltip(actor, text) {
        this._tooltipController.setTooltip(actor, text);
    }

    /** GNOME 51+ reduced-motion; older shells always allow motion. */
    _prefersReducedMotion() {
        try {
            if (St.Settings && St.ReducedMotion) {
                const {reducedMotion} = St.Settings.get();
                return reducedMotion === St.ReducedMotion.REDUCE;
            }
        } catch (_e) {
            /* St.ReducedMotion is GNOME 51+ */
        }
        return false;
    }

    hasMotion() {
        try {
            const s = St.Settings.get();
            if (s && 'enable_animations' in s && s.enable_animations === false) return false;
            if (St.ReducedMotion && s.reducedMotion === St.ReducedMotion.REDUCE) return false;
        } catch (_e) {}
        try {
            const cs = Clutter.Settings.get_default?.();
            if (cs && 'enable_animations' in cs && cs.enable_animations === false) return false;
        } catch (_e) {}
        return !this._prefersReducedMotion();
    }

    /**
     * Soft ease helper — no-ops when reduced motion is on or actor is gone.
     * props: {opacity, scale_x, scale_y, time, mode, onComplete}
     */
    _ease(actor, props = {}) {
        if (!actor || this._destroyed || !this.hasMotion()) {
            if (actor && props.opacity !== undefined)
                actor.opacity = props.opacity;
            if (actor && props.scale_x !== undefined)
                actor.scale_x = props.scale_x;
            if (actor && props.scale_y !== undefined)
                actor.scale_y = props.scale_y;
            if (actor && props.translation_y !== undefined)
                actor.translation_y = props.translation_y;
            if (typeof props.onComplete === 'function')
                props.onComplete();
            return;
        }
        const {
            opacity,
            scale_x: scaleX,
            scale_y: scaleY,
            translation_y: translationY,
            time = 150,
            mode = Clutter.AnimationMode.EASE_OUT_CUBIC,
            onComplete,
        } = props;
        const params = {duration: time, mode};
        if (opacity !== undefined)
            params.opacity = opacity;
        if (scaleX !== undefined)
            params.scale_x = scaleX;
        if (scaleY !== undefined)
            params.scale_y = scaleY;
        if (translationY !== undefined)
            params.translation_y = translationY;
        if (typeof onComplete === 'function')
            params.onComplete = onComplete;
        try {
            actor.ease(params);
        } catch (_e) {
            if (opacity !== undefined)
                actor.opacity = opacity;
            if (scaleX !== undefined)
                actor.scale_x = scaleX;
            if (scaleY !== undefined)
                actor.scale_y = scaleY;
            if (translationY !== undefined)
                actor.translation_y = translationY;
            if (typeof onComplete === 'function')
                onComplete();
        }
    }

    /** Energetic badge bounce when unread count rises. */
    _animateBadgePop() {
        if (!this._label || !this.hasMotion())
            return;
        this._label.set_pivot_point(0.5, 0.5);
        this._label.scale_x = 0.55;
        this._label.scale_y = 0.55;
        this._label.opacity = 180;
        this._ease(this._label, {
            scale_x: 1.45,
            scale_y: 1.45,
            opacity: 255,
            time: 140,
            mode: Clutter.AnimationMode.EASE_OUT_BACK,
            onComplete: () => {
                this._ease(this._label, {
                    scale_x: 0.92,
                    scale_y: 0.92,
                    time: 90,
                    mode: Clutter.AnimationMode.EASE_IN_OUT_QUAD,
                    onComplete: () => {
                        this._ease(this._label, {
                            scale_x: 1.0,
                            scale_y: 1.0,
                            time: 110,
                            mode: Clutter.AnimationMode.EASE_OUT_BACK,
                        });
                    },
                });
            },
        });
    }

    /** Strong Octocat pulse + slight hop when new activity arrives. */
    _animateIconPulse() {
        if (!this._icon || !this.hasMotion())
            return;
        this._icon.set_pivot_point(0.5, 0.5);
        this._icon.translation_y = 0;
        this._ease(this._icon, {
            scale_x: 1.35,
            scale_y: 1.35,
            translation_y: -3,
            time: 120,
            mode: Clutter.AnimationMode.EASE_OUT_BACK,
            onComplete: () => {
                this._ease(this._icon, {
                    scale_x: 0.88,
                    scale_y: 0.88,
                    translation_y: 1,
                    time: 100,
                    mode: Clutter.AnimationMode.EASE_IN_OUT_QUAD,
                    onComplete: () => {
                        this._ease(this._icon, {
                            scale_x: 1.0,
                            scale_y: 1.0,
                            translation_y: 0,
                            time: 130,
                            mode: Clutter.AnimationMode.EASE_OUT_BACK,
                        });
                    },
                });
            },
        });
    }

    _startRefreshSpin() {
        const icon = this._refreshIcon;
        if (!icon || !this.hasMotion()) return;
        if (icon.get_transition?.('rotation-angle-z')) return;
        try {
            icon.set_pivot_point(0.5, 0.5);
            const loop = () => {
                if (!this._polling || this._destroyed || !icon.get_stage?.()) return;
                icon.ease({ rotation_angle_z: (icon.rotation_angle_z || 0) + 360, duration: 900, mode: Clutter.AnimationMode.LINEAR, onComplete: () => { if (this._polling && !this._destroyed) loop(); } });
            };
            loop();
        } catch (e) {}
    }

    _stopRefreshSpin() {
        const icon = this._refreshIcon;
        if (!icon) return;
        try { icon.remove_all_transitions(); icon.ease({ rotation_angle_z: 0, duration: 250, mode: Clutter.AnimationMode.EASE_OUT_QUAD }); } catch (e) { try { icon.rotation_angle_z = 0; } catch (ee) {} }
    }

    _animateHeaderEntrance() {
        if (!this.hasMotion() || !this._heroBox) return;
        try {
            this._heroBox.set_pivot_point(0.5, 0.5);
            this._heroBox.opacity = 0;
            this._heroBox.set_scale(0.96, 0.96);
            this._ease(this._heroBox, { opacity: 255, scale_x: 1, scale_y: 1, time: 280, mode: Clutter.AnimationMode.EASE_OUT_QUAD });
            if (this._heroIcon) {
                this._heroIcon.set_pivot_point(0.5, 0.5);
                this._heroIcon.set_scale(0.5, 0.5);
                this._ease(this._heroIcon, { scale_x: 1, scale_y: 1, time: 420, mode: Clutter.AnimationMode.EASE_OUT_BACK });
            }
        } catch (e) {}
    }

    _addButtonHoverScale(button) {
        if (!button || !this.hasMotion()) return;
        try {
            button.set_pivot_point(0.5, 0.5);
            button.connect('enter-event', () => { if (!this.hasMotion() || this._destroyed) return; this._ease(button, { scale_x: 1.06, scale_y: 1.06, time: 140, mode: Clutter.AnimationMode.EASE_OUT_QUAD }); });
            button.connect('leave-event', () => { if (this._destroyed) return; this._ease(button, { scale_x: 1, scale_y: 1, time: 140, mode: Clutter.AnimationMode.EASE_OUT_QUAD }); });
        } catch (e) {}
    }

    /** Show or hide the status banner. kind: 'error' | 'info' | 'none' */
    _setStatusBanner(text, kind = 'info') {
        if (!this._statusItem) return;
        if (this._statusActionItem) {
            const message = typeof text === 'string' ? text : '';
            if (/add a github token|token unavailable|invalid token|check settings|check token permissions|secret service/i.test(message)) {
                this._statusAction = 'settings';
                this._statusActionItem.label.text = 'Open Settings';
            } else if (/quiet hours|metered connection/i.test(message)) {
                this._statusAction = 'refresh';
                this._statusActionItem.label.text = 'Refresh once';
            } else {
                this._statusAction = null;
            }
            this._statusActionItem.visible = this._statusAction !== null;
        }
        this._statusItem.remove_style_class_name('github-notifier-banner-error');
        this._statusItem.remove_style_class_name('github-notifier-banner-info');
        if (!text) {
            if (this._statusItem.visible && this.hasMotion()) {
                this._ease(this._statusItem, {
                    opacity: 0,
                    translation_y: -4,
                    time: 100,
                    mode: Clutter.AnimationMode.EASE_IN_QUAD,
                    onComplete: () => {
                        this._statusItem.visible = false;
                        this._statusItem.opacity = 255;
                        this._statusItem.translation_y = 0;
                    },
                });
            } else {
                this._statusItem.visible = false;
                this._statusItem.opacity = 255;
                this._statusItem.translation_y = 0;
            }
            this._statusIsError = false;
            return;
        }
        this._statusItem.label.text = text;
        this._statusIsError = kind === 'error';
        if (kind === 'error')
            this._statusItem.add_style_class_name('github-notifier-banner-error');
        else
            this._statusItem.add_style_class_name('github-notifier-banner-info');

        const wasHidden = !this._statusItem.visible;
        this._statusItem.visible = true;
        if (wasHidden && this.hasMotion()) {
            this._statusItem.opacity = 0;
            this._statusItem.translation_y = -8;
            this._ease(this._statusItem, {
                opacity: 255,
                translation_y: 0,
                time: 180,
                mode: Clutter.AnimationMode.EASE_OUT_BACK,
            });
        } else {
            this._statusItem.opacity = 255;
            this._statusItem.translation_y = 0;
        }
    }

    _applyMatugenTheme() {
        this._loadMatugenColorsIfChanged();
        if (this._matugenColors) {
            this._applyMatugenThemeInternal(this._matugenColors);
        }
    }

    _applyMatugenThemeDeferred() {
        this._loadMatugenColorsIfChanged(true);
        if (this._matugenColors) {
            this._applyMatugenThemeInternal(this._matugenColors);
        }
    }

    _loadMatugenColorsIfChanged(force = false) {
        const path = GLib.build_filenamev([GLib.get_home_dir(), '.config', 'matugen', 'matugen-colors.css']);
        try {
            let mtime = -1;
            try {
                const file = Gio.File.new_for_path(path);
                if (file.query_exists(null)) {
                    const info = file.query_info('standard::modification-time', Gio.FileQueryInfoFlags.NONE, null);
                    const dt = info.get_modification_time();
                    mtime = (dt && typeof dt.to_unix === 'function') ? dt.to_unix() : (dt ? dt.to_unix_utc() : -1);
                }
            } catch (e) {
                mtime = -1;
            }
            if (force || mtime !== this._matugenMtime || !this._matugenColors) {
                this._matugenMtime = mtime;
                this._matugenColors = loadMatugenColors();
            }
        } catch (e) {
            logError(e, 'GitHubNotifier matugen load failed');
            this._matugenColors = loadMatugenColors();
        }
    }

    _applyMatugenThemeInternal(colors) {
        try {
            const css = buildMatugenCss(colors);
            // Fixed path — avoid creating a new file (and forced unload/load)
            // on every call. Only touch St.Theme when content actually changed.
            const cachePath = GLib.build_filenamev([GLib.get_user_cache_dir(), 'github-notifier-matugen.css']);
            const cssChanged = css !== this._matugenCss;

            if (cssChanged) {
                // Robust stage lookup (Wayland/X11 differ) — mirrors update-checker@local
                let theme = null;
                try {
                    const stage = global.stage ?? global.display?.get_stage?.() ?? Main.layoutManager?.dummyStage ?? null;
                    if (stage) {
                        const ctx = St.ThemeContext.get_for_stage(stage);
                        theme = ctx?.get_theme() ?? null;
                    }
                } catch (e) {}
                if (!theme) {
                    try { theme = St.ThemeContext.get_for_stage(global.stage)?.get_theme() ?? null; } catch (e) {}
                }
                // Unload previous only when we are about to load a different one
                if (theme && this._matugenThemeFile) {
                    try { theme.unload_stylesheet(this._matugenThemeFile); } catch (e) {}
                }
                const ok = GLib.file_set_contents(cachePath, css);
                if (!ok) throw new Error('file_set_contents failed');
                const file = Gio.File.new_for_path(cachePath);
                if (theme) {
                    theme.load_stylesheet(file);
                    this._matugenThemeFile = file;
                    try { this.menu?.box?.queue_relayout(); } catch (e) {}
                } else {
                    this._matugenThemeFile = file;
                }
                this._matugenCss = css;
                log(`GitHubNotifier matugen applied primary=${colors.primary} primary_container=${colors.primary_container} -> ${cachePath}`);
            }

            // Rebuild current list so banners/rows/footer pick up new stylesheet/inline immediately if popup is open
            try {
                if (this.menu?.isOpen) this._renderList();
            } catch (e) {}
        } catch (e) {
            logError(e, 'GitHubNotifier matugen theme failed');
        }
    }

    _setupMatugenMonitor() {
        const path = GLib.build_filenamev([GLib.get_home_dir(), '.config', 'matugen', 'matugen-colors.css']);
        const file = Gio.File.new_for_path(path);
        try {
            this._matugenMonitor = file.monitor_file(Gio.FileMonitorFlags.NONE, null);
            this._matugenMonitor.connect('changed', (monitor, file, otherFile, eventType) => {
                if (eventType === Gio.FileMonitorEvent.CHANGES_DONE_HINT || eventType === Gio.FileMonitorEvent.CHANGED) {
                    this._loadMatugenColorsIfChanged(true);
                    if (this._matugenColors) {
                        this._applyMatugenThemeInternal(this._matugenColors);
                    }
                }
            });
        } catch (e) {
            logError(e, 'GitHubNotifier matugen monitor failed');
        }
    }

    _removeMatugenTheme() {
        if (this._matugenThemeFile) {
            try {
                const theme = St.ThemeContext.get_for_stage(global.stage)?.get_theme();
                if (theme) theme.unload_stylesheet(this._matugenThemeFile);
            } catch (e) {}
            this._matugenThemeFile = null;
        }
        this._matugenCss = null;
        if (this._matugenDebounceId) {
            GLib.source_remove(this._matugenDebounceId);
            this._matugenDebounceId = null;
        }
        if (this._matugenMonitor) {
            try { this._matugenMonitor.cancel(); } catch (e) {}
            this._matugenMonitor = null;
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
    _stateScope() {
        return stateScope(this);
    }
    _loadState() {
        return loadState(this);
    }
    _saveState(state) {
        return saveState(this, state);
    }
    _isValidPendingMarkAll(value) {
        return isValidPendingMarkAll(this, value);
    }
    _persistCurrentItems(state = null) {
        return persistCurrentItems(this, state);
    }
    _sleep(ms) {
        return new Promise(resolve => {
            let sourceId = 0;
            const finish = () => {
                if (sourceId) {
                    GLib.source_remove(sourceId);
                    this._sleepTimerIds.delete(sourceId);
                    sourceId = 0;
                }
                this._pendingSleepResolvers.delete(finish);
                resolve();
            };
            sourceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
                this._sleepTimerIds.delete(sourceId);
                sourceId = 0;
                this._pendingSleepResolvers.delete(finish);
                resolve();
                return GLib.SOURCE_REMOVE;
            });
            this._sleepTimerIds.add(sourceId);
            this._pendingSleepResolvers.add(finish);
        });
    }

    _addTransientTimeout(seconds, callback) {
        let sourceId = 0;
        sourceId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, seconds, () => {
            this._transientTimeouts.delete(sourceId);
            if (this._destroyed)
                return GLib.SOURCE_REMOVE;
            return callback();
        });
        this._transientTimeouts.add(sourceId);
        return sourceId;
    }

    _buildMessage(method, uri, token, body, headers = {}) {
        const msg = new Soup.Message({method, uri});
        msg.request_headers.append('Accept', 'application/vnd.github+json');
        msg.request_headers.append('X-GitHub-Api-Version', '2022-11-28');
        msg.request_headers.append('User-Agent', 'gnome-shell-github-notifier');
        if (token)
            msg.request_headers.append('Authorization', `Bearer ${token}`);
        for (const [name, value] of Object.entries(headers))
            msg.request_headers.append(name, value);
        if (body !== null) {
            const bodyBytes = new TextEncoder().encode(JSON.stringify(body));
            msg.set_request_body_from_bytes('application/json', new GLib.Bytes(bodyBytes));
        }
        return msg;
    }

    async _sendOnce(method, uri, token, body, headers = {}, cancellable = null) {
        const msg = this._buildMessage(method, uri, token, body, headers);
        const bytes = await this._session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, cancellable);
        return {bytes, msg};
    }

    _apiBase() {
        const host = this._settings.get_string('github-host').trim() || 'api.github.com';
        return getApiBase(host);
    }

    async _apiRequest(method, path, options = {}) {
        return apiRequest(this, method, path, options);
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

    /** Turn an absolute GitHub Link URL into a path for _apiRequest(). */
    _pathFromAbsoluteUrl(absoluteUrl) {
        const path = getApiPathFromAbsoluteUrl(this._apiBase(), absoluteUrl);
        if (path === null)
            log('github-notifier: ignored invalid or out-of-base pagination URL');
        return path;
    }

    // ---------- polling ----------
    _isQuietHoursActive(now = new Date()) {
        return this._settings.get_boolean('quiet-hours-enabled') &&
            isWithinQuietHours(now, this._settings.get_string('quiet-hours-start'), this._settings.get_string('quiet-hours-end'));
    }

    _shouldPauseForQuietHours(now = new Date()) {
        return this._isQuietHoursActive(now) && this._settings.get_boolean('pause-polling-during-quiet-hours');
    }

    _shouldSuppressDesktopNotifications() {
        return shouldSuppressDesktopNotifications(
            this._isQuietHoursActive(),
            this._desktopNotificationSettings.get_boolean('show-banners'),
        );
    }

    _refreshNow() {
        if (this._destroyed || this._paused)
            return;
        // An explicit user request may bypass automatic backoff and metered-network pausing.
        this._manualRefreshPending = true;
        this._networkFailureCount = 0;
        this._networkRetryAfterEpoch = 0;
        if (this._polling) {
            // A manual refresh should not be ignored behind a stalled request.
            // Cancel the active cycle and queue exactly one fresh cycle in finally.
            this._restartPollRequested = true;
            this._pollCancellable?.cancel();
            return;
        }
        this._poll();
    }

    async _poll() {
        if (this._paused || this._destroyed || this._polling || this._markingAllRead)
            return;

        const manualRefresh = this._manualRefreshPending;
        this._manualRefreshPending = false;

        if (this._shouldPauseForQuietHours() && !manualRefresh) {
            this._setStatusBanner('Quiet hours — automatic polling paused', 'info');
            this._updateHero();
            this._updatePanel();
            return;
        }
        if (this._networkMonitor.network_metered && !manualRefresh) {
            this._setStatusBanner('Metered connection — automatic polling paused', 'info');
            this._updateHero();
            this._updatePanel();
            return;
        }

        if (this._tokenLoading)
            return;
        const token = this._token;
        if (!token) {
            this._setStatusBanner(this._tokenWarning
                ? 'GitHub token unavailable — check Secret Service and Settings'
                : 'Add a GitHub token in Settings', 'error');
            this._updateHero();
            this._updatePanel();
            return;
        }

        const connectivity = this._networkMonitor.get_connectivity();
        if (connectivity !== Gio.NetworkConnectivity.FULL) {
            // Distinguish a captive portal from a local-only or limited connection.
            // In every case, existing data may be stale rather than genuinely empty.
            let message = 'No internet connection — data may be out of date';
            if (connectivity === Gio.NetworkConnectivity.PORTAL)
                message = 'Sign in to the Wi-Fi network to connect to GitHub';
            else if (connectivity === Gio.NetworkConnectivity.LIMITED)
                message = 'Connected, but internet access is limited';
            else if (connectivity === Gio.NetworkConnectivity.LOCAL)
                message = 'Connected to a local network only';
            this._setStatusBanner(message, 'error');
            this._updateHero();
            this._updatePanel();
            return;
        }

        const nowEpoch = Math.floor(Date.now() / 1000);
        const networkRetrySeconds = this._networkRetryAfterEpoch - nowEpoch;
        if (networkRetrySeconds > 0) {
            const retryIn = networkRetrySeconds < 120
                ? `${networkRetrySeconds} seconds`
                : `${Math.ceil(networkRetrySeconds / 60)} minutes`;
            this._setStatusBanner(`GitHub is unreachable — retrying in ${retryIn}`, 'error');
            this._updateHero();
            this._updatePanel();
            return;
        }
        const retryEpoch = Math.max(this._rateLimitResetEpoch, this._retryAfterEpoch);
        if (retryEpoch > nowEpoch) {
            const waitMin = Math.ceil((retryEpoch - nowEpoch) / 60);
            this._setStatusBanner(`Rate limited — retrying in ~${waitMin} min`, 'error');
            this._updateHero();
            this._updatePanel();
            return;
        }

        this._polling = true;
        const pollScope = this._stateScope();
        const pollCancellable = new Gio.Cancellable();
        this._pollCancellable = pollCancellable;
        // Bound the total cycle even when many individually slow requests are queued.
        this._pollDeadlineId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 60, () => {
            this._pollDeadlineId = null;
            if (this._pollCancellable === pollCancellable && !pollCancellable.is_cancelled())
                pollCancellable.cancel();
            return GLib.SOURCE_REMOVE;
        });
        this._updateHero();
        this._startRefreshSpin();
        const state = this._loadState();
        let notificationItems = [];
        let notificationPollFailed = false;
        let activityItems = [];
        const errors = [];
        const baselineNotes = [];
        let pollSucceeded = false;

        try {
            if (this._settings.get_boolean('watch-mentions')) {
                try {
                    notificationItems = await this._pollNotifications(state);
                } catch (e) {
                    if (e instanceof ApiError && (e.status === 0 || e.status === 401 || e.status === 403 || e.status === 429))
                        throw e;
                    // Preserve the last known inbox when a refresh fails.
                    // An empty array here would incorrectly erase the badge/list.
                    notificationPollFailed = true;
                    notificationItems = this._notificationItems;
                    errors.push(`Notifications: ${e.message}`);
                    logError(e, 'github-notifier: notifications poll failed');
                }
            }

            // Always prune last-state.repos to the current watch list (or empty)
            {
                const reposStr = this._settings.get_string('watched-repos');
                const rawRepos = reposStr.split(',').map(r => r.trim()).filter(r => r.length > 0);
                const watched = new Set(Array.from(new Set(rawRepos)));
                const mutedRepositories = this._mutedRepositories();
                if (state.repos && typeof state.repos === 'object') {
                    for (const key of Object.keys(state.repos)) {
                        // Reset baselines while muted so unmuting does not replay
                        // every issue/star event that accumulated during the mute.
                        if (!watched.has(key) || isRepositoryMuted(key, mutedRepositories))
                            delete state.repos[key];
                    }
                }
            }

            if (this._settings.get_boolean('watch-issues-prs') || this._settings.get_boolean('watch-stars')) {
                const reposStr = this._settings.get_string('watched-repos');
                const rawRepos = reposStr.split(',').map(r => r.trim()).filter(r => r.length > 0);
                const repos = Array.from(new Set(rawRepos));
                const mutedRepositories = this._mutedRepositories();

                // Keep one poll cycle at a time, but overlap a few independent
                // repositories so large watch lists do not spend most of the
                // cycle waiting on serial network round-trips. Requests for a
                // single repo remain ordered, and result merging stays stable.
                const results = new Array(repos.length);
                const concurrency = Math.min(3, repos.length);
                let nextRepoIndex = 0;
                let fatalRepoError = null;

                const pollNextRepository = async () => {
                    while (!this._destroyed && !fatalRepoError) {
                        const index = nextRepoIndex++;
                        if (index >= repos.length)
                            return;

                        const repo = repos[index];
                        const repoActivity = [];
                        const repoErrors = [];
                        results[index] = {activity: repoActivity, errors: repoErrors};

                        if (!isValidRepository(repo)) {
                            repoErrors.push(`Skipped invalid repo "${repo}" (expected owner/repo)`);
                            continue;
                        }
                        if (isRepositoryMuted(repo, mutedRepositories))
                            continue;

                        if (this._settings.get_boolean('watch-issues-prs')) {
                            try {
                                repoActivity.push(...await this._pollRepoIssues(repo, state, baselineNotes));
                            } catch (e) {
                                if (e instanceof ApiError && [0, 401, 403, 429].includes(e.status)) {
                                    fatalRepoError ||= e;
                                    continue;
                                }
                                repoErrors.push(`${repo} issues: ${e.message}`);
                                logError(e, `github-notifier: issues poll failed for ${repo}`);
                            }
                        }
                        if (this._destroyed || fatalRepoError)
                            continue;

                        if (this._settings.get_boolean('watch-stars')) {
                            try {
                                repoActivity.push(...await this._pollRepoStars(repo, state, baselineNotes));
                            } catch (e) {
                                if (e instanceof ApiError && [0, 401, 403, 429].includes(e.status)) {
                                    fatalRepoError ||= e;
                                    continue;
                                }
                                repoErrors.push(`${repo} stars: ${e.message}`);
                                logError(e, `github-notifier: stars poll failed for ${repo}`);
                            }
                        }
                    }
                };

                await Promise.all(Array.from({length: concurrency}, () => pollNextRepository()));
                if (this._destroyed)
                    return;
                if (fatalRepoError)
                    throw fatalRepoError;

                for (const result of results) {
                    if (!result)
                        continue;
                    activityItems.push(...result.activity);
                    errors.push(...result.errors);
                }
            }

            if (this._destroyed)
                return;

            // Host/token may have changed while awaiting network requests. Never
            // commit results fetched under a different account scope.
            if (this._stateScope() !== pollScope) {
                this._accountRefreshPending = true;
                return;
            }

            if (errors.length === 0 && !notificationPollFailed) {
                this._networkFailureCount = 0;
                this._networkRetryAfterEpoch = 0;
            }
            this._afterPoll(notificationItems, activityItems, {updateFetchedAt: errors.length === 0 && !notificationPollFailed});
            this._persistCurrentItems(state);
            pollSucceeded = errors.length === 0 && !notificationPollFailed;

            if (baselineNotes.length > 0)
                this._notifyBaseline(baselineNotes);

            if (errors.length > 0) {
                const errorText = errors.join(' ').toLowerCase();
                const intervalSeconds = Math.max(60, this._settings.get_int('poll-interval'));
                const retrySeconds = Math.max(
                    intervalSeconds,
                    this._retryAfterEpoch - Math.floor(Date.now() / 1000),
                    this._networkRetryAfterEpoch - Math.floor(Date.now() / 1000));
                const retryIn = retrySeconds < 120
                    ? `about ${retrySeconds} seconds`
                    : `about ${Math.ceil(retrySeconds / 60)} minutes`;
                let message = `Some GitHub data could not be refreshed — retrying in ${retryIn}; details in logs`;
                if (/rate limit|rate limited|secondary rate/.test(errorText))
                    message = `GitHub rate limit reached — retrying in ${retryIn}; details in logs`;
                else if (/returned 5[0-9]{2}/.test(errorText))
                    message = `GitHub is temporarily unavailable — retrying in ${retryIn}`;
                else if (/network error|resolve|tls|timed out|connection reset|socket/.test(errorText))
                    message = `GitHub is unreachable — retrying in ${retryIn}; details in logs`;
                this._setStatusBanner(message, 'error');
            } else if (baselineNotes.length > 0) {
                this._setStatusBanner(`Started tracking ${baselineNotes.length} new watch(es)`, 'info');
                // auto-hide after 4s like omarchy banner
                this._addTransientTimeout(4, () => {
                    if (this._statusItem.label.text.startsWith('Started tracking')) {
                        this._setStatusBanner(null);
                        this._updatePanel();
                    }
                    return GLib.SOURCE_REMOVE;
                });
            } else {
                this._setStatusBanner(null);
                this._lastFetchedAt = new Date().toISOString();
                this._updateRateFooter();
            }
            this._updateHero();
            this._updatePanel();
        } catch (e) {
            if (this._destroyed || this._restartPollRequested)
                return;
            if (this._stateScope() !== pollScope) {
                this._accountRefreshPending = true;
                return;
            }
            logError(e, 'github-notifier poll failed');
            if (e instanceof ApiError && e.status === 401) {
                this._setStatusBanner('Invalid token — check Settings', 'error');
            } else if (e instanceof ApiError && (e.status === 403 || e.status === 429)) {
                if (e.message.toLowerCase().includes('rate limited')) {
                    const retryEpoch = Math.max(this._rateLimitResetEpoch, this._retryAfterEpoch);
                    const waitMin = retryEpoch > Math.floor(Date.now() / 1000)
                        ? Math.ceil((retryEpoch - Date.now() / 1000) / 60)
                        : null;
                    this._setStatusBanner(waitMin
                        ? `Rate limited by GitHub — retrying in ~${waitMin} min`
                        : 'Rate limited by GitHub — will retry later', 'error');
                } else {
                    this._setStatusBanner('GitHub access denied — check token permissions or organization SSO', 'error');
                }
            } else if (e instanceof ApiError && e.status === 0) {
                this._networkFailureCount = Math.min(this._networkFailureCount + 1, 5);
                const backoffSeconds = Math.min(900, 60 * (2 ** (this._networkFailureCount - 1)));
                this._networkRetryAfterEpoch = Math.floor(Date.now() / 1000) + backoffSeconds;
                const retryLabel = backoffSeconds < 60
                    ? `${backoffSeconds} seconds`
                    : `${Math.ceil(backoffSeconds / 60)} minute${backoffSeconds >= 120 ? 's' : ''}`;
                this._setStatusBanner(`GitHub is unreachable — retrying in ${retryLabel}`, 'error');
            } else if (e instanceof ApiError && e.status >= 500) {
                const retryEpoch = Math.max(this._retryAfterEpoch, this._networkRetryAfterEpoch);
                const retrySeconds = Math.max(
                    Math.max(60, this._settings.get_int('poll-interval')),
                    retryEpoch - Math.floor(Date.now() / 1000));
                const retryIn = retrySeconds < 120
                    ? `about ${retrySeconds} seconds`
                    : `about ${Math.ceil(retrySeconds / 60)} minutes`;
                this._setStatusBanner(`GitHub is temporarily unavailable — retrying in ${retryIn}`, 'error');
            } else {
                this._setStatusBanner('Could not refresh GitHub data — see logs for details', 'error');
            }
            this._updateHero();
            this._updatePanel();
        } finally {
            if (this._pollDeadlineId) {
                GLib.source_remove(this._pollDeadlineId);
                this._pollDeadlineId = null;
            }
            if (this._pollCancellable === pollCancellable)
                this._pollCancellable = null;
            this._polling = false;
            if (this._serverPollIntervalSeconds > 0 || this._networkRetryAfterEpoch > 0)
                this._restartTimer();
            this._updateHero();
            this._stopRefreshSpin();
            if (pollSucceeded && (this._pendingReadItems.length > 0 || this._pendingMarkAllRead)) {
                GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                    this._retryPendingReadItems();
                    return GLib.SOURCE_REMOVE;
                });
            }
            const restartAfterRefresh = this._restartPollRequested && !this._destroyed && !this._paused;
            this._restartPollRequested = false;
            if ((this._accountRefreshPending || restartAfterRefresh) && !this._destroyed) {
                this._accountRefreshPending = false;
                GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                    if (!this._destroyed)
                        this._poll();
                    return GLib.SOURCE_REMOVE;
                });
            }
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
        const isInitialBaseline = !state.notificationBaselineEstablished;
        const toasted = new Set(state.toastedNotificationIds);
        const items = [];

        let path = '/notifications?per_page=50&participating=false';
        let pagesFetched = 0;

        while (path && pagesFetched < MAX_NOTIFICATION_PAGES) {
            const headers = pagesFetched === 0 && state.notificationsLastModified
                ? {'If-Modified-Since': state.notificationsLastModified}
                : {};
            const response = await this._apiRequest('GET', path, {headers});
            if (pagesFetched === 0 && response.notModified)
                return this._notificationItems.slice();
            const {data, linkHeader, lastModified} = response;
            if (pagesFetched === 0 && lastModified)
                state.notificationsLastModified = lastModified;
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
                    // Establish a quiet baseline on first run; existing unread
                    // notifications should not all generate desktop toasts.
                    isNewToast: !isInitialBaseline && !toasted.has(n.id),
                    reasonLabel: kind,
                    notificationReason: n.reason,
                    subjectType: n.subject.type,
                });
                toasted.add(n.id);
            }

            const nextUrl = data.length === 50 ? this._nextPageUrl(linkHeader) : null;
            path = nextUrl ? this._pathFromAbsoluteUrl(nextUrl) : null;
        }

        state.toastedNotificationIds = Array.from(toasted).slice(-500);
        state.notificationBaselineEstablished = true;
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

        // The configured API host may include a deployment prefix (for
        // example, git.example.com/github) or the standard /api/v3 suffix.
        // Browser links need the deployment prefix, but not the API suffix.
        let webHost = host.replace(/\/+$/, '');
        if (webHost.endsWith('/api/v3'))
            webHost = webHost.slice(0, -'/api/v3'.length);
        return `https://${webHost}`;
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
                if (hasMoreNew) {
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
        if (this._networkMonitor.get_connectivity() !== Gio.NetworkConnectivity.FULL) {
            this._queuePendingReadItem(item);
            this._setActionStatus('Offline — queued to mark read when reconnected');
            this._addTransientTimeout(4, () => { this._setActionStatus(''); return GLib.SOURCE_REMOVE; });
            return;
        }
        this._setActionStatus('Marking notification read…');
        try {
            await this._apiRequest('PATCH', `/notifications/threads/${item.rawId}`);
        } catch (e) {
            logError(e, 'github-notifier: failed to mark thread read on GitHub');
            this._queuePendingReadItem(item);
            this._setActionStatus('Could not mark read — queued for retry');
            this._addTransientTimeout(3, () => { this._setActionStatus(''); return GLib.SOURCE_REMOVE; });
            return;
        }
        this._pendingReadItems = this._pendingReadItems.filter(pending => pending.rawId !== String(item.rawId));
        this._notificationItems = this._notificationItems.filter(i => i.id !== item.id);
        this._persistCurrentItems();
        this._setActionStatus('');
        this._renderList();
        this._updatePanel();
        this._updateHero();
    }

    _queuePendingReadItem(item) {
        const rawId = String(item.rawId || '');
        if (!rawId)
            return;
        if (!this._pendingReadItems.some(pending => pending.rawId === rawId))
            this._pendingReadItems.push({id: String(item.id), rawId});
        this._pendingReadItems = this._pendingReadItems.slice(0, MAX_NOTIFICATION_PAGES * 50);
        this._persistCurrentItems();
    }

    async _retryPendingReadItems() {
        if (this._destroyed || this._polling || this._retryingPendingReadItems ||
            (this._pendingReadItems.length === 0 && !this._pendingMarkAllRead) ||
            this._tokenLoading ||
            this._networkMonitor.get_connectivity() !== Gio.NetworkConnectivity.FULL ||
            !this._token)
            return;

        this._retryingPendingReadItems = true;
        let changed = false;
        try {
            if (this._pendingMarkAllRead) {
                const pending = this._pendingMarkAllRead;
                try {
                    await this._apiRequest('PUT', '/notifications', {body: {last_read_at: pending.lastReadAt}});
                    const notificationIds = new Set(pending.notificationIds);
                    const activityIds = new Set(pending.activityIds);
                    this._notificationItems = this._notificationItems.filter(item => !notificationIds.has(item.id));
                    this._activityItems = this._activityItems.filter(item => !activityIds.has(item.id));
                    this._pendingReadItems = this._pendingReadItems.filter(item => !notificationIds.has(item.id));
                    this._pendingMarkAllRead = null;
                    changed = true;
                } catch (e) {
                    logError(e, 'github-notifier: queued mark-all-read retry failed');
                    return;
                }
            }
            for (const pending of this._pendingReadItems.slice()) {
                if (this._destroyed || this._polling)
                    break;
                try {
                    await this._apiRequest('PATCH', `/notifications/threads/${pending.rawId}`);
                    this._pendingReadItems = this._pendingReadItems.filter(item => item.rawId !== pending.rawId);
                    this._notificationItems = this._notificationItems.filter(item => item.id !== pending.id);
                    changed = true;
                } catch (e) {
                    logError(e, 'github-notifier: queued mark-read retry failed');
                    break;
                }
            }
        } finally {
            this._retryingPendingReadItems = false;
            if (changed) {
                this._persistCurrentItems();
                this._renderList();
                this._updatePanel();
                this._updateHero();
            }
        }
    }

    _dismissActivityItem(item) {
        this._activityItems = this._activityItems.filter(i => i.id !== item.id);
        this._persistCurrentItems();
        this._renderList();
        this._updatePanel();
        this._updateHero();
    }

    // ---------- UI update ----------
    _afterPoll(notificationItems, newActivityItems, {updateFetchedAt = true} = {}) {
        this._notificationItems = notificationItems.map(({isNewToast, ...rest}) => rest);
        const newNotificationCount = notificationItems.filter(item => item.isNewToast).length;
        const toToast = notificationItems.filter(n => n.isNewToast &&
            this._isNotificationTypeEnabled(n) && !this._isItemMuted(n));
        if (this._settings.get_boolean('show-daily-stats'))
            this._dailyStats = updateDailyStats(this._dailyStats, this._localDateKey(), newNotificationCount, newActivityItems.length);

        if (newActivityItems.length > 0)
            this._activityItems = newActivityItems.concat(this._activityItems).slice(0, MAX_RECENT);

        if (updateFetchedAt)
            this._lastFetchedAt = new Date().toISOString();
        this._renderList();
        this._updatePanel();
        this._updateHero();
        this._updateRateFooter();

        const toNotify = toToast.concat(newActivityItems.filter(item => !this._isItemMuted(item)));
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
        // Confirmed. Keep the current lists until GitHub acknowledges the
        // operation; otherwise a network failure would permanently discard
        // local-only activity and temporarily hide still-unread notifications.
        this._disarmMarkAll();
        if (this._tokenLoading || !this._token) {
            this._setActionStatus('Add or unlock a GitHub token in Settings');
            return;
        }
        if (this._pendingMarkAllRead) {
            this._setActionStatus('Mark all read is already queued for retry');
            this._addTransientTimeout(4, () => { this._setActionStatus(''); return GLib.SOURCE_REMOVE; });
            return;
        }

        // Snapshot the exact items and timestamp at confirmation time. When
        // offline, persist the request but keep every item visible until the
        // server acknowledges it after connectivity returns.
        const pendingMarkAll = {
            lastReadAt: new Date().toISOString(),
            notificationIds: this._notificationItems.map(item => item.id),
            activityIds: this._activityItems.map(item => item.id),
        };
        if (this._networkMonitor.get_connectivity() !== Gio.NetworkConnectivity.FULL) {
            this._pendingMarkAllRead = pendingMarkAll;
            this._persistCurrentItems();
            this._setActionStatus('Offline — mark all read queued until reconnected');
            this._addTransientTimeout(4, () => { this._setActionStatus(''); return GLib.SOURCE_REMOVE; });
            return;
        }
        this._markingAllRead = true;
        this._setActionStatus('Marking all read…');
        this._apiRequest('PUT', '/notifications', {body: {last_read_at: pendingMarkAll.lastReadAt}}).then(() => {
            if (this._destroyed)
                return;
            const notificationIds = new Set(pendingMarkAll.notificationIds);
            const activityIds = new Set(pendingMarkAll.activityIds);
            this._notificationItems = this._notificationItems.filter(item => !notificationIds.has(item.id));
            this._activityItems = this._activityItems.filter(item => !activityIds.has(item.id));
            this._pendingReadItems = this._pendingReadItems.filter(item => !notificationIds.has(item.id));
            this._pendingMarkAllRead = null;
            this._persistCurrentItems();
            this._notificationsPage = 0;
            this._markingAllRead = false;
            this._renderList();
            this._updatePanel();
            this._updateHero();
            this._setActionStatus('All marked read');
            this._addTransientTimeout(2, () => {
                this._setActionStatus('');
                return GLib.SOURCE_REMOVE;
            });
        }).catch(e => {
            this._markingAllRead = false;
            if (this._destroyed)
                return;
            logError(e, 'github-notifier: failed to mark all read on GitHub');
            this._pendingMarkAllRead = pendingMarkAll;
            this._persistCurrentItems();
            this._setActionStatus('Could not mark all read — queued for retry; items were kept');
            this._addTransientTimeout(3, () => {
                this._setActionStatus('');
                return GLib.SOURCE_REMOVE;
            });
        });
    }

    _publishNotificationSummary(unreadNotifications, activityItems, enabled = true) {
        const previousText = this._settings.get_string('notification-summary');
        let previous = null;
        try { previous = JSON.parse(previousText || '{}'); } catch (_error) {}
        const sameCounts = previous && previous.version === 1 && previous.enabled === enabled &&
            previous.unreadNotifications === unreadNotifications && previous.activityItems === activityItems;
        if (this._summaryPublished && sameCounts)
            return;

        const serialized = JSON.stringify(createNotificationSummary(
            unreadNotifications, activityItems, enabled, new Date().toISOString()
        ));
        if (previousText !== serialized && !this._settings.set_string('notification-summary', serialized))
            return;
        this._summaryPublished = true;
    }

    _updatePanel() {
        const unreadNotifications = this._visibleNotificationItems().length;
        const activityItems = this._visibleActivityItems().length;
        const unread = unreadNotifications + activityItems;
        this._publishNotificationSummary(unreadNotifications, activityItems);
        const prev = this._lastUnreadCount ?? 0;
        const alwaysUnlit = this._settings.get_boolean('icon-always-unlit');
        if (unread > 0) {
            this._label.text = unread > MAX_BADGE ? `${MAX_BADGE}+` : String(unread);
            this._label.show();
            if (alwaysUnlit) this._label.remove_style_class_name('urgent');
            else this._label.add_style_class_name('urgent');
        } else {
            this._label.hide();
            this._label.remove_style_class_name('urgent');
            this._label.scale_x = 1.0;
            this._label.scale_y = 1.0;
        }

        // Dim the Octocat itself when "keep icon unlit" is on (even with unread)
        if (this._icon) {
            if (alwaysUnlit)
                this._icon.add_style_class_name('github-notifier-icon-unlit');
            else
                this._icon.remove_style_class_name('github-notifier-icon-unlit');
        }

        // Subtle motion when new items arrive (not on every poll drop)
        if (unread > prev) {
            this._animateBadgePop();
            this._animateIconPulse();
        }
        this._lastUnreadCount = unread;

        if (this._statusIsError)
            this._setTooltip(this, 'GitHub Notifier — attention needed');
        else if (unread > 0)
            this._setTooltip(this, `GitHub Notifier — ${unread} unread`);
        else
            this._setTooltip(this, 'GitHub Notifier');

        const hideWhenEmpty = this._settings.get_boolean('hide-when-empty');
        this.visible = !(hideWhenEmpty && unread === 0 && !this._statusIsError);
    }

    _truncate(text, maxLen) {
        if (!text)
            return text;
        const characters = Array.from(String(text));
        if (characters.length <= maxLen)
            return text;
        return `${characters.slice(0, Math.max(0, maxLen - 1)).join('')}…`;
    }

    // --- section helpers — inline Matugen like update-checker@local (guarantees popup reflects new wallpaper even if theme cached) ---
    _addSectionHeader(section, title, count) {
        addSectionHeader(section, title, count);
    }

    _addSeparator(section) {
        addSeparator(section);
    }

    _addEmpty(section, text) {
        addEmpty(section, text);
    }

    _openUri(uri) {
        try {
            if (Gio.AppInfo.launch_default_for_uri(uri, null))
                return true;
        } catch (e) {
            logError(e, 'github-notifier: failed to open link');
        }

        this._setActionStatus('Could not open link — check your default browser');
        this._addTransientTimeout(4, () => {
            this._setActionStatus('');
            return GLib.SOURCE_REMOVE;
        });
        return false;
    }

    _githubCliLaunchConfig(item) {
        const commandArgs = getGitHubCliArguments(item);
        const ghPath = GLib.find_program_in_path('gh');
        if (!commandArgs || !ghPath)
            return null;

        const terminals = [
            {name: 'kgx', args: ['--']},
            {name: 'ptyxis', args: ['--new-window', '--']},
            {name: 'gnome-terminal', args: ['--']},
            {name: 'x-terminal-emulator', args: ['-e']},
        ];
        for (const terminal of terminals) {
            const path = GLib.find_program_in_path(terminal.name);
            if (path)
                return {argv: [path, ...terminal.args, ghPath, ...commandArgs]};
        }
        return null;
    }

    _openWithGitHubCli(item) {
        const config = this._githubCliLaunchConfig(item);
        if (!config) {
            this._setActionStatus('GitHub CLI or a supported terminal is unavailable');
            this._addTransientTimeout(4, () => {
                this._setActionStatus('');
                return GLib.SOURCE_REMOVE;
            });
            return false;
        }

        try {
            GLib.spawn_async(null, config.argv, null, GLib.SpawnFlags.SEARCH_PATH, null);
            this._handleOpenedItem(item);
            return true;
        } catch (e) {
            logError(e, 'github-notifier: failed to launch GitHub CLI');
            this._setActionStatus(`Could not launch GitHub CLI: ${e.message}`);
            this._addTransientTimeout(4, () => {
                this._setActionStatus('');
                return GLib.SOURCE_REMOVE;
            });
            return false;
        }
    }

    _handleOpenedItem(item) {
        if (item.kind === 'notification' && item.rawId) {
            if (this._settings.get_boolean('mark-read-on-open'))
                this._markThreadRead(item);
        } else {
            this._dismissActivityItem(item);
        }
    }

    _addRow(section, item) {
        addRow(this, section, item);
    }

    _addFooter(section, opts) {
        addFooter(this, section, opts, ACTIVITY_EXPANDED);
    }

    _renderList() {
        renderList(this, {
            notifPageSize: NOTIF_PAGE_SIZE,
            activityPreview: ACTIVITY_PREVIEW,
            activityExpanded: ACTIVITY_EXPANDED,
        });
    }

    _ensureSource() {
        if (!this._source) {
            const iconPath = GLib.build_filenamev([this._ext.path, 'icons', 'github-symbolic.svg']);
            this._source = _createMessageTraySource(
                'GitHub Notifier',
                Gio.icon_new_for_string(iconPath),
            );
            Main.messageTray.add(this._source);
        }
        return this._source;
    }

    _notify(newItems) {
        return notify(this, newItems);
    }
    _notifyBaseline(notes) {
        return notifyBaseline(this, notes);
    }
    destroy() {
        this._tooltipController?.destroy();
        this._tooltipController = null;
        try {
            this._publishNotificationSummary(
                this._visibleNotificationItems().length,
                this._visibleActivityItems().length,
                false
            );
        } catch (e) {
            logError(e, 'github-notifier: failed to publish disabled summary');
        }
        this._destroyed = true;
        this._pollCancellable?.cancel();
        if (this._pollDeadlineId) {
            GLib.source_remove(this._pollDeadlineId);
            this._pollDeadlineId = null;
        }
        try { this._stopRefreshSpin(); } catch (e) {}
        try { this._removeMatugenTheme(); } catch (e) {}
        if (this._timeoutId) {
            GLib.source_remove(this._timeoutId);
            this._timeoutId = null;
        }
        if (this._networkDebounceId) {
            GLib.source_remove(this._networkDebounceId);
            this._networkDebounceId = null;
        }
        for (const sourceId of this._transientTimeouts)
            GLib.source_remove(sourceId);
        this._transientTimeouts.clear();
        for (const finish of this._pendingSleepResolvers)
            finish();
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
        if (this._statsChangedId) {
            this._settings.disconnect(this._statsChangedId);
            this._statsChangedId = null;
        }
        if (this._usernameChangedId) {
            this._settings.disconnect(this._usernameChangedId);
            this._usernameChangedId = null;
        }
        for (const id of this._filterChangedIds || [])
            this._settings.disconnect(id);
        this._filterChangedIds = [];
        // These handlers are connected to the shared GSettings object, which
        // outlives this indicator. Disconnect them to avoid stale callbacks
        // and retained indicator instances across extension reloads.
        if (this._tokenChangedId) {
            this._settings.disconnect(this._tokenChangedId);
            this._tokenChangedId = null;
        }
        if (this._reposChangedId) {
            this._settings.disconnect(this._reposChangedId);
            this._reposChangedId = null;
        }
        if (this._hostChangedId) {
            this._settings.disconnect(this._hostChangedId);
            this._hostChangedId = null;
        }
        if (this._mutedReposChangedId) {
            this._settings.disconnect(this._mutedReposChangedId);
            this._mutedReposChangedId = null;
        }
        if (this._networkChangedId) {
            this._networkMonitor.disconnect(this._networkChangedId);
            this._networkChangedId = null;
        }
        if (this._connectivityChangedId) {
            this._networkMonitor.disconnect(this._connectivityChangedId);
            this._connectivityChangedId = null;
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
        const ind = this._indicator;
        if (ind) {
            if (ind._startupId) {
                GLib.source_remove(ind._startupId);
                ind._startupId = null;
            }
            if (ind._startupCompleteId) {
                try { Main.layoutManager.disconnect(ind._startupCompleteId); } catch (e) {}
                ind._startupCompleteId = null;
            }
            if (ind._matugenDebounceId) {
                GLib.source_remove(ind._matugenDebounceId);
                ind._matugenDebounceId = null;
            }
            if (ind._timeoutId) {
                GLib.source_remove(ind._timeoutId);
                ind._timeoutId = null;
            }
            ind._destroyed = true;
        }
        this._indicator?.destroy();
        this._indicator = null;
    }
}
