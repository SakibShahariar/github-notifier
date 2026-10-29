import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('../poll-controller.js', import.meta.url), 'utf8');

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
    assert.match(source, /if \(!indicator\._paused\)\s*indicator\._poll\(\)/);
});

test('watched repository polling uses a bounded three-worker pool', () => {
    assert.match(source, /runBoundedWorkers\(\s*repos,\s*3,/);
});


test('drops activity returned by an in-flight request after its repository becomes muted', () => {
    assert.match(source, /import \{[^}]*filterVisibleActivityItems[^}]*\} from '\.\/repo-utils\.js'/);
    assert.match(source, /const visibleNewActivityItems = filterVisibleActivityItems\(newActivityItems, indicator\._mutedRepositories\(\)\)/);
    assert.match(source, /indicator\._activityItems = visibleNewActivityItems\.concat\(indicator\._activityItems\)/);
    assert.match(source, /toToast\.concat\(visibleNewActivityItems\.filter/);
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
