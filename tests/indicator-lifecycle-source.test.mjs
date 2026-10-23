import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('../indicator-lifecycle.js', import.meta.url), 'utf8');

test('indicator cleanup cancels deferred startup poll and disconnects startup signal', () => {
    assert.match(source, /if \(indicator\._startupId\)\s*\{\s*GLib\.source_remove\(indicator\._startupId\);\s*indicator\._startupId = null;/);
    assert.match(source, /if \(indicator\._startupCompleteId\)\s*\{\s*try \{ Main\.layoutManager\.disconnect\(indicator\._startupCompleteId\); \} catch \(e\) \{\}\s*indicator\._startupCompleteId = null;/);
});
