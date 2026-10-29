import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('../ui-theme.js', import.meta.url), 'utf8');

test('missing or invalid Matugen palettes remove overrides instead of applying dark fallback colors', () => {
    assert.match(source, /if \(!file\.query_exists\(null\)\)\s*return null/);
    assert.match(source, /if \(!ok \|\| !contents\?\.length\)\s*return null/);
    assert.match(source, /if \(!required\.every\(key => map\[key\]\)\)\s*return null/);
    assert.match(source, /if \(!colors\) \{\s*clearMatugenStylesheet\(indicator\);\s*return;/);
});

test('Matugen file changes clear stale overrides and monitor creation when the palette is absent', () => {
    assert.match(source, /if \(indicator\._matugenColors\) \{\s*indicator\._applyMatugenThemeInternal\(indicator\._matugenColors\);\s*\} else \{\s*clearMatugenStylesheet\(indicator\);\s*\}/);
    assert.match(source, /function clearMatugenStylesheet\(indicator\)/);
    assert.match(source, /configDirectory\.monitor_directory/);
    assert.match(source, /directory\.monitor_directory/);
    assert.match(source, /Monitoring the palette file directly fails when Matugen has not generated it yet/);
    assert.match(source, /export function removeMatugenTheme\(indicator\) \{\s*clearMatugenStylesheet\(indicator\);/);
});
