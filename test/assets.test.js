const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { listPackageAssets } = require('../src/assets/optimize');

test('listPackageAssets returns only supported image files', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wxpub-assets-'));
  fs.writeFileSync(path.join(tmpDir, 'cover.png'), 'fake');
  fs.writeFileSync(path.join(tmpDir, 'notes.txt'), 'not image');
  fs.mkdirSync(path.join(tmpDir, 'nested.jpg'));

  const files = listPackageAssets(tmpDir).map((file) => path.basename(file));

  assert.deepEqual(files, ['cover.png']);
});

test('listPackageAssets returns empty list for missing or unreadable paths', () => {
  assert.deepEqual(listPackageAssets('/path/that/does/not/exist'), []);
});
