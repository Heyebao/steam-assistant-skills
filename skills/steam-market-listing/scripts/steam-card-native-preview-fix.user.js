// ==UserScript==
// @name         Steam 卡牌原生批量入口修复（仅打开预览）
// @namespace    codex.local.steam-card-preview-fix
// @version      1.0.0
// @description  保留完整 market_hash_name，打开零数量的 Steam 原生卡牌价格预览，不撤单、不提交。
// @match        https://steamcommunity.com/market/listings/753/*
// @grant        none
// @run-at       document-idle
// @license      MIT
// ==/UserScript==

(function () {
    'use strict';

    function buildNativeUrl(href) {
        const source = new URL(href);
        if (source.origin !== 'https://steamcommunity.com') throw new Error('不是 Steam 官方页面。');
        const match = source.pathname.match(/^\/market\/listings\/753\/([^/]+)\/?$/);
        if (!match) throw new Error('仅支持 Steam 社区卡牌市场页面。');
        const marketHashName = decodeURIComponent(match[1]);
        if (!/^\d+-.+/.test(marketHashName)) throw new Error('完整卡牌标识缺少游戏编号。');
        const destination = new URL('/market/multisell', source.origin);
        destination.searchParams.set('appid', '753');
        destination.searchParams.set('contextid', '6');
        destination.searchParams.append('items[]', marketHashName);
        destination.searchParams.append('qty[]', '0');
        return destination.toString();
    }

    function isCardText(text) {
        return /集换式卡牌|交易卡牌|Trading Card/i.test(String(text));
    }

    if (globalThis.__STEAM_CARD_PREVIEW_FIX_TEST__) {
        globalThis.__SteamCardPreviewFix = Object.freeze({ buildNativeUrl, isCardText });
        return;
    }

    function openPreview() {
        if (!isCardText(document.body?.innerText)) {
            console.warn('Steam 卡牌预览：当前页面无法确认卡牌类型，未跳转。');
            return;
        }
        try {
            location.assign(buildNativeUrl(location.href));
        } catch (error) {
            console.warn('Steam 卡牌预览：' + error.message);
        }
    }

    // 旧入口以显示名称组装 URL，会丢失游戏编号。仅在卡牌页接管这个入口。
    document.addEventListener('click', event => {
        if (!(event.target instanceof Element) || !isCardText(document.body?.innerText)) return;
        let candidate = event.target;
        for (let depth = 0; candidate && depth < 3; depth++, candidate = candidate.parentElement) {
            if (candidate.textContent.trim() !== '🛒 批量销售此物品') continue;
            event.preventDefault();
            event.stopImmediatePropagation();
            openPreview();
            return;
        }
    }, true);

    function mount() {
        if (!document.body || !isCardText(document.body.innerText) || document.getElementById('codex-card-native-preview-fix')) return;
        const button = document.createElement('button');
        button.id = 'codex-card-native-preview-fix';
        button.type = 'button';
        button.textContent = '卡牌原生批量预览（完整标识）';
        button.title = '只打开原生预览，数量为0；不会撤单或提交挂单。';
        Object.assign(button.style, {
            position: 'fixed', right: '20px', bottom: '64px', zIndex: '9999',
            padding: '10px 14px', border: '1px solid #80b629', borderRadius: '4px',
            background: '#243a16', color: '#d9ffb0', cursor: 'pointer',
        });
        button.addEventListener('click', openPreview);
        document.body.appendChild(button);
    }

    // Steam 新版页面异步渲染。观察只持续30秒，不请求行情、不连续交易。
    mount();
    const observer = new MutationObserver(mount);
    observer.observe(document.documentElement, { childList: true, subtree: true });
    setTimeout(() => observer.disconnect(), 30000);
})();
