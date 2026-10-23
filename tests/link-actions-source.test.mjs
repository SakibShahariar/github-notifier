import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('../link-actions.js', import.meta.url), 'utf8');

test('GitHub CLI launch config receives the item in its declared argument position', () => {
    assert.match(source, /export function githubCliLaunchConfig\(indicator, item\)/);
    assert.match(source, /export function openWithGitHubCli\(indicator, item\)\s*\{\s*const config = githubCliLaunchConfig\(indicator, item\);/);
});

test('GitHub CLI launch failure remains actionable when no valid command or terminal exists', () => {
    assert.match(source, /if \(!config\)\s*\{\s*indicator\._setActionStatus\('GitHub CLI or a supported terminal is unavailable'\)/);
});


test('link and CLI error timers cannot clear a newer action status', () => {
    assert.ok((source.match(/statusGeneration === indicator\._actionStatusGeneration/g) || []).length >= 3);
});
