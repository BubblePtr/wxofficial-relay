const { execFile } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);

const DEFAULT_SELECTOR = '#gzh-content';
const DEFAULT_BROWSER = 'chrome';
const DEFAULT_ENGINE = 'macos';
const DEFAULT_WAIT_MS = 1200;
const APPLESCRIPT_TIMEOUT_MS = 20000;
const COMPAT_MODE_CLIPBOARD_HTML = 'wechat-clipboard-html';

function parseCaptureArgs(args = {}, opts = {}) {
  const values = Array.isArray(args) ? [...args] : [];
  const positional = [];
  const parsed = {
    browser: DEFAULT_BROWSER,
    engine: DEFAULT_ENGINE,
    headless: true,
    selector: DEFAULT_SELECTOR,
    waitMs: DEFAULT_WAIT_MS,
    out: '',
    article: '',
    outArticle: '',
  };

  for (let i = 0; i < values.length; i += 1) {
    const arg = values[i];
    if (arg === '--browser') parsed.browser = requireOptionValue(values, ++i, arg);
    else if (arg === '--engine') parsed.engine = requireOptionValue(values, ++i, arg);
    else if (arg === '--headless') parsed.headless = true;
    else if (arg === '--headed') parsed.headless = false;
    else if (arg === '--selector') parsed.selector = requireOptionValue(values, ++i, arg);
    else if (arg === '--wait-ms') parsed.waitMs = Number(requireOptionValue(values, ++i, arg));
    else if (arg === '--out') parsed.out = requireOptionValue(values, ++i, arg);
    else if (arg === '--article') parsed.article = requireOptionValue(values, ++i, arg);
    else if (arg === '--out-article') parsed.outArticle = requireOptionValue(values, ++i, arg);
    else if (arg === '--help' || arg === '-h') parsed.help = true;
    else if (arg.startsWith('--')) throw new Error(`Unknown option: ${arg}`);
    else positional.push(arg);
  }

  parsed.preview = positional[0] || '';
  if (!parsed.article && opts.articleFromPosition) parsed.article = positional[1] || '';
  if (!parsed.preview && !parsed.help) throw new Error('Missing preview file or URL');
  if (opts.requireArticle && !parsed.article && !parsed.help) throw new Error('Missing article.json');
  if (!Number.isFinite(parsed.waitMs) || parsed.waitMs < 0) throw new Error('--wait-ms must be a non-negative number');
  if (!['macos', 'playwright'].includes(parsed.engine)) throw new Error('--engine must be macos or playwright');
  if (!['chrome', 'safari'].includes(parsed.browser)) throw new Error('--browser must be chrome or safari');

  return parsed;
}

function requireOptionValue(values, index, flag) {
  const value = values[index];
  if (!value || value.startsWith('--')) throw new Error(`Missing value for ${flag}`);
  return value;
}

function previewToUrl(input) {
  if (/^https?:\/\//i.test(input) || /^file:\/\//i.test(input)) return input;
  return pathToFileURL(path.resolve(input)).href;
}

function applyClipboardHtmlToArticle(article, clipboardHtml) {
  const next = {
    ...article,
    contentHtml: clipboardHtml,
    compatMode: COMPAT_MODE_CLIPBOARD_HTML,
  };
  delete next.content;
  delete next.compat_mode;
  delete next.wechatCompat;
  delete next.wechat_compat;
  return next;
}

function loadArticle(articlePath) {
  return JSON.parse(fs.readFileSync(articlePath, 'utf8'));
}

function defaultOutArticlePath(articlePath) {
  const parsed = path.parse(articlePath);
  return path.join(parsed.dir, `${parsed.name}.clipboard${parsed.ext || '.json'}`);
}

function writeArticleWithClipboardHtml(articlePath, outArticlePath, clipboardHtml) {
  const article = applyClipboardHtmlToArticle(loadArticle(articlePath), clipboardHtml);
  const outPath = outArticlePath || defaultOutArticlePath(articlePath);
  fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(article, null, 2)}\n`);
  return { article, outPath };
}

async function captureClipboardHtmlFromPreview(opts = {}) {
  const engine = opts.engine || DEFAULT_ENGINE;
  const browser = opts.browser || DEFAULT_BROWSER;
  const selector = opts.selector || DEFAULT_SELECTOR;
  const waitMs = Number(opts.waitMs ?? DEFAULT_WAIT_MS);
  const previewUrl = previewToUrl(opts.preview);

  if (engine === 'playwright') {
    return captureClipboardHtmlWithPlaywright({
      headless: opts.headless !== false,
      preview: opts.preview,
      selector,
      waitMs,
    });
  }

  if (process.platform !== 'darwin') {
    throw new Error('macos clipboard capture requires macOS because it reads text/html via pbpaste');
  }

  await clearMacClipboard();
  if (browser === 'safari') await copySelectionWithSafari({ previewUrl, selector, waitMs });
  else await copySelectionWithChrome({ previewUrl, selector, waitMs });

  await delay(Number(opts.afterCopyMs ?? 300));
  const html = await readMacClipboardHtml();
  if (!html.trim()) {
    throw new Error('No text/html found in clipboard after copy; check browser permissions and selector');
  }
  return html;
}

async function captureClipboardHtmlWithPlaywright(opts = {}) {
  const playwright = loadPlaywright();
  const previewTarget = await preparePlaywrightPreview(opts.preview);
  let browser;
  try {
    browser = await playwright.chromium.launch({
      channel: 'chrome',
      headless: opts.headless !== false,
    });
    const context = await browser.newContext();
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], {
      origin: new URL(previewTarget.url).origin,
    });
    const page = await context.newPage();
    await page.goto(previewTarget.url, { waitUntil: 'load' });
    await page.waitForTimeout(Number(opts.waitMs ?? DEFAULT_WAIT_MS));
    return await copyPreviewHtmlWithPlaywright(page, opts.selector || DEFAULT_SELECTOR);
  } finally {
    if (browser) await browser.close();
    if (previewTarget.close) await previewTarget.close();
  }
}

function loadPlaywright() {
  try {
    return require('playwright-core');
  } catch (_err) {
    throw new Error('Playwright engine requires playwright-core. Run: npm install playwright-core');
  }
}

async function preparePlaywrightPreview(input) {
  if (/^https?:\/\//i.test(input)) return { url: input, close: null };
  if (/^file:\/\//i.test(input)) {
    throw new Error('Playwright engine expects a local path or http(s) URL, not file:// URL');
  }

  const filePath = path.resolve(input);
  const rootDir = path.dirname(filePath);
  const relativeFile = path.basename(filePath);
  const server = await startStaticServer(rootDir);
  return {
    url: `${server.url}/${encodeURIComponent(relativeFile)}`,
    close: server.close,
  };
}

async function startStaticServer(rootDir) {
  const resolvedRoot = path.resolve(rootDir);
  const server = http.createServer((req, res) => {
    const rawPath = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname);
    const requestedPath = path.resolve(resolvedRoot, rawPath.replace(/^\/+/, ''));
    if (!isPathInsideRoot(requestedPath, resolvedRoot)) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }
    fs.readFile(requestedPath, (err, data) => {
      if (err) {
        res.writeHead(404);
        res.end('Not found');
        return;
      }
      res.writeHead(200, { 'Content-Type': contentTypeForPath(requestedPath) });
      res.end(data);
    });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const address = server.address();
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function isPathInsideRoot(filePath, rootDir) {
  return filePath === rootDir || filePath.startsWith(`${rootDir}${path.sep}`);
}

function contentTypeForPath(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.html' || ext === '.htm') return 'text/html; charset=utf-8';
  if (ext === '.css') return 'text/css; charset=utf-8';
  if (ext === '.js') return 'text/javascript; charset=utf-8';
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.gif') return 'image/gif';
  if (ext === '.svg') return 'image/svg+xml';
  return 'application/octet-stream';
}

async function clearMacClipboard() {
  await execFileAsync('sh', ['-c', ': | pbcopy'], { maxBuffer: 1024 });
}

async function readMacClipboardHtml() {
  const { stdout } = await execFileAsync('pbpaste', ['-Prefer', 'html'], {
    encoding: 'utf8',
    maxBuffer: 50 * 1024 * 1024,
  });
  return stdout;
}

async function copySelectionWithChrome({ previewUrl, selector, waitMs }) {
  const js = buildSelectScript(selector);
  await runAppleScript([
    'on run argv',
    'set targetUrl to item 1 of argv',
    'set jsCode to item 2 of argv',
    'set waitSeconds to ((item 3 of argv) as number) / 1000',
    'tell application "Google Chrome"',
    '  activate',
    '  if (count of windows) = 0 then make new window',
    '  set URL of active tab of front window to targetUrl',
    'end tell',
    'delay waitSeconds',
    'tell application "Google Chrome"',
    '  execute active tab of front window javascript jsCode',
    'end tell',
    'delay 0.2',
    'tell application "System Events"',
    '  keystroke "c" using command down',
    'end tell',
    'end run',
  ], [previewUrl, js, String(waitMs)]);
}

async function copySelectionWithSafari({ previewUrl, selector, waitMs }) {
  const js = buildSelectScript(selector);
  await runAppleScript([
    'on run argv',
    'set targetUrl to item 1 of argv',
    'set jsCode to item 2 of argv',
    'set waitSeconds to ((item 3 of argv) as number) / 1000',
    'tell application "Safari"',
    '  activate',
    '  if (count of documents) = 0 then make new document',
    '  set URL of front document to targetUrl',
    'end tell',
    'delay waitSeconds',
    'tell application "Safari"',
    '  do JavaScript jsCode in front document',
    'end tell',
    'delay 0.2',
    'tell application "System Events"',
    '  keystroke "c" using command down',
    'end tell',
    'end run',
  ], [previewUrl, js, String(waitMs)]);
}

function buildSelectScript(selector) {
  return `(() => {
    const selector = ${JSON.stringify(selector)};
    const el = document.querySelector(selector);
    if (!el) throw new Error('Selector not found: ' + selector);
    el.scrollIntoView({ block: 'center', inline: 'nearest' });
    const range = document.createRange();
    range.selectNodeContents(el);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    return 'selected ' + selector;
  })();`;
}

async function copyPreviewHtmlWithPlaywright(page, selector) {
  const sourceImgCount = await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) throw new Error('Selector not found: ' + sel);
    return el.querySelectorAll('img').length;
  }, selector);

  await page.evaluate(async (sel) => {
    const el = document.querySelector(sel);
    const imgs = [...el.querySelectorAll('img')];
    await Promise.all(imgs.map((img) => {
      if (img.complete) return undefined;
      return new Promise((resolve) => {
        img.addEventListener('load', resolve, { once: true });
        img.addEventListener('error', resolve, { once: true });
      });
    }));
    // Force absolute http(s) src so Chromium does not drop relative/file images on copy.
    for (const img of imgs) {
      if (img.currentSrc || img.src) img.setAttribute('src', img.currentSrc || img.src);
    }
  }, selector);

  const copyButton = page.getByRole('button', { name: /复制到公众号/ });
  if (await copyButton.count()) {
    await copyButton.first().click();
  } else {
    const copied = await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      el.scrollIntoView({ block: 'center', inline: 'nearest' });
      const range = document.createRange();
      range.selectNodeContents(el);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      return document.execCommand('copy');
    }, selector);
    if (!copied) {
      throw new Error('document.execCommand("copy") failed');
    }
  }

  await page.waitForTimeout(200);
  const html = await page.evaluate(async () => {
    if (!navigator.clipboard?.read) return '';
    const items = await navigator.clipboard.read();
    for (const item of items) {
      if (!item.types.includes('text/html')) continue;
      const blob = await item.getType('text/html');
      return await blob.text();
    }
    return '';
  });

  if (!html || !html.trim()) {
    throw new Error('Playwright could not read text/html from browser clipboard');
  }

  const capturedImgCount = (html.match(/<img\b/gi) || []).length;
  if (sourceImgCount > 0 && capturedImgCount === 0) {
    throw new Error(
      `Playwright clipboard HTML dropped all ${sourceImgCount} <img> tags. `
      + 'Serve the preview over http (Playwright engine) so images are not file://, '
      + 'or use the preview “复制到公众号” button.',
    );
  }

  return html;
}

async function runAppleScript(lines, argv = []) {
  const args = [];
  for (const line of lines) args.push('-e', line);
  args.push(...argv);
  try {
    await execFileAsync('osascript', args, {
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
      timeout: APPLESCRIPT_TIMEOUT_MS,
    });
  } catch (err) {
    throw new Error(`Browser clipboard automation failed: ${err.message}`);
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = {
  COMPAT_MODE_CLIPBOARD_HTML,
  applyClipboardHtmlToArticle,
  buildSelectScript,
  captureClipboardHtmlFromPreview,
  captureClipboardHtmlWithPlaywright,
  copyPreviewHtmlWithPlaywright,
  defaultOutArticlePath,
  loadPlaywright,
  parseCaptureArgs,
  previewToUrl,
  writeArticleWithClipboardHtml,
};
