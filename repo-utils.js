// Shared repository-name validation for preferences and runtime code.
const REPO_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?\/[A-Za-z0-9._-]+$/;


/**
 * Build a safe HTTPS API base from the user-configured host.
 * Accept a bare hostname (GitHub.com or Enterprise) and optional deployment
 * path, but never credentials, a scheme, query, or fragment.
 */
export function getApiBase(host) {
    if (typeof host !== 'string')
        throw new TypeError('API host must be a hostname, optionally followed by an Enterprise API path');
    let value = host.trim();
    while (value.endsWith('/'))
        value = value.slice(0, -1);
    if (!value || value.includes('://') ||
        [' ', '\t', '\n', '\r', '?', '#', '\\'].some(character => value.includes(character)) ||
        value.split('/').some(part => {
            // Reject encoded separators and repeatedly decoded dot segments.
            // Some proxies and Enterprise installations decode paths more than once.
            if (/%(?:2f|5c)/i.test(part))
                return true;
            try {
                let decoded = part;
                for (let i = 0; i < 4; i++) {
                    const next = decodeURIComponent(decoded);
                    if (next === '.' || next === '..' || next.includes('/') || next.includes('\\'))
                        return true;
                    if (next === decoded)
                        return false;
                    decoded = next;
                }
                // Avoid ambiguous over-encoded path segments.
                return /%[0-9a-f]{2}/i.test(decoded);
            } catch (_error) {
                return true;
            }
        }))
        throw new TypeError('Enter a hostname such as api.github.com or git.example.com/enterprise/api/v3');

    let parsed;
    try {
        parsed = new URL('https://' + value);
    } catch (_error) {
        throw new TypeError('Invalid API host; use a hostname with an optional Enterprise API path');
    }
    if (parsed.protocol !== 'https:' || !parsed.hostname ||
        parsed.username || parsed.password || parsed.search || parsed.hash ||
        parsed.pathname.split('/').some(part => part === '.' || part === '..'))
        throw new TypeError('Invalid API host; credentials, query strings, fragments, and URL schemes are not allowed');

    if (parsed.hostname.toLowerCase() === 'api.github.com' && parsed.pathname === '/')
        return 'https://api.github.com';
    if (parsed.pathname === '/')
        return 'https://' + parsed.host + '/api/v3';
    let path = parsed.pathname;
    while (path.endsWith('/'))
        path = path.slice(0, -1);
    return 'https://' + parsed.host + path;
}

export function isValidRepository(value) {
    return typeof value === 'string' && REPO_RE.test(value);
}

export function getNotificationCategory(item) {
    const reason = String(item?.notificationReason || item?.reasonLabel || '')
        .trim().toLowerCase().replaceAll(' ', '_');
    if (reason === 'mention' || reason === 'team_mention')
        return 'mentions';
    if (['review_requested', 'requested_reviewer', 'approval_requested', 'review_request_removed'].includes(reason))
        return 'reviews';
    if (reason === 'assign' || reason === 'assigned')
        return 'assignments';
    if (reason === 'ci_activity' || ['CheckSuite', 'WorkflowRun'].includes(item?.subjectType))
        return 'checks';
    if (['author', 'comment', 'manual', 'state_change', 'subscribed', 'new_comment',
        'update_on_your_thread', 'state_changed', 'activity'].includes(reason))
        return 'conversation';
    return 'other';
}

export function parseRepositoryList(value) {
    if (typeof value !== 'string')
        return [];
    return Array.from(new Set(
        value.split(',').map(repository => repository.trim())
            .filter(repository => isValidRepository(repository))
            .map(repository => repository.toLowerCase())
    ));
}

/**
 * Deduplicate watched entries case-insensitively while preserving invalid values
 * so the poller can report them to the user instead of silently dropping them.
 */
export function deduplicateRepositoryEntries(value) {
    if (typeof value !== 'string')
        return [];
    const seen = new Set();
    const repositories = [];
    for (const entry of value.split(',')) {
        const repository = entry.trim();
        if (!repository)
            continue;
        const key = repository.toLowerCase();
        if (seen.has(key))
            continue;
        seen.add(key);
        repositories.push(repository);
    }
    return repositories;
}

export function isRepositoryMuted(repository, mutedRepositories) {
    return typeof repository === 'string' &&
        mutedRepositories.has(repository.trim().toLowerCase());
}

export function getGitHubCliArguments(item) {
    if (!item || typeof item.url !== 'string' || typeof item.subtitle !== 'string')
        return null;

    const repository = item.subtitle.trim();
    if (!isValidRepository(repository))
        return null;

    let url;
    try {
        url = new URL(item.url);
    } catch (_error) {
        return null;
    }

    const match = url.pathname.match(/\/(issues|pull)\/(\d+)(?:\/|$)/i);
    if (!match)
        return null;

    const [, resource, number] = match;
    const command = resource.toLowerCase() === 'pull' || item.kind === 'pr'
        ? 'pr'
        : 'issue';
    // GitHub CLI accepts [HOST/]OWNER/REPO for Enterprise instances.
    const repoTarget = url.hostname.toLowerCase() === 'github.com'
        ? repository
        : `${url.hostname}/${repository}`;
    return [command, 'view', number, '--repo', repoTarget];
}

function clockTimeToMinutes(value) {
    if (typeof value !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value))

        return null;
    const parts = value.split(':').map(Number);
    return parts[0] * 60 + parts[1];
}


function isValidDateKey(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value))
        return false;
    const parsed = new Date(`${value}T00:00:00Z`);
    return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/** Track only local, daily event counts; retain the current day and previous six days. */
export function updateDailyStats(stats, dateKey, notifications = 0, activity = 0) {
    if (!isValidDateKey(dateKey))
        throw new TypeError('dateKey must be a valid YYYY-MM-DD date');
    const validCount = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;
    const cutoffDate = new Date(`${dateKey}T00:00:00Z`);
    cutoffDate.setUTCDate(cutoffDate.getUTCDate() - 6);
    const cutoff = cutoffDate.toISOString().slice(0, 10);
    const result = {};
    if (stats && typeof stats === 'object' && !Array.isArray(stats)) {
        for (const [key, value] of Object.entries(stats)) {
            if (!isValidDateKey(key) || key < cutoff || key > dateKey ||
                !value || typeof value !== 'object' || Array.isArray(value))
                continue;
            result[key] = {
                notifications: validCount(value.notifications),
                activity: validCount(value.activity),
            };
        }
    }
    const today = result[dateKey] || {notifications: 0, activity: 0};
    today.notifications += validCount(notifications);
    today.activity += validCount(activity);
    result[dateKey] = today;
    return result;
}

export function getDailyStatsTotals(stats, dateKey) {
    if (!isValidDateKey(dateKey))
        return {todayNotifications: 0, todayActivity: 0, weekNotifications: 0, weekActivity: 0};
    const normalized = updateDailyStats(stats, dateKey);
    let weekNotifications = 0;
    let weekActivity = 0;
    for (const value of Object.values(normalized)) {
        weekNotifications += value.notifications;
        weekActivity += value.activity;
    }
    const today = normalized[dateKey] || {notifications: 0, activity: 0};
    return {todayNotifications: today.notifications, todayActivity: today.activity,
        weekNotifications, weekActivity};
}

export function createNotificationSummary(unreadNotifications, activityItems, enabled = true, updatedAt = new Date().toISOString()) {
    const unread = Number.isSafeInteger(unreadNotifications) && unreadNotifications >= 0 ? unreadNotifications : 0;
    const activity = Number.isSafeInteger(activityItems) && activityItems >= 0 ? activityItems : 0;
    return {
        version: 1,
        enabled: enabled === true,
        unreadNotifications: unread,
        activityItems: activity,
        totalCount: unread + activity,
        updatedAt: typeof updatedAt === 'string' ? updatedAt : new Date().toISOString(),
    };
}

export function isValidClockTime(value) {
    return clockTimeToMinutes(value) !== null;
}

/** Start is inclusive and end is exclusive. Equal endpoints disable the interval. */
export function shouldSuppressDesktopNotifications(quietHoursActive, showBanners) {
    return quietHoursActive === true || showBanners === false;
}

export function isWithinQuietHours(now, start, end) {
    const startMinutes = clockTimeToMinutes(start);
    const endMinutes = clockTimeToMinutes(end);
    if (startMinutes === null || endMinutes === null || startMinutes === endMinutes ||
        !(now instanceof Date) || Number.isNaN(now.getTime()))
        return false;
    const currentMinutes = now.getHours() * 60 + now.getMinutes();
    if (startMinutes < endMinutes)
        return currentMinutes >= startMinutes && currentMinutes < endMinutes;
    return currentMinutes >= startMinutes || currentMinutes < endMinutes;
}

/**
 * Convert an absolute pagination URL into a path relative to the configured
 * API base. Enterprise Link headers include the deployment prefix (for
 * example /api/v3), which must not be appended twice by _apiRequest().
 * Reject links outside the configured HTTPS origin/base path.
 */
export function getApiPathFromAbsoluteUrl(apiBase, absoluteUrl) {
    if (typeof apiBase !== 'string' || typeof absoluteUrl !== 'string')
        return null;

    try {
        const base = new URL(apiBase);
        const link = new URL(absoluteUrl);
        if (base.protocol !== 'https:' || link.protocol !== base.protocol ||
            link.origin !== base.origin)
            return null;

        const basePath = base.pathname.replace(/\/+$/, '');
        const linkPath = link.pathname;
        let path;
        if (!basePath || basePath === '/') {
            path = linkPath;
        } else if (linkPath === basePath) {
            path = '/';
        } else if (linkPath.startsWith(basePath + '/')) {
            path = linkPath.slice(basePath.length);
        } else {
            return null;
        }

        return (path || '/') + link.search;
    } catch (_error) {
        return null;
    }
}


/** Return a GNOME/Adwaita symbolic icon for a notification or activity item. */
export function getNotificationIconName(item) {
    if (item?.kind === 'notification') {
        const type = item.subjectType || '';
        if (type === 'PullRequest') return 'insert-link-symbolic';
        if (type === 'Issue') return 'chat-message-new-symbolic';
        if (type === 'Commit') return 'document-edit-symbolic';
        if (type === 'Release') return 'tag-symbolic';
        if (type === 'CheckSuite') return 'emblem-ok-symbolic';
        if (type === 'WorkflowRun') return 'media-playback-start-symbolic';
        if (type === 'Discussion') return 'chat-bubbles-symbolic';
        return 'mail-unread-symbolic';
    }
    if (item?.kind === 'pr') return 'insert-link-symbolic';
    if (item?.kind === 'issue') return 'chat-message-new-symbolic';
    if (item?.kind === 'star') return 'starred-symbolic';
    return 'mail-unread-symbolic';
}


/** Format a timestamp as a compact relative age, using an injectable clock for tests. */
export function formatRelativeTime(value, now = Date.now()) {
    const then = new Date(String(value || '')).getTime();
    if (!Number.isFinite(then)) return '';
    const seconds = Math.max(0, Math.floor((now - then) / 1000));
    if (seconds < 60) return 'just now';
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
    if (seconds < 2592000) return `${Math.floor(seconds / 86400)}d ago`;
    return `${Math.floor(seconds / 2592000)}mo ago`;
}


/** Compose the secondary text shown under a notification/activity title. */
export function getItemDetail(item, relativeTime = '') {
    const repository = item?.subtitle || '';
    const time = relativeTime || '';
    if (item?.kind === 'notification') {
        const reason = item.reasonLabel || item.kind;
        return `${repository} · ${reason} · ${time}`.trim();
    }
    if (item?.kind === 'pr') return `${repository} · PR · ${time}`;
    if (item?.kind === 'issue') return `${repository} · issue · ${time}`;
    if (item?.kind === 'star') return `${repository} · star · ${time}`;
    return `${repository} · ${time}`;
}


/** Map GitHub notification reasons and subject types to concise display labels. */
export function getNotificationReasonLabel(reason, subjectType) {
    const typeLabels = {
        Release: 'New release',
        Commit: 'New commit',
        CheckSuite: 'CI run',
        WorkflowRun: 'CI run',
    };
    if (typeLabels[subjectType])
        return typeLabels[subjectType];

    const labels = {
        mention: 'Mention',
        review_requested: 'Review requested',
        assign: 'Assigned',
        author: 'Update on your thread',
        comment: 'New comment',
        state_change: 'State changed',
        subscribed: 'Activity',
        team_mention: 'Team mention',
    };
    return labels[reason] || 'Notification';
}


/** Format a Date as a local-calendar YYYY-MM-DD key (not a UTC date). */
export function formatLocalDateKey(date = new Date()) {
    return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-');
}


/** Update a comma-separated repository setting without duplicates or invalid names. */
export function setRepositoryMembership(settings, settingKey, repository, shouldContain) {
    if (!isValidRepository(repository))
        return false;

    const normalized = repository.trim().toLowerCase();
    const repositories = parseRepositoryList(settings.get_string(settingKey));
    const next = shouldContain
        ? Array.from(new Set([...repositories, normalized]))
        : repositories.filter(value => value !== normalized);
    const serialized = next.join(', ');
    if (settings.get_string(settingKey) !== serialized && !settings.set_string(settingKey, serialized))
        return false;
    return true;
}


/** Resolve a GitHub Enterprise API host to its browser-facing base URL. */
export function getWebBase(configuredHost = '') {
    const host = String(configuredHost || '').trim() || 'api.github.com';
    if (host === 'api.github.com')
        return 'https://github.com';
    let webHost = host.replace(/\/+$/, '');
    if (webHost.endsWith('/api/v3'))
        webHost = webHost.slice(0, -'/api/v3'.length);
    return `https://${webHost}`;
}

/** Convert API subject URLs into browser URLs for GitHub.com and GHES deployments. */
export function getSubjectHtmlUrl(subject, repoFullName, apiBase, webBase) {
    const repoUrl = `${webBase}/${repoFullName}`;
    if (!subject?.url)
        return repoUrl;
    const apiReposPrefix = `${apiBase}/repos`;
    const escaped = apiReposPrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const url = subject.url.replace(new RegExp(escaped, 'i'), webBase);
    switch (subject.type) {
        case 'Issue':
        case 'Discussion':
            return url;
        case 'PullRequest':
            return url.replace(/\/pulls\//i, '/pull/');
        case 'Commit':
            return url.replace(/\/commits\//i, '/commit/');
        case 'Release':
            return `${repoUrl}/releases`;
        case 'CheckSuite':
        case 'WorkflowRun':
            return `${repoUrl}/actions`;
        default:
            return repoUrl;
    }
}


/** Map actionable status messages to one primary follow-up action. */
export function getStatusAction(message) {
    const text = typeof message === 'string' ? message : '';
    if (/add a github token|token unavailable|invalid token|check settings|check token permissions|secret service/i.test(text))
        return 'settings';
    if (/quiet hours|metered connection/i.test(text))
        return 'refresh';
    return null;
}


/** Filter cached notifications by enabled categories and muted repository names. */
export function filterVisibleNotificationItems(items, enabledCategories, mutedRepositories) {
    if (!Array.isArray(items))
        return [];
    const enabled = enabledCategories instanceof Set
        ? enabledCategories
        : new Set(Array.isArray(enabledCategories) ? enabledCategories : []);
    return items.filter(item => item && enabled.has(getNotificationCategory(item)) &&
        !isRepositoryMuted(item.subtitle, mutedRepositories));
}

/** Filter cached activity rows using the same repository mute policy as notifications. */
export function filterVisibleActivityItems(items, mutedRepositories) {
    if (!Array.isArray(items))
        return [];
    return items.filter(item => item && !isRepositoryMuted(item.subtitle, mutedRepositories));
}
