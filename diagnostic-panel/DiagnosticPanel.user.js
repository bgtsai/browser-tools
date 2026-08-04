// ==UserScript==
// @name         通用診斷面板骨架
// @namespace    browser-tools
// @version      1.6
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

    // ── 目的：弄清楚 Google 自己「平滑移動＋縮放」的觸發鏈路 ──
    //
    // 不是驗證「點得動嗎」，而是要看清楚：使用者點下路線步驟之後，
    // 網頁內部到底發生了什麼，才有機會改成由我們用自己的座標去觸發。
    //
    // 觀察四件事：
    //   ① 被點的元素本身——jsaction 等屬性會透露 Google 內部的動作名稱
    //   ② 視野的變化曲線——高頻取樣，看它是連續動畫還是一次跳到位
    //   ③ 誰改的網址——攔 pushState/replaceState 並抓呼叫堆疊，
    //      堆疊裡會出現 Google 自己的函式名稱，那是往內挖的入口
    //   ④ 期間的網路請求與 rAF 次數——判斷動畫是本地算的還是要跟伺服器要資料
    //
    // 本腳本是 @grant none，跑在網頁環境（page context）。
    // 研究網頁內部機制必須在這個環境，沙箱裡看到的是包裝過的副本，
    // 抓到的堆疊也不是網頁自己的。

    const SAMPLE_MS = 50;          // 視野取樣間隔
    const WATCH_MS = 4000;         // 一次點擊後觀察多久
    let _samples = [];
    let _stacks = [];
    let _rafCount = 0;
    let _netCount = 0;
    let _watching = false;

    function vpOf() {
        const m = location.href.match(/\/@(-?[\d.]+),(-?[\d.]+),([\d.]+)z/);
        return m ? { lat: +m[1], lon: +m[2], zoom: +m[3] } : null;
    }

    /** 只留 Google 自己的框架，濾掉本腳本與瀏覽器內建的堆疊列 */
    function briefStack(err) {
        return String(err.stack || '').split('\n')
            .filter(l => l && !/DiagnosticPanel|briefStack|hookHistory/.test(l))
            .slice(0, 6)
            .map(l => l.trim().replace(/https?:\/\/[^\s)]+\//g, '').slice(0, 110))
            .join('\n        ');
    }

    function describeElement(el) {
        const out = [];
        let n = el, depth = 0;
        while (n && n.nodeType === 1 && depth < 5) {
            const attrs = [...n.attributes]
                .filter(a => /^(class|jsaction|jslog|jsname|data-|aria-|role)/.test(a.name))
                .map(a => `${a.name}="${a.value.slice(0, 90)}"`)
                .join(' ');
            out.push(`  [${depth}] <${n.tagName.toLowerCase()}> ${attrs}`);
            n = n.parentElement; depth++;
        }
        return out.join('\n');
    }

    function startWatch(label, el) {
        _samples = []; _stacks = []; _rafCount = 0; _netCount = 0;
        _watching = true;
        log('▶ 觸發', label + '\n' + describeElement(el));

        const t0 = performance.now();
        const timer = setInterval(() => {
            const vp = vpOf();
            if (vp) _samples.push({ t: Math.round(performance.now() - t0), ...vp });
            if (performance.now() - t0 >= WATCH_MS) {
                clearInterval(timer);
                _watching = false;
                report();
            }
        }, SAMPLE_MS);
        _rrRestore.push(() => clearInterval(timer));
    }

    function report() {
        // 只保留「有變化」的取樣點，看得出動畫的節奏
        const changed = [];
        let prev = null;
        for (const s of _samples) {
            const key = `${s.lat},${s.lon},${s.zoom}`;
            if (key !== prev) { changed.push(s); prev = key; }
        }
        log('②視野變化', changed.length <= 1
            ? '整段沒有變化（或只跳一次）'
            : `${changed.length} 次變化，網址是「持續更新」而非一次到位\n      ` +
              changed.slice(0, 14).map(s => `${s.t}ms  ${s.lat},${s.lon} @${s.zoom}z`).join('\n      ') +
              (changed.length > 14 ? `\n      …共 ${changed.length} 筆` : ''));

        if (changed.length >= 2) {
            const a = changed[0], b = changed[changed.length - 1];
            log('②總結', `歷時 ${b.t - a.t}ms　zoom ${a.zoom} → ${b.zoom}　` +
                `中心 ${a.lat},${a.lon} → ${b.lat},${b.lon}`);
        }
        log('③改網址的堆疊', _stacks.length
            ? _stacks.slice(0, 3).map((s, i) => `第 ${i + 1} 次（${s.type}）\n        ${s.stack}`).join('\n      ')
            : '期間沒有呼叫 pushState／replaceState');
        log('④其他', `requestAnimationFrame 呼叫 ${_rafCount} 次　網路請求 ${_netCount} 次`);
        log('DONE', '本次觀察結束。可以再點一個步驟繼續觀察，或按「停止監控」後複製。');
    }

    function hookHistory() {
        ['pushState', 'replaceState'].forEach(name => {
            const orig = history[name];
            history[name] = function (...args) {
                if (_watching) {
                    _stacks.push({ type: name, stack: briefStack(new Error()) });
                }
                return orig.apply(this, args);
            };
            _rrRestore.push(() => { history[name] = orig; });
        });
    }

    function PROBE_SETUP() {
        log('START', '請先在左側面板展開路線的「詳細資料」，然後點其中一個步驟。');

        hookHistory();

        const origRaf = window.requestAnimationFrame;
        window.requestAnimationFrame = function (cb) {
            if (_watching) _rafCount++;
            return origRaf.call(window, cb);
        };
        _rrRestore.push(() => { window.requestAnimationFrame = origRaf; });

        const origFetch = window.fetch;
        window.fetch = function (...a) { if (_watching) _netCount++; return origFetch.apply(this, a); };
        _rrRestore.push(() => { window.fetch = origFetch; });
        const origSend = XMLHttpRequest.prototype.send;
        XMLHttpRequest.prototype.send = function () { if (_watching) _netCount++; return origSend.apply(this, arguments); };
        _rrRestore.push(() => { XMLHttpRequest.prototype.send = origSend; });

        // 在捕獲階段監聽，才能在 Google 自己處理之前先記錄下來
        const onClick = (ev) => {
            if (_watching) return;                       // 上一次觀察還沒結束
            const el = ev.target;
            if (!el || el.nodeType !== 1) return;
            if (el.closest && el.closest('#bdp-panel')) return;   // 忽略面板自己
            const txt = (el.textContent || '').trim().slice(0, 40);
            startWatch(`點擊「${txt || '(無文字)'}」`, el);
        };
        document.addEventListener('click', onClick, true);
        _rrRestore.push(() => document.removeEventListener('click', onClick, true));

        // 順便把疑似「步驟清單」的元素列出來，方便找到要點哪裡
        const steps = [...document.querySelectorAll('[jsaction]')]
            .filter(e => /step|direction|maneuver/i.test(e.getAttribute('jsaction') || ''))
            .slice(0, 12);
        log('提示', steps.length
            ? `找到 ${steps.length} 個 jsaction 含 step/direction 的元素：\n      ` +
              steps.map(e => (e.getAttribute('jsaction') || '').slice(0, 80)).join('\n      ')
            : '目前找不到明顯的步驟元素，請先展開「詳細資料」再開始監控');

        log('READY', '監聽就緒。點一個路線步驟，會自動記錄 4 秒內的變化。');
    }

    function PROBE_TEARDOWN() {
        _watching = false;
        _rrRestore.forEach(fn => { try { fn(); } catch (err) { /* 還原失敗不影響停止 */ } });
        _rrRestore = [];
        _bdpObservers.forEach(mo => mo.disconnect());
        _bdpObservers = [];
        log('STOP', '監控停止');
    }

})();
