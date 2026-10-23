import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('../prefs.js', import.meta.url), 'utf8');

test('API host preferences validate input and report GSettings write failures', () => {
    assert.match(source, /getApiBase\(host \|\| 'api\.github\.com'\);\s*if \(!settings\.set_string\('github-host', host \|\| 'api\.github\.com'\)\)\s*\{\s*testRow\.subtitle = 'Could not save API host setting';\s*return;/);
    assert.match(source, /testRow\.subtitle = 'API host saved';/);
});


test('quiet-hours settings report failed GSettings writes instead of false success', () => {
    assert.match(source, /if \(!settings\.set_string\('quiet-hours-start', value\)\)\s*\{\s*quietStatusRow\.subtitle = 'Could not save quiet-hours start\.';\s*quietStartRow\.set_text\(settings\.get_string\('quiet-hours-start'\)\);\s*return;/);
    assert.match(source, /if \(!settings\.set_string\('quiet-hours-end', value\)\)\s*\{\s*quietStatusRow\.subtitle = 'Could not save quiet-hours end\.';\s*quietEndRow\.set_text\(settings\.get_string\('quiet-hours-end'\)\);\s*return;/);
});


test('username, muted-repository, and watched-repository saves report write failures', () => {
    assert.match(source, /if \(!settings\.set_string\('github-username', username\)\)\s*\{\s*testRow\.subtitle = 'Could not save GitHub username setting';\s*userRow\.set_text\(settings\.get_string\('github-username'\)\);/);
    assert.match(source, /if \(!settings\.set_string\('muted-repos', values\.join\(', '\)\)\)\s*\{\s*mutedError\.set_title\('Could not save muted repositories'\)/);
    assert.match(source, /const saved = settings\.set_string\('watched-repos', values\.join\(', '\)\);\s*syncing = false;\s*saveErrorBanner\.set_revealed\(!saved\);/);
});
