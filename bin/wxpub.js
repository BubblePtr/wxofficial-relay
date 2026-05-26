#!/usr/bin/env node
/**
 * wxpub CLI.
 *
 * First landing version keeps the command surface intentionally tiny:
 *   wxpub relay health
 *   wxpub relay token
 */

const WxClient = require('../client');

function createClientFromEnv() {
  return WxClient.create({
    serverUrl: process.env.WX_PROXY_URL || 'https://localhost:3901',
    apiKey: process.env.WX_PROXY_KEY || '',
    allowInsecureTLS: process.env.WX_PROXY_INSECURE_TLS === '1',
    caCertPath: process.env.WX_PROXY_CA_CERT || '',
  });
}

function printJson(value) {
  console.log(JSON.stringify(value, null, 2));
}

function printHelp() {
  console.log(`wxpub

Usage:
  wxpub relay health
  wxpub relay token

Environment:
  WX_PROXY_URL             Relay base URL, e.g. https://wx.example.com
  WX_PROXY_KEY             Relay API key
  WX_PROXY_INSECURE_TLS=1  Allow self-signed relay certificates for local debugging
`);
}

async function main(argv = process.argv.slice(2)) {
  const [scope, command] = argv;

  if (!scope || scope === 'help' || scope === '--help' || scope === '-h') {
    printHelp();
    return;
  }

  if (scope !== 'relay') {
    throw new Error(`Unknown scope: ${scope}`);
  }

  const wx = createClientFromEnv();

  if (command === 'health') {
    printJson(await wx.health());
    return;
  }

  if (command === 'token') {
    printJson(await wx.getTokenStatus());
    return;
  }

  throw new Error(`Unknown relay command: ${command || '(missing)'}`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`[ERROR] ${err.message}`);
    if (err.details) console.error(JSON.stringify(err.details, null, 2));
    process.exit(1);
  });
}

module.exports = { main, createClientFromEnv };
