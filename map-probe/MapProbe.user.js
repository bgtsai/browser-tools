// ==UserScript==
// @name         地圖操作手段測試
// @namespace    browser-tools
// @version      4.0
// @description  驗證 setPointerCapture 攔截能否提高拖曳精度，以及 #widget-zoom-in 縮放鈕是否可用
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
    let _restore = [];

    // ── 目的：驗證從 gMapZoomShortcut 學到的兩個技巧 ──
    //
    // ① setPointerCapture 攔截
    //    網頁收到 pointerdown 後通常會呼叫 element.setPointerCapture(pointerId)。
    //    我們送的是合成事件，那個 pointerId 在瀏覽器眼中不存在，這個呼叫會**拋例外**，
    //    而例外發生在 Google 自己的處理函式中間，可能把它的拖曳初始化打斷——
    //    症狀正好是我們看到的「拖曳有反應但不完整」。
    //    對照組：同樣的拖曳，裝／不裝這個攔截，量出實際位移比例。
    //
    // ② #widget-zoom-in
    //    先前測「縮放按鈕無效」是用中文 aria-label 找到的元素；
    //    那支擴充功能優先用這個 id，值得直接測。
    //
    // 量測方式：不用固定等待，改成**輪詢等網址改變**——
    // 網址落後真實視野，所以它一變就代表動作已經完成，這是可靠的完成訊號。

    const W = (typeof unsafeWindow !== 'undefined' && unsafeWindow) || window;
    const POINTER_ID = 10088;
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
    /** 等網址改變＝動作已完成。回傳等了多久，逾時回傳 -1 */
    async function waitUrlChange(prevKey, timeoutMs) {
        const t0 = performance.now();
        while (performance.now() - t0 < (timeoutMs || 4000)) {
            if (vpKey() !== prevKey) {
                await sleep(250);          // 再等一下讓值穩定
                return Math.round(performance.now() - t0);
            }
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

    let _patched = false;
    function installPointerCapturePatch() {
        if (_patched) return;
        const EP = (W.Element || Element).prototype;
        const origSet = EP.setPointerCapture;
        const origRel = EP.releasePointerCapture;
        EP.setPointerCapture = function (id) {
            if (id === POINTER_ID) return;          // 合成指標：略過，避免拋例外打斷處理流程
            return origSet.call(this, id);
        };
        EP.releasePointerCapture = function (id) {
            if (id === POINTER_ID) return;
            return origRel.call(this, id);
        };
        _restore.push(() => { EP.setPointerCapture = origSet; EP.releasePointerCapture = origRel; });
        _patched = true;
    }

    function fire(target, mouseType, pointerType, opts) {
        const ME = W.MouseEvent || MouseEvent;
        const PE = W.PointerEvent || PointerEvent;
        target.dispatchEvent(new ME(mouseType, opts));
        target.dispatchEvent(new PE(pointerType, Object.assign(
            { pointerId: POINTER_ID, isPrimary: true, pointerType: 'mouse' }, opts)));
    }

    /** 一次連續拖曳：分 N 格送出，放開前在原位補一次 move（消除慣性） */
    async function drag(canvas, dx, dy, frames, frameMs) {
        const r = canvas.getBoundingClientRect();
        let x = r.left + r.width * 0.75;      // 往左拖，所以從右側按下
        let y = r.top + r.height * 0.5;
        const base = { bubbles: true, cancelable: true, view: W, button: 0, buttons: 1 };
        fire(canvas, 'mousedown', 'pointerdown', Object.assign({}, base, { detail: 1, clientX: x, clientY: y }));
        for (let i = 1; i <= frames; i++) {
            const cx = x + dx * i / frames, cy = y + dy * i / frames;
            fire(canvas, 'mousemove', 'pointermove',
                Object.assign({}, base, { cancelable: false, detail: 88, clientX: cx, clientY: cy }));
            await sleep(frameMs);
        }
        const ex = x + dx, ey = y + dy;
        fire(canvas, 'mousemove', 'pointermove',
            Object.assign({}, base, { cancelable: false, detail: 88, clientX: ex, clientY: ey }));
        fire(canvas, 'mouseup', 'pointerup',
            Object.assign({}, base, { detail: 1, buttons: 0, clientX: ex, clientY: ey }));
    }

    async function measureDrag(canvas, label, dxPx) {
        const results = [];
        for (let round = 0; round < 3; round++) {
            const v0 = viewport(), key0 = vpKey();
            await drag(canvas, dxPx, 0, 16, 16);
            const waited = await waitUrlChange(key0, 4000);
            const moved = shiftPx(v0, viewport());
            results.push({ moved, waited, pct: Math.round(moved / Math.abs(dxPx) * 100) });
            await sleep(400);
            // 拖回去復位
            const keyBack = vpKey();
            await drag(canvas, -dxPx, 0, 16, 16);
            await waitUrlChange(keyBack, 4000);
            await sleep(400);
        }
        const pcts = results.map(r => r.pct);
        const avg = Math.round(pcts.reduce((a, b) => a + b, 0) / pcts.length);
        log(label, `三次達成率 ${pcts.join('%, ')}%　平均 ${avg}%\n` +
            `      位移 ${results.map(r => r.moved).join(', ')} px（要求 ${Math.abs(dxPx)} px）\n` +
            `      網址更新耗時 ${results.map(r => r.waited).join(', ')} ms`);
        return avg;
    }

    async function runAll() {
        const canvas = mapCanvas();
        if (!canvas) { log('錯誤', '找不到地圖畫布'); return; }
        const DX = -400;
        log('環境', `畫布 ${Math.round(canvas.r.width)}x${Math.round(canvas.r.height)}　` +
            `視野 ${JSON.stringify(viewport())}　控制點 ${ctrlPoints()} 個`);

        log('──', '① 對照組：未攔截 setPointerCapture');
        const before = await measureDrag(canvas.el, '①未攔截', DX);

        log('──', '② 實驗組：已攔截 setPointerCapture');
        installPointerCapturePatch();
        const after = await measureDrag(canvas.el, '②已攔截', DX);

        log('①②結論', after > before + 3
            ? `✅ 攔截有效：達成率 ${before}% → ${after}%，應納入 route-rain`
            : (before >= 97
                ? `兩者都已接近 100%（${before}% → ${after}%），拖曳本來就準，問題不在這裡`
                : `攔截沒有明顯差異（${before}% → ${after}%），另有原因`));

        log('──', '③ 縮放按鈕：比較兩種選擇器');
        for (const [name, sel] of [['#widget-zoom-in', '#widget-zoom-in'],
                                   ['aria-label 放大', 'button[aria-label="放大"]'],
                                   ['aria-label Zoom in', 'button[aria-label="Zoom in"]']]) {
            const btn = document.querySelector(sel);
            if (!btn) { log('③' + name, '找不到元素'); continue; }
            const v0 = viewport(), key0 = vpKey();
            btn.click();
            const waited = await waitUrlChange(key0, 4000);
            const v1 = viewport();
            const dz = v1 && v0 ? +(v1.zoom - v0.zoom).toFixed(2) : 0;
            log('③' + name, (Math.abs(dz) > 0.1 ? '✅ 有效' : '❌ 無效') +
                `　${dz} 級　中心位移 ${shiftPx(v0, v1)}px　網址更新 ${waited}ms`);
            if (Math.abs(dz) > 0.1) {
                const k = vpKey();
                const out = document.querySelector('#widget-zoom-out')
                    || document.querySelector('button[aria-label="縮小"]');
                if (out) { out.click(); await waitUrlChange(k, 4000); }
            }
            await sleep(300);
        }

        log('④副作用', ctrlPoints() === 0 ? '路線未被改動 ✅' : '⚠️ 路線的途經點數改變了');
        log('DONE', '測試完成，請按「停止監控」後複製。');
    }

    function PROBE_SETUP() {
        log('START', '開始測試，全程約 60 秒，請勿操作頁面。');
        runAll().catch(err => log('錯誤', err.message + '\n      ' + String(err.stack || '').slice(0, 200)));
    }

    function PROBE_TEARDOWN() {
        _restore.forEach(fn => { try { fn(); } catch (err) { /* 還原失敗不影響停止 */ } });
        _restore = [];
        _bdpObservers.forEach(mo => mo.disconnect());
        _bdpObservers = [];
        log('STOP', '監控停止（已還原 setPointerCapture）');
    }

})();
