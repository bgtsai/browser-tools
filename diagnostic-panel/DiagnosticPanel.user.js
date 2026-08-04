// ==UserScript==
// @name         通用診斷面板骨架
// @namespace    browser-tools
// @version      2.2
// @description  診斷面板骨架：面板 UI + 相對時間戳 + 開始/停止 + 一鍵複製；任務專屬邏輯只需替換「探針區塊」。目前任務：找出讓拖曳穩定到位的參數組合
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

    // ── 目前任務：找出讓拖曳「穩定」到位的參數組合 ──
    //
    // 已確立：第一格的位移不被套用，補償公式 S = dx × N/(N−1) 在成功時精準到個位數
    //         （400/400、150/150、700/700），所以公式本身是對的。
    //
    // 但同樣 16 格，有時 100%、有時 129% ——有東西間歇性地「多加」了位移，
    // 最可能是**慣性滑行**：放開瞬間若仍有速度，地圖會繼續滑。
    //
    // 上一輪的測試有個方法錯誤：探針用**等速**直線拖曳，
    // 而 route-rain 實際用 **easeInOutCubic 緩動**——兩者放開瞬間的速度完全不同。
    // 測試的動作曲線與真實實作不一致，結果本來就不能直接套用。
    // （與先前「Console 環境 vs 沙箱環境」是同一類錯誤：驗證條件必須與實際一致。）
    //
    // 本輪對照四組：{等速, 緩動} × {結尾 1 個零速樣本, 結尾 3 個}
    // 每組重複三次，看的不只是平均，更是**變異**——穩定比準確更重要，
    // 因為只要穩定，剩下的偏差都可以用係數補掉。

    const W = (typeof unsafeWindow !== 'undefined' && unsafeWindow) || window;
    const POINTER_ID = 10088;
    const FRAME_MS = 16;
    const FRAMES = 16;
    const DIST = 400;
    const REPEATS = 3;
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
    async function waitUrlChange(prevKey, timeoutMs) {
        const t0 = performance.now();
        while (performance.now() - t0 < (timeoutMs || 5000)) {
            if (vpKey() !== prevKey) { await sleep(300); return Math.round(performance.now() - t0); }
            await sleep(60);
        }
        return -1;
    }
    /** 等到視野連續兩次讀值相同才算真的停下——避免慣性還沒結束就開始下一輪 */
    async function waitSettled(timeoutMs) {
        const t0 = performance.now();
        let last = null;
        while (performance.now() - t0 < (timeoutMs || 3000)) {
            const k = vpKey();
            if (k === last) return;
            last = k;
            await sleep(250);
        }
    }
    function mapCanvas() {
        return [...document.querySelectorAll('canvas')]
            .map(el => ({ el, r: el.getBoundingClientRect() }))
            .filter(o => o.r.width > 200 && o.r.height > 200)
            .sort((a, b) => b.r.width * b.r.height - a.r.width * a.r.height)[0] || null;
    }
    function fire(target, mouseType, pointerType, opts) {
        const ME = W.MouseEvent || MouseEvent;
        const PE = W.PointerEvent || PointerEvent;
        target.dispatchEvent(new ME(mouseType, opts));
        target.dispatchEvent(new PE(pointerType, Object.assign(
            { pointerId: POINTER_ID, isPrimary: true, pointerType: 'mouse' }, opts)));
    }

    const easeInOutCubic = t => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

    /**
     * @param eased      true=easeInOutCubic（與 route-rain 相同），false=等速
     * @param tailFrames 結尾在終點原地補送幾次 move，用來把速度樣本填成零
     */
    async function drag(canvas, dx, eased, tailFrames) {
        const sx = dx * FRAMES / (FRAMES - 1);      // 補償「第一格不被套用」
        const r = canvas.getBoundingClientRect();
        const x = r.left + r.width * (sx < 0 ? 0.78 : 0.22);
        const y = r.top + r.height * 0.5;
        const base = { bubbles: true, cancelable: true, view: W, button: 0, buttons: 1 };
        const move = (cx) => fire(canvas, 'mousemove', 'pointermove',
            Object.assign({}, base, { cancelable: false, detail: 88, clientX: cx, clientY: y }));

        fire(canvas, 'mousedown', 'pointerdown',
            Object.assign({}, base, { detail: 1, clientX: x, clientY: y }));
        for (let i = 1; i <= FRAMES; i++) {
            const t = i / FRAMES;
            move(x + sx * (eased ? easeInOutCubic(t) : t));
            await sleep(FRAME_MS);
        }
        const ex = x + sx;
        for (let k = 0; k < tailFrames; k++) { move(ex); await sleep(FRAME_MS); }
        fire(canvas, 'mouseup', 'pointerup',
            Object.assign({}, base, { detail: 1, buttons: 0, clientX: ex, clientY: y }));
    }

    async function measureOnce(canvas, eased, tailFrames) {
        await waitSettled(3000);
        const v0 = viewport(), key0 = vpKey();
        await drag(canvas, -DIST, eased, tailFrames);
        await waitUrlChange(key0, 5000);
        await waitSettled(3000);
        const moved = shiftPx(v0, viewport());
        // 拖回原位，同樣等它完全停下
        const keyBack = vpKey();
        await drag(canvas, DIST, eased, tailFrames);
        await waitUrlChange(keyBack, 5000);
        await waitSettled(3000);
        return Math.round(moved / DIST * 1000) / 10;
    }

    async function runGroup(canvas, label, eased, tailFrames) {
        const pcts = [];
        for (let i = 0; i < REPEATS; i++) pcts.push(await measureOnce(canvas, eased, tailFrames));
        const avg = Math.round(pcts.reduce((a, b) => a + b, 0) / pcts.length * 10) / 10;
        const spread = Math.round((Math.max(...pcts) - Math.min(...pcts)) * 10) / 10;
        // 穩定優先：變異小就算平均偏離，也能用固定係數補掉
        const stable = spread <= 3;
        const accurate = Math.abs(avg - 100) <= 2;
        log(label, `三次 ${pcts.join('%, ')}%　平均 ${avg}%　變異 ${spread}%　` +
            (stable && accurate ? '✅ 穩定且準確'
                : stable ? `⚠️ 穩定但偏離 ${Math.round((avg - 100) * 10) / 10}%（可用係數補）`
                    : '❌ 不穩定'));
        return { label, avg, spread, stable, accurate };
    }

    async function runAll() {
        const canvas = mapCanvas();
        if (!canvas) { log('錯誤', '找不到地圖畫布'); return; }
        log('環境', `畫布 ${Math.round(canvas.r.width)}x${Math.round(canvas.r.height)}　` +
            `視野 ${JSON.stringify(viewport())}　控制點 ${ctrlPoints()} 個　` +
            `固定 ${FRAMES} 格、${DIST}px、已補償`);

        const groups = [];
        groups.push(await runGroup(canvas.el, '①等速＋結尾 1 格', false, 1));
        groups.push(await runGroup(canvas.el, '②等速＋結尾 3 格', false, 3));
        groups.push(await runGroup(canvas.el, '③緩動＋結尾 1 格', true, 1));
        groups.push(await runGroup(canvas.el, '④緩動＋結尾 3 格', true, 3));

        const best = groups.slice().sort((a, b) =>
            (a.spread - b.spread) || (Math.abs(a.avg - 100) - Math.abs(b.avg - 100)))[0];
        log('總結', `最穩定的是「${best.label}」：平均 ${best.avg}%、變異 ${best.spread}%\n` +
            '      ' + (best.stable
                ? (best.accurate ? '→ 直接採用這組參數'
                    : `→ 採用這組，並在補償公式再乘上 ${Math.round(100 / best.avg * 1000) / 1000}`)
                : '→ 四組都不穩定，慣性不是唯一原因，需再找變數'));
        log('④副作用', ctrlPoints() === 0 ? '路線未被改動 ✅' : '⚠️ 路線的途經點數改變了');
        log('DONE', '測試完成，請按「停止監控」後複製。');
    }

    function PROBE_SETUP() {
        log('START', '開始測試四組參數，全程約 2 分鐘，請勿操作頁面。');
        runAll().catch(err => log('錯誤', err.message + '\n      ' + String(err.stack || '').slice(0, 200)));
    }

    function PROBE_TEARDOWN() {
        _bdpObservers.forEach(mo => mo.disconnect());
        _bdpObservers = [];
        log('STOP', '監控停止');
    }

})();
