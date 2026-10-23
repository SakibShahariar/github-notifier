# Token storage security review

## Previous behavior

Before Secret Service integration, the extension stored the GitHub personal access token in the GSettings key `github-token`, persisted through the user's dconf configuration. The extension did not encrypt that token itself.

## Current behavior

New tokens are stored through libsecret in the user's freedesktop.org Secret Service, commonly provided by GNOME Keyring. Lookup attributes are limited to the application identifier and normalized API host; the token is never included in the label or attributes.

The legacy `github-token` key remains in the schema solely to support migration from existing installations. On lookup, the extension first checks Secret Service. If a legacy token exists and no matching secret is found, it writes the token to Secret Service and clears the legacy setting only after the store operation succeeds. If Secret Service is missing, locked, or unavailable, the legacy setting is preserved and its existing token may continue to be used, with a warning. New tokens are never written to the legacy setting as a fallback.

The token is scoped to the configured API host. Changing the API host selects a separate credential, and the previous host's credential is retained until explicitly removed. A legacy plaintext token is bound to the host configured when it is first loaded; if Secret Service migration is unavailable, the extension refuses to send that legacy token to a different host. Enter a new token for the new host or switch back to the original host. The GitHub username is a display hint and is not a lookup attribute: changing the username does not silently switch credentials. When changing GitHub accounts, replace the token and use **Test connection** to confirm the authenticated identity.

The Account preferences provide a **Remove saved token** action for the currently configured API host. It clears the Secret Service item and any legacy plaintext value only after the Secret Service operation completes. If the service is unavailable, the operation reports an error and does not silently erase the legacy credential.

## Failure and recovery behavior

- **No token stored:** the extension asks the user to add a token in Settings.
- **Secret Service missing or unavailable with a legacy token:** preserve and continue using the legacy token where possible; report that migration needs attention.
- **Secret Service unavailable with no legacy token:** do not issue authenticated requests; show an actionable token/keyring status.
- **Store failure while saving a new token:** retain the value in the preferences entry for retry, report the error, and do not write it to GSettings.
- **Legacy cleanup failure after a successful store or removal:** report the partial result clearly and retain the legacy setting rather than claiming it was cleared.
- **Unscoped legacy token during a host-specific save/removal:** retain it because its original host is unknown; first load binds it to the configured host before host-scoped migration or cleanup can occur.
- **Legacy migration failure:** keep the old setting and do not claim migration succeeded.
- **Host change:** look up a separate credential for the new API host. Existing host-specific items remain available.
- **Username change:** the credential remains unchanged. The user should save the token belonging to the intended account and verify it with **Test connection**.
- **Removal/reset:** remove the current host's secret and then clear the legacy setting. If Secret Service cannot confirm the operation, preserve the legacy setting.

## Remaining verification

The implementation uses libsecret's asynchronous GObject API so Secret Service operations do not synchronously block GNOME Shell or the preferences UI. CI can validate syntax, schema, and source-level migration/error-path tests, but it cannot prove that a real GNOME Keyring session is unlocked or that a prompt behaves correctly. Live testing in a GNOME session remains required before claiming complete runtime verification.

## References

- [freedesktop.org Secret Service API](https://specifications.freedesktop.org/secret-service/latest/)
- [GNOME libsecret documentation](https://gnome.pages.gitlab.gnome.org/libsecret/)
- [libsecret JavaScript examples](https://gnome.pages.gitlab.gnome.org/libsecret/libsecret-js-examples.html)
