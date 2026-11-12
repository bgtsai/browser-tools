// ==UserScript==
// @name         Claude 用量通道診斷
// @namespace    browser-tools
// @version      1.2.0
// @description  診斷用：在 claude.ai 攔截網頁收到的資料（fetch 串流、XHR、WebSocket、EventSource），找出每次 API 呼叫的 token 用量欄位在哪個通道。結果只留在瀏覽器裡，按「複製結果」才進剪貼簿
// @match        https://claude.ai/*
// @grant        none
// @run-at       document-start
// @downloadURL  https://raw.githubusercontent.com/bgtsai/browser-tools/main/claude-usage-probe/ClaudeUsageProbe.user.js
// @updateURL    https://raw.githubusercontent.com/bgtsai/browser-tools/main/claude-usage-probe/ClaudeUsageProbe.user.js
// ==/UserScript==

(function () {
    'use strict';

    // 為什麼要 document-start：Console 版指令是在網頁載入後才貼，
    // 網頁在載入時就開好的 WebSocket 已經拿到原生建構子，包不到（2026-11-12 實測只抓到 fetch）。
    // 為什麼 @grant none：要覆寫的是頁面自己的 fetch／WebSocket；宣告任何 @grant 會進沙盒，
    // window.fetch 改到的是沙盒副本，靜默失效（01 第⑤條）。
    const VERSION = '1.2.0';
    const MAX_ENTRIES = 600;          // 記錄筆數上限，避免長時間開著吃記憶體
    const MAX_SAMPLES_PER_SOCKET = 8; // 每條 WebSocket／EventSource 留前幾則訊息的開頭，用來看格式
    const SAMPLE_LEN = 400;           // 每則樣本保留的字元數
    const CARRY_LEN = 400;            // 串流分塊時保留上一塊尾巴的字元數，避免欄位被切在兩塊之間
    // v1.1.0 輪詢：送出訊息（PerformAction）後主動查工作階段 GET，看累計用量是「每次 API 呼叫」就更新，還是整輪結束才更新
    const POLL_INTERVAL_MS = 2000;    // 輪詢間隔 (ms)
    const POLL_IDLE_STOP = 15;        // 有變化之後，連續幾次沒變就停（約 30 秒）
    const POLL_MAX_MS = 10 * 60 * 1000; // 單次輪詢最長時間 (ms)，避免忘了停
    // v1.2.0：StreamTimeline（connect+proto 二進位）原樣存進 window.__cupST，給 Claude 用 Claude in Chrome 讀回去離線解析
    // 只放在頁面記憶體，不進複製結果、不送任何地方（內含對話內容）
    const ST_MAX_BYTES = 4 * 1024 * 1024; // 存的總位元組上限
    const ST_RE = /ConversationService\/StreamTimeline/;
    window.__cupST = [];
    let stBytes = 0;

    // 欄位名執行時才拼接：頁面上與網路上都會出現我（Claude）回覆裡的說明文字，
    // 寫成完整字串會命中自己（02「搜尋字串會命中自己的回覆」）。
    // 只比對「未跳脫的 JSON 鍵＋數字或 {」，回覆內文裡的字串是跳脫過的（\"），不會命中。
    const KEYS = ['usage', ...['input', 'output', 'cache_read_input', 'cache_creation_input', 'cache_read', 'cache_write']
        .map(s => s + '_tok' + 'ens')];
    const RE = new RegExp('"(?:' + KEYS.join('|') + ')"\\s*:\\s*[\\d{]', 'g');

    const t0 = performance.now();
    const L = [];
    const T = { req: 0, bytes: 0, hit: 0, ws: 0, es: 0, xhr: 0, binary: 0 };
    const tm = () => +((performance.now() - t0) / 1000).toFixed(2);
    const now = () => new Date().toLocaleTimeString('zh-TW', { hour12: false, timeZone: 'Asia/Taipei' });
    const push = (e) => { if (L.length < MAX_ENTRIES) L.push(e); update(); };

    // 從命中位置往後取出完整的 {…} 物件（括號配對），取不完整就退回固定長度片段。
    function extractObject(txt, from) {
        const start = txt.indexOf('{', from);
        if (start < 0 || start - from > 40) return null;
        let depth = 0;
        for (let i = start; i < txt.length && i - start < 3000; i++) {
            if (txt[i] === '{') depth++;
            else if (txt[i] === '}') { depth--; if (depth === 0) return txt.slice(start, i + 1); }
        }
        return null;
    }

    function scan(src, txt) {
        let m, hits = [];
        RE.lastIndex = 0;
        while ((m = RE.exec(txt)) && hits.length < 6) {
            const key = m[0].slice(1, m[0].indexOf('"', 1));
            const obj = key === 'usage' ? extractObject(txt, m.index) : null;
            hits.push(obj ? { key, obj } : { key, ctx: txt.slice(Math.max(0, m.index - 200), m.index + 300) });
        }
        if (hits.length) { T.hit++; push({ t: tm(), clock: now(), src, hits }); }
    }

    // 失敗也要留痕跡（01 第⑤條：不要讓 fallback 靜默吞掉錯誤）
    const guard = (where, fn) => { try { fn(); } catch (er) { push({ t: tm(), err: where + ': ' + er }); } };

    // ── fetch（含串流回應）──
    const origFetch = window.fetch;
    const fetchWasNative = /\[native code\]/.test(Function.prototype.toString.call(origFetch));
    window.fetch = async function (...a) {
        const r = await origFetch.apply(this, a);
        guard('fetch', () => {
            const u = String(a[0] && a[0].url || a[0]);
            const me = (a[1] && a[1].method) || (a[0] && a[0].method) || 'GET';
            noteUrl(u, me);
            T.req++;
            const e = { t: tm(), clock: now(), kind: 'fetch', u: u.slice(0, 200), me, st: r.status, ct: r.headers.get('content-type'), len: 0 };
            push(e);
            // 只 clone 一次：每個沒讀的 clone 都會把整個串流暫存在記憶體裡
            const c = r.clone();
            const rd = c.body && c.body.getReader ? c.body.getReader() : null;
            if (!rd) return;
            const d = new TextDecoder();
            // 每個回應各自一筆，同網址的多條串流不會混在一起
            const stR = ST_RE.test(u) ? (window.__cupST.push({ t: Date.now(), u, chunks: [] }), window.__cupST[window.__cupST.length - 1]) : null;
            let carry = '';
            (async () => {
                for (;;) {
                    const { done, value } = await rd.read();
                    if (done) break;
                    if (stR && stBytes < ST_MAX_BYTES) { stBytes += value.length; stR.chunks.push({ t: Date.now(), b: value.slice() }); }
                    const x = d.decode(value, { stream: true });
                    e.len += x.length; T.bytes += x.length;
                    scan(u.slice(0, 100), carry + x);
                    carry = x.slice(-CARRY_LEN);
                    update();
                }
            })().catch(er => { e.err = String(er); });
        });
        return r;
    };

    // ── XMLHttpRequest ──
    const XO = XMLHttpRequest.prototype.open, XS = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (me, u, ...rest) { this.__cupInfo = { me, u: String(u).slice(0, 200) }; return XO.call(this, me, u, ...rest); };
    XMLHttpRequest.prototype.send = function (...a) {
        guard('xhr', () => {
            const info = this.__cupInfo || {};
            T.req++; T.xhr++;
            this.addEventListener('load', () => guard('xhr-load', () => {
                const txt = typeof this.response === 'string' ? this.response : (this.responseType === '' ? this.responseText : '');
                T.bytes += txt.length;
                push({ t: tm(), clock: now(), kind: 'xhr', u: info.u, me: info.me, st: this.status, len: txt.length });
                if (txt) scan(info.u, txt);
            }));
        });
        return XS.apply(this, a);
    };

    // ── WebSocket ──
    function wireSocket(kind, url, target) {
        const rec = { t: tm(), clock: now(), kind, u: String(url).slice(0, 200), msgs: 0, samples: [] };
        push(rec);
        target.addEventListener('message', ev => guard(kind + '-msg', () => {
            rec.msgs++;
            const handle = (txt) => {
                T.bytes += txt.length;
                if (rec.samples.length < MAX_SAMPLES_PER_SOCKET) rec.samples.push(txt.slice(0, SAMPLE_LEN));
                scan(kind + ' ' + rec.u.slice(0, 80), txt);
                update();
            };
            if (typeof ev.data === 'string') handle(ev.data);
            else {
                T.binary++;
                // 二進位訊息（例如 protobuf）：記大小，也試著當文字解碼，鍵名若是明文仍找得到
                const toText = ev.data instanceof Blob ? ev.data.arrayBuffer() : Promise.resolve(ev.data);
                toText.then(buf => {
                    if (rec.samples.length < MAX_SAMPLES_PER_SOCKET) rec.samples.push('[binary ' + buf.byteLength + ' bytes]');
                    handle(new TextDecoder('utf-8', { fatal: false }).decode(buf));
                }).catch(er => push({ t: tm(), err: 'binary decode: ' + er }));
            }
        }));
    }

    const OW = window.WebSocket;
    window.WebSocket = function (...a) {
        const w = new OW(...a);
        guard('ws', () => { T.req++; T.ws++; wireSocket('ws', a[0], w); });
        return w;
    };
    window.WebSocket.prototype = OW.prototype;
    Object.assign(window.WebSocket, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });

    // ── EventSource ──
    const OE = window.EventSource;
    if (OE) {
        window.EventSource = function (...a) {
            const es = new OE(...a);
            guard('es', () => { T.req++; T.es++; wireSocket('es', a[0], es); });
            return es;
        };
        window.EventSource.prototype = OE.prototype;
    }

    // ── v1.1.0：輪詢工作階段累計用量 ──
    // 自己發的請求一律用 origFetch，不經過上面的攔截，不會被重複記錄
    const SESSION_RE = /\/v1\/code\/sessions\/(cse_[A-Za-z0-9]+)/;
    const ORG_RE = /\/api\/organizations\/([0-9a-f-]{36})\//;
    const POLLS = [];      // 只記「累計值有變」的那幾次
    const PS = { sessionUrl: null, orgId: null, runs: 0, polls: 0, changes: 0, active: false, lastErr: null };
    let pollTimer = null, pollStart = 0, idle = 0, sawChange = false, last = null;

    function noteUrl(u, me) {
        const ms = u.match(SESSION_RE);
        if (ms && !PS.sessionUrl) PS.sessionUrl = '/v1/code/sessions/' + ms[1] + '?omit_bound_device=true';
        const mo = u.match(ORG_RE);
        if (mo && !PS.orgId) { PS.orgId = mo[1]; setTimeout(probeTree, 0); }
        if (me === 'POST' && /ConversationService\/PerformAction/.test(u)) startPoll('PerformAction');
    }

    function startPoll(why) {
        if (!PS.sessionUrl) { PS.lastErr = '還沒看到工作階段網址，無法輪詢（' + why + '）'; update(); return; }
        pollStart = Date.now(); idle = 0; sawChange = false;
        if (pollTimer) return; // 已在輪詢中：只延長，不重開
        PS.runs++; PS.active = true;
        POLLS.push({ clock: now(), t: tm(), event: '開始輪詢（' + why + '）' });
        pollTimer = setInterval(pollOnce, POLL_INTERVAL_MS);
        pollOnce();
    }

    function stopPoll(why) {
        clearInterval(pollTimer); pollTimer = null; PS.active = false;
        POLLS.push({ clock: now(), t: tm(), event: '停止輪詢（' + why + '）' });
        update();
    }

    async function pollOnce() {
        if (Date.now() - pollStart > POLL_MAX_MS) return stopPoll('超過最長時間');
        try {
            PS.polls++;
            const r = await origFetch(PS.sessionUrl, { credentials: 'include', headers: { 'anthropic-version': '2023-06-01' } }); // 沒帶這個標頭會回 400（2026-11-12 實測）
            const j = await r.json();
            const u = findUsage(j);
            if (!u) { PS.lastErr = '回應裡找不到 usage（HTTP ' + r.status + '）'; update(); return; }
            const sum = (u.cache_read_tokens || 0) + (u.cache_write_tokens || 0) + (u.input_tokens || 0);
            const st = findKey(j, 'status_category');
            if (!last || sum !== last.sum || u.output_tokens !== last.out) {
                PS.changes++;
                POLLS.push({ clock: now(), t: tm(), usage: u, status: st, delta_in: last ? sum - last.sum : null, delta_out: last ? u.output_tokens - last.out : null });
                if (last) sawChange = true;
                last = { sum, out: u.output_tokens };
                idle = 0;
            } else if (sawChange && ++idle >= POLL_IDLE_STOP) {
                stopPoll('連續 ' + POLL_IDLE_STOP + ' 次沒變化');
            }
            update();
        } catch (er) { PS.lastErr = 'poll: ' + er; update(); }
    }

    // 不假設欄位在哪一層：深度優先找第一個名為 usage 且帶數字的物件
    function findUsage(o, depth = 0) {
        if (!o || typeof o !== 'object' || depth > 6) return null;
        if (o.usage && typeof o.usage === 'object' && typeof o.usage.cache_read_tokens === 'number') return o.usage;
        for (const k of Object.keys(o)) { const f = findUsage(o[k], depth + 1); if (f) return f; }
        return null;
    }
    function findKey(o, key, depth = 0) {
        if (!o || typeof o !== 'object' || depth > 6) return null;
        if (key in o) return o[key];
        for (const k of Object.keys(o)) { const f = findKey(o[k], key, depth + 1); if (f !== null) return f; }
        return null;
    }

    // ── v1.1.0：Claude Counter 那條路（對話樹）在這個介面能不能用 ──
    // 只記結構（欄位名、訊息數、內容區塊種類），不記內容
    let TREE = null;
    async function probeTree() {
        if (TREE) return;
        const cm = location.pathname.match(/\/chat\/([0-9a-f-]{36})/);
        if (!cm || !PS.orgId) return;
        TREE = { pending: true };
        try {
            const r = await origFetch('/api/organizations/' + PS.orgId + '/chat_conversations/' + cm[1] + '?tree=true&rendering_mode=messages&render_all_tools=true', { credentials: 'include' });
            const txt = await r.text();
            TREE = { status: r.status, ct: r.headers.get('content-type'), len: txt.length };
            try {
                const j = JSON.parse(txt);
                TREE.topKeys = Object.keys(j);
                const msgs = Array.isArray(j.chat_messages) ? j.chat_messages : null;
                TREE.messages = msgs ? msgs.length : 'chat_messages 不存在';
                if (msgs && msgs.length) {
                    TREE.msgKeys = Object.keys(msgs[msgs.length - 1]);
                    const types = {};
                    msgs.forEach(m => (Array.isArray(m.content) ? m.content : []).forEach(c => { types[c && c.type] = (types[c && c.type] || 0) + 1; }));
                    TREE.contentTypes = types;
                }
            } catch (er) { TREE.parseErr = String(er); }
        } catch (er) { TREE = { err: String(er) }; }
        update();
    }

    // ── 面板（body 出現後才建立）──
    let statusEl = null;
    function update() {
        if (statusEl) statusEl.textContent = '請求 ' + T.req + '（WS ' + T.ws + '／ES ' + T.es + '）｜讀到 ' + T.bytes + ' 字元｜命中 ' + T.hit + ' 筆\n'
            + '輪詢 ' + (PS.active ? '進行中' : '停止') + '｜查 ' + PS.polls + ' 次｜變化 ' + PS.changes + ' 次｜對話樹 ' + (TREE ? (TREE.status || (TREE.pending ? '查詢中' : '失敗')) : '未查')
            + (PS.lastErr ? '\n⚠ ' + PS.lastErr : '');
    }

    function buildPanel() {
        const P = document.createElement('div');
        P.id = 'cup-panel';
        P.style.cssText = 'position:fixed;right:12px;bottom:12px;z-index:2147483647;background:#111;color:#eee;font:13px monospace;padding:8px;border-radius:6px;width:380px;box-sizing:border-box';
        const title = document.createElement('div');
        title.textContent = '用量通道診斷 v' + VERSION;
        title.style.cssText = 'font-weight:bold;margin-bottom:4px';
        statusEl = document.createElement('div');
        statusEl.style.whiteSpace = 'pre-wrap';
        const row = document.createElement('div');
        row.style.cssText = 'margin-top:6px;display:flex;gap:6px';
        const mk = (label, fn) => { const b = document.createElement('button'); b.textContent = label; b.style.cssText = 'font:13px sans-serif;padding:2px 8px;cursor:pointer'; b.onclick = fn; row.append(b); return b; };
        const copyBtn = mk('複製結果', () => {
            const out = JSON.stringify({ version: VERSION, ua: navigator.userAgent, page: location.pathname, fetchWasNative, hasEventSource: !!OE, T, PS, POLLS, TREE, L }, null, 1);
            const done = (label) => { copyBtn.textContent = label; setTimeout(() => { copyBtn.textContent = '複製結果'; }, 1500); };
            navigator.clipboard.writeText(out).then(() => done('已複製'), () => {
                const ta = document.createElement('textarea'); ta.value = out; document.body.append(ta); ta.select();
                document.execCommand('copy'); ta.remove(); done('已複製（備援）');
            });
        });
        mk('清空', () => { L.length = 0; POLLS.length = 0; Object.keys(T).forEach(k => { T[k] = 0; }); update(); });
        mk('收合', function () { const hide = statusEl.style.display !== 'none'; statusEl.style.display = hide ? 'none' : ''; this.textContent = hide ? '展開' : '收合'; });
        P.append(title, statusEl, row);
        document.body.append(P);
        update();
    }
    if (document.body) buildPanel();
    else document.addEventListener('DOMContentLoaded', buildPanel, { once: true });

    console.log('[ClaudeUsageProbe] v' + VERSION + ' 已載入');
})();
