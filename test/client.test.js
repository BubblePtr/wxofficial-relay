const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const WxClient = require('../client');

test('createDraftAuto includes WeChat compatibility fields in multipart payload', async () => {
  const client = WxClient.create({ serverUrl: 'https://relay.example.test', apiKey: 'test-key' });
  client._postForm = async (_route, form) => form;

  const form = await client.createDraftAuto({
    title: '标题',
    author: 'Kieran',
    digest: '摘要',
    contentHtml: '<section>正文</section>',
    coverMediaId: 'cover-media-id',
    compatMode: 'wechat-editor-safe',
    wechatCompat: true,
  });

  const body = form.getBuffer().toString('utf8');
  assert.match(body, /name="compat_mode"/);
  assert.match(body, /wechat-editor-safe/);
  assert.match(body, /name="wechat_compat"/);
});

test('createDraftAuto can request clipboard HTML compatibility mode without legacy downgrade flag', async () => {
  const client = WxClient.create({ serverUrl: 'https://relay.example.test', apiKey: 'test-key' });
  client._postForm = async (_route, form) => form;

  const form = await client.createDraftAuto({
    title: '标题',
    contentHtml: '<meta charset="utf-8"><section style="display:flex">正文</section>',
    coverMediaId: 'cover-media-id',
    compatMode: 'wechat-clipboard-html',
  });

  const body = form.getBuffer().toString('utf8');
  assert.match(body, /name="compat_mode"/);
  assert.match(body, /wechat-clipboard-html/);
  assert.doesNotMatch(body, /name="wechat_compat"/);
});

test('createDraftAuto materializes clipboard data:image srcs into uploaded files', async () => {
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const client = WxClient.create({ serverUrl: 'https://relay.example.test', apiKey: 'test-key' });
  client._postForm = async (_route, form) => form;

  const form = await client.createDraftAuto({
    title: '标题',
    contentHtml: `<section><img src="data:image/png;base64,${png}"></section>`,
    coverMediaId: 'cover-media-id',
    compatMode: 'wechat-clipboard-html',
  });

  const textParts = form._streams.filter((part) => typeof part === 'string').join('\n');
  assert.match(textParts, /wxrelay-inline:\/\/clipboard-inline-1\.png/);
  assert.doesNotMatch(textParts, /data:image\/png;base64,/);
  assert.match(textParts, /name="images"/);
  assert.match(textParts, /clipboard-inline-1\.png/);
});

test('loopback preview image URLs are eligible for local asset upload', () => {
  const { isLoopbackHttpUrl, resolveLocalAssetPath, shouldSkipImageSrc } = WxClient._internals;
  const assetsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wxrelay-assets-'));
  const imagePath = path.join(assetsDir, 'inline.png');
  fs.writeFileSync(imagePath, 'png');

  assert.equal(isLoopbackHttpUrl('http://127.0.0.1:5173/assets/inline.png'), true);
  assert.equal(isLoopbackHttpUrl('http://localhost:5173/assets/inline.png'), true);
  assert.equal(isLoopbackHttpUrl('https://cdn.example.test/assets/inline.png'), false);

  assert.equal(shouldSkipImageSrc('http://127.0.0.1:5173/assets/inline.png'), false);
  assert.equal(shouldSkipImageSrc('https://cdn.example.test/assets/inline.png'), true);
  assert.equal(resolveLocalAssetPath(assetsDir, 'http://127.0.0.1:5173/assets/inline.png'), imagePath);
});
