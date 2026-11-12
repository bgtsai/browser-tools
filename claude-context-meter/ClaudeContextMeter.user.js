// ==UserScript==
// @name         Claude 上下文用量
// @namespace    browser-tools
// @version      0.4.0
// @description  在 claude.ai 的 Claude Code 遠端工作階段顯示目前上下文用量（對話樹估算＋/context 校正），換新對話串划算或用量過高時提醒
// @match        https://claude.ai/*
// @grant        none
// @run-at       document-start
// @downloadURL  https://raw.githubusercontent.com/bgtsai/browser-tools/main/claude-context-meter/ClaudeContextMeter.user.js
// @updateURL    https://raw.githubusercontent.com/bgtsai/browser-tools/main/claude-context-meter/ClaudeContextMeter.user.js
// ==/UserScript==

(function () {
    'use strict';

    // 為什麼 @grant none：要包的是頁面自己的 fetch；宣告任何 @grant 會進沙盒，window.fetch 改到沙盒副本、靜默失效。
    // 為什麼 document-start：網頁很早就存下原生 fetch；晚一步包，部分請求不會經過我們（2026-11-12 實測）。
    const VERSION = '0.4.0';

    // 推導見 README「預設值」；2026-11-12 以 /context 實測
    const CFG = {
        DEFAULT_FIXED: 135000,        // F：/context 總量 − 訊息
        DEFAULT_K: 1.82,              // k：/context 的訊息 ÷ 對話樹估算
        DEFAULT_WINDOW: 1000000,      // 上下文視窗（/context 的「/ 1m」）
        RULES_R: 42000,               // R：新對話串要讀的規則
        HANDOFF_H: 5000,              // H：交接內容
        WORK_W: 40000,                // W：新對話串要重讀的工作資料
        NEXT_ROUNDS: 15,              // 下一階段預估輪數（沒有其他資訊時的預設）
        K_READ: 0.1, K_WRITE: 1.25,   // 快取讀取／寫入相對正常價的比例（01 第⑫條）
        WARN_PCT: 0.70,               // 開始提醒的用量（黃）
        HIGH_PCT: 0.80,               // 紅：再往上可能來不及歸檔＋交接就被自動壓縮（96.7 萬壓縮 − 歸檔交接約 15 萬，推測值，待實測）
        WARN_STEP: 0.10,              // 之後每增加多少再提醒一次
        AUTO_CTX: true,               // 自動送 /context 校正
        AUTO_FIRST_MIN_MSGS: 2,       // 沒有校正點時，至少幾則訊息才送
        AUTO_RECHECK_PCT: 0.65,       // 估算到這個用量、且上次校正低於 AUTO_RECHECK_BELOW 時再送一次
        AUTO_RECHECK_BELOW: 0.60,
        AUTO_MAX_PER_CHAT: 3,
        AUTO_MIN_GAP_MS: 15 * 60 * 1000,
        TAG_ON_SEND: true,            // 送出訊息時在尾端附用量標記，讓 Claude 每輪讀得到（使用者定案，2026-11-12）
        REFRESH_THROTTLE_MS: 1500,    // 同一輪結束常連續觸發好幾次，合併成一次（節流，不是防手震）
    };
    const LS = 'ccm:';                // localStorage 前綴（專案前綴，避免撞名）
    const SESSION_RE = /\/v1\/code\/sessions\/cse_[A-Za-z0-9]+/;
    const ORG_RE = /\/api\/organizations\/([0-9a-f-]{36})\//;
    const CHAT_RE = /\/chat\/([0-9a-f-]{36})/;
    const CTX_HEAD = '## Context' + ' Usage'; // 拆開寫：避免本檔被別的工具用文字搜尋時誤判
    const SEL = {
        input: '[data-testid="chat-input"]', send: 'button[data-testid="chat-input-send"]',
        titleSplit: '[data-testid="session-title-split"]', // 頁首「標題 ⌄」那一排（跟 claude-chat-handover 同一組選擇器）
        moreBtn: 'button[aria-haspopup="menu"]',          // 標題旁的 ⌄
    };

    const state = { orgId: null, last: null, err: null, autoPending: false };
    window.__ccm = state; // 給除錯用（Claude in Chrome 讀得到）

    const load = (k, d) => { try { const v = localStorage.getItem(LS + k); return v ? JSON.parse(v) : d; } catch (e) { return d; } };
    const save = (k, v) => { try { localStorage.setItem(LS + k, JSON.stringify(v)); } catch (e) { /* 存不了不影響顯示 */ } };

    // ── 1. 攔 fetch：看到工作階段 GET 就代表一輪剛結束 ──
    const origFetch = window.fetch;
    window.fetch = async function (...a) {
        const r = await origFetch.apply(this, a);
        try {
            const u = String(a[0] && a[0].url || a[0]);
            const mo = u.match(ORG_RE);
            if (mo) state.orgId = mo[1];
            const me = (a[1] && a[1].method) || (a[0] && a[0].method) || 'GET';
            if (me === 'GET' && SESSION_RE.test(u)) scheduleRefresh();
        } catch (e) { state.err = 'hook: ' + e; }
        return r;
    };

    let lastRun = 0, timer = null;
    function scheduleRefresh() {
        if (timer) return;
        const wait = Math.max(0, CFG.REFRESH_THROTTLE_MS - (Date.now() - lastRun));
        timer = setTimeout(() => { timer = null; lastRun = Date.now(); refresh().catch(e => { state.err = 'refresh: ' + e; render(); }); }, wait);
    }

    // ── 2. 估算 ──
    function estTokens(s) {
        let cjk = 0, other = 0;
        for (const ch of s) { if (/[　-鿿가-힯＀-￯]/.test(ch)) cjk++; else other++; }
        return cjk + other / 3.5;
    }
    function blockText(b) {
        if (!b) return '';
        if (b.type === 'text') return b.text || '';
        if (b.type === 'thinking') return ''; // 舊回合的思考不在後續的上下文裡
        if (b.type === 'tool_use') return JSON.stringify(b.input || {});
        return JSON.stringify(b.content || '');
    }
    function msgTokens(m) {
        let s = (m.content || []).map(blockText).join('\n');
        (m.attachments || []).forEach(x => { if (x && x.extracted_content) s += x.extracted_content; });
        return estTokens(s);
    }
    function trunkOf(tree) {
        const byId = new Map((tree.chat_messages || []).map(m => [m.uuid, m]));
        const out = []; let cur = tree.current_leaf_message_uuid; const seen = new Set();
        while (cur && byId.has(cur) && !seen.has(cur)) { seen.add(cur); const m = byId.get(cur); out.push(m); cur = m.parent_message_uuid; }
        return out.reverse();
    }
    // /context 輸出：Tokens: 404.4k / 1m (40%)、| Messages | 269.5k |
    function parseNum(s) { const m = String(s).trim().match(/^([\d.]+)\s*([km]?)$/i); if (!m) return null; return parseFloat(m[1]) * ({ k: 1e3, m: 1e6 }[m[2].toLowerCase()] || 1); }
    function parseContext(text) {
        const t = text.match(/\*\*Tokens:\*\*\s*([\d.]+[km]?)\s*\/\s*([\d.]+[km]?)/i);
        const msg = text.match(/\|\s*Messages\s*\|\s*([\d.]+[km]?)\s*\|/i);
        if (!t || !msg) return null;
        const total = parseNum(t[1]), win = parseNum(t[2]), messages = parseNum(msg[1]);
        return total && win && messages ? { total, win, messages } : null;
    }

    async function refresh() {
        const cm = location.pathname.match(CHAT_RE);
        if (!cm || !state.orgId) return;
        const cid = cm[1];
        const r = await origFetch('/api/organizations/' + state.orgId + '/chat_conversations/' + cid + '?tree=true&rendering_mode=messages&render_all_tools=true', { credentials: 'include' });
        if (!r.ok) { state.err = '對話樹 HTTP ' + r.status; render(); return; }
        const trunk = trunkOf(await r.json());
        const per = trunk.map(msgTokens);
        const estNow = per.reduce((a, b) => a + b, 0);

        // 最近一次 /context
        let calib = null;
        for (let i = trunk.length - 1; i >= 0 && !calib; i--) {
            const txt = (trunk[i].content || []).filter(b => b.type === 'text').map(b => b.text || '').join('\n');
            if (txt.startsWith(CTX_HEAD)) {
                const p = parseContext(txt);
                if (p) { const before = per.slice(0, i).reduce((a, b) => a + b, 0); calib = { ...p, idx: i, before, k: before > 0 ? p.messages / before : CFG.DEFAULT_K, fixed: p.total - p.messages }; }
            }
        }
        if (calib) save('lastCalib', { fixed: calib.fixed, k: calib.k, win: calib.win, at: Date.now() });
        const g = load('lastCalib', null);
        const fixed = calib ? calib.fixed : (g ? g.fixed : CFG.DEFAULT_FIXED);
        const k = calib ? calib.k : (g ? g.k : CFG.DEFAULT_K);
        const win = calib ? calib.win : (g ? g.win : CFG.DEFAULT_WINDOW);
        // 有校正點時等同「/context 總量 ＋ k ×（之後新增的估算）」：k × 校正點之前的估算 ＝ 訊息，代數上相同
        const C = fixed + k * estNow;

        const B = fixed + CFG.RULES_R + CFG.HANDOFF_H + CFG.WORK_W;
        const nStar = C > B ? (CFG.K_WRITE * B) / (CFG.K_READ * (C - B)) : Infinity;
        const pct = C / win;
        const switchWorth = CFG.NEXT_ROUNDS >= nStar;

        state.last = { cid, t: Date.now(), C: Math.round(C), pct, win, fixed: Math.round(fixed), k: +k.toFixed(3), estNow: Math.round(estNow), msgs: trunk.length,
            calib: calib ? { total: calib.total, messages: calib.messages, idx: calib.idx, ago: trunk.length - 1 - calib.idx } : null,
            source: calib ? '此對話串的 /context' : (g ? '其他對話串的校正' : '預設值'), B: Math.round(B), nStar, switchWorth };
        state.err = null;
        warnIfNeeded(cid, pct);
        render();
        maybeAutoContext(cid, trunk.length, pct, calib);
    }

    // ── 3. 提醒：70% 起每 +10% 一次；換串划算時標示 ──
    function warnIfNeeded(cid, pct) {
        if (pct < CFG.WARN_PCT) return;
        const level = Math.floor((pct - CFG.WARN_PCT) / CFG.WARN_STEP + 1e-9);
        const key = 'warned:' + cid;
        if (load(key, -1) >= level) return;
        save(key, level);
        state.flash = Date.now();
    }

    // ── 4. 自動送 /context ──
    async function maybeAutoContext(cid, nMsgs, pct, calib) {
        if (!CFG.AUTO_CTX || state.autoPending) return;
        const rec = load('auto:' + cid, { n: 0, t: 0 });
        if (rec.n >= CFG.AUTO_MAX_PER_CHAT || Date.now() - rec.t < CFG.AUTO_MIN_GAP_MS) return;
        const need = (!calib && nMsgs >= CFG.AUTO_FIRST_MIN_MSGS)
            || (calib && pct >= CFG.AUTO_RECHECK_PCT && calib.total / calib.win < CFG.AUTO_RECHECK_BELOW);
        if (!need) return;
        const ed = document.querySelector(SEL.input);
        if (!ed || ed.innerText.trim()) return; // 使用者有沒送出的字就不動，下一輪再說
        if (await sendContext('自動 /context')) save('auto:' + cid, { n: rec.n + 1, t: Date.now() });
    }
    // 送一次 /context（自動與〔校正〕共用）；輸入框有字時不送。成功回 true
    async function sendContext(who) {
        const ed = document.querySelector(SEL.input);
        if (!ed || ed.innerText.trim() || state.autoPending) return false;
        state.autoPending = true; render();
        try {
            ed.focus();
            const dt = new DataTransfer(); dt.setData('text/plain', '/context');
            ed.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
            await sleep(300);
            if (!ed.innerText.trim().startsWith('/context')) document.execCommand('insertText', false, '/context');
            await sleep(300);
            if (ed.innerText.trim() !== '/context') { state.err = who + '：填入失敗'; return false; }
            const btn = document.querySelector(SEL.send);
            if (!btn) { state.err = who + '：找不到送出鈕'; return false; }
            btn.click();
            await sleep(1500);
            if (ed.innerText.trim()) { state.err = who + '：送出後輸入框沒清空'; return false; }
            state.calibWait = { idx: state.last && state.last.calib ? state.last.calib.idx : -1, t: Date.now() };
            return true;
        } finally { state.autoPending = false; render(); }
    }
    const sleep = ms => new Promise(r => setTimeout(r, ms));

    // ── 5. 頁首標籤：⌄ 右邊、「交接對話串」左邊 ──
    // 那一排是 claude.ai 框架管的；重繪會把我們的節點清掉，所以用 MutationObserver 補插（做法同 claude-chat-handover）。
    // 永遠插在 ⌄ 正後面；交接鈕 v1.2.0 起看到 .ccm-meter 會排在它後面，兩邊各自補插也不會互換位置。
    // 字級、高度照同一排的既有元件（03 第⑮節）：2026-11-12 量到 14px／行高 20、⌄ 高 28、交接鈕左邊距 8、圓角 8。
    let el = null;
    function mount() {
        const split = document.querySelector(SEL.titleSplit);
        const more = split && split.querySelector(SEL.moreBtn);
        if (!more) return false;
        if (!el) {
            el = document.createElement('span');
            el.id = 'ccm-badge';
            el.className = 'ccm-meter';
            el.setAttribute('role', 'button');
            el.addEventListener('click', e => { e.stopPropagation(); togglePanel(); });
        }
        if (more.nextElementSibling !== el) {
            const h = Math.round(more.getBoundingClientRect().height) || 28;
            el.style.cssText = 'display:inline-flex;align-items:center;flex:0 0 auto;white-space:nowrap;box-sizing:border-box;'
                + 'height:' + h + 'px;margin-left:8px;padding:0 10px;border-radius:8px;font-size:14px;line-height:20px;cursor:pointer';
            more.after(el);
        }
        return true;
    }
    function render() {
        if (!document.body) return;
        const onChat = CHAT_RE.test(location.pathname);
        if (!onChat || !mount()) { if (el) el.style.display = 'none'; if (strip) renderStrip(null); closePanel(); return; }
        const L = state.last;
        el.style.display = L || state.err ? 'inline-flex' : 'none';
        if (!L) { el.textContent = '—'; el.title = state.err || ''; paint('normal'); renderStrip(null); renderPanel(); return; }
        el.textContent = Math.round(L.pct * 100) + '%' + (L.switchWorth ? '・建議換串' : '');
        el.title = '點一下看詳細資料';
        paint(L.pct >= CFG.HIGH_PCT ? 'high' : (L.pct >= CFG.WARN_PCT || L.switchWorth) ? 'warn' : 'normal');
        renderStrip(L.pct >= CFG.HIGH_PCT ? 'red' : L.pct >= CFG.WARN_PCT ? 'yellow' : L.switchWorth ? 'blue' : null);
        renderPanel();
    }

    // ── 6. 詳細面板（點標籤開關）：主數字 → 判斷 → 依據 → 〔校正〕（mockup【28_圖】定案）──
    // 掛在 body、fixed 對齊標籤左下：放進框架那一排會被重繪清掉（03 第⑨節）。
    let panel = null;
    const isDark = () => { const bg = getComputedStyle(document.body).backgroundColor.match(/\d+/g) || [255, 255, 255]; return (0.299 * bg[0] + 0.587 * bg[1] + 0.114 * bg[2]) < 128; };
    const man = n => (n / 1e4).toFixed(1).replace(/\.0$/, '') + ' 萬';
    function onEsc(e) { if (e.key === 'Escape' && panel) { e.preventDefault(); e.stopPropagation(); closePanel(); } }
    function onOutside(e) { if (panel && !panel.contains(e.target) && !(el && el.contains(e.target))) closePanel(); }
    function closePanel() {
        if (!panel) return;
        panel.remove(); panel = null;
        document.removeEventListener('keydown', onEsc, true);
        document.removeEventListener('pointerdown', onOutside, true);
    }
    function togglePanel() {
        if (panel) { closePanel(); return; }
        panel = document.createElement('div');
        panel.className = 'ccm-panel';
        document.body.append(panel);
        document.addEventListener('keydown', onEsc, true);      // 捕獲階段：一次只關最上層（03 第⑮節）
        document.addEventListener('pointerdown', onOutside, true);
        renderPanel();
    }
    function renderPanel() {
        if (!panel) return;
        if (!el || !el.isConnected || el.style.display === 'none') { closePanel(); return; }
        const L = state.last, d = isDark();
        const r = el.getBoundingClientRect();
        const fg = d ? '#eeeeee' : '#1f1f1f', dim = d ? '#a6a6a6' : '#767676', line = d ? 'rgba(255,255,255,.16)' : 'rgba(0,0,0,.10)';
        panel.style.cssText = 'position:fixed;z-index:2147483646;box-sizing:border-box;width:340px;padding:12px 14px;border-radius:8px;'
            + 'font-size:14px;line-height:20px;left:' + Math.round(r.left) + 'px;top:' + Math.round(r.bottom + 8) + 'px;'
            + 'background:' + (d ? '#30302e' : '#f4f4f2') + ';color:' + fg + ';border:1px solid ' + line + ';box-shadow:0 4px 16px rgba(0,0,0,' + (d ? '.5' : '.14') + ')';
        const busy = state.autoPending || !!state.calibWait;
        const ed = document.querySelector(SEL.input);
        const typing = !!(ed && ed.innerText.trim());
        const row = (txt, css) => { const x = document.createElement('div'); x.style.cssText = css || ''; x.textContent = txt; return x; };
        const parts = [];
        if (L) {
            parts.push(row(man(L.C) + ' / ' + man(L.win) + '（' + Math.round(L.pct * 100) + '%）', 'font-weight:600'));
            const j = document.createElement('div'); j.style.marginTop = '8px';
            j.append('換新對話串約 ', Object.assign(document.createElement('b'), { textContent: (isFinite(L.nStar) ? Math.ceil(L.nStar) : '—') + ' 輪' }),
                '後回本，下一階段預估 ' + CFG.NEXT_ROUNDS + ' 輪', document.createElement('br'),
                Object.assign(document.createElement('b'), { textContent: L.switchWorth ? '建議換' : '不用換' }));
            parts.push(j);
            const basis = row('', 'margin-top:8px;padding-top:8px;border-top:1px solid ' + line + ';color:' + dim);
            basis.append('校正：' + L.source + (L.calib ? '（' + L.calib.ago + ' 則訊息前）' : ''), document.createElement('br'),
                '固定部分 F ' + man(L.fixed) + '・係數 k ' + L.k + '・v' + VERSION);
            parts.push(basis);
        } else parts.push(row(state.err ? '⚠ ' + state.err : '還沒有資料', 'color:' + dim));
        if (L && state.err) parts.push(row('⚠ ' + state.err, 'margin-top:6px;color:' + (d ? '#ffd37a' : '#9a5b00')));
        const act = row('', 'margin-top:10px;display:flex;align-items:center;gap:10px');
        const b = document.createElement('button');
        b.type = 'button'; b.className = 'ccm-calib';
        b.textContent = busy ? '校正中…' : '校正';
        const off = busy || typing;
        b.style.cssText = 'height:28px;padding:0 12px;border-radius:8px;box-sizing:border-box;font:inherit;color:inherit;cursor:' + (off ? 'default' : 'pointer') + ';'
            + 'background:' + (d ? '#3a3a3a' : '#ffffff') + ';border:1px solid ' + (d ? 'rgba(255,255,255,.25)' : 'rgba(0,0,0,.25)') + ';opacity:' + (off ? '.45' : '1');
        b.setAttribute('aria-disabled', off ? 'true' : 'false');
        const why = row(typing && !busy ? '輸入框有字，先送出或清空' : '', 'color:' + (d ? '#ffd37a' : '#9a5b00'));
        why.className = 'ccm-why';
        b.addEventListener('click', () => { if (!off) sendContext('校正'); });
        act.append(b, why);
        parts.push(act);
        panel.replaceChildren(...parts);
    }
    // 面板開著時，輸入框打字／清空要即時反映到〔校正〕的停用狀態
    setInterval(() => {
        if (state.calibWait && (Date.now() - state.calibWait.t > 90000 || (state.last && state.last.calib && state.last.calib.idx > state.calibWait.idx))) { state.calibWait = null; renderPanel(); }
        if (panel) { const ed = document.querySelector(SEL.input); const t = !!(ed && ed.innerText.trim()); if (t !== panel.__typing) { panel.__typing = t; renderPanel(); } }
    }, 500);

    // ── 7. 視窗底部燈帶（Z-Library 工具箱的底部燈帶同一套做法）：紅 ≥80% > 黃 ≥70% > 藍 建議換串，一直呼吸 ──
    // 外層只管淡入淡出、內層只管上色與呼吸：呼吸會動 opacity，跟淡入淡出放同一個元素會互相打架。
    const STRIP = {
        blue:   { color: '#2979FF', white: 0.4,  alpha: 0.65 },
        yellow: { color: '#F2B705', white: 0.6,  alpha: 0.65 }, // Z-Library 沒有黃，新調（mockup 定案）
        red:    { color: '#FF0000', white: 0.28, alpha: 0.65 },
    };
    let strip = null;
    function renderStrip(kind) {
        if (!strip) {
            const st = document.createElement('style');
            st.textContent = '@keyframes ccmBreathe{0%,100%{opacity:.35}50%{opacity:1}}';
            (document.head || document.documentElement).append(st);
            strip = document.createElement('div');
            strip.className = 'ccm-strip';
            strip.style.cssText = 'position:fixed;left:0;bottom:0;width:100%;height:4px;z-index:2147483000;pointer-events:none;opacity:0;transition:opacity 180ms ease';
            strip.append(document.createElement('div'));
            document.body.append(strip);
        }
        strip.dataset.kind = kind || '';
        if (!kind) { strip.style.opacity = '0'; return; }
        const c = STRIP[kind], rgb = c.color.match(/\w\w/g).map(h => parseInt(h, 16)).join(',');
        strip.firstChild.style.cssText = 'height:100%;width:100%;background:' + c.color + ';animation:ccmBreathe 1.4s ease-in-out infinite;'
            + 'box-shadow:0 0 7px 1.4px rgba(255,255,255,' + c.white + '),0 0 9.8px 2.8px rgba(' + rgb + ',' + c.alpha + ')';
        strip.style.opacity = '1';
    }
    function paint(level) {
        // 依頁面底色判斷深淺（常駐介面跟網站一致：03 第①節）
        const bg = getComputedStyle(document.body).backgroundColor.match(/\d+/g) || [255, 255, 255];
        const dark = (0.299 * bg[0] + 0.587 * bg[1] + 0.114 * bg[2]) < 128;
        const C = {
            normal: dark ? ['#3a3a3a', '#e8e8e8', 'rgba(255,255,255,.16)'] : ['#f4f4f2', '#3d3d3a', 'rgba(0,0,0,.10)'],
            warn: dark ? ['#4a3a12', '#ffd37a', 'rgba(255,200,80,.45)'] : ['#fff3d6', '#7a4f00', 'rgba(200,140,0,.45)'],
            high: dark ? ['#4a1d1d', '#ffb3b3', 'rgba(255,120,120,.5)'] : ['#fde8e8', '#9b1c1c', 'rgba(200,40,40,.45)'],
        }[level];
        el.style.background = C[0]; el.style.color = C[1]; el.style.border = '1px solid ' + C[2];
    }

    // 換頁（單頁應用）時重新整理顯示
    let lastPath = '';
    setInterval(() => { if (location.pathname !== lastPath) { lastPath = location.pathname; state.last = null; render(); if (CHAT_RE.test(lastPath)) scheduleRefresh(); } }, 1000);
    // ── 8. 送出時在訊息尾端附用量標記：[ctx 47%・47.2萬] ──
    // Claude 在 claude.ai 遠端工作階段看不到 hook、也送不了 /context；附在使用者訊息裡是它每輪唯一讀得到的地方（01 第⑫條）。
    // 做法：攔下送出（Enter、送出鈕）→ 游標移到尾端、新段落插入標記 → 下一格再按一次送出鈕（帶旗標放行）。
    // 不在攔截當下直接放行：ProseMirror 讀 DOM 變動是非同步的，同一個事件裡送出可能送到加標記前的內容。
    // 以 / 開頭的不加（/context 這類本機指令，加了會變成一般訊息）；已經有標記、還沒有估算值時也不加。
    const TAG_RE = /\[ctx \d+%・[\d.]+萬\]\s*$/;
    let passSend = false;
    function tagText() { const L = state.last; return L ? '[ctx ' + Math.round(L.pct * 100) + '%・' + (L.C / 1e4).toFixed(1) + '萬]' : ''; }
    function shouldTag(ed) {
        if (!CFG.TAG_ON_SEND || passSend || state.autoPending || !ed || !CHAT_RE.test(location.pathname)) return false;
        const t = ed.innerText.trim();
        return !!t && !t.startsWith('/') && !TAG_RE.test(t) && !!tagText();
    }
    function tagAndSend(ed) {
        ed.focus();
        const sel = getSelection(); sel.selectAllChildren(ed); sel.collapseToEnd();
        document.execCommand('insertText', false, '\n' + tagText());
        setTimeout(() => {
            const btn = document.querySelector(SEL.send);
            if (!btn) { state.err = '用量標記：找不到送出鈕（標記已加在輸入框，請手動送出）'; render(); return; }
            passSend = true; try { btn.click(); } finally { passSend = false; }
        }, 60);
    }
    document.addEventListener('keydown', e => {
        if (e.key !== 'Enter' || e.shiftKey || e.isComposing || e.keyCode === 229) return; // 輸入法選字中的 Enter 不算送出
        const ed = e.target && e.target.closest && e.target.closest(SEL.input);
        if (!shouldTag(ed)) return;
        e.preventDefault(); e.stopImmediatePropagation();
        tagAndSend(ed);
    }, true);
    document.addEventListener('click', e => {
        const btn = e.target && e.target.closest && e.target.closest(SEL.send);
        if (!btn) return;
        const ed = document.querySelector(SEL.input);
        if (!shouldTag(ed)) return;
        e.preventDefault(); e.stopImmediatePropagation();
        tagAndSend(ed);
    }, true);

    // 框架重繪頁首後補插（節流）
    let mountTimer = null;
    new MutationObserver(() => {
        if (mountTimer) return;
        mountTimer = setTimeout(() => { mountTimer = null; try { const split = document.querySelector(SEL.titleSplit); if (split && (!el || !split.contains(el))) render(); } catch (e) { console.log('[ClaudeContextMeter] 掛標籤失敗', e); } }, 300);
    }).observe(document, { childList: true, subtree: true }); // 觀察 document 本身：Chromium 在 document-start 時 documentElement 可能還是 null，observe 會丟例外、後面的程式整段不跑（測試實測）
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', render, { once: true }); else render();
    console.log('[ClaudeContextMeter] v' + VERSION + ' 已載入');
})();
