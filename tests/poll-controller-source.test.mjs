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
