// ==UserScript==
// @name         通用診斷面板骨架
// @namespace    browser-tools
// @version      1.4
// @description  可複用的診斷面板骨架（方案 C）：面板 UI + 相對時間戳 + 開始/停止 + 一鍵複製，任務專屬邏輯只需替換「探針區塊」
// @match        *://*/*
// @grant        none
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
    let _rrRestore = [];

    // ── 目前任務：找出 Google Maps 的「相機層」，並同時驗證滾輪縮放是否可行 ──
    //
    // 一次執行回答四件事：
    //   ① window 上有沒有具備地圖控制方法的物件
    //   ② 從 canvas 及其祖先的自有屬性反查，有沒有內部控制器
    //   ③ 用「數值特徵」找相機狀態物件——方法名稱會被混淆，但存著的
    //      經緯度騙不了人：找出屬性值剛好等於目前地圖中心的物件
    //   ④ 備案驗證：合成的 wheel 事件能不能縮放地圖
    //
    // 本腳本是 @grant none，跑在網頁環境；先前在沙箱裡掃描的結果不可信。

    const CAM_METHODS = ['panTo', 'panBy', 'setCenter', 'getCenter', 'setZoom', 'getZoom',
        'moveCamera', 'setCameraParams', 'flyTo', 'setView', 'fitBounds'];
    const SCAN_MAX_NODES = 30000;
    const SCAN_MAX_DEPTH = 4;
    const LATLNG_TOLERANCE = 0.02;

    function rrViewport() {
        const m = location.href.match(/\/@(-?[\d.]+),(-?[\d.]+),([\d.]+)z/);
        return m ? { lat: +m[1], lon: +m[2], zoom: +m[3] } : null;
    }

    function rrScan(roots, vp) {
        const seen = new WeakSet();
        const methodHits = [];
        const valueHits = [];
        let nodes = 0;

        const visit = (obj, path, depth) => {
            if (!obj || depth > SCAN_MAX_DEPTH || nodes > SCAN_MAX_NODES) return;
            const t = typeof obj;
            if (t !== 'object' && t !== 'function') return;
            if (seen.has(obj)) return;
            seen.add(obj);
            nodes++;

            let keys;
            try { keys = Object.getOwnPropertyNames(obj); } catch (err) { return; }

            // ① 方法名稱比對
            const found = CAM_METHODS.filter(m => {
                try { return typeof obj[m] === 'function'; } catch (err) { return false; }
            });
            if (found.length >= 2) methodHits.push(`${path}  →  ${found.join(', ')}`);

            // ③ 數值特徵：同一個物件裡同時有接近中心緯度與經度的數字
            if (vp && keys.length <= 60) {
                const nums = [];
                for (const k of keys) {
                    let v;
                    try { v = obj[k]; } catch (err) { continue; }
                    if (typeof v === 'number' && isFinite(v)) nums.push([k, v]);
                }
                const nearLat = nums.filter(([, v]) => Math.abs(v - vp.lat) < LATLNG_TOLERANCE);
                const nearLon = nums.filter(([, v]) => Math.abs(v - vp.lon) < LATLNG_TOLERANCE);
                if (nearLat.length && nearLon.length) {
                    valueHits.push(`${path}  {${nearLat[0][0]}:${nearLat[0][1].toFixed(5)}, ` +
                        `${nearLon[0][0]}:${nearLon[0][1].toFixed(5)}}  共 ${keys.length} 個屬性`);
                }
            }

            if (depth >= SCAN_MAX_DEPTH) return;
            for (const k of keys) {
                if (/^(window|self|top|parent|frames|document|location|history)$/.test(k)) continue;
                let v;
                try { v = obj[k]; } catch (err) { continue; }
                if (v && (typeof v === 'object' || typeof v === 'function')) {
                    visit(v, path + '.' + k, depth + 1);
                }
            }
        };

        roots.forEach(([obj, name]) => visit(obj, name, 0));
        return { methodHits, valueHits, nodes };
    }

    function PROBE_SETUP() {
        const vp = rrViewport();
        log('START', `目前視野：${vp ? `${vp.lat}, ${vp.lon} @ ${vp.zoom}z` : '(讀不到)'}`);

        const canvas = [...document.querySelectorAll('canvas')]
            .map(el => ({ el, r: el.getBoundingClientRect() }))
            .filter(o => o.r.width > 200 && o.r.height > 200)
            .sort((a, b) => b.r.width * b.r.height - a.r.width * a.r.height)[0];
        if (!canvas) { log('錯誤', '找不到地圖畫布，後續測試無法進行'); return; }
        log('畫布', `${Math.round(canvas.r.width)}x${Math.round(canvas.r.height)}`);

        // 從多個根出發：window、畫布本身、以及畫布往上四層的祖先
        const roots = [[window, 'window'], [canvas.el, 'canvas']];
        let anc = canvas.el.parentElement;
        for (let i = 0; i < 4 && anc; i++, anc = anc.parentElement) {
            roots.push([anc, `祖先[${i}]`]);
        }

        const t0 = performance.now();
        const { methodHits, valueHits, nodes } = rrScan(roots, vp);
        log('掃描', `走訪 ${nodes} 個物件，耗時 ${Math.round(performance.now() - t0)} ms`);

        log('①②方法比對', methodHits.length
            ? methodHits.slice(0, 10).join('\n      ')
            : '找不到具備兩個以上地圖控制方法的物件');

        log('③數值特徵', valueHits.length
            ? valueHits.slice(0, 12).join('\n      ')
            : '找不到屬性值等於目前地圖中心的物件');

        // ④ 滾輪縮放測試（備案方案的可行性）
        const cx = canvas.r.left + canvas.r.width / 2;
        const cy = canvas.r.top + canvas.r.height / 2;
        const before = (location.href.match(/\/@[^/]+/) || ['(無)'])[0];
        log('④滾輪', `開始測試，於畫布中心送出 5 次 wheel（縮放前 ${before}）`);
        let n = 0;
        const timer = setInterval(() => {
            n++;
            canvas.el.dispatchEvent(new WheelEvent('wheel', {
                bubbles: true, cancelable: true, composed: true, view: window,
                clientX: cx, clientY: cy, deltaY: -120, deltaMode: 0,
            }));
            if (n >= 5) {
                clearInterval(timer);
                setTimeout(() => {
                    const after = (location.href.match(/\/@[^/]+/) || ['(無)'])[0];
                    log('④滾輪', `縮放後 ${after}\n      結果：` +
                        (after !== before ? '視野已改變 → 合成 wheel 可行' : '沒有變化 → 合成 wheel 無效'));
                    log('DONE', '四項檢查完成，請按「停止監控」後複製。');
                }, 1500);
            }
        }, 120);
        _rrRestore.push(() => clearInterval(timer));
    }

    function PROBE_TEARDOWN() {
        _rrRestore.forEach(fn => { try { fn(); } catch (err) { /* 還原失敗不影響停止 */ } });
        _rrRestore = [];
        _bdpObservers.forEach(mo => mo.disconnect());
        _bdpObservers = [];
        log('STOP', '監控停止');
    }

})();
