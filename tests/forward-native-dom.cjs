'use strict';
// Independent forward scenarios. No network/browser/process/config access.
const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const path = require('node:path');
const root = path.resolve(__dirname, '../skills/steam-market-listing/scripts');
const { createRunner, makeNativeIO } = require(path.join(root, 'steam-market-reprice-runner.cjs'));
const source = fs.readFileSync(path.join(root, 'steam-card-bulk-lister.user.js'), 'utf8');
const account = 'Independent Fictional Account';
const profile = 'https://steamcommunity.com/id/independent-fictional/inventory';
const hash = '12345-Independent Card';
const itemUrl = 'https://steamcommunity.com/market/listings/753/' + encodeURIComponent(hash);
const clone = x => JSON.parse(JSON.stringify(x));
function withDocument(doc, fn) { const old = global.document; global.document = doc; try { return fn(); } finally { global.document = old; } }
function fixture(options = {}) {
  const trace = [], store = new Map();
  let marketState = 'OLD', nativeUrl = '', buyer = '0.78', receive = '0.64', incompleteMarket = false;
  let releaseClick, onClick, gateClick = false, clickAccepted;
  const active = { m_appid: '753', m_contextid: '6', m_rgAssets: {}, LoadCompleteInventory: async () => {} };
  const card = () => ({ assetid: '3001', appid: '753', contextid: '6', description: {
    market_hash_name: hash, name: 'Independent Card', marketable: 1, tradable: 1,
    tags: [{ category: 'item_class', internal_name: 'item_class_2' }], market_fee: 0.1,
  } });
  const href = () => `javascript:${marketState === 'PENDING' ? 'CancelMarketListingConfirmation' : 'RemoveMarketListing'}('mylisting', '${marketState === 'OLD' ? '1001' : '4001'}', 753, '16', '${marketState === 'OLD' ? '2001' : '3001'}')`;
  const sandbox = { __STEAM_CARD_LISTING_TEST__: true, URL, AbortController, setTimeout, clearTimeout,
    location: { href: profile, origin: 'https://steamcommunity.com' },
    document: { querySelector: s => s === '#account_pulldown' ? { innerText: account } : null, querySelectorAll: () => [] },
    localStorage: { getItem: k => store.get(k) ?? null, setItem: (k,v) => store.set(k,v) },
    g_ActiveInventory: active, g_rgWalletInfo: { wallet_currency: 23 },
    CalculateAmountToSendForDesiredReceivedAmount: v => ({ amount: v + 2 }),
    fetch: async () => ({ ok: true, status: 200, text: async () => '<div id="my_market_selllistings"></div>' + (marketState === 'PENDING' ? href() : '') }),
  };
  vm.runInNewContext(source, sandbox);
  const helper = sandbox.__SteamCardListingCore;
  const accountNode = { innerText: account };
  const listingNode = () => ({ id: marketState === 'OLD' ? 'mylisting_1001' : 'mylisting_4001',
    innerText: '¥ 0.78 (¥ 0.64)', querySelectorAll(s) {
      if (s === 'a') return [{ innerText: '撤下', getAttribute: () => href() }, { innerText: 'Independent Card', getAttribute: () => itemUrl }];
      if (s === '.market_listing_listed_date_combined') return marketState === 'HELD' ? [{ innerText: '暂挂到 2026-10-25' }] : [];
      throw new Error('Unexpected market selector: ' + s);
    } });
  const marketDoc = () => ({ querySelector(s) {
    if (s === '#account_pulldown') return accountNode;
    if (s === '#tabContentsMyActiveMarketListingsTable') return {};
    if (s === '#my_market_selllistings_pagingtotal') return incompleteMarket ? null : { innerText: marketState === 'OLD' ? '1' : '0' };
    if (s === '#my_market_selllistings_number') return incompleteMarket ? null : { innerText: marketState === 'OLD' ? '1' : '0' };
    if (s === '#my_market_listingsonhold_number') return { innerText: marketState === 'HELD' ? '1' : '0' };
    throw new Error('Unexpected market field: ' + s);
  }, querySelectorAll(s) { assert.equal(s, '#tabContentsMyListings .market_listing_row'); return marketState === 'RETURNED' ? [] : [listingNode()]; } });
  const market = { reload: async () => { trace.push('market.reload'); }, playwright: {
    evaluate: async callback => withDocument(marketDoc(), callback),
    locator(selector) { assert.equal(selector, '#mylisting_1001'); return {
      getByRole: () => ({ getAttribute: async () => href(), click: async () => { trace.push('cancel.open'); } }),
      waitFor: async () => { assert.equal(marketState, 'RETURNED'); },
    }; },
    getByText: () => ({ click: async () => { trace.push('cancel.confirm'); marketState = 'RETURNED'; active.m_rgAssets['3001'] = card(); } }),
  } };
  const inventory = { url: async () => profile, reload: async () => { trace.push('inventory.reload'); }, playwright: {
    getByRole: () => ({ click: async () => { trace.push('inventory.scan'); await helper.scanInventory(); } }),
    locator: () => ({ waitFor: async () => {} }),
    evaluate: async callback => withDocument({ URL: profile, querySelector(s) {
      if (s === '#account_pulldown') return accountNode;
      if (s === '#codex-steam-card-listing-panel') return { getAttribute: () => '2', shadowRoot: {
        querySelector: inner => { assert.equal(inner, '#scbl-agent-summary'); return { textContent: JSON.stringify(helper.auditSummary(helper.loadLedger())) }; },
      } };
      throw new Error('Unexpected inventory field: ' + s);
    } }, callback),
  } };
  const numberInput = { get value() { return new URL(nativeUrl).searchParams.get('qty[]'); } };
  const nativeRow = { get innerText() { return '共 ' + (marketState === 'RETURNED' ? '1' : '0') + ' 个'; },
    querySelector: s => { assert.equal(s, 'input[type="number"]'); return numberInput; },
    querySelectorAll: s => { assert.equal(s, 'input[type="text"]'); return [{ value: receive }, { value: buyer }]; },
  };
  const nativeCardLink = { href: itemUrl, innerText: 'Independent Card', closest: () => nativeRow };
  const sellDoc = () => ({ URL: nativeUrl, querySelector(s) {
    if (s === '#account_pulldown') return accountNode;
    if (s === '#market_multi_accept_ssa') return { checked: options.terms !== false };
    if (s === '#market_multisell_total') return { innerText: '¥ ' + (Number(numberInput.value) * Number(receive)).toFixed(2) };
    throw new Error('Unexpected sell field: ' + s);
  }, querySelectorAll(s) {
    if (s === 'a[href*="/market/listings/753/"]') return [nativeCardLink];
    if (s === 'a') return [nativeCardLink, { innerText: '创建上架物品' }];
    throw new Error('Unexpected sell selector: ' + s);
  } });
  const sell = { goto: async value => { nativeUrl = value; trace.push('sell.goto:' + numberInput.value); }, playwright: {
    evaluate: async callback => withDocument(sellDoc(), callback), locator: selector => ({ selector }),
    getByRole(role) {
      if (role === 'row') return { filter: ({ has }) => { assert.equal(has.selector, 'a[href="' + itemUrl + '"]'); return {
        getByRole: () => ({ nth: n => { assert.equal(n, 1); return {
          fill: async value => { buyer = value; trace.push('price.fill'); }, press: async () => { receive = '0.64'; trace.push('price.event'); },
        }; } }),
      }; } };
      if (role === 'dialog') return { innerText: async () => { throw new Error('mock result dialog vanished'); }, isVisible: async () => false };
      assert.equal(role, 'link');
      return { click: async () => { trace.push('submit.click'); marketState = 'PENDING'; if (gateClick) { onClick(); await clickAccepted; throw new Error('mock tool timeout after acceptance'); } } };
    },
  } };
  const ledger = { account, inventoryProfileUrl: profile, approvedBuyerTotalCents: 78, approvedReceiveTotalCents: 64,
    rows: [{ listingid: '1001', assetid: '2001', appid: '753', submission_contextid: '6', name: 'Independent Card', game: 'Example Trading Card', url: itemUrl,
      proposedBuyerCents: 78, nativeReceiveCents: 64, nativeFeeCents: 14, state: 'APPROVED_ACTIVE' }], batches: [] };
  let durable;
  const config = { ledger, tabs: { market, inventory, sell }, approvedPlan: true, jobKey: options.jobKey || {}, persist: async v => { durable = clone(v); } };
  return { trace, active, helper, ledger, config, native: makeNativeIO({ market, inventory, sell, inventoryProfileUrl: profile }),
    durable: () => clone(durable), incomplete: () => { incompleteMarket = true; },
    phoneHold: () => { marketState = 'HELD'; active.m_rgAssets = {}; },
    gate() { gateClick = true; clickAccepted = new Promise(resolve => { releaseClick = resolve; }); return new Promise(resolve => { onClick = resolve; }); },
    release: () => releaseClick(),
  };
}
async function runToPhase(runner, ledger, phase) {
  for (let i=0; i<15 && ledger.execution?.phase !== phase; i++) {
    const result = await runner.runStep(); assert.equal(result.halted, false, JSON.stringify(result));
  }
  assert.equal(ledger.execution.phase, phase);
}
async function main() {
  const f = fixture(), runner = createRunner(f.config);
  await runToPhase(runner, f.ledger, 'SUBMIT');
  assert.equal(f.trace.filter(s => s === 'cancel.confirm').length, 1);
  assert.ok(f.trace.indexOf('sell.goto:0') < f.trace.indexOf('cancel.open'));
  const clickStarted = f.gate(), pendingStep = runner.runStep(); await clickStarted;
  const inflight = f.durable(); assert.equal(inflight.execution.phase, 'RECONCILE'); assert.equal(inflight.batches[0].state, 'SUBMITTING_NATIVE');
  await assert.rejects(() => runner.runStep(), { code: 'CONCURRENT_RUN' });
  const replacement = createRunner({ ...f.config, ledger: inflight });
  await assert.rejects(() => replacement.runStep(), { code: 'CONCURRENT_RUN' });
  f.release(); await pendingStep;
  const accepted = await runner.runStep(); assert.equal(accepted.pending, 1); assert.equal(accepted.halted, false);
  assert.equal(f.trace.filter(s => s === 'submit.click').length, 1);
  f.phoneHold(); const held = await runner.reconcile();
  assert.equal(held.held, 1); assert.equal(held.active, 0); assert.equal(held.pending, 0);
  assert.equal(f.ledger.batches[0].submissions[0].holdUntil, '暂挂到 2026-10-25');
  assert.equal(f.trace.filter(s => s === 'submit.click').length, 1);
  const bad = fixture(); bad.incomplete(); const badRunner = createRunner(bad.config);
  await badRunner.runStep(); const missing = await badRunner.runStep();
  assert.equal(missing.error.code, 'MARKET_INCOMPLETE'); assert.equal(bad.trace.includes('cancel.open'), false);
  const loading = fixture(); loading.active.LoadCompleteInventory = async () => { throw new Error('mock load unavailable'); };
  const loadingRunner = createRunner(loading.config); await loadingRunner.runStep(); const unavailable = await loadingRunner.runStep();
  assert.equal(unavailable.error.code, 'INVENTORY_INCOMPLETE'); assert.equal(loading.trace.includes('cancel.open'), false);
  const terms = fixture({ terms: false }), termsRunner = createRunner(terms.config);
  await runToPhase(termsRunner, terms.ledger, 'SUBMIT'); const noTerms = await termsRunner.runStep();
  assert.equal(noTerms.error.code, 'TERMS_REQUIRE_USER'); assert.equal(terms.trace.includes('submit.click'), false);
  console.log('PASS independent: actual market, inventory/helper, and native-sell DOM callbacks complete approved exact card; timeout retains owner/locks and no replay; pending becomes confirmed hold; incomplete market/load stops before cancellation; terms stop submission.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
