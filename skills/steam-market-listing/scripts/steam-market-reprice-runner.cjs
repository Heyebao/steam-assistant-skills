'use strict';

// Reusable Codex browser orchestration. Importing this file never starts a job.
// All live actions use the provided cua Tab API. No HTTP transaction requests,
// Steam globals, credentials, cookies, or extension storage are accessed here.
const DONE = new Set(['PENDING_MOBILE_CONFIRMATION', 'CONFIRMED_MARKET_HOLD', 'ACTIVE']);
const UNSAFE = new Set(['SUBMITTING_NATIVE', 'CANCEL_REQUESTED', 'OUTCOME_UNKNOWN', 'RECONCILE_PENDING']);
const IN_FLIGHT_JOBS = new Set(); // Process-local only; never run two owners of one ledger.
const HELPER_VERSION = '0.4.0', HELPER_SCHEMA = 2;
const HELPER_LOCKED_STATES = new Set(['EXTERNAL_PENDING', 'SUBMITTING', 'SUBMITTED', 'PAUSED_CONFIRMATIONS',
    'RECONCILE_PENDING', 'OUTCOME_UNKNOWN', 'QUARANTINED', 'ACTIVE']);
const HELPER_STATES = new Set([...HELPER_LOCKED_STATES, 'DISCOVERED', 'PLANNED', 'PRICE_ERROR', 'RETRYABLE_ERROR']);
const money = cents => (cents / 100).toFixed(2);
const cents = text => {
    const value = String(text).replace(/[^\d.]/g, '');
    if (!/^\d+\.\d{2}$/.test(value)) throw new Error('PRICE_FORMAT');
    return Math.round(Number(value) * 100);
};
function fail(code, detail) { throw Object.assign(new Error(detail || code), { code }); }
function groupKey(hash) { return '753|6|' + hash; }
function buildNativeUrl(hash, quantity) {
    if (!/^\d+-.+/.test(hash) || !Number.isInteger(quantity) || quantity < 0) fail('INVALID_NATIVE_GROUP');
    const url = new URL('https://steamcommunity.com/market/multisell');
    url.searchParams.set('appid', '753');
    url.searchParams.set('contextid', '6');
    url.searchParams.append('items[]', hash);
    url.searchParams.append('qty[]', String(quantity));
    return url.toString();
}
function buildNativeBatchUrl(groups) {
    if (!Array.isArray(groups) || !groups.length) fail('INVALID_NATIVE_GROUP');
    const url = new URL('https://steamcommunity.com/market/multisell');
    url.searchParams.set('appid', '753'); url.searchParams.set('contextid', '6');
    const seen = new Set();
    for (const group of groups) {
        buildNativeUrl(group.hash, group.quantity);
        if (seen.has(group.hash)) fail('DUPLICATE_NATIVE_GROUP');
        seen.add(group.hash);
        url.searchParams.append('items[]', group.hash);
        url.searchParams.append('qty[]', String(group.quantity));
    }
    return url.toString();
}
function verifyNativeSnapshot(snapshot, groups, batches, prices = true, preview = false) {
    if (snapshot.account !== batches[0].account) fail('ACCOUNT_MISMATCH');
    const actual = new URL(snapshot.url);
    const expected = new URL(buildNativeBatchUrl(groups.map((g, i) => ({ hash: g.hash, quantity: batches[i].quantity }))));
    if (actual.origin !== expected.origin || actual.pathname !== expected.pathname ||
        actual.searchParams.get('appid') !== '753' || actual.searchParams.get('contextid') !== '6' ||
        JSON.stringify(actual.searchParams.getAll('items[]')) !== JSON.stringify(expected.searchParams.getAll('items[]')) ||
        JSON.stringify(actual.searchParams.getAll('qty[]')) !== JSON.stringify(expected.searchParams.getAll('qty[]'))) fail('NATIVE_IDENTITY_MISMATCH');
    if (snapshot.rows.length !== groups.length || new Set(snapshot.rows.map(r => r.hash)).size !== groups.length) fail('NATIVE_IDENTITY_MISMATCH');
    const checks = groups.map((group, i) => {
        const row = snapshot.rows.find(r => r.hash === group.hash), batch = batches[i];
        if (!row || row.quantity !== batch.quantity || (preview ? !Number.isSafeInteger(row.available) || row.available < 0 : row.available !== batch.quantity)) fail('NATIVE_PRICE_OR_QUANTITY_MISMATCH');
        if (!prices) return null;
        const buyerCents = cents(row.prices[1]), receiveCents = cents(row.prices[0]);
        if (buyerCents !== batch.buyerCents || receiveCents !== batch.receiveCents) fail('NATIVE_PRICE_OR_QUANTITY_MISMATCH');
        return { buyerCents, receiveCents, quantity: row.quantity, receiveTotalCents: row.quantity * receiveCents };
    });
    if (prices) {
        if (!snapshot.terms) fail('TERMS_REQUIRE_USER');
        if (cents(snapshot.total) !== checks.reduce((sum, r) => sum + r.receiveTotalCents, 0)) fail('NATIVE_PRICE_OR_QUANTITY_MISMATCH');
    }
    return checks;
}
function validatePlan(ledger) {
    const account = typeof ledger.account === 'string' ? ledger.account : ledger.account?.name;
    if (!account || !Array.isArray(ledger.rows) || !ledger.rows.length) fail('INVALID_APPROVED_PLAN');
    const groups = new Map(), ids = new Set(), listings = new Set();
    let buyerTotal = 0, receiveTotal = 0;
    for (const row of ledger.rows) {
        const url = new URL(row.url);
        const path = url.pathname.match(/^\/market\/listings\/753\/([^/]+)\/?$/);
        if (url.origin !== 'https://steamcommunity.com' || !path || row.appid !== '753' ||
            row.submission_contextid !== '6' || !/集换式卡牌|Trading Card/i.test(row.game || '')) fail('CARD_SCOPE');
        const hash = decodeURIComponent(path[1]);
        buildNativeUrl(hash, 0);
        if (!/^\d+$/.test(row.assetid) || !/^\d+$/.test(row.listingid) ||
            ids.has(row.assetid) || listings.has(row.listingid)) fail('DUPLICATE_OR_INVALID_ID');
        ids.add(row.assetid); listings.add(row.listingid);
        const buyer = row.proposedBuyerCents, receive = row.nativeReceiveCents;
        if (!Number.isSafeInteger(buyer) || !Number.isSafeInteger(receive) ||
            receive < 1 || buyer <= receive || buyer - receive !== row.nativeFeeCents) fail('INVALID_FEE_LOCK');
        const key = groupKey(hash);
        if (!groups.has(key)) groups.set(key, { key, hash, url: row.url, name: row.name, buyerCents: buyer, receiveCents: receive, rows: [] });
        const group = groups.get(key);
        if (group.buyerCents !== buyer || group.receiveCents !== receive || group.url !== row.url) fail('MIXED_PRICE_LOCK');
        group.rows.push(row); buyerTotal += buyer; receiveTotal += receive;
    }
    if (buyerTotal !== ledger.approvedBuyerTotalCents || receiveTotal !== ledger.approvedReceiveTotalCents) fail('APPROVED_TOTAL_MISMATCH');
    return { account, groups: [...groups.values()], buyerTotal, receiveTotal };
}
function parseMarketRows(snapshot) {
    const seen = new Set();
    const rows = snapshot.rows.map(row => {
        const link = row.links.find(a => /(?:CancelMarketListingConfirmation|RemoveMarketListing)\(/.test(a.href || ''));
        const match = link?.href.match(/(CancelMarketListingConfirmation|RemoveMarketListing)\(\s*['"]mylisting['"]\s*,\s*['"](\d+)['"]\s*,\s*(\d+)\s*,\s*['"](\d+)['"]\s*,\s*['"](\d+)['"]\s*\)/);
        if (!match) fail('MARKET_ROW_UNREADABLE');
        const identity = match[3] + '|' + match[5];
        if (seen.has(identity)) fail('DUPLICATE_MARKET_ASSET');
        seen.add(identity);
        const amounts = [...row.text.matchAll(/¥\s*(\d+\.\d{2})/g)].map(m => cents(m[1]));
        if (amounts.length !== 2) fail('MARKET_PRICE_UNREADABLE');
        return { listingid: match[2], appid: match[3], observed_contextid: match[4], assetid: match[5],
            buyerCents: amounts[0], receiveCents: amounts[1], url: row.links.find(a => a.href?.startsWith('https://steamcommunity.com/market/listings/'))?.href,
            state: match[1] === 'CancelMarketListingConfirmation' ? 'PENDING_MOBILE_CONFIRMATION' : row.holdUntil ? 'CONFIRMED_MARKET_HOLD' : 'ACTIVE',
            holdUntil: row.holdUntil || null };
    });
    return { account: snapshot.account?.trim(), rows };
}
function parseCompleteMarketSnapshot(snapshot) {
    // Only visible rows are read. A paginated/truncated page cannot prove absence.
    if (!snapshot.account || !snapshot.listPresent || !Number.isSafeInteger(snapshot.activeTotal) || snapshot.activeTotal < 0) fail('MARKET_INCOMPLETE');
    const market = parseMarketRows(snapshot);
    const heldTotal = snapshot.heldTotal ?? 0;
    if (!Number.isSafeInteger(heldTotal) || heldTotal < 0) fail('MARKET_INCOMPLETE');
    if (market.rows.filter(r => r.state === 'ACTIVE').length !== snapshot.activeTotal ||
        market.rows.filter(r => r.state === 'CONFIRMED_MARKET_HOLD').length !== heldTotal) fail('MARKET_PAGINATED', '出售或暂挂分区未完整显示；先调整可见分页，再只读核对。');
    return market;
}
function parseHelperSnapshot(snapshot, inventoryProfileUrl, previousGeneration = null) {
    const data = snapshot.data, normalized = value => {
        const url = new URL(value);
        return url.origin + url.pathname.replace(/\/$/, '');
    };
    if (snapshot.schema !== String(HELPER_SCHEMA) || data?.schema !== HELPER_SCHEMA ||
        data.helperVersion !== HELPER_VERSION || data.mode !== 'READ_ONLY') fail('READ_ONLY_HELPER_UPDATE_REQUIRED');
    if (!data.account || snapshot.account !== data.account) fail('INVENTORY_ACCOUNT_MISMATCH');
    if (normalized(snapshot.url) !== normalized(inventoryProfileUrl) ||
        normalized(data.inventoryProfileUrl) !== normalized(inventoryProfileUrl)) fail('INVENTORY_PROFILE_MISMATCH');
    if (data.appid !== '753' || data.contextid !== '6') fail('INVENTORY_CONTEXT_MISMATCH');
    if (data.currency !== 23) fail('UNSUPPORTED_CURRENCY');
    const scan = data.scan;
    if (data.busy !== false || scan?.complete !== true || scan.status !== 'COMPLETE' || scan.error !== null ||
        typeof scan.generation !== 'string' || !scan.generation || scan.generation === previousGeneration ||
        !Number.isFinite(Date.parse(scan.startedAt)) || !Number.isFinite(Date.parse(scan.completedAt)) ||
        Date.parse(scan.completedAt) < Date.parse(scan.startedAt) || !Array.isArray(data.assets)) fail('INVENTORY_INCOMPLETE');
    const seen = new Set();
    const rows = data.assets.map(row => {
        if (typeof row.assetid !== 'string' || !/^\d+$/.test(row.assetid) || seen.has(row.assetid) || row.appid !== '753' || row.contextid !== '6' ||
            !/^\d+-.+/.test(row.market_hash_name) || typeof row.marketable !== 'boolean' || typeof row.tradable !== 'boolean') fail('INVENTORY_INCOMPLETE');
        seen.add(row.assetid);
        if (!HELPER_STATES.has(row.state) || typeof row.locked !== 'boolean' ||
            row.locked && (typeof row.lockReason !== 'string' || !row.lockReason) ||
            !row.locked && (row.lockReason !== null || HELPER_LOCKED_STATES.has(row.state) || !row.marketable || !row.tradable)) fail('HELPER_LOCK_UNPROVEN');
        return { assetid: row.assetid, hash: row.market_hash_name, state: row.state,
            locked: row.locked, lockReason: row.lockReason, pending: row.state === 'EXTERNAL_PENDING',
            eligible: row.marketable && row.tradable && !row.locked };
    });
    rows.account = data.account; rows.scanGeneration = scan.generation;
    return rows;
}
function observeBatch(batch, market, inventory) {
    const exact = new Set(batch.submissionAssetids);
    if (exact.size !== batch.quantity || inventory.length !== new Set(inventory.map(r => r.assetid)).size) fail('ASSET_COUNT_MISMATCH');
    const observed = market.rows.filter(r => r.appid === '753' && exact.has(r.assetid));
    if (observed.length !== exact.size) fail('ACCEPTANCE_UNPROVEN', '市场未显示全部提交资产；锁定并停止，禁止重提。');
    const hash = batch.key.slice('753|6|'.length);
    if (observed.some(r => {
        try {
            const url = new URL(r.url);
            const path = url.pathname.match(/^\/market\/listings\/753\/([^/]+)\/?$/);
            return url.origin !== 'https://steamcommunity.com' || !path || decodeURIComponent(path[1]) !== hash;
        } catch (_) { return true; }
    })) fail('MARKET_ITEM_MISMATCH');
    if (observed.some(r => r.buyerCents !== batch.buyerCents || r.receiveCents !== batch.receiveCents)) fail('MARKET_PRICE_MISMATCH');
    const states = new Set(observed.map(r => r.state));
    const inInventory = inventory.filter(r => exact.has(r.assetid));
    for (const row of observed) {
        const present = inInventory.find(r => r.assetid === row.assetid);
        if (row.state === 'PENDING_MOBILE_CONFIRMATION') {
            if (!present?.pending) fail('PENDING_LOCK_MISMATCH');
        } else if (present) fail('INVENTORY_STALE', '已确认资产仍在库存；保持锁定，等待再次对账。');
    }
    return { state: states.size === 1 ? observed[0].state : 'CONFIRMED_MIXED', submissions: observed };
}
function compactSummary(ledger, current = null, error = null, approved = null) {
    const batches = ledger.batches || [], observed = batches.flatMap(b => b.submissions || []);
    const states = observed.reduce((counts, r) => { counts[r.state] = (counts[r.state] || 0) + 1; return counts; }, {});
    const finishedKeys = new Set(batches.filter(b => DONE.has(b.state) || b.state === 'CONFIRMED_MIXED').map(b => b.key));
    const plan = approved || validatePlan(ledger);
    return { account: plan.account, planned: plan.groups.reduce((sum, g) => sum + g.rows.length, 0), submitted: observed.length,
        pending: states.PENDING_MOBILE_CONFIRMATION || 0, held: states.CONFIRMED_MARKET_HOLD || 0, active: states.ACTIVE || 0,
        remaining: plan.groups.filter(g => !finishedKeys.has(g.key)).reduce((sum, g) => sum + g.rows.length, 0),
        buyerTotalCents: plan.buyerTotal, receiveTotalCents: plan.receiveTotal,
        current: current ? { name: current.name, quantity: current.quantity, state: current.state } : null,
        phase: ledger.execution?.phase || null,
        halted: Boolean(error), error: error ? { code: error.code || 'UNEXPECTED', message: error.message.slice(0, 180) } : null };
}

function makeNativeIO({ market, inventory, sell, inventoryProfileUrl }) {
    const handles = [market, inventory, sell].filter(Boolean);
    if (new Set(handles).size !== handles.length) fail('SEPARATE_TABS_REQUIRED');
    let inventoryGeneration = null;
    // A single DOM observation collects every field; evaluate never clicks or fills.
    const readNative = () => sell.playwright.evaluate(() => ({
        account: document.querySelector('#account_pulldown')?.innerText.trim(), url: document.URL,
        terms: document.querySelector('#market_multi_accept_ssa')?.checked === true,
        total: document.querySelector('#market_multisell_total')?.innerText || '',
        submitControl: Array.from(document.querySelectorAll('a')).some(a => a.innerText.trim() === '创建上架物品'),
        rows: Array.from(document.querySelectorAll('a[href*="/market/listings/753/"]')).filter(a => a.closest('tr')?.querySelector('input[type="number"]')).map(a => {
            const row = a.closest('tr'), match = new URL(a.href).pathname.match(/^\/market\/listings\/753\/([^/]+)\/?$/);
            const available = row.innerText.match(/共\s*(\d+)\s*个/);
            return { hash: match ? decodeURIComponent(match[1]) : null,
                quantity: Number(row.querySelector('input[type="number"]')?.value), available: available ? Number(available[1]) : null,
                prices: Array.from(row.querySelectorAll('input[type="text"]')).map(e => e.value) };
        }),
    }));
    return {
        async readMarket() {
            await market.reload();
            const snapshot = await market.playwright.evaluate(() => ({
                account: document.querySelector('#account_pulldown')?.innerText,
                listPresent: Boolean(document.querySelector('#tabContentsMyActiveMarketListingsTable')),
                activeTotal: (() => {
                    const text = document.querySelector('#my_market_selllistings_pagingtotal')?.innerText || document.querySelector('#my_market_selllistings_number')?.innerText || '';
                    const match = text.replace(/[,，\s]/g, '').match(/^\(?(\d+)\)?$/);
                    return match ? Number(match[1]) : null;
                })(),
                heldTotal: (() => {
                    const node = document.querySelector('#my_market_listingsonhold_number');
                    if (!node) return 0;
                    const text = node.innerText.replace(/[,，\s]/g, '');
                    return /^\d+$/.test(text) ? Number(text) : null;
                })(),
                rows: Array.from(document.querySelectorAll('#tabContentsMyListings .market_listing_row')).filter(r => r.id.startsWith('mylisting_')).map(r => ({
                    text: r.innerText,
                    links: Array.from(r.querySelectorAll('a')).map(a => ({ text: a.innerText, href: a.getAttribute('href') })),
                    holdUntil: Array.from(r.querySelectorAll('.market_listing_listed_date_combined')).find(e => /暂挂到|hold until/i.test(e.innerText))?.innerText.trim() || null,
                })),
            }));
            return parseCompleteMarketSnapshot(snapshot);
        },
        async readInventory() {
            let expected;
            try {
                expected = new URL(inventoryProfileUrl);
                if (expected.origin !== 'https://steamcommunity.com' || !/^\/(?:id|profiles)\/[^/]+\/inventory\/?$/.test(expected.pathname)) fail('OWNED_INVENTORY_URL_REQUIRED');
            } catch (_) { fail('OWNED_INVENTORY_URL_REQUIRED'); }
            const actual = new URL(await inventory.url());
            if (actual.origin !== expected.origin || actual.pathname.replace(/\/$/, '') !== expected.pathname.replace(/\/$/, '')) fail('INVENTORY_PROFILE_MISMATCH');
            // LoadCompleteInventory on an already loaded page reuses old assets.
            // A real reload is necessary after removal or mobile confirmation.
            await inventory.reload();
            const scan = inventory.playwright.getByRole('button', { name: '1. 只读盘点', exact: true });
            await scan.click();
            await inventory.playwright.locator('#scbl-scan:not([disabled])').waitFor({ state: 'attached', timeoutMs: 15000 });
            const snapshot = await inventory.playwright.evaluate(() => {
                const root = document.querySelector('#codex-steam-card-listing-panel')?.shadowRoot;
                return { schema: document.querySelector('#codex-steam-card-listing-panel')?.getAttribute('data-audit-schema'),
                    account: document.querySelector('#account_pulldown')?.innerText?.trim(),
                    url: document.URL,
                    data: JSON.parse(root?.querySelector('#scbl-agent-summary')?.textContent || '{}') };
            });
            const rows = parseHelperSnapshot(snapshot, inventoryProfileUrl, inventoryGeneration);
            inventoryGeneration = rows.scanGeneration;
            return rows;
        },
        async cancel(row) {
            const old = market.playwright.locator('#mylisting_' + row.listingid);
            const link = old.getByRole('link', { name: '撤下', exact: true });
            const href = await link.getAttribute('href');
            const match = href?.match(/RemoveMarketListing\('mylisting',\s*'(\d+)',\s*(\d+),\s*'(\d+)',\s*'(\d+)'\)/);
            if (!['6', '16'].includes(row.observed_contextid) || !match || match[1] !== row.listingid || match[2] !== row.appid ||
                match[3] !== row.observed_contextid || match[4] !== row.assetid) fail('CANCEL_IDENTITY_MISMATCH');
            await link.click();
            const yes = market.playwright.getByText('是的，移除此上架物品', { exact: true });
            await yes.click();
            await old.waitFor({ state: 'hidden', timeoutMs: 15000 });
        },
        async preflightNative(groups, account) {
            const batches = groups.map(() => ({ account, quantity: 0 }));
            await sell.goto(buildNativeBatchUrl(groups.map(group => ({ hash: group.hash, quantity: 0 }))));
            const snapshot = await readNative();
            verifyNativeSnapshot(snapshot, groups, batches, false, true);
            if (!snapshot.submitControl || snapshot.rows.some(row => row.prices.length !== 2)) fail('NATIVE_PREFLIGHT_REQUIRED');
            return { account, hashes: groups.map(group => group.hash) };
        },
        async prepare(group, batch) {
            await sell.goto(buildNativeUrl(group.hash, batch.quantity));
            verifyNativeSnapshot(await readNative(), [group], [batch], false);
            const row = sell.playwright.getByRole('row').filter({ has: sell.playwright.locator('a[href="' + group.url + '"]') });
            const buyerInput = row.getByRole('textbox').nth(1);
            await buyerInput.fill(money(batch.buyerCents));
            await buyerInput.press('Tab');
            return verifyNativeSnapshot(await readNative(), [group], [batch])[0];
        },
        async openNative(groups, batches) {
            await sell.goto(buildNativeBatchUrl(groups.map((g, i) => ({ hash: g.hash, quantity: batches[i].quantity }))));
            verifyNativeSnapshot(await readNative(), groups, batches, false);
        },
        async priceNative(group, batch) {
            // Immutable explicit group parameters; no captured mutable "current row".
            const row = sell.playwright.getByRole('row').filter({ has: sell.playwright.locator('a[href="' + group.url + '"]') });
            const input = row.getByRole('textbox').nth(1);
            await input.fill(money(batch.buyerCents)); await input.press('Tab');
        },
        async verifyNative(groups, batches) { return verifyNativeSnapshot(await readNative(), groups, batches); },
        async clickSubmit() { await sell.playwright.getByRole('link', { name: '创建上架物品', exact: true }).click(); },
        async readResult() { return await sell.playwright.getByRole('dialog').innerText(); },
        async submit() {
            await sell.playwright.getByRole('link', { name: '创建上架物品', exact: true }).click();
            const dialog = sell.playwright.getByRole('dialog');
            await dialog.waitFor({ state: 'visible', timeoutMs: 15000 });
            return await dialog.innerText();
        },
        async dismissResult() {
            const dialog = sell.playwright.getByRole('dialog');
            if (await dialog.isVisible()) await dialog.getByText('确定', { exact: true }).click();
        },
    };
}

function createRunner({ ledger, tabs, io = tabs && makeNativeIO({ ...tabs, inventoryProfileUrl: ledger.inventoryProfileUrl }), persist,
    approvedPlan = false, collectMobileConfirmations = false, batchGroups = false, jobKey = ledger }) {
    if (!approvedPlan) fail('EXPLICIT_PLAN_APPROVAL_REQUIRED');
    if (!io || typeof persist !== 'function') fail('DURABLE_STATE_REQUIRED');
    const plan = validatePlan(ledger);
    const summarize = (current = null, error = null) => compactSummary(ledger, current, error, plan);
    const stagedNative = ['openNative', 'priceNative', 'verifyNative', 'clickSubmit'].every(key => typeof io[key] === 'function');
    if (batchGroups && (!collectMobileConfirmations || !stagedNative)) fail('BATCH_READINESS_REQUIRED');
    const fingerprint = () => JSON.stringify({ account: ledger.account,
        totals: [ledger.approvedBuyerTotalCents, ledger.approvedReceiveTotalCents],
        rows: ledger.rows.map(r => [r.listingid, r.appid, r.submission_contextid, r.assetid, r.url, r.proposedBuyerCents, r.nativeReceiveCents, r.nativeFeeCents]) });
    const approvedFingerprint = fingerprint();
    ledger.batches ||= [];
    let busy = false, paused = false;
    const save = () => persist(ledger);
    const finished = batch => batch && (DONE.has(batch.state) || batch.state === 'CONFIRMED_MIXED');
    // Both readers finish before a failed checkpoint releases the queue lock.
    async function checkpoint() {
        const results = await Promise.allSettled([Promise.resolve().then(() => io.readMarket()), Promise.resolve().then(() => io.readInventory())]);
        const failed = results.find(r => r.status === 'rejected');
        if (failed) throw failed.reason;
        const market = results[0].value, inventory = results[1].value;
        if (market.account !== plan.account) fail('ACCOUNT_MISMATCH');
        if (inventory.account !== plan.account) fail('INVENTORY_ACCOUNT_MISMATCH');
        return { market, inventory };
    }
    function lockedBatches(groups) {
        return groups.map(group => {
            const batch = ledger.batches.find(b => b.key === group.key);
            if (batch && (batch.quantity !== group.rows.length || batch.buyerCents !== group.buyerCents || batch.receiveCents !== group.receiveCents ||
                batch.account !== plan.account || batch.submissionContextid !== '6' ||
                JSON.stringify(batch.oldAssetids) !== JSON.stringify(group.rows.map(r => r.assetid)) ||
                JSON.stringify(batch.oldListingids) !== JSON.stringify(group.rows.map(r => r.listingid)))) fail('BATCH_LOCK_MISMATCH');
            return batch;
        });
    }
    const cohortFingerprint = batches => JSON.stringify(batches.map(b => [b.key, b.submissionAssetids]));
    function guardAction(groups, batches) {
        if (fingerprint() !== approvedFingerprint) fail('APPROVED_PLAN_CHANGED');
        lockedBatches(groups);
        if (ledger.execution?.cohortFingerprint && ledger.execution.cohortFingerprint !== cohortFingerprint(batches)) fail('EXECUTION_LOCK_MISMATCH');
    }
    const checkNative = (checks, batches) => {
        if (!Array.isArray(checks) || checks.length !== batches.length) fail('NATIVE_PRICE_OR_QUANTITY_MISMATCH');
        checks.forEach((check, i) => {
            const b = batches[i];
            if (check.buyerCents !== b.buyerCents || check.receiveCents !== b.receiveCents || check.quantity !== b.quantity ||
                check.receiveTotalCents !== b.quantity * b.receiveCents) fail('NATIVE_PRICE_OR_QUANTITY_MISMATCH');
            b.nativeVerified = check;
        });
    };
    function returned(groups, batches, market, inventory) {
        groups.forEach((g, i) => {
            const b = batches[i], cohort = inventory.filter(r => r.hash === g.hash);
            if (market.rows.some(r => b.oldListingids.includes(r.listingid)) || cohort.length !== b.quantity ||
                cohort.some(r => !r.eligible || r.locked !== false || r.pending || !HELPER_STATES.has(r.state) || b.beforeAssetIds.includes(r.assetid)) ||
                new Set(cohort.map(r => r.assetid)).size !== b.quantity ||
                market.rows.some(r => r.appid === '753' && cohort.some(a => a.assetid === r.assetid))) fail('RETURNED_COHORT_MISMATCH');
            if (b.submissionAssetids.length && (b.submissionAssetids.length !== b.quantity || cohort.some(r => !b.submissionAssetids.includes(r.assetid)))) fail('RETURNED_COHORT_MISMATCH');
            b.submissionAssetids = cohort.map(r => r.assetid);
            b.lineageEvidence = '本组撤单前库存为0；旧挂单全部消失；完整新库存仅有批准数量的可售同名返回资产。';
            b.state = 'RETURNED_VERIFIED';
        });
    }
    function current(groups, batches) {
        return batches.length === 1 ? batches[0] : { name: groups.length + ' approved groups',
            quantity: batches.reduce((sum, b) => sum + (b?.quantity || 0), 0), state: ledger.execution?.phase };
    }
    async function step() {
        let groups = [], batches = [], operation = 'read', acting = null;
        try {
            if (paused) fail('PAUSED');
            if (ledger.pauseReason) fail('SYSTEM_PAUSED', ledger.pauseReason);
            if (fingerprint() !== approvedFingerprint) fail('APPROVED_PLAN_CHANGED');
            let execution = ledger.execution;
            if (ledger.batches.some(b => UNSAFE.has(b.state) && !(b.state === 'SUBMITTING_NATIVE' && execution?.phase === 'RECONCILE'))) fail('LOCKED_OUTCOME');
            if (!execution || execution.phase === 'DONE') {
                if (!collectMobileConfirmations && ledger.batches.some(b => b.state === 'PENDING_MOBILE_CONFIRMATION' || b.submissions?.some(r => r.state === 'PENDING_MOBILE_CONFIRMATION'))) fail('MOBILE_CONFIRMATION_REQUIRED');
                const remaining = plan.groups.filter(g => !finished(ledger.batches.find(b => b.key === g.key)));
                if (!remaining.length) return summarize();
                groups = batchGroups ? remaining : remaining.slice(0, 1);
                execution = ledger.execution = { phase: 'PREFLIGHT', keys: groups.map(g => g.key), priceIndex: 0, fingerprint: approvedFingerprint };
                await save();
            } else {
                if (execution.fingerprint !== approvedFingerprint || !Array.isArray(execution.keys) ||
                    !execution.keys.length || new Set(execution.keys).size !== execution.keys.length) fail('EXECUTION_LOCK_MISMATCH');
                groups = execution.keys.map(key => plan.groups.find(g => g.key === key));
                if (groups.some(g => !g) || groups.length > 1 && (!batchGroups || !collectMobileConfirmations || !stagedNative)) fail('EXECUTION_LOCK_MISMATCH');
            }
            batches = lockedBatches(groups);
            guardAction(groups, batches);
            if (execution.phase === 'PREFLIGHT') {
                if (typeof io.preflightNative !== 'function') fail('NATIVE_PREFLIGHT_REQUIRED');
                const proof = await io.preflightNative(groups, plan.account);
                guardAction(groups, batches);
                if (proof?.account !== plan.account || JSON.stringify(proof.hashes) !== JSON.stringify(groups.map(g => g.hash))) fail('NATIVE_PREFLIGHT_REQUIRED');
                execution.nativePreflight = { ...proof, schema: 1 };
                execution.phase = 'CHECK_BEFORE'; await save();
            } else if (execution.phase === 'CHECK_BEFORE') {
                if (execution.nativePreflight?.schema !== 1) fail('NATIVE_PREFLIGHT_REQUIRED');
                const { market, inventory } = await checkpoint();
                // Validate the entire cohort before creating cancellation state.
                groups.forEach((g, i) => {
                    if (batches[i]) {
                        if (!['RETURNED_VERIFIED', 'READY_NATIVE', 'READ_ONLY_BLOCKED'].includes(batches[i].state) ||
                            batches[i].submissionAssetids.length !== batches[i].quantity) fail('MANUAL_RECONCILIATION_REQUIRED');
                        return;
                    }
                    if (inventory.some(r => r.hash === g.hash)) fail('UNAPPROVED_SAME_NAME_COPIES');
                    for (const source of g.rows) {
                        const active = market.rows.find(r => r.listingid === source.listingid);
                        if (source.state !== 'APPROVED_ACTIVE' || !active || active.state !== 'ACTIVE' || active.assetid !== source.assetid ||
                            active.appid !== source.appid || !['6', '16'].includes(active.observed_contextid) || active.url !== source.url) fail('SOURCE_NOT_APPROVED_ACTIVE');
                        source.observed_contextid = active.observed_contextid;
                    }
                });
                groups.forEach((g, i) => {
                    if (batches[i]) return;
                    const b = { key: g.key, account: plan.account, name: g.name, quantity: g.rows.length, buyerCents: g.buyerCents, receiveCents: g.receiveCents,
                        oldListingids: g.rows.map(r => r.listingid), oldAssetids: g.rows.map(r => r.assetid), submissionContextid: '6',
                        beforeAssetIds: inventory.map(r => r.assetid), submissionAssetids: [], state: 'CANCELLING' };
                    ledger.batches.push(b); batches[i] = b;
                });
                const existing = batches.filter(b => b.submissionAssetids.length);
                if (existing.length) {
                    if (existing.length !== batches.length || existing.some(b => !['RETURNED_VERIFIED', 'READY_NATIVE', 'READ_ONLY_BLOCKED'].includes(b.state))) fail('MANUAL_RECONCILIATION_REQUIRED');
                    returned(groups, batches, market, inventory); execution.cohortFingerprint = cohortFingerprint(batches); execution.phase = 'NATIVE_OPEN';
                } else execution.phase = 'CANCEL';
                await save();
            } else if (execution.phase === 'CANCEL') {
                if (execution.nativePreflight?.schema !== 1 || execution.nativePreflight.account !== plan.account ||
                    JSON.stringify(execution.nativePreflight.hashes) !== JSON.stringify(groups.map(g => g.hash))) fail('NATIVE_PREFLIGHT_REQUIRED');
                const group = groups.find(g => g.rows.some(r => r.state !== 'CANCELLED_INVENTORY_PENDING'));
                if (!group) fail('EXECUTION_LOCK_MISMATCH');
                const row = group.rows.find(r => r.state !== 'CANCELLED_INVENTORY_PENDING');
                acting = batches[groups.indexOf(group)];
                const identity = Object.freeze({ ...row });
                operation = 'cancel'; acting.state = 'CANCEL_REQUESTED'; row.state = 'CANCEL_REQUESTED'; await save();
                // Fresh immutable identity for this click, never a mutable cross-cell locator.
                guardAction(groups, batches); await io.cancel(identity);
                row.state = 'CANCELLED_INVENTORY_PENDING'; acting.state = 'AWAITING_RETURN'; operation = 'read';
                if (groups.every(g => g.rows.every(r => r.state === 'CANCELLED_INVENTORY_PENDING'))) execution.phase = 'CHECK_RETURNED';
                await save();
            } else if (execution.phase === 'CHECK_RETURNED') {
                const { market, inventory } = await checkpoint();
                returned(groups, batches, market, inventory); execution.cohortFingerprint = cohortFingerprint(batches); execution.phase = 'NATIVE_OPEN'; await save();
            } else if (execution.phase === 'NATIVE_OPEN') {
                if (stagedNative) await io.openNative(groups, batches);
                else {
                    if (groups.length !== 1) fail('BATCH_READINESS_REQUIRED');
                    checkNative([await io.prepare(groups[0], batches[0])], batches);
                }
                execution.priceIndex = 0; execution.phase = stagedNative ? 'NATIVE_PRICE' : 'SUBMIT'; await save();
            } else if (execution.phase === 'NATIVE_PRICE') {
                const i = execution.priceIndex;
                if (!Number.isInteger(i) || !groups[i]) fail('EXECUTION_LOCK_MISMATCH');
                await io.priceNative(Object.freeze({ ...groups[i] }), Object.freeze({ ...batches[i] }));
                execution.priceIndex++;
                if (execution.priceIndex === groups.length) execution.phase = 'SUBMIT';
                await save();
            } else if (execution.phase === 'SUBMIT') {
                // Re-read all native fields immediately before the sole transaction click.
                if (stagedNative) checkNative(await io.verifyNative(groups, batches), batches);
                else checkNative([await io.prepare(groups[0], batches[0])], batches);
                guardAction(groups, batches);
                batches.forEach(b => { b.state = 'SUBMITTING_NATIVE'; });
                execution.phase = 'RECONCILE'; operation = 'submit'; await save();
                guardAction(groups, batches);
                try {
                    if (stagedNative) await io.clickSubmit();
                    else execution.nativeResult = await io.submit(groups[0], batches[0]);
                } catch (error) { execution.provisionalUiError = error.message.slice(0, 180); }
                // A failed/late click is never retried; the next step is read-only.
                operation = 'read'; await save();
            } else if (execution.phase === 'RECONCILE') {
                const reads = await Promise.allSettled([checkpoint(), Promise.resolve().then(() => io.readResult ? io.readResult() : execution.nativeResult || '')]);
                if (reads[0].status === 'rejected') throw reads[0].reason;
                if (reads[1].status === 'fulfilled') execution.nativeResult = reads[1].value;
                const { market, inventory } = reads[0].value;
                for (const b of batches) Object.assign(b, observeBatch(b, market, inventory));
                groups.forEach((g, i) => g.rows.forEach(r => { r.state = batches[i].state; }));
                if (execution.provisionalUiError) batches.forEach(b => { b.provisionalUiError = execution.provisionalUiError; });
                execution.phase = 'DONE'; await save();
                if (/too many.*pending|待确认.*(?:过多|上限)|rate.?limit|too many requests|会话|重新登录|sign.?in|session error|HTTP\s*(?:401|403|429)/i.test(String(execution.nativeResult || '') + ' ' + (execution.provisionalUiError || ''))) {
                    ledger.pauseReason = 'Steam 显示限流、会话或确认数量异常；已接受资产保持锁定，队列停止，先只读核对。';
                    await save(); fail('STEAM_SYSTEM_ERROR', ledger.pauseReason);
                }
                if (io.dismissResult) {
                    try { await io.dismissResult(); } catch (error) { execution.dismissError = error.message.slice(0, 180); await save(); }
                }
            } else fail('LOCKED_OUTCOME');
            return summarize(current(groups, batches));
        } catch (error) {
            paused = true;
            for (const b of batches.filter(Boolean)) {
                if (operation === 'cancel' && b === acting || operation === 'submit') b.state = 'OUTCOME_UNKNOWN';
                else if (b.state === 'SUBMITTING_NATIVE') b.state = 'OUTCOME_UNKNOWN';
                else if (!finished(b) && b !== acting) b.state = 'READ_ONLY_BLOCKED';
                b.lastError = { code: error.code || 'UI_ERROR', message: error.message.slice(0, 180), operation };
            }
            try { await save(); } catch (_) { /* Preserve the last durable in-flight lock. */ }
            return summarize(batches.filter(Boolean).length ? current(groups, batches.filter(Boolean)) : null, error);
        }
    }
    async function runStep() {
        if (busy || IN_FLIGHT_JOBS.has(jobKey)) fail('CONCURRENT_RUN');
        busy = true; IN_FLIGHT_JOBS.add(jobKey);
        try { return await step(); } finally { busy = false; IN_FLIGHT_JOBS.delete(jobKey); }
    }
    async function runNext() {
        // Compatibility for fast/mock IO only. Native callers should use runStep.
        if (busy || IN_FLIGHT_JOBS.has(jobKey)) fail('CONCURRENT_RUN');
        busy = true; IN_FLIGHT_JOBS.add(jobKey);
        try {
            const limit = ledger.rows.length + plan.groups.length + 8;
            for (let i = 0; i < limit; i++) {
                const result = await step();
                if (result.halted || !result.remaining || ledger.execution?.phase === 'DONE') return result;
            }
            fail('STEP_LIMIT');
        } finally { busy = false; IN_FLIGHT_JOBS.delete(jobKey); }
    }
    async function reconcile() {
        if (busy || IN_FLIGHT_JOBS.has(jobKey)) fail('CONCURRENT_RUN');
        busy = true; IN_FLIGHT_JOBS.add(jobKey);
        try {
            const { market, inventory } = await checkpoint();
            for (const b of ledger.batches) {
                if (!b.submissionAssetids?.length) continue;
                try { Object.assign(b, observeBatch(b, market, inventory)); }
                catch (error) { b.state = 'RECONCILE_PENDING'; b.lastError = { code: error.code || 'UI_ERROR', message: error.message.slice(0, 180) }; }
                plan.groups.find(g => g.key === b.key)?.rows.forEach(r => { r.state = b.state; });
            }
            const unresolved = ledger.batches.find(b => UNSAFE.has(b.state));
            if (ledger.execution && !unresolved && ledger.execution.keys.every(key => finished(ledger.batches.find(b => b.key === key)))) ledger.execution.phase = 'DONE';
            await save();
            return summarize(unresolved || null, unresolved ? Object.assign(new Error('仍有资产需要核对，保持锁定。'), { code: 'RECONCILE_PENDING' }) : null);
        } finally { busy = false; IN_FLIGHT_JOBS.delete(jobKey); }
    }
    return { runStep, runNext, reconcile, summary: () => summarize(),
        async resumeReadOnly() {
            if (busy || ledger.batches.some(b => UNSAFE.has(b.state))) fail('LOCKED_OUTCOME');
            if (ledger.execution && ['NATIVE_PRICE', 'SUBMIT'].includes(ledger.execution.phase)) {
                ledger.execution.phase = 'NATIVE_OPEN'; ledger.execution.priceIndex = 0;
            }
            delete ledger.pauseReason; await save(); paused = false;
        } };
}
module.exports = { createRunner, makeNativeIO, validatePlan, buildNativeUrl, buildNativeBatchUrl, verifyNativeSnapshot,
    parseMarketRows, parseCompleteMarketSnapshot, parseHelperSnapshot, observeBatch, compactSummary };
