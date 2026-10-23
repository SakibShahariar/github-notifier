import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

// Tear down all indicator-owned resources before PanelMenu.Button is destroyed.
export function cleanupIndicator(indicator) {
        indicator._tooltipController?.destroy();
        indicator._tooltipController = null;
        try {
            indicator._publishNotificationSummary(
                indicator._visibleNotificationItems().length,
                indicator._visibleActivityItems().length,
                false
            );
        } catch (e) {
            logError(e, 'github-notifier: failed to publish disabled summary');
        }
        indicator._destroyed = true;
        // Cancel delayed startup polling and detach the shared startup signal.
        // Otherwise a disabled extension can leave a closure retaining the indicator.
        if (indicator._startupId) {
            GLib.source_remove(indicator._startupId);
            indicator._startupId = null;
        }
        if (indicator._startupCompleteId) {
            try { Main.layoutManager.disconnect(indicator._startupCompleteId); } catch (e) {}
            indicator._startupCompleteId = null;
        }
        indicator._pollCancellable?.cancel();
        if (indicator._pollDeadlineId) {
            GLib.source_remove(indicator._pollDeadlineId);
            indicator._pollDeadlineId = null;
        }
        try { indicator._stopRefreshSpin(); } catch (e) {}
        try { indicator._removeMatugenTheme(); } catch (e) {}
        if (indicator._timeoutId) {
            GLib.source_remove(indicator._timeoutId);
            indicator._timeoutId = null;
        }
        if (indicator._networkDebounceId) {
            GLib.source_remove(indicator._networkDebounceId);
            indicator._networkDebounceId = null;
        }
        for (const sourceId of indicator._transientTimeouts)
            GLib.source_remove(sourceId);
        indicator._transientTimeouts.clear();
        for (const finish of indicator._pendingSleepResolvers)
            finish();
        if (indicator._markAllTimer) {
            GLib.source_remove(indicator._markAllTimer);
            indicator._markAllTimer = null;
        }
        if (indicator._settingsChangedId) {
            indicator._settings.disconnect(indicator._settingsChangedId);
            indicator._settingsChangedId = null;
        }
        if (indicator._hideEmptyChangedId) {
            indicator._settings.disconnect(indicator._hideEmptyChangedId);
            indicator._hideEmptyChangedId = null;
        }
        if (indicator._unlitChangedId) {
            indicator._settings.disconnect(indicator._unlitChangedId);
            indicator._unlitChangedId = null;
        }
        if (indicator._statsChangedId) {
            indicator._settings.disconnect(indicator._statsChangedId);
            indicator._statsChangedId = null;
        }
        if (indicator._usernameChangedId) {
            indicator._settings.disconnect(indicator._usernameChangedId);
            indicator._usernameChangedId = null;
        }
        for (const id of indicator._filterChangedIds || [])
            indicator._settings.disconnect(id);
        indicator._filterChangedIds = [];
        // These handlers are connected to the shared GSettings object, which
        // outlives this indicator. Disconnect them to avoid stale callbacks
        // and retained indicator instances across extension reloads.
        if (indicator._tokenChangedId) {
            indicator._settings.disconnect(indicator._tokenChangedId);
            indicator._tokenChangedId = null;
        }
        if (indicator._reposChangedId) {
            indicator._settings.disconnect(indicator._reposChangedId);
            indicator._reposChangedId = null;
        }
        if (indicator._hostChangedId) {
            indicator._settings.disconnect(indicator._hostChangedId);
            indicator._hostChangedId = null;
        }
        if (indicator._mutedReposChangedId) {
            indicator._settings.disconnect(indicator._mutedReposChangedId);
            indicator._mutedReposChangedId = null;
        }
        if (indicator._networkChangedId) {
            indicator._networkMonitor.disconnect(indicator._networkChangedId);
            indicator._networkChangedId = null;
        }
        if (indicator._connectivityChangedId) {
            indicator._networkMonitor.disconnect(indicator._connectivityChangedId);
            indicator._connectivityChangedId = null;
        }
        if (indicator._source) {
            indicator._source.destroy();
            indicator._source = null;
        }
        if (indicator._session)
            indicator._session.abort();
    }


// Attach debounced recovery handlers once the indicator state is initialized.
export function setupNetworkRecovery(indicator) {
            indicator._networkMonitor = Gio.NetworkMonitor.get_default();
            const scheduleNetworkRecoveryPoll = () => {
                if (indicator._destroyed ||
                    indicator._networkMonitor.get_connectivity() !== Gio.NetworkConnectivity.FULL)
                    return;
    
                // A real network recovery is a new opportunity; don't carry the
                // exponential delay from the previous failed connection forward.
                indicator._networkFailureCount = 0;
                indicator._networkRetryAfterEpoch = 0;
    
                // Network and connectivity signals can fire in bursts during a
                // Wi-Fi/VPN transition. Share one debounce window between both.
                if (indicator._networkDebounceId)
                    GLib.source_remove(indicator._networkDebounceId);
                indicator._networkDebounceId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 5, () => {
                    indicator._networkDebounceId = null;
                    if (!indicator._destroyed &&
                        indicator._networkMonitor.get_connectivity() === Gio.NetworkConnectivity.FULL)
                        indicator._poll();
                    return GLib.SOURCE_REMOVE;
                });
            };
            indicator._networkChangedId = indicator._networkMonitor.connect('network-changed', (monitor, available) => {
                if (available)
                    scheduleNetworkRecoveryPoll();
            });
            // Connectivity can become FULL after a captive-portal sign-in without
            // an availability transition, so listen for the property notification too.
            indicator._connectivityChangedId = indicator._networkMonitor.connect('notify::connectivity', scheduleNetworkRecoveryPoll);
    
}

// Start polling after Shell startup, with a bounded fallback if the signal is delayed.
export function scheduleInitialPoll(indicator) {
            // Defer first poll until shell startup completes (or ~5–8s).
            const startPoll = () => {
                if (indicator._destroyed)
                    return;
                if (indicator._startupId) {
                    GLib.source_remove(indicator._startupId);
                    indicator._startupId = null;
                }
                if (indicator._startupCompleteId) {
                    try { Main.layoutManager.disconnect(indicator._startupCompleteId); } catch (e) {}
                    indicator._startupCompleteId = null;
                }
                indicator._poll();
            };
            indicator._startupId = null;
            indicator._startupCompleteId = null;
            if (Main.layoutManager._startingUp) {
                indicator._startupCompleteId = Main.layoutManager.connect('startup-complete', () => startPoll());
                indicator._startupId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 8, () => {
                    startPoll();
                    return GLib.SOURCE_REMOVE;
                });
            } else {
                indicator._startupId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 5, () => {
                    startPoll();
                    return GLib.SOURCE_REMOVE;
                });
            }
    
}
