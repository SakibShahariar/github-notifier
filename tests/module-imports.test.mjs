import assert from 'node:assert/strict';
import {readdir, readFile} from 'node:fs/promises';
import test from 'node:test';

// Discover modules automatically so adding a new top-level module cannot silently
// escape the import/export audit.
const modules = (await readdir(new URL('../', import.meta.url)))
    .filter(path => path.endsWith('.js'))
    .sort();
const sources = new Map(await Promise.all(modules.map(async path => [
    path, await readFile(new URL(`../${path}`, import.meta.url), 'utf8'),
])));
const exportsByPath = new Map([...sources].map(([path, source]) => [path, new Set(
    [...source.matchAll(/export\s+(?:async\s+)?(?:function|class|const|let|var)\s+([A-Za-z_$][\w$]*)/g)]
        .map(match => match[1]),
)]));

const exportedFunctions = new Map();
for (const [path, source] of sources) {
    for (const match of source.matchAll(/^export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm))
        exportedFunctions.set(match[1], path);
}

test('bare calls to exported local helpers are imported or defined in the same module', () => {
    const missing = [];
    for (const [sourcePath, source] of sources) {
        const imported = new Set();
        for (const match of source.matchAll(/import\s*\{([^}]+)\}\s*from\s*['"]\.\/([^'"]+)['"]/gs)) {
            for (const entry of match[1].split(',')) {
                const name = entry.trim().split(/\s+as\s+/)[0].trim();
                if (name)
                    imported.add(name);
            }
        }
        const localDefinitions = new Set(
            [...source.matchAll(/^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm)]
                .map(match => match[1])
        );
        for (const [name, owner] of exportedFunctions) {
            if (owner === sourcePath || imported.has(name) || localDefinitions.has(name))
                continue;
            const call = new RegExp('(?<![.$\\w])' + name + '\\s*\\(');
            if (call.test(source))
                missing.push(sourcePath + ': calls ' + name + '() without importing it');
        }
    }
    assert.deepEqual(missing, []);
});

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

test('every referenced GNOME GI namespace is imported or locally declared', () => {
    const namespaces = ['Gio', 'GLib', 'St', 'Clutter', 'Pango', 'Main', 'GObject', 'Soup', 'PopupMenu', 'PanelMenu', 'Extension', 'Secret', 'Adw', 'Gtk', 'Gdk', 'Meta', 'Shell', 'ByteArray'];
    const missing = [];
    for (const [path, source] of sources) {
        const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
        for (const name of namespaces) {
            if (!new RegExp('\\b' + name + '\\s*\\.').test(code))
                continue;
            const declared = new RegExp('\\bimport\\s+(?:\\*\\s+as\\s+' + name + '\\b|' + name + '\\s+from|\\{[^}]*\\b' + name + '\\b[^}]*\\}\\s+from)').test(source) ||
                new RegExp('\\b(?:const|let|var)\\s+(?:\\{[^}]*\\b' + name + '\\b[^}]*\\}|'+name+')\\s*=').test(source);
            if (!declared)
                missing.push(path + ': references ' + name + ' without importing or declaring it');
        }
    }
    assert.deepEqual(missing, []);
});
