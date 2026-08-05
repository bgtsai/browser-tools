// ==UserScript==
// @name         通用診斷面板骨架
// @namespace    browser-tools
// @version      3.0
// @description  診斷面板骨架：面板 UI + 相對時間戳 + 開始/停止 + 一鍵複製；任務專屬邏輯只需替換「探針區塊」。目前任務：找出「點路線取得地點名稱」的請求格式
// @match        https://www.google.com/maps/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @grant        unsafeWindow
// @run-at       document-start
// ==/UserScript==

(function () {
    'use strict';

    // ─────────────────────────────────────────────────────────────────────
    // 這是「骨架」而非單一診斷工具。每次要診斷不同問題時，
    // 只需要替換下方標示「探針區塊」的那一段（PROBE_SETUP / PROBE_TEARDOWN），
    // 其餘的面板 UI、時間戳、複製邏輯不需要改動。
    //
    // ── 執行環境（重要）──
    // 本腳本使用 GM_* 授權，因此跑在**沙箱**裡，與 route-rain 相同。
    // 沙箱的 window 與網頁真正使用的那一份是兩個不同的物件，凡是要
    //   ・攔截網頁發出的請求
    //   ・派送網頁監聽得到的合成事件
    //   ・讀取網頁自己的全域變數
    // 都必須明寫 unsafeWindow，否則只會動到沙箱自己的副本。
    // 這個坑踩過三次（攔截器、事件建構子、滾輪縮放），
    // 「被迫明寫 unsafeWindow」正是選擇這個環境的理由——它讓錯誤無所遁形。
    //
    // @match 一律限定在當前任務的網站，不要用 *://*/*——
    // 這個面板是針對性工具，不該在每個網頁都載入。
    //
    // DOM 上所有自建的 id / class 一律加 bdp（browser diagnostic panel）前綴，
    // 避免跟頁面本身或其他擴充功能的命名空間衝突。
    // ─────────────────────────────────────────────────────────────────────

    const LOG = [];              // 每筆記錄：{ t: 相對秒數(number), tag: string, content: string }
    let isMonitoring = false;
    let startTimeMs = 0;         // 監控起點的 Date.now()，作為相對時間戳的基準

    // ── 記錄函式：探針區塊透過這個函式寫入時序記錄 ──────────────────────────
    // content 若是物件，展開成縮排的 key: value 純文字（不用 JSON.stringify），
    // 理由見 01 與本工具 README：純文字時序記錄比 JSON 更適合直接閱讀與貼給協作者。
    function log(tag, content) {
        if (!isMonitoring) return; // 停止狀態下呼叫視為誤用，靜默忽略而非報錯，避免探針區塊要額外判斷
        const t = ((Date.now() - startTimeMs) / 1000).toFixed(2);
        const text = formatContent(content);
        LOG.push({ t, tag, text });
        renderNewestEntry(t, tag, text);
        updateCount();
    }

    function formatContent(content) {
        if (content == null) return '';
        if (typeof content !== 'object') return String(content);
        // 物件展開成一層縮排的 key: value，不做深層遞迴美化——
        // 診斷當下通常只需要看第一層欄位，深層結構直接印會太長、反而難讀，
        // 需要更深資訊時應該在探針區塊裡自己挑選欄位，而不是仰賴這裡自動遞迴
        return Object.entries(content)
            .map(([k, v]) => `    ${k}: ${v}`)
            .join('\n');
    }

    // ── 面板 UI ──────────────────────────────────────────────────────────
    const panel = document.createElement('div');
    panel.id = 'bdp-panel';
    panel.style.cssText = `
        position: fixed; top: 80px; right: 20px; z-index: 2147483647;
        background: #212121; color: #eee; border: 1px solid #444;
        border-radius: 8px; width: 320px;
        font-family: system-ui, sans-serif; font-size: 12.5px;
        box-shadow: 0 4px 16px rgba(0,0,0,.5);
        display: flex; flex-direction: column;
        max-height: 70vh;
    `;

    const header = document.createElement('div');
    header.id = 'bdp-header';
    header.style.cssText = `
        display: flex; align-items: center; justify-content: space-between;
        padding: 8px 10px; cursor: move; user-select: none;
        border-bottom: 1px solid #444; flex-shrink: 0;
    `;
    const title = document.createElement('span');
    title.textContent = '診斷面板';
    title.style.cssText = 'font-weight: 600;';
    const collapseBtn = document.createElement('button');
    collapseBtn.textContent = '－';
    collapseBtn.title = '摺疊/展開';
    collapseBtn.style.cssText = btnStyle();
    header.appendChild(title);
    header.appendChild(collapseBtn);
    panel.appendChild(header);

    const body = document.createElement('div');
    body.id = 'bdp-body';
    body.style.cssText = 'display: flex; flex-direction: column; overflow: hidden;';
    panel.appendChild(body);

    const controls = document.createElement('div');
    controls.style.cssText = 'display: flex; gap: 6px; padding: 8px 10px; border-bottom: 1px solid #333; flex-shrink: 0;';
    const startStopBtn = document.createElement('button');
    startStopBtn.textContent = '開始監控';
    startStopBtn.style.cssText = btnStyle(true);
    const clearBtn = document.createElement('button');
    clearBtn.textContent = '清空';
    clearBtn.style.cssText = btnStyle();
    const copyBtn = document.createElement('button');
    copyBtn.textContent = '複製';
    copyBtn.style.cssText = btnStyle();
    controls.appendChild(startStopBtn);
    controls.appendChild(clearBtn);
    controls.appendChild(copyBtn);
    body.appendChild(controls);

    // ── 操作指引區 ────────────────────────────────────────────────────
    // 由探針區塊透過 guide([...]) 設定。把「按下開始後要做什麼」直接寫在面板上，
    // 使用者就不必在對話視窗與被測頁面之間來回切換、或把步驟背下來。
    // 沒有設定時整個區塊不顯示，不佔版面。
    const guideBox = document.createElement('div');
    guideBox.id = 'bdp-guide';
    guideBox.style.cssText =
        'padding: 8px 10px; border-bottom: 1px solid #333; flex-shrink: 0; display: none;' +
        'background: #2a2a1f; color: #e8d98a; line-height: 1.65;';
    body.appendChild(guideBox);

    /**
     * 設定操作指引。傳入字串陣列，會自動編號；傳入空值則隱藏整區。
     * 供探針區塊在 PROBE_SETUP 之外的頂層呼叫，面板一出現就看得到。
     */
    function guide(steps) {
        if (!steps || !steps.length) { guideBox.style.display = 'none'; return; }
        guideBox.style.display = '';
        guideBox.textContent = '';
        const title = document.createElement('div');
        title.style.cssText = 'font-weight: 600; margin-bottom: 4px; color: #f5e6a3;';
        title.textContent = '操作步驟';
        guideBox.appendChild(title);
        steps.forEach((s, i) => {
            const line = document.createElement('div');
            line.textContent = `${i + 1}. ${s}`;
            guideBox.appendChild(line);
        });
    }

    const countLine = document.createElement('div');
    countLine.id = 'bdp-count';
    countLine.style.cssText = 'padding: 4px 10px; color: #999; flex-shrink: 0;';
    countLine.textContent = '尚未開始 · 0 筆';
    body.appendChild(countLine);

    const logView = document.createElement('div');
    logView.id = 'bdp-log';
    logView.style.cssText = `
        overflow-y: auto; padding: 6px 10px; white-space: pre-wrap;
        word-break: break-word; font-family: monospace; flex: 1;
    `;
    body.appendChild(logView);

    document.documentElement.appendChild(panel);

    function btnStyle(primary) {
        return `
            padding: 3px 10px; font-size: 12px; cursor: pointer;
            border: none; border-radius: 4px; color: #fff;
            background: ${primary ? '#2e7d32' : '#3a3a3a'};
        `;
    }

    // ── 摺疊 ─────────────────────────────────────────────────────────────
    let collapsed = false;
    collapseBtn.addEventListener('click', () => {
        collapsed = !collapsed;
        body.style.display = collapsed ? 'none' : 'flex';
        collapseBtn.textContent = collapsed ? '＋' : '－';
    });

    // ── 拖曳（不持久化位置，每次重新整理頁面即重置，符合本次確認的規格）───────
    (function makeDraggable() {
        let dragging = false, offsetX = 0, offsetY = 0;
        header.addEventListener('mousedown', (e) => {
            if (e.target === collapseBtn) return; // 摺疊鈕自己的點擊不該觸發拖曳
            dragging = true;
            const rect = panel.getBoundingClientRect();
            offsetX = e.clientX - rect.left;
            offsetY = e.clientY - rect.top;
        });
        document.addEventListener('mousemove', (e) => {
            if (!dragging) return;
            panel.style.left = `${e.clientX - offsetX}px`;
            panel.style.top = `${e.clientY - offsetY}px`;
            panel.style.right = 'auto'; // 一旦拖曳過就改用 left 定位，取消原本的 right 錨點
        });
        document.addEventListener('mouseup', () => { dragging = false; });
    })();

    // ── 開始 / 停止 ──────────────────────────────────────────────────────
    startStopBtn.addEventListener('click', () => {
        if (!isMonitoring) {
            isMonitoring = true;
            startTimeMs = Date.now();
            LOG.length = 0;
            logView.textContent = '';
            startStopBtn.textContent = '停止監控';
            startStopBtn.style.background = '#c62828';
            updateCount();
            PROBE_SETUP();
        } else {
            isMonitoring = false;
            startStopBtn.textContent = '開始監控';
            startStopBtn.style.background = '#2e7d32';
            PROBE_TEARDOWN();
        }
    });

    clearBtn.addEventListener('click', () => {
        LOG.length = 0;
        logView.textContent = '';
        updateCount();
    });

    function updateCount() {
        countLine.textContent = `${isMonitoring ? '監控中' : '已停止'} · ${LOG.length} 筆`;
    }

    function renderNewestEntry(t, tag, text) {
        const line = document.createElement('div');
        line.textContent = `[${t}s] ${tag} | ${text}`;
        line.style.marginBottom = '4px';
        logView.appendChild(line);
        logView.scrollTop = logView.scrollHeight;
    }

    // ── 一鍵複製（含環境資訊，clipboard API 失敗時 fallback 到 textarea）────
    copyBtn.addEventListener('click', () => {
        const header_ = [
            `時間：${new Date().toLocaleString()}`,
            `網址：${location.href}`,
            `UA：${navigator.userAgent}`,
            `===== 開始 =====`,
        ].join('\n');
        const body_ = LOG.map(e => `[${e.t}s] ${e.tag} | ${e.text}`).join('\n');
        const fullText = `${header_}\n${body_}\n===== 結束 =====`;

        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(fullText).then(
                () => flashCopyBtn('已複製'),
                () => fallbackCopy(fullText)
            );
        } else {
            fallbackCopy(fullText);
        }
    });

    function fallbackCopy(text) {
        // clipboard API 在非 https 頁面或權限被拒時會失敗，
        // 用隱藏 textarea + execCommand('copy') 當備援，這是瀏覽器擴充功能常見的相容寫法
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        try {
            document.execCommand('copy');
            flashCopyBtn('已複製');
        } catch {
            flashCopyBtn('複製失敗');
        }
        document.body.removeChild(ta);
    }

    function flashCopyBtn(msg) {
        const original = copyBtn.textContent;
        copyBtn.textContent = msg;
        setTimeout(() => { copyBtn.textContent = original; }, 1200);
    }

    // ─────────────────────────────────────────────────────────────────────
    // ▼▼▼ 探針區塊（每次診斷替換這裡，其餘骨架不動）▼▼▼
    //
    // PROBE_SETUP()：按下「開始監控」時呼叫，在這裡建立 MutationObserver、
    //                事件監聽、輪詢等，觀察到事件時呼叫 log(tag, content) 記錄。
    // PROBE_TEARDOWN()：按下「停止監控」時呼叫，負責 disconnect / removeEventListener，
    //                    避免監控停止後探針仍在背景運作。
    //
    // 下面留兩個最常用的探針型態當範本（來自本 Project 過往診斷的高頻用法）：
    // watch：觀察某元素的某個 CSS 屬性變化（例如 display）
    // probe：讀取某元素的資料路徑（同時支援 Polymer .data 與新框架 rawProps.data() 兩種存取方式）
    // 實際使用時，把不需要的範本刪掉，或整段替換成任務專屬邏輯即可。
    // ─────────────────────────────────────────────────────────────────────

    let _bdpObservers = [];
    let _restore = [];

    // ── 目前任務：點路線會冒出「111臺北市士林區福志里福林路」那種名稱，
    //            找出背後的請求，看能不能改成用我們自己的座標直接呼叫 ──
    //
    // 目的不是「能不能點得動」，而是要看清楚請求的格式：
    //   ・網址與參數長什麼樣、座標放在哪一段
    //   ・是否只換座標就能重用（若綁了 session 或簽章就不通）
    //   ・回應裡那串名稱在哪個位置
    //
    // 攔截器裝在 unsafeWindow 上：本腳本用了 GM_* 授權而跑在沙箱，
    // 改沙箱的 fetch/XHR 只會動到副本，攔不到網頁真正發出的請求。

    const W = (typeof unsafeWindow !== 'undefined' && unsafeWindow) || window;
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const MAX_KEEP = 12;
    let _hits = [];
    let _armed = false;

    /** 這個回應裡有沒有「看起來像地址」的字串 */
    function findAddressLike(text) {
        // 台灣地址的特徵：郵遞區號＋縣市＋區＋里/路。取最長的幾筆當代表
        const re = /[\u4e00-\u9fa5\d]{0,6}[縣市][\u4e00-\u9fa5]{1,4}[區鄉鎮市][\u4e00-\u9fa5\d]{2,20}/g;
        const found = [...new Set(text.match(re) || [])];
        return found.sort((a, b) => b.length - a.length).slice(0, 5);
    }

    function record(kind, url, body, text) {
        if (!_armed || _hits.length >= MAX_KEEP) return;
        const addrs = findAddressLike(text || '');
        if (!addrs.length) return;                    // 沒有地址樣式就不是我們要的
        const item = { kind, url: String(url), body: body || null, text, addrs };
        _hits.push(item);
        const short = String(url).replace(/^https?:\/\/[^/]+/, '');
        log(`捕捉 #${_hits.length}`,
            `${kind}　${(text.length / 1024).toFixed(1)}KB\n` +
            `      路徑：${short.slice(0, 150)}\n` +
            `      疑似地址：${addrs.join('　│　')}`);
    }

    function armInterceptors() {
        const XHR = W.XMLHttpRequest;
        const origOpen = XHR.prototype.open;
        const origSend = XHR.prototype.send;
        XHR.prototype.open = function (m, u) { this.__u = u; this.__m = m; return origOpen.apply(this, arguments); };
        XHR.prototype.send = function (b) {
            this.addEventListener('load', () => {
                try { record('XHR ' + (this.__m || ''), this.__u, b, this.responseText); } catch (err) { /* 非文字回應 */ }
            });
            return origSend.apply(this, arguments);
        };
        _restore.push(() => { XHR.prototype.open = origOpen; XHR.prototype.send = origSend; });

        const origFetch = W.fetch;
        W.fetch = function (...a) {
            const url = (a[0] && a[0].url) || a[0];
            const body = a[1] && a[1].body;
            return origFetch.apply(this, a).then(res => {
                res.clone().text().then(t => record('fetch', url, body, t)).catch(() => {});
                return res;
            });
        };
        _restore.push(() => { W.fetch = origFetch; });
    }

    guide([
        '在地圖上找到路線（那條藍色粗線）',
        '按下方的「開始監控」',
        '用滑鼠點一下路線上的任一點，等下方彈出地點名稱',
        '想多看幾個點可以再點幾次（最多記錄 12 筆）',
        '按「停止監控」，再按「複製」',
    ]);

    function PROBE_SETUP() {
        _hits = [];
        _armed = true;
        armInterceptors();
        log('START', '攔截器已就位。請點一下地圖上的路線，只會記錄「回應裡含台灣地址樣式」的請求。');
    }

    function PROBE_TEARDOWN() {
        _armed = false;
        if (_hits.length) {
            // 把最有希望的那一筆完整攤開：格式看得清楚才判斷得出能不能重用
            const best = _hits.slice().sort((a, b) => b.addrs[0].length - a.addrs[0].length)[0];
            log('最有希望的一筆', `${best.kind}\n      完整網址：${best.url.slice(0, 600)}` +
                (best.body ? `\n      請求內容：${String(best.body).slice(0, 400)}` : ''));
            const idx = best.text.indexOf(best.addrs[0]);
            log('名稱在回應中的位置', `字元位置 ${idx}／全長 ${best.text.length}\n` +
                `      前後文：…${best.text.slice(Math.max(0, idx - 160), idx + 160)}…`);
            log('提示', '完整內容留在 window.__rrHits，可用 __rrHits[N].text 取出');
            W.__rrHits = _hits;
        } else {
            log('結果', '沒有捕捉到含地址的回應。可能是點在路線之外，或該資訊來自已載入的資料而非新請求。');
        }
        _restore.forEach(fn => { try { fn(); } catch (err) { /* 還原失敗不影響停止 */ } });
        _restore = [];
        _bdpObservers.forEach(mo => mo.disconnect());
        _bdpObservers = [];
        log('STOP', '監控停止');
    }

})();
