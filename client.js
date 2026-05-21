#!/usr/bin/env node
/**
 * wx-proxy 客户端 SDK
 *
 * 部署在家庭服务器（动态 IP）上，用于连接云服务器上的 wx-proxy 服务。
 * 可以以编程方式使用（require），也可以作为 CLI 使用。
 *
 * 作为 CLI 使用:
 *   node client.js health
 *   node client.js draft:add '{"articles":[...]}'
 *   node client.js draft:list
 *   node client.js media:uploadimage '{"image_url":"https://..."}'
 *   node client.js publish:submit '{"media_id":"xxx"}'
 *
 * 作为库使用:
 *   const WxClient = require('./client');
 *   const wx = WxClient.create({ serverUrl: 'http://43.142.162.14:3900', apiKey: 'xxx' });
 *   await wx.health();
 *   await wx.draft.add({ articles: [...] });
 */

const axios = require('axios');
const https = require('https');
const fs = require('fs');
const path = require('path');

// 默认的 HTTPS Agent：接受自签证书（生产环境建议传入 CA 证书路径）
const insecureAgent = new https.Agent({ rejectUnauthorized: false });

class WxClient {
  /**
   * @param {object} opts
   * @param {string} opts.serverUrl  wx-proxy 服务器地址，如 http://43.142.162.14:3900
   * @param {string} opts.apiKey     API 密钥，与服务端 .env 中的 API_KEY 一致
   * @param {number} [opts.timeout]  请求超时毫秒数，默认 60000
   */
  constructor(opts) {
    this.serverUrl = (opts.serverUrl || '').replace(/\/+$/, ''); // 去尾部斜杠
    this.apiKey = opts.apiKey || '';
    this.timeout = opts.timeout || 60000;
    // 如果传入 caCertPath，使用可信连接；否则接受自签证书
    if (opts.caCertPath && fs.existsSync(opts.caCertPath)) {
      this.httpsAgent = new https.Agent({ ca: fs.readFileSync(opts.caCertPath) });
    } else if (this.serverUrl.startsWith('https')) {
      this.httpsAgent = insecureAgent;
    } else {
      this.httpsAgent = null;
    }
  }

  // ─── 底层请求 ──────────────────────────────────────────────

  async _request(method, path, data) {
    const url = `${this.serverUrl}${path}`;
    const headers = {};

    if (this.apiKey) {
      headers['X-Api-Key'] = this.apiKey;
    }

    try {
      const opts = { method, url, headers, timeout: this.timeout };
      if (this.httpsAgent) opts.httpsAgent = this.httpsAgent;
      if (method === 'get' || method === 'delete') {
        opts.params = data;
      } else {
        opts.data = data;
      }
      const res = await axios(opts);
      return res.data;
    } catch (err) {
      if (err.response) {
        // 服务器返回了错误响应
        throw new WxProxyError(
          err.response.data?.error || `HTTP ${err.response.status}`,
          err.response.data
        );
      }
      // 网络错误
      throw new WxProxyError(`无法连接到 wx-proxy 服务器: ${err.message}`);
    }
  }

  async _get(path, params) { return this._request('get', path, params); }
  async _post(path, body) { return this._request('post', path, body); }

  // ─── 健康检查 ──────────────────────────────────────────────

  /** 检查服务是否正常 */
  async health() {
    return this._get('/health');
  }

  /** 获取当前缓存的 access_token（调试用） */
  async getToken() {
    return this._get('/api/token');
  }

  // ─── 草稿 ──────────────────────────────────────────────────

  draft = {
    /** 新建草稿 */
    add: async (articles) => {
      return this._post('/api/draft/add', articles);
    },
    /** 获取草稿列表 */
    list: async (opts = {}) => {
      return this._get('/api/draft/list', {
        offset: opts.offset || 0,
        count: opts.count || 20,
        no_content: opts.no_content || 0,
      });
    },
    /** 获取单个草稿详情 */
    get: async (mediaId) => {
      return this._get(`/api/draft/${mediaId}`);
    },
    /** 更新草稿 */
    update: async (data) => {
      return this._post('/api/draft/update', data);
    },
    /** 删除草稿 */
    delete: async (mediaId) => {
      return this._post('/api/draft/delete', { media_id: mediaId });
    },
  };

  // ─── 发布 ──────────────────────────────────────────────────

  publish = {
    /** 发布草稿 */
    submit: async (mediaId) => {
      return this._post('/api/publish/submit', { media_id: mediaId });
    },
    /** 查询发布状态 */
    status: async (publishId) => {
      return this._post('/api/publish/status', { publish_id: publishId });
    },
    /** 删除已发布文章 */
    delete: async (articleId, index = 1) => {
      return this._post('/api/publish/delete', { article_id: articleId, index });
    },
  };

  // ─── 素材/图片 ─────────────────────────────────────────────

  media = {
    /**
     * 上传封面图：传图片 URL，服务器下载后上传微信，返回 media_id
     * 返回的 media_id 在 draft.add 时作为 thumb_media_id 使用
     */
    uploadThumb: async (imageUrl) => {
      return this._post('/api/media/uploadthumb', { image_url: imageUrl });
    },

    /**
     * 上传正文图片：传图片 URL，返回微信图片 URL
     * 可直接替换 HTML 中的 <img src="..." />
     */
    uploadImage: async (imageUrl) => {
      return this._post('/api/media/uploadimage', { image_url: imageUrl });
    },
  };

  // ─── 通用转发 ──────────────────────────────────────────────

  /**
   * 通用微信 API 转发（未封装的接口用这个）
   * @param {string} apiPath 微信 API 路径，如 /cgi-bin/menu/create
   * @param {string} method  GET | POST
   * @param {object} data   请求体
   */
  async proxy(apiPath, method = 'POST', data = {}) {
    return this._post('/api/proxy', { path: apiPath, method, data });
  }

  // ─── 便捷方法：完整发布流程 ─────────────────────────────────

  /**
   * 一键发布 Markdown/HTML 文章到公众号草稿
   *
   * @param {object} article
   * @param {string} article.title            标题
   * @param {string} article.content          正文 HTML
   * @param {string} [article.thumbUrl]       封面图 URL（可选，不上传则用空字符串）
   * @param {string} [article.author]         作者
   * @param {string} [article.digest]         摘要
   * @param {string} [article.contentSourceUrl] 原文链接
   * @returns {object} 草稿创建结果（包含 media_id）
   */
  async publishArticle(article) {
    let thumbMediaId = '';
    if (article.thumbUrl) {
      const thumbRes = await this.media.uploadThumb(article.thumbUrl);
      if (thumbRes.media_id) {
        thumbMediaId = thumbRes.media_id;
      } else if (thumbRes.errcode) {
        throw new WxProxyError(`上传封面失败`, thumbRes);
      }
    }

    const draftData = {
      articles: [{
        title: article.title,
        content: article.content,
        thumb_media_id: thumbMediaId,
        author: article.author || '',
        digest: article.digest || '',
        content_source_url: article.contentSourceUrl || '',
        need_open_comment: article.needOpenComment ?? 0,
        only_fans_can_comment: article.onlyFansCanComment ?? 0,
      }]
    };

    return this.draft.add(draftData);
  }

  /**
   * 将文章内容中的远程图片 URL 批量上传到微信，并替换为微信地址
   * @param {string} htmlContent  文章 HTML
   * @param {string[]} [extraUrls] 额外需要替换的图片 URL（如封面）
   * @returns {{ content: string, urlMap: Record<string, string> }}
   */
  async uploadImagesInContent(htmlContent, extraUrls = []) {
    // 从 HTML 中提取所有 img src
    const imgRegex = /<img[^>]+src=["']([^"']+)["'][^>]*>/gi;
    const urls = new Set(extraUrls);
    let match;
    while ((match = imgRegex.exec(htmlContent)) !== null) {
      urls.add(match[1]);
    }

    const urlMap = {}; // 原始URL → 微信URL
    for (const url of urls) {
      if (!url || url.startsWith('data:') || url.includes('mmbiz.qpic.cn')) {
        // 跳过 data URI 和已经是微信图片的 URL
        urlMap[url] = url;
        continue;
      }
      const res = await this.media.uploadImage(url);
      if (res.url) {
        urlMap[url] = res.url;
      } else {
        console.warn(`[wx-client] 上传图片失败，保留原始URL: ${url}`, res);
        urlMap[url] = url;
      }
    }

    // 替换 HTML 中的图片 URL
    let content = htmlContent;
    for (const [oldUrl, newUrl] of Object.entries(urlMap)) {
      if (oldUrl !== newUrl) {
        content = content.split(oldUrl).join(newUrl);
      }
    }

    return { content, urlMap };
  }

  /**
   * 一键：上传所有图片 + 创建草稿
   */
  async publishArticleAuto(article) {
    const { content, urlMap } = await this.uploadImagesInContent(
      article.content,
      article.thumbUrl ? [article.thumbUrl] : []
    );

    return this.publishArticle({
      ...article,
      content,
      thumbUrl: urlMap[article.thumbUrl] || article.thumbUrl,
    });
  }
}

/** 自定义错误类 */
class WxProxyError extends Error {
  constructor(message, details) {
    super(message);
    this.name = 'WxProxyError';
    this.details = details;
  }
}

WxClient.WxProxyError = WxProxyError;

/**
 * 快速创建客户端实例
 */
WxClient.create = (opts) => new WxClient(opts);

// ─── CLI 模式 ──────────────────────────────────────────────────
async function cli() {
  const args = process.argv.slice(2);
  const cmd = args[0];

  // 从环境变量读取配置
  const serverUrl = process.env.WX_PROXY_URL || 'https://localhost:3901';
  const apiKey = process.env.WX_PROXY_KEY || '';

  // 特殊命令：不需要连接服务器
  if (cmd === 'config' || cmd === 'setup') {
    console.log('# wx-proxy 客户端配置');
    console.log('# 在 ~/.bashrc 或 .env 中设置以下环境变量:');
    console.log(`export WX_PROXY_URL="${serverUrl}"`);
    console.log(`export WX_PROXY_KEY="${apiKey || 'your-api-key-here'}"`);
    return;
  }

  const wx = WxClient.create({ serverUrl, apiKey });

  try {
    switch (cmd) {
      case 'health': {
        const r = await wx.health();
        console.log(JSON.stringify(r, null, 2));
        break;
      }

      case 'token': {
        const r = await wx.getToken();
        console.log(JSON.stringify(r, null, 2));
        break;
      }

      case 'draft:add': {
        const data = JSON.parse(args[1] || '{}');
        const r = await wx.draft.add(data);
        console.log(JSON.stringify(r, null, 2));
        break;
      }

      case 'draft:list': {
        const r = await wx.draft.list({ count: 10 });
        if (r.item) {
          for (const item of r.item) {
            console.log(`  media_id: ${item.media_id}`);
            const c = item.content?.news_item?.[0];
            if (c) console.log(`  title: ${c.title}`);
            console.log(`  updated: ${new Date(item.update_time * 1000).toISOString()}`);
            console.log('');
          }
        } else {
          console.log(JSON.stringify(r, null, 2));
        }
        break;
      }

      case 'draft:get': {
        const r = await wx.draft.get(args[1]);
        console.log(JSON.stringify(r, null, 2));
        break;
      }

      case 'draft:delete': {
        const r = await wx.draft.delete(args[1]);
        console.log(JSON.stringify(r, null, 2));
        break;
      }

      case 'publish:submit': {
        const r = await wx.publish.submit(args[1]);
        console.log(JSON.stringify(r, null, 2));
        break;
      }

      case 'publish:status': {
        const r = await wx.publish.status(args[1]);
        console.log(JSON.stringify(r, null, 2));
        break;
      }

      case 'media:uploadimage': {
        const data = JSON.parse(args[1] || '{}');
        const r = await wx.media.uploadImage(data.image_url);
        console.log(JSON.stringify(r, null, 2));
        break;
      }

      case 'media:uploadthumb': {
        const data = JSON.parse(args[1] || '{}');
        const r = await wx.media.uploadThumb(data.image_url);
        console.log(JSON.stringify(r, null, 2));
        break;
      }

      default:
        console.log('wx-proxy 客户端 CLI');
        console.log('');
        console.log('用法: node client.js <命令> [参数]');
        console.log('');
        console.log('命令:');
        console.log('  health              健康检查');
        console.log('  token               查看 access_token');
        console.log('  draft:add <JSON>     新建草稿');
        console.log('  draft:list           草稿列表');
        console.log('  draft:get <media_id> 草稿详情');
        console.log('  draft:delete <id>    删除草稿');
        console.log('  publish:submit <id>  发布草稿');
        console.log('  publish:status <id>  查询发布状态');
        console.log('  media:uploadimage <JSON>  上传正文图片');
        console.log('  media:uploadthumb <JSON>  上传封面图');
        console.log('');
        console.log('环境变量:');
        console.log(`  WX_PROXY_URL=${serverUrl}`);
        console.log(`  WX_PROXY_KEY=${apiKey ? '(已设置)' : '(未设置)'}`);
    }
  } catch (err) {
    console.error(`[ERROR] ${err.message}`);
    if (err.details) {
      console.error('详情:', JSON.stringify(err.details, null, 2));
    }
    process.exit(1);
  }
}

// 判断是否作为 CLI 运行
if (require.main === module) {
  cli();
}

module.exports = WxClient;
