import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('../notification-actions.js', import.meta.url), 'utf8');

test('opened notification rows respect mark-read-on-open while activity rows are dismissed', () => {
    assert.match(source, /export function handleOpenedItem\(indicator, item\)/);
    assert.match(source, /item\.kind === 'notification' && item\.rawId/);
    assert.match(source, /indicator\._settings\.get_boolean\('mark-read-on-open'\)/);
    assert.match(source, /return indicator\._markThreadRead\(item\)/);
    assert.match(source, /return indicator\._dismissActivityItem\(item\)/);
});
