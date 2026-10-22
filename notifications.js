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
