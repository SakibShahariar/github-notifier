import GLib from 'gi://GLib';
import {updateDailyStats} from './repo-utils.js';

const MAX_RECENT = 40;
const MAX_NOTIFICATION_PAGES = 3;

// Persistence is scoped to the configured API host and token fingerprint.
export function stateScope(indicator) {
        const host = indicator._settings.get_string('github-host').trim() || 'api.github.com';
        const token = indicator._token || indicator._settings.get_string('github-token');
        // Store only a one-way token fingerprint, never the token itself.
        const tokenFingerprint = GLib.compute_checksum_for_string(GLib.ChecksumType.SHA256, token, -1);
        return `${host.toLowerCase()}|${tokenFingerprint}`;
}

export function loadState(indicator) {
        try {
            const parsed = JSON.parse(indicator._settings.get_string('last-state') || '{}');
            if (typeof parsed !== 'object' || parsed === null)
                return {};
            // Ignore baselines and cached inbox data from a different host or token.
            // Older unscoped state is intentionally reset once to avoid cross-account events.
            return parsed.scope === indicator._stateScope() ? parsed : {};
        } catch (e) {
            logError(e, 'github-notifier: corrupt last-state, resetting');
            return {};
        }
}

export function saveState(indicator, state) {
        try {
            state.scope = indicator._stateScope();
            const serialized = JSON.stringify(state);
            if (indicator._settings.get_string('last-state') !== serialized)
                indicator._settings.set_string('last-state', serialized);
        } catch (e) {
            logError(e, 'github-notifier: failed to save state');
        }
}

export function isValidPendingMarkAll(indicator, value) {
        return !!value && typeof value.lastReadAt === 'string' &&
            Array.isArray(value.notificationIds) && value.notificationIds.every(id => typeof id === 'string') &&
            Array.isArray(value.activityIds) && value.activityIds.every(id => typeof id === 'string');
}

export function persistCurrentItems(indicator, state = null) {
        const currentState = state || indicator._loadState();
        currentState.activityItems = indicator._activityItems.slice(0, MAX_RECENT);
        currentState.notificationItems = indicator._notificationItems.slice(0, MAX_NOTIFICATION_PAGES * 50);
        currentState.pendingReadItems = indicator._pendingReadItems.slice(0, MAX_NOTIFICATION_PAGES * 50);
        currentState.pendingMarkAllRead = indicator._pendingMarkAllRead;
        currentState.lastFetchedAt = indicator._lastFetchedAt;
        currentState.dailyStats = indicator._dailyStats;
        indicator._saveState(currentState);
}


// Restore only structurally valid cached records before the first network poll.
export function restoreCachedState(indicator) {
    const persistedState = indicator._loadState();
    indicator._dailyStats = updateDailyStats(persistedState.dailyStats, indicator._localDateKey());
    indicator._notificationItems = Array.isArray(persistedState.notificationItems)
        ? persistedState.notificationItems.filter(item => item && typeof item.id === 'string').slice(0, MAX_NOTIFICATION_PAGES * 50)
        : []; // cached inbox, restored when GitHub is temporarily unavailable
    indicator._activityItems = Array.isArray(persistedState.activityItems)
        ? persistedState.activityItems.filter(item => item && typeof item.id === 'string').slice(0, MAX_RECENT)
        : []; // accumulated issue/PR/star events, restored across shell restarts
    indicator._pendingReadItems = Array.isArray(persistedState.pendingReadItems)
        ? persistedState.pendingReadItems.filter(item => item && typeof item.id === 'string' && typeof item.rawId === 'string')
            .slice(0, MAX_NOTIFICATION_PAGES * 50)
        : [];
    indicator._pendingMarkAllRead = indicator._isValidPendingMarkAll(persistedState.pendingMarkAllRead)
        ? persistedState.pendingMarkAllRead
        : null;
}
