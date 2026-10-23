import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('../prefs.js', import.meta.url), 'utf8');

test('API host preferences validate input and report GSettings write failures', () => {
    assert.match(source, /getApiBase\(host \|\| 'api\.github\.com'\);\s*if \(!settings\.set_string\('github-host', host \|\| 'api\.github\.com'\)\)\s*\{\s*testRow\.subtitle = 'Could not save API host setting';\s*return;/);
    assert.match(source, /testRow\.subtitle = 'API host saved';/);
});
