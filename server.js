#!/usr/bin/env node
/**
 * wxofficial-relay - WeChat Official Account API relay
 *
 * Deploy this service on a fixed-IP cloud server. Home machines call this
 * relay, and the relay calls api.weixin.qq.com from the whitelisted IP.
 */

require('dotenv').config();

const express = require('express');
const axios = require('axios');
const https = require('https');
const fs = require('fs');
const path = require('path');
const dns = require('dns').promises;
const net = require('net');
const multer = require('multer');
const FormData = require('form-data');

const WX_API_BASE = 'https://api.weixin.qq.com';
const MAX_IMAGE_BYTES = parseSize(process.env.MAX_IMAGE_SIZE || '10mb');

const CONFIG = {
  APP_ID: process.env.WX_APP_ID,
  APP_SECRET: process.env.WX_APP_SECRET,
  PORT: parseInt(process.env.PORT || '3900', 10),
  HOST: process.env.HOST || '0.0.0.0',
  API_KEY: process.env.API_KEY,
  RATE_LIMIT_RPM: parseInt(process.env.RATE_LIMIT_RPM || '60', 10),
  TOKEN_CACHE_FILE: process.env.TOKEN_CACHE_FILE || null,
  ENABLE_GENERIC_PROXY: process.env.ENABLE_GENERIC_PROXY === '1',
};

if (!CONFIG.APP_ID || !CONFIG.APP_SECRET) {
  console.error('[FATAL] Missing WX_APP_ID / WX_APP_SECRET');
  process.exit(1);
}

if (!CONFIG.API_KEY || CONFIG.API_KEY === 'change_me_to_a_random_string') {
  console.error('[FATAL] API_KEY is required and must not use the default value');
  process.exit(1);
}

const LOG_LEVELS = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };
const LOG_LEVEL = LOG_LEVELS[process.env.LOG_LEVEL?.toUpperCase()] ?? LOG_LEVELS.INFO;

function log(level, msg, detail) {
  if (LOG_LEVELS[level] < LOG_LEVEL) return;
  const line = {
    ts: new Date().toISOString(),
    level,
    msg,
    ...(detail ? { detail: redact(detail) } : {}),
  };
  const output = JSON.stringify(line);
  if (level === 'ERROR') console.error(output);
  else console.log(output);
}

function redact(value) {
  if (typeof value === 'string') return redactString(value);
  if (Array.isArray(value)) return value.map(redact);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [key, val] of Object.entries(value)) {
    if (/secret|token|api[-_]?key|authorization/i.test(key)) {
      out[key] = mask(String(val));
    } else {
      out[key] = redact(val);
    }
  }
  return out;
}

function redactString(text) {
  return text
    .replace(/access_token=[^&\s]+/gi, 'access_token=***')
    .replace(/secret=[^&\s]+/gi, 'secret=***')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+-]+/gi, '$1***');
}

function mask(value) {
  if (!value || value.length <= 8) return '***';
  return `${value.slice(0, 3)}***${value.slice(-3)}`;
}

function parseSize(input) {
  const match = String(input).trim().toLowerCase().match(/^(\d+)(kb|mb|b)?$/);
  if (!match) return 10 * 1024 * 1024;
  const n = Number(match[1]);
  const unit = match[2] || 'b';
  if (unit === 'mb') return n * 1024 * 1024;
  if (unit === 'kb') return n * 1024;
  return n;
}

let tokenCache = { access_token: null, expiresAt: 0 };
let tokenRefreshPromise = null;

function loadTokenFromDisk() {
  if (!CONFIG.TOKEN_CACHE_FILE) return;
  try {
    if (!fs.existsSync(CONFIG.TOKEN_CACHE_FILE)) return;
    const cached = JSON.parse(fs.readFileSync(CONFIG.TOKEN_CACHE_FILE, 'utf-8'));
    if (cached.access_token && cached.expiresAt > Date.now() + 5 * 60 * 1000) {
      tokenCache = cached;
      log('INFO', 'Restored access_token cache', {
        expiresAt: new Date(cached.expiresAt).toISOString(),
      });
    }
  } catch (err) {
    log('WARN', 'Failed to read token cache file', { error: err.message });
  }
}

function saveTokenToDisk() {
  if (!CONFIG.TOKEN_CACHE_FILE || !tokenCache.access_token) return;
  try {
    const dir = path.dirname(CONFIG.TOKEN_CACHE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(CONFIG.TOKEN_CACHE_FILE, JSON.stringify(tokenCache), { mode: 0o600 });
  } catch (err) {
    log('WARN', 'Failed to save token cache', { error: err.message });
  }
}

function tokenIsFresh() {
  return !!(tokenCache.access_token && tokenCache.expiresAt > Date.now() + 5 * 60 * 1000);
}

async function getAccessToken({ forceRefresh = false } = {}) {
  if (!forceRefresh && tokenIsFresh()) return tokenCache.access_token;

  if (!tokenRefreshPromise) {
    tokenRefreshPromise = refreshAccessToken().finally(() => {
      tokenRefreshPromise = null;
    });
  }

  return tokenRefreshPromise;
}

async function refreshAccessToken() {
  log('INFO', 'Refreshing access_token');
  const url = `${WX_API_BASE}/cgi-bin/token?grant_type=client_credential&appid=${encodeURIComponent(CONFIG.APP_ID)}&secret=${encodeURIComponent(CONFIG.APP_SECRET)}`;
  const res = await axios.get(url, { timeout: 10000 });
  const data = res.data;

  if (data.errcode) {
    throw new WxRelayError('token', `WeChat token error [${data.errcode}]: ${data.errmsg}`, data);
  }
  if (!data.access_token || !data.expires_in) {
    throw new WxRelayError('token', 'WeChat did not return access_token', data);
  }

  tokenCache = {
    access_token: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  };
  saveTokenToDisk();
  log('INFO', 'access_token refreshed', {
    expiresAt: new Date(tokenCache.expiresAt).toISOString(),
    expiresInSec: data.expires_in,
  });
  return tokenCache.access_token;
}

function isTokenExpiredError(data) {
  return data && [40001, 40014, 41001, 42001].includes(Number(data.errcode));
}

async function callWxApi({ method = 'POST', path: apiPath, data = {}, params = {}, stage = 'wechat_api', retryOnTokenError = true }) {
  validateWxApiPath(apiPath);
  const token = await getAccessToken();
  const sep = apiPath.includes('?') ? '&' : '?';
  const url = `${WX_API_BASE}${apiPath}${sep}access_token=${encodeURIComponent(token)}`;

  const opts = {
    method: method.toUpperCase(),
    url,
    timeout: 30000,
  };

  if (opts.method === 'GET') opts.params = { ...params, ...data };
  else opts.data = data;

  const res = await axios(opts);
  const body = res.data;

  if (isTokenExpiredError(body) && retryOnTokenError) {
    log('WARN', 'WeChat token expired, refreshing and retrying once', { stage, errcode: body.errcode });
    tokenCache = { access_token: null, expiresAt: 0 };
    await getAccessToken({ forceRefresh: true });
    return callWxApi({ method, path: apiPath, data, params, stage, retryOnTokenError: false });
  }

  return body;
}

function validateWxApiPath(apiPath) {
  if (!apiPath || typeof apiPath !== 'string') {
    throw new WxRelayError('validation', 'Missing WeChat API path');
  }
  if (!apiPath.startsWith('/cgi-bin/') || apiPath.includes('..') || apiPath.includes('//')) {
    throw new WxRelayError('validation', 'Illegal WeChat API path');
  }
}

class WxRelayError extends Error {
  constructor(stage, message, details) {
    super(message);
    this.name = 'WxRelayError';
    this.stage = stage;
    this.details = details;
  }
}

function normalizeError(err, stage) {
  const details = err.details || err.response?.data;
  const wechatErrcode = details?.errcode;
  const wechatErrmsg = details?.errmsg;
  return {
    ok: false,
    stage: err.stage || stage,
    error: err.message,
    ...(wechatErrcode !== undefined ? { wechat_errcode: wechatErrcode } : {}),
    ...(wechatErrmsg ? { wechat_errmsg: wechatErrmsg } : {}),
    ...(wechatErrcode !== undefined ? { hint: hintForWechatError(wechatErrcode) } : {}),
  };
}

function hintForWechatError(errcode) {
  const code = Number(errcode);
  if (code === 40164) return 'The cloud server egress IP is not in the Official Account IP whitelist.';
  if ([40001, 40014, 41001, 42001].includes(code)) return 'The access_token is invalid or expired; the relay retried once.';
  if (code === 48001) return 'The Official Account lacks permission for this API.';
  if (code === 45009) return 'WeChat API rate limit reached.';
  if ([40007, 40097].includes(code)) return 'Invalid media_id or draft payload field.';
  return 'Check the WeChat errcode documentation for this API.';
}

function sendError(res, err, stage, status = 502) {
  const body = normalizeError(err, stage);
  log('ERROR', `${stage} failed`, body);
  res.status(status).json(body);
}

const app = express();

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));

app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    log('DEBUG', `${req.method} ${req.path}`, {
      status: res.statusCode,
      ms: Date.now() - start,
      ip: req.ip,
    });
  });
  next();
});

function authMiddleware(req, res, next) {
  const key = req.headers['x-api-key'] || req.headers.authorization?.replace(/^Bearer\s+/i, '');
  if (!key || key !== CONFIG.API_KEY) {
    log('WARN', 'Authentication failed', { ip: req.ip, path: req.path });
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  next();
}

app.use('/api', authMiddleware);

if (CONFIG.RATE_LIMIT_RPM > 0) {
  const rateLimit = require('express-rate-limit');
  app.use('/api', rateLimit({
    windowMs: 60 * 1000,
    max: CONFIG.RATE_LIMIT_RPM,
    standardHeaders: true,
    legacyHeaders: false,
    message: { ok: false, error: 'Too many requests' },
  }));
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_IMAGE_BYTES,
    files: 50,
    fields: 100,
  },
  fileFilter: (_req, file, cb) => {
    if (isAllowedImageMime(file.mimetype)) cb(null, true);
    else cb(new WxRelayError('upload', `Unsupported image type: ${file.mimetype}`));
  },
});

function isAllowedImageMime(mime) {
  return ['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(String(mime).toLowerCase());
}

app.get('/health', async (_req, res) => {
  const tokenCached = tokenIsFresh();
  res.json({
    ok: true,
    time: new Date().toISOString(),
    uptime: Math.floor(process.uptime()),
    version: require('./package.json').version,
    wechat: {
      token_cached: tokenCached,
      expires_in_sec: tokenCache.expiresAt ? Math.max(0, Math.floor((tokenCache.expiresAt - Date.now()) / 1000)) : 0,
    },
  });
});

app.get('/api/token/status', async (_req, res) => {
  try {
    await getAccessToken();
    res.json({
      ok: true,
      cached: tokenIsFresh(),
      expiresAt: tokenCache.expiresAt ? new Date(tokenCache.expiresAt).toISOString() : null,
      expiresInSec: tokenCache.expiresAt ? Math.max(0, Math.floor((tokenCache.expiresAt - Date.now()) / 1000)) : 0,
    });
  } catch (err) {
    sendError(res, err, 'token_status');
  }
});

app.get('/api/token', async (_req, res) => {
  try {
    await getAccessToken();
    res.json({
      ok: true,
      cached: tokenIsFresh(),
      expiresAt: tokenCache.expiresAt ? new Date(tokenCache.expiresAt).toISOString() : null,
      expiresInSec: tokenCache.expiresAt ? Math.max(0, Math.floor((tokenCache.expiresAt - Date.now()) / 1000)) : 0,
    });
  } catch (err) {
    sendError(res, err, 'token_status');
  }
});

app.post('/api/draft/add', async (req, res) => {
  try {
    const data = await callWxApi({ path: '/cgi-bin/draft/add', data: req.body, stage: 'draft_add' });
    res.json(data);
  } catch (err) {
    sendError(res, err, 'draft_add');
  }
});

app.get('/api/draft/list', async (req, res) => {
  try {
    const data = await callWxApi({
      path: '/cgi-bin/draft/batchget',
      data: {
        offset: parseInt(req.query.offset, 10) || 0,
        count: Math.min(parseInt(req.query.count, 10) || 20, 20),
        no_content: parseInt(req.query.no_content, 10) || 0,
      },
      stage: 'draft_list',
    });
    res.json(data);
  } catch (err) {
    sendError(res, err, 'draft_list');
  }
});

app.get('/api/draft/:mediaId', async (req, res) => {
  try {
    const data = await callWxApi({
      path: '/cgi-bin/draft/get',
      data: { media_id: req.params.mediaId },
      stage: 'draft_get',
    });
    res.json(data);
  } catch (err) {
    sendError(res, err, 'draft_get');
  }
});

app.post('/api/draft/delete', async (req, res) => {
  try {
    const data = await callWxApi({
      path: '/cgi-bin/draft/delete',
      data: { media_id: req.body.media_id },
      stage: 'draft_delete',
    });
    res.json(data);
  } catch (err) {
    sendError(res, err, 'draft_delete');
  }
});

app.post('/api/draft/update', async (req, res) => {
  try {
    const { media_id, ...payload } = req.body;
    const data = await callWxApi({
      path: '/cgi-bin/draft/update',
      data: { media_id, ...payload },
      stage: 'draft_update',
    });
    res.json(data);
  } catch (err) {
    sendError(res, err, 'draft_update');
  }
});

app.post('/api/draft/create-auto', upload.fields([
  { name: 'cover', maxCount: 1 },
  { name: 'images', maxCount: 50 },
]), async (req, res) => {
  try {
    const result = await createDraftAuto(req.body, req.files || {});
    res.json(result);
  } catch (err) {
    sendError(res, err, 'draft_create_auto');
  }
});

async function createDraftAuto(body, files) {
  const title = requireField(body.title, 'title');
  let content = requireField(body.content_html || body.content, 'content_html');
  const author = body.author || '';
  const digest = body.digest || '';
  const contentSourceUrl = body.content_source_url || body.contentSourceUrl || '';

  let thumbMediaId = body.cover_media_id || body.thumb_media_id || '';
  const cover = files.cover?.[0];
  if (!thumbMediaId) {
    if (!cover) throw new WxRelayError('validation', 'Missing cover file or cover_media_id');
    const coverRes = await uploadImageBufferToWechat(cover, 'cover');
    if (!coverRes.media_id) throw new WxRelayError('upload_cover', 'WeChat did not return cover media_id', coverRes);
    thumbMediaId = coverRes.media_id;
  }

  const imageMap = parseImageMap(body.image_map || body.imageMap);
  const inlineFiles = files.images || [];
  const replacements = await uploadInlineImagesAndBuildMap(content, inlineFiles, imageMap);
  for (const [oldSrc, newSrc] of Object.entries(replacements)) {
    content = content.split(oldSrc).join(newSrc);
  }

  const draftPayload = {
    articles: [{
      title,
      author,
      digest,
      content,
      content_source_url: contentSourceUrl,
      thumb_media_id: thumbMediaId,
      show_cover_pic: Number(body.show_cover_pic ?? 1),
      need_open_comment: Number(body.need_open_comment ?? body.needOpenComment ?? 0),
      only_fans_can_comment: Number(body.only_fans_can_comment ?? body.onlyFansCanComment ?? 0),
    }],
  };

  const draft = await callWxApi({ path: '/cgi-bin/draft/add', data: draftPayload, stage: 'draft_add' });
  return {
    ...draft,
    ok: !draft.errcode || draft.errcode === 0,
    thumb_media_id: thumbMediaId,
    image_replacements: replacements,
  };
}

function requireField(value, name) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new WxRelayError('validation', `Missing ${name}`);
  }
  return value;
}

function parseImageMap(raw) {
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new WxRelayError('validation', `Invalid image_map JSON: ${err.message}`);
  }
}

async function uploadInlineImagesAndBuildMap(content, files, imageMap) {
  const replacements = {};
  const filesByName = new Map();
  for (const file of files) filesByName.set(file.originalname, file);

  for (const [src, filename] of Object.entries(imageMap)) {
    const file = filesByName.get(filename) || files.find((f) => f.fieldname === filename);
    if (!file) throw new WxRelayError('validation', `image_map references missing file: ${filename}`);
    const uploaded = await uploadImageBufferToWechat(file, 'inline');
    if (!uploaded.url) throw new WxRelayError('upload_inline_image', 'WeChat did not return image url', uploaded);
    replacements[src] = uploaded.url;
  }

  const htmlSrcs = extractImageSrcs(content);
  for (const src of htmlSrcs) {
    if (replacements[src] || shouldSkipImageSrc(src)) continue;
    const basename = path.basename(stripQuery(src));
    const file = filesByName.get(basename) || filesByName.get(src);
    if (!file) continue;
    const uploaded = await uploadImageBufferToWechat(file, 'inline');
    if (!uploaded.url) throw new WxRelayError('upload_inline_image', 'WeChat did not return image url', uploaded);
    replacements[src] = uploaded.url;
  }

  return replacements;
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

function shouldSkipImageSrc(src) {
  return !src || src.startsWith('data:') || src.includes('mmbiz.qpic.cn');
}

app.post('/api/media/upload-cover', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) throw new WxRelayError('validation', 'Missing multipart file field: image');
    res.json(await uploadImageBufferToWechat(req.file, 'cover'));
  } catch (err) {
    sendError(res, err, 'upload_cover');
  }
});

app.post('/api/media/upload-inline-image', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) throw new WxRelayError('validation', 'Missing multipart file field: image');
    res.json(await uploadImageBufferToWechat(req.file, 'inline'));
  } catch (err) {
    sendError(res, err, 'upload_inline_image');
  }
});

app.post('/api/media/uploadthumb', async (req, res) => {
  try {
    const file = await downloadImage(req.body.image_url);
    res.json(await uploadImageBufferToWechat(file, 'cover'));
  } catch (err) {
    sendError(res, err, 'upload_cover_url');
  }
});

app.post('/api/media/uploadimage', async (req, res) => {
  try {
    const file = await downloadImage(req.body.image_url);
    res.json(await uploadImageBufferToWechat(file, 'inline'));
  } catch (err) {
    sendError(res, err, 'upload_inline_image_url');
  }
});

async function uploadImageBufferToWechat(file, kind, retryOnTokenError = true) {
  const token = await getAccessToken();
  const form = new FormData();
  const filename = sanitizeFilename(file.originalname || file.filename || defaultImageFilename(file.mimetype));
  form.append('media', file.buffer, { filename, contentType: file.mimetype });

  const uploadUrl = kind === 'cover'
    ? `${WX_API_BASE}/cgi-bin/material/add_material?access_token=${encodeURIComponent(token)}&type=thumb`
    : `${WX_API_BASE}/cgi-bin/media/uploadimg?access_token=${encodeURIComponent(token)}`;

  try {
    const res = await axios.post(uploadUrl, form, {
      headers: form.getHeaders(),
      timeout: 60000,
      maxBodyLength: MAX_IMAGE_BYTES + 1024 * 1024,
    });

    const body = res.data;
    if (isTokenExpiredError(body) && retryOnTokenError) {
      tokenCache = { access_token: null, expiresAt: 0 };
      await getAccessToken({ forceRefresh: true });
      return uploadImageBufferToWechat(file, kind, false);
    }
    return body;
  } catch (err) {
    // Avoid stream/epipe errors escaping and crashing the process
    if (err.code === 'EPIPE' || err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT') {
      throw new WxRelayError('upload_to_wechat', `Upload connection closed: ${err.code}`, { code: err.code });
    }
    throw err;
  }
}

function sanitizeFilename(filename) {
  return path.basename(filename).replace(/[^a-zA-Z0-9._-]/g, '_') || 'image.jpg';
}

function defaultImageFilename(mime) {
  if (mime === 'image/png') return 'image.png';
  if (mime === 'image/webp') return 'image.webp';
  if (mime === 'image/gif') return 'image.gif';
  return 'image.jpg';
}

async function downloadImage(imageUrl) {
  if (!imageUrl) throw new WxRelayError('validation', 'Missing image_url');
  await validateRemoteImageUrl(imageUrl);
  const res = await axios.get(imageUrl, {
    responseType: 'arraybuffer',
    timeout: 30000,
    maxContentLength: MAX_IMAGE_BYTES,
    maxRedirects: 3,
    validateStatus: (status) => status >= 200 && status < 300,
  });
  const mimetype = String(res.headers['content-type'] || '').split(';')[0].toLowerCase();
  if (!isAllowedImageMime(mimetype)) {
    throw new WxRelayError('validation', `Remote URL did not return an allowed image type: ${mimetype}`);
  }
  return {
    buffer: Buffer.from(res.data),
    mimetype,
    originalname: path.basename(new URL(imageUrl).pathname) || defaultImageFilename(mimetype),
  };
}

async function validateRemoteImageUrl(imageUrl) {
  let parsed;
  try {
    parsed = new URL(imageUrl);
  } catch (_) {
    throw new WxRelayError('validation', 'Invalid image_url');
  }
  if (parsed.protocol !== 'https:') {
    throw new WxRelayError('validation', 'Only https image URLs are allowed');
  }
  const addresses = await dns.lookup(parsed.hostname, { all: true });
  if (!addresses.length) throw new WxRelayError('validation', 'Cannot resolve image_url hostname');
  for (const addr of addresses) {
    if (isPrivateOrLocalAddress(addr.address)) {
      throw new WxRelayError('validation', 'Private, local, or link-local image URLs are not allowed');
    }
  }
}

function isPrivateOrLocalAddress(address) {
  if (address === '127.0.0.1' || address === '::1') return true;
  const family = net.isIP(address);
  if (family === 4) {
    const parts = address.split('.').map(Number);
    const [a, b] = parts;
    return a === 10
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168)
      || (a === 169 && b === 254)
      || a === 0
      || a === 127;
  }
  if (family === 6) {
    const lower = address.toLowerCase();
    return lower === '::1' || lower.startsWith('fc') || lower.startsWith('fd') || lower.startsWith('fe80');
  }
  return true;
}

app.post('/api/publish/submit', async (req, res) => {
  try {
    const data = await callWxApi({
      path: '/cgi-bin/freepublish/submit',
      data: { media_id: req.body.media_id },
      stage: 'publish_submit',
    });
    res.json(data);
  } catch (err) {
    sendError(res, err, 'publish_submit');
  }
});

app.post('/api/publish/status', async (req, res) => {
  try {
    const data = await callWxApi({
      path: '/cgi-bin/freepublish/get',
      data: { publish_id: req.body.publish_id },
      stage: 'publish_status',
    });
    res.json(data);
  } catch (err) {
    sendError(res, err, 'publish_status');
  }
});

app.post('/api/publish/delete', async (req, res) => {
  try {
    const data = await callWxApi({
      path: '/cgi-bin/freepublish/delete',
      data: { article_id: req.body.article_id, index: req.body.index },
      stage: 'publish_delete',
    });
    res.json(data);
  } catch (err) {
    sendError(res, err, 'publish_delete');
  }
});

app.post('/api/proxy', async (req, res) => {
  if (!CONFIG.ENABLE_GENERIC_PROXY) {
    return res.status(404).json({ ok: false, error: 'Generic proxy is disabled' });
  }

  try {
    const { path: apiPath, method = 'POST', data = {}, params = {} } = req.body;
    const result = await callWxApi({ method, path: apiPath, data, params, stage: 'generic_proxy' });
    res.json(result);
  } catch (err) {
    sendError(res, err, 'generic_proxy');
  }
});

app.use((req, res) => {
  res.status(404).json({ ok: false, error: `NotFound: ${req.method} ${req.path}` });
});

app.use((err, req, res, _next) => {
  if (err instanceof multer.MulterError || err instanceof WxRelayError) {
    return sendError(res, err, err.stage || 'request', 400);
  }
  log('ERROR', 'Unhandled exception', { error: err.message, stack: err.stack });
  res.status(500).json({ ok: false, error: 'Internal Server Error' });
});

loadTokenFromDisk();

const TLS_CERT = process.env.TLS_CERT || '';
const TLS_KEY = process.env.TLS_KEY || '';

function printBanner({ httpPort, httpsPort }) {
  console.log('='.repeat(55));
  console.log('  wxofficial-relay - WeChat Official Account API relay');
  console.log('='.repeat(55));
  if (httpPort) console.log(`  HTTP:    http://localhost:${httpPort}`);
  if (httpsPort) console.log(`  HTTPS:   https://${CONFIG.HOST}:${httpsPort}`);
  console.log('  Auth:    X-Api-Key or Authorization: Bearer');
  console.log(`  Rate:    ${CONFIG.RATE_LIMIT_RPM > 0 ? CONFIG.RATE_LIMIT_RPM + ' req/min' : 'disabled'}`);
  console.log(`  Proxy:   ${CONFIG.ENABLE_GENERIC_PROXY ? 'enabled' : 'disabled'}`);
  console.log('='.repeat(55));
}

app.listen(CONFIG.PORT, CONFIG.HOST, () => {
  printBanner({ httpPort: CONFIG.PORT, httpsPort: TLS_CERT && TLS_KEY ? CONFIG.PORT + 1 : 0 });
});

if (TLS_CERT && TLS_KEY && fs.existsSync(TLS_CERT) && fs.existsSync(TLS_KEY)) {
  const httpsPort = CONFIG.PORT + 1;
  https.createServer({
    cert: fs.readFileSync(TLS_CERT),
    key: fs.readFileSync(TLS_KEY),
  }, app).listen(httpsPort, CONFIG.HOST, () => {
    log('INFO', 'HTTPS server started', { port: httpsPort });
  });
} else if (TLS_CERT || TLS_KEY) {
  log('WARN', 'TLS_CERT or TLS_KEY does not exist, skipping HTTPS');
}

getAccessToken().catch((err) => {
  log('WARN', 'Startup access_token warmup failed', { error: err.message });
});

process.on('uncaughtException', (err) => {
  log('ERROR', 'Uncaught exception, shutting down', { error: err.message, stack: err.stack });
  saveTokenToDisk();
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  log('ERROR', 'Unhandled rejection, shutting down', { error: reason?.message || String(reason), stack: reason?.stack });
  saveTokenToDisk();
  process.exit(1);
});

process.on('SIGTERM', () => { saveTokenToDisk(); process.exit(0); });
process.on('SIGINT', () => { saveTokenToDisk(); process.exit(0); });
