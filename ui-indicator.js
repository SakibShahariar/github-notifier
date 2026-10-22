import St from 'gi://St';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

// Small menu primitives kept separate from the indicator's stateful rendering.
export function addSectionHeader(section, title, count) {
    const headerItem = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
    const box = new St.BoxLayout({x_expand: true});
    const label = new St.Label({text: `${title}  ${count}`, style_class: 'github-notifier-section-header', x_expand: true});
    box.add_child(label);
    headerItem.add_child(box);
    section.addMenuItem(headerItem);
}

export function addSeparator(section) {
    const sepItem = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
    const sep = new St.Widget({style_class: 'github-notifier-separator', x_expand: true});
    sepItem.add_child(sep);
    section.addMenuItem(sepItem);
}

export function addEmpty(section, text) {
    const item = new PopupMenu.PopupMenuItem(text, {reactive: false});
    item.style_class = 'github-notifier-empty';
    item.label.style_class = 'github-notifier-empty';
    section.addMenuItem(item);
}
