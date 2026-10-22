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
    const legacyToken = settings.get_string('github-token');

    let api;
    let storedToken;
    try {
        api = await resolveApi(apiOverride);
        storedToken = await api.lookup(host);
    } catch (_error) {
        if (legacyToken) {
            return {
                token: legacyToken,
                source: 'legacy',
                warning: 'Secret Service is unavailable; the existing legacy token was retained',
            };
        }
        throw new Error('Secret Service is unavailable. Unlock or install a compatible keyring to use a saved token.');
    }

    if (storedToken) {
        let warning = '';
        // Recover safely from a crash between writing the secret and clearing
        // the old setting. Never clear a legacy value before a successful store.
        if (legacyToken && settings.get_string('github-token') === legacyToken &&
            !settings.set_string('github-token', '')) {
            warning = 'The saved token is available, but the legacy setting could not be cleared';
        }
        return {token: storedToken, source: 'secret-service', warning};
    }

    if (!legacyToken)
        return {token: '', source: 'none', warning: ''};

    try {
        await api.store(host, legacyToken);
    } catch (_error) {
        // Keep using an existing credential if migration cannot complete.
        // New tokens are never written to the legacy setting as a fallback.
        return {
            token: legacyToken,
            source: 'legacy',
            warning: 'Secret Service migration failed; the existing legacy token was retained',
        };
    }

    if (settings.get_string('github-token') === legacyToken &&
        !settings.set_string('github-token', '')) {
        return {
            token: legacyToken,
            source: 'legacy',
            warning: 'The token was stored, but the legacy setting could not be cleared',
        };
    }

    return {token: legacyToken, source: 'secret-service', migrated: true, warning: ''};
}

export function clearLegacyTokenSetting(settings) {
    const legacyToken = settings.get_string('github-token');
    return !legacyToken || settings.set_string('github-token', '');
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
