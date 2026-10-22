import St from 'gi://St';
import Clutter from 'gi://Clutter';
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

export function addFooter(indicator, section, opts, activityExpanded) {
        // opts: {expandable, expanded, count, onToggle, paginated, page, pageCount, onPrev, onNext, showOpen, openUrl, showMarkAll, markAllArmed, onMarkAll, showRefresh, onRefresh, isPaused}
        const footerItem = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        const box = new St.BoxLayout({style_class: 'github-notifier-footer', x_align: Clutter.ActorAlign.CENTER, x_expand: true});
        const makeBtn = (text, cb, urgent) => {
            const btn = new St.Button({label: text, style_class: 'github-notifier-footer-button' + (urgent ? ' urgent' : ''), can_focus: true});
            btn.connect('clicked', cb);
            box.add_child(btn);
            if (indicator.hasMotion()) indicator._addButtonHoverScale(btn);
            return btn;
        };
        const makeIconBtn = (iconName, cb, tooltip) => {
            const btn = new St.Button({
                style_class: 'github-notifier-footer-button github-notifier-footer-icon-button',
                can_focus: true,
                child: new St.Icon({icon_name: iconName, icon_size: 14, style_class: 'popup-menu-icon'}),
            });
            if (tooltip) indicator._setTooltip(btn, tooltip);
            btn.connect('clicked', cb);
            box.add_child(btn);
            if (indicator.hasMotion()) indicator._addButtonHoverScale(btn);
            return btn;
        };
        if (opts.expandable) {
            const label = opts.expanded ? 'Show less' : (opts.count > activityExpanded ? 'Show 25' : `Show all ${opts.count}`);
            makeBtn(label, opts.onToggle);
        }
        if (opts.showMarkAll) {
            const label = opts.markAllArmed ? 'Confirm?' : 'Mark all read';
            makeBtn(label, opts.onMarkAll, opts.markAllArmed);
        }
        if (opts.paginated) {
            const prev = makeIconBtn('go-previous-symbolic', opts.onPrev, 'Previous page');
            prev.can_focus = true;
            if (opts.page <= 0) prev.reactive = false;
            const lab = new St.Label({text: `${opts.page + 1} / ${opts.pageCount}`, y_align: Clutter.ActorAlign.CENTER, style_class: 'github-notifier-hero-meta'});
            lab.set_style('padding: 0 6px; opacity: 1;');
            box.add_child(lab);
            const next = makeIconBtn('go-next-symbolic', opts.onNext, 'Next page');
            if (opts.page + 1 >= opts.pageCount) next.reactive = false;
        }
        if (opts.showOpen) {
            const openLabel = opts.openLabel || 'Open in GitHub';
            const openBox = new St.BoxLayout({style: 'spacing: 6px;', x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER});
            openBox.add_child(new St.Label({text: openLabel}));
            openBox.add_child(new St.Icon({icon_name: 'go-next-symbolic', icon_size: 14, style_class: 'popup-menu-icon', y_align: Clutter.ActorAlign.CENTER}));
            const openBtn = new St.Button({style_class: 'github-notifier-footer-button', can_focus: true, child: openBox});
            openBtn.connect('clicked', () => indicator._openUri(opts.openUrl));
            box.add_child(openBtn);
            if (indicator.hasMotion()) indicator._addButtonHoverScale(openBtn);
        }
        // refresh / pause controls only when handlers provided (global footer)
        if (opts.onPauseToggle && opts.onRefresh) {
            makeBtn(opts.isPaused ? 'Resume' : 'Pause', opts.onPauseToggle);
            const refreshBox = new St.BoxLayout({spacing: 6, y_align: Clutter.ActorAlign.CENTER});
            indicator._refreshIcon = new St.Icon({
                icon_name: 'view-refresh-symbolic',
                icon_size: 14,
                style_class: 'popup-menu-icon',
                y_align: Clutter.ActorAlign.CENTER,
            });
            refreshBox.add_child(indicator._refreshIcon);
            refreshBox.add_child(new St.Label({text: 'Refresh', y_align: Clutter.ActorAlign.CENTER}));
            const refreshBtn = new St.Button({
                style_class: 'github-notifier-footer-button',
                can_focus: true,
                child: refreshBox,
            });
            refreshBtn.connect('clicked', opts.onRefresh);
            box.add_child(refreshBtn);
            if (indicator.hasMotion())
                indicator._addButtonHoverScale(refreshBtn);
        }

        footerItem.add_child(box);
        section.addMenuItem(footerItem);
    }
