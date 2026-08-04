// ==UserScript==
// @name         通用診斷面板骨架
// @namespace    browser-tools
// @version      2.1
// @description  診斷面板骨架：面板 UI + 相對時間戳 + 開始/停止 + 一鍵複製；任務專屬邏輯只需替換「探針區塊」。目前任務：驗證拖曳的補償公式
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

    // ── 目前任務：驗證補償公式 S = dx × N/(N−1) 能否讓拖曳精準到位 ──
    //
    // 已確立的事實（上一輪三個資料點、零誤差）：
    //   拖曳分 N 格送出時，**第一格的位移不會被套用**，實際到位 = 送出量 × (N−1)/N
    //   8 格 → 87.5%（7/8）　16 格 → 93.8%（15/16）　32 格 → 97.0%（31/32）
    //
    // 因此要讓實際到位等於目標 dx，送出量應為 dx × N/(N−1)。
    // 本輪驗證這個公式在不同格數、不同距離、不同縮放層級下都成立。
    //
    // 判讀條件這次設**雙邊**：|達成率 − 100| ≤ 2 才算通過。
    // 上一輪寫成 pct >= 98 而沒有上限，結果把 112.5% 也判成「接近 100%」——
    // 判斷條件比實際要求寬鬆，等於沒有檢查。

    const W = (typeof unsafeWindow !== 'undefined' && unsafeWindow) || window;
    const POINTER_ID = 10088;
    const FRAME_MS = 16;
    const sleep = ms => new Promise(r => setTimeout(r, ms));

    function viewport() {
        const m = location.href.match(/\/@(-?[\d.]+),(-?[\d.]+),([\d.]+)z/);
        return m ? { lat: +m[1], lon: +m[2], zoom: +m[3] } : null;
    }
    const vpKey = () => (location.href.match(/\/@[^/]+/) || [''])[0];
    function ctrlPoints() {
        return ((location.href.match(/\/data=([^?]+)/) || [''])[1].match(/3m4/g) || []).length;
    }
    function projectPx(lat, lon, zoom) {
        const world = 256 * Math.pow(2, zoom);
        const s = Math.sin(lat * Math.PI / 180);
        return { x: (lon + 180) / 360 * world,
                 y: (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * world };
    }
    function shiftPx(a, b) {
        if (!a || !b) return 0;
        const p1 = projectPx(a.lat, a.lon, a.zoom);
        const p2 = projectPx(b.lat, b.lon, a.zoom);
        return Math.round(Math.hypot(p2.x - p1.x, p2.y - p1.y));
    }
    /** 網址落後真實視野，所以它一變就代表動作已完成 */
    async function waitUrlChange(prevKey, timeoutMs) {
        const t0 = performance.now();
        while (performance.now() - t0 < (timeoutMs || 5000)) {
            if (vpKey() !== prevKey) { await sleep(300); return Math.round(performance.now() - t0); }
            await sleep(60);
        }
        return -1;
    }
    function mapCanvas() {
        return [...document.querySelectorAll('canvas')]
            .map(el => ({ el, r: el.getBoundingClientRect() }))
            .filter(o => o.r.width > 200 && o.r.height > 200)
            .sort((a, b) => b.r.width * b.r.height - a.r.width * a.r.height)[0] || null;
    }
    /** 事件建構子一律取自 unsafeWindow：沙箱建立的事件網頁不一定認得 */
    function fire(target, mouseType, pointerType, opts) {
        const ME = W.MouseEvent || MouseEvent;
        const PE = W.PointerEvent || PointerEvent;
        target.dispatchEvent(new ME(mouseType, opts));
        target.dispatchEvent(new PE(pointerType, Object.assign(
            { pointerId: POINTER_ID, isPrimary: true, pointerType: 'mouse' }, opts)));
    }

    /**
     * 拖曳。compensate=true 時把送出量放大為 dx × N/(N−1)，
     * 抵銷「第一格不被套用」的損失。
     */
    async function drag(canvas, dx, dy, frames, compensate) {
        const factor = compensate ? frames / (frames - 1) : 1;
        const sx = dx * factor, sy = dy * factor;
        const r = canvas.getBoundingClientRect();
        // 往左拖就從右側按下，行程才夠；反之亦然
        const x = r.left + r.width * (sx < 0 ? 0.78 : 0.22);
        const y = r.top + r.height * 0.5;
        const base = { bubbles: true, cancelable: true, view: W, button: 0, buttons: 1 };
        fire(canvas, 'mousedown', 'pointerdown',
            Object.assign({}, base, { detail: 1, clientX: x, clientY: y }));
        for (let i = 1; i <= frames; i++) {
            fire(canvas, 'mousemove', 'pointermove', Object.assign({}, base,
                { cancelable: false, detail: 88,
                  clientX: x + sx * i / frames, clientY: y + sy * i / frames }));
            await sleep(FRAME_MS);
        }
        const ex = x + sx, ey = y + sy;
        // 放開前在原位再送一次 move：速度歸零，不觸發慣性滑行
        fire(canvas, 'mousemove', 'pointermove',
            Object.assign({}, base, { cancelable: false, detail: 88, clientX: ex, clientY: ey }));
        fire(canvas, 'mouseup', 'pointerup',
            Object.assign({}, base, { detail: 1, buttons: 0, clientX: ex, clientY: ey }));
    }

    /** 拖過去量一次，再拖回來復位，避免位置漂移影響下一輪 */
    async function measure(canvas, dxPx, frames, compensate) {
        const v0 = viewport(), key0 = vpKey();
        await drag(canvas, dxPx, 0, frames, compensate);
        await waitUrlChange(key0, 5000);
        const moved = shiftPx(v0, viewport());
        await sleep(300);
        const keyBack = vpKey();
        await drag(canvas, -dxPx, 0, frames, compensate);
        await waitUrlChange(keyBack, 5000);
        await sleep(300);
        return { moved, pct: Math.round(moved / Math.abs(dxPx) * 1000) / 10 };
    }

    /** |達成率 − 100| ≤ 2 才算通過——雙邊判斷，超過與不足都不行 */
    const verdict = pct => (Math.abs(pct - 100) <= 2 ? '✅' : '❌');

    async function wheelZoom(canvas, levels) {
        const WE = W.WheelEvent || WheelEvent;
        const r = canvas.getBoundingClientRect();
        const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
        const events = Math.max(1, Math.round(Math.abs(levels) / 0.32));
        const key0 = vpKey();
        for (let i = 0; i < events; i++) {
            canvas.dispatchEvent(new WE('wheel', {
                bubbles: true, cancelable: true, view: W,
                clientX: cx, clientY: cy, deltaY: (levels > 0 ? -120 : 120), deltaMode: 0,
            }));
            await sleep(50);            // 實測：低於 30ms 會被整批忽略
        }
        // 上一輪就是縮放後只等 900ms 就開始拖曳，量到動畫還沒結束的混合結果。
        // 這次等網址真的改變，再多留一段時間讓動畫完全停下。
        await waitUrlChange(key0, 5000);
        await sleep(800);
    }

    async function runAll() {
        const canvas = mapCanvas();
        if (!canvas) { log('錯誤', '找不到地圖畫布'); return; }
        log('環境', `畫布 ${Math.round(canvas.r.width)}x${Math.round(canvas.r.height)}　` +
            `視野 ${JSON.stringify(viewport())}　控制點 ${ctrlPoints()} 個`);

        const results = [];

        log('──', '① 不同格數（要求 400px，已補償）');
        for (const frames of [8, 16, 32]) {
            const r = await measure(canvas.el, -400, frames, true);
            results.push(r.pct);
            log(`①${frames} 格`, `送出 ${Math.round(400 * frames / (frames - 1))}px　` +
                `實際 ${r.moved}px　達成率 ${r.pct}%　${verdict(r.pct)}`);
        }

        log('──', '② 不同距離（16 格，已補償）');
        for (const dist of [150, 700]) {
            const r = await measure(canvas.el, -dist, 16, true);
            results.push(r.pct);
            log(`②${dist}px`, `實際 ${r.moved}px　達成率 ${r.pct}%　${verdict(r.pct)}`);
        }

        log('──', '③ 換縮放層級（16 格，已補償）');
        await wheelZoom(canvas.el, -2);
        const zoomed = viewport();
        const r3 = await measure(canvas.el, -400, 16, true);
        results.push(r3.pct);
        log('③縮小 2 級後', `zoom=${zoomed ? zoomed.zoom : '?'}　實際 ${r3.moved}px　` +
            `達成率 ${r3.pct}%　${verdict(r3.pct)}`);
        await wheelZoom(canvas.el, 2);

        const worst = Math.max(...results.map(p => Math.abs(p - 100)));
        log('總結', worst <= 2
            ? `✅ 全部通過，最大偏離 ${Math.round(worst * 10) / 10}% → 補償公式成立，可套入 route-rain`
            : `❌ 最大偏離 ${Math.round(worst * 10) / 10}%，公式在某些情況下不成立，需再分析`);
        log('④副作用', ctrlPoints() === 0 ? '路線未被改動 ✅' : '⚠️ 路線的途經點數改變了');
        log('DONE', '測試完成，請按「停止監控」後複製。');
    }

    function PROBE_SETUP() {
        log('START', '開始驗證補償公式，全程約 90 秒，請勿操作頁面。');
        runAll().catch(err => log('錯誤', err.message + '\n      ' + String(err.stack || '').slice(0, 200)));
    }

    function PROBE_TEARDOWN() {
        _bdpObservers.forEach(mo => mo.disconnect());
        _bdpObservers = [];
        log('STOP', '監控停止');
    }

})();
