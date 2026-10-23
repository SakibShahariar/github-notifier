import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('../link-actions.js', import.meta.url), 'utf8');

test('GitHub CLI launch config receives the item in its declared argument position', () => {
    assert.match(source, /export function githubCliLaunchConfig\(indicator, item\)/);
    assert.match(source, /export function openWithGitHubCli\(indicator, item\)\s*\{\s*const config = githubCliLaunchConfig\(indicator, item\);/);
});

test('GitHub CLI launch failure remains actionable when no valid command or terminal exists', () => {
    assert.match(source, /if \(!config\)\s*\{\s*const statusGeneration = indicator\._setActionStatus\('GitHub CLI or a supported terminal is unavailable'\)/);
});


test('link and CLI error timers cannot clear a newer action status', () => {
    assert.ok((source.match(/statusGeneration === indicator\._actionStatusGeneration/g) || []).length >= 3);
});


test('browser launches validate the URL scheme and credentials before handing links to the desktop', () => {
    assert.match(source, /import \{getGitHubCliArguments, isSafeWebUrl\} from '\.\/repo-utils\.js'/);
    assert.match(source, /if \(!isSafeWebUrl\(uri, indicator\._webBase\(\)\)\)\s*throw new Error\('Refusing to open an invalid, non-HTTPS, or cross-host link'\)/);
    assert.ok(source.indexOf('if (!isSafeWebUrl(uri, indicator._webBase()))') < source.indexOf('Gio.AppInfo.launch_default_for_uri(uri, null)'));
});
