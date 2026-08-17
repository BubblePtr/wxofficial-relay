# Troubleshooting

## `wxpub relay health` cannot connect

Check:

- `WX_PROXY_URL` points to the public relay URL.
- DNS resolves to the fixed-IP server.
- Caddy/Nginx forwards to the Node process port.
- The Node process is running.

For local self-signed certificate testing only:

```bash
export WX_PROXY_INSECURE_TLS=1
```

Do not use that in production.

## `wxpub relay token` returns WeChat credential errors

Check:

- `WX_APP_ID` and `WX_APP_SECRET` are from the same Official Account.
- The cloud server public IP is in the WeChat Official Account IP whitelist.
- The account has the required API capability enabled.

## API key rejected

The local client sends `X-Api-Key`. Make sure:

```bash
export WX_PROXY_KEY=the_same_value_as_server_API_KEY
```

## Body images do not show in WeChat draft

The typesetter intentionally preserves local image paths. Before creating a draft, inline images must be uploaded through the relay and rewritten to WeChat CDN URLs.

For the minimal version, verify only the relay and token commands first. Draft creation can stay outside the public CLI until the package format is stable.

## HTML looks different inside WeChat

WeChat strips or misrenders many browser-oriented tags and styles. A local
390px browser preview is only a precheck; it is not proof that the API-created
draft will render correctly inside the WeChat editor.

For API-created drafts from gzh-design-like themes, set:

```json
{
  "compatMode": "wechat-editor-safe"
}
```

The relay will rewrite the highest-risk structures while preserving visual
tokens where practical. Watch for:

- inline styles only
- no class names
- no external CSS
- no scripts
- no raw `flex` / `grid` / SVG decorations / fixed desktop-width wrappers
- convert table-like content to mobile cards or block sections

If the mobile editor shows vertical letter-by-letter text, narrow columns, or a
desktop-like two-column hero, regenerate or update the draft with compatibility
mode before publishing.

If manual copy-paste from the preview page looks correct but `wechat-editor-safe`
looks too plain, capture the real browser clipboard `text/html` and create the
draft with:

```json
{
  "compatMode": "wechat-clipboard-html"
}
```

This is a fidelity-first path for verified clipboard HTML. It intentionally keeps
clipboard structures such as `flex` and SVG when WeChat accepts them, while still
uploading and rewriting inline images. Do not feed it the raw preview source; use
the actual clipboard HTML captured from the browser copy action, then verify the
result in the Official Account backend and mobile preview before publishing.

## Clipboard capture command fails

`clipboard:capture` and `draft:create-from-preview` are local capture helpers;
the relay server does not generate clipboard HTML itself. The default macOS
engine uses a visible browser plus the system clipboard. The Playwright engine
uses an isolated Chromium browser context and does not read or overwrite the
macOS system clipboard.

If capture fails:

- Confirm the preview contains `#gzh-content`, or pass `--selector`.
- Try `--engine playwright --headless` to use isolated Chromium instead of the
  visible macOS browser automation path.
- Try `--browser safari` or `--browser chrome`.
- Allow the terminal app to control the browser and System Events in macOS
  Privacy & Security settings.
- For Chrome/Safari JavaScript automation, enable JavaScript from Apple Events
  if the browser blocks the selection script.
- If Playwright reports that it cannot read `text/html`, treat that as a real
  failure. Do not use raw `innerHTML` as a replacement.
- Chromium strips `<img>` whose `src` is `file://` or an unresolved relative
  path. The Playwright engine serves the preview over `http://127.0.0.1` and
  rewrites image srcs to absolute loopback URLs before copy. If every `<img>`
  still disappears, fail the capture instead of creating an empty-image draft.
- Clipboard HTML may contain `data:image` after a preview “复制到公众号”
  action. `createDraftAuto` extracts those payloads, uploads them as inline
  images, and replaces them with `mmbiz.qpic.cn` URLs so the WeChat content
  field does not overflow. Leftover `data:image` or `wxrelay-inline://`
  tokens after upload still fail validation.
- Fall back to `clipboard-inspector.html`: copy from the preview manually, paste
  into the inspector, then use the exported `clipboard.html`.
