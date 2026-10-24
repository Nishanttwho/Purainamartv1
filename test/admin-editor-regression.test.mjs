import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const source = await fs.readFile(new URL('../public/admin.js', import.meta.url), 'utf8');
const editorHandler = source.slice(source.indexOf("$('#editor-form').onsubmit"), source.indexOf('\n    editor.showModal();'));

test('Admin edit form submits through the record save callback without an out-of-scope type', () => {
  assert.match(editorHandler, /await saveFn\(value\)/);
  assert.doesNotMatch(editorHandler, /\btype\b/);
});
