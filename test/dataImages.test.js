const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  countHtmlImages,
  materializeClipboardDataImages,
  parseDataImageUrl,
} = require('../src/html/dataImages');

test('materializeClipboardDataImages extracts data URLs into files and tokens', () => {
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  );
  const html = `<section><img src="data:image/png;base64,${png.toString('base64')}"><p>hi</p></section>`;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wxrelay-test-'));
  const result = materializeClipboardDataImages(html, tmpDir);

  assert.equal(result.images.length, 1);
  assert.match(result.html, /wxrelay-inline:\/\/clipboard-inline-1\.png/);
  assert.doesNotMatch(result.html, /data:image/);
  assert.equal(fs.existsSync(result.images[0].path), true);
  assert.ok(fs.statSync(result.images[0].path).size > 0);
});

test('parseDataImageUrl rejects garbage', () => {
  assert.equal(parseDataImageUrl('not-a-data-url'), null);
  assert.equal(parseDataImageUrl('data:text/plain;base64,YQ=='), null);
});

test('countHtmlImages counts img tags', () => {
  assert.equal(countHtmlImages('<p>no</p>'), 0);
  assert.equal(countHtmlImages('<img src="a"><IMG SRC="b">'), 2);
});
