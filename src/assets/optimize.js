const fs = require('fs');
const path = require('path');

const SUPPORTED_IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif']);

function listPackageAssets(assetsDir) {
  if (!assetsDir || !fs.existsSync(assetsDir)) return [];
  return fs.readdirSync(assetsDir)
    .filter((name) => SUPPORTED_IMAGE_EXTENSIONS.has(path.extname(name).toLowerCase()))
    .map((name) => path.join(assetsDir, name));
}

async function optimizeAssets(assetsDir, opts = {}) {
  // Minimal landing version: discovery + validation hook only.
  // Real compression can be added behind this function without changing callers.
  const files = listPackageAssets(assetsDir);
  return {
    ok: true,
    assetsDir,
    count: files.length,
    files,
    mode: opts.mode || 'passthrough',
  };
}

module.exports = {
  SUPPORTED_IMAGE_EXTENSIONS,
  listPackageAssets,
  optimizeAssets,
};
