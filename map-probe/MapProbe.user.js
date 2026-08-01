// ==UserScript==
// @name         地圖操作手段測試
// @namespace    browser-tools
// @version      1.0
// @description  在與 route-rain 相同的沙箱環境下，逐一測試八種地圖移動與縮放手段是否可用
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

    // ── 目的 ──
    // 一次測完所有可能的地圖操作手段，產出「哪些能用」的清單。
    //
    // 關鍵設計：本腳本的 @grant 與 route-rain 完全相同，因此跑在同一種沙箱環境。
    // 先前多次踩到「在 Console（網頁環境）測試成功、寫進沙箱腳本卻無效」——
    // 攔截器、pointer 事件建構子、滾輪縮放都栽在這一點上。
    // 環境不一致的驗證，通過了也不代表什麼。

    const W = (typeof unsafeWindow !== 'undefined' && unsafeWindow) || window;
    const sleep = ms => new Promise(r => setTimeout(r, ms));

    function viewport() {
        const m = location.href.match(/\/@(-?[\d.]+),(-?[\d.]+),([\d.]+)z/);
        return m ? { lat: +m[1], lon: +m[2], zoom: +m[3] } : null;
    }
    function routeKey() {
        return (location.href.match(/\/data=([^?]+)/) || [])[1] || '';
    }
    function ctrlPoints() {
        return (routeKey().match(/3m4/g) || []).length;
    }
    function mapCanvas() {
        return [...document.querySelectorAll('canvas')]
            .map(el => ({ el, r: el.getBoundingClientRect() }))
            .filter(o => o.r.width > 200 && o.r.height > 200)
            .sort((a, b) => b.r.width * b.r.height - a.r.width * a.r.height)[0] || null;
    }
    function projectPx(lat, lon, zoom) {
        const world = 256 * Math.pow(2, zoom);
        const s = Math.sin(lat * Math.PI / 180);
        return { x: (lon + 180) / 360 * world,
                 y: (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * world };
    }
    /** 兩個視野之間的像素位移（以第一個視野的縮放層級計） */
    function shiftPx(a, b) {
        if (!a || !b) return null;
        const p1 = projectPx(a.lat, a.lon, a.zoom);
        const p2 = projectPx(b.lat, b.lon, a.zoom);
        return Math.round(Math.hypot(p2.x - p1.x, p2.y - p1.y));
    }

    function fire(target, type, x, y, buttons, extra) {
        const Ctor = type.startsWith('pointer') ? (W.PointerEvent || PointerEvent)
                   : type === 'wheel' ? (W.WheelEvent || WheelEvent)
                   : (W.MouseEvent || MouseEvent);
        const init = Object.assign({
            bubbles: true, cancelable: true, composed: true, view: W,
            clientX: x, clientY: y, screenX: x, screenY: y,
            button: 0, buttons: buttons,
            pointerId: 1, pointerType: 'mouse', isPrimary: true,
        }, extra || {});
        target.dispatchEvent(new Ctor(type, init));
        if (type.startsWith('pointer')) {
            const M = W.MouseEvent || MouseEvent;
            target.dispatchEvent(new M(type.replace('pointer', 'mouse'), init));
        }
    }

    function fireKey(key, code) {
        const KE = W.KeyboardEvent || KeyboardEvent;
        const init = { bubbles: true, cancelable: true, composed: true, view: W,
                       key, code, keyCode: 0, which: 0 };
        const t = document.activeElement || document.body;
        t.dispatchEvent(new KE('keydown', init));
        t.dispatchEvent(new KE('keyup', init));
    }

    async function dragBy(canvas, fromX, fromY, dx, dy, steps, ms) {
        fire(canvas, 'pointerdown', fromX, fromY, 1);
        for (let i = 1; i <= steps; i++) {
            fire(canvas, 'pointermove', fromX + dx * i / steps, fromY + dy * i / steps, 1);
            await sleep(ms / steps);
        }
        fire(canvas, 'pointerup', fromX + dx, fromY + dy, 0);
        await sleep(500);
    }

    /** 找地圖右下角的縮放鈕，用可見標籤定位而非混淆過的 class */
    function zoomButton(zoomIn) {
        const want = zoomIn ? /放大|zoom in/i : /縮小|zoom out/i;
        return [...document.querySelectorAll('button')]
            .find(b => want.test(b.getAttribute('aria-label') || b.title || '')) || null;
    }

    const RESULTS = [];
    function record(code, name, ok, detail, routeChanged) {
        RESULTS.push({ code, name, ok, detail, routeChanged });
        log(code + ' ' + name,
            (ok ? '✅ 有效' : '❌ 無效') +
            (routeChanged ? '　⚠️ 路線被改動' : '') +
            (detail ? '　' + detail : ''));
    }

    async function runTests() {
        const canvas = mapCanvas();
        if (!canvas) { log('錯誤', '找不到地圖畫布'); return; }
        const cw = canvas.r.width, ch = canvas.r.height;
        const cx = canvas.r.left + cw / 2, cy = canvas.r.top + ch / 2;
        log('環境', `畫布 ${Math.round(cw)}x${Math.round(ch)}　` +
            `unsafeWindow=${W !== window ? '可用' : '不可用（沙箱）'}　` +
            `起始視野 ${JSON.stringify(viewport())}　控制點 ${ctrlPoints()} 個`);

        // ── A. 拖曳畫布（從正中央按下，現行做法）──
        {
            const v0 = viewport(), c0 = ctrlPoints();
            await dragBy(canvas.el, cx, cy, -200, 120, 12, 250);
            const v1 = viewport();
            const moved = shiftPx(v0, v1);
            record('A', '拖曳畫布（中央按下）', moved > 20,
                `位移 ${moved}px（要求 ~233px）`, ctrlPoints() !== c0);
        }

        // ── B. 鍵盤方向鍵 ──
        {
            const v0 = viewport(), c0 = ctrlPoints();
            canvas.el.focus && canvas.el.focus();
            for (let i = 0; i < 3; i++) { fireKey('ArrowRight', 'ArrowRight'); await sleep(220); }
            await sleep(500);
            const v1 = viewport();
            const moved = shiftPx(v0, v1);
            record('B', '鍵盤方向鍵', moved > 5,
                `按 3 次共位移 ${moved}px（每次約 ${Math.round(moved / 3)}px）`, ctrlPoints() !== c0);
        }

        // ── C. 拖曳但從角落按下（避開路線）──
        {
            const v0 = viewport(), c0 = ctrlPoints();
            const px = canvas.r.left + cw * 0.85, py = canvas.r.top + ch * 0.15;
            await dragBy(canvas.el, px, py, -150, 100, 12, 250);
            const v1 = viewport();
            const moved = shiftPx(v0, v1);
            record('C', '拖曳（角落按下）', moved > 20,
                `位移 ${moved}px`, ctrlPoints() !== c0);
        }

        // ── D. 連續兩次拖曳能否累加 ──
        {
            const v0 = viewport(), c0 = ctrlPoints();
            const px = canvas.r.left + cw * 0.85, py = canvas.r.top + ch * 0.15;
            await dragBy(canvas.el, px, py, 300, 0, 12, 250);
            const mid = viewport();
            await dragBy(canvas.el, px, py, 300, 0, 12, 250);
            const v1 = viewport();
            const first = shiftPx(v0, mid), total = shiftPx(v0, v1);
            record('D', '多次拖曳累加', total > first * 1.6,
                `第一次 ${first}px　兩次合計 ${total}px`, ctrlPoints() !== c0);
        }

        // ── E. 滾輪縮放（沙箱環境下）──
        {
            const v0 = viewport(), c0 = ctrlPoints();
            for (let i = 0; i < 5; i++) {
                fire(canvas.el, 'wheel', cx, cy, 0, { deltaY: -120, deltaMode: 0 });
                await sleep(120);
            }
            await sleep(900);
            const v1 = viewport();
            const dz = v1 && v0 ? +(v1.zoom - v0.zoom).toFixed(2) : 0;
            record('E', '滾輪縮放', Math.abs(dz) > 0.1,
                `5 個事件共 ${dz} 級（每事件約 ${(dz / 5).toFixed(3)} 級）`, ctrlPoints() !== c0);
        }

        // ── F. 縮放按鈕 ──
        {
            const v0 = viewport(), c0 = ctrlPoints();
            const btn = zoomButton(false);
            if (!btn) { record('F', '縮放按鈕', false, '找不到按鈕', false); }
            else {
                btn.click(); await sleep(700);
                const v1 = viewport();
                const dz = v1 && v0 ? +(v1.zoom - v0.zoom).toFixed(2) : 0;
                const drift = shiftPx(v0, v1);
                record('F', '縮放按鈕', Math.abs(dz) > 0.1,
                    `1 次 ${dz} 級　中心位移 ${drift}px`, ctrlPoints() !== c0);
            }
        }

        // ── G. 鍵盤 +／− ──
        {
            const v0 = viewport(), c0 = ctrlPoints();
            fireKey('+', 'Equal'); await sleep(800);
            const v1 = viewport();
            const dz = v1 && v0 ? +(v1.zoom - v0.zoom).toFixed(2) : 0;
            record('G', '鍵盤 +／−', Math.abs(dz) > 0.1, `1 次 ${dz} 級`, ctrlPoints() !== c0);
        }

        // ── H. 雙擊放大 ──
        {
            const v0 = viewport(), c0 = ctrlPoints();
            const px = canvas.r.left + cw * 0.85, py = canvas.r.top + ch * 0.15;
            fire(canvas.el, 'pointerdown', px, py, 1); fire(canvas.el, 'pointerup', px, py, 0);
            fire(canvas.el, 'click', px, py, 0, { detail: 1 });
            await sleep(60);
            fire(canvas.el, 'pointerdown', px, py, 1); fire(canvas.el, 'pointerup', px, py, 0);
            fire(canvas.el, 'click', px, py, 0, { detail: 2 });
            fire(canvas.el, 'dblclick', px, py, 0, { detail: 2 });
            await sleep(900);
            const v1 = viewport();
            const dz = v1 && v0 ? +(v1.zoom - v0.zoom).toFixed(2) : 0;
            record('H', '雙擊放大', Math.abs(dz) > 0.1, `${dz} 級`, ctrlPoints() !== c0);
        }

        // ── 總表 ──
        const usable = RESULTS.filter(r => r.ok && !r.routeChanged).map(r => r.code);
        const broken = RESULTS.filter(r => r.routeChanged).map(r => r.code);
        log('總結', `可用且不改動路線：${usable.join('、') || '（無）'}` +
            (broken.length ? `\n      會改動路線（不可用）：${broken.join('、')}` : ''));
        log('DONE', '八項測試完成，請按「停止監控」後複製。地圖已被移動，重新整理即可復原。');
    }

    function PROBE_SETUP() {
        RESULTS.length = 0;
        log('START', '開始測試八種地圖操作手段，全程約 15 秒，請勿操作頁面。');
        runTests().catch(err => log('錯誤', err.message));
    }

    function PROBE_TEARDOWN() {
        _bdpObservers.forEach(mo => mo.disconnect());
        _bdpObservers = [];
        log('STOP', '監控停止');
    }

})();
