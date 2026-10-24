import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('../ui-indicator.js', import.meta.url), 'utf8');

test('refresh control exposes an explicit accessible name and tooltip', () => {
    const start = source.indexOf('const refreshBtn = new St.Button({');
    assert.notEqual(start, -1, 'refresh control exists');
    const end = source.indexOf("refreshBtn.connect('clicked', opts.onRefresh);", start);
    assert.notEqual(end, -1, 'refresh control has its action handler');
    const refreshControl = source.slice(start, end);
    assert.match(refreshControl, /refreshBtn\.accessible_name = 'Refresh GitHub notifications';/);
    assert.match(refreshControl, /indicator\._setTooltip\(refreshBtn, refreshBtn\.accessible_name\);/);
});
