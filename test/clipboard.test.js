const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const {
  applyClipboardHtmlToArticle,
  buildSelectScript,
  defaultOutArticlePath,
  parseCaptureArgs,
  previewToUrl,
} = require('../src/clipboard/capture');

test('parseCaptureArgs parses clipboard capture options', () => {
  const args = parseCaptureArgs([
    './preview.html',
    '--out',
    './clipboard.html',
    '--article',
    './article.json',
    '--out-article',
    './article.clipboard.json',
    '--selector',
    '#content',
    '--browser',
    'safari',
    '--wait-ms',
    '2500',
  ]);

  assert.equal(args.preview, './preview.html');
  assert.equal(args.out, './clipboard.html');
  assert.equal(args.article, './article.json');
  assert.equal(args.outArticle, './article.clipboard.json');
  assert.equal(args.selector, '#content');
  assert.equal(args.browser, 'safari');
  assert.equal(args.waitMs, 2500);
});

test('parseCaptureArgs parses Playwright engine options', () => {
  const args = parseCaptureArgs([
    './preview.html',
    '--engine',
    'playwright',
    '--headed',
  ]);

  assert.equal(args.engine, 'playwright');
  assert.equal(args.headless, false);
});

test('parseCaptureArgs can read article path from positional argument', () => {
  const args = parseCaptureArgs(['./preview.html', './article.json'], {
    articleFromPosition: true,
    requireArticle: true,
  });

  assert.equal(args.preview, './preview.html');
  assert.equal(args.article, './article.json');
});

test('applyClipboardHtmlToArticle sets clipboard mode and removes legacy flags', () => {
  const article = applyClipboardHtmlToArticle({
    title: '标题',
    content: '<section>old</section>',
    compat_mode: 'wechat-editor-safe',
    wechatCompat: true,
  }, '<meta charset="utf-8"><section>clipboard</section>');

  assert.equal(article.title, '标题');
  assert.equal(article.contentHtml, '<meta charset="utf-8"><section>clipboard</section>');
  assert.equal(article.compatMode, 'wechat-clipboard-html');
  assert.equal(article.content, undefined);
  assert.equal(article.compat_mode, undefined);
  assert.equal(article.wechatCompat, undefined);
});

test('previewToUrl converts local paths to file URLs', () => {
  const url = previewToUrl('./preview.html');

  assert.match(url, /^file:\/\//);
  assert.match(url, /preview\.html$/);
});

test('defaultOutArticlePath inserts clipboard suffix before extension', () => {
  assert.equal(
    defaultOutArticlePath(path.join('out', 'article.json')),
    path.join('out', 'article.clipboard.json')
  );
});

test('buildSelectScript targets the requested selector', () => {
  const script = buildSelectScript('#gzh-content');

  assert.match(script, /querySelector/);
  assert.match(script, /#gzh-content/);
  assert.match(script, /createRange/);
});
