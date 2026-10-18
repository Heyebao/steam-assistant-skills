'use strict';
// Offline only: fictional assets and injected IO; no browser or network access.
const assert = require('node:assert/strict');
const { createRunner } = require('./steam-market-reprice-runner.cjs');
const clone = value => JSON.parse(JSON.stringify(value));
const account = 'Offline staged test';
const hashFor = row => decodeURIComponent(new URL(row.url).pathname.split('/').at(-1));
const returnedId = row => '30' + row.assetid.slice(2);

function makePlan(groupCount = 2) {
    const make = (id, hash, buyer, receive) => ({ listingid: '10' + id, assetid: '20' + id,
        appid: '753', submission_contextid: '6', name: hash, game: 'Example Trading Card',
        url: 'https://steamcommunity.com/market/listings/753/' + encodeURIComponent(hash),
        proposedBuyerCents: buyer, nativeReceiveCents: receive, nativeFeeCents: buyer - receive,
        state: 'APPROVED_ACTIVE' });
    const rows = [make('01', '12345-Example A', 78, 64), make('02', '12345-Example A', 78, 64)];
    for (let i = 1; i < groupCount; i++) rows.push(make(String(i + 2).padStart(2, '0'),
        '12345-Example ' + String.fromCharCode(65 + i), 99 + (i - 1) * 20, 84 + (i - 1) * 20));
    return { account, approvedBuyerTotalCents: rows.reduce((sum, row) => sum + row.proposedBuyerCents, 0),
        approvedReceiveTotalCents: rows.reduce((sum, row) => sum + row.nativeReceiveCents, 0), rows, batches: [] };
}

function fixture(options = {}) {
    const ledger = makePlan(options.groupCount), source = clone(ledger.rows), cancelled = new Set(), accepted = new Set();
    const groupCount = new Set(source.map(hashFor)).size;
    const saves = [], events = [], calls = { market: 0, inventory: 0, cancel: [], open: 0, price: [], verify: 0, click: 0 };
    let activeReads = 0, maxActiveReads = 0, opened = false;
    let releaseRead;
    const blockedRead = options.blockRead || (options.blockInventory ? 'inventory' : null);
    const readGate = blockedRead ? new Promise(resolve => { releaseRead = resolve; }) : null;
    const latest = () => saves.at(-1);
    function throwSync(kind) {
        calls[kind]++; events.push(kind + ':start'); events.push(kind + ':end');
        throw Object.assign(new Error('synchronous fixture read failed'), { code: 'FIXTURE_SYNC_READ_FAILED' });
    }
    async function read(kind, getValue) {
        calls[kind]++; events.push(kind + ':start'); activeReads++;
        maxActiveReads = Math.max(maxActiveReads, activeReads);
        try {
            // Yield without a wall-clock sleep so independent reads can overlap.
            await Promise.resolve();
            if (kind === blockedRead) await readGate;
            if (kind === 'market' && options.failMarket) throw Object.assign(new Error('fixture read failed'), { code: 'FIXTURE_READ_FAILED' });
            await Promise.resolve();
            return getValue();
        } finally { activeReads--; events.push(kind + ':end'); }
    }
    const io = {
        readMarket() {
            if (options.syncThrow === 'market') return throwSync('market');
            return read('market', () => ({ account, rows: source.flatMap(row => {
                if (!cancelled.has(row.assetid)) return [{ listingid: row.listingid, assetid: row.assetid,
                    appid: '753', observed_contextid: '6', state: 'ACTIVE', url: row.url,
                    buyerCents: row.proposedBuyerCents, receiveCents: row.nativeReceiveCents }];
                if (!accepted.has(returnedId(row))) return [];
                return [{ listingid: '40' + row.assetid.slice(2), assetid: returnedId(row), appid: '753',
                    observed_contextid: '6', state: 'PENDING_MOBILE_CONFIRMATION', url: row.url,
                    buyerCents: row.proposedBuyerCents, receiveCents: row.nativeReceiveCents }];
            }) }));
        },
        readInventory() {
            if (options.syncThrow === 'inventory') return throwSync('inventory');
            return read('inventory', () => {
                const rows = source.filter(row => cancelled.has(row.assetid)).map(row => ({
                    assetid: returnedId(row), hash: hashFor(row), eligible: true, pending: accepted.has(returnedId(row)),
                }));
                if (options.extraReturnedCopy && cancelled.size === source.length) rows.push({
                    assetid: '9999', hash: hashFor(source[0]), eligible: true, pending: false,
                });
                rows.account = account;
                return rows;
            });
        },
        async cancel(row) {
            const original = source.find(candidate => candidate.listingid === row.listingid);
            assert.ok(original, 'every cancellation supplies an approved old listing ID');
            assert.deepEqual([row.listingid, row.appid, row.submission_contextid, row.assetid],
                [original.listingid, '753', '6', original.assetid], 'old identity is explicit on every action');
            assert.equal(latest().rows.find(candidate => candidate.listingid === row.listingid).state, 'CANCEL_REQUESTED');
            assert.ok(latest().batches.some(batch => batch.state === 'CANCEL_REQUESTED' && batch.oldListingids.includes(row.listingid)),
                'durable cancellation lock precedes click');
            assert.ok(!cancelled.has(row.assetid), 'a cancellation must not replay');
            calls.cancel.push(row.listingid); events.push('cancel:' + row.listingid); cancelled.add(row.assetid);
        },
        async openNative(groups, batches) {
            calls.open++; events.push('open'); opened = true;
            assert.equal(groups.length, groupCount); assert.equal(batches.length, groupCount);
            assert.equal(batches.reduce((sum, batch) => sum + batch.quantity, 0), source.length);
            assert.equal(cancelled.size, source.length);
            assert.deepEqual(new Set(batches.flatMap(batch => batch.submissionAssetids)), new Set(source.map(returnedId)));
        },
        async priceNative(group, batch) {
            assert.ok(opened); assert.equal(group.key, batch.key);
            assert.ok(!calls.price.includes(group.key), 'a group is priced once');
            calls.price.push(group.key); events.push('price:' + group.key);
        },
        async verifyNative(groups, batches) {
            calls.verify++; events.push('verify');
            assert.equal(groups.length, groupCount); assert.equal(calls.price.length, groupCount);
            if (options.beforeVerify) await options.beforeVerify(ledger);
            return batches.map(batch => ({ buyerCents: batch.buyerCents, receiveCents: batch.receiveCents,
                quantity: batch.quantity, receiveTotalCents: batch.quantity * batch.receiveCents }));
        },
        async clickSubmit() {
            assert.equal(calls.verify, 1);
            assert.equal(latest().batches.length, groupCount);
            assert.ok(latest().batches.every(batch => batch.state === 'SUBMITTING_NATIVE'),
                'all submitted assets are durably locked before native click');
            calls.click++; events.push('click');
            assert.equal(calls.click, 1, 'a native click must never replay');
            source.forEach(row => accepted.add(returnedId(row)));
            if (options.clickTimeout) throw new Error('native click timed out after acceptance');
        },
        async readResult() { events.push('result'); return 'Accepted'; },
        async dismissResult() { events.push('dismiss'); },
    };
    const params = { ledger, io, approvedPlan: true, collectMobileConfirmations: true, batchGroups: true,
        persist: async value => {
            if (options.beforePersist) await options.beforePersist(value, calls);
            saves.push(clone(value)); events.push('persist');
        } };
    return { ledger, params, runner: createRunner(params), calls, saves, events,
        cardCount: source.length, groupCount, steps: 0,
        releaseRead: () => releaseRead?.(), releaseInventory: () => releaseRead?.(),
        get activeReads() { return activeReads; }, get maxActiveReads() { return maxActiveReads; } };
}

async function oneStep(f, runner = f.runner) {
    const before = { cancel: f.calls.cancel.length, open: f.calls.open, price: f.calls.price.length,
        click: f.calls.click, market: f.calls.market, inventory: f.calls.inventory };
    f.steps++;
    const result = await runner.runStep();
    assert.ok(f.calls.cancel.length - before.cancel <= 1, 'one step cancels at most one card');
    assert.ok(f.calls.price.length - before.price <= 1, 'one step fills at most one price group');
    const phases = Number(f.calls.cancel.length > before.cancel) + Number(f.calls.open > before.open) +
        Number(f.calls.price.length > before.price) + Number(f.calls.click > before.click) +
        Number(f.calls.market > before.market || f.calls.inventory > before.inventory);
    assert.ok(phases <= 1, 'a step cannot combine baseline/return/reconciliation reads with a transaction phase');
    return result;
}
async function complete(f, runner = f.runner) {
    for (let i = 0; i < 24; i++) {
        const result = await oneStep(f, runner);
        assert.equal(Boolean(result?.halted), false, JSON.stringify(result?.error));
        const summary = runner.summary();
        if (summary.remaining === 0 && summary.submitted === f.cardCount) return summary;
    }
    assert.fail('staged runner failed to finish within its finite stage budget');
}

function deferred() {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
}
function changeApproval(ledger) {
    ledger.rows[0].proposedBuyerCents++; ledger.rows[0].nativeFeeCents++;
    ledger.approvedBuyerTotalCents++;
}
async function advanceUntil(f, predicate) {
    for (let i = 0; i < 24; i++) {
        if (predicate()) return;
        const result = await oneStep(f);
        assert.equal(Boolean(result?.halted), false, JSON.stringify(result?.error));
    }
    assert.fail('fixture did not reach the requested checkpoint');
}

async function main() {
    const success = fixture();
    const first = await oneStep(success);
    assert.equal(Boolean(first?.halted), false);
    assert.deepEqual(success.calls.cancel, [], 'baseline is its own read-only step');
    const summary = await complete(success);
    assert.equal(summary.pending, 3);
    assert.equal(summary.buyerTotalCents, 255); assert.equal(summary.receiveTotalCents, 212);
    assert.deepEqual(success.calls.cancel, ['1001', '1002', '1003']);
    assert.equal(success.calls.open, 1); assert.equal(success.calls.price.length, 2);
    assert.equal(success.calls.verify, 1); assert.equal(success.calls.click, 1);
    assert.equal(success.calls.market, 3); assert.equal(success.calls.inventory, 3);
    assert.equal(success.maxActiveReads, 2, 'market/inventory snapshots overlap');
    const beforeDone = clone(success.calls);
    await oneStep(success); assert.deepEqual(success.calls, beforeDone, 'completed jobs perform no further work');

    const timeout = fixture({ clickTimeout: true });
    const recovered = await complete(timeout);
    assert.equal(recovered.pending, 3); assert.equal(timeout.calls.click, 1);

    const restart = fixture();
    for (let i = 0; i < 24 && restart.calls.click === 0; i++) {
        const step = await oneStep(restart); assert.equal(Boolean(step?.halted), false);
    }
    assert.equal(restart.calls.click, 1);
    const persisted = clone(restart.saves.at(-1));
    assert.ok(persisted.batches.every(batch => batch.state === 'SUBMITTING_NATIVE'),
        'submission step leaves a durable acceptance check for the next step');
    const replay = createRunner({ ...restart.params, ledger: persisted });
    const mutationCounts = { cancel: restart.calls.cancel.length, open: restart.calls.open,
        price: restart.calls.price.length, verify: restart.calls.verify, click: restart.calls.click };
    assert.equal((await complete(restart, replay)).pending, 3);
    assert.deepEqual({ cancel: restart.calls.cancel.length, open: restart.calls.open,
        price: restart.calls.price.length, verify: restart.calls.verify, click: restart.calls.click }, mutationCounts,
    'restart after submitting only reconciles; it never repeats native actions');

    const edited = fixture(); await oneStep(edited);
    edited.ledger.rows[0].proposedBuyerCents++; edited.ledger.rows[0].nativeFeeCents++;
    edited.ledger.approvedBuyerTotalCents++;
    const changed = await oneStep(edited);
    assert.equal(changed.error.code, 'APPROVED_PLAN_CHANGED');
    assert.equal(edited.calls.cancel.length, 0); assert.equal(edited.calls.click, 0);

    const duplicate = fixture({ extraReturnedCopy: true });
    let duplicateResult;
    for (let i = 0; i < 24; i++) {
        duplicateResult = await oneStep(duplicate);
        if (duplicateResult?.halted) break;
    }
    assert.equal(duplicateResult.error.code, 'RETURNED_COHORT_MISMATCH');
    assert.equal(duplicate.calls.open, 0); assert.equal(duplicate.calls.click, 0);

    const readFailure = fixture({ failMarket: true, blockInventory: true });
    let settled = false;
    const running = readFailure.runner.runStep().then(value => { settled = true; return value; }, error => { settled = true; throw error; });
    for (let i = 0; i < 12; i++) await Promise.resolve();
    assert.equal(readFailure.calls.inventory, 1, 'the independent inventory read starts despite market failure');
    assert.equal(settled, false, 'one failed read cannot release the runner while its sibling is active');
    assert.equal(readFailure.activeReads, 1);
    readFailure.releaseInventory();
    const failed = await running;
    assert.equal(failed.halted, true); assert.equal(readFailure.activeReads, 0);
    assert.equal(readFailure.calls.cancel.length, 0); assert.equal(readFailure.calls.click, 0);

    for (const failingAction of ['cancel', 'submit']) {
        const writeFailure = fixture({ beforePersist: async (value, calls) => {
            const transactionLock = failingAction === 'cancel' ? value.batches.some(batch => batch.state === 'CANCEL_REQUESTED') :
                value.execution?.phase === 'RECONCILE' && value.batches.every(batch => batch.state === 'SUBMITTING_NATIVE') && calls.click === 0;
            if (transactionLock) throw new Error('fixture disk failure before ' + failingAction);
        } });
        await advanceUntil(writeFailure, () => writeFailure.ledger.execution?.phase === (failingAction === 'cancel' ? 'CANCEL' : 'SUBMIT'));
        const stopped = await oneStep(writeFailure);
        assert.equal(stopped.halted, true);
        assert.equal(writeFailure.calls.click, 0, 'failed pre-transaction persistence prevents native submission');
        if (failingAction === 'cancel') assert.equal(writeFailure.calls.cancel.length, 0, 'failed persistence prevents cancellation');
    }

    let diskUnavailable = true;
    const afterClickFailure = fixture({ beforePersist: async (_value, calls) => {
        if (calls.click > 0 && diskUnavailable) throw new Error('fixture disk failure after native acceptance');
    } });
    await advanceUntil(afterClickFailure, () => afterClickFailure.ledger.execution?.phase === 'SUBMIT');
    const failedAfterClick = await oneStep(afterClickFailure);
    assert.equal(failedAfterClick.halted, true); assert.equal(afterClickFailure.calls.click, 1);
    const durableSubmission = clone(afterClickFailure.saves.at(-1));
    assert.equal(durableSubmission.execution.phase, 'RECONCILE');
    assert.ok(durableSubmission.batches.every(batch => batch.state === 'SUBMITTING_NATIVE'));
    diskUnavailable = false;
    const afterDiskRestart = createRunner({ ...afterClickFailure.params, ledger: durableSubmission });
    assert.equal((await complete(afterClickFailure, afterDiskRestart)).pending, 3);
    assert.equal(afterClickFailure.calls.click, 1, 'restarting from the last durable lock cannot repeat the accepted click');

    for (const waitingAction of ['cancel', 'submit']) {
        const entered = deferred(), release = deferred();
        let intercepted = false;
        const duringPersist = fixture({ beforePersist: async (value, calls) => {
            const transactionLock = waitingAction === 'cancel' ? value.batches.some(batch => batch.state === 'CANCEL_REQUESTED') :
                value.execution?.phase === 'RECONCILE' && value.batches.every(batch => batch.state === 'SUBMITTING_NATIVE') && calls.click === 0;
            if (!intercepted && transactionLock) { intercepted = true; entered.resolve(); await release.promise; }
        } });
        await advanceUntil(duringPersist, () => duringPersist.ledger.execution?.phase === (waitingAction === 'cancel' ? 'CANCEL' : 'SUBMIT'));
        const pending = oneStep(duringPersist);
        await entered.promise;
        changeApproval(duringPersist.ledger);
        release.resolve();
        const changedDuringPersist = await pending;
        assert.equal(changedDuringPersist.error.code, 'APPROVED_PLAN_CHANGED');
        assert.equal(duringPersist.calls.click, 0, 'approval edits during durable write prevent native submission');
        if (waitingAction === 'cancel') assert.equal(duringPersist.calls.cancel.length, 0, 'approval edits during durable write prevent cancellation');
    }

    const verifying = deferred(), releaseVerify = deferred();
    const duringVerify = fixture({ beforeVerify: async () => { verifying.resolve(); await releaseVerify.promise; } });
    await advanceUntil(duringVerify, () => duringVerify.ledger.execution?.phase === 'SUBMIT');
    const pendingVerification = oneStep(duringVerify);
    await verifying.promise;
    changeApproval(duringVerify.ledger);
    releaseVerify.resolve();
    const changedDuringVerify = await pendingVerification;
    assert.equal(changedDuringVerify.error.code, 'APPROVED_PLAN_CHANGED');
    assert.equal(duringVerify.calls.click, 0, 'approval edits while native verification waits prevent submission');

    for (const syncThrow of ['market', 'inventory']) {
        const sibling = syncThrow === 'market' ? 'inventory' : 'market';
        const syncFailure = fixture({ syncThrow, blockRead: sibling });
        let syncSettled = false;
        const syncRun = syncFailure.runner.runStep().then(value => { syncSettled = true; return value; });
        for (let i = 0; i < 12; i++) await Promise.resolve();
        assert.equal(syncFailure.calls.market, 1); assert.equal(syncFailure.calls.inventory, 1);
        assert.equal(syncSettled, false, 'a synchronous ' + syncThrow + ' failure still awaits the active sibling');
        assert.equal(syncFailure.activeReads, 1);
        syncFailure.releaseRead();
        const syncFailed = await syncRun;
        assert.equal(syncFailed.error.code, 'FIXTURE_SYNC_READ_FAILED'); assert.equal(syncFailure.activeReads, 0);
        assert.equal(syncFailure.calls.cancel.length, 0); assert.equal(syncFailure.calls.click, 0);
    }

    const sevenCards = fixture({ groupCount: 6 });
    const sevenSummary = await complete(sevenCards);
    assert.equal(sevenSummary.pending, 7); assert.equal(sevenCards.calls.cancel.length, 7);
    assert.equal(sevenCards.calls.price.length, 6); assert.equal(sevenCards.calls.open, 1);
    assert.equal(sevenCards.calls.market, 3); assert.equal(sevenCards.calls.inventory, 3);
    assert.equal(sevenCards.calls.click, 1);
    console.log('SCALE: 6 groups / 7 cards; ' + sevenCards.steps + ' steps; ' + sevenCards.calls.market +
        ' paired market+inventory snapshots (' + (sevenCards.calls.market + sevenCards.calls.inventory) + ' reads); ' + sevenCards.calls.click + ' native submission.');
    console.log('PASS: offline staged batching, one-action steps, durable locks, exact old identities, no timeout/restart replay, pre/post-click persistence failures, approval edits during waits, settled parallel/synchronous reader failures, and extra-copy stop. No live requests.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
