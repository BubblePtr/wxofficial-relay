# wxofficial-relay

This repository contains both the local publishing CLI and the fixed-IP relay server.

它的边界很窄：不写文章，不生成配图，不调用 LLM，不判断文章质量。它只做公众号发布前的工程处理，以及通过固定 IP relay 调微信官方接口。

## Minimal structure

```text
server.js
client.js
typesetter.js
bin/wxpub.js
src/package/schema.js
src/package/validate.js
src/assets/optimize.js
src/html/wechatCompat.js
src/clipboard/capture.js
docs/usage.md
docs/troubleshooting.md
examples/minimal/
```

## First commands

第一版公开 CLI 只保留 relay 诊断命令：

```bash
wxpub relay health
wxpub relay token
```

旧的 `client.js` 仍保留为 SDK/内部调用入口，避免把第一版 CLI 做胖。

## Install

```bash
npm ci
npm link
```

## Relay server

`.env` 至少需要：

```ini
WX_APP_ID=wx_your_app_id
WX_APP_SECRET=your_secret
PORT=3900
API_KEY=use_openssl_rand_hex_32_here
RATE_LIMIT_RPM=60
TOKEN_CACHE_FILE=/tmp/wxofficial-relay-token.json
```

启动：

```bash
node server.js
```

生产环境建议用 pm2 或 systemd，并用 Caddy/Nginx 做 HTTPS 终止。

## Local configuration

```bash
export WX_PROXY_URL=https://wx.example.com
export WX_PROXY_KEY=your_api_key
```

然后检查：

```bash
wxpub relay health
wxpub relay token
```

## Local typesetting

```bash
node typesetter.js render examples/minimal/article.md --theme warm -o examples/minimal/article.html
node typesetter.js preview examples/minimal/article.md --theme warm -o examples/minimal/preview.html
```

## contentHtml draft workflow

The relay expects article content to arrive as already-rendered `contentHtml`.
For browser-oriented WeChat HTML, choose an explicit compatibility mode:

- `wechat-editor-safe`: downgrades risky layout such as `flex`, `grid`, SVG,
  large fixed-width wrappers, and table tags before creating API drafts.
- `wechat-clipboard-html`: preserves real browser clipboard `text/html` after a
  verified copy action, while still uploading/replacing inline images and
  rejecting unresolved local artifacts.

The helper command below captures `#gzh-content` from a preview, sets
`compatMode="wechat-clipboard-html"`, uploads images, and creates a draft. It
does not publish:

```bash
node client.js draft:create-from-preview path/to/preview.html path/to/article.json \
  --engine playwright \
  --headless \
  --out-article path/to/article.clipboard.json
```

The Playwright engine uses an isolated Chromium context and browser-context
clipboard permissions. It does not read or overwrite the macOS system clipboard.
The relay URL and API key must come from environment variables; do not commit
credentials or generated draft payloads.

更多见：

```text
docs/usage.md
docs/troubleshooting.md
```
