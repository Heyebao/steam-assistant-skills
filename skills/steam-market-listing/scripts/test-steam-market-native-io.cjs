'use strict';
// Adapter contract and round-trip budgets. Fictional DOM observations only.
const assert = require('node:assert/strict');
const { makeNativeIO, buildNativeBatchUrl, verifyNativeSnapshot } = require('./steam-market-reprice-runner.cjs');
const account = 'Offline adapter';
const groups = ['12345-Example A', '12345-Example B'].map(hash => ({ hash,
    url: 'https://steamcommunity.com/market/listings/753/' + encodeURIComponent(hash) }));
const batches = [{ account, quantity: 2, buyerCents: 78, receiveCents: 64 },
    { account, quantity: 1, buyerCents: 99, receiveCents: 84 }];
const clone = x => JSON.parse(JSON.stringify(x));
function observation() {
    return { account, url: buildNativeBatchUrl(groups.map((g, i) => ({ hash: g.hash, quantity: batches[i].quantity }))),
        terms: true, total: '¥ 2.12', rows: groups.map((g, i) => ({ hash: g.hash, quantity: batches[i].quantity,
            available: batches[i].quantity, prices: i ? ['¥ 0.84', '¥ 0.99'] : ['¥ 0.64', '¥ 0.78'] })) };
}
function sellTab(snapshot = observation()) {
    const trace = [];
    const tab = {
        async goto(url) { trace.push('goto'); snapshot.url = url; },
        playwright: {
            async evaluate() { trace.push('read all native fields'); return clone(snapshot); },
            locator(selector) { return { selector }; },
            getByRole(role) {
                if (role === 'link') return { async click() { trace.push('submit'); } };
                assert.equal(role, 'row');
                return { filter({ has }) {
                    const i = groups.findIndex(g => has.selector.includes(g.url));
                    assert.notEqual(i, -1, 'price locator binds this exact group URL');
                    return { getByRole(type) {
                        assert.equal(type, 'textbox');
                        return { nth(index) {
                            assert.equal(index, 1);
                            return {
                                async fill(value) { trace.push('fill'); snapshot.rows[i].prices[1] = value; },
                                async press(key) { trace.push('price event'); assert.equal(key, 'Tab'); },
                            };
                        } };
                    } };
                } };
            },
        },
    };
    return { tab, trace, snapshot };
}
async function main() {
    assert.equal(verifyNativeSnapshot(observation(), groups, batches).length, 2);
    for (const [edit, code] of [
        [s => { s.account = 'Other'; }, 'ACCOUNT_MISMATCH'],
        [s => { s.rows[0].prices[0] = '¥ 0.63'; }, 'NATIVE_PRICE_OR_QUANTITY_MISMATCH'],
        [s => { s.rows[0].quantity = 1; }, 'NATIVE_PRICE_OR_QUANTITY_MISMATCH'],
        [s => { s.rows[0].available = 3; }, 'NATIVE_PRICE_OR_QUANTITY_MISMATCH'],
        [s => { s.rows.pop(); }, 'NATIVE_IDENTITY_MISMATCH'],
        [s => { s.rows[1].hash = s.rows[0].hash; }, 'NATIVE_IDENTITY_MISMATCH'],
        [s => { s.total = '¥ 2.11'; }, 'NATIVE_PRICE_OR_QUANTITY_MISMATCH'],
        [s => { s.terms = false; }, 'TERMS_REQUIRE_USER'],
        [s => { s.url = s.url.replace('contextid=6', 'contextid=16'); }, 'NATIVE_IDENTITY_MISMATCH'],
    ]) {
        const s = observation(); edit(s);
        assert.throws(() => verifyNativeSnapshot(s, groups, batches), { code });
    }
    assert.throws(() => buildNativeBatchUrl([{ hash: groups[0].hash, quantity: 1 }, { hash: groups[0].hash, quantity: 1 }]), /DUPLICATE_NATIVE_GROUP/);
    const shared = {}; assert.throws(() => makeNativeIO({ market: shared, inventory: shared }), /SEPARATE_TABS_REQUIRED/);

    const multi = sellTab(); const io = makeNativeIO({ sell: multi.tab });
    await io.openNative(groups, batches);
    for (let i = 0; i < groups.length; i++) await io.priceNative(groups[i], batches[i]);
    assert.equal((await io.verifyNative(groups, batches)).length, 2);
    await io.clickSubmit();
    assert.equal(multi.trace.length, 8, 'two groups use one open, two price edits, one combined verification and one click');
    assert.equal(multi.trace.filter(x => x === 'submit').length, 1);
    const singleSnapshot = observation(); singleSnapshot.rows.pop(); singleSnapshot.total = '¥ 1.28';
    const single = sellTab(singleSnapshot);
    await makeNativeIO({ sell: single.tab }).prepare(groups[0], batches[0]);
    assert.equal(single.trace.length, 5, 'legacy native preparation also combines DOM reads');

    const cancelTrace = [], sources = ['1001', '1002'].map((listingid, i) => ({ listingid, appid: '753', submission_contextid: '6', assetid: '200' + (i + 1) }));
    const market = { playwright: {
        locator(selector) {
            const source = sources.find(r => selector === '#mylisting_' + r.listingid);
            assert.ok(source);
            return { getByRole() { return {
                async getAttribute() { cancelTrace.push('identity:' + source.listingid); return `javascript:RemoveMarketListing('mylisting', '${source.listingid}', 753, '6', '${source.assetid}')`; },
                async click() { cancelTrace.push('remove:' + source.listingid); },
            }; }, async waitFor() { cancelTrace.push('removed:' + source.listingid); } };
        },
        getByText() { return { async click() { cancelTrace.push('confirm'); } }; },
    } };
    const cancelIO = makeNativeIO({ market });
    await cancelIO.cancel(sources[0]); await cancelIO.cancel(sources[1]);
    assert.deepEqual(cancelTrace.filter(x => x.startsWith('remove:')), ['remove:1001', 'remove:1002']);
    assert.equal(cancelTrace.length, 8, 'each cancel uses four guarded native operations');

    const inventoryTrace = [], profile = 'https://steamcommunity.com/id/offline/inventory';
    const inventorySnapshot = { schema: '1', currency: 23, busy: false, account,
        log: '只读盘点完成：0 件、0 种', rows: [] };
    const inventory = { async url() { inventoryTrace.push('profile'); return profile; },
        async reload() { inventoryTrace.push('reload'); }, playwright: {
            getByRole() { return { async click() { inventoryTrace.push('scan'); } }; },
            locator() { return { async waitFor() { inventoryTrace.push('finished'); } }; },
            async evaluate() { inventoryTrace.push('snapshot'); return clone(inventorySnapshot); },
        } };
    const inventoryIO = makeNativeIO({ inventory, inventoryProfileUrl: profile });
    assert.equal((await inventoryIO.readInventory()).account, account);
    assert.equal(inventoryTrace.length, 5);
    inventorySnapshot.busy = true;
    await assert.rejects(() => inventoryIO.readInventory(), /INVENTORY_INCOMPLETE/);
    console.log('PASS: native fee/account/cohort/terms checks; two-group form uses 8 browser operations, single-group preparation 5, cancellation 4/card, inventory scan 5; no live requests.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
