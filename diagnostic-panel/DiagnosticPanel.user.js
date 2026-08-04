// ==UserScript==
// @name         通用診斷面板骨架
// @namespace    browser-tools
// @version      1.8
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

    // ── 目的：最後一次嘗試找出相機層的入口 ──
    //
    // 上一版在 window._.aP 的座標屬性上裝 setter 失敗（0 個成功）。
    // 這一版做三件事，把「為什麼失敗」與「還有沒有別的路」一次問清楚：
    //   ① 診斷失敗原因——凍結？封裝？屬性不可設定？
    //      若是凍結，代表 Google 每次是「換一個新的狀態物件」而非改寫舊的，
    //      那就該往上一層裝設。
    //   ② 改在「持有者」上裝 setter（window._ 的 aP 這個屬性本身），
    //      物件被替換時就能捕捉到呼叫堆疊。
    //   ③ 擴大搜尋範圍——深度加到 5，並加入畫布與其祖先的自訂屬性
    //      （框架常把控制器掛在 DOM 元素上）。
    //
    // 這是這條路線的最後一次嘗試。若仍拿不到可呼叫的入口，就轉向鍵盤方案。

    const TOL = 0.02;
    const MAX_TARGETS = 60;
    const MAX_STACKS = 25;
    let _holders = [];
    let _hits = [];
    let _armed = false;

    function vpOf() {
        const m = location.href.match(/\/@(-?[\d.]+),(-?[\d.]+),([\d.]+)z/);
        return m ? { lat: +m[1], lon: +m[2], zoom: +m[3] } : null;
    }
    function briefStack(err) {
        return String(err.stack || '').split('\n')
            .filter(l => l && !/DiagnosticPanel|briefStack|<anonymous>:/.test(l))
            .slice(0, 8)
            .map(l => l.trim().replace(/https?:\/\/[^\s)]+\//g, '').slice(0, 100))
            .join('\n        ');
    }
    /** 這個物件是不是「存著目前地圖中心」 */
    function holdsCentre(obj, vp) {
        let keys;
        try { keys = Object.getOwnPropertyNames(obj); } catch (err) { return null; }
        if (keys.length > 40) return null;
        let latKey = null, lonKey = null;
        for (const k of keys) {
            let v;
            try { v = obj[k]; } catch (err) { continue; }
            if (typeof v !== 'number' || !isFinite(v)) continue;
            if (latKey === null && Math.abs(v - vp.lat) < TOL) latKey = k;
            if (lonKey === null && Math.abs(v - vp.lon) < TOL) lonKey = k;
        }
        return (latKey !== null && lonKey !== null) ? { latKey, lonKey } : null;
    }

    /** 掃描：回傳 [{holder, key, obj, path}]——holder[key] 就是那個狀態物件 */
    function scan(vp) {
        const seen = new WeakSet();
        const found = [];
        const visit = (obj, path, depth, holder, key) => {
            if (!obj || depth > 5 || found.length >= MAX_TARGETS) return;
            const t = typeof obj;
            if (t !== 'object' && t !== 'function') return;
            if (seen.has(obj)) return;
            seen.add(obj);
            if (holder && holdsCentre(obj, vp)) found.push({ holder, key, obj, path });
            if (depth >= 5) return;
            let keys;
            try { keys = Object.getOwnPropertyNames(obj); } catch (err) { return; }
            for (const k of keys) {
                if (/^(window|self|top|parent|frames|document|location|history)$/.test(k)) continue;
                let v;
                try { v = obj[k]; } catch (err) { continue; }
                if (v && (typeof v === 'object' || typeof v === 'function')) {
                    visit(v, path + '.' + k, depth + 1, obj, k);
                }
            }
        };
        visit(window, 'window', 0, null, null);
        if (window._) visit(window._, 'window._', 0, null, null);
        // 框架常把控制器掛在 DOM 元素上，畫布與其祖先一併掃
        const cv = [...document.querySelectorAll('canvas')]
            .map(el => ({ el, r: el.getBoundingClientRect() }))
            .filter(o => o.r.width > 200 && o.r.height > 200)
            .sort((a, b) => b.r.width * b.r.height - a.r.width * a.r.height)[0];
        if (cv) {
            let n = cv.el, d = 0;
            while (n && d < 5) { visit(n, `canvas祖先[${d}]`, 3, null, null); n = n.parentElement; d++; }
        }
        return found;
    }

    function describeWhyLocked(obj) {
        const bits = [];
        if (Object.isFrozen(obj)) bits.push('已凍結(frozen)');
        else if (Object.isSealed(obj)) bits.push('已封裝(sealed)');
        else if (!Object.isExtensible(obj)) bits.push('不可擴充');
        const d = Object.getOwnPropertyDescriptor(obj, Object.getOwnPropertyNames(obj)[0]);
        if (d) bits.push(`首個屬性 writable=${d.writable} configurable=${d.configurable}`);
        return bits.join('　') || '沒有明顯的鎖定';
    }

    function PROBE_SETUP() {
        const vp = vpOf();
        if (!vp) { log('錯誤', '網址讀不到視野'); return; }
        log('START', `目前視野 ${vp.lat}, ${vp.lon} @ ${vp.zoom}z`);

        const t0 = performance.now();
        const found = scan(vp);
        log('①掃描結果', found.length
            ? `${found.length} 個狀態物件（耗時 ${Math.round(performance.now() - t0)}ms）\n      ` +
              found.slice(0, 10).map(f => `${f.path}　${describeWhyLocked(f.obj)}`).join('\n      ')
            : '找不到任何存著目前中心的物件');
        if (!found.length) { log('結論', '這條路不通，改用鍵盤方案'); return; }

        // 改在「持有者」上裝設：物件被整個替換時才捕捉得到
        let ok = 0;
        _holders = [];
        for (const f of found) {
            let current = f.obj;
            try {
                Object.defineProperty(f.holder, f.key, {
                    configurable: true, enumerable: true,
                    get() { return current; },
                    set(v) {
                        if (_armed && v !== current && _hits.length < MAX_STACKS) {
                            let c = null;
                            try { c = holdsCentre(v, { lat: 0, lon: 0 }); } catch (err) { /* 忽略 */ }
                            _hits.push({ path: f.path, stack: briefStack(new Error()) });
                        }
                        current = v;
                    },
                });
                _holders.push(f); ok++;
            } catch (err) { /* 持有者本身也鎖住 */ }
        }
        log('②在持有者上裝設', `${ok} / ${found.length} 個成功`);
        if (!ok) {
            log('結論', '持有者也無法裝設 → 從外部完全攔不到，改用鍵盤方案');
            return;
        }
        _armed = true;
        _hits = [];
        log('READY', '請點一個路線步驟讓地圖移動，然後按「停止監控」。');
    }

    function PROBE_TEARDOWN() {
        _armed = false;
        if (_hits.length) {
            log('③捕捉到替換', `共 ${_hits.length} 筆，列出前 4 筆：`);
            _hits.slice(0, 4).forEach((h, i) => {
                log(`  第 ${i + 1} 筆`, `${h.path}\n        ${h.stack}`);
            });
            log('判讀', '堆疊裡若出現接收經緯度的函式，那就是相機層的入口');
        } else {
            log('③捕捉到替換', '沒有捕捉到任何替換');
            const vp = vpOf();
            if (vp) {
                const again = scan(vp);
                log('④判讀', again.length
                    ? '重新掃描仍找得到狀態物件，但替換沒經過我們裝的 setter →'
                      + ' 內部持有自己的參照，從外部攔不到，改用鍵盤方案'
                    : '重新掃描已找不到 → 狀態存在閉包裡，改用鍵盤方案');
            }
        }
        _rrRestore.forEach(fn => { try { fn(); } catch (err) { /* 還原失敗不影響停止 */ } });
        _rrRestore = [];
        _bdpObservers.forEach(mo => mo.disconnect());
        _bdpObservers = [];
        log('STOP', '監控停止');
    }

})();
