// ==UserScript==
// @name         通用診斷面板骨架
// @namespace    browser-tools
// @version      4.0
// @description  診斷面板骨架：面板 UI + 相對時間戳 + 開始/停止 + 一鍵複製；任務專屬邏輯只需替換「探針區塊」。目前任務：對照真實點擊與合成點擊，找出合成點擊為何沒作用
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

    // ── 目前任務：合成的點擊送出了、卻沒有冒出地點卡 ──
    //
    // 現有的診斷只記了「我們做了什麼」，完全沒有記「Google 有沒有反應」。
    // 這支腳本補上另一半，並且用**對照**的方式呈現：
    // 先請使用者真的用滑鼠點一次，再讓程式點一次，把兩者並排比較。
    // 真實點擊做了什麼、合成點擊少了什麼，一比就知道。
    //
    // 監看四件事：
    //   ① reveal 請求——最決定性的訊號。手動點路線時一定會發出，
    //      合成點擊若沒發出，就代表事件根本沒被當成「點到地圖上的東西」
    //   ② DOM 新增節點——地點卡有沒有被建立
    //   ③ 畫布收到的事件序列（含 isTrusted）——我們送的有沒有真的送達
    //   ④ 點擊座標上的元素堆疊——有沒有東西擋在畫布上面

    const W = (typeof unsafeWindow !== 'undefined' && unsafeWindow) || window;
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    let _session = null;          // 目前這一輪的紀錄

    function newSession(kind) {
        _session = { kind, t0: performance.now(), events: [], reveals: 0, added: [], at: null };
        return _session;
    }
    const rel = () => Math.round(performance.now() - _session.t0);

    function summarise() {
        if (!_session) return;
        const s = _session;
        const seq = s.events.map(e => `${e.t}ms ${e.type}${e.trusted ? '(真)' : '(合成)'}`).join('　');
        log(`【${s.kind}】事件序列`, seq || '（畫布沒有收到任何事件）');
        log(`【${s.kind}】reveal 請求`, s.reveals
            ? `✅ 發出 ${s.reveals} 次 → Google 有處理這次點擊`
            : '❌ 完全沒有發出 → 沒被當成「點到地圖上的東西」');
        log(`【${s.kind}】新增的 DOM`, s.added.length
            ? s.added.slice(0, 6).join('\n      ')
            : '（沒有明顯的新增節點）');
        if (s.at) {
            const stack = document.elementsFromPoint(s.at[0], s.at[1]).slice(0, 4)
                .map(el => `<${el.tagName.toLowerCase()}>.${String(el.className).trim().split(/\s+/)[0] || '-'}`)
                .join(' > ');
            log(`【${s.kind}】座標上的堆疊`, `(${s.at[0]}, ${s.at[1]})　${stack}`);
        }
        log('──', '');
    }

    function mapCanvas() {
        return [...document.querySelectorAll('canvas')]
            .map(el => ({ el, r: el.getBoundingClientRect() }))
            .filter(o => o.r.width > 200 && o.r.height > 200)
            .sort((a, b) => b.r.width * b.r.height - a.r.width * a.r.height)[0] || null;
    }

    function armWatchers() {
        // ① reveal 請求
        const XHR = W.XMLHttpRequest;
        const oOpen = XHR.prototype.open;
        XHR.prototype.open = function (m, u) {
            if (_session && String(u).indexOf('/maps/preview/reveal') >= 0) {
                _session.reveals++;
                log('　→ 偵測到 reveal 請求', `於 ${rel()}ms`);
            }
            return oOpen.apply(this, arguments);
        };
        _restore.push(() => { XHR.prototype.open = oOpen; });
        const oFetch = W.fetch;
        W.fetch = function (...a) {
            const u = (a[0] && a[0].url) || a[0];
            if (_session && String(u).indexOf('/maps/preview/reveal') >= 0) {
                _session.reveals++;
                log('　→ 偵測到 reveal 請求', `於 ${rel()}ms（fetch）`);
            }
            return oFetch.apply(this, a);
        };
        _restore.push(() => { W.fetch = oFetch; });

        // ③ 畫布收到的事件
        const types = ['pointermove', 'pointerdown', 'pointerup', 'mousemove', 'mousedown', 'mouseup', 'click'];
        const onEv = (ev) => {
            if (!_session || !ev.target || ev.target.tagName !== 'CANVAS') return;
            if (ev.type === 'pointermove' || ev.type === 'mousemove') {
                // move 太多，只留最後一筆免得洗版
                const last = _session.events[_session.events.length - 1];
                if (last && last.type === ev.type) { last.t = rel(); return; }
            }
            _session.events.push({ t: rel(), type: ev.type, trusted: ev.isTrusted });
        };
        types.forEach(t => {
            document.addEventListener(t, onEv, true);
            _restore.push(() => document.removeEventListener(t, onEv, true));
        });

        // ② 新增的 DOM
        const mo = new MutationObserver(muts => {
            if (!_session) return;
            for (const m of muts) {
                for (const n of m.addedNodes) {
                    if (n.nodeType !== 1) continue;
                    const txt = (n.textContent || '').trim().slice(0, 40);
                    if (!txt) continue;
                    const cls = String(n.className || '').trim().split(/\s+/)[0] || '-';
                    _session.added.push(`${rel()}ms <${n.tagName.toLowerCase()}>.${cls} 「${txt}」`);
                }
            }
        });
        mo.observe(document.body, { childList: true, subtree: true });
        _bdpObservers.push(mo);
    }

    /** 真人點擊：靠使用者自己動手，我們只負責記錄 */
    function watchRealClick() {
        const onDown = (ev) => {
            if (!ev.isTrusted || !ev.target || ev.target.tagName !== 'CANVAS') return;
            newSession('真實點擊');
            _session.at = [Math.round(ev.clientX), Math.round(ev.clientY)];
            log('【真實點擊】開始', `座標 (${_session.at[0]}, ${_session.at[1]})，記錄 2.5 秒…`);
            setTimeout(summarise, 2500);
        };
        document.addEventListener('pointerdown', onDown, true);
        _restore.push(() => document.removeEventListener('pointerdown', onDown, true));
    }

    /** 合成點擊：完全照 route-rain v0.65 的流程重現 */
    async function synthClick() {
        const cv = mapCanvas();
        if (!cv) { log('錯誤', '找不到地圖畫布'); return; }
        const x = Math.round(cv.r.left + cv.r.width / 2);
        const y = Math.round(cv.r.top + cv.r.height / 2);
        newSession('合成點擊');
        _session.at = [x, y];
        log('【合成點擊】開始', `座標 (${x}, ${y})，流程與 route-rain 相同`);

        const PE = W.PointerEvent || PointerEvent;
        const ME = W.MouseEvent || MouseEvent;
        const fire = (type, buttons) => {
            const init = {
                bubbles: true, cancelable: true, composed: true, view: W,
                clientX: x, clientY: y, screenX: x, screenY: y,
                button: 0, buttons, pointerId: 1, pointerType: 'mouse', isPrimary: true,
            };
            cv.el.dispatchEvent(new PE(type, init));
            cv.el.dispatchEvent(new ME(type.replace('pointer', 'mouse'), init));
        };
        fire('pointermove', 0); await sleep(160);
        fire('pointermove', 0); await sleep(160);
        fire('pointerdown', 1); await sleep(60);
        fire('pointerup', 0);
        cv.el.dispatchEvent(new ME('click', {
            bubbles: true, cancelable: true, composed: true, view: W,
            clientX: x, clientY: y, button: 0, buttons: 0, detail: 1,
        }));
        setTimeout(summarise, 2500);
    }

    guide([
        '把地圖移到有路線的地方，讓畫面中心壓在路線上',
        '按「開始監控」',
        '先用滑鼠「真的點一下」路線，等 2.5 秒讓它記錄完',
        '再從 Tampermonkey 選單點「觸發合成點擊」',
        '兩份紀錄都出來後，按「複製」貼回',
    ]);

    GM_registerMenuCommand('觸發合成點擊', () => {
        if (!_session && !_restore.length) { alert('請先按面板上的「開始監控」'); return; }
        synthClick();
    });

    function PROBE_SETUP() {
        armWatchers();
        watchRealClick();
        log('START', '監看就緒。請先真的點一下路線，再用選單觸發合成點擊。');
    }

    function PROBE_TEARDOWN() {
        _session = null;
        _restore.forEach(fn => { try { fn(); } catch (err) { /* 還原失敗不影響停止 */ } });
        _restore = [];
        _bdpObservers.forEach(mo => mo.disconnect());
        _bdpObservers = [];
        log('STOP', '監控停止');
    }

})();
