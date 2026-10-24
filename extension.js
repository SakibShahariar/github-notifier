import GObject from 'gi://GObject';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Soup from 'gi://Soup';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import {getApiBase, getApiPathFromAbsoluteUrl, getNextPageUrl, getNotificationCategory, getNotificationIconName, filterVisibleActivityItems, filterVisibleNotificationItems, formatRelativeTime, getItemDetail, getNotificationReasonLabel, getWebBase, getSubjectHtmlUrl, formatLocalDateKey, encodeRepositoryPath, truncateText, isRepositoryMuted, setRepositoryMembership, isWithinQuietHours, parseRepositoryList, shouldSuppressDesktopNotifications} from './repo-utils.js';
import {connectSettingsSignals} from './settings-controller.js';
import {cleanupIndicator, scheduleInitialPoll, setupNetworkRecovery} from './indicator-lifecycle.js';
import {apiRequest, buildMessage, sendOnce} from './api.js';
import {isValidPendingMarkAll, loadState, persistCurrentItems, restoreCachedState, saveState, stateScope} from './state.js';
import {HoverTooltipController} from './ui-utils.js';
import {addEmpty, addFooter, addRow, addSectionHeader, addSeparator, buildMenuSkeleton, buildPanelButton, setupMenuLifecycle, renderList, setActionStatus, setStatusBanner, showRepositoryActionStatus, updateDailyStatsItem, updateHero, updatePanel, updateRateFooter} from './ui-indicator.js';
import {addTransientTimeout, afterPoll, pollIndicator, refreshPollNow, restartPollTimer, sleepIndicator, togglePollingPause} from './poll-controller.js';
import {addButtonHoverScale, animateBadgePop, animateHeaderEntrance, animateIconPulse, ease, hasMotion, prefersReducedMotion, startRefreshSpin, stopRefreshSpin} from './ui-animations.js';
import {pollRepoIssues, pollRepoStars} from './repository-polling.js';
import {pollNotifications} from './notification-polling.js';
import {dismissActivityItem, handleOpenedItem, disarmMarkAll, markAllRead, publishNotificationSummary, markThreadRead, queuePendingReadItem, retryPendingReadItems} from './notification-actions.js';
import {githubCliLaunchConfig, openUri, openWithGitHubCli} from './link-actions.js';
import {_createMessageTraySource, notify, notifyBaseline} from './notifications.js';
import {applyMatugenThemeInternal, loadMatugenColorsIfChanged, removeMatugenTheme, setupMatugenMonitor} from './ui-theme.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
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
        restoreCachedState(this);
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
        buildPanelButton(this);

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

        connectSettingsSignals(this, {
            notificationFilterCategories: NOTIFICATION_FILTER_CATEGORIES,
            maxNotificationPages: MAX_NOTIFICATION_PAGES,
            maxRecent: MAX_RECENT,
        });
        setupNetworkRecovery(this);

        this._setupMatugenMonitor();

        // Theme changes only happen while the menu is closed (focus leaves the
        // popup). Skip Matugen on open — colors already applied at launch / by
        // the file monitor. Still build/render + entrance animation.
        setupMenuLifecycle(this);

        this._restartTimer();
        scheduleInitialPoll(this);
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
        togglePollingPause(this);
    }

    _restartTimer() {
        return restartPollTimer(this);
    }

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
        return setRepositoryMembership(this._settings, settingKey, repository, shouldContain);
    }

    _showRepositoryActionStatus(message, undoMuteRepository = null) {
        showRepositoryActionStatus(this, message, undoMuteRepository);
    }

    _isItemMuted(item, mutedRepositories = this._mutedRepositories()) {
        return isRepositoryMuted(item?.subtitle, mutedRepositories);
    }

    _visibleNotificationItems() {
        const enabledCategories = new Set(NOTIFICATION_FILTER_CATEGORIES.filter(category =>
            this._settings.get_boolean(`filter-${category}`)));
        return filterVisibleNotificationItems(
            this._notificationItems, enabledCategories, this._mutedRepositories());
    }

    _visibleActivityItems() {
        return filterVisibleActivityItems(this._activityItems, this._mutedRepositories());
    }

    _iconForItem(item) {
        return getNotificationIconName(item);
    }
    _detailForItem(item) {
        return getItemDetail(item, this._relativeTime(item.ts));
    }

    _localDateKey(date = new Date()) {
        return formatLocalDateKey(date);
    }

    _updateDailyStatsItem() {
        updateDailyStatsItem(this);
    }
    _updateHero() {
        updateHero(this);
    }

    _setActionStatus(text) {
        return setActionStatus(this, text);
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
        return loadMatugenColorsIfChanged(this, force);
    }

    _applyMatugenThemeInternal(colors) {
        return applyMatugenThemeInternal(this, colors);
    }

    _setupMatugenMonitor() {
        return setupMatugenMonitor(this);
    }

    _removeMatugenTheme() {
        return removeMatugenTheme(this);
    }

    _disarmMarkAll() {
        return disarmMarkAll(this);
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
        return sleepIndicator(this, ms);
    }

    _addTransientTimeout(seconds, callback) {
        return addTransientTimeout(this, seconds, callback);
    }

    _buildMessage(method, uri, token, body, headers = {}) {
        return buildMessage(this, method, uri, token, body, headers);
    }

    async _sendOnce(method, uri, token, body, headers = {}, cancellable = null) {
        return sendOnce(this, method, uri, token, body, headers, cancellable);
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
        return getNextPageUrl(linkHeader);
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
        return refreshPollNow(this);
    }

    _poll() {
        return pollIndicator(this);
    }

    _updateRateFooter() {
        updateRateFooter(this);
    }

    async _pollNotifications(state) {
        return pollNotifications(this, state, MAX_NOTIFICATION_PAGES);
    }

    _reasonToKind(reason, subjectType) {
        return getNotificationReasonLabel(reason, subjectType);
    }

    _webBase() {
        return getWebBase(this._settings.get_string('github-host'));
    }

    _subjectHtmlUrl(subject, repoFullName) {
        return getSubjectHtmlUrl(subject, repoFullName, this._apiBase(), this._webBase());
    }

    _encodeRepo(repo) {
        return encodeRepositoryPath(repo);
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
    _afterPoll(notificationItems, newActivityItems, options = {}) {
        return afterPoll(this, notificationItems, newActivityItems, options, MAX_RECENT);
    }

    _markAllRead() {
        return markAllRead(this);
    }

    _publishNotificationSummary(unreadNotifications, activityItems, enabled = true) {
        return publishNotificationSummary(this, unreadNotifications, activityItems, enabled);
    }

    _updatePanel() {
        updatePanel(this, MAX_BADGE);
    }

    _truncate(text, maxLen) {
        return truncateText(text, maxLen);
    }
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
        return openUri(this, uri);
    }

    _githubCliLaunchConfig(item) {
        return githubCliLaunchConfig(this, item);
    }

    _openWithGitHubCli(item) {
        return openWithGitHubCli(this, item);
    }

    _handleOpenedItem(item) {
        return handleOpenedItem(this, item);
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
        cleanupIndicator(this);
        super.destroy();
    }
});

export default class GithubNotifierExtension extends Extension {
    enable() {
        this._indicator = new Indicator(this);
        Main.panel.addToStatusArea(this.uuid, this._indicator);
    }

    disable() {
        // Indicator.destroy() owns complete teardown through cleanupIndicator().
        this._indicator?.destroy();
        this._indicator = null;
    }
}
