import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {createNotificationSummary} from './repo-utils.js';

// Read/dismiss actions and their offline retry state are delegated while the indicator owns UI and persistence.
export async function markThreadRead(indicator, item) {
        const rawId = String(item.rawId || '');
        if (!/^\d+$/.test(rawId))
            return;
        if (indicator._networkMonitor.get_connectivity() !== Gio.NetworkConnectivity.FULL) {
            indicator._queuePendingReadItem(item);
            const statusGeneration = indicator._setActionStatus('Offline — queued to mark read when reconnected');
            indicator._addTransientTimeout(4, () => {
                if (statusGeneration === indicator._actionStatusGeneration) indicator._setActionStatus('');
                return GLib.SOURCE_REMOVE;
            });
            return;
        }
        indicator._setActionStatus('Marking notification read…');
        try {
            await indicator._apiRequest('PATCH', `/notifications/threads/${rawId}`);
        } catch (e) {
            logError(e, 'github-notifier: failed to mark thread read on GitHub');
            indicator._queuePendingReadItem(item);
            const statusGeneration = indicator._setActionStatus('Could not mark read — queued for retry');
            indicator._addTransientTimeout(3, () => {
                if (statusGeneration === indicator._actionStatusGeneration) indicator._setActionStatus('');
                return GLib.SOURCE_REMOVE;
            });
            return;
        }
        indicator._pendingReadItems = indicator._pendingReadItems.filter(pending => pending.rawId !== rawId);
        indicator._notificationItems = indicator._notificationItems.filter(i => i.id !== item.id);
        indicator._persistCurrentItems();
        indicator._setActionStatus('');
        indicator._renderList();
        indicator._updatePanel();
        indicator._updateHero();
    }

export function queuePendingReadItem(indicator, item, maxNotificationPages) {
        const rawId = String(item.rawId || '');
        if (!/^\d+$/.test(rawId))
            return;
        if (!indicator._pendingReadItems.some(pending => pending.rawId === rawId))
            indicator._pendingReadItems.push({id: String(item.id), rawId});
        indicator._pendingReadItems = indicator._pendingReadItems.slice(0, maxNotificationPages * 50);
        indicator._persistCurrentItems();
    }

export async function retryPendingReadItems(indicator) {
        if (indicator._destroyed || indicator._polling || indicator._retryingPendingReadItems ||
            (indicator._pendingReadItems.length === 0 && !indicator._pendingMarkAllRead) ||
            indicator._tokenLoading ||
            indicator._networkMonitor.get_connectivity() !== Gio.NetworkConnectivity.FULL ||
            !indicator._token)
            return;

        indicator._retryingPendingReadItems = true;
        let changed = false;
        try {
            if (indicator._pendingMarkAllRead) {
                const pending = indicator._pendingMarkAllRead;
                try {
                    await indicator._apiRequest('PUT', '/notifications', {body: {last_read_at: pending.lastReadAt}});
                    const notificationIds = new Set(pending.notificationIds);
                    const activityIds = new Set(pending.activityIds);
                    indicator._notificationItems = indicator._notificationItems.filter(item => !notificationIds.has(item.id));
                    indicator._activityItems = indicator._activityItems.filter(item => !activityIds.has(item.id));
                    indicator._pendingReadItems = indicator._pendingReadItems.filter(item => !notificationIds.has(item.id));
                    indicator._pendingMarkAllRead = null;
                    changed = true;
                } catch (e) {
                    logError(e, 'github-notifier: queued mark-all-read retry failed');
                    return;
                }
            }
            for (const pending of indicator._pendingReadItems.slice()) {
                if (indicator._destroyed || indicator._polling)
                    break;
                try {
                    await indicator._apiRequest('PATCH', `/notifications/threads/${pending.rawId}`);
                    indicator._pendingReadItems = indicator._pendingReadItems.filter(item => item.rawId !== pending.rawId);
                    indicator._notificationItems = indicator._notificationItems.filter(item => item.id !== pending.id);
                    changed = true;
                } catch (e) {
                    logError(e, 'github-notifier: queued mark-read retry failed');
                    break;
                }
            }
        } finally {
            indicator._retryingPendingReadItems = false;
            if (changed) {
                indicator._persistCurrentItems();
                indicator._renderList();
                indicator._updatePanel();
                indicator._updateHero();
            }
        }
    }

export function dismissActivityItem(indicator, item) {
        indicator._activityItems = indicator._activityItems.filter(i => i.id !== item.id);
        indicator._persistCurrentItems();
        indicator._renderList();
        indicator._updatePanel();
        indicator._updateHero();
    }

export function markAllRead(indicator) {
        // 2-step confirm like omarchy DashboardSection: first click arms, second executes
        if (!indicator._markAllArmed) {
            if (indicator._notificationItems.length === 0 && indicator._activityItems.length === 0)
                return;
            indicator._markAllArmed = true;
            const statusGeneration = indicator._setActionStatus('Confirm mark all read? Click again.');
            indicator._renderList();
            if (indicator._markAllTimer) GLib.source_remove(indicator._markAllTimer);
            indicator._markAllTimer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 4, () => {
                indicator._disarmMarkAll();
                if (statusGeneration === indicator._actionStatusGeneration) indicator._setActionStatus('');
                return GLib.SOURCE_REMOVE;
            });
            return;
        }
        // Confirmed. Keep the current lists until GitHub acknowledges the
        // operation; otherwise a network failure would permanently discard
        // local-only activity and temporarily hide still-unread notifications.
        indicator._disarmMarkAll();
        if (indicator._tokenLoading || !indicator._token) {
            indicator._setActionStatus('Add or unlock a GitHub token in Settings');
            return;
        }
        if (indicator._pendingMarkAllRead) {
            const statusGeneration = indicator._setActionStatus('Mark all read is already queued for retry');
            indicator._addTransientTimeout(4, () => {
                if (statusGeneration === indicator._actionStatusGeneration) indicator._setActionStatus('');
                return GLib.SOURCE_REMOVE;
            });
            return;
        }

        // Snapshot the exact items and timestamp at confirmation time. When
        // offline, persist the request but keep every item visible until the
        // server acknowledges it after connectivity returns.
        const pendingMarkAll = {
            lastReadAt: new Date().toISOString(),
            notificationIds: indicator._notificationItems.map(item => item.id),
            activityIds: indicator._activityItems.map(item => item.id),
        };
        if (indicator._networkMonitor.get_connectivity() !== Gio.NetworkConnectivity.FULL) {
            indicator._pendingMarkAllRead = pendingMarkAll;
            indicator._persistCurrentItems();
            const statusGeneration = indicator._setActionStatus('Offline — mark all read queued until reconnected');
            indicator._addTransientTimeout(4, () => {
                if (statusGeneration === indicator._actionStatusGeneration) indicator._setActionStatus('');
                return GLib.SOURCE_REMOVE;
            });
            return;
        }
        indicator._markingAllRead = true;
        indicator._setActionStatus('Marking all read…');
        indicator._apiRequest('PUT', '/notifications', {body: {last_read_at: pendingMarkAll.lastReadAt}}).then(() => {
            if (indicator._destroyed)
                return;
            const notificationIds = new Set(pendingMarkAll.notificationIds);
            const activityIds = new Set(pendingMarkAll.activityIds);
            indicator._notificationItems = indicator._notificationItems.filter(item => !notificationIds.has(item.id));
            indicator._activityItems = indicator._activityItems.filter(item => !activityIds.has(item.id));
            indicator._pendingReadItems = indicator._pendingReadItems.filter(item => !notificationIds.has(item.id));
            indicator._pendingMarkAllRead = null;
            indicator._persistCurrentItems();
            indicator._notificationsPage = 0;
            indicator._markingAllRead = false;
            indicator._renderList();
            indicator._updatePanel();
            indicator._updateHero();
            const statusGeneration = indicator._setActionStatus('All marked read');
            indicator._addTransientTimeout(2, () => {
                if (statusGeneration === indicator._actionStatusGeneration) indicator._setActionStatus('');
                return GLib.SOURCE_REMOVE;
            });
        }).catch(e => {
            indicator._markingAllRead = false;
            if (indicator._destroyed)
                return;
            logError(e, 'github-notifier: failed to mark all read on GitHub');
            indicator._pendingMarkAllRead = pendingMarkAll;
            indicator._persistCurrentItems();
            const statusGeneration = indicator._setActionStatus('Could not mark all read — queued for retry; items were kept');
            indicator._addTransientTimeout(3, () => {
                if (statusGeneration === indicator._actionStatusGeneration) indicator._setActionStatus('');
                return GLib.SOURCE_REMOVE;
            });
        });
    }


export function disarmMarkAll(indicator) {
    indicator._markAllArmed = false;
    if (indicator._markAllTimer) {
        GLib.source_remove(indicator._markAllTimer);
        indicator._markAllTimer = null;
    }
    indicator._renderList();
}

/** Route an opened row to mark-read or local activity dismissal. */
export function handleOpenedItem(indicator, item) {
    if (item.kind === 'notification' && item.rawId) {
        if (indicator._settings.get_boolean('mark-read-on-open'))
            return indicator._markThreadRead(item);
    } else {
        return indicator._dismissActivityItem(item);
    }
}

/** Publish the current unread counts to the extension's shared settings key. */
export function publishNotificationSummary(indicator, unreadNotifications, activityItems, enabled = true) {
    const previousText = indicator._settings.get_string('notification-summary');
    let previous = null;
    try { previous = JSON.parse(previousText || '{}'); } catch (_error) {}
    const sameCounts = previous && previous.version === 1 && previous.enabled === enabled &&
        previous.unreadNotifications === unreadNotifications && previous.activityItems === activityItems;
    if (indicator._summaryPublished && sameCounts)
        return;

    const serialized = JSON.stringify(createNotificationSummary(
        unreadNotifications, activityItems, enabled, new Date().toISOString()
    ));
    if (previousText !== serialized && !indicator._settings.set_string('notification-summary', serialized))
        return;
    indicator._summaryPublished = true;
}
