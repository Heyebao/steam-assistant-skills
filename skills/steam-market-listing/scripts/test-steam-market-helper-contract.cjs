'use strict';
// Offline contract regressions: execute the real helper and DOM callbacks against
// fictional Steam objects. No browser, credentials, network or market operations.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRunner, makeNativeIO, parseHelperSnapshot } = require('./steam-market-reprice-runner.cjs');
const source = fs.readFileSync(path.join(__dirname, 'steam-card-bulk-lister.user.js'), 'utf8');
const account = 'Offline contract', profile = 'https://steamcommunity.com/id/offline-contract/inventory';
const hash = '12345-Example', url = 'https://steamcommunity.com/market/listings/753/' + hash;
const clone = value => JSON.parse(JSON.stringify(value));
const legacyKey = 'codex.steamCardListing.ledger.v1';
function card(assetid = '3001') {
    return { assetid, appid: '753', contextid: '6', description: { market_hash_name: hash,
        name: 'Example', marketable: 1, tradable: 1, market_fee: 0.1,
        tags: [{ category: 'item_class', internal_name: 'item_class_2' }] } };
}
function helperFixture(options = {}) {
    const storage = options.storage || new Map();
    const identity = { account: options.account || account, profile: options.profile || profile };
    const active = { m_appid: '753', m_contextid: '6', m_rgAssets: {}, LoadCompleteInventory: async () => {} };
    const sandbox = { __STEAM_CARD_LISTING_TEST__: true, URL, AbortController,
        setTimeout: (callback, ms) => setTimeout(callback, options.fastTimers ? Math.min(ms, 10) : ms), clearTimeout,
        location: { href: identity.profile, origin: 'https://steamcommunity.com' },
        document: { querySelector: selector => selector === '#account_pulldown' ? { innerText: identity.account } : null,
            querySelectorAll: () => [] },
        localStorage: { getItem: key => storage.has(key) ? storage.get(key) : null, setItem: (key, value) => storage.set(key, value) },
        g_ActiveInventory: active, g_rgWalletInfo: { wallet_currency: 23 },
        CalculateAmountToSendForDesiredReceivedAmount: receive => ({ amount: receive + 2 }),
        fetch: options.fetch || (async () => ({ ok: true, status: 200, text: async () => '<div id="my_market_selllistings"></div>' })),
    };
    vm.runInNewContext(source, sandbox);
    const helper = sandbox.__SteamCardListingCore;
    return { helper, sandbox, storage, active,
        summary: () => clone(helper.auditSummary(helper.loadLedger())) };
}
function inventoryTab(fixture) {
    const trace = [];
    const tab = { url: async () => fixture.sandbox.location.href, reload: async () => { trace.push('reload'); }, playwright: {
        getByRole: () => ({ click: async () => { trace.push('scan'); await fixture.helper.scanInventory(); } }),
        locator: () => ({ waitFor: async () => {} }),
        evaluate: async callback => {
            trace.push('DOM callback');
            const previous = global.document;
            global.document = { URL: fixture.sandbox.location.href, querySelector(selector) {
                if (selector === '#account_pulldown') return { innerText: fixture.sandbox.document.querySelector(selector).innerText };
                if (selector === '#codex-steam-card-listing-panel') return { getAttribute: () => '2', shadowRoot: {
                    querySelector: inner => inner === '#scbl-agent-summary' ? { textContent: JSON.stringify(fixture.summary()) } : null,
                } };
                return null;
            } };
            try { return callback(); } finally { global.document = previous; }
        },
    } };
    return { tab, trace };
}
function plan() {
    return { account, inventoryProfileUrl: profile, approvedBuyerTotalCents: 78, approvedReceiveTotalCents: 64,
        rows: [{ listingid: '1001', assetid: '2001', appid: '753', submission_contextid: '6', name: 'Example',
            game: 'Example Trading Card', url, proposedBuyerCents: 78, nativeReceiveCents: 64, nativeFeeCents: 14,
            state: 'APPROVED_ACTIVE' }], batches: [] };
}
async function contractChecks() {
    const f = helperFixture(); f.active.m_rgAssets['3001'] = card();
    const inventory = inventoryTab(f), io = makeNativeIO({ inventory: inventory.tab, inventoryProfileUrl: profile });
    const rows = await io.readInventory();
    assert.equal(rows.length, 1); assert.equal(rows[0].eligible, true); assert.equal(rows[0].locked, false);
    assert.ok(inventory.trace.includes('DOM callback'), 'real DOM extraction executes without a translated log or table');
    const data = f.summary(), wrapper = { schema: '2', account, url: profile, data };
    assert.equal(data.scan.complete, true); assert.equal(data.appid, '753'); assert.equal(data.contextid, '6');
    for (const state of ['OUTCOME_UNKNOWN', 'SUBMITTING', 'RECONCILE_PENDING', 'QUARANTINED', 'ACTIVE', 'EXTERNAL_PENDING']) {
        const ledger = f.helper.loadLedger(); ledger.assets['3001'].state = state; f.helper.saveLedger(ledger);
        // The explicit pending state is produced by the market parser, not a label.
        if (state === 'EXTERNAL_PENDING') {
            f.sandbox.fetch = async () => ({ ok: true, status: 200, text: async () => "my_market_selllistings CancelMarketListingConfirmation('mylisting','9001',753,'6','3001')" });
        }
        const locked = await io.readInventory();
        assert.equal(locked[0].locked, true, state); assert.equal(locked[0].eligible, false, state);
    }
    for (const [edit, code] of [
        [s => { s.data.schema = 1; }, 'READ_ONLY_HELPER_UPDATE_REQUIRED'],
        [s => { s.data.helperVersion = '0.3.1'; }, 'READ_ONLY_HELPER_UPDATE_REQUIRED'],
        [s => { s.data.scan.complete = false; }, 'INVENTORY_INCOMPLETE'],
        [s => { s.data.contextid = '16'; }, 'INVENTORY_CONTEXT_MISMATCH'],
        [s => { s.data.assets[0].state = 'FUTURE_UNKNOWN_STATE'; }, 'HELPER_LOCK_UNPROVEN'],
        [s => { s.data.assets[0].assetid = 3001; }, 'INVENTORY_INCOMPLETE'],
        [s => { s.data.assets[0].state = 'OUTCOME_UNKNOWN'; s.data.assets[0].locked = false; }, 'HELPER_LOCK_UNPROVEN'],
        [s => { delete s.data.assets[0].locked; }, 'HELPER_LOCK_UNPROVEN'],
        [s => { s.data.inventoryProfileUrl = profile + '-another'; }, 'INVENTORY_PROFILE_MISMATCH'],
    ]) {
        const changed = clone(wrapper); edit(changed);
        assert.throws(() => parseHelperSnapshot(changed, profile), { code });
    }
    assert.throws(() => parseHelperSnapshot(wrapper, profile, data.scan.generation), { code: 'INVENTORY_INCOMPLETE' });
    delete f.active.LoadCompleteInventory;
    await f.helper.scanInventory();
    assert.equal(f.summary().scan.complete, false); assert.equal(f.summary().busy, false);
    const other = helperFixture(); other.active.m_appid = '730'; await other.helper.scanInventory();
    assert.equal(other.summary().scan.complete, false);
    const unobservable = helperFixture(); unobservable.active.LoadCompleteInventory = () => undefined;
    await unobservable.helper.scanInventory();
    assert.equal(unobservable.summary().scan.status, 'FAILED'); assert.equal(unobservable.summary().busy, false);
    for (const change of [
        f => { f.active.m_appid = '730'; },
        f => { f.active.m_contextid = '16'; },
        f => { f.sandbox.g_ActiveInventory = { ...f.active }; },
        f => { f.sandbox.document.querySelector = () => ({ innerText: 'Switched account' }); },
        f => { f.sandbox.location.href = profile.replace('/inventory', '-switched/inventory'); },
    ]) {
        let switched;
        switched = helperFixture({ fetch: async () => { change(switched);
            return { ok: true, status: 200, text: async () => 'my_market_selllistings' };
        } });
        await switched.helper.scanInventory();
        assert.equal(switched.storage.size, 0, 'scope switch during pending GET cannot merge old assets into any ledger');
        assert.equal(switched.summary().scan.complete, false); assert.equal(switched.summary().busy, false);
    }
    const afterScan = helperFixture(); await afterScan.helper.scanInventory();
    afterScan.active.m_contextid = '16';
    assert.equal(afterScan.summary().scan.complete, false, 'published complete metadata is invalidated after an inventory switch');
}
async function runnerIntegration(locked) {
    const f = helperFixture(), inv = inventoryTab(f), ledger = plan(), actions = [];
    let cancelled = false, submitted = false;
    const inventoryIO = makeNativeIO({ inventory: inv.tab, inventoryProfileUrl: profile });
    const io = {
        preflightNative: async groups => { actions.push('preflight'); return { account, hashes: groups.map(g => g.hash) }; },
        readInventory: () => inventoryIO.readInventory(),
        readMarket: async () => ({ account, rows: cancelled ? submitted ? [{ listingid: '4001', assetid: '3001', appid: '753',
            observed_contextid: '6', state: 'PENDING_MOBILE_CONFIRMATION', url, buyerCents: 78, receiveCents: 64 }] : [] : [{
            listingid: '1001', assetid: '2001', appid: '753', observed_contextid: '16', state: 'ACTIVE', url }] }),
        cancel: async identity => {
            assert.deepEqual([identity.observed_contextid, identity.submission_contextid], ['16', '6']);
            assert.equal(actions[0], 'preflight'); actions.push('cancel'); cancelled = true;
            f.active.m_rgAssets['3001'] = card();
            if (locked) {
                const local = f.helper.loadLedger();
                local.assets['3001'] = { assetid: '3001', appid: '753', contextid: '6', market_hash_name: hash,
                    state: 'OUTCOME_UNKNOWN', selected: false, marketable: true, tradable: true, presentInInventory: false };
                f.helper.saveLedger(local);
            }
        },
        prepare: async (_group, batch) => ({ buyerCents: 78, receiveCents: 64, quantity: batch.quantity, receiveTotalCents: 64 }),
        submit: async () => { actions.push('submit'); submitted = true; return 'Accepted'; },
    };
    const runner = createRunner({ ledger, io, approvedPlan: true, persist: async () => {} });
    let result;
    for (let i = 0; i < 12 && !submitted; i++) { result = await runner.runStep(); if (result.halted) break; }
    if (locked) { assert.equal(result.error.code, 'RETURNED_COHORT_MISMATCH'); assert.equal(submitted, false); }
    else { assert.equal(submitted, true); assert.deepEqual(actions, ['preflight', 'cancel', 'submit']); }
}
async function preflightAndCancel() {
    let location = '', clicked = 0, hasControl = true;
    const row = { innerText: '共 0 个', querySelector: () => ({ value: '0' }),
        querySelectorAll: () => [{ value: '' }, { value: '' }] };
    const cardLink = { href: url, innerText: 'Example', closest: () => row };
    const sell = { goto: async value => { location = value; }, playwright: { evaluate: async callback => {
        const previous = global.document;
        global.document = { URL: location, querySelector: selector => selector === '#account_pulldown' ? { innerText: account } :
            selector === '#market_multi_accept_ssa' ? { checked: false } : null,
            querySelectorAll: selector => selector.startsWith('a[href') ? [cardLink] : [cardLink, ...(hasControl ? [{ innerText: '创建上架物品' }] : [])] };
        try { return callback(); } finally { global.document = previous; }
    } } };
    const native = makeNativeIO({ sell });
    const proof = await native.preflightNative([{ hash, url }], account);
    assert.equal(proof.account, account); assert.equal(new URL(location).searchParams.get('qty[]'), '0');
    hasControl = false;
    const ledger = plan();
    const runner = createRunner({ ledger, approvedPlan: true, persist: async () => {}, io: {
        preflightNative: (...args) => native.preflightNative(...args), cancel: async () => { clicked++; },
    } });
    assert.equal((await runner.runStep()).error.code, 'NATIVE_PREFLIGHT_REQUIRED'); assert.equal(clicked, 0);
    const market = { playwright: { locator: () => ({ getByRole: () => ({
        getAttribute: async () => "javascript:RemoveMarketListing('mylisting', '1001', 753, '16', '2001')",
        click: async () => { clicked++; },
    }), waitFor: async () => {} }), getByText: () => ({ click: async () => {} }) } };
    const cancelIO = makeNativeIO({ market });
    await cancelIO.cancel({ ...ledger.rows[0], observed_contextid: '16' }); assert.equal(clicked, 1);
    await assert.rejects(() => cancelIO.cancel({ ...ledger.rows[0], observed_contextid: '6' }), { code: 'CANCEL_IDENTITY_MISMATCH' });
    assert.equal(clicked, 1);
}
async function storageAndTimeouts() {
    for (const lastError of ['', '请求失败', '用户仍在等待手机确认', 'network timeout']) {
        const historic = helperFixture({ storage: new Map([[legacyKey, JSON.stringify({ version: 1, assets: { '3001': {
            assetid: '3001', appid: '753', contextid: '6', market_hash_name: hash,
            state: 'PAUSED_CONFIRMATIONS', marketable: true, tradable: true, lastError,
        } } })]]) });
        historic.active.m_rgAssets['3001'] = card(); await historic.helper.scanInventory();
        const row = historic.summary().assets[0];
        assert.equal(row.locked, true, 'legacy pause stays locked: ' + lastError);
        assert.equal(row.state, lastError.includes('timeout') ? 'OUTCOME_UNKNOWN' : 'RECONCILE_PENDING');
        assert.equal(historic.helper.loadLedger().assets['3001'].selected, false);
    }
    let pendingVisible = true;
    const external = helperFixture({ fetch: async () => ({ ok: true, status: 200,
        text: async () => 'my_market_selllistings ' + (pendingVisible ? "CancelMarketListingConfirmation('mylisting','9001',753,'6','3001')" : ''),
    }) });
    external.active.m_rgAssets['3001'] = card(); await external.helper.scanInventory();
    assert.equal(external.summary().assets[0].state, 'EXTERNAL_PENDING');
    pendingVisible = false; await external.helper.scanInventory();
    assert.equal(external.summary().assets[0].state, 'RECONCILE_PENDING');
    assert.equal(external.summary().assets[0].locked, true, 'vanished external pending cannot unlock a still-visible inventory copy');
    const storage = new Map([[legacyKey, JSON.stringify({ version: 1, assets: { '3001': {
        assetid: '3001', appid: '753', contextid: '6', market_hash_name: hash, state: 'OUTCOME_UNKNOWN',
        marketable: true, tradable: true, selected: false,
    } } })]]);
    const original = storage.get(legacyKey), alice = helperFixture({ storage });
    const old = alice.helper.loadLedger(); assert.equal(old.assets['3001'].state, 'OUTCOME_UNKNOWN');
    old.assets['7777'] = { assetid: '7777', appid: '753', contextid: '6', market_hash_name: hash, state: 'DISCOVERED' };
    alice.helper.saveLedger(old);
    const bob = helperFixture({ storage, account: 'Another account', profile: profile.replace('/inventory', '-bob/inventory') });
    const isolated = bob.helper.loadLedger(); assert.equal(isolated.assets['7777'], undefined);
    assert.equal(isolated.assets['3001'].state, 'OUTCOME_UNKNOWN', 'unbound legacy locks remain conservative in each scope');
    assert.equal(storage.get(legacyKey), original, 'legacy source is never rewritten');
    alice.active.m_rgAssets['3001'] = card();
    const pending = new Map([['3001', { confirmationid: '9001' }]]);
    alice.helper.mergeScanIntoLedger([clone(card())].map(raw => alice.helper.normalizeAsset(raw)), pending);
    const cleared = alice.helper.mergeScanIntoLedger([alice.helper.normalizeAsset(card())]);
    assert.equal(cleared.assets['3001'].state, 'OUTCOME_UNKNOWN', 'temporary pending state cannot erase an earlier unsafe lock');
    storage.set(alice.helper.ledgerKey(), '{broken');
    assert.throws(() => alice.helper.loadLedger(), /台账损坏/);
    await alice.helper.scanInventory();
    const bad = helperFixture({ storage: new Map([[legacyKey, '{broken']]) });
    assert.throws(() => bad.helper.loadLedger(), /台账损坏/);
    const missingState = helperFixture({ storage: new Map([[legacyKey, JSON.stringify({ version: 1, assets: {
        '3001': { assetid: '3001', appid: '753', contextid: '6' },
    } })]]) });
    assert.throws(() => missingState.helper.loadLedger(), /台账结构不兼容/);
    let aborts = 0;
    const timeout = helperFixture({ fastTimers: true, fetch: async (_url, options) => ({ ok: true, status: 200,
        text: () => new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => {
            aborts++; reject(Object.assign(new Error('aborted body'), { name: 'AbortError' }));
        }, { once: true })),
    }) });
    await timeout.helper.scanInventory();
    assert.equal(aborts, 1, 'body remains under the request abort timer after headers');
    assert.equal(timeout.summary().busy, false); assert.equal(timeout.summary().scan.status, 'FAILED');
    assert.equal(timeout.summary().scan.complete, false);
}
async function quotes() {
    let requests = 0, release;
    const gate = new Promise(done => { release = done; });
    const f = helperFixture({ fetch: async requestUrl => { requests++;
        await gate; return { ok: true, status: 200, json: async () => ({ success: true,
            lowest_price: new URL(requestUrl).searchParams.get('currency') === '23' ? '¥ 0.78' : '$ 1.00' }) };
    } });
    const item = f.helper.normalizeAsset(card()), cache = {};
    const first = f.helper.fetchLowestBuyerCents(item, cache), second = f.helper.fetchLowestBuyerCents(item, cache);
    release(); assert.equal((await first).buyerCents, 78); assert.equal((await second).buyerCents, 78); assert.equal(requests, 1);
    assert.equal((await f.helper.fetchLowestBuyerCents(item, cache)).cached, true); assert.equal(requests, 1);
    f.sandbox.g_rgWalletInfo.wallet_currency = 1;
    assert.equal((await f.helper.fetchLowestBuyerCents(item, cache)).buyerCents, 100); assert.equal(requests, 2);
    let quoteCalls = 0;
    const limited = helperFixture({ fastTimers: true, fetch: async requestUrl => {
        if (String(requestUrl).includes('priceoverview')) {
            quoteCalls++; return { ok: false, status: 429, text: async () => '<html>Too many requests</html>' };
        }
        return { ok: true, status: 200, text: async () => 'my_market_selllistings' };
    } });
    limited.active.m_rgAssets['3001'] = card();
    const secondCard = card('3002'); secondCard.description.market_hash_name = '12345-Second';
    limited.active.m_rgAssets['3002'] = secondCard;
    await limited.helper.buildDryRun();
    assert.equal(quoteCalls, 1, 'HTTP 429 HTML keeps its status classification and stops later quote groups');
    assert.equal(limited.summary().busy, false);
}
(async () => {
    await contractChecks(); await runnerIntegration(true); await runnerIntegration(false);
    await preflightAndCancel(); await storageAndTimeouts(); await quotes();
    console.log('PASS: real helper/DOM contract, historical/unknown locks, full-scan identity/generation, context16 cancellation + context6 submission, native preflight before cancellation, corrupt/legacy/account-scoped ledgers, full-body timeout cleanup, and currency-aware quote dedup/cache. Offline only.');
})().catch(error => { console.error(error); process.exitCode = 1; });
