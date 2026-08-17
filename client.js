#!/usr/bin/env node
/**
 * wxofficial-relay client SDK and CLI.
 */

const axios = require('axios');
const https = require('https');
const fs = require('fs');
const path = require('path');
const FormData = require('form-data');
const {
  applyClipboardHtmlToArticle,
  captureClipboardHtmlFromPreview,
  parseCaptureArgs,
  writeArticleWithClipboardHtml,
} = require('./src/clipboard/capture');
const { materializeClipboardDataImages } = require('./src/html/dataImages');

class WxClient {
  constructor(opts = {}) {
    this.serverUrl = (opts.serverUrl || '').replace(/\/+$/, '');
    this.apiKey = opts.apiKey || '';
    this.timeout = opts.timeout || 60000;

    if (!this.serverUrl) throw new WxProxyError('serverUrl is required');

    const tlsServername = opts.tlsServername || new URL(this.serverUrl).hostname;
    if (opts.caCertPath && fs.existsSync(opts.caCertPath)) {
      this.httpsAgent = new https.Agent({ ca: fs.readFileSync(opts.caCertPath), servername: tlsServername });
    } else if (opts.allowInsecureTLS === true) {
      this.httpsAgent = new https.Agent({ rejectUnauthorized: false, servername: tlsServername });
    } else {
      this.httpsAgent = null;
    }
  }

  async _request(method, route, data, extra = {}) {
    const url = `${this.serverUrl}${route}`;
    const headers = { ...(extra.headers || {}) };
    if (this.apiKey) headers['X-Api-Key'] = this.apiKey;

    try {
      const opts = {
        method,
        url,
        headers,
        timeout: this.timeout,
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
      };
      if (this.httpsAgent) {
        opts.httpsAgent = this.httpsAgent;
        // Axios otherwise honors HTTP(S)_PROXY and the tunnel can still reject
        // self-signed relay certificates before our agent setting is applied.
        opts.proxy = false;
      }
      if (method === 'get' || method === 'delete') opts.params = data;
      else opts.data = data;
      const res = await axios(opts);
      return res.data;
    } catch (err) {
      if (err.response) {
        throw new WxProxyError(
          err.response.data?.error || `HTTP ${err.response.status}`,
          err.response.data
        );
      }
      throw new WxProxyError(`Cannot connect to wxofficial-relay: ${err.message}`);
    }
  }

  async _get(route, params) { return this._request('get', route, params); }
  async _post(route, body) { return this._request('post', route, body); }
  async _postForm(route, form) { return this._request('post', route, form, { headers: form.getHeaders() }); }

  async health() { return this._get('/health'); }
  async getTokenStatus() { return this._get('/api/token/status'); }
  async getToken() { return this.getTokenStatus(); }

  draft = {
    add: async (payload) => this._post('/api/draft/add', payload),
    list: async (opts = {}) => this._get('/api/draft/list', {
      offset: opts.offset || 0,
      count: opts.count || 20,
      no_content: opts.no_content || 0,
    }),
    get: async (mediaId) => this._get(`/api/draft/${mediaId}`),
    update: async (payload) => this._post('/api/draft/update', payload),
    delete: async (mediaId) => this._post('/api/draft/delete', { media_id: mediaId }),
    createAuto: async (article) => this.createDraftAuto(article),
  };

  publish = {
    submit: async (mediaId) => this._post('/api/publish/submit', { media_id: mediaId }),
    status: async (publishId) => this._post('/api/publish/status', { publish_id: publishId }),
    delete: async (articleId, index = 1) => this._post('/api/publish/delete', { article_id: articleId, index }),
  };

  media = {
    uploadCover: async (filePath) => this.uploadImageFile('/api/media/upload-cover', filePath),
    uploadInlineImage: async (filePath) => this.uploadImageFile('/api/media/upload-inline-image', filePath),
    uploadThumb: async (imageUrl) => this._post('/api/media/uploadthumb', { image_url: imageUrl }),
    uploadImage: async (imageUrl) => this._post('/api/media/uploadimage', { image_url: imageUrl }),
  };

  async proxy(apiPath, method = 'POST', data = {}, params = {}) {
    return this._post('/api/proxy', { path: apiPath, method, data, params });
  }

  async uploadImageFile(route, filePath) {
    const form = new FormData();
    form.append('image', fs.createReadStream(filePath), path.basename(filePath));
    return this._postForm(route, form);
  }

  async createDraftAuto(article) {
    const form = new FormData();
    const materialized = materializeClipboardDataImages(article.contentHtml || article.content || '');
    const contentHtml = materialized.html;
    form.append('title', article.title || '');
    form.append('author', article.author || '');
    form.append('digest', article.digest || '');
    form.append('content_html', contentHtml);
    form.append('content_source_url', article.contentSourceUrl || article.content_source_url || '');
    form.append('need_open_comment', String(article.needOpenComment ?? article.need_open_comment ?? 0));
    form.append('only_fans_can_comment', String(article.onlyFansCanComment ?? article.only_fans_can_comment ?? 0));
    form.append('show_cover_pic', String(article.showCoverPic ?? article.show_cover_pic ?? 1));
    if (article.compatMode || article.compat_mode) form.append('compat_mode', article.compatMode || article.compat_mode);
    if (article.wechatCompat || article.wechat_compat) form.append('wechat_compat', '1');

    if (article.coverMediaId || article.cover_media_id || article.thumb_media_id) {
      form.append('cover_media_id', article.coverMediaId || article.cover_media_id || article.thumb_media_id);
    } else if (article.coverPath) {
      form.append('cover', fs.createReadStream(article.coverPath), path.basename(article.coverPath));
    }

    const imageMap = {};

    for (const image of [...(article.images || []), ...materialized.images]) {
      const src = image.src || image.url || image.path;
      const filePath = image.path || image.filePath;
      if (!src || !filePath) continue;
      const filename = image.filename || path.basename(filePath);
      imageMap[src] = filename;
      form.append('images', fs.createReadStream(filePath), filename);
    }

    if (article.assetsDir) {
      const srcs = extractImageSrcs(contentHtml);
      for (const src of srcs) {
        if (shouldSkipImageSrc(src) || imageMap[src]) continue;
        const localPath = resolveLocalAssetPath(article.assetsDir, src);
        if (!localPath || !fs.existsSync(localPath)) continue;
        const filename = path.basename(localPath);
        imageMap[src] = filename;
        form.append('images', fs.createReadStream(localPath), filename);
      }
    }

    form.append('image_map', JSON.stringify({ ...(article.imageMap || {}), ...imageMap }));
    return this._postForm('/api/draft/create-auto', form);
  }

  async publishArticle(article) {
    const draftPayload = {
      articles: [{
        title: article.title,
        content: article.contentHtml || article.content,
        thumb_media_id: article.thumbMediaId || article.thumb_media_id || '',
        author: article.author || '',
        digest: article.digest || '',
        content_source_url: article.contentSourceUrl || article.content_source_url || '',
        show_cover_pic: article.showCoverPic ?? article.show_cover_pic ?? 1,
        need_open_comment: article.needOpenComment ?? article.need_open_comment ?? 0,
        only_fans_can_comment: article.onlyFansCanComment ?? article.only_fans_can_comment ?? 0,
      }],
    };
    return this.draft.add(draftPayload);
  }

  async uploadImagesInContent(htmlContent, images = []) {
    const urlMap = {};
    let content = htmlContent;

    for (const image of images) {
      if (!image.src || !image.path) continue;
      const res = await this.media.uploadInlineImage(image.path);
      if (!res.url) throw new WxProxyError('Inline image upload failed', res);
      urlMap[image.src] = res.url;
      content = content.split(image.src).join(res.url);
    }

    return { content, urlMap };
  }

  async publishArticleAuto(article) {
    return this.createDraftAuto(article);
  }
}

function extractImageSrcs(html) {
  const srcs = new Set();
  const imgRegex = /<img[^>]+src=["']([^"']+)["'][^>]*>/gi;
  let match;
  while ((match = imgRegex.exec(html)) !== null) srcs.add(match[1]);
  return [...srcs];
}

function shouldSkipImageSrc(src) {
  if (!src || src.startsWith('data:') || src.includes('mmbiz.qpic.cn')) return true;
  if (/^https?:\/\//i.test(src)) return !isLoopbackHttpUrl(src);
  return false;
}

function isLoopbackHttpUrl(src) {
  try {
    const url = new URL(src);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    return hostname === 'localhost' || hostname === '::1' || hostname.startsWith('127.');
  } catch (_err) {
    return false;
  }
}

function resolveLocalAssetPath(assetsDir, src) {
  const clean = src.split('?')[0].split('#')[0];
  const candidates = [
    path.resolve(assetsDir, clean),
    path.resolve(assetsDir, path.basename(clean)),
  ];
  return candidates.find((candidate) => candidate.startsWith(path.resolve(assetsDir)) && fs.existsSync(candidate));
}

class WxProxyError extends Error {
  constructor(message, details) {
    super(message);
    this.name = 'WxProxyError';
    this.details = details;
  }
}

WxClient.WxProxyError = WxProxyError;
WxClient.create = (opts) => new WxClient(opts);

async function cli() {
  const args = process.argv.slice(2);
  const cmd = args[0];

  const serverUrl = process.env.WX_PROXY_URL || 'https://localhost:3901';
  const apiKey = process.env.WX_PROXY_KEY || '';
  const allowInsecureTLS = process.env.WX_PROXY_INSECURE_TLS === '1';

  if (cmd === 'config' || cmd === 'setup') {
    console.log('# wxofficial-relay client configuration');
    console.log(`export WX_PROXY_URL="${serverUrl}"`);
    console.log('export WX_PROXY_KEY="your-api-key-here"');
    console.log('# Optional for self-signed certificates only: export WX_PROXY_INSECURE_TLS=1');
    return;
  }

  const wx = WxClient.create({ serverUrl, apiKey, allowInsecureTLS });

  try {
    switch (cmd) {
      case 'health':
        console.log(JSON.stringify(await wx.health(), null, 2));
        break;
      case 'token':
      case 'token:status':
        console.log(JSON.stringify(await wx.getTokenStatus(), null, 2));
        break;
      case 'draft:add':
        console.log(JSON.stringify(await wx.draft.add(JSON.parse(args[1] || '{}')), null, 2));
        break;
      case 'draft:list':
        printDraftList(await wx.draft.list({ count: Number(args[1]) || 10 }));
        break;
      case 'draft:get':
        console.log(JSON.stringify(await wx.draft.get(args[1]), null, 2));
        break;
      case 'draft:delete':
        console.log(JSON.stringify(await wx.draft.delete(args[1]), null, 2));
        break;
      case 'draft:create-auto':
        console.log(JSON.stringify(await wx.createDraftAuto(JSON.parse(fs.readFileSync(args[1], 'utf-8'))), null, 2));
        break;
      case 'clipboard:capture':
        await runClipboardCaptureCommand(args.slice(1));
        break;
      case 'draft:create-from-preview':
        await runCreateDraftFromPreviewCommand(wx, args.slice(1));
        break;
      case 'publish:submit':
        console.log(JSON.stringify(await wx.publish.submit(args[1]), null, 2));
        break;
      case 'publish:status':
        console.log(JSON.stringify(await wx.publish.status(args[1]), null, 2));
        break;
      case 'media:upload-cover':
        console.log(JSON.stringify(await wx.media.uploadCover(args[1]), null, 2));
        break;
      case 'media:upload-inline':
        console.log(JSON.stringify(await wx.media.uploadInlineImage(args[1]), null, 2));
        break;
      case 'media:uploadimage':
        console.log(JSON.stringify(await wx.media.uploadImage(JSON.parse(args[1] || '{}').image_url), null, 2));
        break;
      case 'media:uploadthumb':
        console.log(JSON.stringify(await wx.media.uploadThumb(JSON.parse(args[1] || '{}').image_url), null, 2));
        break;
      default:
        printHelp(serverUrl, apiKey);
    }
  } catch (err) {
    console.error(`[ERROR] ${err.message}`);
    if (err.details) console.error('details:', JSON.stringify(err.details, null, 2));
    process.exit(1);
  }
}

async function runClipboardCaptureCommand(args) {
  const opts = parseCaptureArgs(args);
  if (opts.help) {
    printClipboardCaptureHelp();
    return;
  }

  const html = await captureClipboardHtmlFromPreview(opts);
  const result = {
    ok: true,
    preview: opts.preview,
    selector: opts.selector,
    browser: opts.browser,
    htmlLength: html.length,
  };

  if (opts.out) {
    fs.mkdirSync(path.dirname(path.resolve(opts.out)), { recursive: true });
    fs.writeFileSync(opts.out, html);
    result.out = opts.out;
  }

  if (opts.article) {
    const written = writeArticleWithClipboardHtml(opts.article, opts.outArticle, html);
    result.outArticle = written.outPath;
  }

  if (!opts.out && !opts.article) process.stdout.write(html);
  else console.log(JSON.stringify(result, null, 2));
}

async function runCreateDraftFromPreviewCommand(wx, args) {
  const opts = parseCaptureArgs(args, { articleFromPosition: true, requireArticle: true });
  if (opts.help) {
    printCreateDraftFromPreviewHelp();
    return;
  }

  const html = await captureClipboardHtmlFromPreview(opts);
  const sourceArticle = JSON.parse(fs.readFileSync(opts.article, 'utf8'));
  const article = applyClipboardHtmlToArticle(sourceArticle, html);

  if (opts.outArticle) {
    fs.mkdirSync(path.dirname(path.resolve(opts.outArticle)), { recursive: true });
    fs.writeFileSync(opts.outArticle, `${JSON.stringify(article, null, 2)}\n`);
  }

  console.log(JSON.stringify(await wx.createDraftAuto(article), null, 2));
}

function printDraftList(result) {
  if (!result.item) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  for (const item of result.item) {
    console.log(`media_id: ${item.media_id}`);
    const first = item.content?.news_item?.[0];
    if (first) console.log(`title: ${first.title}`);
    console.log(`updated: ${new Date(item.update_time * 1000).toISOString()}`);
    console.log('');
  }
}

function printHelp(serverUrl, apiKey) {
  console.log('wxofficial-relay client CLI');
  console.log('');
  console.log('Usage: node client.js <command> [args]');
  console.log('');
  console.log('Commands:');
  console.log('  health');
  console.log('  token:status');
  console.log('  draft:add <JSON>');
  console.log('  draft:list [count]');
  console.log('  draft:get <media_id>');
  console.log('  draft:delete <media_id>');
  console.log('  draft:create-auto <article.json>');
  console.log('  draft:create-from-preview <preview.html|url> <article.json> [--out-article file]');
  console.log('  clipboard:capture <preview.html|url> [--out clipboard.html] [--article article.json]');
  console.log('  media:upload-cover <file>');
  console.log('  media:upload-inline <file>');
  console.log('  publish:submit <media_id>');
  console.log('');
  console.log('Environment:');
  console.log(`  WX_PROXY_URL=${serverUrl}`);
  console.log(`  WX_PROXY_KEY=${apiKey ? '(set)' : '(missing)'}`);
}

function printClipboardCaptureHelp() {
  console.log(`clipboard:capture <preview.html|url> [options]

Options:
  --out <file>             Write captured clipboard HTML to a file
  --article <article.json> Write an article JSON with contentHtml replaced
  --out-article <file>     Output path for rewritten article JSON
  --selector <selector>    Element to copy, default #gzh-content
  --engine <macos|playwright>
  --headless / --headed    Playwright engine display mode
  --browser <chrome|safari>
  --wait-ms <ms>           Wait after opening preview, default 1200
`);
}

function printCreateDraftFromPreviewHelp() {
  console.log(`draft:create-from-preview <preview.html|url> <article.json> [options]

Captures real browser clipboard HTML from the preview, sets
compatMode="wechat-clipboard-html", uploads images, and creates a draft.

Options:
  --out-article <file>     Also save the rewritten article JSON
  --selector <selector>    Element to copy, default #gzh-content
  --engine <macos|playwright>
  --headless / --headed    Playwright engine display mode
  --browser <chrome|safari>
  --wait-ms <ms>           Wait after opening preview, default 1200
`);
}

if (require.main === module) cli();

WxClient._internals = {
  isLoopbackHttpUrl,
  resolveLocalAssetPath,
  shouldSkipImageSrc,
};

module.exports = WxClient;
