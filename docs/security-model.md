# Token storage security review

## Current behavior

The extension stores the GitHub personal access token in the GSettings key `github-token`. On GNOME this setting is persisted through the user's dconf configuration. The extension does not encrypt the token itself.

This is not, by itself, evidence of a remotely exploitable vulnerability. Normal Unix user permissions still apply to configuration files. However, a plain-text setting is not a dedicated secret vault: other software running as the same user, configuration exports/backups, or a compromised user session may expose it. The token's effective permissions also determine the impact of exposure, so use the narrowest token permissions that support the features you enable.

## Secret Service evaluation

The freedesktop.org Secret Service API is a better fit for credential storage. GNOME Keyring and compatible services can store a secret in the user's login session, typically encrypted at rest and optionally locked until the collection is unlocked. The extension can identify the item using non-secret attributes such as the API host and account label.

References:

- [Secret Service API](https://specifications.freedesktop.org/secret-service/latest/)
- [GNOME libsecret documentation](https://gnome.pages.gitlab.gnome.org/libsecret/)
- [libsecret password-storage examples](https://github.com/GNOME/libsecret/blob/main/docs/reference/libsecret/libsecret-c-examples.md)

Secret Service is a meaningful improvement for stored credentials, but it is not protection against every same-user threat. A process that can access an unlocked secret service may still request secrets, and lookup attributes must not contain the token itself.

## Recommended migration design

A future implementation should:

1. Store the token in Secret Service using a stable schema and non-secret lookup attributes (for example, extension identifier and API host).
2. Read the existing GSettings token only as a migration source. Clear it only after Secret Service confirms that the new value was stored successfully.
3. Preserve the existing token if the secret store is unavailable or locked; never silently discard credentials.
4. Provide a clear settings error when credentials cannot be retrieved. Do not fall back to writing a new token in plain-text GSettings without an explicit, documented user choice.
5. Keep non-secret settings such as username, API host, polling interval, and watched repositories in GSettings.
6. Test first-run setup, existing-token migration, changed tokens/hosts, locked or missing secret service, failed writes, and removal/reset behavior.

## Current status

**Secret Service integration is not implemented yet.** Until it is, the token remains in GSettings/dconf and should be treated as unencrypted by the extension. The extension must not describe the current storage as secure or encrypted.
