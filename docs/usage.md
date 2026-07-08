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

## WeChat compatibility modes

For gzh-design or other browser-oriented themes, choose an explicit compatibility
mode before creating the draft. The default behavior is unchanged when no mode is
set.

Use `wechat-editor-safe` when the input is ordinary rendered HTML and you want
the relay to reduce structures that commonly break in API-created drafts:

```json
{
  "title": "Article title",
  "contentHtml": "<section>...</section>",
  "coverPath": "./assets/cover.jpg",
  "compatMode": "wechat-editor-safe"
}
```

The relay keeps visual tokens such as colors, borders, spacing, and cards where
possible, but rewrites structures that commonly break in the WeChat editor:

- `flex` / `grid` declarations
- SVG decorations
- large fixed-width wrappers
- real table tags
- CSS columns / writing-mode

Use this for API-created drafts. Manual copy-paste into the Official Account
editor may preserve some browser-oriented layouts differently, so do not treat
local browser preview as proof that API-created drafts will render correctly.

Use `wechat-clipboard-html` when the input is the real browser clipboard
`text/html` captured after clicking a page's "copy to WeChat" button:

```json
{
  "title": "Article title",
  "contentHtml": "<meta charset=\"utf-8\"><section>...</section>",
  "coverPath": "./assets/cover.jpg",
  "compatMode": "wechat-clipboard-html"
}
```

This mode is fidelity-first. It does not downgrade `flex`, SVG, or browser-
expanded inline styles; it still uploads and rewrites inline images. The input
must already be API-ready clipboard HTML, not the original preview page source
or raw `#gzh-content.innerHTML`. The relay rejects obvious unresolved local
artifacts such as `file://`, `data:image`, template placeholders, and local
absolute image paths.

## Capture clipboard HTML from a preview

On macOS, the client CLI can automate the upstream capture step from a local
preview file or URL. It opens the preview in a browser, selects `#gzh-content`,
copies it through the system clipboard, and reads the clipboard `text/html`:

```bash
node client.js clipboard:capture out/article-preview.html \
  --out out/clipboard.html \
  --article out/article.json \
  --out-article out/article.clipboard.json
```

Then create the draft from the rewritten package:

```bash
node client.js draft:create-auto out/article.clipboard.json
```

For one command that captures clipboard HTML and creates the draft:

```bash
node client.js draft:create-from-preview out/article-preview.html out/article.json \
  --out-article out/article.clipboard.json
```

By default this command uses a visible macOS browser and the macOS clipboard. If
the browser blocks AppleScript or accessibility automation, use the manual
`clipboard-inspector.html` capture path instead, or grant the terminal/browser
the required macOS automation permissions. The default macOS engine overwrites
the current system clipboard while capturing.

To avoid controlling the user's visible Chrome/Safari window, use the optional
Playwright engine:

```bash
node client.js clipboard:capture out/article-preview.html \
  --engine playwright \
  --headless \
  --out out/clipboard.html
```

The Playwright engine starts an isolated Chromium instance, selects the target
element, triggers copy, and reads browser-context clipboard `text/html`. It does
not read or overwrite the macOS system clipboard, and it does not silently fall
back to raw `innerHTML`; if real clipboard HTML cannot be read, the command
fails. Because the project depends on `playwright-core`, the machine running the
command must have Google Chrome available for the `chrome` channel.
