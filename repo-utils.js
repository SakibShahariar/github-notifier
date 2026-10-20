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
