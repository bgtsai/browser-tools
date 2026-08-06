// ==UserScript==
// @name         通用診斷面板骨架
// @namespace    browser-tools
// @version      5.0
// @description  診斷面板骨架：面板 UI + 相對時間戳 + 開始/停止 + 一鍵複製；任務專屬邏輯只需替換「探針區塊」。目前任務：量出 Google 節點的位置與它點擊後的縮放層級
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

    // ── 要量兩件事 ──
    //
    // ① 地圖上那些白色圓點，跟我們解析出來的 step 邊界是不是同一組？
    //    我先前一律說成「轉彎處」，但 step 的切分原因不只轉彎——匯流、
    //    道路改名、進出匝道都可能切一段。而「地圖上畫的點」與「資料裡的 step 邊界」
    //    是否一一對應，我從來沒有驗證過。對不上的話，用 step 邊界去避開就是無效的。
    //
    // ② 點到那種節點時，Google 自動縮放到哪一級？
    //    量出來就有客觀依據可以決定我們的最終層級，不必憑感覺猜。
    //
    // 做法：攔截 directions 取得 step 邊界的座標（與 route-rain 同一套解析），
    // 再請使用者手動點幾個節點，記錄每次的縮放變化與該點離最近 step 邊界多遠。

    const W = (typeof unsafeWindow !== 'undefined' && unsafeWindow) || window;
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    let _boundaries = null;     // step 邊界的 [lat, lon] 陣列
    let _pending = null;

    function viewport() {
        const m = location.href.match(/\/@(-?[\d.]+),(-?[\d.]+),([\d.]+)z/);
        return m ? { lat: +m[1], lon: +m[2], zoom: +m[3] } : null;
    }
    function metres(a, b, c, d) {
        const R = 6371000, p = Math.PI / 180;
        const dla = (c - a) * p, dlo = (d - b) * p;
        const h = Math.sin(dla / 2) ** 2 + Math.cos(a * p) * Math.cos(c * p) * Math.sin(dlo / 2) ** 2;
        return 2 * R * Math.asin(Math.sqrt(h));
    }

    /** 與 route-rain 相同的解析：累加差分座標，並依 step 的公尺數切出邊界 */
    function parseBoundaries(text) {
        const root = JSON.parse(text.replace(/^\)\]\}'\n?/, ''));
        const alts = root[0] && root[0][1], geos = root[0] && root[0][7];
        if (!Array.isArray(alts) || !Array.isArray(geos) || !alts.length) return null;
        const segments = (alts[0][1] || []).filter(s => Array.isArray(s));
        const steps = [];
        for (const seg of segments) {
            for (const leg of (seg[1] || [])) {
                for (const st of (leg[1] || [])) {
                    steps.push((st[0] && st[0][2] && st[0][2][0]) || 0);
                }
            }
        }
        const acc = a => { let s = 0; return a.map(v => (s += v)); };
        const lat = acc(geos[0][0]).map(v => v / 1e7);
        const lon = acc(geos[0][1]).map(v => v / 1e7);
        // 每個點的累積距離
        const cum = [0];
        for (let i = 1; i < lat.length; i++) {
            cum.push(cum[i - 1] + metres(lat[i - 1], lon[i - 1], lat[i], lon[i]));
        }
        const total = cum[cum.length - 1] || 1;
        const declared = steps.reduce((s, v) => s + v, 0) || total;
        const scale = total / declared;
        // step 邊界 → 對應到座標
        const out = [];
        let target = 0, k = 0;
        for (const m of steps) {
            target += m * scale;
            while (k < cum.length - 1 && cum[k] < target) k++;
            out.push([lat[k], lon[k]]);
        }
        return { boundaries: out, stepCount: steps.length, points: lat.length };
    }

    function armCapture() {
        const XHR = W.XMLHttpRequest;
        const oOpen = XHR.prototype.open, oSend = XHR.prototype.send;
        XHR.prototype.open = function (m, u) { this.__u = u; return oOpen.apply(this, arguments); };
        XHR.prototype.send = function () {
            this.addEventListener('load', () => {
                try { onResponse(this.__u, this.responseText); } catch (err) { /* 非文字回應 */ }
            });
            return oSend.apply(this, arguments);
        };
        _restore.push(() => { XHR.prototype.open = oOpen; XHR.prototype.send = oSend; });
        const oFetch = W.fetch;
        W.fetch = function (...a) {
            const u = (a[0] && a[0].url) || a[0];
            return oFetch.apply(this, a).then(r => {
                r.clone().text().then(t => onResponse(u, t)).catch(() => {});
                return r;
            });
        };
        _restore.push(() => { W.fetch = oFetch; });
    }

    function onResponse(url, text) {
        const u = String(url);
        if (u.indexOf('/maps/preview/directions') >= 0 && !_boundaries && text && text.length > 1000) {
            const r = parseBoundaries(text);
            if (r) {
                _boundaries = r.boundaries;
                log('①已取得 step 邊界', `${r.stepCount} 個 step、路徑 ${r.points} 點　` +
                    '接下來請手動點地圖上的白色圓點');
            }
        }
        if (_pending && u.indexOf('/maps/preview/reveal') >= 0) _pending.reveal = true;
    }

    /** 使用者按下時記錄，2.5 秒後比對縮放與距離 */
    function watchClicks() {
        const onDown = (ev) => {
            if (!ev.isTrusted || !ev.target || ev.target.tagName !== 'CANVAS') return;
            const vp0 = viewport();
            const r = ev.target.getBoundingClientRect();
            _pending = { vp0, x: ev.clientX, y: ev.clientY, rect: r, reveal: false };
            setTimeout(report, 2500);
        };
        document.addEventListener('pointerdown', onDown, true);
        _restore.push(() => document.removeEventListener('pointerdown', onDown, true));
    }

    function report() {
        if (!_pending) return;
        const p = _pending; _pending = null;
        const vp1 = viewport();
        if (!p.vp0 || !vp1) { log('量測', '讀不到視野'); return; }

        // 由點擊的螢幕位置反推經緯度（以點擊當下的視野換算）
        const world = 256 * Math.pow(2, p.vp0.zoom);
        const cx = (p.vp0.lon + 180) / 360 * world;
        const s = Math.sin(p.vp0.lat * Math.PI / 180);
        const cy = (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * world;
        const px = cx + (p.x - (p.rect.left + p.rect.width / 2));
        const py = cy + (p.y - (p.rect.top + p.rect.height / 2));
        const lon = px / world * 360 - 180;
        const n = Math.PI - 2 * Math.PI * py / world;
        const lat = 180 / Math.PI * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));

        let near = '（尚未取得 step 邊界）';
        if (_boundaries) {
            let best = Infinity, idx = -1;
            _boundaries.forEach((b, i) => {
                const d = metres(lat, lon, b[0], b[1]);
                if (d < best) { best = d; idx = i; }
            });
            near = `離最近的 step 邊界 ${best.toFixed(0)} 公尺（第 ${idx + 1} 個）`;
        }
        const dz = +(vp1.zoom - p.vp0.zoom).toFixed(2);
        log('量測結果',
            `點擊處 ${lat.toFixed(6)}, ${lon.toFixed(6)}\n` +
            `      ${near}\n` +
            `      縮放 ${p.vp0.zoom} → ${vp1.zoom}（${dz >= 0 ? '+' : ''}${dz} 級）` +
            (Math.abs(dz) > 0.05 ? '　←自動縮放了' : '　←沒有縮放') + '\n' +
            `      reveal 請求：${p.reveal ? '有（出現地點卡）' : '無（沒有出現地點卡）'}`);
    }

    guide([
        '先切換一次交通方式，讓頁面重新要一次路線資料（才拿得到 step 邊界）',
        '按「開始監控」',
        '在地圖上找路線的白色圓點，點它，等 2.5 秒看結果',
        '再點幾個「不是圓點」的路線位置作為對照',
        '至少各點 3 次後按「複製」貼回',
    ]);

    function PROBE_SETUP() {
        _boundaries = null; _pending = null;
        armCapture();
        watchClicks();
        log('START', '已就緒。若下方沒出現「已取得 step 邊界」，請切換一次交通方式。');
    }

    function PROBE_TEARDOWN() {
        _pending = null;
        _restore.forEach(fn => { try { fn(); } catch (err) { /* 還原失敗不影響停止 */ } });
        _restore = [];
        _bdpObservers.forEach(mo => mo.disconnect());
        _bdpObservers = [];
        log('STOP', '監控停止');
    }

})();
