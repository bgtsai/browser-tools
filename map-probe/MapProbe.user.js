// ==UserScript==
// @name         地圖操作手段測試
// @namespace    browser-tools
// @version      3.0
// @description  在與 route-rain 相同的沙箱環境下，測出鍵盤平移與縮放的可用性與精度
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

    // ── 目的：鍵盤方案能不能用、準不準 ──
    //
    // 背景：往內挖相機層已經確定不通（狀態物件在內部持有參照，從外部攔不到）。
    // 官方無障礙文件寫著「按 Tab 直到焦點設為地圖」之後，方向鍵可平移、+/- 可縮放，
    // 而先前測試「鍵盤無效」很可能是因為沒讓地圖取得焦點。
    //
    // 鍵盤方案的價值不只是備案：它完全不碰畫布，因此
    //   ・不可能誤觸「拖曳路線新增途經點」
    //   ・可以在最終縮放層級做微調，殘留誤差不會再被放大
    //
    // 要回答四件事：
    //   ① 該讓哪個元素取得焦點才有效
    //   ② 一次按鍵移動多少像素——這決定能不能算出要按幾次
    //   ③ 重複按是否穩定——這決定準不準
    //   ④ +/- 一次縮放多少級
    //
    // 注意：網址更新落後真實視野超過一秒（v1.6 實測），所以每次量測都要等夠久。

    const W = (typeof unsafeWindow !== 'undefined' && unsafeWindow) || window;
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const SETTLE_MS = 1600;        // 等網址反映新視野；實測落後可達 1.4 秒

    function viewport() {
        const m = location.href.match(/\/@(-?[\d.]+),(-?[\d.]+),([\d.]+)z/);
        return m ? { lat: +m[1], lon: +m[2], zoom: +m[3] } : null;
    }
    function ctrlPoints() {
        return ((location.href.match(/\/data=([^?]+)/) || [''])[1].match(/3m4/g) || []).length;
    }
    function projectPx(lat, lon, zoom) {
        const world = 256 * Math.pow(2, zoom);
        const s = Math.sin(lat * Math.PI / 180);
        return { x: (lon + 180) / 360 * world,
                 y: (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * world };
    }
    /** 兩個視野之間的像素位移（以第一個視野的縮放層級計） */
    function shiftPx(a, b) {
        if (!a || !b) return 0;
        const p1 = projectPx(a.lat, a.lon, a.zoom);
        const p2 = projectPx(b.lat, b.lon, a.zoom);
        return Math.round(Math.hypot(p2.x - p1.x, p2.y - p1.y));
    }
    function mapCanvas() {
        return [...document.querySelectorAll('canvas')]
            .map(el => ({ el, r: el.getBoundingClientRect() }))
            .filter(o => o.r.width > 200 && o.r.height > 200)
            .sort((a, b) => b.r.width * b.r.height - a.r.width * a.r.height)[0] || null;
    }

    function pressKey(target, key, code, opts) {
        const KE = W.KeyboardEvent || KeyboardEvent;
        const init = Object.assign({
            bubbles: true, cancelable: true, composed: true, view: W,
            key, code, location: 0, repeat: false,
        }, opts || {});
        const t = target || document.activeElement || document.body;
        t.dispatchEvent(new KE('keydown', init));
        t.dispatchEvent(new KE('keypress', init));
        t.dispatchEvent(new KE('keyup', init));
    }

    /** 列出「可能就是地圖」的可聚焦元素：有 tabindex 且覆蓋畫布區域 */
    function focusCandidates(canvasRect) {
        const all = [...document.querySelectorAll('[tabindex]')];
        return all.map(el => {
            const r = el.getBoundingClientRect();
            return { el, r, ti: el.getAttribute('tabindex'),
                     label: (el.getAttribute('aria-label') || '').slice(0, 30),
                     cls: String(el.className || '').slice(0, 40) };
        }).filter(o => o.r.width > canvasRect.width * 0.5 && o.r.height > canvasRect.height * 0.5)
          .slice(0, 8);
    }

    async function tryFocusAndPan(cand, canvas) {
        try { cand.el.focus({ preventScroll: true }); } catch (err) { return null; }
        const active = document.activeElement === cand.el;
        const v0 = viewport();
        for (let i = 0; i < 3; i++) { pressKey(cand.el, 'ArrowRight', 'ArrowRight'); await sleep(200); }
        await sleep(SETTLE_MS);
        const v1 = viewport();
        return { active, moved: shiftPx(v0, v1), v0, v1 };
    }

    async function runAll() {
        const canvas = mapCanvas();
        if (!canvas) { log('錯誤', '找不到地圖畫布'); return; }
        log('環境', `畫布 ${Math.round(canvas.r.width)}x${Math.round(canvas.r.height)}　` +
            `視野 ${JSON.stringify(viewport())}　控制點 ${ctrlPoints()} 個`);

        // ① 找出該聚焦哪個元素
        const cands = focusCandidates(canvas.r);
        log('①可聚焦候選', cands.length
            ? cands.map((c, i) => `[${i}] tabindex=${c.ti} class="${c.cls}" ${c.label}`).join('\n      ')
            : '找不到覆蓋畫布的可聚焦元素');

        let winner = null;
        for (let i = 0; i < cands.length; i++) {
            const res = await tryFocusAndPan(cands[i], canvas);
            if (!res) continue;
            log(`①測試候選[${i}]`,
                `focus 成功=${res.active}　按 3 次方向鍵位移 ${res.moved}px`);
            if (res.moved > 5) { winner = { cand: cands[i], idx: i }; break; }
        }
        // 也試試直接對畫布與 document 送鍵
        if (!winner) {
            for (const [name, target] of [['畫布', canvas.el], ['document.body', document.body]]) {
                const v0 = viewport();
                try { target.focus && target.focus({ preventScroll: true }); } catch (err) { /* 不可聚焦 */ }
                for (let i = 0; i < 3; i++) { pressKey(target, 'ArrowRight', 'ArrowRight'); await sleep(200); }
                await sleep(SETTLE_MS);
                const moved = shiftPx(v0, viewport());
                log('①直接送鍵', `${name}：位移 ${moved}px`);
                if (moved > 5) { winner = { cand: { el: target }, idx: -1 }; break; }
            }
        }

        if (!winner) {
            log('結論', '❌ 鍵盤完全無反應——合成的鍵盤事件不被接受。\n' +
                '      兩條路線都不通，只能沿用現有的「滾輪＋拖曳」模擬方案並繼續優化它。');
            log('DONE', '測試結束。');
            return;
        }
        const el = winner.cand.el;
        log('①結論', `✅ 有效：候選[${winner.idx}]（-1 代表直接送鍵）`);

        // ② 每次按鍵移動多少、③ 是否穩定
        const perPress = [];
        for (let round = 0; round < 3; round++) {
            const v0 = viewport();
            pressKey(el, 'ArrowRight', 'ArrowRight');
            await sleep(SETTLE_MS);
            const d = shiftPx(v0, viewport());
            perPress.push(d);
        }
        const avg = perPress.reduce((a, b) => a + b, 0) / perPress.length;
        const spread = Math.max(...perPress) - Math.min(...perPress);
        log('②③單次位移', `三次各為 ${perPress.join(', ')} px　平均 ${avg.toFixed(0)}px　` +
            `落差 ${spread}px　→ ${spread <= 2 ? '穩定，可據以計算按幾次' : '不穩定，難以精確定位'}`);

        // Shift+方向鍵（官方文件說是「以方形為單位」大幅移動）
        {
            const v0 = viewport();
            pressKey(el, 'ArrowRight', 'ArrowRight', { shiftKey: true });
            await sleep(SETTLE_MS);
            log('②Shift+方向鍵', `位移 ${shiftPx(v0, viewport())} px`);
        }

        // ④ 縮放
        for (const [label, key, code] of [['+ 放大', '+', 'Equal'], ['- 縮小', '-', 'Minus']]) {
            const v0 = viewport();
            pressKey(el, key, code);
            await sleep(SETTLE_MS);
            const v1 = viewport();
            const dz = v1 && v0 ? +(v1.zoom - v0.zoom).toFixed(2) : 0;
            log('④' + label, `${dz} 級　中心位移 ${shiftPx(v0, v1)}px`);
        }

        log('⑤副作用', ctrlPoints() === 0 ? '路線未被改動 ✅' : '⚠️ 路線的途經點數改變了');
        log('DONE', '測試結束，請按「停止監控」後複製。地圖已被移動，重新整理即可復原。');
    }

    function PROBE_SETUP() {
        log('START', '開始測試鍵盤方案，全程約 40 秒，請勿操作頁面或移動滑鼠到地圖上。');
        runAll().catch(err => log('錯誤', err.message + '\n      ' + String(err.stack || '').slice(0, 200)));
    }

    function PROBE_TEARDOWN() {
        _bdpObservers.forEach(mo => mo.disconnect());
        _bdpObservers = [];
        log('STOP', '監控停止');
    }

})();
