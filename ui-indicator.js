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

// Render the indicator's sections while keeping actor/state ownership on the indicator.
export function renderList(indicator, constants) {
        // Skip render if data hasn't changed
        const newHash = JSON.stringify({
            notifications: indicator._notificationItems.map(i => i.id).join(','),
            activity: indicator._activityItems.map(i => i.id).join(','),
            notificationsPage: indicator._notificationsPage,
            issuesExpanded: indicator._issuesExpanded,
            starsExpanded: indicator._starsExpanded,
            markAllArmed: indicator._markAllArmed,
            paused: indicator._paused,
            statusIsError: indicator._statusIsError,
            statusText: indicator._statusItem?.label?.text || '',
            rateLimitReset: indicator._rateLimitResetEpoch,
        });
        if (newHash === indicator._lastRenderHash) {
            return;
        }
        indicator._lastRenderHash = newHash;

        // clear sections
        indicator._notifSection.removeAll();
        indicator._issuesSection.removeAll();
        indicator._starsSection.removeAll();
        indicator._footerSection.removeAll();
        indicator._notifSection._rowAnimIdx = 0;
        indicator._issuesSection._rowAnimIdx = 0;
        indicator._starsSection._rowAnimIdx = 0;

        const visibleNotificationItems = indicator._visibleNotificationItems();
        const visibleActivityItems = indicator._visibleActivityItems();
        const hasAny = visibleNotificationItems.length > 0 || visibleActivityItems.length > 0;

        // status banner visibility already handled in _poll; keep hidden when no error unless empty?
        if (!hasAny && !indicator._statusIsError) {
            // show hero already, but ensure empty state still renders sections
        }

        // ---- Unread Notifications (GNOME HIG: Title Case) ----
        // No leading separator: hero (and optional banner) already separate the section.
        const notifCount = visibleNotificationItems.length;
        indicator._addSectionHeader(indicator._notifSection, 'Unread Notifications', notifCount);
        if (notifCount === 0) {
            let emptyMessage;
            if (indicator._statusIsError) {
                emptyMessage = 'No notifications loaded.';
            } else if (!indicator._settings.get_boolean('watch-mentions')) {
                emptyMessage = 'Inbox monitoring is disabled.';
            } else if (indicator._notificationItems.length > 0) {
                emptyMessage = 'No notifications match your filters or muted repositories.';
            } else {
                emptyMessage = "You're all caught up.";
            }
            indicator._addEmpty(indicator._notifSection, emptyMessage);
        } else {
            const pageCount = Math.max(1, Math.ceil(notifCount / constants.notifPageSize));
            if (indicator._notificationsPage >= pageCount) indicator._notificationsPage = pageCount - 1;
            if (indicator._notificationsPage < 0) indicator._notificationsPage = 0;
            const start = indicator._notificationsPage * constants.notifPageSize;
            const slice = visibleNotificationItems.slice(start, start + constants.notifPageSize);
            for (const item of slice) indicator._addRow(indicator._notifSection, item);
            const paginated = pageCount > 1;
            const showMarkAll = notifCount > 0;
            indicator._addFooter(indicator._notifSection, {
                expandable: false,
                paginated,
                page: indicator._notificationsPage,
                pageCount,
                onPrev: () => { indicator._notificationsPage = Math.max(0, indicator._notificationsPage - 1); indicator._renderList(); },
                onNext: () => { indicator._notificationsPage = Math.min(pageCount - 1, indicator._notificationsPage + 1); indicator._renderList(); },
                showOpen: false,
                showMarkAll,
                markAllArmed: indicator._markAllArmed,
                onMarkAll: () => indicator._markAllRead(),
            });
        }

        // ---- ISSUES / PRS ---- (hidden when empty to reduce whitespace)
        const issuePrItems = visibleActivityItems.filter(i => i.kind === 'issue' || i.kind === 'pr')
            .sort((a,b)=> new Date(b.ts)-new Date(a.ts));
        if (issuePrItems.length > 0) {
            indicator._addSeparator(indicator._issuesSection);
            indicator._addSectionHeader(indicator._issuesSection, 'New Issues & Pull Requests', issuePrItems.length);
            const expandable = issuePrItems.length > constants.activityPreview;
            const shown = issuePrItems.slice(0, indicator._issuesExpanded ? constants.activityExpanded : constants.activityPreview);
            for (const item of shown) indicator._addRow(indicator._issuesSection, item);
            indicator._addFooter(indicator._issuesSection, {
                expandable,
                expanded: indicator._issuesExpanded,
                count: issuePrItems.length,
                onToggle: () => { indicator._issuesExpanded = !indicator._issuesExpanded; indicator._renderList(); },
                showOpen: new Set(issuePrItems.map(item => item.subtitle)).size === 1,
                openLabel: 'Open repo',
                openUrl: `${indicator._webBase()}/${issuePrItems[0].subtitle}/issues`,
            });
        }

        // ---- STARS ---- (hidden when empty)
        const starItems = visibleActivityItems.filter(i => i.kind === 'star')
            .sort((a,b)=> new Date(b.ts)-new Date(a.ts));
        if (starItems.length > 0) {
            indicator._addSeparator(indicator._starsSection);
            indicator._addSectionHeader(indicator._starsSection, 'New Stars', starItems.length);
            const expandable = starItems.length > constants.activityPreview;
            const shown = starItems.slice(0, indicator._starsExpanded ? constants.activityExpanded : constants.activityPreview);
            for (const item of shown) indicator._addRow(indicator._starsSection, item);
            indicator._addFooter(indicator._starsSection, {
                expandable,
                expanded: indicator._starsExpanded,
                count: starItems.length,
                onToggle: () => { indicator._starsExpanded = !indicator._starsExpanded; indicator._renderList(); },
                showOpen: new Set(starItems.map(item => item.subtitle)).size === 1,
                openLabel: 'Open repo',
                openUrl: `${indicator._webBase()}/${starItems[0].subtitle}/stargazers`,
            });
        }

        // global footer — always for pause/refresh + rate
        indicator._addFooter(indicator._footerSection, {
            showOpen: true,
            openLabel: 'Open in GitHub',
            openUrl: `${indicator._webBase()}/notifications`,
            showMarkAll: false,
            isPaused: indicator._paused,
            onPauseToggle: () => indicator._togglePause(),
            onRefresh: () => indicator._refreshNow(),
        });

        // when truly empty
        if (!hasAny) {
            // already showed per-section empties, ensure at least one indicator
            if (issuePrItems.length === 0 && starItems.length === 0 && notifCount === 0) {
                // footer already added
            }
        }
        // update rate footer after sections
        indicator._updateRateFooter();
        if (indicator._polling)
            indicator._startRefreshSpin();
    }
