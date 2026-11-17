import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('../poll-controller.js', import.meta.url), 'utf8');
const repoUtilsSource = await readFile(new URL('../repo-utils.js', import.meta.url), 'utf8');

test('poll controller imports every repository predicate it invokes', () => {
    const repoUtilsImport = source.match(/import\s*\{([^}]+)\}\s*from\s*['"]\.\/repo-utils\.js['"]/s);
    assert.ok(repoUtilsImport, 'expected a repo-utils.js import');
    const imported = new Set(repoUtilsImport[1].split(',').map(name => name.trim()));
    assert.ok(imported.has('isValidRepository'), 'isValidRepository must be imported');
    assert.ok(imported.has('isRepositoryMuted'), 'isRepositoryMuted must be imported');
    assert.ok(imported.has('deduplicateRepositoryEntries'), 'deduplicateRepositoryEntries must be imported');
});

test('poll controller deduplicates watched repositories before pruning and polling', () => {
    assert.equal((source.match(/deduplicateRepositoryEntries\(reposStr\)/g) || []).length, 2);
});

test('pause toggle refreshes the menu and polls immediately when resumed', () => {
    assert.match(source, /export function togglePollingPause\(indicator\)/);
    assert.match(source, /indicator\._paused = !indicator\._paused/);
    assert.match(source, /indicator\._renderList\(\)/);
    assert.match(source, /if \(!indicator\._paused\) \{\s*indicator\._idlePollCount = 0;\s*indicator\._poll\(\);\s*\}/);
});

test('watched repository polling uses a bounded three-worker pool', () => {
    assert.match(source, /runBoundedWorkers\(\s*repos,\s*3,/);
});


test('drops activity returned by an in-flight request after its repository becomes muted', () => {
    assert.match(source, /import \{[^}]*filterVisibleActivityItems[^}]*\} from '\.\/repo-utils\.js'/);
    assert.match(source, /const visibleNewActivityItems = filterVisibleActivityItems\(newActivityItems, indicator\._mutedRepositories\(\)\)/);
    assert.match(source, /indicator\._activityItems = freshActivityItems\.concat\(indicator\._activityItems\)/);
    assert.match(source, /toToast\.concat\(freshActivityItems\.filter/);
});

test('replayed star or issue ids never duplicate rows, counters, or notifications', () => {
    assert.match(source, /import \{[^}]*deduplicateActivityItems[^}]*\} from '\.\/repo-utils\.js'/);
    assert.match(source, /const knownActivityIds = new Set\(indicator\._activityItems\.map\(item => item\.id\)\)/);
    assert.match(source, /const freshActivityItems = deduplicateActivityItems\(visibleNewActivityItems\)\s*\.filter\(item => !knownActivityIds\.has\(item\.id\)\)/);
    assert.match(source, /updateDailyStats\(indicator\._dailyStats, indicator\._localDateKey\(\), newNotificationCount, freshActivityItems\.length\)/);
});


test('poll results filter in-flight activity and baseline notices against current watch/mute settings', () => {
    assert.match(source, /currentWatchedRepositories = new Set\([\s\S]*?watched-repos[\s\S]*?\.filter\(item => !isValidRepository\(item\.subtitle\) \|\|\s*currentWatchedRepositories\.has\(item\.subtitle\.trim\(\)\.toLowerCase\(\)\)\)/);
    assert.match(source, /visibleBaselineNotes = baselineNotes\.filter\(note => \{[\s\S]*?currentWatchedRepositories\.has\(repository\.toLowerCase\(\)\)[\s\S]*?!isRepositoryMuted\(repository, currentMutedRepositories\)/);
    assert.match(source, /indicator\._notifyBaseline\(visibleBaselineNotes\)/);
    assert.doesNotMatch(source, /indicator\._notifyBaseline\(baselineNotes\)/);
});


test('manual refresh while paused reports why no refresh starts', () => {
    assert.match(source, /if \(indicator\._paused\) \{\s*indicator\._setStatusBanner\('Polling is paused — resume polling to refresh GitHub', 'info'\);\s*indicator\._updateHero\(\);\s*indicator\._updatePanel\(\);\s*return;/);
});


test('idle polling backs off after three unchanged successes and remains capped', () => {
    assert.match(source, /indicator\._idlePollCount = hasNewInboxItems \|\| activityItems\.length > 0\s*\? 0\s*:\s*Math\.min\(5, indicator\._idlePollCount \+ 1\)/);
    assert.match(source, /getIdlePollInterval\(configuredInterval, indicator\._idlePollCount\)/);
    assert.match(repoUtilsSource, /const multiplier = count < 3\s*\? 1\s*:\s*Math\.min\(8, 2 \*\* \(count - 2\)\)/);
    assert.match(repoUtilsSource, /Math\.max\(baseInterval, Math\.min\(1800, baseInterval \* multiplier\)\)/);
    assert.match(source, /Math\.max\(idleInterval, indicator\._serverPollIntervalSeconds, backoffSeconds, retryAfterSeconds, tokenRetrySeconds\)/);
});

test('manual refresh, resume, and failed polls reset idle backoff', () => {
    assert.match(source, /if \(manualRefresh\)\s*indicator\._idlePollCount = 0/);
    assert.match(source, /indicator\._manualRefreshPending = true;\s*indicator\._idlePollCount = 0/);
    assert.match(source, /if \(!pollSucceeded\)\s*indicator\._idlePollCount = 0/);
    assert.match(source, /if \(!indicator\._paused\) \{\s*indicator\._idlePollCount = 0;\s*indicator\._poll\(\)/);
});


test('failed Secret Service token retries wait for a poll-interval cooldown', () => {
    assert.match(source, /const TOKEN_RETRY_COOLDOWN_SECONDS = 60;/);
    assert.match(source, /const retryInterval = Math\.max\(TOKEN_RETRY_COOLDOWN_SECONDS, indicator\._settings\.get_int\('poll-interval'\)\);/);
    assert.match(source, /const retryDue = !indicator\._tokenRetryAfterEpoch \|\| nowEpoch >= indicator\._tokenRetryAfterEpoch;/);
    assert.match(source, /if \(isSecretServiceProblem && !indicator\._tokenRetryInFlight && retryDue\) \{/);
    assert.match(source, /indicator\._tokenRetryAfterEpoch = nowEpoch \+ retryInterval;/);
});


test('a failed token retry schedules the timer instead of re-polling immediately', () => {
    assert.match(source, /function refreshAccountScopeForRetry\(indicator, \{immediate = false\} = \{\}\)/);
    assert.match(source, /if \(immediate\) \{[\s\S]*?indicator\._poll\(\);[\s\S]*?\} else \{\s*indicator\._restartTimer\(\);\s*\}/);
    assert.match(source, /refreshAccountScopeForRetry\(indicator, \{immediate: true\}\);/);
    assert.match(source, /logError\(e, 'github-notifier: retry to retrieve GitHub token from Secret Service failed'\);\s*indicator\._setStatusBanner/);
    assert.match(source, /logError\(e, 'github-notifier: retry to retrieve GitHub token from Secret Service failed'\);[\s\S]{0,300}refreshAccountScopeForRetry\(indicator\);/);
});


test('manual refresh bypasses and the poll timer respects the token retry cooldown', () => {
    assert.match(source, /indicator\._networkRetryAfterEpoch = 0;\s*\/\/ An explicit refresh may bypass the Secret Service retry cooldown\.\s*indicator\._tokenRetryAfterEpoch = 0;/);
    assert.match(source, /const tokenRetrySeconds = Math\.max\(0, \(indicator\._tokenRetryAfterEpoch \?\? 0\) - nowEpoch\);/);
    assert.match(source, /Math\.max\(idleInterval, indicator\._serverPollIntervalSeconds, backoffSeconds, retryAfterSeconds, tokenRetrySeconds\)/);
});
