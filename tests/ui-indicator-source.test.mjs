import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('../ui-indicator.js', import.meta.url), 'utf8');
const extensionSource = await readFile(new URL('../extension.js', import.meta.url), 'utf8');

test('panel tooltip updates target the indicator actor, not module this', () => {
    assert.match(source, /indicator\._setTooltip\(indicator, 'GitHub Notifier — attention needed'\)/);
    assert.match(source, /indicator\._setTooltip\(indicator,.*unread/);
    assert.match(source, /indicator\._setTooltip\(indicator, 'GitHub Notifier'\)/);
    assert.doesNotMatch(source, /indicator\._setTooltip\(this,/);
});

test('icon-only menu controls retain tooltip/accessibility labels', () => {
    for (const label of ['Previous page', 'Next page', 'Settings', 'Open with GitHub CLI', 'Mark read', 'Dismiss'])
        assert.ok(source.includes(label), `missing accessible control label: ${label}`);
});

test('panel and status actions expose stable accessible names and keyboard activation', () => {
    assert.match(extensionSource, /this\.accessible_name = 'GitHub Notifier'/);
    assert.match(source, /indicator\._setTooltip\(gearButton, 'Settings'\)/);
    assert.match(source, /indicator\._statusActionItem\.connect\('activate'/);
    assert.match(source, /indicator\._statusActionItem\.visible = indicator\._statusAction !== null/);
});


test('action status generation prevents stale transient timers from hiding newer messages', () => {
    assert.match(source, /indicator\._actionStatusGeneration = generation/);
    assert.match(source, /statusGeneration === indicator\._actionStatusGeneration/);
});
