const RISKY_DISPLAY_VALUES = new Set(['flex', 'inline-flex', 'grid', 'inline-grid']);
const RISKY_STYLE_PROPS = new Set([
  'align-content',
  'align-items',
  'align-self',
  'flex',
  'flex-basis',
  'flex-direction',
  'flex-flow',
  'flex-grow',
  'flex-shrink',
  'flex-wrap',
  'gap',
  'grid',
  'grid-area',
  'grid-auto-columns',
  'grid-auto-flow',
  'grid-auto-rows',
  'grid-column',
  'grid-column-end',
  'grid-column-gap',
  'grid-column-start',
  'grid-gap',
  'grid-row',
  'grid-row-end',
  'grid-row-gap',
  'grid-row-start',
  'grid-template',
  'grid-template-areas',
  'grid-template-columns',
  'grid-template-rows',
  'justify-content',
  'justify-items',
  'justify-self',
  'min-width',
  'place-content',
  'place-items',
  'place-self',
]);

const COMPAT_MODE_EDITOR_SAFE = 'wechat-editor-safe';
const COMPAT_MODE_CLIPBOARD_HTML = 'wechat-clipboard-html';
const WECHAT_COMPAT_MODES = new Set([
  COMPAT_MODE_EDITOR_SAFE,
  COMPAT_MODE_CLIPBOARD_HTML,
]);

function normalizeWechatCompatMode(value = {}) {
  const explicit = value.compat_mode || value.compatMode;
  if (explicit) return String(explicit);

  return value.wechat_compat === '1'
    || value.wechat_compat === true
    || value.wechatCompat === true
    || value.wechatCompat === '1'
    ? COMPAT_MODE_EDITOR_SAFE
    : '';
}

function isKnownWechatCompatMode(mode) {
  return !mode || WECHAT_COMPAT_MODES.has(mode);
}

function applyWechatCompatMode(html, value = {}) {
  const mode = normalizeWechatCompatMode(value);
  if (mode === COMPAT_MODE_EDITOR_SAFE) return transformForWeChatEditor(html);
  return html;
}

function findClipboardHtmlApiSafetyIssues(html) {
  const text = String(html || '');
  const issues = [];

  if (/file:\/\//i.test(text)) issues.push('file:// URLs');
  if (/data:image\//i.test(text)) issues.push('data:image URLs');
  if (/\{\{[^}]+\}\}/.test(text)) issues.push('template placeholders');

  for (const src of extractImageSrcs(text)) {
    if (looksLikeLocalAbsolutePath(src)) issues.push(`local image path: ${src}`);
  }

  return issues;
}

function transformForWeChatEditor(html, opts = {}) {
  if (!html || typeof html !== 'string') return html;

  let output = html;
  output = replaceSvgDecorations(output);
  output = rewriteStyleAttributes(output);
  output = rewriteTableTags(output);
  output = opts.addMarker === false ? output : addCompatMarker(output);
  return output;
}

function rewriteStyleAttributes(html) {
  return html.replace(/\sstyle=(["'])([\s\S]*?)\1/gi, (_match, quote, style) => {
    const rewritten = rewriteStyle(style);
    return rewritten ? ` style=${quote}${rewritten}${quote}` : '';
  });
}

function rewriteStyle(style) {
  const parts = String(style)
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean);
  const kept = [];

  for (const part of parts) {
    const idx = part.indexOf(':');
    if (idx === -1) continue;
    const prop = part.slice(0, idx).trim().toLowerCase();
    const value = part.slice(idx + 1).trim();
    if (!prop || !value) continue;
    if (shouldDropDeclaration(prop, value)) continue;
    kept.push(`${prop}:${value}`);
  }

  return kept.join(';');
}

function shouldDropDeclaration(prop, value) {
  const normalized = value.toLowerCase().replace(/\s*!important\s*$/, '');
  if (prop === 'display' && RISKY_DISPLAY_VALUES.has(normalized)) return true;
  if (RISKY_STYLE_PROPS.has(prop)) return true;

  if (prop === 'max-width') {
    const match = normalized.match(/^(\d+(?:\.\d+)?)px$/);
    if (match && Number(match[1]) > 430) return true;
  }

  if (prop === 'width') {
    const match = normalized.match(/^(\d+(?:\.\d+)?)px$/);
    if (match && Number(match[1]) > 430) return true;
  }

  if (prop === 'white-space' && normalized === 'nowrap') return true;
  if (prop === 'writing-mode') return true;
  if (prop.startsWith('column')) return true;

  return false;
}

function replaceSvgDecorations(html) {
  return html.replace(/<svg\b[\s\S]*?<\/svg>/gi, () => (
    '<span style="display:block;margin:0 auto;width:72px;height:72px;line-height:72px;text-align:center;border:2px solid #4d4f46;border-radius:36px;color:#4d4f46;font-size:18px;font-weight:700;">AI</span>'
  ));
}

function rewriteTableTags(html) {
  return html
    .replace(/<table\b([^>]*)>/gi, (_match, attrs) => (
      `<section${stripStyleAttribute(attrs)} style="display:block;width:100%;border:1px solid #d8d9d1;border-radius:6px;padding:8px;margin:12px 0;">`
    ))
    .replace(/<\/table>/gi, '</section>')
    .replace(/<thead\b[^>]*>/gi, '<section style="display:block;">')
    .replace(/<\/thead>/gi, '</section>')
    .replace(/<tbody\b[^>]*>/gi, '<section style="display:block;">')
    .replace(/<\/tbody>/gi, '</section>')
    .replace(/<tr\b[^>]*>/gi, '<section style="display:block;border-bottom:1px solid #d8d9d1;padding:8px 0;">')
    .replace(/<\/tr>/gi, '</section>')
    .replace(/<t[hd]\b([^>]*)>/gi, (_match, attrs) => (
      `<p${stripStyleAttribute(attrs)} style="margin:0 0 4px;font-size:14px;line-height:1.7;color:#4d4f46;">`
    ))
    .replace(/<\/t[hd]>/gi, '</p>');
}

function stripStyleAttribute(attrs = '') {
  return String(attrs).replace(/\sstyle=(["'])[\s\S]*?\1/gi, '');
}

function extractImageSrcs(html) {
  const srcs = new Set();
  const imgRegex = /<img[^>]+src=["']([^"']+)["'][^>]*>/gi;
  let match;
  while ((match = imgRegex.exec(html)) !== null) srcs.add(match[1]);
  return [...srcs];
}

function stripQuery(value) {
  return String(value).split('?')[0].split('#')[0];
}

function looksLikeLocalAbsolutePath(value) {
  const src = stripQuery(value).replace(/\\/g, '/');
  return /^file:\/\//i.test(src)
    || /^\/(?:Users|Volumes|private|tmp|var|home)\//i.test(src)
    || /^[a-zA-Z]:\//.test(src);
}

function addCompatMarker(html) {
  if (/data-wx-compat=/.test(html)) return html;
  return html.replace(/<section\b/i, '<section data-wx-compat="editor-safe"');
}

function hasRiskyWechatLayout(html) {
  const text = String(html || '');
  return /display\s*:\s*(inline-)?flex/i.test(text)
    || /display\s*:\s*(inline-)?grid/i.test(text)
    || /<svg\b/i.test(text)
    || /<table\b/i.test(text)
    || /max-width\s*:\s*(?:4[4-9]\d|[5-9]\d\d|[1-9]\d{3,})px/i.test(text)
    || /writing-mode\s*:/i.test(text)
    || /column-count\s*:/i.test(text);
}

module.exports = {
  COMPAT_MODE_CLIPBOARD_HTML,
  COMPAT_MODE_EDITOR_SAFE,
  applyWechatCompatMode,
  findClipboardHtmlApiSafetyIssues,
  hasRiskyWechatLayout,
  isKnownWechatCompatMode,
  normalizeWechatCompatMode,
  transformForWeChatEditor,
  rewriteStyle,
};
