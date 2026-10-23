import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8');

test('installation instructions copy every JavaScript module into the extension directory', () => {
    assert.match(readme, /cp \.\/\*\.js metadata\.json stylesheet\.css "\$DEST\//);
});
