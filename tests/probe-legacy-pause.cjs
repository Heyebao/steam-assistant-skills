'use strict';
const fs = require('node:fs'), vm = require('node:vm'), path = require('node:path'), assert = require('node:assert/strict');
const source = fs.readFileSync(path.resolve(__dirname, '../skills/steam-market-listing/scripts/steam-card-bulk-lister.user.js'), 'utf8');
async function probe(lastError) {
  const rawCard = { assetid: '3001', appid: '753', contextid: '6', description: {
    market_hash_name: '12345-Example', name: 'Example', marketable: 1, tradable: 1,
    tags: [{ category: 'item_class', internal_name: 'item_class_2' }],
  } };
  const old = { version: 1, assets: { '3001': { assetid: '3001', appid: '753', contextid: '6',
    market_hash_name: '12345-Example', state: 'PAUSED_CONFIRMATIONS', marketable: true, tradable: true, lastError } } };
  const storage = new Map([['codex.steamCardListing.ledger.v1', JSON.stringify(old)]]);
  const sandbox = { __STEAM_CARD_LISTING_TEST__: true, URL, AbortController, setTimeout, clearTimeout,
    location: { href: 'https://steamcommunity.com/id/independent-fictional/inventory', origin: 'https://steamcommunity.com' },
    document: { querySelector: s => s === '#account_pulldown' ? { innerText: 'Independent Fictional Account' } : null, querySelectorAll: () => [] },
    localStorage: { getItem: k => storage.get(k) ?? null, setItem: (k,v) => storage.set(k,v) },
    g_ActiveInventory: { m_appid: '753', m_contextid: '6', m_rgAssets: { '3001': rawCard }, LoadCompleteInventory: async () => {} },
    g_rgWalletInfo: { wallet_currency: 23 },
    fetch: async () => ({ ok: true, status: 200, text: async () => '<div id="my_market_selllistings"></div>' }),
  };
  vm.runInNewContext(source, sandbox); const helper = sandbox.__SteamCardListingCore;
  await helper.scanInventory();
  const row = helper.auditSummary(helper.loadLedger()).assets.find(r => r.assetid === '3001');
  console.log(JSON.stringify({ original: { state: 'PAUSED_CONFIRMATIONS', lastError }, observed: row }));
  return row;
}
function probeExternalPending() {
  const sandbox = { __STEAM_CARD_LISTING_TEST__: true, URL, AbortController, setTimeout, clearTimeout,
    location: { href: 'https://steamcommunity.com/id/independent-fictional/inventory', origin: 'https://steamcommunity.com' },
    document: { querySelector: s => s === '#account_pulldown' ? { innerText: 'Independent Fictional Account' } : null, querySelectorAll: () => [] },
    localStorage: { getItem: () => null, setItem: () => {} }, g_rgWalletInfo: { wallet_currency: 23 },
  };
  const storage = new Map(); sandbox.localStorage = { getItem: k => storage.get(k) ?? null, setItem: (k,v) => storage.set(k,v) };
  vm.runInNewContext(source, sandbox); const helper = sandbox.__SteamCardListingCore;
  const item = helper.normalizeAsset({ assetid: '3001', appid: '753', contextid: '6', description: {
    market_hash_name: '12345-Example', name: 'Example', marketable: 1, tradable: 1,
    tags: [{ category: 'item_class', internal_name: 'item_class_2' }],
  } });
  const first = helper.mergeScanIntoLedger([item], new Map([['3001', { confirmationid: '4001' }]]));
  const before = helper.auditSummary(first).assets[0];
  const after = helper.auditSummary(helper.mergeScanIntoLedger([item], new Map())).assets[0];
  console.log(JSON.stringify({ pendingDisappearedWithSameInventory: true, before, after }));
  assert.equal(before.locked, true); assert.equal(after.locked, true); assert.equal(after.state, 'RECONCILE_PENDING');
}
(async () => {
  for (const error of ['', '请求失败', 'Paused while waiting for user', 'network timeout']) {
    const row = await probe(error); assert.equal(row.locked, true);
    assert.equal(row.state, error === 'network timeout' ? 'OUTCOME_UNKNOWN' : 'RECONCILE_PENDING');
  }
  probeExternalPending();
  console.log('PASS independent historical-lock and vanished-external-pending regressions.');
})().catch(error => { console.error(error); process.exitCode = 1; });
