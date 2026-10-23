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
    assert.match(source, /const pollAfterRepositorySettingsChange = \(\) => \{[\s\S]*?if \(indicator\._polling\) \{\s*indicator\._restartPollRequested = true;\s*return;\s*\}[\s\S]*?indicator\._poll\(\);/);
    assert.match(source, /changed::watched-repos'[\s\S]*?pollAfterRepositorySettingsChange\(\)/);
    assert.match(source, /changed::muted-repos'[\s\S]*?pollAfterRepositorySettingsChange\(\)/);
});
