import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Soup from 'gi://Soup';
import Pango from 'gi://Pango';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import {createNotificationSummary, getApiBase, getApiPathFromAbsoluteUrl, getDailyStatsTotals, getGitHubCliArguments, getNotificationCategory, getNotificationIconName, formatRelativeTime, getItemDetail, isRepositoryMuted, isValidRepository, isWithinQuietHours, parseRepositoryList, shouldSuppressDesktopNotifications, updateDailyStats} from './repo-utils.js';
import {loadGithubToken} from './secret-store.js';
import {ApiError, apiRequest} from './api.js';
import {isValidPendingMarkAll, loadState, persistCurrentItems, saveState, stateScope} from './state.js';
import {HoverTooltipController} from './ui-utils.js';
import {addEmpty, addFooter, addRow, addSectionHeader, addSeparator, buildMenuSkeleton, renderList, updateRateFooter, updateHero, setStatusBanner, updatePanel} from './ui-indicator.js';
import {addButtonHoverScale, animateBadgePop, animateHeaderEntrance, animateIconPulse, ease, hasMotion, prefersReducedMotion, startRefreshSpin, stopRefreshSpin} from './ui-animations.js';
import {pollRepoIssues, pollRepoStars} from './repository-polling.js';
import {dismissActivityItem, markAllRead, markThreadRead, queuePendingReadItem, retryPendingReadItems} from './notification-actions.js';
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
        buildMenuSkeleton(this);
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
        return formatRelativeTime(value);
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
        return getNotificationIconName(item);
    }
    _detailForItem(item) {
        return getItemDetail(item, this._relativeTime(item.ts));
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
        updateHero(this);
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
        return prefersReducedMotion(this);
    }

    hasMotion() {
        return hasMotion(this);
    }

    /**
     * Soft ease helper — no-ops when reduced motion is on or actor is gone.
     * props: {opacity, scale_x, scale_y, time, mode, onComplete}
     */
    _ease(actor, props = {}) {
        return ease(this, actor, props);
    }

    _animateBadgePop() {
        animateBadgePop(this);
    }

    /** Strong Octocat pulse + slight hop when new activity arrives. */
    _animateIconPulse() {
        animateIconPulse(this);
    }

    _startRefreshSpin() {
        startRefreshSpin(this);
    }

    _stopRefreshSpin() {
        stopRefreshSpin(this);
    }

    _animateHeaderEntrance() {
        animateHeaderEntrance(this);
    }

    _addButtonHoverScale(button) {
        addButtonHoverScale(this, button);
    }

    /** Show or hide the status banner. kind: 'error' | 'info' | 'none' */
    _setStatusBanner(text, kind = 'info') {
        setStatusBanner(this, text, kind);
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
        updateRateFooter(this);
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
        return pollRepoIssues(this, repo, state, baselineNotes);
    }

    async _pollRepoStars(repo, state, baselineNotes) {
        return pollRepoStars(this, repo, state, baselineNotes);
    }

    async _markThreadRead(item) {
        return markThreadRead(this, item);
    }

    _queuePendingReadItem(item) {
        return queuePendingReadItem(this, item, MAX_NOTIFICATION_PAGES);
    }

    async _retryPendingReadItems() {
        return retryPendingReadItems(this);
    }

    _dismissActivityItem(item) {
        return dismissActivityItem(this, item);
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
        return markAllRead(this);
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
        updatePanel(this, MAX_BADGE);
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
