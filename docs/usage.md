# Usage

This repository contains both the local publishing CLI and the fixed-IP relay server.

The boundary is deliberately narrow:

- Human or Agent writes the article, chooses title/digest, and prepares images.
- `typesetter.js` renders finished Markdown into WeChat-compatible inline HTML.
- `wxpub` talks to the relay.
- `server.js` runs on a fixed-IP server and calls the WeChat Official Account API.

## Install

```bash
npm ci
```

## Relay server

Create `.env` on the cloud server:

```ini
WX_APP_ID=wx_your_app_id
WX_APP_SECRET=your_secret
PORT=3900
API_KEY=use_openssl_rand_hex_32_here
RATE_LIMIT_RPM=60
TOKEN_CACHE_FILE=/tmp/wxofficial-relay-token.json
```

Run:

```bash
node server.js
```

Production can use pm2:

```bash
pm2 start server.js --name wxofficial-relay
pm2 save
```

## Local CLI

Configure local environment:

```bash
export WX_PROXY_URL=https://wx.example.com
export WX_PROXY_KEY=your_api_key
```

Check relay:

```bash
wxpub relay health
wxpub relay token
```

## Local typesetting

```bash
node typesetter.js render examples/minimal/article.md --theme warm -o examples/minimal/article.html
node typesetter.js preview examples/minimal/article.md --theme warm -o examples/minimal/preview.html
```

The rendered HTML keeps image `src` values unchanged. Upload/rewrite is handled by the relay flow later.

## Minimal article package

```text
examples/minimal/
  article.md
  article.json
  assets/
```

`article.json` should contain the already-rendered `contentHtml`, cover path, and optional inline image mapping.
