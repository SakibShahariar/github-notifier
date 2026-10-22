import assert from 'node:assert/strict';
import test from 'node:test';

import {
    clearGithubToken,
    clearLegacyTokenSetting,
    getSecretAttributes,
    loadGithubToken,
    normalizeSecretHost,
    storeGithubToken,
} from '../secret-store.js';

function makeSettings({host = 'api.github.com', token = ''} = {}) {
    const strings = {'github-host': host, 'github-token': token};
    const integers = {'token-generation': 0};
    return {
        get_string(key) { return strings[key] ?? ''; },
        set_string(key, value) { strings[key] = value; return true; },
        get_int(key) { return integers[key] ?? 0; },
        set_int(key, value) { integers[key] = value; return true; },
        strings,
        integers,
    };
}

test('normalizes API host lookup identity without including a token', () => {
    assert.equal(normalizeSecretHost(' API.GITHUB.COM/// '), 'api.github.com');
    assert.equal(normalizeSecretHost('GIT.EXAMPLE.COM/enterprise/api/v3/'), 'git.example.com/enterprise/api/v3');
    assert.deepEqual(getSecretAttributes('API.GITHUB.COM'), {
        application: 'github-notifier@SakibShahariar',
        'api-host': 'api.github.com',
    });
    assert.equal(JSON.stringify(getSecretAttributes('api.github.com')).includes('ghp_'), false);
});

test('migrates a legacy token and clears plaintext only after successful storage', async () => {
    const settings = makeSettings({token: 'legacy-token'});
    const events = [];
    const api = {
        async lookup(host) { events.push(['lookup', host]); return ''; },
        async store(host, token) { events.push(['store', host, token]); },
    };
    const result = await loadGithubToken(settings, api);
    assert.equal(result.token, 'legacy-token');
    assert.equal(result.source, 'secret-service');
    assert.equal(result.migrated, true);
    assert.equal(settings.get_string('github-token'), '');
    assert.deepEqual(events, [['lookup', 'api.github.com'], ['store', 'api.github.com', 'legacy-token']]);
});

test('preserves the legacy token when migration storage fails', async () => {
    const settings = makeSettings({token: 'legacy-token'});
    const api = {async lookup() { return ''; }, async store() { throw new Error('locked'); }};
    const result = await loadGithubToken(settings, api);
    assert.equal(result.token, 'legacy-token');
    assert.equal(result.source, 'legacy');
    assert.match(result.warning, /retained/);
    assert.equal(settings.get_string('github-token'), 'legacy-token');
});

test('preserves and uses the legacy token when Secret Service lookup is unavailable', async () => {
    const settings = makeSettings({token: 'legacy-token'});
    const result = await loadGithubToken(settings, {async lookup() { throw new Error('service unavailable'); }});
    assert.equal(result.token, 'legacy-token');
    assert.equal(result.source, 'legacy');
    assert.match(result.warning, /unavailable/);
    assert.equal(settings.get_string('github-token'), 'legacy-token');
});

test('uses an existing Secret Service token and repairs interrupted migration cleanup', async () => {
    const settings = makeSettings({token: 'legacy-token'});
    const api = {
        async lookup(host) { assert.equal(host, 'api.github.com'); return 'secret-token'; },
        async store() { assert.fail('must not overwrite an existing secret'); },
    };
    const result = await loadGithubToken(settings, api);
    assert.equal(result.token, 'secret-token');
    assert.equal(result.source, 'secret-service');
    assert.equal(settings.get_string('github-token'), '');
});

test('does not pretend a missing secret service means a credential exists', async () => {
    await assert.rejects(loadGithubToken(makeSettings(), {
        async lookup() { throw new Error('missing service'); },
    }), /Secret Service is unavailable/);
});

test('new tokens are never stored through the legacy settings key', async () => {
    const calls = [];
    const api = {async store(host, token) { calls.push([host, token]); }};
    await storeGithubToken('GIT.EXAMPLE.COM/api/v3/', 'new-token', api);
    assert.deepEqual(calls, [['GIT.EXAMPLE.COM/api/v3/', 'new-token']]);
    await assert.rejects(storeGithubToken('api.github.com', '   ', api), /non-empty/);
});

test('removal is scoped to the selected API host', async () => {
    const calls = [];
    const api = {async clear(host) { calls.push(host); return true; }};
    assert.equal(await clearGithubToken('git.example.com/api/v3', api), true);
    assert.deepEqual(calls, ['git.example.com/api/v3']);
});

test('reports when legacy plaintext cleanup is not writable', () => {
    const settings = makeSettings({token: 'legacy-token'});
    settings.set_string = () => false;
    assert.equal(clearLegacyTokenSetting(settings), false);
    assert.equal(settings.get_string('github-token'), 'legacy-token');
});

test('treats an already-empty legacy setting as successfully cleared', () => {
    const settings = makeSettings();
    settings.set_string = () => assert.fail('must not write when no legacy token exists');
    assert.equal(clearLegacyTokenSetting(settings), true);
});
