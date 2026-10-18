// ==UserScript==
// @name         Steam 卡牌批量上架助手（本地审计版）
// @namespace    codex.local.steam-card-listing
// @version      0.3.1
// @description  只读盘点、取价、DOM 审计元数据与精简摘要；真实提交由原生页面流程处理。
// @match        https://steamcommunity.com/id/*/inventory*
// @match        https://steamcommunity.com/profiles/*/inventory*
// @grant        none
// @run-at       document-idle
// @license      MIT
// ==/UserScript==

(function () {
    'use strict';

    const APP_ID = '753';
    const DEFAULT_CONTEXT_ID = '6';
    const LEDGER_KEY = 'codex.steamCardListing.ledger.v1';
    const PRICE_CACHE_KEY = 'codex.steamCardListing.priceCache.v1';
    const PANEL_ID = 'codex-steam-card-listing-panel';
    const CACHE_TTL_MS = 10 * 60 * 1000;
    const DEFAULT_BATCH_SIZE = 20;
    const DELAY_MIN_MS = 800;
    const DELAY_MAX_MS = 1500;
    const PRICE_DELAY_MIN_MS = 650;
    const PRICE_DELAY_MAX_MS = 1000;
    const READ_REQUEST_TIMEOUT_MS = 15 * 1000;
    const SELL_REQUEST_TIMEOUT_MS = 20 * 1000;
    const MAX_ATTEMPTS = 3;
    const MAX_ITEMS_GUARD = 250;
    const MAX_RECEIVE_PER_ITEM_CENTS = 10000;
    const MAX_RECEIVE_TOTAL_CENTS = 100000;

    const STATES = Object.freeze({
        DISCOVERED: 'DISCOVERED',
        PLANNED: 'PLANNED',
        PRICE_ERROR: 'PRICE_ERROR',
        SUBMITTING: 'SUBMITTING',
        SUBMITTED: 'SUBMITTED',
        EXTERNAL_PENDING: 'EXTERNAL_PENDING',
        PAUSED_CONFIRMATIONS: 'PAUSED_CONFIRMATIONS',
        RECONCILE_PENDING: 'RECONCILE_PENDING',
        OUTCOME_UNKNOWN: 'OUTCOME_UNKNOWN',
        RETRYABLE_ERROR: 'RETRYABLE_ERROR',
        QUARANTINED: 'QUARANTINED',
        ACTIVE: 'ACTIVE',
    });

    const TEST_MODE = Boolean(globalThis.__STEAM_CARD_LISTING_TEST__);
    const runtime = {
        running: false,
        pauseRequested: false,
        confirming: false,
        panel: null,
        shadow: null,
        logLines: [],
    };

    function nowIso() {
        return new Date().toISOString();
    }

    function sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    function randomInt(min, max) {
        return Math.floor(Math.random() * (max - min + 1)) + min;
    }

    function withTimeout(promise, timeoutMs, label) {
        let timeout;
        return Promise.race([
            Promise.resolve(promise),
            new Promise((_, reject) => {
                timeout = setTimeout(() => reject(new Error(`${label}超过 ${Math.round(timeoutMs / 1000)} 秒，已安全停止。`)), timeoutMs);
            }),
        ]).finally(() => clearTimeout(timeout));
    }

    async function fetchReadOnly(url, options = {}, label = '只读请求') {
        if (options.method && options.method.toUpperCase() !== 'GET') throw new Error('只读助手仅允许 GET。');
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), READ_REQUEST_TIMEOUT_MS);
        try {
            return await fetch(url, { ...options, signal: controller.signal });
        } catch (error) {
            if (error?.name === 'AbortError') {
                throw new Error(`${label}超过 ${Math.round(READ_REQUEST_TIMEOUT_MS / 1000)} 秒，已安全停止。`);
            }
            throw error;
        } finally {
            clearTimeout(timeout);
        }
    }

    function toPositiveInt(value, fallback = 0) {
        const parsed = Number.parseInt(String(value), 10);
        return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
    }

    function escapeHtml(value) {
        return String(value ?? '')
            .replaceAll('&', '&amp;')
            .replaceAll('<', '&lt;')
            .replaceAll('>', '&gt;')
            .replaceAll('"', '&quot;')
            .replaceAll("'", '&#039;');
    }

    function parsePriceToCents(priceText) {
        if (!priceText) return 0;
        const match = String(priceText).match(/([\d.,]+)/);
        if (!match) return 0;
        let numberText = match[1];
        if (numberText.lastIndexOf('.') < numberText.lastIndexOf(',')) {
            numberText = numberText.replace(/\./g, '').replace(',', '.');
        } else {
            numberText = numberText.replace(/,/g, '');
        }
        const value = Number.parseFloat(numberText);
        return Number.isFinite(value) ? Math.round(value * 100) : 0;
    }

    function getWalletInfo() {
        const info = globalThis.g_rgWalletInfo || {};
        return {
            wallet_currency: toPositiveInt(info.wallet_currency, 23),
            wallet_fee: Number(info.wallet_fee ?? 1),
            wallet_fee_percent: Number.parseFloat(info.wallet_fee_percent ?? 0.05),
            wallet_fee_minimum: toPositiveInt(info.wallet_fee_minimum, 1),
            wallet_fee_base: Number.parseInt(info.wallet_fee_base ?? 0, 10) || 0,
            publisher_fee_default: Number.parseFloat(info.wallet_publisher_fee_percent_default ?? 0.10),
        };
    }

    function calculateBuyerCents(receiveCents, publisherFee) {
        const receive = Math.max(1, Math.round(receiveCents));
        const fee = Number.isFinite(publisherFee) ? publisherFee : getWalletInfo().publisher_fee_default;

        if (typeof globalThis.CalculateAmountToSendForDesiredReceivedAmount === 'function') {
            try {
                const result = globalThis.CalculateAmountToSendForDesiredReceivedAmount(receive, fee);
                if (result && Number.isFinite(Number(result.amount))) return Number(result.amount);
            } catch (_) {}
        }

        throw new Error('Steam 原生费用计算器不可用；停止费用预演。');
    }

    function calculateReceiveCents(buyerCents, publisherFee) {
        const buyer = Math.max(1, Math.round(buyerCents));
        let best = 1;
        for (let receive = 1; receive <= buyer; receive += 1) {
            const paid = calculateBuyerCents(receive, publisherFee);
            if (paid <= buyer) best = receive;
            if (paid >= buyer) break;
        }
        return best;
    }

    function normalizeTags(tags) {
        if (Array.isArray(tags)) return tags.filter(Boolean);
        if (!tags || typeof tags !== 'object') return [];
        return Object.values(tags).flatMap(value => Array.isArray(value) ? value : [value]).filter(Boolean);
    }

    function isTradingCard(item) {
        const tags = normalizeTags(item?.tags);
        if (tags.some(tag => tag?.category === 'item_class' && tag?.internal_name === 'item_class_2')) return true;
        const type = String(item?.type || '').toLowerCase();
        return type === 'trading card' || type === '交易卡牌';
    }

    function isFoilCard(item) {
        if (!isTradingCard(item)) return false;
        const tags = normalizeTags(item?.tags);
        if (tags.some(tag => tag?.category === 'cardborder' && tag?.internal_name === 'cardborder_1')) return true;
        const type = String(item?.type || '').toLowerCase();
        return type.includes('foil') || type.includes('闪亮') || type.includes('闪箔');
    }

    function normalizeAsset(raw, fallback = {}) {
        if (!raw || typeof raw !== 'object') return null;
        const description = raw.description || raw.rgDescription || fallback.description || raw;
        const assetid = String(raw.assetid || raw.id || fallback.assetid || '');
        const appid = String(raw.appid || fallback.appid || '');
        const contextid = String(raw.contextid || fallback.contextid || DEFAULT_CONTEXT_ID);
        const marketHashName = String(
            description.market_hash_name || raw.market_hash_name || description.market_name || raw.market_name || '',
        );
        if (!assetid || !appid || !marketHashName) return null;
        return {
            assetid,
            appid,
            contextid,
            classid: String(raw.classid || description.classid || fallback.classid || ''),
            instanceid: String(raw.instanceid || description.instanceid || fallback.instanceid || '0'),
            market_hash_name: marketHashName,
            name: String(description.name || raw.name || marketHashName),
            type: String(description.type || raw.type || ''),
            marketable: Boolean(Number(description.marketable ?? raw.marketable ?? 0)),
            tradable: Boolean(Number(description.tradable ?? raw.tradable ?? 0)),
            amount: toPositiveInt(raw.amount || raw.original_amount, 1),
            market_fee: Number.parseFloat(description.market_fee ?? raw.market_fee ?? getWalletInfo().publisher_fee_default),
            tags: description.tags || raw.tags || [],
            owner_actions: description.owner_actions || raw.owner_actions || [],
        };
    }

    function promiseFromSteamDeferred(result) {
        if (!result) return Promise.resolve();
        if (typeof result.then === 'function') return Promise.resolve(result);
        if (typeof result.done === 'function') {
            return new Promise((resolve, reject) => {
                result.done(resolve);
                if (typeof result.fail === 'function') result.fail(reject);
            });
        }
        return Promise.resolve();
    }

    async function loadCompleteInventory() {
        const active = globalThis.g_ActiveInventory;
        if (!active) throw new Error('Steam 库存对象尚未加载，请刷新页面后重试。');
        const targets = [];
        if (active.m_rgChildInventories) targets.push(...Object.values(active.m_rgChildInventories));
        targets.push(active);
        const seen = new Set();
        for (const inventory of targets) {
            if (!inventory || seen.has(inventory)) continue;
            seen.add(inventory);
            if (typeof inventory.LoadCompleteInventory === 'function') {
                await withTimeout(
                    promiseFromSteamDeferred(inventory.LoadCompleteInventory()),
                    READ_REQUEST_TIMEOUT_MS,
                    '加载完整库存',
                );
            }
        }
    }

    function collectFromInventoryObjects() {
        const active = globalThis.g_ActiveInventory;
        if (!active) return [];
        const assets = [];
        const visited = new Set();

        function walk(inventory, inheritedDescriptions = {}) {
            if (!inventory || visited.has(inventory)) return;
            visited.add(inventory);
            const descriptions = {
                ...inheritedDescriptions,
                ...(inventory.m_rgDescriptions || {}),
            };
            const rawAssets = inventory.m_rgAssets || inventory.rgItems || {};
            for (const [key, raw] of Object.entries(rawAssets)) {
                if (!raw || typeof raw !== 'object') continue;
                const descKey = `${raw.classid || ''}_${raw.instanceid || '0'}`;
                const description = raw.description || raw.rgDescription || descriptions[descKey] || null;
                const normalized = normalizeAsset(
                    description ? { ...raw, description } : raw,
                    {
                        assetid: key,
                        appid: inventory.m_appid || inventory.appid || APP_ID,
                        contextid: raw.contextid || inventory.m_contextid || inventory.contextid || DEFAULT_CONTEXT_ID,
                        description,
                    },
                );
                if (normalized) assets.push(normalized);
            }
            for (const child of Object.values(inventory.m_rgChildInventories || {})) {
                walk(child, descriptions);
            }
        }

        walk(active);
        return assets;
    }

    function collectFromDom() {
        const assets = [];
        const nodes = document.querySelectorAll('.inventory_ctn .item[id]');
        for (const node of nodes) {
            const match = String(node.id || '').match(/^(\d+)_(\d+)_(\d+)$/);
            if (!match) continue;
            let raw = null;
            try {
                if (node.rgItem) raw = node.rgItem;
                else if (globalThis.$J) raw = globalThis.$J(node).data('rgItem');
                else if (globalThis.jQuery) raw = globalThis.jQuery(node).data('rgItem');
            } catch (_) {}
            const normalized = normalizeAsset(raw, {
                appid: match[1],
                contextid: match[2],
                assetid: match[3],
            });
            if (normalized) assets.push(normalized);
        }
        return assets;
    }

    function collectTradingCards() {
        const combined = [...collectFromInventoryObjects(), ...collectFromDom()];
        const byAssetId = new Map();
        for (const asset of combined) {
            if (asset.appid !== APP_ID || !asset.marketable || !isTradingCard(asset)) continue;
            if (!byAssetId.has(asset.assetid)) byAssetId.set(asset.assetid, asset);
        }
        return [...byAssetId.values()].sort((a, b) =>
            a.market_hash_name.localeCompare(b.market_hash_name) || a.assetid.localeCompare(b.assetid),
        );
    }

    function parsePendingListingConfirmations(html) {
        const pending = new Map();
        const source = String(html || '');
        const pattern = /CancelMarketListingConfirmation\(\s*['"]mylisting['"]\s*,\s*['"]([^'"]+)['"]\s*,\s*(\d+)\s*,\s*['"]([^'"]+)['"]\s*,\s*['"]([^'"]+)['"]\s*\)/g;
        let match;
        while ((match = pattern.exec(source)) !== null) {
            pending.set(String(match[4]), {
                confirmationid: String(match[1]),
                appid: String(match[2]),
                contextid: String(match[3]),
                assetid: String(match[4]),
            });
        }
        return pending;
    }

    async function fetchPendingListingConfirmations() {
        const response = await fetchReadOnly('/market/', {
            credentials: 'include',
            headers: { 'X-Requested-With': 'XMLHttpRequest' },
        }, '读取 Steam 待确认挂单');
        if (!response.ok) throw new Error(`无法读取 Steam 待确认挂单（HTTP ${response.status}）。`);
        const html = await response.text();
        if (!html.includes('my_market_selllistings') && !html.includes('CancelMarketListingConfirmation')) {
            throw new Error('Steam 市场页面结构无法识别；安全起见停止。');
        }
        return parsePendingListingConfirmations(html);
    }

    function emptyLedger() {
        return { version: 1, createdAt: nowIso(), updatedAt: nowIso(), assets: {} };
    }

    function migrateLedgerForSafety(ledger) {
        let migrated = false;
        for (const row of Object.values(ledger?.assets || {})) {
            const unsafeRetryAfterSubmission = row?.state === STATES.RETRYABLE_ERROR && row.submittedAt;
            if (unsafeRetryAfterSubmission) {
                row.state = STATES.RECONCILE_PENDING;
                row.selected = false;
                row.lastError = '市场提交已成功，但库存仍显示；等待 Steam 缓存同步后再次对账，禁止重提。';
                migrated = true;
                continue;
            }
            const oldUnknownOutcome = row?.state === STATES.PAUSED_CONFIRMATIONS
                && !row.submittedAt
                && /结果不确定|超过\s*20\s*秒|timeout|network/i.test(String(row.lastError || ''));
            if (oldUnknownOutcome) {
                row.state = STATES.OUTCOME_UNKNOWN;
                row.selected = false;
                row.submissionOutcomeUnknown = true;
                migrated = true;
                continue;
            }
            const oldRejectedByConfirmationLimit = row?.state === STATES.PAUSED_CONFIRMATIONS && !row.submittedAt;
            if (oldRejectedByConfirmationLimit) {
                row.state = STATES.RETRYABLE_ERROR;
                row.selected = false;
                migrated = true;
            }
        }
        return migrated;
    }

    function loadLedger() {
        try {
            const parsed = JSON.parse(localStorage.getItem(LEDGER_KEY) || 'null');
            if (parsed?.version === 1 && parsed.assets && typeof parsed.assets === 'object') {
                const migrated = migrateLedgerForSafety(parsed);
                if (migrated) {
                    parsed.updatedAt = nowIso();
                    localStorage.setItem(LEDGER_KEY, JSON.stringify(parsed));
                }
                return parsed;
            }
        } catch (_) {}
        return emptyLedger();
    }

    function saveLedger(ledger) {
        ledger.updatedAt = nowIso();
        localStorage.setItem(LEDGER_KEY, JSON.stringify(ledger));
    }

    function loadPriceCache() {
        try {
            const parsed = JSON.parse(localStorage.getItem(PRICE_CACHE_KEY) || '{}');
            return parsed && typeof parsed === 'object' ? parsed : {};
        } catch (_) {
            return {};
        }
    }

    function savePriceCache(cache) {
        localStorage.setItem(PRICE_CACHE_KEY, JSON.stringify(cache));
    }

    function log(message, level = 'info') {
        runtime.logLines.push({ at: new Date().toLocaleTimeString(), level, message: String(message) });
        runtime.logLines = runtime.logLines.slice(-80);
        render();
    }

    function resolveScannedState(existing, externalPending) {
        if (externalPending) return { state: STATES.EXTERNAL_PENDING, selected: false };
        if (existing.state === STATES.EXTERNAL_PENDING) {
            if (existing.submittedAt || existing.submissionOutcomeUnknown) {
                return {
                    state: STATES.RECONCILE_PENDING,
                    selected: false,
                    lastError: 'Steam 待确认记录已消失，但库存仍显示；等待缓存同步后再次对账，禁止重提。',
                };
            }
            return { state: STATES.DISCOVERED, selected: true };
        }
        const lockedState = [
            STATES.SUBMITTING,
            STATES.SUBMITTED,
            STATES.PAUSED_CONFIRMATIONS,
            STATES.RECONCILE_PENDING,
            STATES.OUTCOME_UNKNOWN,
            STATES.QUARANTINED,
            STATES.ACTIVE,
        ].includes(existing.state);
        return {
            state: lockedState ? existing.state : STATES.DISCOVERED,
            selected: lockedState ? false : existing.selected !== false,
        };
    }

    function mergeScanIntoLedger(cards, pendingByAsset = new Map()) {
        const ledger = loadLedger();
        const presentIds = new Set(cards.map(card => card.assetid));

        for (const card of cards) {
            const existing = ledger.assets[card.assetid] || {};
            const externalPending = pendingByAsset.get(card.assetid);
            const resolved = resolveScannedState(existing, externalPending);
            ledger.assets[card.assetid] = {
                ...existing,
                ...card,
                original_contextid: String(existing.original_contextid || existing.submittedContextid || existing.contextid || card.contextid),
                observed_contextid: String(card.contextid),
                foil: isFoilCard(card),
                selected: resolved.selected,
                state: resolved.state,
                lastError: resolved.lastError ?? existing.lastError ?? '',
                presentInInventory: true,
                externalPendingConfirmationId: externalPending?.confirmationid || '',
                discoveredAt: existing.discoveredAt || nowIso(),
                lastSeenAt: nowIso(),
                attempts: toPositiveInt(existing.attempts, 0),
            };
        }

        for (const row of Object.values(ledger.assets)) {
            if (!presentIds.has(row.assetid)) row.presentInInventory = false;
        }
        saveLedger(ledger);
        return ledger;
    }

    function getInventoryRows(ledger = loadLedger()) {
        return Object.values(ledger.assets)
            .filter(row => row.presentInInventory)
            .sort((a, b) => a.market_hash_name.localeCompare(b.market_hash_name) || a.assetid.localeCompare(b.assetid));
    }

    async function scanInventory() {
        if (runtime.running) return;
        runtime.running = true;
        try {
            log('正在加载完整的 Steam 社区物品库存…');
            await loadCompleteInventory();
            const pendingByAsset = await fetchPendingListingConfirmations();
            const cards = collectTradingCards();
            if (cards.length > MAX_ITEMS_GUARD) {
                throw new Error(`识别到 ${cards.length} 件卡牌，超过安全上限 ${MAX_ITEMS_GUARD}，已停止。`);
            }
            const ledger = mergeScanIntoLedger(cards, pendingByAsset);
            const unique = new Set(cards.map(card => card.market_hash_name)).size;
            const duplicates = cards.length - unique;
            const lockedPending = cards.filter(card => pendingByAsset.has(card.assetid)).length;
            log(`只读盘点完成：${cards.length} 件、${unique} 种、重复副本 ${duplicates} 件；Steam 待确认锁定 ${lockedPending} 件。`, 'success');
            render(ledger);
        } catch (error) {
            log(error?.message || error, 'error');
        } finally {
            runtime.running = false;
            render();
        }
    }

    function getMarketGroupKey(row) {
        return `${row.appid}|${row.contextid}|${row.market_hash_name}`;
    }

    async function fetchLowestBuyerCents(row, cache, forceRefresh = false) {
        const key = `${row.appid}|${row.market_hash_name}`;
        const cached = cache[key];
        if (!forceRefresh && cached && Date.now() - cached.at < CACHE_TTL_MS && cached.buyerCents > 0) {
            return { ...cached, cached: true };
        }

        const wallet = getWalletInfo();
        const url = new URL('/market/priceoverview/', location.origin);
        url.searchParams.set('appid', row.appid);
        url.searchParams.set('market_hash_name', row.market_hash_name);
        url.searchParams.set('currency', String(wallet.wallet_currency));
        const response = await fetchReadOnly(url, {
            credentials: 'include',
            headers: { 'X-Requested-With': 'XMLHttpRequest' },
        }, `读取 ${row.name} 的市场价格`);
        if (response.status === 429) throw new Error('RATE_LIMITED');
        if (response.status === 401 || response.status === 403) throw new Error(`SESSION_HTTP_${response.status}`);
        if (!response.ok) throw new Error(`HTTP_${response.status}`);
        const data = await response.json();
        const buyerCents = parsePriceToCents(data.lowest_price || '');
        if (!data.success) throw new Error('NO_PRICE');
        if (buyerCents <= 0) throw new Error('NO_ACTIVE_LISTING');
        const result = { at: Date.now(), buyerCents, text: data.lowest_price };
        cache[key] = result;
        savePriceCache(cache);
        return result;
    }

    async function buildDryRun() {
        if (runtime.running) return;
        runtime.running = true;
        runtime.pauseRequested = false;
        try {
            let ledger = loadLedger();
            await loadCompleteInventory();
            const pendingByAsset = await fetchPendingListingConfirmations();
            ledger = mergeScanIntoLedger(collectTradingCards(), pendingByAsset);
            const rows = getInventoryRows(ledger);
            if (!rows.length) throw new Error('没有识别到可出售的集换式卡牌。');

            const planRows = rows.filter(row => row.tradable && row.contextid === DEFAULT_CONTEXT_ID && ![
                STATES.EXTERNAL_PENDING,
                STATES.SUBMITTING,
                STATES.SUBMITTED,
                STATES.PAUSED_CONFIRMATIONS,
                STATES.RECONCILE_PENDING,
                STATES.OUTCOME_UNKNOWN,
                STATES.ACTIVE,
                STATES.QUARANTINED,
            ].includes(row.state));
            if (!planRows.length) throw new Error('没有可进入预演的卡牌；其余资产均被待确认或安全状态锁定。');

            const cache = loadPriceCache();
            const groups = new Map();
            for (const row of planRows) {
                const groupKey = getMarketGroupKey(row);
                if (!groups.has(groupKey)) groups.set(groupKey, []);
                groups.get(groupKey).push(row);
            }

            let done = 0;
            for (const [groupKey, group] of groups) {
                if (runtime.pauseRequested) break;
                try {
                    const quote = await fetchLowestBuyerCents(group[0], cache, true);
                    const lockAt = new Date(quote.at).toISOString();
                    const lockId = `${groupKey}|${quote.buyerCents}|${lockAt}`;
                    for (const row of group) {
                        const receiveCents = calculateReceiveCents(quote.buyerCents, row.market_fee);
                        ledger.assets[row.assetid] = {
                            ...ledger.assets[row.assetid],
                            buyerCents: quote.buyerCents,
                            receiveCents,
                            quoteText: quote.text,
                            quoteAt: lockAt,
                            priceLockId: lockId,
                            priceGroupKey: groupKey,
                            priceSource: '最低卖单（批次锁价）',
                            state: STATES.PLANNED,
                            lastError: '',
                        };
                    }
                } catch (error) {
                    for (const row of group) {
                        ledger.assets[row.assetid].state = STATES.PRICE_ERROR;
                        ledger.assets[row.assetid].lastError = error?.message || String(error);
                    }
                    if (/RATE_LIMITED|SESSION_HTTP|登录|login|超过\s*\d+\s*秒|Failed to fetch|NetworkError/i.test(String(error?.message || error))) {
                        runtime.pauseRequested = true;
                        log('行情读取出现限流、会话或网络异常，预演已停止；未继续请求后续卡牌。', 'warn');
                    }
                }
                done += 1;
                saveLedger(ledger);
                log(`行情预演 ${done}/${groups.size}：${group[0].market_hash_name}（同商品 ${group.length} 件仅取价一次）`);
                if (done < groups.size) await sleep(randomInt(PRICE_DELAY_MIN_MS, PRICE_DELAY_MAX_MS));
            }

            const planned = getInventoryRows(ledger).filter(row => row.state === STATES.PLANNED);
            const failed = getInventoryRows(ledger).filter(row => row.state === STATES.PRICE_ERROR);
            const total = planned.reduce((sum, row) => sum + toPositiveInt(row.receiveCents), 0);
            log(`预演完成：可提交 ${planned.length} 件，到手价合计 ${formatCents(total)}；取价失败 ${failed.length} 件。`, failed.length ? 'warn' : 'success');
        } catch (error) {
            log(error?.message || error, 'error');
        } finally {
            runtime.running = false;
            render();
        }
    }

    function classifyError(message) {
        const text = String(message || '');
        if (/too many listings pending confirmation|待确认|等待确认/i.test(text)) return 'CONFIRMATION_LIMIT';
        if (/session|会话|重新登录|登录|sign.?in|login|HTTP\s*(401|403)/i.test(text)) return 'SESSION_ERROR';
        if (/429|rate.?limit|上一个操作|previous action|刷新页面并重试|refresh.*try again|无法连接到游戏物品服务器|temporary connection/i.test(text)) {
            return 'RETRYABLE';
        }
        if (/not found|不存在|不可出售|not marketable|asset/i.test(text)) return 'ASSET_ERROR';
        return 'UNKNOWN';
    }

    function validatePlan(rows) {
        const selected = rows.filter(row => row.selected !== false && [STATES.PLANNED, STATES.RETRYABLE_ERROR].includes(row.state));
        const ids = new Set(selected.map(row => row.assetid));
        if (!selected.length) throw new Error('没有处于可提交状态的已选卡牌。');
        if (ids.size !== selected.length) throw new Error('计划中发现重复 assetid，已停止。');
        const groupLocks = new Map();
        for (const row of selected) {
            const receive = toPositiveInt(row.receiveCents);
            const buyer = toPositiveInt(row.buyerCents);
            if (!receive || receive > MAX_RECEIVE_PER_ITEM_CENTS) {
                throw new Error(`${row.name} 的到手价超出安全范围。`);
            }
            if (!buyer) throw new Error(`${row.name} 缺少买家支付价格。`);
            const groupKey = getMarketGroupKey(row);
            const signature = `${buyer}|${receive}`;
            const existing = groupLocks.get(groupKey);
            if (existing && existing !== signature) {
                throw new Error(`${row.name} 的同商品批次出现混合价格，已停止；请重新预演并统一锁价。`);
            }
            groupLocks.set(groupKey, signature);
        }
        const total = selected.reduce((sum, row) => sum + toPositiveInt(row.receiveCents), 0);
        if (total > MAX_RECEIVE_TOTAL_CENTS) throw new Error('计划总到手价超过安全上限，已停止。');
        return { selected, total, groupCount: groupLocks.size };
    }

    async function runBatch() {
        log('此版本仅盘点、取价；请通过原生流程提交。', 'warn');
    }

    function needsSubmissionReconciliation(row) {
        if ([
            STATES.SUBMITTING,
            STATES.SUBMITTED,
            STATES.PAUSED_CONFIRMATIONS,
            STATES.RECONCILE_PENDING,
            STATES.OUTCOME_UNKNOWN,
        ].includes(row?.state)) return true;
        return row?.state === STATES.EXTERNAL_PENDING
            && Boolean(row.submittedAt || row.submissionOutcomeUnknown);
    }

    async function reconcileAfterConfirmation() {
        log('请通过原生流程核对待确认、暂挂、出售和库存状态。', 'warn');
    }

    function formatCents(cents) {
        const value = Math.max(0, Number(cents) || 0);
        return `¥${(value / 100).toFixed(2)}`;
    }

    function summarize(ledger) {
        const rows = Object.values(ledger.assets);
        const present = rows.filter(row => row.presentInInventory);
        const unique = new Set(present.map(row => row.market_hash_name)).size;
        const planned = present.filter(row => row.state === STATES.PLANNED);
        const submitted = rows.filter(row => [STATES.SUBMITTED, STATES.PAUSED_CONFIRMATIONS, STATES.RECONCILE_PENDING, STATES.OUTCOME_UNKNOWN].includes(row.state));
        const externalPending = present.filter(row => row.state === STATES.EXTERNAL_PENDING);
        const quarantined = rows.filter(row => row.state === STATES.QUARANTINED);
        const active = rows.filter(row => row.state === STATES.ACTIVE);
        return {
            present: present.length,
            unique,
            duplicates: present.length - unique,
            planned: planned.length,
            plannedTotal: planned.reduce((sum, row) => sum + toPositiveInt(row.receiveCents), 0),
            submitted: submitted.length,
            externalPending: externalPending.length,
            quarantined: quarantined.length,
            active: active.length,
        };
    }

    function stateLabel(state) {
        return ({
            [STATES.DISCOVERED]: '已盘点',
            [STATES.PLANNED]: '可提交',
            [STATES.PRICE_ERROR]: '取价失败',
            [STATES.SUBMITTING]: '提交中',
            [STATES.SUBMITTED]: '待确认/待对账',
            [STATES.EXTERNAL_PENDING]: 'Steam 待确认（锁定）',
            [STATES.PAUSED_CONFIRMATIONS]: '确认屏障暂停',
            [STATES.RECONCILE_PENDING]: '等待库存同步（锁定）',
            [STATES.OUTCOME_UNKNOWN]: '提交结果不确定（锁定）',
            [STATES.RETRYABLE_ERROR]: '可重试',
            [STATES.QUARANTINED]: '已隔离',
            [STATES.ACTIVE]: '历史记录（未重新核验）',
        })[state] || state || '未知';
    }

    function exportLedger() {
        const ledger = loadLedger();
        const blob = new Blob([JSON.stringify(ledger, null, 2)], { type: 'application/json;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = `steam-card-listing-ledger-${new Date().toISOString().replaceAll(':', '-')}.json`;
        anchor.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    function updateRowFromUi(target) {
        const assetid = target?.dataset?.assetid;
        if (!assetid) return;
        const ledger = loadLedger();
        const row = ledger.assets[assetid];
        if (!row) return;
        if ([STATES.EXTERNAL_PENDING, STATES.SUBMITTING, STATES.SUBMITTED, STATES.PAUSED_CONFIRMATIONS, STATES.RECONCILE_PENDING, STATES.OUTCOME_UNKNOWN, STATES.ACTIVE, STATES.QUARANTINED].includes(row.state)) return;
        if (target.matches('.scbl-select')) row.selected = target.checked;
        if (target.matches('.scbl-price')) {
            persistPriceInput(target, ledger, row);
        }
        saveLedger(ledger);
        render(ledger);
    }

    function persistPriceInput(target, existingLedger, existingRow) {
        if (!target?.matches?.('.scbl-price')) return false;
        const assetid = target.dataset.assetid;
        const ledger = existingLedger || loadLedger();
        const row = existingRow || ledger.assets[assetid];
        if (!row || [STATES.EXTERNAL_PENDING, STATES.SUBMITTING, STATES.SUBMITTED, STATES.PAUSED_CONFIRMATIONS, STATES.RECONCILE_PENDING, STATES.OUTCOME_UNKNOWN, STATES.ACTIVE, STATES.QUARANTINED].includes(row.state)) return false;
        const receiveCents = Math.round(Number(target.value) * 100);
        if (receiveCents <= 0 || receiveCents > MAX_RECEIVE_PER_ITEM_CENTS) return false;
        const groupKey = getMarketGroupKey(row);
        const lockAt = nowIso();
        const lockId = `${groupKey}|manual|${receiveCents}|${lockAt}`;
        for (const peer of Object.values(ledger.assets)) {
            if (!peer.presentInInventory || getMarketGroupKey(peer) !== groupKey) continue;
            if ([STATES.EXTERNAL_PENDING, STATES.SUBMITTING, STATES.SUBMITTED, STATES.PAUSED_CONFIRMATIONS, STATES.RECONCILE_PENDING, STATES.OUTCOME_UNKNOWN, STATES.ACTIVE, STATES.QUARANTINED].includes(peer.state)) continue;
            peer.receiveCents = receiveCents;
            peer.buyerCents = calculateBuyerCents(receiveCents, peer.market_fee);
            peer.quoteAt = lockAt;
            peer.priceLockId = lockId;
            peer.priceGroupKey = groupKey;
            peer.priceSource = '手动修改（同商品批次锁价）';
            if ([STATES.DISCOVERED, STATES.PRICE_ERROR, STATES.RETRYABLE_ERROR].includes(peer.state)) peer.state = STATES.PLANNED;
            peer.lastError = '';
        }
        saveLedger(ledger);
        return true;
    }

    function render(ledger = loadLedger()) {
        if (!runtime.shadow) return;
        const summary = summarize(ledger);
        const rows = getInventoryRows(ledger);
        const stats = runtime.shadow.querySelector('#scbl-stats');
        const tbody = runtime.shadow.querySelector('#scbl-rows');
        const logs = runtime.shadow.querySelector('#scbl-logs');
        const buttons = runtime.shadow.querySelectorAll('button');
        buttons.forEach(button => { button.disabled = runtime.running; });
        const pause = runtime.shadow.querySelector('#scbl-pause');
        if (pause) pause.disabled = !runtime.running;
        for (const id of ['#scbl-run', '#scbl-reconcile']) {
            const button = runtime.shadow.querySelector(id);
            if (button) button.disabled = true;
        }
        const machine = runtime.shadow.querySelector('#scbl-agent-summary');
        if (machine) machine.textContent = JSON.stringify({
            schema: 1, mode: 'READ_ONLY', busy: runtime.running,
            currency: Number(globalThis.g_rgWalletInfo?.wallet_currency) || null,
            inventory: summary.present, groups: summary.unique, pendingLocks: summary.externalPending,
            quoted: summary.planned, feePreviewIsNativeApproval: false,
            lastMessage: runtime.logLines.at(-1)?.message?.slice(0, 160) || '',
        });

        if (stats) {
            stats.innerHTML = [
                `库存卡牌 <b>${summary.present}</b>`,
                `不同名称 <b>${summary.unique}</b>`,
                `重复 <b>${summary.duplicates}</b>`,
                `已预演 <b>${summary.planned}</b>`,
                `计划到手 <b>${escapeHtml(formatCents(summary.plannedTotal))}</b>`,
                `脚本待对账 <b>${summary.submitted}</b>`,
                `Steam 待确认锁定 <b>${summary.externalPending}</b>`,
                `历史记录（未重新核验） <b>${summary.active}</b>`,
                `隔离 <b>${summary.quarantined}</b>`,
            ].map(text => `<span>${text}</span>`).join('');
        }

        if (tbody) {
            tbody.innerHTML = rows.map((row, index) => {
                const editable = ![STATES.EXTERNAL_PENDING, STATES.SUBMITTING, STATES.SUBMITTED, STATES.PAUSED_CONFIRMATIONS, STATES.RECONCILE_PENDING, STATES.OUTCOME_UNKNOWN, STATES.ACTIVE, STATES.QUARANTINED].includes(row.state);
                const receive = toPositiveInt(row.receiveCents);
                return `<tr>
                    <td><input class="scbl-select" data-assetid="${escapeHtml(row.assetid)}" data-appid="${escapeHtml(row.appid)}" data-contextid="${escapeHtml(row.contextid)}" data-marketable="${row.marketable ? 1 : 0}" data-tradable="${row.tradable ? 1 : 0}" type="checkbox" ${row.selected !== false ? 'checked' : ''} ${editable ? '' : 'disabled'}></td>
                    <td>${index + 1}</td>
                    <td title="${escapeHtml(row.market_hash_name)}">${escapeHtml(row.name)}${row.foil ? ' <em>闪卡</em>' : ''}</td>
                    <td><code>${escapeHtml(row.assetid)}</code></td>
                    <td>${row.buyerCents ? escapeHtml(formatCents(row.buyerCents)) : '—'}</td>
                    <td><input class="scbl-price" data-assetid="${escapeHtml(row.assetid)}" type="number" min="0.01" max="100" step="0.01" value="${receive ? (receive / 100).toFixed(2) : ''}" ${editable ? '' : 'disabled'}></td>
                    <td class="state state-${escapeHtml(row.state || '')}">${escapeHtml(stateLabel(row.state))}</td>
                    <td title="${escapeHtml(row.lastError || '')}">${escapeHtml(row.lastError || row.priceSource || '')}</td>
                </tr>`;
            }).join('');
        }

        if (logs) {
            logs.innerHTML = runtime.logLines.slice().reverse().map(line =>
                `<div class="log-${escapeHtml(line.level)}"><time>${escapeHtml(line.at)}</time> ${escapeHtml(line.message)}</div>`,
            ).join('') || '<div>尚未执行操作。</div>';
        }
    }

    function mountUi() {
        if (document.getElementById(PANEL_ID)) return;
        const host = document.createElement('div');
        host.id = PANEL_ID;
        document.documentElement.appendChild(host);
        const shadow = host.attachShadow({ mode: 'open' });
        host.dataset.auditSchema = '1';
        runtime.panel = host;
        runtime.shadow = shadow;
        shadow.innerHTML = `
            <style>
                :host{all:initial} .panel{position:fixed;right:18px;bottom:18px;z-index:2147483647;width:min(980px,calc(100vw - 36px));max-height:82vh;display:flex;flex-direction:column;background:#182536;color:#dbe7f2;border:1px solid #4d7594;border-radius:10px;box-shadow:0 14px 50px #000b;font:13px/1.45 system-ui,sans-serif}
                header{display:flex;align-items:center;gap:10px;padding:10px 12px;background:#101c29;border-radius:10px 10px 0 0} header b{font-size:15px} header .note{color:#8fb5d1} header button{margin-left:auto}
                button{border:1px solid #5f86a5;background:#2b5876;color:white;border-radius:6px;padding:7px 10px;cursor:pointer} button:hover{background:#347099} button:disabled{opacity:.45;cursor:not-allowed}.danger{background:#7c3a37;border-color:#a95d58}.secondary{background:#334454}
                .actions{display:flex;flex-wrap:wrap;gap:7px;padding:10px 12px;border-bottom:1px solid #324a5e}.actions label{display:flex;align-items:center;gap:5px}.actions input{width:54px;background:#0e1822;color:#fff;border:1px solid #567188;border-radius:4px;padding:5px}.submit-confirm{margin:8px 12px;padding:10px;border:1px solid #d9a441;border-radius:6px;background:#3b2d15;color:#fff}.submit-confirm[hidden]{display:none}.submit-confirm p{margin:0 0 8px;white-space:normal}.submit-confirm .buttons{display:flex;gap:8px}
                #scbl-stats{display:flex;flex-wrap:wrap;gap:7px;padding:8px 12px;border-bottom:1px solid #324a5e}#scbl-stats span{background:#22394d;border-radius:5px;padding:4px 7px}#scbl-stats b{color:#7fd4ff}
                .table-wrap{overflow:auto;max-height:43vh}table{width:100%;border-collapse:collapse}th,td{padding:6px 7px;border-bottom:1px solid #2b4051;text-align:left;white-space:nowrap}th{position:sticky;top:0;background:#132333;z-index:1}td:nth-child(3){max-width:240px;overflow:hidden;text-overflow:ellipsis}td:nth-child(8){max-width:220px;overflow:hidden;text-overflow:ellipsis;color:#9fb3c3}code{font-size:11px;color:#a9c7de}.scbl-price{width:72px;background:#0e1822;color:#fff;border:1px solid #567188;border-radius:4px;padding:4px}.state{font-weight:700}.state-PLANNED,.state-ACTIVE{color:#6fd69a}.state-PRICE_ERROR,.state-QUARANTINED{color:#ff8a84}.state-EXTERNAL_PENDING,.state-SUBMITTED,.state-PAUSED_CONFIRMATIONS,.state-RECONCILE_PENDING,.state-OUTCOME_UNKNOWN,.state-RETRYABLE_ERROR{color:#ffd476}em{font-style:normal;color:#dd9cff}
                #scbl-logs{max-height:105px;overflow:auto;padding:8px 12px;background:#0d1720;border-radius:0 0 10px 10px;color:#a9bac8}#scbl-logs time{color:#7891a5}.log-error{color:#ff938d}.log-warn{color:#ffd476}.log-success{color:#83dba4}
                .hidden{display:none}.collapsed .body{display:none}.collapsed{width:auto}.collapsed header{border-radius:10px}
            </style>
            <section class="panel">
                <header><b>Steam 卡牌批量上架助手</b><span class="note">只读版 · 费用仍须原生页面确认</span><button id="scbl-collapse" class="secondary">收起</button></header>
                <div class="body">
                    <div class="actions">
                        <button id="scbl-scan">1. 只读盘点</button>
                        <button id="scbl-plan">2. 获取最低价并预演</button>
                        <label>每批 <input id="scbl-batch-size" type="number" min="1" max="50" value="${DEFAULT_BATCH_SIZE}"> 件</label>
                        <button id="scbl-run" class="danger">提交请用原生流程</button>
                        <button id="scbl-pause" class="secondary" disabled>暂停</button>
                        <button id="scbl-reconcile" class="secondary">对账请用原生流程</button>
                        <button id="scbl-export" class="secondary">导出台账</button>
                    </div>
                    <div id="scbl-submit-confirm" class="submit-confirm" hidden>
                        <p id="scbl-submit-confirm-message"></p>
                        <div class="buttons">
                            <button id="scbl-submit-confirm-accept" class="danger">确认提交</button>
                            <button id="scbl-submit-confirm-cancel" class="secondary">取消</button>
                        </div>
                    </div>
                    <pre id="scbl-agent-summary" style="white-space:pre-wrap;margin:8px 12px"></pre>
                    <div id="scbl-stats"></div>
                    <div class="table-wrap"><table>
                        <thead><tr><th>选</th><th>#</th><th>卡牌</th><th>assetid</th><th>买家最低价</th><th>卖家到手价</th><th>状态</th><th>来源/错误</th></tr></thead>
                        <tbody id="scbl-rows"></tbody>
                    </table></div>
                    <div id="scbl-logs"></div>
                </div>
            </section>`;

        shadow.querySelector('#scbl-scan').addEventListener('click', scanInventory);
        shadow.querySelector('#scbl-plan').addEventListener('click', buildDryRun);
        shadow.querySelector('#scbl-run').addEventListener('click', runBatch);
        shadow.querySelector('#scbl-pause').addEventListener('click', () => {
            runtime.pauseRequested = true;
            log('已请求暂停；当前请求结束后停止。', 'warn');
        });
        shadow.querySelector('#scbl-reconcile').addEventListener('click', reconcileAfterConfirmation);
        shadow.querySelector('#scbl-export').addEventListener('click', exportLedger);
        shadow.querySelector('#scbl-collapse').addEventListener('click', event => {
            const panel = shadow.querySelector('.panel');
            panel.classList.toggle('collapsed');
            event.currentTarget.textContent = panel.classList.contains('collapsed') ? '展开' : '收起';
        });
        shadow.querySelector('#scbl-rows').addEventListener('change', event => updateRowFromUi(event.target));
        shadow.querySelector('#scbl-rows').addEventListener('input', event => {
            if (event.target?.matches?.('.scbl-price')) persistPriceInput(event.target);
        });
        render();
        log('助手已加载。先点击“只读盘点”，不会提交任何市场操作。');
    }

    const testApi = Object.freeze({
        parsePriceToCents,
        calculateBuyerCents,
        calculateReceiveCents,
        normalizeTags,
        isTradingCard,
        isFoilCard,
        normalizeAsset,
        collectFromInventoryObjects,
        collectTradingCards,
        parsePendingListingConfirmations,
        classifyError,
        getMarketGroupKey,
        validatePlan,
        migrateLedgerForSafety,
        resolveScannedState,
        needsSubmissionReconciliation,
        STATES,
    });

    if (TEST_MODE) {
        globalThis.__SteamCardListingCore = testApi;
        return;
    }

    function initWhenReady() {
        if (!location.hostname.endsWith('steamcommunity.com') || !/\/inventory\/?/i.test(location.pathname)) return;
        mountUi();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initWhenReady, { once: true });
    } else {
        initWhenReady();
    }
})();
