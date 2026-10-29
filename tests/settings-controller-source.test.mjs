import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('../settings-controller.js', import.meta.url), 'utf8');

test('credential refresh ignores stale asynchronous results after host/token changes', () => {
    assert.match(source, /let tokenRefreshGeneration = 0/);
    assert.match(source, /const generation = \+\+tokenRefreshGeneration/);
    assert.match(source, /if \(indicator\._destroyed \|\| generation !== tokenRefreshGeneration\)\s*return/);
    assert.match(source, /changed::token-generation', refreshToken/);
    assert.match(source, /changed::github-host', refreshToken/);
});

test('polling stays blocked while the current Secret Service credential is loading', () => {
    assert.match(source, /indicator\._tokenLoading = true/);
    assert.match(source, /if \(!indicator\._destroyed && generation === tokenRefreshGeneration\)\s*\{\s*indicator\._tokenLoading = false/);
    assert.match(source, /refreshAccountScope\(\)/);
});

test('account changes reload state under the current host/token scope and clear old backoff', () => {
    assert.match(source, /indicator\._rateLimitResetEpoch = 0/);
    assert.match(source, /indicator\._retryAfterEpoch = 0/);
    assert.match(source, /const state = indicator\._loadState\(\)/);
    assert.match(source, /indicator\._pendingMarkAllRead = indicator\._isValidPendingMarkAll/);
});


test('repository setting changes queue a fresh poll when the current cycle has stale watch state', () => {
    assert.match(source, /const pollAfterRepositorySettingsChange = \(\) => \{[\s\S]*?if \(indicator\._polling\) \{\s*indicator\._restartPollRequested = true;\s*indicator\._pollCancellable\?\.cancel\(\);\s*return;\s*\}[\s\S]*?indicator\._poll\(\);/);
    assert.match(source, /changed::watched-repos'[\s\S]*?pollAfterRepositorySettingsChange\(\)/);
    assert.match(source, /changed::muted-repos'[\s\S]*?pollAfterRepositorySettingsChange\(\)/);
});


test('credential refresh cancels an in-flight poll without treating it as a network failure', () => {
    assert.match(source, /indicator\._tokenLoading = true;[\s\S]*?if \(indicator\._polling\) \{[\s\S]*?indicator\._restartPollRequested = true;[\s\S]*?indicator\._pollCancellable\?\.cancel\(\);/);
});


test('account-scope restoration rejects malformed notification thread IDs too', () => {
    assert.match(source, /state\.pendingReadItems\.filter\(item => item && typeof item\.id === 'string' && typeof item\.rawId === 'string' && \/\^\\d\{1,20\}\$\/\.test\(item\.rawId\)\)/);
});


test('account-scope restoration rejects invalid last-fetch timestamps', () => {
    assert.match(source, /indicator\._lastFetchedAt = typeof state\.lastFetchedAt === 'string' && Number\.isFinite\(Date\.parse\(state\.lastFetchedAt\)\) \? state\.lastFetchedAt : null/);
});


test('clears server-directed inbox polling interval when inbox monitoring is disabled', () => {
    assert.match(source, /changed::watch-mentions'[\s\S]*?if \(!indicator\._settings\.get_boolean\('watch-mentions'\)\)[\s\S]*?indicator\._serverPollIntervalSeconds = 0;[\s\S]*?indicator\._restartTimer\(\)/);
});
