import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('../indicator-lifecycle.js', import.meta.url), 'utf8');

test('indicator cleanup cancels deferred startup poll and disconnects startup signal', () => {
    assert.match(source, /if \(indicator\._startupId\)\s*\{\s*GLib\.source_remove\(indicator\._startupId\);\s*indicator\._startupId = null;/);
    assert.match(source, /if \(indicator\._startupCompleteId\)\s*\{\s*try \{ Main\.layoutManager\.disconnect\(indicator\._startupCompleteId\); \} catch \(e\) \{\}\s*indicator\._startupCompleteId = null;/);
});

test('extension disable delegates all resource cleanup to the indicator lifecycle', async () => {
    const extension = await readFile(new URL('../extension.js', import.meta.url), 'utf8');
    const start = extension.indexOf('    disable() {', extension.indexOf('export default class GithubNotifierExtension')) ;
    assert.notEqual(start, -1);
    const end = extension.indexOf('\n    }', start) + 6;
    const method = extension.slice(start, end);
    assert.match(method, /this\._indicator\?\.destroy\(\)/);
    assert.match(method, /this\._indicator = null/);
    assert.doesNotMatch(method, /GLib\.source_remove|layoutManager\.disconnect/);
});

test('network recovery imports Gio before creating the default network monitor', () => {
    assert.match(source, /^import Gio from 'gi:\/\/Gio';/m);
    assert.match(source, /Gio\.NetworkMonitor\.get_default\(\)/);
});

test('network recovery handlers and debounce timer are cleaned up on disable', () => {
    assert.match(source, /if \(indicator\._networkDebounceId\)\s*\{\s*GLib\.source_remove\(indicator\._networkDebounceId\);\s*indicator\._networkDebounceId = null;/);
    assert.match(source, /if \(indicator\._networkChangedId\)\s*\{\s*indicator\._networkMonitor\.disconnect\(indicator\._networkChangedId\)/);
    assert.match(source, /if \(indicator\._connectivityChangedId\)\s*\{\s*indicator\._networkMonitor\.disconnect\(indicator\._connectivityChangedId\)/);
});
