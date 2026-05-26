const path = require('path');

const articlePackageSchema = {
  title: { type: 'string', required: true, minLength: 1, maxLength: 64 },
  author: { type: 'string', required: false, maxLength: 8 },
  digest: { type: 'string', required: false, maxLength: 120 },
  contentHtml: { type: 'string', required: true, minLength: 1 },
  coverPath: { type: 'string', required: false },
  coverMediaId: { type: 'string', required: false },
  assetsDir: { type: 'string', required: false },
  images: { type: 'array', required: false },
};

function createMinimalArticlePackage(overrides = {}) {
  return {
    title: 'Untitled Article',
    author: '',
    digest: '',
    contentHtml: '<p></p>',
    coverPath: '',
    assetsDir: '',
    images: [],
    ...overrides,
  };
}

function normalizePackagePaths(article, baseDir = process.cwd()) {
  const out = { ...article };
  if (out.coverPath) out.coverPath = resolveMaybeRelative(baseDir, out.coverPath);
  if (out.assetsDir) out.assetsDir = resolveMaybeRelative(baseDir, out.assetsDir);
  if (Array.isArray(out.images)) {
    out.images = out.images.map((image) => ({
      ...image,
      path: image.path ? resolveMaybeRelative(baseDir, image.path) : image.path,
      filePath: image.filePath ? resolveMaybeRelative(baseDir, image.filePath) : image.filePath,
    }));
  }
  return out;
}

function resolveMaybeRelative(baseDir, value) {
  if (!value || path.isAbsolute(value)) return value;
  return path.resolve(baseDir, value);
}

module.exports = {
  articlePackageSchema,
  createMinimalArticlePackage,
  normalizePackagePaths,
};
