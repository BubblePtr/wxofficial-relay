const assert = require('node:assert/strict');
const test = require('node:test');

const { createClientFromEnv } = require('../bin/wxpub');

test('createClientFromEnv defaults to the documented relay port', () => {
  const oldUrl = process.env.WX_PROXY_URL;
  const oldKey = process.env.WX_PROXY_KEY;

  delete process.env.WX_PROXY_URL;
  delete process.env.WX_PROXY_KEY;
  try {
    const client = createClientFromEnv();
    assert.equal(client.serverUrl, 'https://localhost:3900');
  } finally {
    if (oldUrl === undefined) delete process.env.WX_PROXY_URL;
    else process.env.WX_PROXY_URL = oldUrl;
    if (oldKey === undefined) delete process.env.WX_PROXY_KEY;
    else process.env.WX_PROXY_KEY = oldKey;
  }
});
