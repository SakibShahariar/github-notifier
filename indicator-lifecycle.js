import GLib from 'gi://GLib';

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
        super.destroy();
    }
