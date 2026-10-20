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
    return [command, 'view', number, '--repo', repository];
}
