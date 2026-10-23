// Fetch the GitHub inbox while keeping pagination, cache metadata, and toast baselines together.
export async function pollNotifications(indicator, state, maxPages = 3) {
    state.toastedNotificationIds ||= [];
    const isInitialBaseline = !state.notificationBaselineEstablished;
    const toasted = new Set(state.toastedNotificationIds.map(String));
    const items = [];

    let path = '/notifications?per_page=50&participating=false';
    let pagesFetched = 0;

    while (path && pagesFetched < maxPages) {
        const headers = pagesFetched === 0 && state.notificationsLastModified
            ? {'If-Modified-Since': state.notificationsLastModified}
            : {};
        const response = await indicator._apiRequest('GET', path, {headers});
        if (pagesFetched === 0 && response.notModified)
            return indicator._notificationItems.slice();

        const {data, linkHeader, lastModified} = response;
        if (pagesFetched === 0 && lastModified)
            state.notificationsLastModified = lastModified;
        pagesFetched += 1;

        for (const notification of Array.isArray(data) ? data : []) {
            const rawId = String(notification?.id ?? '');
            if (!/^\d{1,20}$/.test(rawId))
                continue;

            const subject = notification.subject && typeof notification.subject === 'object'
                ? notification.subject
                : {};
            const repository = typeof notification.repository?.full_name === 'string'
                ? notification.repository.full_name
                : '';
            const subjectType = typeof subject.type === 'string' ? subject.type : '';
            const kind = indicator._reasonToKind(notification.reason, subjectType);
            items.push({
                id: `notif-${rawId}`,
                rawId,
                title: `${kind}: ${subject.title || 'Notification'}`,
                subtitle: repository,
                url: indicator._subjectHtmlUrl(subject, repository),
                kind: 'notification',
                ts: notification.updated_at,
                // Establish a quiet baseline on first run; existing unread
                // notifications should not all generate desktop toasts.
                isNewToast: !isInitialBaseline && !toasted.has(rawId),
                reasonLabel: kind,
                subjectType,
            });
            toasted.add(rawId);
        }

        const nextUrl = Array.isArray(data) && data.length === 50
            ? indicator._nextPageUrl(linkHeader)
            : null;
        path = nextUrl ? indicator._pathFromAbsoluteUrl(nextUrl) : null;
    }

    state.toastedNotificationIds = Array.from(toasted).slice(-500);
    state.notificationBaselineEstablished = true;
    if (pagesFetched === maxPages && items.length === maxPages * 50) {
        const inboxUrl = `${indicator._webBase()}/notifications`;
        items.push({
            id: `notif-more-${Date.now()}`,
            title: 'More notifications than shown — check GitHub inbox directly',
            subtitle: inboxUrl,
            url: inboxUrl,
            kind: 'notification',
            ts: new Date().toISOString(),
            isNewToast: false,
            reasonLabel: 'more',
            subjectType: '',
        });
    }
    return items;
}
