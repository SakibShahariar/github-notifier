import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';

// GNOME 46 introduced object-parameter MessageTray constructors. Keep the
// positional constructor path for GNOME 45, which this extension still lists.
export function _usesModernMessageTrayApi() {
    return typeof MessageTray.getSystemSource === 'function';
}

export function _createMessageTraySource(title, icon) {
    return _usesModernMessageTrayApi()
        ? new MessageTray.Source({title, icon})
        : new MessageTray.Source(title, icon);
}

export function _createMessageTrayNotification(source, title, body) {
    return _usesModernMessageTrayApi()
        ? new MessageTray.Notification({source, title, body})
        : new MessageTray.Notification(source, title, body);
}

// Desktop notification delivery. The indicator remains responsible for actions/state.
export function notify(indicator, newItems) {
        // Keep inbox and badge updates while quiet hours or GNOME Do Not Disturb is active.
        if (indicator._shouldSuppressDesktopNotifications())
            return;
        const source = indicator._ensureSource();
        if (newItems.length > 3) {
            const inboxUrl = `${indicator._webBase()}/notifications`;
            const notification = _createMessageTrayNotification(
                source, 'GitHub Notifier', `${newItems.length} new updates`,
            );
            notification.addAction('Open Inbox', () => indicator._openUri(inboxUrl));
            notification.connect('activated', () => indicator._openUri(inboxUrl));
            source.addNotification(notification);
            return;
        }
        for (const item of newItems) {
            const notification = _createMessageTrayNotification(source, item.title, item.subtitle);
            notification.connect('activated', () => {
                if (!indicator._openUri(item.url))
                    return;
                indicator._handleOpenedItem(item);
            });
            notification.addAction('Open', () => {
                if (!indicator._openUri(item.url))
                    return;
                indicator._handleOpenedItem(item);
            });
            const dismissLabel = item.kind === 'notification' ? 'Mark read' : 'Dismiss';
            notification.addAction(dismissLabel, () => {
                if (item.kind === 'notification' && item.rawId)
                    indicator._markThreadRead(item);
                else
                    indicator._dismissActivityItem(item);
            });
            if (indicator._rateLimitResetEpoch > Math.floor(Date.now() / 1000)) {
                notification.addAction('Retry now', () => indicator._refreshNow());
            }
            source.addNotification(notification);
        }
}

export function notifyBaseline(indicator, notes) {
        if (indicator._shouldSuppressDesktopNotifications())
            return;
        const source = indicator._ensureSource();
        const notification = _createMessageTrayNotification(source, 'GitHub Notifier', notes.join('\n'));
        source.addNotification(notification);
}
