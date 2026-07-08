const assert = require('node:assert/strict');
const test = require('node:test');

const {
  COMPAT_MODE_CLIPBOARD_HTML,
  COMPAT_MODE_EDITOR_SAFE,
  applyWechatCompatMode,
  findClipboardHtmlApiSafetyIssues,
  hasRiskyWechatLayout,
  normalizeWechatCompatMode,
  rewriteStyle,
  transformForWeChatEditor,
} = require('../src/html/wechatCompat');

test('rewriteStyle removes layout declarations that break WeChat editor drafts', () => {
  const style = rewriteStyle('display:flex;align-items:center;gap:8px;max-width:677px;color:#23251d;background:#fdfdf8');

  assert.equal(style, 'color:#23251d;background:#fdfdf8');
});

test('transformForWeChatEditor preserves visual tokens while removing risky layout', () => {
  const html = `
<section style="display:flex;align-items:center;gap:18px;max-width:677px;background:#fdfdf8;border:1px solid #bfc1b7;">
  <section style="flex:1;min-width:0;color:#23251d;"><p>Loop Engineering</p></section>
  <section style="flex-shrink:0;width:112px;"><svg viewBox="0 0 64 64"><circle cx="1" cy="1" r="1"></circle></svg></section>
</section>`;

  const result = transformForWeChatEditor(html);

  assert.equal(hasRiskyWechatLayout(result), false);
  assert.doesNotMatch(result, /display:flex/i);
  assert.doesNotMatch(result, /<svg/i);
  assert.match(result, /background:#fdfdf8/);
  assert.match(result, /border:1px solid #bfc1b7/);
  assert.match(result, /Loop Engineering/);
  assert.match(result, /data-wx-compat="editor-safe"/);
});

test('transformForWeChatEditor downgrades table tags to block sections', () => {
  const html = '<section><table style="display:grid;max-width:677px" data-kind="loops"><tr><th style="color:red">类型</th><td>Turn-based</td></tr></table></section>';
  const result = transformForWeChatEditor(html);

  assert.equal(hasRiskyWechatLayout(result), false);
  assert.doesNotMatch(result, /<table/i);
  assert.doesNotMatch(result, /<tr/i);
  assert.doesNotMatch(result, /<td/i);
  assert.doesNotMatch(result, /style="[^"]*"\s+style="/i);
  assert.match(result, /data-kind="loops"/);
  assert.match(result, /Turn-based/);
});

test('transformForWeChatEditor handles an olive-journal style snippet', () => {
  const html = `
<section style="width:100%;max-width:677px;background:#fdfdf8;border:1px solid #bfc1b7;">
  <section style="display:flex;align-items:stretch;gap:18px;">
    <section style="flex:1;min-width:0;">
      <p style="font-size:24px;color:#23251d;letter-spacing:-0.75px;">Loop Engineering · 控制系统</p>
    </section>
    <section style="flex-shrink:0;width:112px;background:#eeefe9;border:1px dashed #bfc1b7;">
      <svg width="72" height="72" viewBox="0 0 64 64"></svg>
      <span>DOODLE</span>
    </section>
  </section>
</section>`;

  const result = transformForWeChatEditor(html);

  assert.equal(hasRiskyWechatLayout(result), false);
  assert.doesNotMatch(result, /display:flex/i);
  assert.doesNotMatch(result, /<svg/i);
  assert.doesNotMatch(result, /max-width:677px/i);
  assert.match(result, /#fdfdf8/);
  assert.match(result, /#bfc1b7/);
  assert.match(result, /DOODLE/);
  assert.match(result, /Loop Engineering/);
});

test('normalizeWechatCompatMode keeps legacy boolean flags mapped to editor-safe mode', () => {
  assert.equal(normalizeWechatCompatMode({ compatMode: COMPAT_MODE_CLIPBOARD_HTML }), COMPAT_MODE_CLIPBOARD_HTML);
  assert.equal(normalizeWechatCompatMode({ compat_mode: COMPAT_MODE_EDITOR_SAFE }), COMPAT_MODE_EDITOR_SAFE);
  assert.equal(normalizeWechatCompatMode({ wechatCompat: true }), COMPAT_MODE_EDITOR_SAFE);
  assert.equal(normalizeWechatCompatMode({ wechat_compat: '1' }), COMPAT_MODE_EDITOR_SAFE);
  assert.equal(normalizeWechatCompatMode({}), '');
});

test('applyWechatCompatMode preserves clipboard HTML in clipboard mode', () => {
  const html = '<meta charset="utf-8"><section style="display:flex;color:rgb(35, 37, 29)"><svg viewBox="0 0 64 64"></svg><p>Loop Engineering</p></section>';
  const result = applyWechatCompatMode(html, { compatMode: COMPAT_MODE_CLIPBOARD_HTML });

  assert.equal(result, html);
  assert.match(result, /<meta charset="utf-8">/);
  assert.match(result, /display:flex/);
  assert.match(result, /<svg/i);
});

test('applyWechatCompatMode leaves default content unchanged', () => {
  const html = '<section style="display:flex"><svg></svg><p>Default path</p></section>';

  assert.equal(applyWechatCompatMode(html, {}), html);
});

test('applyWechatCompatMode downgrades layout in editor-safe mode', () => {
  const html = '<section style="display:flex;max-width:677px"><svg></svg><p>Loop Engineering</p></section>';
  const result = applyWechatCompatMode(html, { compatMode: COMPAT_MODE_EDITOR_SAFE });

  assert.equal(hasRiskyWechatLayout(result), false);
  assert.doesNotMatch(result, /display:flex/i);
  assert.doesNotMatch(result, /<svg/i);
  assert.match(result, /data-wx-compat="editor-safe"/);
});

test('findClipboardHtmlApiSafetyIssues accepts API-ready clipboard HTML', () => {
  const html = '<meta charset="utf-8"><section style="display:flex"><img src="https://mmbiz.qpic.cn/example.png"><p>Loop Engineering</p></section>';

  assert.deepEqual(findClipboardHtmlApiSafetyIssues(html), []);
});

test('findClipboardHtmlApiSafetyIssues reports unresolved unsafe clipboard inputs', () => {
  const html = '<section>{{title}}<img src="file:///Users/kieran/a.png"><img src="data:image/png;base64,abc"><img src="/Users/kieran/b.png"></section>';
  const issues = findClipboardHtmlApiSafetyIssues(html);

  assert.match(issues.join('\n'), /template placeholders/);
  assert.match(issues.join('\n'), /file:\/\/ URLs/);
  assert.match(issues.join('\n'), /data:image URLs/);
  assert.match(issues.join('\n'), /local image path: file:\/\/\/Users\/kieran\/a.png/);
  assert.match(issues.join('\n'), /local image path: \/Users\/kieran\/b.png/);
});
