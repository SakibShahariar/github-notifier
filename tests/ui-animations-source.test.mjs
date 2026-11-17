import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

const animations = await readFile(new URL('../ui-animations.js', import.meta.url), 'utf8');
const indicator = await readFile(new URL('../ui-indicator.js', import.meta.url), 'utf8');
const extension = await readFile(new URL('../extension.js', import.meta.url), 'utf8');

test('badge pop invalidates earlier chained animations', () => {
    assert.match(animations, /export function resetBadgeTransform\(indicator\)/);
    assert.match(animations, /indicator\._badgeAnimationGeneration = \(indicator\._badgeAnimationGeneration \?\? 0\) \+ 1;/);
    assert.match(animations, /const live = \(\) => !indicator\._destroyed && indicator\._badgeAnimationGeneration === generation;/);
    assert.match(animations, /label\.remove_all_transitions\(\)/);
    assert.match(animations, /if \(live\(\) && next\)/);
});

test('panel count snaps to neutral when no fresh pop starts', () => {
    assert.match(indicator, /if \(unread > prev\)\s*indicator\._animateBadgePop\(\);\s*else\s*indicator\._resetBadgeTransform\(\);/);
    assert.doesNotMatch(indicator, /indicator\._animateBadgePop\(\);\s*indicator\._animateIconPulse\(\);/);
    assert.match(animations, /label\.scale_x = 1\.0;\s*label\.scale_y = 1\.0;\s*label\.opacity = 255;/);
});

test('icon pulse uses the same generation guard', () => {
    assert.match(animations, /const generation = \(indicator\._iconAnimationGeneration \?\? 0\) \+ 1;[\s\S]*?indicator\._iconAnimationGeneration = generation;/);
    assert.match(animations, /const live = \(\) => !indicator\._destroyed && indicator\._iconAnimationGeneration === generation;/);
});

test('indicator exposes the badge reset helper', () => {
    assert.match(extension, /import \{[^}]*resetBadgeTransform[^}]*\} from '\.\/ui-animations\.js'/);
    assert.match(extension, /_resetBadgeTransform\(\) \{\s*resetBadgeTransform\(this\);\s*\}/);
});
