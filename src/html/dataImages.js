const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DATA_IMAGE_SRC_RE =
  /src=(["'])(data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=\s]+)\1/gi;

function parseDataImageUrl(dataUrl) {
  const compact = String(dataUrl || '').replace(/\s+/g, '');
  const match = compact.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/i);
  if (!match) return null;
  return {
    mime: match[1].toLowerCase(),
    buffer: Buffer.from(match[2], 'base64'),
    ext: mimeToExt(match[1]),
  };
}

function mimeToExt(mime) {
  const type = String(mime || '').toLowerCase();
  if (type.includes('jpeg') || type.includes('jpg')) return '.jpg';
  if (type.includes('gif')) return '.gif';
  if (type.includes('webp')) return '.webp';
  if (type.includes('svg')) return '.svg';
  return '.png';
}

function countHtmlImages(html) {
  return (String(html || '').match(/<img\b/gi) || []).length;
}

/**
 * Replace data:image srcs with short tokens and write decoded files.
 * Keeps create-auto / WeChat content under field-size limits.
 */
function materializeClipboardDataImages(html, tmpDir) {
  const outDir = tmpDir || fs.mkdtempSync(path.join(os.tmpdir(), 'wxrelay-dataimg-'));
  fs.mkdirSync(outDir, { recursive: true });

  const images = [];
  let index = 0;
  const nextHtml = String(html || '').replace(DATA_IMAGE_SRC_RE, (_full, quote, dataUrl) => {
    const parsed = parseDataImageUrl(dataUrl);
    if (!parsed || !parsed.buffer.length) return _full;

    index += 1;
    const filename = `clipboard-inline-${index}${parsed.ext}`;
    const filePath = path.join(outDir, filename);
    fs.writeFileSync(filePath, parsed.buffer);
    const token = `wxrelay-inline://${filename}`;
    images.push({ src: token, path: filePath, filename });
    return `src=${quote}${token}${quote}`;
  });

  return { html: nextHtml, images, tmpDir: outDir };
}

module.exports = {
  countHtmlImages,
  materializeClipboardDataImages,
  parseDataImageUrl,
};
