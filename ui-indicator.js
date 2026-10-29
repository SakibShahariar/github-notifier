import St from 'gi://St';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Clutter from 'gi://Clutter';
import Pango from 'gi://Pango';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {getDailyStatsTotals, getNotificationEmptyState, getStatusAction, isValidRepository, updateDailyStats} from './repo-utils.js';

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
            const accessibleLabel = tooltip || iconName.replace(/-symbolic$/, '').replaceAll('-', ' ');
            btn.accessible_name = accessibleLabel;
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
            const previousDisabled = opts.page <= 0;
            prev.reactive = !previousDisabled;
            prev.can_focus = !previousDisabled;
            const lab = new St.Label({text: `${opts.page + 1} / ${opts.pageCount}`, y_align: Clutter.ActorAlign.CENTER, style_class: 'github-notifier-hero-meta'});
            lab.accessible_name = `Page ${opts.page + 1} of ${opts.pageCount}`;
            lab.set_style('padding: 0 6px; opacity: 1;');
            box.add_child(lab);
            const next = makeIconBtn('go-next-symbolic', opts.onNext, 'Next page');
            const nextDisabled = opts.page + 1 >= opts.pageCount;
            next.reactive = !nextDisabled;
            next.can_focus = !nextDisabled;
        }
        if (opts.showOpen) {
            const openLabel = opts.openLabel || 'Open in GitHub';
            const openBox = new St.BoxLayout({style: 'spacing: 6px;', x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER});
            openBox.add_child(new St.Label({text: openLabel}));
            openBox.add_child(new St.Icon({icon_name: 'go-next-symbolic', icon_size: 14, style_class: 'popup-menu-icon', y_align: Clutter.ActorAlign.CENTER}));
            const openBtn = new St.Button({style_class: 'github-notifier-footer-button', can_focus: true, child: openBox});
            openBtn.accessible_name = openLabel;
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
            refreshBtn.accessible_name = 'Refresh GitHub notifications';
            indicator._setTooltip(refreshBtn, refreshBtn.accessible_name);
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
            notifications: indicator._notificationItems.map(i => [i.id, i.title, i.subtitle, i.ts, i.url, i.kind, i.rawId]),
            activity: indicator._activityItems.map(i => [i.id, i.title, i.subtitle, i.ts, i.url, i.kind]),
            notificationsPage: indicator._notificationsPage,
            notificationSearchQuery: indicator._notificationSearchQuery,
            issuesExpanded: indicator._issuesExpanded,
            starsExpanded: indicator._starsExpanded,
            markAllArmed: indicator._markAllArmed,
            paused: indicator._paused,
            statusIsError: indicator._statusIsError,
            statusText: indicator._statusItem?.label?.text || '',
            watchEnabled: indicator._settings.get_boolean('watch-mentions'),
            tokenLoading: indicator._tokenLoading,
            hasToken: Boolean(indicator._token),
            tokenWarning: indicator._tokenWarning,
            hasFetched: Boolean(indicator._lastFetchedAt),
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
            if (indicator._notificationSearchQuery.trim()) {
                indicator._addEmpty(indicator._notifSection, 'No cached notifications match your search.');
            } else {
            const emptyMessage = getNotificationEmptyState({
                watchEnabled: indicator._settings.get_boolean('watch-mentions'),
                tokenLoading: indicator._tokenLoading,
                hasToken: Boolean(indicator._token),
                tokenWarning: indicator._tokenWarning,
                statusIsError: indicator._statusIsError,
                hasFetched: Boolean(indicator._lastFetchedAt),
                hasCachedNotifications: indicator._notificationItems.length > 0,
            });
            indicator._addEmpty(indicator._notifSection, emptyMessage);
            }
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
                openUrl: `${indicator._webBase()}/${issuePrItems[0].subtitle}/${new Set(issuePrItems.map(item => item.kind)).size === 1 && issuePrItems[0].kind === 'pr' ? 'pulls' : new Set(issuePrItems.map(item => item.kind)).size === 1 && issuePrItems[0].kind === 'issue' ? 'issues' : ''}`,
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

// Build one activity/inbox row; all state transitions remain methods on the indicator.
export function addRow(indicator, section, item) {
        const secondaryColor = indicator._matugenColors?.secondary || '#aaaaaa';
        const menuItem = new PopupMenu.PopupBaseMenuItem({style_class: 'github-notifier-row'});
        const rowKind = ({
            notification: 'Notification',
            issue: 'Issue',
            pr: 'Pull request',
            star: 'New star',
        })[item.kind] || 'Activity';
        const rowParts = [rowKind, item.title, item.subtitle, indicator._detailForItem(item)]
            .filter(value => typeof value === 'string' && value.trim())
            .map(value => value.trim());
        menuItem.accessible_name = indicator._truncate([...new Set(rowParts)].join(', '), 180);
        menuItem.connect('activate', () => {
            if (!indicator._openUri(item.url))
                return;
            indicator._handleOpenedItem(item);
        });

        const rowBox = new St.BoxLayout({x_expand: true, style_class: 'github-notifier-row-inner', y_align: Clutter.ActorAlign.CENTER});
        // GNOME-native symbolic icon (replaces nerd-font glyph)
        const iconName = indicator._iconForItem(item);
        const glyph = new St.Icon({
            icon_name: iconName,
            style_class: 'popup-menu-icon github-notifier-glyph' + (item.kind === 'star' ? ' urgent' : ' dim'),
            y_align: Clutter.ActorAlign.CENTER,
            icon_size: 18,
        });
        rowBox.add_child(glyph);

        const textBox = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        const titleLabel = new St.Label({text: indicator._truncate(item.title, 68), style_class: 'github-notifier-row-title', x_expand: true});
        titleLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        titleLabel.clutter_text.line_wrap = false;
        const detailLabel = new St.Label({text: indicator._detailForItem(item), style_class: 'github-notifier-row-detail', x_expand: true});
        detailLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        textBox.add_child(titleLabel);
        textBox.add_child(detailLabel);
        rowBox.add_child(textBox);

        // combine row and read-strip in single container (PopupBaseMenuItem is a Bin)
        const container = new St.BoxLayout({x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        container.add_child(rowBox);
        const strip = new St.BoxLayout({style_class: 'github-notifier-read-strip', y_align: Clutter.ActorAlign.CENTER});
        // Inbox and activity rows carry owner/repo in subtitle. Only show
        // repository actions when that value passes the shared validator; the
        // synthetic "more notifications" row has a URL here and is excluded.
        const repository = typeof item.subtitle === 'string' &&
            isValidRepository(item.subtitle.trim()) ? item.subtitle.trim().toLowerCase() : '';
        if (repository) {
            const watched = indicator._watchedRepositories().has(repository);
            if (!watched) {
                const watchButton = new St.Button({
                    style_class: 'github-notifier-read-button',
                    can_focus: true,
                    child: new St.Icon({
                        icon_name: 'list-add-symbolic',
                        x_align: Clutter.ActorAlign.CENTER,
                        y_align: Clutter.ActorAlign.CENTER,
                    }),
                });
                watchButton.set_style(`color: ${secondaryColor}; width: 24px; height: 24px;`);
                watchButton.accessible_name = `Watch ${repository}`;
                indicator._setTooltip(watchButton, `Watch ${repository}`);
                watchButton.connect('clicked', () => {
                    if (indicator._setRepositoryMembership('watched-repos', repository, true))
                        indicator._showRepositoryActionStatus(`Watching ${repository}`);
                    else
                        indicator._showRepositoryActionStatus('Could not update watched repositories');
                    indicator._lastRenderHash = '';
                    indicator._renderList();
                    return Clutter.EVENT_STOP;
                });
                strip.add_child(watchButton);
            }
        }

        const repositoryForMute = typeof item.subtitle === 'string' &&
            isValidRepository(item.subtitle.trim()) ? item.subtitle.trim().toLowerCase() : '';
        if (repositoryForMute) {
            const muted = indicator._mutedRepositories().has(repositoryForMute);
            const muteButton = new St.Button({
                style_class: 'github-notifier-read-button',
                can_focus: true,
                child: new St.Icon({
                    icon_name: muted ? 'edit-undo-symbolic' : 'notifications-disabled-symbolic',
                    x_align: Clutter.ActorAlign.CENTER,
                    y_align: Clutter.ActorAlign.CENTER,
                }),
            });
            muteButton.set_style(`color: ${secondaryColor}; width: 24px; height: 24px;`);
            muteButton.accessible_name = muted ? `Unmute ${repositoryForMute}` : `Mute ${repositoryForMute}`;
            indicator._setTooltip(muteButton, muteButton.accessible_name);
            muteButton.connect('clicked', () => {
                const nextMuted = !indicator._mutedRepositories().has(repositoryForMute);
                if (indicator._setRepositoryMembership('muted-repos', repositoryForMute, nextMuted))
                    indicator._showRepositoryActionStatus(
                        nextMuted ? `Muted ${repositoryForMute}` : `Unmuted ${repositoryForMute}`,
                        nextMuted ? repositoryForMute : null);
                else
                    indicator._showRepositoryActionStatus('Could not update muted repositories');
                indicator._lastRenderHash = '';
                indicator._renderList();
                return Clutter.EVENT_STOP;
            });
            strip.add_child(muteButton);
        }

        const githubCliConfig = indicator._githubCliLaunchConfig(item);
        if (githubCliConfig) {
            const cliButton = new St.Button({
                style_class: 'github-notifier-read-button',
                can_focus: true,
                child: new St.Icon({
                    icon_name: 'utilities-terminal-symbolic',
                    x_align: Clutter.ActorAlign.CENTER,
                    y_align: Clutter.ActorAlign.CENTER,
                }),
            });
            cliButton.set_style(`color: ${secondaryColor}; width: 24px; height: 24px;`);
            cliButton.accessible_name = 'Open with GitHub CLI';
            indicator._setTooltip(cliButton, 'Open with GitHub CLI');
            cliButton.connect('clicked', () => {
                indicator._openWithGitHubCli(item);
                return Clutter.EVENT_STOP;
            });
            strip.add_child(cliButton);
        }
        const readIcon = new St.Icon({
            icon_name: 'object-select-symbolic',
            style_class: 'github-notifier-read-icon',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        const btn = new St.Button({
            style_class: 'github-notifier-read-button',
            can_focus: true,
            child: readIcon,
        });
        btn.set_style(`color: ${secondaryColor}; width: 24px; height: 24px;`);
        btn.accessible_name = item.kind === 'notification' ? 'Mark read' : 'Dismiss';
        indicator._setTooltip(btn, btn.accessible_name);
        btn.connect('clicked', () => {
            if (item.kind === 'notification' && item.rawId)
                indicator._markThreadRead(item);
            else
                indicator._dismissActivityItem(item);
            return Clutter.EVENT_STOP;
        });
        strip.add_child(btn);
        container.add_child(strip);
        menuItem.add_child(container);

        section.addMenuItem(menuItem);
        if (indicator.hasMotion()) {
            const idx = section._rowAnimIdx || 0;
            section._rowAnimIdx = idx + 1;
            menuItem.opacity = 0;
            menuItem.translation_y = -4;
            menuItem.ease({ opacity: 255, translation_y: 0, delay: idx * 35, duration: 220, mode: Clutter.AnimationMode.EASE_OUT_QUAD });
        }
        if (indicator.hasMotion()) indicator._addButtonHoverScale(btn);
    }

// Construct the menu's stable skeleton and keep it owned by the indicator.
export function buildMenuSkeleton(indicator) {
        // --- hero ---
        const iconPath = GLib.build_filenamev([indicator._ext.path, 'icons', 'github-symbolic.svg']);
        const heroItem = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        heroItem.style_class = 'github-notifier-hero-item';
        const heroBox = new St.BoxLayout({x_expand: true, style_class: 'github-notifier-hero'});
        const heroIcon = new St.Icon({
            gicon: Gio.icon_new_for_string(iconPath),
            style_class: 'system-status-icon github-notifier-hero-icon',
            icon_size: 24,
        });
        const textBox = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        indicator._heroTitle = new St.Label({text: 'GitHub', style_class: 'github-notifier-hero-title'});
        indicator._heroMeta = new St.Label({text: 'Checking…', style_class: 'github-notifier-hero-meta'});
        // ellipsize meta so it fits ~420px
        indicator._heroMeta.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        textBox.add_child(indicator._heroTitle);
        textBox.add_child(indicator._heroMeta);
        const gearButton = new St.Button({
            style_class: 'github-notifier-hero-gear',
            can_focus: true,
            child: new St.Icon({icon_name: 'preferences-system-symbolic', style_class: 'popup-menu-icon'}),
        });
        indicator._heroBox = heroBox;
        indicator._heroItem = heroItem;
        indicator._heroIcon = heroIcon;
        indicator._heroGear = gearButton;
        gearButton.accessible_name = 'Settings';
        indicator._setTooltip(gearButton, 'Settings');
        gearButton.connect('clicked', () => indicator._ext.openPreferences());
        heroBox.add_child(heroIcon);
        heroBox.add_child(textBox);
        heroBox.add_child(gearButton);
        heroItem.add_child(heroBox);
        indicator.menu.addMenuItem(heroItem);

        // status / warning banner (hidden unless needed)
        indicator._statusItem = new PopupMenu.PopupMenuItem('Checking GitHub…', {reactive: false});
        indicator._statusItem.style_class = 'github-notifier-banner';
        indicator._statusItem.label.clutter_text.line_wrap = true;
        indicator._statusItem.label.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        indicator.menu.addMenuItem(indicator._statusItem);
        indicator._statusItem.visible = false;

        // Give token and credential errors a direct, keyboard-accessible route
        // to Preferences instead of leaving users to hunt for the settings gear.
        indicator._statusAction = null;
        indicator._statusActionItem = new PopupMenu.PopupMenuItem('Open Settings');
        indicator._statusActionItem.connect('activate', () => {
            if (indicator._statusAction === 'refresh')
                indicator._refreshNow();
            else if (indicator._statusAction === 'settings')
                indicator._ext.openPreferences();
        });
        indicator._statusActionItem.visible = false;
        indicator.menu.addMenuItem(indicator._statusActionItem);

        // action status (marking …) centered dim text
        indicator._statsItem = new PopupMenu.PopupMenuItem('', {reactive: false});
        indicator._statsItem.style_class = 'github-notifier-rate';
        indicator.menu.addMenuItem(indicator._statsItem);
        indicator._statsItem.visible = false;

        indicator._repositoryActionStatusGeneration = 0;
    indicator._actionStatusGeneration = 0;
    indicator._actionStatusItem = new PopupMenu.PopupMenuItem('', {reactive: false});
        indicator._actionStatusItem.style_class = 'github-notifier-action-status';
        indicator._actionStatusItem.visible = false;
        indicator.menu.addMenuItem(indicator._actionStatusItem);

        // Muting hides every row for that repository, so provide a short-lived
        // undo action here rather than leaving the row's future Unmute control
        // unreachable after the first click.
        indicator._pendingMuteUndoRepository = null;
        indicator._repositoryUndoItem = new PopupMenu.PopupMenuItem('Undo mute');
        indicator._repositoryUndoItem.connect('activate', () => {
            const repository = indicator._pendingMuteUndoRepository;
            indicator._pendingMuteUndoRepository = null;
            indicator._repositoryUndoItem.visible = false;
            if (!repository)
                return;
            if (indicator._setRepositoryMembership('muted-repos', repository, false)) {
                indicator._showRepositoryActionStatus(`Unmuted ${repository}`);
                indicator._lastRenderHash = '';
                indicator._renderList();
            } else {
                indicator._showRepositoryActionStatus('Could not unmute repository');
            }
        });
        indicator._repositoryUndoItem.visible = false;
        indicator.menu.addMenuItem(indicator._repositoryUndoItem);

        // Search cached inbox notifications without triggering extra API requests.
        const searchItem = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        indicator._notificationSearchEntry = new St.Entry({
            style_class: 'github-notifier-search',
            hint_text: 'Search notifications…',
            can_focus: true,
            x_expand: true,
        });
        indicator._notificationSearchEntry.accessible_name = 'Search cached notifications';
        indicator._notificationSearchEntry.clutter_text.connect('text-changed', () => {
            indicator._notificationSearchQuery = indicator._notificationSearchEntry.get_text();
            indicator._notificationsPage = 0;
            indicator._lastRenderHash = '';
            indicator._renderList();
        });
        searchItem.add_child(indicator._notificationSearchEntry);
        indicator.menu.addMenuItem(searchItem);

        // sections
        indicator._notifSection = new PopupMenu.PopupMenuSection();
        indicator.menu.addMenuItem(indicator._notifSection);
        indicator._issuesSection = new PopupMenu.PopupMenuSection();
        indicator.menu.addMenuItem(indicator._issuesSection);
        indicator._starsSection = new PopupMenu.PopupMenuSection();
        indicator.menu.addMenuItem(indicator._starsSection);

        indicator.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // footer controls + rate limit
        indicator._footerSection = new PopupMenu.PopupMenuSection();
        indicator.menu.addMenuItem(indicator._footerSection);
        indicator._rateItem = new PopupMenu.PopupMenuItem('', {reactive: false});
        indicator._rateItem.style_class = 'github-notifier-rate';
        indicator._rateItem.label.clutter_text.line_wrap = true;
        indicator.menu.addMenuItem(indicator._rateItem);
        indicator._rateItem.visible = false;

        indicator._updateHero();
        indicator._updateDailyStatsItem();
    }

export function updateRateFooter(indicator) {
        if (!indicator._rateItem) return;
        const parts = [];
        if (indicator._rateLimitResetEpoch > 0)
            parts.push(`Rate limit resets in ${Math.max(1, Math.ceil((indicator._rateLimitResetEpoch - Date.now()/1000)/60))}m`);
        if (indicator._lastFetchedAt)
            parts.push(`updated ${indicator._relativeTime(indicator._lastFetchedAt)}`);
        if (parts.length > 0) {
            indicator._rateItem.label.text = parts.join(' · ');
            indicator._rateItem.visible = true;
        } else {
            indicator._rateItem.visible = false;
        }
    }

export function updateHero(indicator) {
        if (!indicator._heroTitle || !indicator._heroMeta) return;
        indicator._updateDailyStatsItem();
        const username = indicator._settings.get_string('github-username').trim();
        indicator._heroTitle.text = username ? `GitHub · ${username}` : 'GitHub';
        const n = indicator._visibleNotificationItems().length;
        const visibleActivityItems = indicator._visibleActivityItems();
        const issuesPrCount = visibleActivityItems.filter(i => i.kind === 'issue' || i.kind === 'pr').length;
        const starsCount = visibleActivityItems.filter(i => i.kind === 'star').length;
        const parts = [];
        if (indicator._polling) parts.push('Refreshing…');
        else if (n > 0) parts.push(`${n} unread`);
        if (issuesPrCount > 0) parts.push(`${issuesPrCount} issues/PRs`);
        if (starsCount > 0) parts.push(`${starsCount} stars`);
        if (parts.length === 0) {
            const statusText = indicator._statusItem?.label?.text || '';
            if (indicator._statusIsError && /offline|internet|wi-fi|network|unreachable/i.test(statusText)) {
                parts.push(indicator._lastFetchedAt
                    ? `Offline · last updated ${indicator._relativeTime(indicator._lastFetchedAt)}`
                    : 'Offline · no cached data yet');
            } else if (indicator._statusIsError) {
                parts.push('Attention needed');
            } else {
                parts.push('All caught up');
            }
        }
        // also show paused
        if (indicator._paused) parts.unshift('Paused');
        indicator._heroMeta.text = parts.join(' · ');
    }

export function setStatusBanner(indicator, text, kind = 'info') {
        if (!indicator._statusItem) return;
        if (indicator._statusActionItem) {
            indicator._statusAction = getStatusAction(text);
            indicator._statusActionItem.label.text = indicator._statusAction === 'settings'
                ? 'Open Settings'
                : 'Refresh once';
            indicator._statusActionItem.visible = indicator._statusAction !== null;
        }
        indicator._statusItem.remove_style_class_name('github-notifier-banner-error');
        indicator._statusItem.remove_style_class_name('github-notifier-banner-info');
        if (!text) {
            if (indicator._statusItem.visible && indicator.hasMotion()) {
                indicator._ease(indicator._statusItem, {
                    opacity: 0,
                    translation_y: -4,
                    time: 100,
                    mode: Clutter.AnimationMode.EASE_IN_QUAD,
                    onComplete: () => {
                        indicator._statusItem.visible = false;
                        indicator._statusItem.opacity = 255;
                        indicator._statusItem.translation_y = 0;
                    },
                });
            } else {
                indicator._statusItem.visible = false;
                indicator._statusItem.opacity = 255;
                indicator._statusItem.translation_y = 0;
            }
            indicator._statusIsError = false;
            return;
        }
        indicator._statusItem.label.text = text;
        indicator._statusIsError = kind === 'error';
        if (kind === 'error')
            indicator._statusItem.add_style_class_name('github-notifier-banner-error');
        else
            indicator._statusItem.add_style_class_name('github-notifier-banner-info');

        const wasHidden = !indicator._statusItem.visible;
        indicator._statusItem.visible = true;
        if (wasHidden && indicator.hasMotion()) {
            indicator._statusItem.opacity = 0;
            indicator._statusItem.translation_y = -8;
            indicator._ease(indicator._statusItem, {
                opacity: 255,
                translation_y: 0,
                time: 180,
                mode: Clutter.AnimationMode.EASE_OUT_BACK,
            });
        } else {
            indicator._statusItem.opacity = 255;
            indicator._statusItem.translation_y = 0;
        }
    }

export function updatePanel(indicator, maxBadge) {
        const unreadNotifications = indicator._visibleNotificationItems().length;
        const activityItems = indicator._visibleActivityItems().length;
        const unread = unreadNotifications + activityItems;
        indicator._publishNotificationSummary(unreadNotifications, activityItems);
        const prev = indicator._lastUnreadCount ?? 0;
        const alwaysUnlit = indicator._settings.get_boolean('icon-always-unlit');
        if (unread > 0) {
            indicator._label.text = unread > maxBadge ? `${maxBadge}+` : String(unread);
            indicator._label.show();
            if (alwaysUnlit) indicator._label.remove_style_class_name('urgent');
            else indicator._label.add_style_class_name('urgent');
        } else {
            indicator._label.hide();
            indicator._label.remove_style_class_name('urgent');
            indicator._label.scale_x = 1.0;
            indicator._label.scale_y = 1.0;
        }

        // Dim the Octocat itself when "keep icon unlit" is on (even with unread)
        if (indicator._icon) {
            if (alwaysUnlit)
                indicator._icon.add_style_class_name('github-notifier-icon-unlit');
            else
                indicator._icon.remove_style_class_name('github-notifier-icon-unlit');
        }

        // Subtle motion when new items arrive (not on every poll drop)
        if (unread > prev) {
            indicator._animateBadgePop();
            indicator._animateIconPulse();
        }
        indicator._lastUnreadCount = unread;

        if (indicator._statusIsError)
            indicator._setTooltip(indicator, 'GitHub Notifier — attention needed');
        else if (unread > 0)
            indicator._setTooltip(indicator, `GitHub Notifier — ${unread} unread`);
        else
            indicator._setTooltip(indicator, 'GitHub Notifier');

        const hideWhenEmpty = indicator._settings.get_boolean('hide-when-empty');
        indicator.visible = !(hideWhenEmpty && unread === 0 && !indicator._statusIsError);
    }


export function updateDailyStatsItem(indicator) {
    if (!indicator._statsItem)
        return;
    if (!indicator._settings.get_boolean('show-daily-stats')) {
        indicator._statsItem.visible = false;
        return;
    }
    indicator._dailyStats = updateDailyStats(indicator._dailyStats, indicator._localDateKey());
    const totals = getDailyStatsTotals(indicator._dailyStats, indicator._localDateKey());
    indicator._statsItem.label.text = `Today: ${totals.todayNotifications} notifications · ${totals.todayActivity} activity | 7 days: ${totals.weekNotifications} notifications · ${totals.weekActivity} activity`;
    indicator._statsItem.visible = true;
}

export function setActionStatus(indicator, text) {
    const generation = (indicator._actionStatusGeneration || 0) + 1;
    indicator._actionStatusGeneration = generation;
    if (!indicator._actionStatusItem) return generation;
    if (text) {
        indicator._actionStatusItem.label.text = text;
        indicator._actionStatusItem.visible = true;
    } else {
        indicator._actionStatusItem.visible = false;
    }
    return generation;
}


export function showRepositoryActionStatus(indicator, message, undoMuteRepository = null) {
    const generation = ++indicator._repositoryActionStatusGeneration;
    const statusGeneration = setActionStatus(indicator, message);
    indicator._pendingMuteUndoRepository = undoMuteRepository;
    if (indicator._repositoryUndoItem) {
        indicator._repositoryUndoItem.label.text = undoMuteRepository
            ? `Undo mute for ${undoMuteRepository}`
            : 'Undo mute';
        indicator._repositoryUndoItem.visible = Boolean(undoMuteRepository);
    }
    indicator._addTransientTimeout(3, () => {
        if (generation !== indicator._repositoryActionStatusGeneration)
            return GLib.SOURCE_REMOVE;
        if (statusGeneration === indicator._actionStatusGeneration)
            setActionStatus(indicator, '');
        indicator._pendingMuteUndoRepository = null;
        if (indicator._repositoryUndoItem)
            indicator._repositoryUndoItem.visible = false;
        return GLib.SOURCE_REMOVE;
    });
}


// Own menu-open rendering and stop animation when the popup closes.
export function setupMenuLifecycle(indicator) {
            indicator.menu.connect('open-state-changed', (menu, open) => {
                if (open) {
                    GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                        if (indicator._destroyed)
                            return GLib.SOURCE_REMOVE;
                        if (!indicator._menuBuilt) {
                            indicator._buildMenuContent();
                            indicator._menuBuilt = true;
                        }
                        // Force re-render in case data changed while menu was closed
                        indicator._lastRenderHash = '';
                        indicator._animateHeaderEntrance();
                        indicator._renderList();
                        return GLib.SOURCE_REMOVE;
                    });
                } else {
                    indicator._stopRefreshSpin();
                }
            });
    
}


// Construct the panel actor tree and establish its initial accessible label.
export function buildPanelButton(indicator) {
            // --- panel button contents ---
            const box = new St.BoxLayout({style_class: 'panel-status-menu-box'});
            const iconPath = GLib.build_filenamev([indicator._ext.path, 'icons', 'github-symbolic.svg']);
            indicator._icon = new St.Icon({
                gicon: Gio.icon_new_for_string(iconPath),
                style_class: 'system-status-icon',
            });
            indicator._label = new St.Label({
                text: '',
                y_align: Clutter.ActorAlign.CENTER,
                style_class: 'github-notifier-label',
            });
            box.add_child(indicator._icon);
            box.add_child(indicator._label);
            indicator.add_child(box);
            indicator._label.hide();
            indicator._setTooltip(indicator, 'GitHub Notifier');
            
}
