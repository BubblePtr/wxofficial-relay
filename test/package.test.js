const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { validateArticlePackage } = require('../src/package/validate');
const { createMinimalArticlePackage } = require('../src/package/schema');

function validArticle(overrides = {}) {
  return {
    title: '标题',
    contentHtml: '<section>正文</section>',
    coverMediaId: 'cover-media-id',
    ...overrides,
  };
}

test('createMinimalArticlePackage returns a schema-valid package skeleton', () => {
  const result = validateArticlePackage(createMinimalArticlePackage());

  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
});

test('validateArticlePackage treats max-length violations as errors', () => {
  const result = validateArticlePackage(validArticle({ title: 'x'.repeat(65) }));

  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /title exceeds max length 64/);
});

test('validateArticlePackage reports non-string paths instead of throwing', () => {
  const result = validateArticlePackage(
    validArticle({
      coverPath: 123,
      assetsDir: false,
      images: [{ src: './a.png', path: 456 }, null],
    }),
    { checkFiles: true }
  );

  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /coverPath must be a string/);
  assert.match(result.errors.join('\n'), /assetsDir must be a string/);
  assert.match(result.errors.join('\n'), /images\[0\] path must be a string/);
  assert.match(result.errors.join('\n'), /images\[1\] must be an object/);
});

test('validateArticlePackage accepts existing referenced files', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wxpub-package-'));
  const coverPath = path.join(tmpDir, 'cover.png');
  fs.writeFileSync(coverPath, 'fake image');

  const result = validateArticlePackage(
    validArticle({ coverMediaId: '', coverPath, images: [] }),
    { checkFiles: true }
  );

  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
});
