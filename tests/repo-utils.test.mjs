import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

// Load the exact helper source as an ES module without requiring a package.json
// change that could affect GNOME Shell's extension module loading.
const helperSource = await readFile(new URL('../repo-utils.js', import.meta.url), 'utf8');
const helperUrl = `data:text/javascript;base64,${Buffer.from(helperSource).toString('base64')}`;
const {isValidRepository} = await import(helperUrl);

test('accepts ordinary GitHub owner/repository names', () => {
    for (const value of [
        'owner/repo',
        'gnome/gnome-shell',
        'owner.name/repo_name',
        'A1/B2',
        'owner/repo-name',
        'owner/repo.name',
    ]) {
        assert.equal(isValidRepository(value), true, value);
    }
});

test('rejects malformed repository paths', () => {
    for (const value of [
        '',
        'owner',
        '/repo',
        'owner/',
        'owner/repo/extra',
        ' owner/repo',
        'owner/repo ',
        'owner with space/repo',
        'owner/repo name',
        'owner//repo',
    ]) {
        assert.equal(isValidRepository(value), false, JSON.stringify(value));
    }
});

test('rejects non-string inputs', () => {
    for (const value of [null, undefined, 12, {}, ['owner/repo']]) {
        assert.equal(isValidRepository(value), false);
    }
});
