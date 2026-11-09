import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('../ui-utils.js', import.meta.url), 'utf8');

test('shared tooltip controller gives keyboard-focused controls the same tooltip as hover', () => {
    assert.match(source, /actor\.connect\('enter-event'/);
    assert.match(source, /actor\.connect\('key-focus-in', \(\) => \{\s*this\._schedule\(actor\);/);
    assert.match(source, /actor\.connect\('key-focus-out', \(\) => \{\s*if \(this\._activeActor === actor \|\| this\._pendingActor === actor\)\s*this\._hide\(\);/);
    assert.match(source, /actor\.accessible_name = text/);
});

test('tooltip controller disconnects its stage chrome and hides pending tooltips on destruction', () => {
    assert.match(source, /destroy\(\) \{\s*this\._hide\(\);\s*Main\.layoutManager\.removeChrome\(this\._label\);\s*this\._label\.destroy\(\);/);
    assert.match(source, /actor\.connect\('destroy', \(\) => \{\s*if \(this\._activeActor === actor \|\| this\._pendingActor === actor\)\s*this\._hide\(\);/);
});


test('tooltip is raised above popup chrome and positioned from transformed actor bounds', () => {
    assert.match(source, /this\._label\.raise_top\(\)/);
    assert.match(source, /actor\.get_transformed_size\(\)/);
    assert.match(source, /const \[, naturalWidth\] = this\._label\.get_preferred_width\(-1\)/);
    assert.match(source, /const tooltipWidth = Math\.min\(naturalWidth, maxWidth, 360\)/);
    assert.match(source, /this\._label\.set_width\(tooltipWidth\)/);
    assert.match(source, /github-notifier-tooltip/);
});
