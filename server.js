#!/usr/bin/env node
/**
 * wx-proxy  —— 微信公众号 API 中转代理服务
 *
 * 问题：微信公众平台要求 API 调用方 IP 加入白名单，
 *       但家庭宽带是动态轮换 IP，无法固定。
 * 方案：将此服务部署在固定 IP 的云服务器上，
 *       家庭服务器通过 HTTP 调用本服务，由本服务代为请求微信 API。
 *
 * 架构：
 *   家庭服务器(动态IP) ──HTTP + X-Api-Key──▶ wx-proxy(固定IP) ──HTTPS──▶ api.weixin.qq.com
 *
 * 使用：
 *   1. cp .env.example .env && 编辑 .env
 *   2. node server.js
 *   3. 将本服务器 IP 加入微信公众号后台的 IP 白名单
 */

require('dotenv').config();
const express = require('express');
const axios = require('axios');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ─── 配置 ───────────────────────────────────────────────
const CONFIG = {
  APP_ID: process.env.WX_APP_ID,
  APP_SECRET: process.env.WX_APP_SECRET,
  PORT: parseInt(process.env.PORT || '3900', 10),
  HOST: process.env.HOST || '0.0.0.0',
  API_KEY: process.env.API_KEY,
  RATE_LIMIT_RPM: parseInt(process.env.RATE_LIMIT_RPM || '0', 10),
  TOKEN_CACHE_FILE: process.env.TOKEN_CACHE_FILE || null,
};

// 启动前校验
if (!CONFIG.APP_ID || !CONFIG.APP_SECRET) {
  console.error('[FATAL] 缺少 WX_APP_ID / WX_APP_SECRET，请在 .env 中配置');
  process.exit(1);
}
if (!CONFIG.API_KEY) {
  console.warn('[WARN] 未设置 API_KEY，服务将无鉴权运行！建议设置复杂随机字符串');
}

// ─── 日志工具 ─────────────────────────────────────────────
const LOG_LEVELS = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };
const LOG_LEVEL = LOG_LEVELS[process.env.LOG_LEVEL?.toUpperCase()] ?? LOG_LEVELS.INFO;

function log(level, msg, detail) {
  if (LOG_LEVELS[level] < LOG_LEVEL) return;
  const ts = new Date().toISOString();
  const line = {
    ts,
    level,
    msg,
    ...(detail ? { detail } : {})
  };
  if (level === 'ERROR') console.error(JSON.stringify(line));
  else console.log(JSON.stringify(line));
}

// ─── Token 管理 ───────────────────────────────────────────
let tokenCache = { access_token: null, expiresAt: 0 };

// 从磁盘恢复缓存的 token（可选）
function loadTokenFromDisk() {
  if (!CONFIG.TOKEN_CACHE_FILE) return;
  try {
    if (fs.existsSync(CONFIG.TOKEN_CACHE_FILE)) {
      const raw = fs.readFileSync(CONFIG.TOKEN_CACHE_FILE, 'utf-8');
      const cached = JSON.parse(raw);
      if (cached.access_token && cached.expiresAt > Date.now()) {
        tokenCache = cached;
        log('INFO', '从磁盘恢复了 access_token 缓存', {
          expiresAt: new Date(cached.expiresAt).toISOString()
        });
      }
    }
  } catch (e) {
    log('WARN', '读取 token 缓存文件失败', { error: e.message });
  }
}

function saveTokenToDisk() {
  if (!CONFIG.TOKEN_CACHE_FILE) return;
  try {
    const dir = path.dirname(CONFIG.TOKEN_CACHE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(CONFIG.TOKEN_CACHE_FILE, JSON.stringify(tokenCache));
  } catch (e) {
    log('WARN', '保存 token 缓存失败', { error: e.message });
  }
}

async function getAccessToken() {
  const now = Date.now();
  // 提前 5 分钟过期，避免边界
  if (tokenCache.access_token && tokenCache.expiresAt > now + 5 * 60 * 1000) {
    return tokenCache.access_token;
  }

  log('INFO', '获取新的 access_token');
  const url = `https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=${CONFIG.APP_ID}&secret=${CONFIG.APP_SECRET}`;

  try {
    const res = await axios.get(url, { timeout: 10000 });
    const data = res.data;

    if (data.errcode) {
      throw new Error(`微信返回错误 [${data.errcode}]: ${data.errmsg}`);
    }
    if (!data.access_token) {
      throw new Error('微信未返回 access_token');
    }

    tokenCache = {
      access_token: data.access_token,
      expiresAt: now + data.expires_in * 1000,
    };

    saveTokenToDisk();
    log('INFO', 'access_token 获取成功', {
      expiresAt: new Date(tokenCache.expiresAt).toISOString(),
      expiresInSec: data.expires_in
    });
    return data.access_token;
  } catch (err) {
    log('ERROR', '获取 access_token 失败', { error: err.message });
    throw err;
  }
}

// ─── App 初始化 ───────────────────────────────────────────
const app = express();

// Body 解析（大文件支持 50MB，满足图片上传）
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// 请求日志
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

// ─── 认证中间件 ───────────────────────────────────────────
function authMiddleware(req, res, next) {
  if (!CONFIG.API_KEY) return next(); // 未配置 API_KEY 则跳过鉴权

  const key = req.headers['x-api-key'];
  if (!key || key !== CONFIG.API_KEY) {
    log('WARN', '鉴权失败', { ip: req.ip, path: req.path });
    return res.status(401).json({
      ok: false,
      error: 'Unauthorized: 请在 Header 中提供正确的 X-Api-Key',
    });
  }
  next();
}

app.use('/api', authMiddleware);

// ─── 速率限制（可选）───────────────────────────────────────
if (CONFIG.RATE_LIMIT_RPM > 0) {
  const rateLimit = require('express-rate-limit');
  app.use('/api', rateLimit({
    windowMs: 60 * 1000,
    max: CONFIG.RATE_LIMIT_RPM,
    standardHeaders: true,
    legacyHeaders: false,
    message: { ok: false, error: '请求太频繁，请稍后再试' }
  }));
}

// ─── 路由: 健康检查 ───────────────────────────────────────
app.get('/health', async (req, res) => {
  const tokenOk = !!(tokenCache.access_token && tokenCache.expiresAt > Date.now());
  // 如果 token 过期，尝试刷新（顺便作为探活）
  if (!tokenOk) {
    try { await getAccessToken(); } catch (_) { /* ignore */ }
  }
  res.json({
    ok: true,
    time: new Date().toISOString(),
    tokenCached: tokenOk,
    uptime: Math.floor(process.uptime()),
    version: require('./package.json').version,
  });
});

// ─── 辅助: 统一调用微信 API ───────────────────────────────
const WX_API_BASE = 'https://api.weixin.qq.com';

async function callWxApi({ method = 'POST', path: apiPath, data = {}, params = {} }) {
  const token = await getAccessToken();
  const sep = apiPath.includes('?') ? '&' : '?';
  const url = `${WX_API_BASE}${apiPath}${sep}access_token=${token}`;

  const opts = {
    method: method.toUpperCase(),
    url,
    timeout: 30000,
  };

  if (method.toUpperCase() === 'GET') {
    opts.params = { ...params, ...data };
  } else {
    opts.data = data;
  }

  return axios(opts);
}

// ─── 路由: 草稿 ───────────────────────────────────────────
// 新建草稿
app.post('/api/draft/add', async (req, res) => {
  try {
    const result = await callWxApi({
      path: '/cgi-bin/draft/add',
      data: req.body,
    });
    res.json(result.data);
  } catch (err) {
    log('ERROR', '新建草稿失败', { error: err.message });
    res.status(502).json({ ok: false, error: `微信 API 调用失败: ${err.message}` });
  }
});

// 获取草稿列表
app.get('/api/draft/list', async (req, res) => {
  try {
    const result = await callWxApi({
      method: 'POST',
      path: '/cgi-bin/draft/batchget',
      data: {
        offset: parseInt(req.query.offset) || 0,
        count: Math.min(parseInt(req.query.count) || 20, 20),
        no_content: parseInt(req.query.no_content) || 0,
      },
    });
    res.json(result.data);
  } catch (err) {
    log('ERROR', '获取草稿列表失败', { error: err.message });
    res.status(502).json({ ok: false, error: `微信 API 调用失败: ${err.message}` });
  }
});

// 获取单个草稿详情
app.get('/api/draft/:mediaId', async (req, res) => {
  try {
    const result = await callWxApi({
      method: 'POST',
      path: '/cgi-bin/draft/get',
      data: { media_id: req.params.mediaId },
    });
    res.json(result.data);
  } catch (err) {
    log('ERROR', '获取草稿详情失败', { error: err.message });
    res.status(502).json({ ok: false, error: `微信 API 调用失败: ${err.message}` });
  }
});

// 删除草稿
app.post('/api/draft/delete', async (req, res) => {
  try {
    const result = await callWxApi({
      path: '/cgi-bin/draft/delete',
      data: { media_id: req.body.media_id },
    });
    res.json(result.data);
  } catch (err) {
    log('ERROR', '删除草稿失败', { error: err.message });
    res.status(502).json({ ok: false, error: `微信 API 调用失败: ${err.message}` });
  }
});

// 更新草稿
app.post('/api/draft/update', async (req, res) => {
  try {
    const { media_id, ...articles } = req.body;
    const result = await callWxApi({
      path: '/cgi-bin/draft/update',
      data: { media_id, ...articles },
    });
    res.json(result.data);
  } catch (err) {
    log('ERROR', '更新草稿失败', { error: err.message });
    res.status(502).json({ ok: false, error: `微信 API 调用失败: ${err.message}` });
  }
});

// ─── 路由: 发布 ───────────────────────────────────────────
// 发布草稿
app.post('/api/publish/submit', async (req, res) => {
  try {
    const result = await callWxApi({
      path: '/cgi-bin/freepublish/submit',
      data: { media_id: req.body.media_id },
    });
    res.json(result.data);
  } catch (err) {
    log('ERROR', '发布失败', { error: err.message });
    res.status(502).json({ ok: false, error: `微信 API 调用失败: ${err.message}` });
  }
});

// 查询发布状态
app.post('/api/publish/status', async (req, res) => {
  try {
    const result = await callWxApi({
      path: '/cgi-bin/freepublish/get',
      data: { publish_id: req.body.publish_id },
    });
    res.json(result.data);
  } catch (err) {
    log('ERROR', '查询发布状态失败', { error: err.message });
    res.status(502).json({ ok: false, error: `微信 API 调用失败: ${err.message}` });
  }
});

// 删除已发布文章
app.post('/api/publish/delete', async (req, res) => {
  try {
    const result = await callWxApi({
      path: '/cgi-bin/freepublish/delete',
      data: { article_id: req.body.article_id, index: req.body.index },
    });
    res.json(result.data);
  } catch (err) {
    log('ERROR', '删除已发布文章失败', { error: err.message });
    res.status(502).json({ ok: false, error: `微信 API 调用失败: ${err.message}` });
  }
});

// ─── 路由: 素材/图片上传 ───────────────────────────────────
// 上传封面图（永久素材，thumb 类型）
app.post('/api/media/uploadthumb', async (req, res) => {
  try {
    const { image_url } = req.body;
    if (!image_url) {
      return res.status(400).json({ ok: false, error: '缺少 image_url 参数' });
    }
    const { buffer, contentType, ext } = await downloadImage(image_url);

    const FormData = require('form-data');
    const form = new FormData();
    form.append('media', buffer, { filename: `thumb.${ext}`, contentType });

    const token = await getAccessToken();
    const uploadUrl = `${WX_API_BASE}/cgi-bin/material/add_material?access_token=${token}&type=thumb`;
    const result = await axios.post(uploadUrl, form, {
      headers: form.getHeaders(),
      timeout: 30000,
    });

    res.json(result.data);
  } catch (err) {
    log('ERROR', '上传封面图失败', { error: err.message });
    res.status(502).json({ ok: false, error: `上传失败: ${err.message}` });
  }
});

// 上传正文图片（返回微信 URL，可直接在文章 HTML 中使用）
app.post('/api/media/uploadimage', async (req, res) => {
  try {
    const { image_url } = req.body;
    if (!image_url) {
      return res.status(400).json({ ok: false, error: '缺少 image_url 参数' });
    }
    const { buffer, contentType, ext } = await downloadImage(image_url);

    const FormData = require('form-data');
    const form = new FormData();
    form.append('media', buffer, { filename: `image.${ext}`, contentType });

    const token = await getAccessToken();
    const uploadUrl = `${WX_API_BASE}/cgi-bin/media/uploadimg?access_token=${token}`;
    const result = await axios.post(uploadUrl, form, {
      headers: form.getHeaders(),
      timeout: 30000,
    });

    res.json(result.data);
  } catch (err) {
    log('ERROR', '上传正文图片失败', { error: err.message });
    res.status(502).json({ ok: false, error: `上传失败: ${err.message}` });
  }
});

/** 从 URL 下载图片，返回 Buffer + 元信息 */
async function downloadImage(url) {
  const res = await axios.get(url, {
    responseType: 'arraybuffer',
    timeout: 30000,
    maxContentLength: 10 * 1024 * 1024, // 10MB 限制
  });
  const buffer = Buffer.from(res.data);
  const contentType = res.headers['content-type'] || 'image/jpeg';
  const ext = contentType.includes('png') ? 'png'
            : contentType.includes('gif') ? 'gif'
            : contentType.includes('webp') ? 'webp'
            : contentType.includes('svg') ? 'svg'
            : 'jpg';
  return { buffer, contentType, ext };
}

// ─── 路由: 通用转发（兜底，支持任意微信 API）─────────────────
app.post('/api/proxy', async (req, res) => {
  try {
    const { path: apiPath, method = 'POST', data = {}, params = {} } = req.body;
    if (!apiPath) {
      return res.status(400).json({ ok: false, error: '缺少 path 参数（例如 /cgi-bin/xxx）' });
    }

    // 安全限制：禁止转发到非微信域名，禁止路径穿越
    if (apiPath.includes('..') || apiPath.includes('//')) {
      return res.status(400).json({ ok: false, error: '非法 path' });
    }

    const result = await callWxApi({ method, path: apiPath, data, params });
    res.json(result.data);
  } catch (err) {
    log('ERROR', '通用转发失败', { error: err.message, path: req.body.path });
    res.status(502).json({ ok: false, error: `微信 API 调用失败: ${err.message}` });
  }
});

// ─── 路由: Token 查询（调试用）─────────────────────────────
app.get('/api/token', async (req, res) => {
  try {
    const token = await getAccessToken();
    res.json({
      ok: true,
      access_token: token,
      cached: true,
      expiresAt: new Date(tokenCache.expiresAt).toISOString(),
    });
  } catch (err) {
    res.status(502).json({ ok: false, error: err.message });
  }
});

// ─── 404 ──────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ ok: false, error: `NotFound: ${req.method} ${req.path}` });
});

// ─── 全局错误处理 ──────────────────────────────────────────
app.use((err, req, res, _next) => {
  log('ERROR', '未捕获异常', { error: err.message, stack: err.stack });
  res.status(500).json({ ok: false, error: 'Internal Server Error' });
});

// ─── 启动 ──────────────────────────────────────────────────
loadTokenFromDisk();

const TLS_CERT = process.env.TLS_CERT || '';
const TLS_KEY = process.env.TLS_KEY || '';

// 打印 banner
function printBanner({ httpPort, httpsPort }) {
  console.log('═'.repeat(55));
  console.log('  wx-proxy  ——  微信公众号 API 中转代理');
  console.log('═'.repeat(55));
  if (httpPort) console.log(`  HTTP:    http://localhost:${httpPort}`);
  if (httpsPort) console.log(`  HTTPS:   https://${CONFIG.HOST}:${httpsPort}`);
  console.log(`  认证:    ${CONFIG.API_KEY ? 'X-Api-Key' : '无（⚠ 危险）'}`);
  console.log(`  限速:    ${CONFIG.RATE_LIMIT_RPM > 0 ? CONFIG.RATE_LIMIT_RPM + ' req/min' : '关闭'}`);
  console.log('═'.repeat(55));
}

// 启动 HTTP
app.listen(CONFIG.PORT, CONFIG.HOST, () => {
  printBanner({ httpPort: CONFIG.PORT, httpsPort: TLS_CERT && TLS_KEY ? CONFIG.PORT + 1 : 0 });
});

// 启动 HTTPS（如果配置了证书）
if (TLS_CERT && TLS_KEY && fs.existsSync(TLS_CERT) && fs.existsSync(TLS_KEY)) {
  const httpsPort = CONFIG.PORT + 1;
  const tlsOpts = {
    cert: fs.readFileSync(TLS_CERT),
    key: fs.readFileSync(TLS_KEY),
  };
  https.createServer(tlsOpts, app).listen(httpsPort, CONFIG.HOST, () => {
    log('INFO', `HTTPS 服务启动`, { port: httpsPort });
  });
} else if (TLS_CERT || TLS_KEY) {
  log('WARN', 'TLS_CERT 或 TLS_KEY 文件不存在，跳过 HTTPS');
}

// 启动时预热 token
getAccessToken().catch(err => {
  log('WARN', '启动预热 access_token 失败，请检查配置', { error: err.message });
});

// 优雅退出
process.on('SIGTERM', () => { saveTokenToDisk(); process.exit(0); });
process.on('SIGINT', () => { saveTokenToDisk(); process.exit(0); });
