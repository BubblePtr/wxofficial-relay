#!/usr/bin/env node
/**
 * Local-first Markdown -> WeChat Official Account HTML renderer.
 *
 * The WeChat editor is picky: keep output boring, inline-styled, and free of
 * classes / external CSS. Images remain as original src values; the relay will
 * upload local files and replace src with WeChat CDN URLs later.
 */

const fs = require('fs');
const path = require('path');
const MarkdownIt = require('markdown-it');
const hljs = require('highlight.js/lib/core');
const javascript = require('highlight.js/lib/languages/javascript');
const typescript = require('highlight.js/lib/languages/typescript');
const json = require('highlight.js/lib/languages/json');
const bash = require('highlight.js/lib/languages/bash');
const python = require('highlight.js/lib/languages/python');

hljs.registerLanguage('javascript', javascript);
hljs.registerLanguage('js', javascript);
hljs.registerLanguage('typescript', typescript);
hljs.registerLanguage('ts', typescript);
hljs.registerLanguage('json', json);
hljs.registerLanguage('bash', bash);
hljs.registerLanguage('sh', bash);
hljs.registerLanguage('python', python);
hljs.registerLanguage('py', python);

const THEMES = {
  clean: {
    wrapper: 'box-sizing:border-box;margin:0 auto;padding:0 0 6px 0;color:#1f2933;font-size:16px;line-height:1.84;letter-spacing:0.015em;font-family:-apple-system,BlinkMacSystemFont,Helvetica Neue,Helvetica,PingFang SC,Hiragino Sans GB,Microsoft YaHei,Arial,sans-serif;',
    h1: 'margin:0 0 20px 0;padding:0 0 11px 0;color:#111827;font-size:24px;line-height:1.38;font-weight:800;border-bottom:1px solid #e5e7eb;',
    h2: 'margin:30px 0 13px 0;padding:0 0 0 10px;color:#111827;font-size:20px;line-height:1.45;font-weight:750;border-left:4px solid #111827;',
    h3: 'margin:24px 0 10px 0;color:#1f2937;font-size:17px;line-height:1.5;font-weight:700;',
    p: 'margin:0 0 16px 0;color:#374151;font-size:16px;line-height:1.86;',
    strong: 'font-weight:700;color:#111827;',
    em: 'font-style:italic;color:#4b5563;',
    blockquote: 'margin:20px 0;padding:12px 14px;color:#4b5563;background:#f8fafc;border-left:4px solid #94a3b8;border-radius:0 9px 9px 0;',
    ul: 'margin:0 0 16px 0;padding:0 0 0 22px;color:#374151;line-height:1.86;',
    ol: 'margin:0 0 16px 0;padding:0 0 0 22px;color:#374151;line-height:1.86;',
    li: 'margin:5px 0;color:#374151;font-size:16px;line-height:1.82;',
    code_inline: 'padding:2px 5px;margin:0 1px;color:#b91c1c;background:#fef2f2;border-radius:5px;font-size:13px;font-family:SFMono-Regular,Consolas,Liberation Mono,Menlo,monospace;',
    pre: 'margin:20px 0;padding:14px;max-width:100%;overflow-x:auto;overflow-y:hidden;-webkit-overflow-scrolling:touch;color:#e5e7eb;background:#111827;border-radius:9px;font-size:12px;line-height:1.65;font-family:SFMono-Regular,Consolas,Liberation Mono,Menlo,monospace;',
    code_block: 'display:block;min-width:max-content;color:#e5e7eb;background:transparent;font-size:12px;line-height:1.65;font-family:SFMono-Regular,Consolas,Liberation Mono,Menlo,monospace;white-space:pre;',
    hr: 'margin:26px 0;border:0;border-top:1px solid #e5e7eb;',
    img: 'display:block;max-width:100%;height:auto;margin:20px auto;border-radius:9px;',
    a: 'color:#2563eb;text-decoration:none;border-bottom:1px solid #bfdbfe;',
  },
  warm: {
    wrapper: 'box-sizing:border-box;margin:0 auto;padding:0;background:#fff;color:#333;font-size:16px;line-height:1.78;letter-spacing:0.01em;font-family:-apple-system,BlinkMacSystemFont,Helvetica Neue,Helvetica,PingFang SC,Hiragino Sans GB,Microsoft YaHei,Arial,sans-serif;',
    h1: 'margin:28px 0 20px 0;padding:0;color:#2f2f2f;font-size:24px;line-height:1.42;font-weight:800;text-align:left;',
    h2: 'margin:30px 0 14px 0;padding:0 0 0 10px;color:#2f2f2f;font-size:20px;line-height:1.45;font-weight:800;border-left:4px solid #ffb11b;',
    h3: 'margin:24px 0 12px 0;padding:0;color:#3f3f3f;font-size:18px;line-height:1.48;font-weight:700;',
    p: 'margin:0 0 17px 0;color:#333;font-size:16px;line-height:1.78;text-align:left;',
    strong: 'font-weight:700;color:#9a5b00;',
    em: 'font-style:italic;color:#5f5f5f;',
    blockquote: 'margin:20px 0;padding:12px 14px;color:#6a737d;background:#fff9f2;border-left:3px solid #ffb11b;font-size:15px;line-height:1.75;',
    ul: 'margin:0 0 17px 0;padding:0 0 0 22px;color:#333;font-size:16px;line-height:1.78;',
    ol: 'margin:0 0 17px 0;padding:0 0 0 22px;color:#333;font-size:16px;line-height:1.78;',
    li: 'margin:5px 0;color:#333;font-size:16px;line-height:1.76;',
    code_inline: 'padding:2px 5px;margin:0 1px;color:#9a5b00;background:#fff4d6;border-radius:4px;font-size:13px;font-family:SFMono-Regular,Consolas,Liberation Mono,Menlo,monospace;',
    pre: 'margin:20px 0;max-width:100%;overflow:hidden;color:#333;background:#fff;border:1px solid #ead7b8;border-radius:8px;font-size:13px;line-height:1.68;font-family:SFMono-Regular,Consolas,Liberation Mono,Menlo,monospace;',
    code_header: 'display:block;padding:8px 12px;background:#fffaf2;border-bottom:1px solid #f2dfbd;line-height:1;',
    code_dot_red: 'display:inline-block;width:10px;height:10px;margin-right:6px;border-radius:50%;background:#ff5f57;',
    code_dot_yellow: 'display:inline-block;width:10px;height:10px;margin-right:6px;border-radius:50%;background:#febc2e;',
    code_dot_green: 'display:inline-block;width:10px;height:10px;margin-right:0;border-radius:50%;background:#28c840;',
    code_block: 'display:block;max-width:100%;padding:14px;overflow-x:auto;overflow-y:hidden;-webkit-overflow-scrolling:touch;color:#333;background:#fff;font-size:13px;line-height:1.68;font-family:SFMono-Regular,Consolas,Liberation Mono,Menlo,monospace;white-space:pre;',
    hr: 'margin:26px 0;border:0;border-top:1px solid #f2dfbd;',
    img: 'display:block;max-width:100%;height:auto;margin:20px auto;border-radius:0;',
    a: 'color:#a86600;text-decoration:none;border-bottom:1px solid #f2dfbd;',
  },
  classic: {
    wrapper: 'box-sizing:border-box;margin:0 auto;padding:0;background:#fff;color:#000;font-size:16px;line-height:1.85;letter-spacing:0;font-family:Georgia,Times New Roman,serif;',
    h1: 'margin:24px 0 18px 0;padding:0;color:#d86b8f;font-size:24px;line-height:1.45;font-weight:400;text-align:left;font-family:Georgia,Times New Roman,serif;',
    h2: 'margin:28px 0 14px 0;padding:0;color:#d86b8f;font-size:20px;line-height:1.45;font-weight:400;text-align:left;font-family:Georgia,Times New Roman,serif;',
    h3: 'margin:24px 0 12px 0;padding:0;color:#d86b8f;font-size:18px;line-height:1.45;font-weight:400;text-align:left;font-family:Georgia,Times New Roman,serif;',
    p: 'margin:0 0 18px 0;color:#000;font-size:16px;line-height:1.85;text-align:left;font-family:Georgia,Times New Roman,serif;',
    strong: 'font-weight:700;color:#000;',
    em: 'font-style:italic;color:#000;',
    blockquote: 'margin:18px 0;padding:14px 18px;color:#333;background:#f7f7f7;border-left:5px solid #d0d0d0;font-size:16px;line-height:1.85;font-family:Georgia,Times New Roman,serif;',
    ul: 'margin:0 0 18px 0;padding:0 0 0 22px;color:#000;font-size:16px;line-height:1.85;font-family:Georgia,Times New Roman,serif;',
    ol: 'margin:0 0 18px 0;padding:0 0 0 22px;color:#000;font-size:16px;line-height:1.85;font-family:Georgia,Times New Roman,serif;',
    li: 'margin:4px 0;color:#000;font-size:16px;line-height:1.85;font-family:Georgia,Times New Roman,serif;',
    code_inline: 'padding:0 3px;margin:0 1px;color:#000;background:#f5f5f5;border-radius:3px;font-size:14px;font-family:SFMono-Regular,Consolas,Liberation Mono,Menlo,monospace;',
    pre: 'margin:18px 0;padding:12px;max-width:100%;overflow-x:auto;overflow-y:hidden;-webkit-overflow-scrolling:touch;color:#000;background:#f7f7f7;border-radius:0;font-size:13px;line-height:1.7;font-family:SFMono-Regular,Consolas,Liberation Mono,Menlo,monospace;',
    code_block: 'display:block;min-width:max-content;color:#000;background:transparent;font-size:13px;line-height:1.7;font-family:SFMono-Regular,Consolas,Liberation Mono,Menlo,monospace;white-space:pre;',
    hr: 'display:none;',
    img: 'display:block;max-width:100%;height:auto;margin:20px auto;border-radius:0;',
    a: 'color:#d86b8f;text-decoration:none;',
  },
};

const SYNTAX_STYLES = {
  keyword: 'color:#b45309;font-weight:700;',
  literal: 'color:#b45309;font-weight:700;',
  built_in: 'color:#9a3412;',
  type: 'color:#9a3412;',
  string: 'color:#15803d;',
  number: 'color:#2563eb;',
  regexp: 'color:#15803d;',
  comment: 'color:#8a7a62;font-style:italic;',
  title: 'color:#9a5b00;font-weight:700;',
  function_: 'color:#9a5b00;font-weight:700;',
  attr: 'color:#a86600;',
  property: 'color:#a86600;',
  variable: 'color:#7c3aed;',
  punctuation: 'color:#6b7280;',
  operator: 'color:#6b7280;',
};

function parseMarkdownDocument(input) {
  const text = String(input || '').replace(/^\uFEFF/, '');
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/);
  if (!match) return { meta: {}, body: text };

  const meta = {};
  for (const rawLine of match[1].split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    let value = line.slice(colon + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key) meta[key] = value;
  }

  return { meta, body: match[2] || '' };
}

function renderWechatHtml(input, options = {}) {
  const theme = THEMES[options.theme || 'clean'] || THEMES.clean;
  const { body } = parseMarkdownDocument(input);
  const md = createMarkdownRenderer(theme);
  const rendered = md.render(body).trim();

  return `<section data-role="wechat-typesetter" style="${theme.wrapper}">\n${rendered}\n</section>`;
}

function renderPreviewHtml(input, options = {}) {
  const parsed = parseMarkdownDocument(input);
  const title = escapeHtml(options.title || parsed.meta.title || 'WeChat Preview');
  const body = renderWechatHtml(input, options);

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
  body { margin: 0; background: #f3f4f6; }
  main { box-sizing: border-box; width: min(760px, 100%); min-height: 100vh; margin: 0 auto; padding: 36px 16px; background: #fff; }
</style>
</head>
<body>
<main>
${body}
</main>
</body>
</html>
`;
}

function createMarkdownRenderer(theme) {
  const md = new MarkdownIt({
    html: false,
    linkify: true,
    typographer: false,
    breaks: false,
  });

  md.renderer.rules.heading_open = (tokens, idx) => {
    const level = tokens[idx].tag;
    const style = theme[level] || theme.h3;
    return `<${level} style="${style}">`;
  };
  md.renderer.rules.paragraph_open = (tokens, idx) => (tokens[idx].hidden ? '' : `<p style="${theme.p}">`);
  md.renderer.rules.paragraph_close = (tokens, idx) => (tokens[idx].hidden ? '' : '</p>\n');
  md.renderer.rules.strong_open = () => `<strong style="${theme.strong}">`;
  md.renderer.rules.em_open = () => `<em style="${theme.em}">`;
  md.renderer.rules.blockquote_open = () => `<blockquote style="${theme.blockquote}">`;
  md.renderer.rules.bullet_list_open = () => `<ul style="${theme.ul}">`;
  md.renderer.rules.ordered_list_open = () => `<ol style="${theme.ol}">`;
  md.renderer.rules.list_item_open = () => `<li style="${theme.li}">`;
  md.renderer.rules.code_inline = (tokens, idx) => `<code style="${theme.code_inline}">${escapeHtml(tokens[idx].content)}</code>`;
  md.renderer.rules.fence = (tokens, idx) => {
    const token = tokens[idx];
    const highlighted = highlightCode(token.content, token.info);
    return renderCodeBlock(theme, highlighted);
  };
  md.renderer.rules.code_block = (tokens, idx) => {
    const content = escapeHtml(tokens[idx].content);
    return renderCodeBlock(theme, content);
  };
  md.renderer.rules.hr = () => `<hr style="${theme.hr}">\n`;
  md.renderer.rules.image = (tokens, idx) => {
    const token = tokens[idx];
    const src = escapeHtml(token.attrGet('src') || '');
    const alt = escapeHtml(token.content || token.attrGet('alt') || '');
    const title = token.attrGet('title');
    const titleAttr = title ? ` title="${escapeHtml(title)}"` : '';
    return `<img src="${src}" alt="${alt}" style="${theme.img}"${titleAttr}>`;
  };
  md.renderer.rules.link_open = (tokens, idx) => {
    const href = escapeHtml(tokens[idx].attrGet('href') || '');
    return `<a href="${href}" style="${theme.a}">`;
  };

  return md;
}

function renderCodeBlock(theme, content) {
  const header = theme.code_header
    ? `<section style="${theme.code_header}"><span style="${theme.code_dot_red}"></span><span style="${theme.code_dot_yellow}"></span><span style="${theme.code_dot_green}"></span></section>`
    : '';
  return `<pre style="${theme.pre}">${header}<code style="${theme.code_block}">${content}</code></pre>\n`;
}

function highlightCode(content, info = '') {
  const lang = String(info || '').trim().split(/\s+/)[0].toLowerCase();
  if (!lang || !hljs.getLanguage(lang)) return escapeHtml(content);

  try {
    const highlighted = hljs.highlight(content, { language: lang, ignoreIllegals: true }).value;
    return inlineHighlightStyles(highlighted);
  } catch (_) {
    return escapeHtml(content);
  }
}

function inlineHighlightStyles(highlightedHtml) {
  return highlightedHtml.replace(/<span class="([^"]+)">/g, (_, classNames) => {
    const tokens = classNames
      .split(/\s+/)
      .map((name) => name.replace(/^hljs-/, ''));
    const style = tokens.map((name) => SYNTAX_STYLES[name]).find(Boolean) || '';
    return style ? `<span style="${style}">` : '<span>';
  });
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function printHelp() {
  console.log(`wechat-typesetter

Usage:
  node typesetter.js render <article.md> -o <article.html> [--theme clean|warm|classic]
  node typesetter.js preview <article.md> -o <preview.html> [--theme clean|warm|classic]

Commands:
  render   Output WeChat-compatible inline HTML fragment
  preview  Output a local full HTML preview document
`);
}

function readCliArgs(argv) {
  const [command, inputPath, ...rest] = argv;
  let outputPath = '';
  let theme = 'clean';
  for (let i = 0; i < rest.length; i += 1) {
    if (rest[i] === '-o' || rest[i] === '--output') outputPath = rest[i + 1] || '';
    if (rest[i] === '--theme') theme = rest[i + 1] || 'clean';
  }
  return { command, inputPath, outputPath, theme };
}

function cli(argv = process.argv.slice(2)) {
  const { command, inputPath, outputPath, theme } = readCliArgs(argv);
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    printHelp();
    return;
  }
  if (!['render', 'preview'].includes(command)) throw new Error(`Unknown command: ${command}`);
  if (!inputPath) throw new Error('Missing input markdown path');

  const markdown = fs.readFileSync(inputPath, 'utf-8');
  const html = command === 'preview'
    ? renderPreviewHtml(markdown, { title: parseMarkdownDocument(markdown).meta.title, theme })
    : renderWechatHtml(markdown, { theme });

  if (outputPath) {
    fs.mkdirSync(path.dirname(path.resolve(outputPath)), { recursive: true });
    fs.writeFileSync(outputPath, html);
  } else {
    process.stdout.write(html);
  }
}

module.exports = {
  renderWechatHtml,
  renderPreviewHtml,
  parseMarkdownDocument,
  readCliArgs,
  THEMES,
};

if (require.main === module) {
  try {
    cli();
  } catch (err) {
    console.error(`[ERROR] ${err.message}`);
    process.exit(1);
  }
}
