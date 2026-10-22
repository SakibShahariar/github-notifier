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
            try {
                const decoded = decodeURIComponent(part);
                return decoded === '.' || decoded === '..';
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
