import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

const modules = [
    'extension.js', 'prefs.js', 'repo-utils.js', 'secret-store.js', 'api.js', 'state.js',
    'ui-utils.js', 'ui-theme.js', 'notifications.js', 'ui-indicator.js', 'ui-animations.js',
    'repository-polling.js', 'notification-actions.js', 'poll-controller.js', 'link-actions.js',
    'settings-controller.js', 'indicator-lifecycle.js',
];
const sources = new Map(await Promise.all(modules.map(async path => [
    path, await readFile(new URL(`../${path}`, import.meta.url), 'utf8'),
])));
const exportsByPath = new Map([...sources].map(([path, source]) => [path, new Set(
    [...source.matchAll(/export\s+(?:async\s+)?(?:function|class|const|let|var)\s+([A-Za-z_$][\w$]*)/g)]
        .map(match => match[1]),
)]));

test('every named local module import resolves to an exported symbol', () => {
    const missing = [];
    for (const [sourcePath, source] of sources) {
        for (const match of source.matchAll(/import\s*\{([^}]+)\}\s*from\s*['"]\.\/([^'"]+)['"]/gs)) {
            const targetPath = match[2];
            const exports = exportsByPath.get(targetPath);
            if (!exports) {
                missing.push(`${sourcePath}: local module ${targetPath} is not in the scan list`);
                continue;
            }
            for (const entry of match[1].split(',')) {
                const imported = entry.trim().split(/\s+as\s+/)[0].trim();
                if (imported && !exports.has(imported))
                    missing.push(`${sourcePath}: ${imported} is not exported by ${targetPath}`);
            }
        }
    }
    assert.deepEqual(missing, []);
});
