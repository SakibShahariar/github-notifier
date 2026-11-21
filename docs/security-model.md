# Security and data-handling model

## Previous behavior

Before Secret Service integration, the extension stored the GitHub personal access token in the GSettings key `github-token`, persisted through the user's dconf configuration. The extension did not encrypt that token itself.

## Current behavior

New tokens are stored through libsecret in the user's freedesktop.org Secret Service, commonly provided by GNOME Keyring. Lookup attributes are limited to the application identifier and normalized API host; the token is never included in the label or attributes.

The legacy `github-token` key remains in the schema solely to support migration from existing installations. On lookup, the extension first checks Secret Service. If a legacy token exists and no matching secret is found, it writes the token to Secret Service and clears the legacy setting only after the store operation succeeds. If Secret Service is missing, locked, or unavailable, the legacy setting is preserved and its existing token may continue to be used, with a warning. New tokens are never written to the legacy setting as a fallback.

The token is scoped to the configured API host. Changing the API host selects a separate credential, and the previous host's credential is retained until explicitly removed. A legacy plaintext token is bound to the host configured when it is first loaded; if Secret Service migration is unavailable, the extension refuses to send that legacy token to a different host. Enter a new token for the new host or switch back to the original host. The GitHub username is a display hint and is not a lookup attribute: changing the username does not silently switch credentials. When changing GitHub accounts, replace the token and use **Test connection** to confirm the authenticated identity.

The Account preferences provide a **Remove saved token** action for the currently configured API host. It clears the Secret Service item and any legacy plaintext value only after the Secret Service operation completes. If the service is unavailable, the operation reports an error and does not silently erase the legacy credential.

## Token scopes

A classic personal access token is required for inbox access; GitHub's notifications endpoints do not support fine-grained tokens. Use the minimum scopes for the features you enable:

- **Inbox (`watch-mentions`):** `notifications`.
- **Watching issues/PRs (`watch-issues-prs`):** read access to repository issues. For private repositories this means the `repo` scope; avoid granting it if you only watch public repositories and your setup works without it.
- **Watching stars (`watch-stars`):** read access to repository metadata.
- **Marking read (`mark-read-on-open`, Mark all read):** the matching write access. If GitHub rejects the request, the item stays visible and the failure is reported.

The **Test connection** action calls `GET /user` with the entered token and verifies the authenticated login. Tokens are sent only in the `Authorization` header over HTTPS to the configured API host.

## GitHub API endpoints accessed

All requests go to the configured API host (`api.github.com` by default, or your GitHub Enterprise host and path prefix). The extension never contacts any other host.

| Method | Endpoint | Why |
|---|---|---|
| `GET` | `/notifications?per_page=50&participating=false` | Poll the unread inbox; follows paginated `Link` URLs, validated against the configured origin. |
| `PATCH` | `/notifications/threads/{id}` | Mark a single notification thread read when configured or requested. |
| `PUT` | `/notifications` with `last_read_at` | Mark the whole inbox read. |
| `GET` | `/repos/{owner}/{repo}/issues?state=all&sort=created&direction=desc&per_page=20` | Detect new issues and pull requests in watched repositories (including closed items, to catch issues opened and closed between polls). |
| `GET` | `/repos/{owner}/{repo}` | Read star counts and repository metadata for watched repositories. |
| `GET` | `/user` | Verify the token in **Test connection** only. |

Repository polling uses `ETag`/`If-None-Match` conditional requests where supported, and a `304 Not Modified` response reuses the cached baseline. Rate-limit and retry guidance is read from the `X-RateLimit-Remaining`, `X-RateLimit-Reset`, and `X-Poll-Interval` response headers of these ordinary requests; the extension does not call a separate rate-limit endpoint. Pending changes to notification threads are retried on later polls after connection failures, and a host or credential change discards in-flight results so data from one account is not committed under another.

## Data stored locally

- **Credential:** the token in Secret Service, keyed by application id and normalized API host. See [Current behavior](#current-behavior) for the legacy plaintext migration path.
- **`last-state` GSettings key:** an internal JSON cache. It holds notification ids already toasted, `Last-Modified`/`ETag` validators, per-repository issue/star baselines (last seen issue number, star count, ETags), the visible notification and activity item list (title, repository, URL, kind, timestamp, reason), fetch time, local daily counts, and an account-scope hash. It is used to avoid replaying alerts and to survive restarts. Clear it with `dconf reset -f /org/gnome/shell/extensions/github-notifier/` to forget baselines.
- **`notification-summary` GSettings key:** a versioned snapshot of visible counts only, intended for companion extensions. It contains no token, username, repository name, notification text, or URL. See the [companion integration API](user-guide.md#companion-integration-api).
- **Preferences:** API host, username, watched/muted repositories, poll interval, category filters, quiet-hours settings, and display toggles, all in GSettings/dconf.
- **Theme cache:** `~/.cache/github-notifier-matugen.css`, generated from the local Matugen palette. It contains only color values, no credential or API data.

No notification content or repository data is sent anywhere except to and from the configured GitHub API host.

## Failure and recovery behavior

- **No token stored:** the extension asks the user to add a token in Settings.
- **Secret Service missing or unavailable with a legacy token:** preserve and continue using the legacy token where possible; report that migration needs attention.
- **Secret Service unavailable with no legacy token:** do not issue authenticated requests; show an actionable token/keyring status.
- **Stale Secret Service session:** after a failed in-process lookup, disconnect libsecret's cached default proxy and retry once. If that still fails, read the credential through a short-lived `secret-tool` process, which gets a fresh D-Bus connection and cannot inherit the stale session. This keeps Secret Service as the primary store; plaintext is used only if all keyring paths fail.
- **Repeated credential failures:** a failed token retry does not re-enter polling immediately. The next attempt waits at least the configured poll interval (minimum 60 seconds), with the remaining time shown in the status banner. An explicit refresh bypasses that cooldown.
- **Store failure while saving a new token:** retain the value in the preferences entry for retry, report the error, and do not write it to GSettings.
- **Legacy cleanup failure after a successful store or removal:** report the partial result clearly and retain the legacy setting rather than claiming it was cleared.
- **Unscoped legacy token during a host-specific save/removal:** retain it because its original host is unknown; first load binds it to the configured host before host-scoped migration or cleanup can occur.
- **Legacy migration failure:** keep the old setting and do not claim migration succeeded.
- **Host change:** look up a separate credential for the new API host. Existing host-specific items remain available.
- **Username change:** the credential remains unchanged. The user should save the token belonging to the intended account and verify it with **Test connection**.
- **Removal/reset:** remove the current host's secret and then clear the legacy setting. If Secret Service cannot confirm the operation, preserve the legacy setting.

## Remaining verification

The implementation uses libsecret's asynchronous GObject API so Secret Service operations do not synchronously block GNOME Shell or the preferences UI. CI can validate syntax, schema, and source-level migration/error-path tests, but it cannot prove that a real GNOME Keyring session is unlocked or that a prompt behaves correctly. Live testing in a GNOME session remains required before claiming complete runtime verification.


## Browser-link validation

Links opened from notification and activity rows are validated before calling the desktop URI handler. The URL must use HTTPS, contain no embedded username/password, and match the configured GitHub.com or GitHub Enterprise web origin and base path. Enterprise path prefixes are respected, so a host configured below a subpath cannot open a similarly prefixed but unrelated path (for example, `/enterprise-evil`). Invalid or cross-host links are rejected and surfaced as an actionable status rather than opened.

This is a defense-in-depth check for cached/API-provided URLs; it does not replace the browser's own security controls or guarantee that a trusted GitHub page itself is safe.

Notification actions that mark items read use only numeric thread ids taken from the notification payload, and the configured host decides where those requests go. Rate-limit values come from response headers that are parsed with bounds and used only to delay later polls and display a status message; they are never treated as instructions to contact another host.

## Threat model

This section describes what the extension protects against and what it does not.

- **Token leakage.** Tokens are never placed in URLs, HTTP headers other than `Authorization`, Secret Service labels or attributes, the desktop notification summary, or log messages. The API host is validated before any credential is bound or sent, so a stale or manually edited invalid host cannot redirect a legacy token to another host. All API traffic is HTTPS. A legacy plaintext token may exist in dconf when Secret Service migration has not succeeded; this is the main residual exposure — dconf is readable by the local user's processes. Prefer an unlocked keyring so migration can complete.
- **Malicious repository names and content.** Repository entries must match `owner/repo` before being polled or used in a URL, and the path segment is URL-encoded. Repository names and notification text from the API are treated as untrusted strings: rendered as plain text in `St.Label` (never as markup), and truncated for display and accessible names. Notification links are validated before being handed to the desktop opener as described above.
- **Untrusted API responses.** JSON payloads are type-checked before use; response arrays that are not arrays are ignored, thread ids must be numeric, ETag values must match an expected format, and malformed cached state is discarded rather than trusted. Poll results are bound to the account/host scope they were fetched under; if the host or credential changes while requests are in flight, those results are dropped rather than committed under the new account. Validation is defensive, not a sandbox: a compromised GitHub account, a malicious Enterprise server, or a local process running as your user is outside what the extension can protect against.

## References

- [freedesktop.org Secret Service API](https://specifications.freedesktop.org/secret-service/latest/)
- [GNOME libsecret documentation](https://gnome.pages.gitlab.gnome.org/libsecret/)
- [libsecret JavaScript examples](https://gnome.pages.gitlab.gnome.org/libsecret/libsecret-js-examples.html)
