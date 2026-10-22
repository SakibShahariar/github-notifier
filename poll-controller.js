import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {ApiError} from './api.js';

// Poll orchestration extracted from the indicator; the indicator retains state and UI ownership.
export async function pollIndicator(indicator) {
        if (indicator._paused || indicator._destroyed || indicator._polling || indicator._markingAllRead)
            return;

        const manualRefresh = indicator._manualRefreshPending;
        indicator._manualRefreshPending = false;

        if (indicator._shouldPauseForQuietHours() && !manualRefresh) {
            indicator._setStatusBanner('Quiet hours — automatic polling paused', 'info');
            indicator._updateHero();
            indicator._updatePanel();
            return;
        }
        if (indicator._networkMonitor.network_metered && !manualRefresh) {
            indicator._setStatusBanner('Metered connection — automatic polling paused', 'info');
            indicator._updateHero();
            indicator._updatePanel();
            return;
        }

        if (indicator._tokenLoading)
            return;
        const token = indicator._token;
        if (!token) {
            indicator._setStatusBanner(indicator._tokenWarning
                ? 'GitHub token unavailable — check Secret Service and Settings'
                : 'Add a GitHub token in Settings', 'error');
            indicator._updateHero();
            indicator._updatePanel();
            return;
        }

        const connectivity = indicator._networkMonitor.get_connectivity();
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
            indicator._setStatusBanner(message, 'error');
            indicator._updateHero();
            indicator._updatePanel();
            return;
        }

        const nowEpoch = Math.floor(Date.now() / 1000);
        const networkRetrySeconds = indicator._networkRetryAfterEpoch - nowEpoch;
        if (networkRetrySeconds > 0) {
            const retryIn = networkRetrySeconds < 120
                ? `${networkRetrySeconds} seconds`
                : `${Math.ceil(networkRetrySeconds / 60)} minutes`;
            indicator._setStatusBanner(`GitHub is unreachable — retrying in ${retryIn}`, 'error');
            indicator._updateHero();
            indicator._updatePanel();
            return;
        }
        const retryEpoch = Math.max(indicator._rateLimitResetEpoch, indicator._retryAfterEpoch);
        if (retryEpoch > nowEpoch) {
            const waitMin = Math.ceil((retryEpoch - nowEpoch) / 60);
            indicator._setStatusBanner(`Rate limited — retrying in ~${waitMin} min`, 'error');
            indicator._updateHero();
            indicator._updatePanel();
            return;
        }

        indicator._polling = true;
        const pollScope = indicator._stateScope();
        const pollCancellable = new Gio.Cancellable();
        indicator._pollCancellable = pollCancellable;
        // Bound the total cycle even when many individually slow requests are queued.
        indicator._pollDeadlineId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 60, () => {
            indicator._pollDeadlineId = null;
            if (indicator._pollCancellable === pollCancellable && !pollCancellable.is_cancelled())
                pollCancellable.cancel();
            return GLib.SOURCE_REMOVE;
        });
        indicator._updateHero();
        indicator._startRefreshSpin();
        const state = indicator._loadState();
        let notificationItems = [];
        let notificationPollFailed = false;
        let activityItems = [];
        const errors = [];
        const baselineNotes = [];
        let pollSucceeded = false;

        try {
            if (indicator._settings.get_boolean('watch-mentions')) {
                try {
                    notificationItems = await indicator._pollNotifications(state);
                } catch (e) {
                    if (e instanceof ApiError && (e.status === 0 || e.status === 401 || e.status === 403 || e.status === 429))
                        throw e;
                    // Preserve the last known inbox when a refresh fails.
                    // An empty array here would incorrectly erase the badge/list.
                    notificationPollFailed = true;
                    notificationItems = indicator._notificationItems;
                    errors.push(`Notifications: ${e.message}`);
                    logError(e, 'github-notifier: notifications poll failed');
                }
            }

            // Always prune last-state.repos to the current watch list (or empty)
            {
                const reposStr = indicator._settings.get_string('watched-repos');
                const rawRepos = reposStr.split(',').map(r => r.trim()).filter(r => r.length > 0);
                const watched = new Set(Array.from(new Set(rawRepos)));
                const mutedRepositories = indicator._mutedRepositories();
                if (state.repos && typeof state.repos === 'object') {
                    for (const key of Object.keys(state.repos)) {
                        // Reset baselines while muted so unmuting does not replay
                        // every issue/star event that accumulated during the mute.
                        if (!watched.has(key) || isRepositoryMuted(key, mutedRepositories))
                            delete state.repos[key];
                    }
                }
            }

            if (indicator._settings.get_boolean('watch-issues-prs') || indicator._settings.get_boolean('watch-stars')) {
                const reposStr = indicator._settings.get_string('watched-repos');
                const rawRepos = reposStr.split(',').map(r => r.trim()).filter(r => r.length > 0);
                const repos = Array.from(new Set(rawRepos));
                const mutedRepositories = indicator._mutedRepositories();

                // Keep one poll cycle at a time, but overlap a few independent
                // repositories so large watch lists do not spend most of the
                // cycle waiting on serial network round-trips. Requests for a
                // single repo remain ordered, and result merging stays stable.
                const results = new Array(repos.length);
                const concurrency = Math.min(3, repos.length);
                let nextRepoIndex = 0;
                let fatalRepoError = null;

                const pollNextRepository = async () => {
                    while (!indicator._destroyed && !fatalRepoError) {
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

                        if (indicator._settings.get_boolean('watch-issues-prs')) {
                            try {
                                repoActivity.push(...await indicator._pollRepoIssues(repo, state, baselineNotes));
                            } catch (e) {
                                if (e instanceof ApiError && [0, 401, 403, 429].includes(e.status)) {
                                    fatalRepoError ||= e;
                                    continue;
                                }
                                repoErrors.push(`${repo} issues: ${e.message}`);
                                logError(e, `github-notifier: issues poll failed for ${repo}`);
                            }
                        }
                        if (indicator._destroyed || fatalRepoError)
                            continue;

                        if (indicator._settings.get_boolean('watch-stars')) {
                            try {
                                repoActivity.push(...await indicator._pollRepoStars(repo, state, baselineNotes));
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
                if (indicator._destroyed)
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

            if (indicator._destroyed)
                return;

            // Host/token may have changed while awaiting network requests. Never
            // commit results fetched under a different account scope.
            if (indicator._stateScope() !== pollScope) {
                indicator._accountRefreshPending = true;
                return;
            }

            if (errors.length === 0 && !notificationPollFailed) {
                indicator._networkFailureCount = 0;
                indicator._networkRetryAfterEpoch = 0;
            }
            indicator._afterPoll(notificationItems, activityItems, {updateFetchedAt: errors.length === 0 && !notificationPollFailed});
            indicator._persistCurrentItems(state);
            pollSucceeded = errors.length === 0 && !notificationPollFailed;

            if (baselineNotes.length > 0)
                indicator._notifyBaseline(baselineNotes);

            if (errors.length > 0) {
                const errorText = errors.join(' ').toLowerCase();
                const intervalSeconds = Math.max(60, indicator._settings.get_int('poll-interval'));
                const retrySeconds = Math.max(
                    intervalSeconds,
                    indicator._retryAfterEpoch - Math.floor(Date.now() / 1000),
                    indicator._networkRetryAfterEpoch - Math.floor(Date.now() / 1000));
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
                indicator._setStatusBanner(message, 'error');
            } else if (baselineNotes.length > 0) {
                indicator._setStatusBanner(`Started tracking ${baselineNotes.length} new watch(es)`, 'info');
                // auto-hide after 4s like omarchy banner
                indicator._addTransientTimeout(4, () => {
                    if (indicator._statusItem.label.text.startsWith('Started tracking')) {
                        indicator._setStatusBanner(null);
                        indicator._updatePanel();
                    }
                    return GLib.SOURCE_REMOVE;
                });
            } else {
                indicator._setStatusBanner(null);
                indicator._lastFetchedAt = new Date().toISOString();
                indicator._updateRateFooter();
            }
            indicator._updateHero();
            indicator._updatePanel();
        } catch (e) {
            if (indicator._destroyed || indicator._restartPollRequested)
                return;
            if (indicator._stateScope() !== pollScope) {
                indicator._accountRefreshPending = true;
                return;
            }
            logError(e, 'github-notifier poll failed');
            if (e instanceof ApiError && e.status === 401) {
                indicator._setStatusBanner('Invalid token — check Settings', 'error');
            } else if (e instanceof ApiError && (e.status === 403 || e.status === 429)) {
                if (e.message.toLowerCase().includes('rate limited')) {
                    const retryEpoch = Math.max(indicator._rateLimitResetEpoch, indicator._retryAfterEpoch);
                    const waitMin = retryEpoch > Math.floor(Date.now() / 1000)
                        ? Math.ceil((retryEpoch - Date.now() / 1000) / 60)
                        : null;
                    indicator._setStatusBanner(waitMin
                        ? `Rate limited by GitHub — retrying in ~${waitMin} min`
                        : 'Rate limited by GitHub — will retry later', 'error');
                } else {
                    indicator._setStatusBanner('GitHub access denied — check token permissions or organization SSO', 'error');
                }
            } else if (e instanceof ApiError && e.status === 0) {
                indicator._networkFailureCount = Math.min(indicator._networkFailureCount + 1, 5);
                const backoffSeconds = Math.min(900, 60 * (2 ** (indicator._networkFailureCount - 1)));
                indicator._networkRetryAfterEpoch = Math.floor(Date.now() / 1000) + backoffSeconds;
                const retryLabel = backoffSeconds < 60
                    ? `${backoffSeconds} seconds`
                    : `${Math.ceil(backoffSeconds / 60)} minute${backoffSeconds >= 120 ? 's' : ''}`;
                indicator._setStatusBanner(`GitHub is unreachable — retrying in ${retryLabel}`, 'error');
            } else if (e instanceof ApiError && e.status >= 500) {
                const retryEpoch = Math.max(indicator._retryAfterEpoch, indicator._networkRetryAfterEpoch);
                const retrySeconds = Math.max(
                    Math.max(60, indicator._settings.get_int('poll-interval')),
                    retryEpoch - Math.floor(Date.now() / 1000));
                const retryIn = retrySeconds < 120
                    ? `about ${retrySeconds} seconds`
                    : `about ${Math.ceil(retrySeconds / 60)} minutes`;
                indicator._setStatusBanner(`GitHub is temporarily unavailable — retrying in ${retryIn}`, 'error');
            } else {
                indicator._setStatusBanner('Could not refresh GitHub data — see logs for details', 'error');
            }
            indicator._updateHero();
            indicator._updatePanel();
        } finally {
            if (indicator._pollDeadlineId) {
                GLib.source_remove(indicator._pollDeadlineId);
                indicator._pollDeadlineId = null;
            }
            if (indicator._pollCancellable === pollCancellable)
                indicator._pollCancellable = null;
            indicator._polling = false;
            if (indicator._serverPollIntervalSeconds > 0 || indicator._networkRetryAfterEpoch > 0)
                indicator._restartTimer();
            indicator._updateHero();
            indicator._stopRefreshSpin();
            if (pollSucceeded && (indicator._pendingReadItems.length > 0 || indicator._pendingMarkAllRead)) {
                GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                    indicator._retryPendingReadItems();
                    return GLib.SOURCE_REMOVE;
                });
            }
            const restartAfterRefresh = indicator._restartPollRequested && !indicator._destroyed && !indicator._paused;
            indicator._restartPollRequested = false;
            if ((indicator._accountRefreshPending || restartAfterRefresh) && !indicator._destroyed) {
                indicator._accountRefreshPending = false;
                GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                    if (!indicator._destroyed)
                        indicator._poll();
                    return GLib.SOURCE_REMOVE;
                });
            }
        }
}
