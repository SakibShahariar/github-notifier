// HTTP request and GitHub rate-limit handling shared by the indicator.
export class ApiError extends Error {
    constructor(message, status) {
        super(message);
        this.status = status;
    }
}

/** Execute one GitHub API request, including a single transient network retry. */
export async function apiRequest(indicator, method, path, {body = null, headers = {}} = {}) {
        const requestScope = indicator._stateScope();
        const cancellable = indicator._polling ? indicator._pollCancellable : null;
        const token = indicator._token;
        const uri = GLib.Uri.parse(`${indicator._apiBase()}${path}`, GLib.UriFlags.NONE);

        let bytes, msg;
        try {
            ({bytes, msg} = await indicator._sendOnce(method, uri, token, body, headers, cancellable));
        } catch (firstError) {
            if (indicator._destroyed || (cancellable && cancellable.is_cancelled()))
                throw new ApiError(`Network error: ${firstError.message}`, 0);
            await indicator._sleep(1000);
            if (indicator._destroyed || (cancellable && cancellable.is_cancelled()))
                throw new ApiError(`Network error: ${firstError.message}`, 0);
            try {
                ({bytes, msg} = await indicator._sendOnce(method, uri, token, body, headers, cancellable));
            } catch (secondError) {
                throw new ApiError(`Network error: ${secondError.message}`, 0);
            }
        }

        const status = msg.get_status();
        // Ignore throttling metadata from a request that completed after the
        // user switched accounts or API hosts.
        const requestScopeIsCurrent = requestScope === indicator._stateScope();
        const remaining = msg.response_headers.get_one('X-RateLimit-Remaining');
        const reset = msg.response_headers.get_one('X-RateLimit-Reset');
        const retryAfter = msg.response_headers.get_one('Retry-After');
        const pollInterval = msg.response_headers.get_one('X-Poll-Interval');
        if (requestScopeIsCurrent && method === 'GET' && path.startsWith('/notifications') && pollInterval) {
            const parsedInterval = Number.parseInt(pollInterval, 10);
            if (Number.isFinite(parsedInterval) && parsedInterval >= 60)
                indicator._serverPollIntervalSeconds = parsedInterval;
        }
        if (requestScopeIsCurrent && retryAfter) {
            const seconds = Number.parseInt(retryAfter, 10);
            const retryDate = Number.isFinite(seconds) && String(seconds) === retryAfter.trim()
                ? Date.now() / 1000 + Math.max(0, seconds)
                : Date.parse(retryAfter) / 1000;
            if (Number.isFinite(retryDate))
                indicator._retryAfterEpoch = Math.max(indicator._retryAfterEpoch, Math.ceil(retryDate));
        }
        if (requestScopeIsCurrent && remaining === '0' && reset)
            indicator._rateLimitResetEpoch = parseInt(reset, 10);
        if (requestScopeIsCurrent && (status === 403 || status === 429) && !retryAfter && !(remaining === '0' && reset))
            indicator._retryAfterEpoch = Math.max(indicator._retryAfterEpoch, Math.floor(Date.now() / 1000) + 60);
        if (requestScopeIsCurrent && status >= 200 && status < 300) {
            indicator._rateLimitResetEpoch = 0;
            indicator._retryAfterEpoch = 0;
        }

        if (status === 304)
            return {data: null, linkHeader: msg.response_headers.get_one('Link'), lastModified: msg.response_headers.get_one('Last-Modified'), notModified: true};
        if (status === 401)
            throw new ApiError('Invalid or expired token', 401);
        if ((status === 403 && remaining === '0') || status === 429)
            throw new ApiError('Rate limited by GitHub API', status);
        if (status === 404)
            throw new ApiError(`Not found: ${path}`, 404);
        if (status < 200 || status >= 300)
            throw new ApiError(`GitHub API ${path} returned ${status}`, status);

        const linkHeader = msg.response_headers.get_one('Link');
        const lastModified = msg.response_headers.get_one('Last-Modified');
        const data = bytes.get_size() > 0
            ? JSON.parse(new TextDecoder('utf-8').decode(bytes.get_data()))
            : null;
        return {data, linkHeader, lastModified, notModified: false};
}
