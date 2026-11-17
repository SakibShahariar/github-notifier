import {getApiBase} from './repo-utils.js';

const APPLICATION_ID = 'github-notifier@SakibShahariar';
const SCHEMA_NAME = 'org.gnome.shell.extensions.github-notifier';
const TOKEN_LABEL = 'GitHub Notifier personal access token';
// How long to wait for a Secret Service lookup to complete before treating it
// as unavailable. The GJS async callback can fail to fire in the shell's DBus
// context (keyring not reachable from gnome-shell's session), which would
// otherwise hang the poll loop forever.
const SECRET_LOOKUP_TIMEOUT_MS = 4000;

/**
 * Retry a Secret Service lookup once after dropping libsecret's cached default
 * proxy. That proxy is shared process-wide and caches its D-Bus session, so a
 * long-lived process such as GNOME Shell can keep referencing a session that
 * the daemon has already closed (for example, oo7-daemon cleaning up an idle
 * session). Disconnecting makes the next lookup open a fresh session.
 */
export async function lookupWithSessionRecovery(lookup, disconnect, host) {
    try {
        return await lookup(host);
    } catch (error) {
        if (typeof disconnect !== 'function')
            throw error;
        disconnect();
        return lookup(host);
    }
}

export function normalizeSecretHost(host) {
    const value = String(host || 'api.github.com').trim().replace(/\/+$/, '') || 'api.github.com';
    const match = value.match(/^([^/]+)(\/.*)?$/);
    if (!match)
        return value.toLowerCase();
    return match[1].toLowerCase() + (match[2] || '').replace(/\/+$/, '');
}

export function getSecretAttributes(host) {
    return {
        application: APPLICATION_ID,
        'api-host': normalizeSecretHost(host),
    };
}

/** Argument vector for secret-tool. No shell is involved and no token is passed in. */
export function secretToolArguments(host) {
    const argv = ['secret-tool', 'lookup'];
    for (const [key, value] of Object.entries(getSecretAttributes(host)))
        argv.push(key, value);
    return argv;
}

/**
 * Read a credential through a short-lived secret-tool process. A fresh process
 * gets its own D-Bus connection, so it cannot inherit the stale Secret Service
 * session that a long-lived GNOME Shell process can get stuck with.
 */
export function lookupWithSecretTool(host, GLib, Gio) {
    return new Promise((resolve, reject) => {
        let proc;
        try {
            proc = Gio.Subprocess.new(secretToolArguments(host),
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
        } catch (error) {
            reject(error);
            return;
        }
        let settled = false;
        const timeoutId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT, Math.ceil(SECRET_LOOKUP_TIMEOUT_MS / 1000), () => {
                if (settled)
                    return GLib.SOURCE_REMOVE;
                settled = true;
                proc.force_exit();
                reject(new Error('secret-tool lookup timed out'));
                return GLib.SOURCE_REMOVE;
            }
        );
        proc.communicate_async(null, null, (_source, result) => {
            if (settled)
                return;
            settled = true;
            GLib.source_remove(timeoutId);
            try {
                const [, stdout, stderr] = proc.communicate_finish(result);
                if (!proc.get_successful()) {
                    const detail = new TextDecoder().decode(stderr.toArray()).trim();
                    reject(new Error(detail || 'secret-tool lookup failed'));
                    return;
                }
                resolve(new TextDecoder().decode(stdout.toArray()).trim());
            } catch (error) {
                reject(error);
            }
        });
    });
}

async function createLibsecretApi() {
    // Import GI namespaces lazily so this module stays loadable in plain Node
    // for the credential/unit tests. GJS resolves these dynamically at runtime.
    const {default: GLib} = await import('gi://GLib');
    const {default: Gio} = await import('gi://Gio');
    // Dynamic import keeps the extension loadable when the optional typelib is
    // missing; credential operations then return an actionable error instead.
    // Some distributions ship the older Secret-1 typelib name rather than
    // Secret-1.0; fall back to it so the extension still loads.
    let Secret = null;
    try {
        ({default: Secret} = await import('gi://Secret'));
    } catch (_error) {
        ({default: Secret} = await import('gi://Secret-1'));
    }
    const schema = Secret.Schema.new(SCHEMA_NAME, Secret.SchemaFlags.NONE, {
        application: Secret.SchemaAttributeType.STRING,
        'api-host': Secret.SchemaAttributeType.STRING,
    });

    const lookupSecret = host => new Promise((resolve, reject) => {
        let settled = false;
        const timeoutId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT, Math.ceil(SECRET_LOOKUP_TIMEOUT_MS / 1000), () => {
                if (settled)
                    return GLib.SOURCE_REMOVE;
                settled = true;
                reject(new Error('Secret Service lookup timed out'));
                return GLib.SOURCE_REMOVE;
            }
        );
        Secret.password_lookup(schema, getSecretAttributes(host), null, (_source, result) => {
            if (settled)
                return;
            settled = true;
            GLib.source_remove(timeoutId);
            try {
                resolve(Secret.password_lookup_finish(result) || '');
            } catch (error) {
                reject(error);
            }
        });
    });

    return {
        lookup(host) {
            return lookupWithSessionRecovery(
                lookupSecret,
                () => {
                    if (typeof Secret.Service?.disconnect === 'function')
                        Secret.Service.disconnect();
                },
                host,
            ).catch(() => lookupWithSecretTool(host, GLib, Gio));
        },
        store(host, token) {
            return new Promise((resolve, reject) => {
                let settled = false;
                const timeoutId = GLib.timeout_add_seconds(
                    GLib.PRIORITY_DEFAULT, Math.ceil(SECRET_LOOKUP_TIMEOUT_MS / 1000), () => {
                        if (settled)
                            return GLib.SOURCE_REMOVE;
                        settled = true;
                        reject(new Error('Secret Service store timed out'));
                        return GLib.SOURCE_REMOVE;
                    }
                );
                Secret.password_store(
                    schema,
                    getSecretAttributes(host),
                    Secret.COLLECTION_DEFAULT,
                    TOKEN_LABEL,
                    token,
                    null,
                    (_source, result) => {
                        if (settled)
                            return;
                        settled = true;
                        GLib.source_remove(timeoutId);
                        try {
                            if (!Secret.password_store_finish(result))
                                throw new Error('Secret Service did not confirm that the token was stored');
                            resolve(true);
                        } catch (error) {
                            reject(error);
                        }
                    }
                );
            });
        },
        clear(host) {
            return new Promise((resolve, reject) => {
                let settled = false;
                const timeoutId = GLib.timeout_add_seconds(
                    GLib.PRIORITY_DEFAULT, Math.ceil(SECRET_LOOKUP_TIMEOUT_MS / 1000), () => {
                        if (settled)
                            return GLib.SOURCE_REMOVE;
                        settled = true;
                        reject(new Error('Secret Service clear timed out'));
                        return GLib.SOURCE_REMOVE;
                    }
                );
                Secret.password_clear(schema, getSecretAttributes(host), null, (_source, result) => {
                    if (settled)
                        return;
                    settled = true;
                    GLib.source_remove(timeoutId);
                    try {
                        resolve(Secret.password_clear_finish(result));
                    } catch (error) {
                        reject(error);
                    }
                });
            });
        },
    };
}

async function resolveApi(apiOverride) {
    return apiOverride || await createLibsecretApi();
}

export async function loadGithubToken(settings, apiOverride = null) {
    const host = settings.get_string('github-host').trim() || 'api.github.com';
    // Validate before binding legacy plaintext to a host. A stale or manually
    // edited invalid setting must not permanently strand the existing token.
    getApiBase(host);
    const normalizedHost = normalizeSecretHost(host);
    const legacyToken = settings.get_string('github-token');
    let legacyHost = normalizeSecretHost(settings.get_string('legacy-token-host') || '');

    // The old plaintext setting was not host-scoped. Bind it once, before any
    // fallback or migration, so a later host change cannot send it elsewhere.
    if (legacyToken && !settings.get_string('legacy-token-host').trim()) {
        if (!settings.set_string('legacy-token-host', normalizedHost))
            throw new Error('Could not safely bind the existing legacy token to this API host. The token was retained; check GSettings access and retry.');
        legacyHost = normalizedHost;
    }

    let api;
    let storedToken;
    try {
        api = await resolveApi(apiOverride);
        storedToken = await api.lookup(host);
    } catch (_error) {
        if (legacyToken && legacyHost === normalizedHost) {
            return {
                token: legacyToken,
                source: 'legacy',
                warning: 'Secret Service is unavailable; the existing legacy token was retained',
            };
        }
        if (legacyToken && legacyHost !== normalizedHost)
            throw new Error(`Secret Service is unavailable and the legacy token is bound to ${legacyHost}; refusing to send it to ${normalizedHost}. Unlock the keyring or enter a token for this host.`);
        throw new Error('Secret Service is unavailable. Unlock or install a compatible keyring to use a saved token.');
    }

    if (storedToken) {
        let warning = '';
        if (legacyToken && legacyHost === normalizedHost &&
            settings.get_string('github-token') === legacyToken &&
            !clearLegacyTokenSetting(settings, normalizedHost)) {
            warning = 'The saved token is available, but the legacy setting could not be cleared';
        } else if (legacyToken && legacyHost !== normalizedHost) {
            warning = `A legacy token for ${legacyHost} remains stored; it was not used for ${normalizedHost}`;
        }
        return {token: storedToken, source: 'secret-service', warning};
    }

    if (!legacyToken)
        return {token: '', source: 'none', warning: ''};

    if (legacyHost !== normalizedHost)
        throw new Error(`The legacy token is bound to ${legacyHost}, not ${normalizedHost}. Switch back to that API host or enter a token for the new host; the existing token was retained.`);

    try {
        await api.store(host, legacyToken);
    } catch (_error) {
        return {
            token: legacyToken,
            source: 'legacy',
            warning: 'Secret Service migration failed; the existing legacy token was retained',
        };
    }

    if (settings.get_string('github-token') === legacyToken &&
        !clearLegacyTokenSetting(settings)) {
        return {
            token: legacyToken,
            source: 'legacy',
            warning: 'The token was stored, but the legacy setting could not be cleared',
        };
    }

    return {token: legacyToken, source: 'secret-service', migrated: true, warning: ''};
}

export function clearLegacyTokenSetting(settings, expectedHost = null) {
    const legacyToken = settings.get_string('github-token');
    const legacyHost = settings.get_string('legacy-token-host').trim();
    // An unscoped legacy token has no reliable host identity. Do not delete it
    // from a host-specific action until loadGithubToken has bound it safely.
    if (legacyToken && expectedHost && !legacyHost)
        return false;
    if (legacyToken && expectedHost && legacyHost &&
        normalizeSecretHost(legacyHost) !== normalizeSecretHost(expectedHost))
        return false;
    if (legacyToken && !settings.set_string('github-token', ''))
        return false;
    // The host marker is non-secret metadata; clear it only after plaintext is gone.
    if (legacyHost)
        settings.set_string('legacy-token-host', '');
    return true;
}

export async function storeGithubToken(host, token, apiOverride = null) {
    const normalizedToken = String(token || '').trim();
    if (!normalizedToken)
        throw new Error('Enter a non-empty GitHub token');
    // Never report success for a credential tied to an invalid API endpoint.
    getApiBase(String(host || 'api.github.com').trim() || 'api.github.com');
    const api = await resolveApi(apiOverride);
    await api.store(host, normalizedToken);
    return true;
}

export async function clearGithubToken(host, apiOverride = null) {
    const api = await resolveApi(apiOverride);
    return api.clear(host);
}


/** Whether a remaining legacy plaintext token belongs to another API host. */
export function hasLegacyTokenForDifferentHost(settings, host) {
    const token = settings.get_string('github-token');
    const legacyHost = settings.get_string('legacy-token-host').trim();
    return Boolean(token && legacyHost &&
        normalizeSecretHost(legacyHost) !== normalizeSecretHost(host));
}
