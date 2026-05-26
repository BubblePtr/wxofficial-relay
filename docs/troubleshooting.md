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

WeChat strips many tags and styles. Keep output boring:

- inline styles only
- no class names
- no external CSS
- no scripts
- simple headings, paragraphs, quotes, lists, code blocks, and images
