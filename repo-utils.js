// Shared repository-name validation for preferences and runtime code.
const REPO_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?\/[A-Za-z0-9._-]+$/;

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
