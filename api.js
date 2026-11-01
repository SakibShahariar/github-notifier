import GLib from 'gi://GLib';
import Soup from 'gi://Soup';
import {parseGitHubPollInterval, parseRateLimitResetEpoch, parseRetryAfterEpoch} from './repo-utils.js';

// HTTP request and GitHub rate-limit handling shared by the indicator.
export class ApiError extends Error {
    constructor(message, status) {
        super(message);
        this.status = status;
    }
}

/** Execute one GitHub API request, including a single transient network retry. */
export async function apiRequest(indicator, method, path, {body = null, headers = {}} = {}) {
        const requestSequence = (indicator._apiRequestSequence ?? 0) + 1;
        indicator._apiRequestSequence = requestSequence;
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
        const responseMetadataIsCurrent = requestScopeIsCurrent &&
            requestSequence >= (indicator._apiMetadataSequence ?? 0);
        if (responseMetadataIsCurrent)
            indicator._apiMetadataSequence = requestSequence;
        const remaining = msg.response_headers.get_one('X-RateLimit-Remaining');
        const reset = msg.response_headers.get_one('X-RateLimit-Reset');
        const retryAfter = msg.response_headers.get_one('Retry-After');
        const pollInterval = msg.response_headers.get_one('X-Poll-Interval');
        const rateLimitResetEpoch = parseRateLimitResetEpoch(reset);
        const nowEpoch = Math.floor(Date.now() / 1000);
        if (responseMetadataIsCurrent && method === 'GET' && path.startsWith('/notifications') && pollInterval) {
            const parsedInterval = parseGitHubPollInterval(pollInterval);
            if (parsedInterval !== null)
                indicator._serverPollIntervalSeconds = parsedInterval;
        }
        if (responseMetadataIsCurrent && retryAfter) {
            const retryEpoch = parseRetryAfterEpoch(retryAfter);
            if (retryEpoch !== null)
                indicator._retryAfterEpoch = Math.max(indicator._retryAfterEpoch, retryEpoch);
        }
        if (responseMetadataIsCurrent && remaining === '0' && rateLimitResetEpoch !== null)
            indicator._rateLimitResetEpoch = rateLimitResetEpoch;
        const hasFutureRateLimitReset = remaining === '0' && rateLimitResetEpoch !== null && rateLimitResetEpoch > nowEpoch;
        if (responseMetadataIsCurrent && (status === 403 || status === 429) && !retryAfter && !hasFutureRateLimitReset)
            indicator._retryAfterEpoch = Math.max(indicator._retryAfterEpoch, nowEpoch + 60);
        const hasRemainingQuota = typeof remaining === 'string' && /^\\d+$/.test(remaining.trim()) && Number(remaining) > 0;
        if (responseMetadataIsCurrent && status >= 200 && status < 300 && hasRemainingQuota) {
            indicator._rateLimitResetEpoch = 0;
            indicator._retryAfterEpoch = 0;
        }

        if (status === 304)
            return {data: null, linkHeader: msg.response_headers.get_one('Link'), lastModified: msg.response_headers.get_one('Last-Modified'), etag: msg.response_headers.get_one('ETag'), notModified: true};
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
        return {data, linkHeader, lastModified, etag: msg.response_headers.get_one('ETag'), notModified: false};
}


export function buildMessage(indicator, method, uri, token, body, headers = {}) {
        const msg = new Soup.Message({method, uri});
        msg.request_headers.append('Accept', 'application/vnd.github+json');
        msg.request_headers.append('X-GitHub-Api-Version', '2022-11-28');
        msg.request_headers.append('User-Agent', 'gnome-shell-github-notifier');
        if (token)
            msg.request_headers.append('Authorization', `Bearer ${token}`);
        for (const [name, value] of Object.entries(headers))
            msg.request_headers.append(name, value);
        if (body !== null) {
            const bodyBytes = new TextEncoder().encode(JSON.stringify(body));
            msg.set_request_body_from_bytes('application/json', new GLib.Bytes(bodyBytes));
        }
        return msg;
    }

export async function sendOnce(indicator, method, uri, token, body, headers = {}, cancellable = null) {
        const msg = indicator._buildMessage(method, uri, token, body, headers);
        const bytes = await indicator._session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, cancellable);
        return {bytes, msg};
    }