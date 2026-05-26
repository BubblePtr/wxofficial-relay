const assert = require('node:assert/strict');
const test = require('node:test');

const {
  renderWechatHtml,
  renderPreviewHtml,
  parseMarkdownDocument,
  sanitizeHref,
  readCliArgs,
  THEMES,
} = require('../typesetter');

test('readCliArgs parses optional theme flag', () => {
  assert.deepEqual(readCliArgs(['preview', 'article.md', '--theme', 'classic', '-o', 'preview.html']), {
    command: 'preview',
    inputPath: 'article.md',
    outputPath: 'preview.html',
    theme: 'classic',
  });
});

test('classic theme matches the old tool: white background, black Georgia body, pink headings', () => {
  assert.ok(THEMES.classic);
  assert.match(THEMES.classic.wrapper, /background:#fff/);
  assert.match(THEMES.classic.wrapper, /color:#000/);
  assert.match(THEMES.classic.wrapper, /font-size:16px/);
  assert.match(THEMES.classic.wrapper, /font-family:Georgia/);
  assert.match(THEMES.classic.h1, /color:#d86b8f/);
  assert.match(THEMES.classic.h2, /color:#d86b8f/);
  assert.doesNotMatch(THEMES.classic.strong, /background:/);
  assert.match(THEMES.classic.blockquote, /background:#f7f7f7/);
  assert.match(THEMES.classic.blockquote, /border-left:5px solid #d0d0d0/);
  assert.match(THEMES.classic.blockquote, /padding:14px 18px/);
  assert.match(THEMES.classic.hr, /display:none/);

  const html = renderWechatHtml('# 标题\n\n正文 **加粗**\n\n---\n\n## 小标题', { theme: 'classic' });
  assert.match(html, /background:#fff/);
  assert.match(html, /font-family:Georgia/);
  assert.match(html, /<h1 style="[^"]*color:#d86b8f/);
  assert.match(html, /<h2 style="[^"]*color:#d86b8f/);
  assert.doesNotMatch(html, /background:#fffdf7/);
});

test('warm theme uses maize-inspired clean layout with yellow-orange accents', () => {
  assert.ok(THEMES.warm);
  assert.match(THEMES.warm.wrapper, /background:#fff/);
  assert.match(THEMES.warm.wrapper, /font-size:16px/);
  assert.match(THEMES.warm.wrapper, /font-family:-apple-system/);
  assert.match(THEMES.warm.h2, /border-left:4px solid #ffb11b/);
  assert.match(THEMES.warm.blockquote, /background:#fff9f2/);
  assert.match(THEMES.warm.blockquote, /border-left:3px solid #ffb11b/);
  assert.doesNotMatch(THEMES.warm.h1, /color:#d86b8f/);

  const html = renderWechatHtml('# 标题\n\n正文 **加粗**\n\n> 引用\n\n## 小标题', { theme: 'warm' });
  assert.match(html, /data-role="wechat-typesetter"/);
  assert.match(html, /<h2 style="[^"]*border-left:4px solid #ffb11b/);
  assert.match(html, /<blockquote style="[^"]*background:#fff9f2/);
  assert.match(html, /<strong style="[^"]*color:#9a5b00/);
});

test('parseMarkdownDocument extracts simple YAML frontmatter and body', () => {
  const doc = parseMarkdownDocument('---\ntitle: 本地排版测试\nauthor: Bubble\ndigest: 第一版文字排版\n---\n\n# 标题\n\n正文');

  assert.deepEqual(doc.meta, {
    title: '本地排版测试',
    author: 'Bubble',
    digest: '第一版文字排版',
  });
  assert.equal(doc.body.trim(), '# 标题\n\n正文');
});

test('renderWechatHtml turns core markdown into inline-styled WeChat-safe HTML', () => {
  const html = renderWechatHtml(`# 一级标题\n\n## 二级标题\n\n正文 **加粗** 和 *强调*。\n\n> 引用内容\n\n- 第一项\n- 第二项\n\n\`inline code\`\n\n\`\`\`js\nconsole.log('hi')\n\`\`\`\n\n---\n\n![说明](./assets/a.png)`);

  assert.match(html, /<section[^>]+data-role="wechat-typesetter"/);
  assert.match(html, /<h1 style="[^"]+">一级标题<\/h1>/);
  assert.match(html, /<h2 style="[^"]+">二级标题<\/h2>/);
  assert.match(html, /<p style="[^"]+">正文 <strong style="[^"]+">加粗<\/strong> 和 <em style="[^"]+">强调<\/em>。<\/p>/);
  assert.match(html, /<blockquote style="[^"]+">/);
  assert.match(html, /<ul style="[^"]+">/);
  assert.match(html, /<code style="[^"]+">inline code<\/code>/);
  assert.match(html, /<pre style="[^"]+">[\s\S]*<code style="[^"]+">[\s\S]*console[\s\S]*log[\s\S]*hi[\s\S]*<\/code><\/pre>/);
  assert.match(html, /<hr style="[^"]+">/);
  assert.match(html, /<img src="\.\/assets\/a\.png" alt="说明" style="[^"]+">/);
  assert.doesNotMatch(html, /<style[\s>]/i);
  assert.doesNotMatch(html, /class="/i);
});

test('renderWechatHtml highlights fenced code without CSS classes and keeps mobile horizontal scroll', () => {
  const html = renderWechatHtml("```js\nconst answer = 42\nconsole.log('hi', answer)\n```", { theme: 'warm' });

  assert.match(html, /<pre style="[^"]*background:#fff/);
  assert.match(html, /<pre style="[^"]*border:1px solid #ead7b8/);
  assert.match(html, /background:#ff5f57/);
  assert.match(html, /background:#febc2e/);
  assert.match(html, /background:#28c840/);
  assert.match(html, /<code style="[^"]*overflow-x:auto/);
  assert.match(html, /<code style="[^"]*max-width:100%/);
  assert.match(html, /<code style="[^"]*display:block/);
  assert.match(html, /<code style="[^"]*white-space:pre/);
  assert.match(html, /<span style="[^"]+">const<\/span>/);
  assert.match(html, /<span style="[^"]+">42<\/span>/);
  assert.doesNotMatch(html, /class="/i);
});

test('renderWechatHtml escapes raw html by default', () => {
  const html = renderWechatHtml('正文 <script>alert(1)</script>');

  assert.doesNotMatch(html, /<script>/i);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
});

test('renderWechatHtml does not emit dangerous href attributes for unsafe schemes', () => {
  const html = renderWechatHtml('[unsafe](javascript:alert(1))');

  assert.match(html, /unsafe/);
  assert.doesNotMatch(html, /href="javascript:/i);
});

test('sanitizeHref allows publishing-safe links and rejects unsafe protocols', () => {
  assert.equal(sanitizeHref('https://example.com'), 'https://example.com');
  assert.equal(sanitizeHref('./local-page'), './local-page');
  assert.equal(sanitizeHref('#section'), '#section');
  assert.equal(sanitizeHref('javascript:alert(1)'), '');
  assert.equal(sanitizeHref('data:text/html;base64,abc'), '');
});

test('renderPreviewHtml wraps content in a full preview document', () => {
  const html = renderPreviewHtml('# 预览标题', { title: '预览页' });

  assert.match(html, /^<!doctype html>/i);
  assert.match(html, /<title>预览页<\/title>/);
  assert.match(html, /data-role="wechat-typesetter"/);
});
