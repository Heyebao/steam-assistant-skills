'use strict';
// Offline checks only. Fictional assets; no browser, network, or real account.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const api = require('./steam-market-reprice-runner.cjs');
const clone = value => JSON.parse(JSON.stringify(value));
const account = 'Offline test';
function makePlan() {
    const make = (id, hash, buyer, receive) => ({ listingid: '10' + id, assetid: '20' + id,
        appid: '753', submission_contextid: '6', name: hash, game: 'Example Trading Card',
        url: 'https://steamcommunity.com/market/listings/753/' + encodeURIComponent(hash),
        proposedBuyerCents: buyer, nativeReceiveCents: receive, nativeFeeCents: buyer - receive, state: 'APPROVED_ACTIVE' });
    return { account, approvedBuyerTotalCents: 255, approvedReceiveTotalCents: 212,
        rows: [make('01', '12345-Example A', 78, 64), make('02', '12345-Example A', 78, 64), make('03', '12345-Example B', 99, 84)], batches: [] };
}
function simulation(options = {}) {
    const ledger = makePlan(), cancelled = new Set(), submitted = new Set(), saves = [], calls = { cancel: 0, submit: 0 };
    let confirmed = false;
    const idFor = r => '30' + r.assetid.slice(2);
    const hashFor = r => decodeURIComponent(new URL(r.url).pathname.split('/').at(-1));
    const io = {
        async readMarket() {
            const rows = ledger.rows.flatMap(r => {
                if (!cancelled.has(r.assetid)) return [{ listingid: r.listingid, appid: '753', observed_contextid: '6',
                    assetid: r.assetid, state: 'ACTIVE', url: r.url }];
                if (!submitted.has(idFor(r)) || options.missingAccepted && r.assetid === '2001') return [];
                return [{ listingid: '40' + r.assetid.slice(2), appid: '753', observed_contextid: confirmed ? '16' : '6',
                    assetid: idFor(r), url: r.url, buyerCents: r.proposedBuyerCents, receiveCents: r.nativeReceiveCents,
                    state: confirmed ? 'CONFIRMED_MARKET_HOLD' : 'PENDING_MOBILE_CONFIRMATION', holdUntil: confirmed ? '10 月 11 日' : null }];
            });
            return { account: options.wrongAccount ? 'Unexpected account' : account, rows };
        },
        async readInventory() {
            const rows = ledger.rows.flatMap(r => cancelled.has(r.assetid) && (!confirmed || options.staleInventory) ? [{
                assetid: idFor(r), hash: hashFor(r), eligible: !options.tradeLocked, pending: submitted.has(idFor(r)) && !confirmed,
            }] : []);
            if (options.extraCopy) rows.push({ assetid: '9001', hash: hashFor(ledger.rows[0]), eligible: true, pending: false });
            rows.account = options.wrongInventoryAccount ? 'Unexpected account' : account;
            return rows;
        },
        async cancel(r) {
            assert.equal(saves.at(-1), 'CANCEL_REQUESTED');
            calls.cancel++;
            if (options.cancelTimeout) throw new Error('cancel timeout');
            cancelled.add(r.assetid);
        },
        async prepare(group, batch) {
            if (options.termsUnchecked) throw Object.assign(new Error('Terms need user'), { code: 'TERMS_REQUIRE_USER' });
            return { buyerCents: batch.buyerCents + (options.priceMismatch ? 1 : 0), receiveCents: batch.receiveCents,
                quantity: batch.quantity, receiveTotalCents: batch.quantity * batch.receiveCents };
        },
        async submit(group, batch) {
            assert.equal(saves.at(-1), 'SUBMITTING_NATIVE');
            calls.submit++;
            batch.submissionAssetids.forEach(id => submitted.add(id));
            if (options.modalTimeout) throw new Error('result dialog timeout');
            return options.systemError ? 'HTTP 429 too many requests' : 'Accepted';
        },
    };
    const params = { ledger, io, approvedPlan: true, collectMobileConfirmations: true,
        persist: async value => { if (options.saveFails) throw new Error('disk unavailable'); saves.push(value.batches.at(-1)?.state); } };
    return { ledger, params, runner: api.createRunner(params), calls, confirm: () => { confirmed = true; } };
}
function marketFixture() {
    return { account, listPresent: true, activeTotal: 1, rows: [{ text: '¥ 0.78\n(¥ 0.64)', holdUntil: null,
        links: [{ href: 'https://steamcommunity.com/market/listings/753/12345-Example%20A' },
            { href: "javascript:RemoveMarketListing('mylisting', '4001', 753, '16', '3001')" }] }] };
}
async function main() {
    const plan = api.validatePlan(makePlan());
    assert.equal(plan.groups.length, 2);
    assert.equal(plan.buyerTotal, 255);
    const native = new URL(api.buildNativeUrl('12345-Example A', 2));
    assert.equal(native.searchParams.get('items[]'), '12345-Example A');
    assert.equal(native.searchParams.get('qty[]'), '2');
    assert.throws(() => api.buildNativeUrl('Example A', 1), /INVALID_NATIVE_GROUP/);
    const duplicate = makePlan(); duplicate.rows[1].assetid = duplicate.rows[0].assetid;
    assert.throws(() => api.validatePlan(duplicate), /DUPLICATE_OR_INVALID_ID/);
    const fee = makePlan(); fee.rows[0].nativeFeeCents++;
    assert.throws(() => api.validatePlan(fee), /INVALID_FEE_LOCK/);
    const wrongApp = makePlan(); wrongApp.rows[0].appid = '730';
    assert.throws(() => api.validatePlan(wrongApp), /CARD_SCOPE/);
    assert.throws(() => api.createRunner({ ledger: makePlan(), io: {}, persist() {} }), /EXPLICIT_PLAN_APPROVAL_REQUIRED/);
    assert.throws(() => api.createRunner({ ledger: makePlan(), io: {}, approvedPlan: true }), /DURABLE_STATE_REQUIRED/);
    const noProfile = api.makeNativeIO({ inventory: { url: async () => 'https://steamcommunity.com/id/example/inventory' } });
    await assert.rejects(() => noProfile.readInventory(), { code: 'OWNED_INVENTORY_URL_REQUIRED' });
    const otherProfile = api.makeNativeIO({ inventoryProfileUrl: 'https://steamcommunity.com/id/approved/inventory',
        inventory: { url: async () => 'https://steamcommunity.com/id/another/inventory' } });
    await assert.rejects(() => otherProfile.readInventory(), { code: 'INVENTORY_PROFILE_MISMATCH' });

    assert.equal(api.parseCompleteMarketSnapshot(marketFixture()).rows.length, 1);
    const partial = marketFixture(); partial.activeTotal = 2;
    assert.throws(() => api.parseCompleteMarketSnapshot(partial), { code: 'MARKET_PAGINATED' });
    const separateHold = marketFixture();
    separateHold.rows.push({ ...separateHold.rows[0], holdUntil: '10 月 11 日', links: [separateHold.rows[0].links[0],
        { href: "javascript:RemoveMarketListing('mylisting', '4002', 753, '16', '3002')" }] });
    separateHold.heldTotal = 1;
    assert.equal(api.parseCompleteMarketSnapshot(separateHold).rows.length, 2);
    separateHold.heldTotal = 2;
    assert.throws(() => api.parseCompleteMarketSnapshot(separateHold), { code: 'MARKET_PAGINATED' });
    assert.equal(api.parseCompleteMarketSnapshot({ account, listPresent: true, activeTotal: 0, rows: [] }).rows.length, 0);
    const unreadable = marketFixture(); delete unreadable.activeTotal;
    assert.throws(() => api.parseCompleteMarketSnapshot(unreadable), /MARKET_INCOMPLETE/);
    const doubled = marketFixture(); doubled.rows.push(doubled.rows[0]);
    assert.throws(() => api.parseCompleteMarketSnapshot(doubled), /DUPLICATE_MARKET_ASSET/);

    const success = simulation();
    assert.equal((await success.runner.runNext()).pending, 2);
    assert.equal((await success.runner.runNext()).pending, 3);
    assert.equal((await success.runner.runNext()).remaining, 0);
    assert.deepEqual(success.calls, { cancel: 3, submit: 2 });
    success.confirm();
    const held = await success.runner.reconcile();
    assert.equal(held.held, 3); assert.equal(held.pending, 0); assert.equal(held.active, 0);
    assert.ok(success.ledger.batches.every(b => b.submissionContextid === '6' && b.submissions.every(r => r.observed_contextid === '16')));
    assert.equal((await api.createRunner(success.params).runNext()).remaining, 0);
    assert.equal(success.calls.submit, 2);
    const wrongItem = clone(success.ledger.batches[0].submissions);
    wrongItem[0].url = 'https://steamcommunity.com/market/listings/753/12345-Wrong';
    assert.throws(() => api.observeBatch(success.ledger.batches[0], { rows: wrongItem }, []), /MARKET_ITEM_MISMATCH/);

    const defaultMobile = simulation();
    await defaultMobile.runner.runNext();
    const defaultRunner = api.createRunner({ ...defaultMobile.params, collectMobileConfirmations: false });
    assert.equal((await defaultRunner.runNext()).error.code, 'MOBILE_CONFIRMATION_REQUIRED');
    assert.equal(defaultMobile.calls.submit, 1);
    const mixed = simulation(); await mixed.runner.runNext();
    mixed.ledger.batches[0].state = 'CONFIRMED_MIXED';
    assert.equal((await api.createRunner({ ...mixed.params, collectMobileConfirmations: false }).runNext()).error.code, 'MOBILE_CONFIRMATION_REQUIRED');

    for (const [option, code] of [['wrongAccount', 'ACCOUNT_MISMATCH'], ['wrongInventoryAccount', 'INVENTORY_ACCOUNT_MISMATCH'], ['extraCopy', 'UNAPPROVED_SAME_NAME_COPIES']]) {
        const s = simulation({ [option]: true });
        assert.equal((await s.runner.runNext()).error.code, code);
        assert.deepEqual(s.calls, { cancel: 0, submit: 0 });
    }
    for (const [option, code] of [['priceMismatch', 'NATIVE_PRICE_OR_QUANTITY_MISMATCH'], ['tradeLocked', 'RETURNED_COHORT_MISMATCH'], ['termsUnchecked', 'TERMS_REQUIRE_USER']]) {
        const s = simulation({ [option]: true });
        assert.equal((await s.runner.runNext()).error.code, code);
        assert.equal(s.calls.submit, 0);
    }
    const modal = simulation({ modalTimeout: true });
    assert.equal((await modal.runner.runNext()).pending, 2);
    assert.equal(modal.calls.submit, 1);
    const unknown = simulation({ modalTimeout: true, missingAccepted: true });
    assert.equal((await unknown.runner.runNext()).halted, true);
    assert.equal(unknown.ledger.batches[0].state, 'OUTCOME_UNKNOWN');
    assert.equal((await api.createRunner(unknown.params).runNext()).error.code, 'LOCKED_OUTCOME');
    assert.equal(unknown.calls.submit, 1);
    const cancel = simulation({ cancelTimeout: true });
    await cancel.runner.runNext();
    assert.equal(cancel.ledger.batches[0].state, 'OUTCOME_UNKNOWN');
    await api.createRunner(cancel.params).runNext(); assert.equal(cancel.calls.cancel, 1);
    const persistence = simulation({ saveFails: true });
    assert.equal((await persistence.runner.runNext()).halted, true);
    assert.deepEqual(persistence.calls, { cancel: 0, submit: 0 });
    const systemic = simulation({ systemError: true });
    assert.equal((await systemic.runner.runNext()).error.code, 'STEAM_SYSTEM_ERROR');
    assert.equal(systemic.ledger.batches[0].state, 'PENDING_MOBILE_CONFIRMATION');
    assert.equal((await api.createRunner(systemic.params).runNext()).error.code, 'SYSTEM_PAUSED');
    assert.equal(systemic.calls.submit, 1);
    const stale = simulation({ staleInventory: true });
    await stale.runner.runNext(); stale.confirm();
    assert.equal((await stale.runner.reconcile()).error.code, 'RECONCILE_PENDING');
    assert.equal((await api.createRunner(stale.params).runNext()).error.code, 'LOCKED_OUTCOME');
    await assert.rejects(() => stale.runner.resumeReadOnly(), /LOCKED_OUTCOME/);
    const tampered = simulation({ priceMismatch: true });
    await tampered.runner.runNext();
    tampered.ledger.batches[0].buyerCents++;
    assert.equal((await api.createRunner(tampered.params).runNext()).error.code, 'BATCH_LOCK_MISMATCH');
    assert.equal(tampered.calls.submit, 0);
    const edited = simulation(); edited.ledger.rows.forEach(r => { r.proposedBuyerCents++; r.nativeFeeCents++; }); edited.ledger.approvedBuyerTotalCents += 3;
    assert.equal((await edited.runner.runNext()).error.code, 'APPROVED_PLAN_CHANGED');
    assert.deepEqual(edited.calls, { cancel: 0, submit: 0 });

    const helperSource = fs.readFileSync(path.join(__dirname, 'steam-card-bulk-lister.user.js'), 'utf8');
    assert.ok(!helperSource.includes('/market/sellitem/') && !helperSource.includes('g_sessionID') && !/method\s*:\s*['"]POST['"]/.test(helperSource));
    const helperSandbox = { __STEAM_CARD_LISTING_TEST__: true }; vm.runInNewContext(helperSource, helperSandbox);
    const helper = helperSandbox.__SteamCardListingCore;
    assert.throws(() => helper.calculateBuyerCents(64, 0.1), /原生费用计算器不可用/);
    assert.equal(helper.normalizeAsset({ assetid: '123', appid: '753', contextid: '6', description: {
        market_hash_name: '12345-Example', marketable: 1, tradable: 0,
    } }).tradable, false);
    const previewSource = fs.readFileSync(path.join(__dirname, 'steam-card-native-preview-fix.user.js'), 'utf8');
    const previewSandbox = { URL, __STEAM_CARD_PREVIEW_FIX_TEST__: true }; vm.runInNewContext(previewSource, previewSandbox);
    const preview = previewSandbox.__SteamCardPreviewFix;
    assert.equal(new URL(preview.buildNativeUrl(makePlan().rows[0].url)).searchParams.get('qty[]'), '0');
    assert.throws(() => preview.buildNativeUrl('https://example.com/market/listings/753/12345-Example'));
    assert.throws(() => preview.buildNativeUrl('https://steamcommunity.com/market/listings/730/12345-Example'));
    console.log('PASS: offline native card plan, approvals, grouped execution, market completeness, account checks, fee locks, mobile consolidation, holds/context, unknown outcomes/restarts, stale inventory, durable writes, systemic stop, read-only helper, and zero-quantity preview. No live requests.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
