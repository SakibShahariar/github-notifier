const APPLICATION_ID = 'github-notifier@SakibShahariar';
const SCHEMA_NAME = 'org.gnome.shell.extensions.github-notifier';
const TOKEN_LABEL = 'GitHub Notifier personal access token';

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

async function createLibsecretApi() {
    // Dynamic import keeps the extension loadable when the optional typelib is
    // missing; credential operations then return an actionable error instead.
    const {default: Secret} = await import('gi://Secret');
    const schema = Secret.Schema.new(SCHEMA_NAME, Secret.SchemaFlags.NONE, {
        application: Secret.SchemaAttributeType.STRING,
        'api-host': Secret.SchemaAttributeType.STRING,
    });

    return {
        lookup(host) {
            return new Promise((resolve, reject) => {
                Secret.password_lookup(schema, getSecretAttributes(host), null, (_source, result) => {
                    try {
                        resolve(Secret.password_lookup_finish(result) || '');
                    } catch (error) {
                        reject(error);
                    }
                });
            });
        },
        store(host, token) {
            return new Promise((resolve, reject) => {
                Secret.password_store(
                    schema,
                    getSecretAttributes(host),
                    Secret.COLLECTION_DEFAULT,
                    TOKEN_LABEL,
                    token,
                    null,
                    (_source, result) => {
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
                Secret.password_clear(schema, getSecretAttributes(host), null, (_source, result) => {
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
    const api = await resolveApi(apiOverride);
    await api.store(host, normalizedToken);
    return true;
}

export async function clearGithubToken(host, apiOverride = null) {
    const api = await resolveApi(apiOverride);
    return api.clear(host);
}
