import {loadGithubToken} from './secret-store.js';
import {updateDailyStats} from './repo-utils.js';

// Connect setting changes and refresh account-scoped state without growing the entry-point class.
export function connectSettingsSignals(indicator, constants) {
        indicator._settingsChangedId = indicator._settings.connect('changed::poll-interval', () => indicator._restartTimer());
        indicator._hideEmptyChangedId = indicator._settings.connect('changed::hide-when-empty', () => indicator._updatePanel());
        indicator._unlitChangedId = indicator._settings.connect('changed::icon-always-unlit', () => indicator._updatePanel());
        indicator._statsChangedId = indicator._settings.connect('changed::show-daily-stats', () => indicator._updateDailyStatsItem());
        // live hero update when username changes
        indicator._usernameChangedId = indicator._settings.connect('changed::github-username', () => indicator._updateHero());
        indicator._filterChangedIds = constants.notificationFilterCategories.map(category =>
            indicator._settings.connect(`changed::filter-${category}`, () => {
                if (indicator._destroyed)
                    return;
                indicator._lastRenderHash = '';
                indicator._renderList();
                indicator._updatePanel();
                indicator._updateHero();
            }));
        const pollAfterRepositorySettingsChange = () => {
            if (indicator._destroyed)
                return;
            // The current cycle captured the old watch/mute set. Queue one fresh
            // cycle so changes made mid-request are applied immediately.
            if (indicator._polling) {
                indicator._restartPollRequested = true;
                indicator._pollCancellable?.cancel();
                return;
            }
            indicator._poll();
        };
        const refreshIfMenuOpen = () => {
            if (indicator._destroyed || !indicator.menu?.isOpen)
                return;
            indicator._lastRenderHash = '';
            indicator._renderList();
        };
        const refreshAccountScope = () => {
            if (indicator._destroyed)
                return;
            // A poll already in flight may still hold the previous account's data.
            // Queue a fresh poll; the old result is discarded before it can be saved.
            if (indicator._polling)
                indicator._accountRefreshPending = true;
            // Rate-limit headers are host/account-specific; do not carry the old
            // account's API backoff into the newly selected account.
            indicator._rateLimitResetEpoch = 0;
            indicator._retryAfterEpoch = 0;
            indicator._serverPollIntervalSeconds = 0;
            const state = indicator._loadState();
            indicator._notificationItems = Array.isArray(state.notificationItems)
                ? state.notificationItems.filter(item => item && typeof item.id === 'string').slice(0, constants.maxNotificationPages * 50)
                : [];
            indicator._activityItems = Array.isArray(state.activityItems)
                ? state.activityItems.filter(item => item && typeof item.id === 'string').slice(0, constants.maxRecent)
                : [];
            indicator._pendingReadItems = Array.isArray(state.pendingReadItems)
                ? state.pendingReadItems.filter(item => item && typeof item.id === 'string' && typeof item.rawId === 'string' && /^\d+$/.test(item.rawId))
                    .slice(0, constants.maxNotificationPages * 50)
                : [];
            indicator._pendingMarkAllRead = indicator._isValidPendingMarkAll(state.pendingMarkAllRead)
                ? state.pendingMarkAllRead
                : null;
            indicator._lastFetchedAt = typeof state.lastFetchedAt === 'string' ? state.lastFetchedAt : null;
            indicator._dailyStats = updateDailyStats(state.dailyStats, indicator._localDateKey());
            indicator._lastRenderHash = '';
            indicator._updateHero();
            indicator._updatePanel();
            indicator._poll();
        };
        let tokenRefreshGeneration = 0;
        const refreshToken = async () => {
            const generation = ++tokenRefreshGeneration;
            indicator._tokenLoading = true;
            if (indicator._polling) {
                // Stop requests under the previous credential/host promptly.
                // The restart flag prevents cancellation from becoming a network-error banner.
                indicator._restartPollRequested = true;
                indicator._pollCancellable?.cancel();
            }
            try {
                const credential = await loadGithubToken(indicator._settings);
                if (indicator._destroyed || generation !== tokenRefreshGeneration)
                    return;
                indicator._token = credential.token;
                indicator._tokenWarning = credential.warning || '';
                if (indicator._tokenWarning)
                    log('github-notifier: Secret Service credential migration needs attention');
            } catch (e) {
                if (indicator._destroyed || generation !== tokenRefreshGeneration)
                    return;
                indicator._token = '';
                indicator._tokenWarning = e.message;
                logError(e, 'github-notifier: unable to retrieve GitHub token from Secret Service');
            } finally {
                if (!indicator._destroyed && generation === tokenRefreshGeneration) {
                    indicator._tokenLoading = false;
                    refreshAccountScope();
                }
            }
        };
        indicator._tokenChangedId = indicator._settings.connect('changed::token-generation', refreshToken);
        indicator._reposChangedId = indicator._settings.connect('changed::watched-repos', () => {
            if (indicator._destroyed)
                return;
            refreshIfMenuOpen();
            // Establish the new repository's baseline immediately, even when
            // another poll cycle was already in flight.
            pollAfterRepositorySettingsChange();
        });
        indicator._mutedReposChangedId = indicator._settings.connect('changed::muted-repos', () => {
            if (indicator._destroyed)
                return;
            indicator._lastRenderHash = '';
            indicator._renderList();
            indicator._updatePanel();
            indicator._updateHero();
            pollAfterRepositorySettingsChange();
        });
        indicator._hostChangedId = indicator._settings.connect('changed::github-host', refreshToken);
        // Secret Service access is asynchronous so it cannot block GNOME Shell.
        refreshToken();

}
