# wxofficial-relay

微信公众号 API 中转服务，用固定公网 IP 解决家庭服务器无法加入微信 IP 白名单的问题。

设计目标很窄：它不是通用代理，也不是云端生成器。Mac mini 负责生成文章、排版和图片；云服务器 relay 只负责从白名单 IP 调微信官方接口。

## 架构

```text
Mac mini / Hermes Agent
  -> 生成 Markdown、HTML、封面、正文图片
  -> multipart/form-data 调用 relay

Cloud server / fixed IP
  -> 获取并缓存 access_token
  -> 上传封面永久素材
  -> 上传正文图片到微信 CDN
  -> 替换 HTML 中的 img src
  -> 创建公众号草稿

WeChat Official Account
  -> IP 白名单只需要填云服务器公网 IP
```

## 部署

```bash
git clone https://github.com/BubblePtr/wxofficial-relay.git
cd wxofficial-relay
npm ci
cp .env.example .env
nano .env
node server.js
```

生产环境建议用 pm2 或 systemd：

```bash
npm install -g pm2
pm2 start server.js --name wxofficial-relay
pm2 save
pm2 startup
```

`.env` 至少需要：

```ini
WX_APP_ID=wx_your_app_id
WX_APP_SECRET=your_secret
PORT=3900
API_KEY=use_openssl_rand_hex_32_here
RATE_LIMIT_RPM=60
TOKEN_CACHE_FILE=/tmp/wxofficial-relay-token.json
```

生成 API key：

```bash
openssl rand -hex 32
```

微信公众号后台需要把云服务器公网 IP 加入：

```text
设置与开发 -> 基本配置 -> IP 白名单
```

## HTTPS

公网部署不要裸 HTTP 传 API key。推荐用 Caddy 或 Nginx 终止 TLS，然后反代到本地 `3900`。

Caddy 示例：

```caddyfile
wx.example.com {
  reverse_proxy 127.0.0.1:3900
}
```

客户端使用：

```bash
export WX_PROXY_URL=https://wx.example.com
export WX_PROXY_KEY=your_api_key
node client.js health
```

如果临时使用自签证书，客户端可以显式开启不校验证书：

```bash
export WX_PROXY_INSECURE_TLS=1
```

这个只建议调试时用。

## Mac mini 侧用法

```javascript
const WxClient = require('./client');

const wx = WxClient.create({
  serverUrl: process.env.WX_PROXY_URL,
  apiKey: process.env.WX_PROXY_KEY,
});

const result = await wx.createDraftAuto({
  title: '文章标题',
  author: '作者',
  digest: '摘要',
  contentHtml: html,
  coverPath: './cover.png',
  images: [
    { src: './assets/inline-1.png', path: './assets/inline-1.png' },
    { src: './assets/inline-2.png', path: './assets/inline-2.png' },
  ],
});

console.log(result.media_id);
```

如果 HTML 里的图片路径和 `assetsDir` 里的文件名能对应，也可以这样：

```javascript
await wx.createDraftAuto({
  title: '文章标题',
  digest: '摘要',
  contentHtml: html,
  coverPath: './cover.png',
  assetsDir: './assets',
});
```

## CLI

```bash
node client.js health
node client.js token:status
node client.js draft:list
node client.js media:upload-cover ./cover.png
node client.js media:upload-inline ./assets/inline-1.png
```

使用 JSON 文件创建草稿：

```bash
node client.js draft:create-auto article.json
```

`article.json` 示例：

```json
{
  "title": "文章标题",
  "author": "作者",
  "digest": "摘要",
  "contentHtml": "<p>正文 <img src=\"./assets/inline-1.png\"></p>",
  "coverPath": "./cover.png",
  "images": [
    { "src": "./assets/inline-1.png", "path": "./assets/inline-1.png" }
  ]
}
```

## API

所有 `/api/*` 路由都需要认证。支持：

```http
X-Api-Key: your_api_key
```

也支持：

```http
Authorization: Bearer your_api_key
```

核心接口：

```text
GET  /health
GET  /api/token/status
POST /api/draft/create-auto
POST /api/media/upload-cover
POST /api/media/upload-inline-image
POST /api/draft/add
GET  /api/draft/list
GET  /api/draft/:mediaId
POST /api/draft/update
POST /api/draft/delete
```

`POST /api/draft/create-auto` 使用 `multipart/form-data`：

```text
title: string
author: string
digest: string
content_html: string
content_source_url: string
cover: file
images: file[]
image_map: JSON object, e.g. { "./assets/a.png": "a.png" }
```

relay 会：

```text
1. 上传 cover 到 /cgi-bin/material/add_material?type=image
2. 上传正文图片到 /cgi-bin/media/uploadimg
3. 把 HTML 中的原始 src 替换为微信 CDN URL
4. 调 /cgi-bin/draft/add 创建草稿
```

兼容旧接口：

```text
POST /api/media/uploadthumb
POST /api/media/uploadimage
```

这两个接口接收远程 `image_url`，relay 会下载图片再上传微信。它们只允许 HTTPS 图片 URL，并会拒绝内网、localhost、link-local 地址。主流程仍建议用 multipart 文件上传。

## 安全边界

服务启动时强制要求 `API_KEY`，不能无鉴权运行。

`/api/token/status` 不返回明文 access_token，只返回缓存状态和过期时间。

`/api/proxy` 默认关闭。确实需要通用微信 API 转发时，显式设置：

```ini
ENABLE_GENERIC_PROXY=1
```

上传限制：

```text
默认单图最大 10MB
允许 image/jpeg、image/png、image/webp、image/gif
临时文件不落盘，使用内存上传微信
```

## 推荐 md2wechat 工作流

本地只用 md2wechat 做排版，不让它调用微信 API：

```bash
md2wechat convert article.md -o out.html
```

不要在 Mac mini 上跑：

```bash
md2wechat upload_image ...
md2wechat convert ... --upload
md2wechat convert ... --draft
```

这些命令会让本机直接访问微信 API，从而再次撞上 IP 白名单。最终草稿创建交给 relay 完成。

## License

MIT
