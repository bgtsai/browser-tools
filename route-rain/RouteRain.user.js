// ==UserScript==
// @name         Route Rain — 路線降雨預報
// @namespace    https://github.com/bgtsai/browser-tools
// @version      0.1.0
// @description  在 Google Maps 路線面板加一個「路雨」按鈕，顯示沿途各鄉鎮在不同出發時間下的降雨機率表格
// @author       bgtsai
// @match        https://www.google.com/maps/*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=google.com
// @connect      routes.googleapis.com
// @connect      opendata.cwa.gov.tw
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @grant        GM_getResourceText
// @resource     twTowns https://raw.githubusercontent.com/bgtsai/browser-tools/main/route-rain/tw_town_boundaries_encoded.json
// @downloadURL  https://raw.githubusercontent.com/bgtsai/browser-tools/main/route-rain/RouteRain.user.js
// @updateURL    https://raw.githubusercontent.com/bgtsai/browser-tools/main/route-rain/RouteRain.user.js
// @run-at       document-idle
// ==/UserScript==

/* eslint-disable no-unused-vars */
(function () {
    'use strict';

    // ────────────────────────────────────────────────────────────────
    // 設定常數
    // 命名用功能語意而非數值；時間一律標單位 (ms)/(sec)；排列依執行時序
    // ────────────────────────────────────────────────────────────────

    const PREFIX = 'rr';                       // 自己加到 DOM 上的 class／屬性一律加專案前綴

    // 節點切分
    const SUBDIVIDE_SEC = 15 * 60;             // 同一鄉鎮停留超過此秒數就多切一個節點
    const FLAP_GAP_SEC = 180;                  // 同一鄉鎮兩次出現間隔在此秒數內視為同一次穿越（邊界抖動）
    const MIN_DWELL_SEC = 60;                  // 累加停留低於此秒數的鄉鎮不產生節點（切到邊角）
    const ROAD_NAME_MAX_GAP_SEC = 300;         // 節點所在 step 無路名時，前後找路名的時間差上限

    // 表格呈現
    const CELL_PX = 20;                        // 色塊邊長
    const GAP_PX = 4;                          // 色塊間隔
    const PITCH_PX = CELL_PX + GAP_PX;         // 每欄節距
    const ROWH_W_PX = 126;                     // 左側地點欄寬度
    const PANEL_WIDE_PX = 900;                 // 啟用時面板加寬到此寬度
    const DEPART_STEP_MIN = 15;                // 出發時間欄距（分鐘）
    const DEPART_COLUMNS_MAX = 96;             // 欄數上限（96 欄 × 15 分 = 24 小時）
                                               // 預報涵蓋 96 小時、可排到約 370 欄，但步行模式節點多，
                                               // 格數會上萬；第一版先封頂，確認效能後再放寬
    const TIMELINE_AXIS_Y_PX = 27;             // 時間軸線距標頭頂端的距離
    const HEADER_H_PX = 64;                    // 標頭列高度

    // 預報資料
    const CWA_BUCKET_HOURS = 3;                // 降雨機率的時段長度，timeFrom/timeTo 必須對齊此邊界
    const FORECAST_HORIZON_HOURS = 96;         // 「未來3天」資料集實測涵蓋 96 小時
    // 儲存鍵
    const KEY_GOOGLE = 'googleMapsApiKey';
    const KEY_CWA = 'cwaAuthorization';

    // ────────────────────────────────────────────────────────────────
    // 依賴 Google Maps DOM 結構的選擇器，集中一處
    // 網站改版時只改這個物件。class 名稱是混淆過的，會隨版本變動——
    // 因此凡是能用「可見文字」或「結構特徵」判斷的，優先用那種方式。
    // ────────────────────────────────────────────────────────────────
    const SITE_SELECTORS = {
        panelCandidate: 'div.m6QErb.WNBkOb.XiKgde',   // 路線面板外層（量到寬 408、高 >400）
        optionsRowClassHint: 'MlqQ3d',                 // 「選項」按鈕所在的那一列
        sendCopyRowClassHint: 'O7gcad',                // 將路線傳送至／複製連結
        routeListClassHint: 'm6QErb XiKgde',           // 三條路線的容器
        elevationClassHint: 'KqEFYb',                  // 高度剖面圖
        optionsButtonText: '選項',                     // 用可見文字定位，不依賴 class
        routeRowClassHint: 'UgZKXd',                   // 單一條路線那一列
        durationClassHint: 'Fk3sm',                     // 「8 小時 44 分」
        distanceClassHint: 'ivN21e',                    // 「35.8 公里」
    };

    // 縣市 → 「鄉鎮天氣預報-未來3天」dataid
    // 已與官方 swagger 端點清單核對；奇數編號為未來3天、偶數為未來1週
    const CWA_DATAID = {
        '臺北市': 'F-D0047-061', '新北市': 'F-D0047-069', '基隆市': 'F-D0047-049',
        '桃園市': 'F-D0047-005', '新竹市': 'F-D0047-053', '新竹縣': 'F-D0047-009',
        '苗栗縣': 'F-D0047-013', '臺中市': 'F-D0047-073', '彰化縣': 'F-D0047-017',
        '南投縣': 'F-D0047-021', '雲林縣': 'F-D0047-025', '嘉義市': 'F-D0047-057',
        '嘉義縣': 'F-D0047-029', '臺南市': 'F-D0047-077', '高雄市': 'F-D0047-065',
        '屏東縣': 'F-D0047-033', '宜蘭縣': 'F-D0047-001', '花蓮縣': 'F-D0047-041',
        '臺東縣': 'F-D0047-037', '澎湖縣': 'F-D0047-045', '金門縣': 'F-D0047-085',
        '連江縣': 'F-D0047-081',
    };

    // 降雨機率色階（藍，11 級）與兩級洋紅疊加後的預混實色
    // 預混而非用半透明疊層：疊層在小色塊上會有合成成本，且預混值可直接查表
    const PALETTE = {
        0: ['#f2f7fb', '#f5c6e9', '#f78fd5'],
        10: ['#daebf9', '#e1bce7', '#ea88d4'],
        20: ['#c2dff7', '#ceb2e6', '#dc81d2'],
        30: ['#aad3f3', '#bba9e2', '#ce7ad0'],
        40: ['#94c6ef', '#a99edf', '#c173ce'],
        50: ['#7fbae9', '#9995da', '#b56cca'],
        60: ['#6bade1', '#898ad4', '#a964c6'],
        70: ['#59a0d7', '#7a80cc', '#9f5dc0'],
        80: ['#4993cc', '#6d76c3', '#9555ba'],
        90: ['#3a87c0', '#616cba', '#8d4eb3'],
        100: ['#2b7ab4', '#5562b0', '#8447ac'],
    };

    const state = {
        instanceId: Math.random().toString(36).slice(2, 8),  // 區分同一支腳本的不同次載入
        active: false,
        container: null,
        hiddenBlocks: [],
        originalPanelWidth: '',
        townCache: null,
    };

    const log = (...args) => console.log(`[RouteRain ${state.instanceId}]`, ...args);
    const warn = (...args) => console.warn(`[RouteRain ${state.instanceId}]`, ...args);

    // ════════════════════════════════════════════════════════════════
    // 幾何與編碼工具
    // ════════════════════════════════════════════════════════════════

    /** Google Polyline 解碼。回傳 [[lat, lon], ...] */
    function decodePolyline(str, precision) {
        const factor = Math.pow(10, precision === undefined ? 5 : precision);
        const out = [];
        let index = 0, lat = 0, lon = 0;
        while (index < str.length) {
            let result = 1, shift = 0, b;
            do {
                b = str.charCodeAt(index++) - 63 - 1;
                result += b << shift;
                shift += 5;
            } while (b >= 0x1f);
            lat += (result & 1) ? ~(result >> 1) : (result >> 1);
            result = 1; shift = 0;
            do {
                b = str.charCodeAt(index++) - 63 - 1;
                result += b << shift;
                shift += 5;
            } while (b >= 0x1f);
            lon += (result & 1) ? ~(result >> 1) : (result >> 1);
            out.push([lat / factor, lon / factor]);
        }
        return out;
    }

    /** 兩點球面距離（公尺） */
    function haversine(aLat, aLon, bLat, bLon) {
        const R = 6371000, toRad = Math.PI / 180;
        const dLat = (bLat - aLat) * toRad, dLon = (bLon - aLon) * toRad;
        const h = Math.sin(dLat / 2) ** 2 +
            Math.cos(aLat * toRad) * Math.cos(bLat * toRad) * Math.sin(dLon / 2) ** 2;
        return 2 * R * Math.asin(Math.sqrt(h));
    }

    /** 射線法：點是否在單一環內。ring 為 [[x, y], ...]，x=經度 y=緯度 */
    function pointInRing(x, y, ring) {
        let inside = false;
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
            const xi = ring[i][0], yi = ring[i][1];
            const xj = ring[j][0], yj = ring[j][1];
            if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) {
                inside = !inside;
            }
        }
        return inside;
    }

    /** 點是否落在某個鄉鎮內（外環內、且不在任何內環洞裡） */
    function pointInTown(x, y, town) {
        for (const poly of town.rings) {
            if (!pointInRing(x, y, poly[0])) continue;
            let inHole = false;
            for (let h = 1; h < poly.length; h++) {
                if (pointInRing(x, y, poly[h])) { inHole = true; break; }
            }
            if (!inHole) return true;
        }
        return false;
    }

    /** 載入並解碼內建的鄉鎮界線資料（只做一次） */
    function loadTowns() {
        if (state.townCache) return state.townCache;
        let raw;
        try {
            raw = GM_getResourceText('twTowns');
        } catch (err) {
            throw new Error('讀不到內建的鄉鎮界線資料（@resource twTowns）：' + err.message);
        }
        const doc = JSON.parse(raw);
        state.townCache = doc.towns.map(t => ({
            county: t.c,
            town: t.t,
            bbox: t.b,                                   // [minLon, minLat, maxLon, maxLat]
            // 編碼版的環是 polyline 字串，解碼後為 [lat, lon]，這裡轉成 [lon, lat]
            rings: t.e.map(poly => poly.map(enc => decodePolyline(enc, 5).map(p => [p[1], p[0]]))),
        }));
        log('界線資料載入完成，鄉鎮數', state.townCache.length);
        return state.townCache;
    }

    // ════════════════════════════════════════════════════════════════
    // 網址解析：取出停靠站與路徑控制點（依出現順序）
    // ════════════════════════════════════════════════════════════════

    /**
     * 「複製連結」網址的 data= 段裡有兩種區塊：
     *   1m1!1s{PlaceID}!2m2!1d{lng}!2d{lat}      → 正式停靠站
     *   3m4!1m2!1d{lng}!2d{lat}!3s{id}           → 路徑控制點（手動拖曳產生）
     * 停靠站外層的前綴數字會浮動（1m5／1m20…），依後面掛了幾個控制點而變，
     * 所以只抓核心模式、忽略前綴，否則會漏掉第一個停靠站（實際踩過）。
     */
    function parseRouteFromUrl(href) {
        const m = href.match(/\/data=([^?]+)/);
        if (!m) return null;
        const data = m[1];
        const items = [];
        const stopRe = /1m1!1s([^!]+)!2m2!1d(-?[\d.]+)!2d(-?[\d.]+)/g;
        const ctrlRe = /3m4!1m2!1d(-?[\d.]+)!2d(-?[\d.]+)!3s([^!]+)/g;
        let r;
        while ((r = stopRe.exec(data)) !== null) {
            items.push({ pos: r.index, kind: 'stop', lon: +r[2], lat: +r[3] });
        }
        while ((r = ctrlRe.exec(data)) !== null) {
            items.push({ pos: r.index, kind: 'via', lon: +r[1], lat: +r[2] });
        }
        items.sort((a, b) => a.pos - b.pos);
        const modeMatch = data.match(/!3e(\d+)/);
        return {
            points: items,
            urlTravelCode: modeMatch ? modeMatch[1] : null,
        };
    }

    // ════════════════════════════════════════════════════════════════
    // 從 DOM 讀「使用者實際選中的那條路線」
    // ════════════════════════════════════════════════════════════════

    function findPanel() {
        const cands = [...document.querySelectorAll('div')].filter(d => {
            const r = d.getBoundingClientRect();
            return r.height > 400 && d.className &&
                String(d.className).includes('m6QErb') && String(d.className).includes('WNBkOb');
        });
        return cands[0] || null;
    }

    function findOptionsButton() {
        // 用可見文字定位，不依賴混淆過的 class
        const btns = [...document.querySelectorAll('button')];
        return btns.find(b => b.textContent.trim() === SITE_SELECTORS.optionsButtonText) || null;
    }

    /**
     * 哪一條路線被選中：該列裡多出「詳細資料／預覽」兩顆按鈕。
     * 不用 class 判斷，因為那個修飾 class（vKKO3d）是混淆名稱、會隨版本變。
     */
    function readSelectedRoute(panel) {
        const listBlock = [...(panel ? panel.children : [])].find(c => {
            const cn = String(c.className || '');
            return cn.includes('m6QErb') && cn.includes('XiKgde');
        });
        if (!listBlock) return null;
        const rows = [...listBlock.children].filter(c =>
            String(c.className || '').includes(SITE_SELECTORS.routeRowClassHint));
        if (!rows.length) return null;

        let chosen = rows.find(row => row.querySelectorAll('button').length >= 2) || rows[0];
        const pick = (row, hint) => {
            const el = row.querySelector('[class*="' + hint + '"]');
            return el ? el.textContent.trim() : '';
        };
        return {
            index: rows.indexOf(chosen),
            total: rows.length,
            durationText: pick(chosen, SITE_SELECTORS.durationClassHint),
            distanceText: pick(chosen, SITE_SELECTORS.distanceClassHint),
            durationSec: parseDurationText(pick(chosen, SITE_SELECTORS.durationClassHint)),
            distanceMeters: parseDistanceText(pick(chosen, SITE_SELECTORS.distanceClassHint)),
        };
    }

    function parseDurationText(text) {
        if (!text) return null;
        const h = text.match(/(\d+)\s*小時/);
        const mi = text.match(/(\d+)\s*分/);
        if (!h && !mi) return null;
        return (h ? +h[1] * 3600 : 0) + (mi ? +mi[1] * 60 : 0);
    }

    function parseDistanceText(text) {
        if (!text) return null;
        const km = text.match(/([\d.]+)\s*公里/);
        if (km) return Math.round(+km[1] * 1000);
        const m = text.match(/([\d.]+)\s*公尺/);
        return m ? Math.round(+m[1]) : null;
    }

    /**
     * 交通方式。
     * 尚未驗證的部分：網址裡 !3e{n} 的完整對應表我沒有權威來源
     *   （實測樣本出現過 3e9，不在常見的 0=駕車／1=單車／2=步行／3=公共運輸 之內）。
     * 因此改以「面板上被選中的交通方式頁籤」為主要判斷，並把網址代碼記進 log，
     * 累積足夠樣本後再補成對照表。查不出來時退回 DRIVE 並在畫面上標明。
     */
    function detectTravelMode(urlTravelCode) {
        const tabs = [...document.querySelectorAll('button[aria-label],div[role="tab"]')];
        const selected = tabs.find(t =>
            t.getAttribute('aria-selected') === 'true' || t.getAttribute('aria-checked') === 'true');
        const label = selected ? (selected.getAttribute('aria-label') || selected.textContent || '') : '';
        log('交通方式判斷：aria 標籤=', JSON.stringify(label), ' 網址 3e 代碼=', urlTravelCode);

        if (/步行|walk/i.test(label)) return { mode: 'WALK', confident: true };
        if (/自行車|單車|bicycl/i.test(label)) return { mode: 'BICYCLE', confident: true };
        if (/大眾運輸|公共運輸|transit/i.test(label)) return { mode: 'TRANSIT', confident: true };
        if (/開車|駕車|driv/i.test(label)) return { mode: 'DRIVE', confident: true };
        return { mode: 'DRIVE', confident: false };
    }

    // ════════════════════════════════════════════════════════════════
    // Routes API
    // ════════════════════════════════════════════════════════════════

    function gmRequest(opts) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: opts.method || 'GET',
                url: opts.url,
                headers: opts.headers || {},
                data: opts.data,
                timeout: 20000,
                onload: res => {
                    if (res.status >= 200 && res.status < 300) resolve(res.responseText);
                    else reject(new Error(`HTTP ${res.status}：${String(res.responseText).slice(0, 300)}`));
                },
                onerror: () => reject(new Error('網路錯誤')),
                ontimeout: () => reject(new Error('請求逾時')),
            });
        });
    }

    const ROUTES_FIELD_MASK = [
        'routes.duration',
        'routes.distanceMeters',
        'routes.legs.duration',
        'routes.legs.distanceMeters',
        'routes.legs.steps.staticDuration',
        'routes.legs.steps.distanceMeters',
        'routes.legs.steps.polyline.encodedPolyline',
        'routes.legs.steps.navigationInstruction',
    ].join(',');

    async function computeRoutes(apiKey, parsed, travelMode) {
        const pts = parsed.points;
        if (pts.length < 2) throw new Error('網址裡解析不到起點與終點');
        const toLatLng = p => ({ location: { latLng: { latitude: p.lat, longitude: p.lon } } });
        const body = {
            origin: toLatLng(pts[0]),
            destination: toLatLng(pts[pts.length - 1]),
            travelMode: travelMode,
            languageCode: 'zh-TW',
            regionCode: 'TW',
            computeAlternativeRoutes: true,
        };
        const mids = pts.slice(1, -1);
        if (mids.length) {
            body.intermediates = mids.map(p => {
                const item = toLatLng(p);
                // 手動拖曳出來的控制點不是停靠站：via=true 才不會被算進停留時間、也不會拆 legs
                if (p.kind === 'via') item.via = true;
                return item;
            });
        }
        // 有中途點時 Google 不提供替代路線，先關掉以免請求被拒
        if (body.intermediates) body.computeAlternativeRoutes = false;

        const text = await gmRequest({
            method: 'POST',
            url: 'https://routes.googleapis.com/directions/v2:computeRoutes',
            headers: {
                'Content-Type': 'application/json',
                'X-Goog-Api-Key': apiKey,
                'X-Goog-FieldMask': ROUTES_FIELD_MASK,
            },
            data: JSON.stringify(body),
        });
        const json = JSON.parse(text);
        if (json.error) throw new Error('Routes API：' + json.error.message);
        if (!json.routes || !json.routes.length) throw new Error('Routes API 沒有回傳路線');
        return json.routes;
    }

    /** 從多條替代路線中，挑距離與時間最接近面板顯示值的那一條 */
    function pickMatchingRoute(routes, selected) {
        if (routes.length === 1 || !selected || selected.durationSec == null) {
            return { route: routes[0], matchNote: routes.length === 1 ? '只有一條' : '無法比對，取第一條' };
        }
        let best = null;
        for (const r of routes) {
            const dur = parseFloat(String(r.duration).replace('s', ''));
            const dist = r.distanceMeters;
            const score = Math.abs(dur - selected.durationSec) / Math.max(selected.durationSec, 1) +
                Math.abs(dist - selected.distanceMeters) / Math.max(selected.distanceMeters, 1);
            if (!best || score < best.score) best = { route: r, score, dur, dist };
        }
        const pct = (best.score * 100).toFixed(1);
        return {
            route: best.route,
            matchNote: `比對面板值（${selected.durationText}／${selected.distanceText}）誤差 ${pct}%`,
        };
    }

    // ════════════════════════════════════════════════════════════════
    // 時間軸與節點切分
    // ════════════════════════════════════════════════════════════════

    /** 用每個 step 的 staticDuration，在該 step 的 polyline 內按距離比例內插出時間軸 */
    function buildTimeline(route) {
        const timeline = [];
        const steps = [];
        let t = 0;
        for (const leg of route.legs || []) {
            for (const st of leg.steps || []) {
                const pts = decodePolyline(st.polyline.encodedPolyline, 5);
                const dur = parseFloat(String(st.staticDuration || '0s').replace('s', ''));
                const segs = [];
                let total = 0;
                for (let i = 0; i + 1 < pts.length; i++) {
                    const d = haversine(pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1]);
                    segs.push(d); total += d;
                }
                if (total <= 0) total = 1;
                if (pts.length) timeline.push({ sec: t, lat: pts[0][0], lon: pts[0][1] });
                let acc = 0;
                for (let i = 0; i < segs.length; i++) {
                    acc += segs[i];
                    timeline.push({ sec: t + dur * acc / total, lat: pts[i + 1][0], lon: pts[i + 1][1] });
                }
                steps.push({
                    t0: t,
                    t1: t + dur,
                    instruction: (st.navigationInstruction && st.navigationInstruction.instructions) || '',
                });
                t += dur;
            }
        }
        return { timeline, steps, totalSec: t };
    }

    /** 在時間軸上精確內插出某個累積秒數對應的座標（不吸附到最近頂點——吸附會破壞等分性質） */
    function positionAt(timeline, sec) {
        if (!timeline.length) return null;
        if (sec <= timeline[0].sec) return { lat: timeline[0].lat, lon: timeline[0].lon };
        const last = timeline[timeline.length - 1];
        if (sec >= last.sec) return { lat: last.lat, lon: last.lon };
        let lo = 0, hi = timeline.length - 1;
        while (hi - lo > 1) {
            const mid = (lo + hi) >> 1;
            if (timeline[mid].sec <= sec) lo = mid; else hi = mid;
        }
        const a = timeline[lo], b = timeline[hi];
        const f = (b.sec === a.sec) ? 0 : (sec - a.sec) / (b.sec - a.sec);
        return { lat: a.lat + (b.lat - a.lat) * f, lon: a.lon + (b.lon - a.lon) * f };
    }

    /**
     * 節點切分：
     *   1. 每進入一個新鄉鎮 → 一個節點
     *   2. 邊界抖動（來回穿越）依 FLAP_GAP_SEC 併回同一次穿越，並記錄「跨度」與「實際累加」
     *   3. 用實際累加判斷要不要留（MIN_DWELL_SEC），用跨度等分取中點
     *   等分取中點的數學性質：n=2 時節點落在 1/4 與 3/4，於是 a+c=b（a=進入到第一點、
     *   b=兩點之間、c=最後一點到離開）。這個等式可以當自我檢查用。
     */
    function buildNodes(timeline, totalSec) {
        const towns = loadTowns();

        // 先用整條路線的 bbox 篩掉不可能命中的鄉鎮（實測 368 → 約 85 個）
        let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity;
        for (const p of timeline) {
            if (p.lon < minLon) minLon = p.lon;
            if (p.lon > maxLon) maxLon = p.lon;
            if (p.lat < minLat) minLat = p.lat;
            if (p.lat > maxLat) maxLat = p.lat;
        }
        const cands = towns.filter(t =>
            !(t.bbox[2] < minLon || t.bbox[0] > maxLon || t.bbox[3] < minLat || t.bbox[1] > maxLat));
        log('bbox 預篩：', towns.length, '→', cands.length);

        const whoAt = (lat, lon) => {
            for (const t of cands) {
                if (lon < t.bbox[0] || lon > t.bbox[2] || lat < t.bbox[1] || lat > t.bbox[3]) continue;
                if (pointInTown(lon, lat, t)) return t;
            }
            return null;
        };

        // 逐點判斷 → 連續同鄉鎮的區段
        const runs = [];
        for (const p of timeline) {
            const t = whoAt(p.lat, p.lon);
            if (!t) continue;
            const last = runs[runs.length - 1];
            if (last && last.county === t.county && last.town === t.town) last.t1 = p.sec;
            else runs.push({ county: t.county, town: t.town, t0: p.sec, t1: p.sec });
        }

        // 抖動合併：同一鄉鎮的多次出現，間隔在 FLAP_GAP_SEC 內就併成同一次穿越
        const byTown = new Map();
        for (const r of runs) {
            const key = r.county + '|' + r.town;
            if (!byTown.has(key)) byTown.set(key, []);
            byTown.get(key).push(r);
        }
        const presences = [];
        for (const [key, list] of byTown) {
            list.sort((a, b) => a.t0 - b.t0);
            const [county, town] = key.split('|');
            let cur = { county, town, t0: list[0].t0, t1: list[0].t1, accum: list[0].t1 - list[0].t0 };
            for (let i = 1; i < list.length; i++) {
                const r = list[i];
                if (r.t0 - cur.t1 <= FLAP_GAP_SEC) {
                    cur.t1 = Math.max(cur.t1, r.t1);
                    cur.accum += r.t1 - r.t0;
                } else {
                    presences.push(cur);
                    cur = { county, town, t0: r.t0, t1: r.t1, accum: r.t1 - r.t0 };
                }
            }
            presences.push(cur);
        }

        const kept = presences.filter(p => p.accum >= MIN_DWELL_SEC);
        const dropped = presences.filter(p => p.accum < MIN_DWELL_SEC);
        if (dropped.length) {
            log('累加停留不足 ' + MIN_DWELL_SEC + ' 秒、未產生節點：',
                dropped.map(d => `${d.county}${d.town}(${Math.round(d.accum)}s)`).join('、'));
        }
        kept.sort((a, b) => (a.t0 + a.t1) / 2 - (b.t0 + b.t1) / 2);

        const nodes = [];
        for (const p of kept) {
            const span = p.t1 - p.t0;
            const n = Math.max(1, Math.floor(span / SUBDIVIDE_SEC) + 1);
            for (let k = 0; k < n; k++) {
                const sec = p.t0 + span * (2 * k + 1) / (2 * n);
                const pos = positionAt(timeline, sec);
                nodes.push({
                    sec, lat: pos.lat, lon: pos.lon,
                    county: p.county, town: p.town,
                    enterSec: p.t0, exitSec: p.t1, dwellSec: p.accum,
                    part: [k + 1, n],
                    isFlap: Math.abs(span - p.accum) > 5,
                });
            }
        }
        nodes.sort((a, b) => a.sec - b.sec);
        log('節點數', nodes.length, '／涵蓋鄉鎮', new Set(nodes.map(n => n.county + n.town)).size,
            '／總行程', Math.round(totalSec / 60), '分');
        return nodes;
    }

    // ════════════════════════════════════════════════════════════════
    // 路名抽取
    // ════════════════════════════════════════════════════════════════

    const ROAD_SUFFIX_RE = /(?:高架道路|快速道路|聯絡道|交流道|公路|大道|[路街道巷弄線橋段圈])$/;
    const ROAD_NUMBERED_RES = [
        /^國道\d+號$/, /^國道[一二三四五六七八九十]+$/,
        /^台\d+[甲乙丙丁]?線$/, /^臺\d+[甲乙丙丁]?線$/,
        /^\d+[甲乙丙丁]?縣道$/, /^[縣市區鄉鎮]道\d+[甲乙丙丁]?$/,
    ];

    function looksLikeRoad(s) {
        if (!s || s.length > 24) return false;
        if (ROAD_NUMBERED_RES.some(re => re.test(s))) return true;
        return ROAD_SUFFIX_RE.test(s);
    }

    // 由具體到一般依序嘗試；抽出的候選還要通過 looksLikeRoad 才採用。
    // 刻意不抓「朝X前進」——那是目標路名，不是當下所在的路，誤抓會給出錯誤位置。
    const ROAD_PATTERNS = [
        /進入([^\s，,。]+?)(?:$|，|,)/,
        /(?:以)?繼續行駛([^\s，,。]+?)(?:$|，|,)/,
        /接著走([^\s，,。]+?)(?:$|，|,)/,
        /繼續直行走([^\s，,。]+?)(?:$|，|,)/,
        /繼續走([^\s，,。]+?)(?:$|，|,)/,
        /上匝道後走([^\s，,。]+?)(?:$|，|,)/,
        /匝道上([^\s，,。]+?)往/,
        /上([^\s，,。]+?)匝道/,
        /[，,]走([^\s，,。]+?)(?:$|[，,])/,
        /^走([^\s，,。]+?)(?:$|，|,)/,
        /^往[東南西北]+走([^\s，,。]+?)朝/,
        /^於([^\s，,。]+?)(?:\(|（|靠)/,
    ];

    function extractRoadName(instruction) {
        if (!instruction) return null;
        const head = instruction.split('\n')[0].trim();
        for (const re of ROAD_PATTERNS) {
            const m = head.match(re);
            if (!m) continue;
            const parts = m[1].split('/').map(s => s.trim()).filter(Boolean);
            const good = parts.find(looksLikeRoad);
            if (good) return good;
        }
        return null;
    }

    /** 節點所在 step 沒有路名時，前後雙向找時間差最小的；相同時優先取「前」 */
    function resolveRoadName(steps, sec) {
        const named = steps.map(s => ({ ...s, name: extractRoadName(s.instruction) }));
        let idx = named.findIndex(s => s.t0 <= sec && sec < s.t1);
        if (idx < 0) idx = named.length - 1;
        if (idx >= 0 && named[idx] && named[idx].name) {
            return { name: named[idx].name, borrowed: false };
        }
        let best = null;
        for (let j = 0; j < named.length; j++) {
            if (!named[j].name || j === idx) continue;
            const gap = j < idx ? Math.max(0, sec - named[j].t1) : Math.max(0, named[j].t0 - sec);
            if (gap > ROAD_NAME_MAX_GAP_SEC) continue;
            const dir = j < idx ? 'before' : 'after';
            if (!best || gap < best.gap || (gap === best.gap && dir === 'before')) {
                best = { name: named[j].name, gap, dir };
            }
        }
        return best ? { name: best.name, borrowed: true } : { name: null, borrowed: false };
    }

    // ════════════════════════════════════════════════════════════════
    // 天氣現象 → 兩檔嚴重度
    // ════════════════════════════════════════════════════════════════

    const SEV_HEDGE = ['局部', '短暫', '或'];   // 空間／時間／替代性的保留字眼
    const SEEN_WEATHER_CODES = new Set();       // 記錄實際出現過的代碼，用真實使用補完官方拿不到的完整清單

    /**
     * 0 = 無降水；1 = 有可能；2 = 基本上會遇到／後果嚴重
     * 官方預報代碼表拿不到完整版（動態頁面抓不到、編號有跳號可證不完整），
     * 所以改用構詞規則：中文描述是「雲量狀態＋降水型態」的組合，規律穩定，
     * 對沒見過的代碼也能安全降級。
     */
    function severityOf(weatherText, weatherCode) {
        if (!weatherText) return 0;
        if (weatherCode) SEEN_WEATHER_CODES.add(weatherCode);
        const hasThunder = weatherText.includes('雷');
        const hasFrozen = weatherText.includes('雪') || weatherText.includes('積冰');
        const hasRain = weatherText.includes('雨');
        if (!hasThunder && !hasFrozen && !hasRain) return 0;
        if (hasThunder || hasFrozen) return 2;      // 不是機率問題，是後果問題
        return SEV_HEDGE.some(h => weatherText.includes(h)) ? 1 : 2;
    }

    // ════════════════════════════════════════════════════════════════
    // 中央氣象署查詢
    // ════════════════════════════════════════════════════════════════

    function floorToBucket(date) {
        const d = new Date(date.getTime());
        d.setMinutes(0, 0, 0);
        d.setHours(Math.floor(d.getHours() / CWA_BUCKET_HOURS) * CWA_BUCKET_HOURS);
        return d;
    }

    function ceilToBucket(date) {
        const f = floorToBucket(date);
        if (f.getTime() === date.getTime()) return f;
        return new Date(f.getTime() + CWA_BUCKET_HOURS * 3600 * 1000);
    }

    /** 氣象署要的格式是 yyyy-MM-ddThh:mm:ss（本地時間，不帶時區） */
    function cwaTimeString(d) {
        const p = n => String(n).padStart(2, '0');
        return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T` +
            `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
    }

    /**
     * 依縣市分組批次查詢。LocationName 官方標為 array<string>，可重複帶多個值，
     * 因此呼叫次數只跟「經過幾個縣市」掛勾，不隨鄉鎮數膨脹。
     * 注意：參數名大小寫敏感（LocationName／ElementName），寫成小寫開頭會靜默失效——
     * 伺服器不報錯，只是退回未篩選的完整資料。
     */
    async function fetchForecast(auth, nodes, timeFrom, timeTo) {
        const byCounty = new Map();
        for (const n of nodes) {
            if (!byCounty.has(n.county)) byCounty.set(n.county, new Set());
            byCounty.get(n.county).add(n.town);
        }
        const from = cwaTimeString(floorToBucket(timeFrom));
        const to = cwaTimeString(ceilToBucket(timeTo));
        const forecast = new Map();     // town → [{startMs, endMs, pop, weather, code}]
        const failures = [];

        for (const [county, townSet] of byCounty) {
            const dataid = CWA_DATAID[county];
            if (!dataid) { failures.push(`${county}（沒有對應的 dataid）`); continue; }
            const params = [...townSet].map(t => 'LocationName=' + encodeURIComponent(t)).join('&');
            const url = `https://opendata.cwa.gov.tw/api/v1/rest/datastore/${dataid}` +
                `?Authorization=${encodeURIComponent(auth)}&${params}` +
                `&ElementName=${encodeURIComponent('3小時降雨機率')}` +
                `&ElementName=${encodeURIComponent('天氣現象')}` +
                `&timeFrom=${from}&timeTo=${to}&format=JSON`;
            try {
                const json = JSON.parse(await gmRequest({ url }));
                const group = json.records && json.records.Locations && json.records.Locations[0];
                if (!group) { failures.push(`${county}（回應格式非預期）`); continue; }
                for (const loc of group.Location || []) {
                    const merged = new Map();
                    for (const el of loc.WeatherElement || []) {
                        for (const tt of el.Time || []) {
                            const key = tt.StartTime + '|' + tt.EndTime;
                            if (!merged.has(key)) {
                                merged.set(key, {
                                    startMs: Date.parse(tt.StartTime),
                                    endMs: Date.parse(tt.EndTime),
                                    pop: null, weather: null, code: null,
                                });
                            }
                            const slot = merged.get(key);
                            const v = (tt.ElementValue || [])[0] || {};
                            if (v.ProbabilityOfPrecipitation != null) slot.pop = +v.ProbabilityOfPrecipitation;
                            if (v.Weather != null) slot.weather = v.Weather;
                            if (v.WeatherCode != null) slot.code = v.WeatherCode;
                        }
                    }
                    forecast.set(loc.LocationName, [...merged.values()].sort((a, b) => a.startMs - b.startMs));
                }
            } catch (err) {
                failures.push(`${county}（${err.message}）`);
            }
        }
        log('CWA 呼叫', byCounty.size, '次，取得', forecast.size, '個鄉鎮的預報');
        if (SEEN_WEATHER_CODES.size) log('本次出現的天氣現象代碼：', [...SEEN_WEATHER_CODES].join(','));
        return { forecast, failures, callCount: byCounty.size };
    }

    function lookupForecast(forecast, town, whenMs) {
        const rows = forecast.get(town);
        if (!rows) return null;
        for (const r of rows) {
            if (r.startMs <= whenMs && whenMs < r.endMs) return r;
        }
        return null;
    }

    // ════════════════════════════════════════════════════════════════
    // 金鑰設定
    // ════════════════════════════════════════════════════════════════

    function getKeys() {
        return {
            google: GM_getValue(KEY_GOOGLE, ''),
            cwa: GM_getValue(KEY_CWA, ''),
        };
    }

    function openSettings() {
        const cur = getKeys();
        const g = prompt('Google Maps API 金鑰（Routes API）\n\n這組金鑰只存在你自己的瀏覽器裡，不會上傳、也不在腳本原始碼中。', cur.google);
        if (g !== null) GM_setValue(KEY_GOOGLE, g.trim());
        const c = prompt('中央氣象署開放資料授權碼（CWA-xxxxxxxx-…）\n\n同樣只存在本機。', cur.cwa);
        if (c !== null) GM_setValue(KEY_CWA, c.trim());
        alert('已儲存。重新按一次「路雨」即可。');
    }

    GM_registerMenuCommand('設定 API 金鑰', openSettings);

    // ════════════════════════════════════════════════════════════════
    // 樣式
    // ════════════════════════════════════════════════════════════════

    function injectStyle() {
        if (document.getElementById(PREFIX + '-style')) return;
        const rules = [];
        for (const p of Object.keys(PALETTE)) {
            PALETTE[p].forEach((hex, sev) => {
                rules.push(`.${PREFIX}-c.${PREFIX}-s${sev}-${p}{background:${hex}}`);
            });
        }
        const css = `
.${PREFIX}-wrap{font-family:inherit;padding:8px 10px 14px;overflow:auto;max-height:calc(100vh - 320px)}
.${PREFIX}-msg{padding:14px 12px;font-size:13px;color:#3c4043;line-height:1.7}
.${PREFIX}-msg b{color:#1a73e8}
.${PREFIX}-grid{display:grid;grid-auto-rows:${PITCH_PX}px;
  grid-template-columns:${ROWH_W_PX}px repeat(var(--${PREFIX}-cols),${PITCH_PX}px)}
.${PREFIX}-corner{position:sticky;top:0;left:0;z-index:30;background:#fff;height:${HEADER_H_PX}px;
  border-bottom:1px solid #e8eaed;border-right:1px solid #e8eaed}
.${PREFIX}-h{position:sticky;top:0;z-index:20;background:#fff;height:${HEADER_H_PX}px;
  display:flex;align-items:flex-start;justify-content:center;padding-top:${TIMELINE_AXIS_Y_PX - 13}px;
  border-bottom:1px solid #e8eaed}
.${PREFIX}-h::before{content:"";position:absolute;left:0;right:0;top:${TIMELINE_AXIS_Y_PX}px;height:2px;background:#c7d9fb}
.${PREFIX}-h.${PREFIX}-first::before{left:50%}
.${PREFIX}-h.${PREFIX}-last::before{right:50%}
.${PREFIX}-dot{position:absolute;top:${TIMELINE_AXIS_Y_PX}px;left:50%;transform:translate(-50%,-50%);
  width:7px;height:7px;border-radius:50%;background:#a9c2e8;box-shadow:0 0 0 3px #fff;
  transition:transform .08s,background .08s}
.${PREFIX}-hour{position:absolute;top:${TIMELINE_AXIS_Y_PX}px;left:50%;transform:translate(-50%,-50%);
  width:26px;height:26px;border-radius:50%;background:#1a73e8;color:#fff;font-size:12px;font-weight:700;
  display:flex;align-items:center;justify-content:center;
  box-shadow:0 0 0 3px #fff,0 0 0 6px rgba(26,115,232,.16);transition:box-shadow .08s,transform .08s}
.${PREFIX}-h.${PREFIX}-hl{z-index:22}
.${PREFIX}-h.${PREFIX}-hl .${PREFIX}-dot{background:#1a73e8;transform:translate(-50%,-50%) scale(1.9)}
.${PREFIX}-h.${PREFIX}-hl .${PREFIX}-hour{transform:translate(-50%,-50%) scale(1.12);
  box-shadow:0 0 0 3px #fff,0 0 0 7px rgba(26,115,232,.42)}
.${PREFIX}-tl{position:absolute;top:${TIMELINE_AXIS_Y_PX + 15}px;left:50%;transform:translateX(-50%);
  font-size:11px;font-weight:700;color:#1a73e8;white-space:nowrap;background:#fff;padding:0 3px;display:none}
.${PREFIX}-h.${PREFIX}-hl .${PREFIX}-tl{display:block}
.${PREFIX}-rh{position:sticky;left:0;z-index:10;background:#fff;display:flex;align-items:center;
  justify-content:flex-end;padding-right:8px;font-size:12px;white-space:nowrap;
  border-right:1px solid #e8eaed;transition:background .08s;gap:6px}
.${PREFIX}-rh.${PREFIX}-hl{background:#e8f0fe}
.${PREFIX}-rh .${PREFIX}-t{font-weight:600;color:#202124}
.${PREFIX}-rh .${PREFIX}-m{color:#80868b;font-size:11px;min-width:40px;text-align:right}
.${PREFIX}-rh.${PREFIX}-hl .${PREFIX}-m{color:#1a73e8;font-weight:700}
.${PREFIX}-d{display:flex;align-items:center;justify-content:center}
.${PREFIX}-c{width:${CELL_PX}px;height:${CELL_PX}px;border-radius:2px;cursor:pointer;display:block}
.${PREFIX}-c.${PREFIX}-na{background:repeating-linear-gradient(45deg,#f1f3f4 0 4px,#e0e3e6 4px 8px)}
.${PREFIX}-legend{display:flex;gap:14px;flex-wrap:wrap;font-size:12px;align-items:center;
  padding:10px 12px 0;color:#3c4043}
.${PREFIX}-legend span.${PREFIX}-sw{width:18px;height:18px;border-radius:3px;display:inline-block;margin-right:5px}
.${PREFIX}-legend div{display:flex;align-items:center}
.${PREFIX}-scale{display:flex;align-items:center;gap:2px;padding:6px 12px 0;font-size:11px;color:#5f6368}
.${PREFIX}-scale i{width:16px;height:14px;display:inline-block}
.${PREFIX}-tip{position:fixed;z-index:2147483000;pointer-events:none;display:none;background:#202124;
  color:#fff;border-radius:8px;padding:9px 12px;font-size:12px;line-height:1.6;
  box-shadow:0 6px 20px rgba(0,0,0,.25);max-width:280px}
.${PREFIX}-tip .${PREFIX}-k{color:#9aa0a6;display:inline-block;min-width:60px}
.${PREFIX}-note{font-size:11.5px;color:#80868b;padding:8px 12px 0;line-height:1.6}
`;
        const el = document.createElement('style');
        el.id = PREFIX + '-style';
        el.textContent = css + rules.join('\n');
        document.head.appendChild(el);
    }

    // ════════════════════════════════════════════════════════════════
    // 按鈕注入
    // ════════════════════════════════════════════════════════════════

    function injectButton() {
        const optionsBtn = findOptionsButton();
        if (!optionsBtn) return false;
        if (optionsBtn.parentElement.querySelector('[data-' + PREFIX + '-btn]')) return true;

        // 複製「選項」按鈕以完整繼承字型、尺寸、hover 效果——
        // Google 的 class 是混淆過的、會隨版本變動，照抄 CSS 一定會壞。
        const clone = optionsBtn.cloneNode(true);
        clone.setAttribute('data-' + PREFIX + '-btn', '1');

        // 清掉 Google 自己的行為掛勾，否則按下去會連帶觸發原本的「選項」面板
        const strip = el => {
            ['jsaction', 'jslog', 'jsname', 'data-value', 'aria-controls', 'aria-expanded', 'id']
                .forEach(a => el.removeAttribute(a));
        };
        strip(clone);
        clone.querySelectorAll('*').forEach(strip);

        // 實測的結構是 <div class="BunUDe">「選項」<div class="OyjIsf"></div></div>——
        // 文字是父層的「直接文字節點」，旁邊還掛著一個空的子元素（負責 ripple 之類的效果）。
        // 所以不能用 children.length === 0 當條件（會抓不到），也不能直接覆寫 textContent
        // （那會把子元素一起清掉、失去原本的視覺效果）。正解：找出最深層那個文字剛好相符的
        // 元素，只替換它的文字節點，保留元素子節點。
        const holder = [...clone.querySelectorAll('*')].reverse()
            .find(el => el.textContent.trim() === SITE_SELECTORS.optionsButtonText);
        const target = holder || clone;
        let replaced = false;
        for (const nd of [...target.childNodes]) {
            if (nd.nodeType === Node.TEXT_NODE && nd.textContent.trim()) {
                nd.textContent = replaced ? '' : '路雨';
                replaced = true;
            }
        }
        if (!replaced) target.insertBefore(document.createTextNode('路雨'), target.firstChild);
        clone.setAttribute('aria-label', '路線降雨預報');

        clone.addEventListener('click', ev => {
            ev.preventDefault();
            ev.stopPropagation();
            toggle();
        }, true);

        optionsBtn.parentElement.insertBefore(clone, optionsBtn);
        log('已注入「路雨」按鈕');
        return true;
    }

    // ════════════════════════════════════════════════════════════════
    // 面板切換
    // ════════════════════════════════════════════════════════════════

    function toggle() {
        if (state.active) { deactivate(); return; }
        activate();
    }

    function deactivate() {
        state.hiddenBlocks.forEach(({ el, display }) => { el.style.display = display; });
        state.hiddenBlocks = [];
        if (state.container) { state.container.remove(); state.container = null; }
        const panel = findPanel();
        if (panel) panel.style.width = state.originalPanelWidth;
        const tip = document.getElementById(PREFIX + '-tip');
        if (tip) tip.remove();
        state.active = false;
        log('已關閉');
    }

    function activate() {
        injectStyle();
        const panel = findPanel();
        if (!panel) { alert('找不到路線面板，請先在 Google Maps 規劃好路線。'); return; }

        // 隱藏灰線以下三塊：傳送/複製連結、路線列表、高度剖面圖
        const hints = [
            SITE_SELECTORS.sendCopyRowClassHint,
            SITE_SELECTORS.routeListClassHint,
            SITE_SELECTORS.elevationClassHint,
        ];
        state.hiddenBlocks = [];
        for (const child of [...panel.children]) {
            const cn = String(child.className || '');
            const hit = hints.some(h => h.split(' ').every(tok => cn.includes(tok)));
            if (hit) {
                state.hiddenBlocks.push({ el: child, display: child.style.display });
                child.style.display = 'none';
            }
        }
        state.originalPanelWidth = panel.style.width;
        panel.style.width = PANEL_WIDE_PX + 'px';

        const wrap = document.createElement('div');
        wrap.className = PREFIX + '-wrap';
        wrap.id = PREFIX + '-wrap';
        panel.appendChild(wrap);
        state.container = wrap;
        state.active = true;

        run(wrap).catch(err => {
            warn(err);
            wrap.innerHTML = '';
            showMessage(wrap, '出錯了：' + err.message);
        });
    }

    function showMessage(wrap, html) {
        const d = document.createElement('div');
        d.className = PREFIX + '-msg';
        d.innerHTML = html;
        wrap.appendChild(d);
    }

    // ════════════════════════════════════════════════════════════════
    // 主流程
    // ════════════════════════════════════════════════════════════════

    async function run(wrap) {
        const keys = getKeys();
        if (!keys.google || !keys.cwa) {
            showMessage(wrap,
                '還沒設定 API 金鑰。<br><br>需要兩組：<br>' +
                '① <b>Google Maps API 金鑰</b>（Routes API，開發階段可用免綁卡的 Demo Key）<br>' +
                '② <b>中央氣象署授權碼</b>（opendata.cwa.gov.tw 免費註冊即可取得）<br><br>' +
                '兩組金鑰只會存在你自己的瀏覽器裡，不會出現在腳本原始碼中。<br><br>' +
                '請從 Tampermonkey 選單的「設定 API 金鑰」填入。');
            return;
        }

        showMessage(wrap, '正在解析路線…');
        const parsed = parseRouteFromUrl(location.href);
        if (!parsed || parsed.points.length < 2) {
            wrap.innerHTML = '';
            showMessage(wrap, '從網址讀不到路線。請確認已經規劃好路線（網址裡要有 <code>/data=</code> 那一段）。');
            return;
        }
        const panel = findPanel();
        const selected = readSelectedRoute(panel);
        const modeInfo = detectTravelMode(parsed.urlTravelCode);
        log('網址解析：停靠站/控制點共', parsed.points.length, '個；選中路線', selected);

        wrap.innerHTML = '';
        showMessage(wrap, '正在向 Google 取得路徑…');
        const routes = await computeRoutes(keys.google, parsed, modeInfo.mode);
        const picked = pickMatchingRoute(routes, selected);
        const route = picked.route;

        wrap.innerHTML = '';
        showMessage(wrap, '正在判斷沿途行政區…');
        const { timeline, steps, totalSec } = buildTimeline(route);
        if (!timeline.length) throw new Error('Routes API 回傳的路徑沒有可用的座標');
        const nodes = buildNodes(timeline, totalSec);
        if (!nodes.length) {
            wrap.innerHTML = '';
            showMessage(wrap, '這條路線沒有落在台灣任何鄉鎮界線內，目前只支援台灣本島與外島的路線。');
            return;
        }
        for (const n of nodes) {
            const r = resolveRoadName(steps, n.sec);
            n.road = r.name;
            n.roadBorrowed = r.borrowed;
        }

        // 出發時間欄：從現在往後對齊到 DEPART_STEP_MIN 的整數倍，到預報上限為止
        const now = new Date();
        const first = new Date(now.getTime());
        first.setSeconds(0, 0);
        first.setMinutes(Math.ceil(first.getMinutes() / DEPART_STEP_MIN) * DEPART_STEP_MIN);
        const horizonEnd = new Date(now.getTime() + FORECAST_HORIZON_HOURS * 3600 * 1000);
        const departures = [];
        for (let t = first.getTime(); t + totalSec * 1000 <= horizonEnd.getTime();
            t += DEPART_STEP_MIN * 60 * 1000) {
            departures.push(new Date(t));
            if (departures.length >= DEPART_COLUMNS_MAX) break;
        }
        if (!departures.length) {
            wrap.innerHTML = '';
            showMessage(wrap, '這條路線的行程時間超過預報可涵蓋的範圍（' +
                FORECAST_HORIZON_HOURS + ' 小時），無法產生表格。');
            return;
        }

        wrap.innerHTML = '';
        showMessage(wrap, '正在向中央氣象署取得降雨預報…');
        const lastArrive = new Date(departures[departures.length - 1].getTime() + totalSec * 1000);
        const { forecast, failures, callCount } =
            await fetchForecast(keys.cwa, nodes, departures[0], lastArrive);

        wrap.innerHTML = '';
        render(wrap, {
            nodes, departures, forecast, totalSec,
            meta: {
                matchNote: picked.matchNote,
                mode: modeInfo,
                selected,
                callCount,
                failures,
                altCount: routes.length,
            },
        });
    }

    // ════════════════════════════════════════════════════════════════
    // 呈現
    // ════════════════════════════════════════════════════════════════

    const pad2 = n => String(n).padStart(2, '0');
    const clockOf = d => pad2(d.getHours()) + ':' + pad2(d.getMinutes());

    function render(wrap, data) {
        const { nodes, departures, forecast, totalSec, meta } = data;

        const grid = document.createElement('div');
        grid.className = PREFIX + '-grid';
        grid.style.setProperty('--' + PREFIX + '-cols', String(departures.length));

        const parts = ['<div class="' + PREFIX + '-corner"></div>'];
        departures.forEach((d, i) => {
            const isHour = d.getMinutes() === 0;
            const cls = [PREFIX + '-h'];
            if (i === 0) cls.push(PREFIX + '-first');
            if (i === departures.length - 1) cls.push(PREFIX + '-last');
            parts.push(
                `<div class="${cls.join(' ')}" data-${PREFIX}-h="${i}">` +
                (isHour
                    ? `<span class="${PREFIX}-hour">${d.getHours()}</span>`
                    : `<span class="${PREFIX}-dot"></span>`) +
                `<span class="${PREFIX}-tl">${clockOf(d)}</span></div>`);
        });

        nodes.forEach((n, ri) => {
            const cum = '+' + Math.round(n.sec / 60) + '分';
            parts.push(
                `<div class="${PREFIX}-rh" data-${PREFIX}-rh="${ri}">` +
                `<span class="${PREFIX}-m" data-${PREFIX}-cum="${cum}">${cum}</span>` +
                `<span class="${PREFIX}-t">${n.county}${n.town}</span></div>`);
            for (let ci = 0; ci < departures.length; ci++) {
                const whenMs = departures[ci].getTime() + n.sec * 1000;
                const row = lookupForecast(forecast, n.town, whenMs);
                let cls, pop = '', sev = 0;
                if (!row || row.pop == null) {
                    cls = `${PREFIX}-c ${PREFIX}-na`;
                } else {
                    pop = Math.round(row.pop / 10) * 10;
                    sev = severityOf(row.weather, row.code);
                    cls = `${PREFIX}-c ${PREFIX}-s${sev}-${pop}`;
                }
                parts.push(
                    `<div class="${PREFIX}-d"><span class="${cls}" ` +
                    `data-${PREFIX}-r="${ri}" data-${PREFIX}-c="${ci}"></span></div>`);
            }
        });
        grid.innerHTML = parts.join('');
        wrap.appendChild(grid);

        // 色階與圖例
        const scale = document.createElement('div');
        scale.className = PREFIX + '-scale';
        scale.innerHTML = '降雨機率 ' +
            Object.keys(PALETTE).map(p => `<i style="background:${PALETTE[p][0]}"></i>`).join('') +
            ' 0→100%';
        wrap.appendChild(scale);

        const legend = document.createElement('div');
        legend.className = PREFIX + '-legend';
        legend.innerHTML =
            `<div><span class="${PREFIX}-sw" style="background:${PALETTE[60][0]}"></span>不會下雨的天氣型態</div>` +
            `<div><span class="${PREFIX}-sw" style="background:${PALETTE[60][1]}"></span>有可能（局部／短暫／或）</div>` +
            `<div><span class="${PREFIX}-sw" style="background:${PALETTE[60][2]}"></span>基本上會遇到／雷雨・雪</div>`;
        wrap.appendChild(legend);

        const note = document.createElement('div');
        note.className = PREFIX + '-note';
        const bits = [
            `節點 ${nodes.length} 個／涵蓋 ${new Set(nodes.map(n => n.county + n.town)).size} 個鄉鎮`,
            `總行程 ${Math.round(totalSec / 60)} 分`,
            `氣象署呼叫 ${meta.callCount} 次`,
            `交通方式 ${meta.mode.mode}${meta.mode.confident ? '' : '（自動判斷失敗，預設值）'}`,
            `路線比對：${meta.matchNote}`,
        ];
        if (meta.failures && meta.failures.length) {
            bits.push('取得失敗：' + meta.failures.join('、'));
        }
        note.textContent = bits.join('　·　');
        wrap.appendChild(note);

        bindInteractions(grid, nodes, departures, forecast);
    }

    /** tooltip、hover 連動、點擊：全部用事件委派，整張表只掛 4 個 listener */
    function bindInteractions(grid, nodes, departures, forecast) {
        let tip = document.getElementById(PREFIX + '-tip');
        if (!tip) {
            tip = document.createElement('div');
            tip.id = PREFIX + '-tip';
            tip.className = PREFIX + '-tip';
            document.body.appendChild(tip);
        }
        const heads = [...grid.querySelectorAll('.' + PREFIX + '-h')];
        const rhs = [...grid.querySelectorAll('.' + PREFIX + '-rh')];
        let curH = null;

        const restoreRowLabels = () => {
            rhs.forEach(rh => {
                const m = rh.querySelector('.' + PREFIX + '-m');
                m.textContent = m.getAttribute('data-' + PREFIX + '-cum');
                rh.classList.remove(PREFIX + '-hl');
            });
        };

        grid.addEventListener('mouseover', ev => {
            const cell = ev.target.closest('.' + PREFIX + '-c');
            if (!cell) return;
            const ri = +cell.getAttribute('data-' + PREFIX + '-r');
            const ci = +cell.getAttribute('data-' + PREFIX + '-c');
            const dep = departures[ci];

            if (curH !== ci) {
                if (curH !== null) heads[curH].classList.remove(PREFIX + '-hl');
                heads[ci].classList.add(PREFIX + '-hl');
                curH = ci;
            }
            // 整欄的列標籤都換成「以這個出發時間計算，各自的抵達時刻」，
            // 這樣一眼就能讀出整趟行程的時刻表
            nodes.forEach((n, i) => {
                const m = rhs[i].querySelector('.' + PREFIX + '-m');
                m.textContent = clockOf(new Date(dep.getTime() + n.sec * 1000));
            });
            rhs.forEach((rh, i) => rh.classList.toggle(PREFIX + '-hl', i === ri));

            const n = nodes[ri];
            const arrive = new Date(dep.getTime() + n.sec * 1000);
            const row = lookupForecast(forecast, n.town, arrive.getTime());
            const sev = row ? severityOf(row.weather, row.code) : 0;
            const sevLabel = ['—', '有可能', '基本上會遇到'][sev];
            const k = s => `<span class="${PREFIX}-k">${s}</span>`;
            tip.innerHTML =
                `<b>${n.county}${n.town}</b>${n.road ? '　' + n.road + (n.roadBorrowed ? '（附近）' : '') : ''}<br>` +
                k('出發時間') + clockOf(dep) + '<br>' +
                k('抵達時刻') + clockOf(arrive) + `（出發後 ${Math.round(n.sec / 60)} 分）<br>` +
                k('降雨機率') + (row && row.pop != null ? row.pop + '%' : '無資料') + '<br>' +
                k('天氣現象') + (row && row.weather ? row.weather : '—') + '<br>' +
                k('雨勢判定') + sevLabel +
                (n.part[1] > 1 ? `<br>${k('本鄉鎮')}第 ${n.part[0]}／${n.part[1]} 個取樣點` : '') +
                (n.isFlap ? `<br>${k('備註')}此處為行政區交界，來回穿越` : '');
            tip.style.display = 'block';
        });

        grid.addEventListener('mousemove', ev => {
            if (tip.style.display !== 'block') return;
            const off = 14;
            let x = ev.clientX + off, y = ev.clientY + off;
            const r = tip.getBoundingClientRect();
            if (x + r.width > innerWidth - 8) x = ev.clientX - r.width - off;
            if (y + r.height > innerHeight - 8) y = ev.clientY - r.height - off;
            tip.style.left = x + 'px';
            tip.style.top = y + 'px';
        });

        grid.addEventListener('mouseleave', () => {
            tip.style.display = 'none';
            if (curH !== null) { heads[curH].classList.remove(PREFIX + '-hl'); curH = null; }
            restoreRowLabels();
        });

        grid.addEventListener('click', ev => {
            const cell = ev.target.closest('.' + PREFIX + '-c');
            if (!cell) return;
            const n = nodes[+cell.getAttribute('data-' + PREFIX + '-r')];
            onNodeClick(n);
        });
    }

    /**
     * 點擊節點時把地圖 focus 到該座標。
     * 待補：使用者指定要在「原分頁內」切換視野，而不是開新分頁；
     * 具體做法（改網址讓 SPA 自己處理、或操作地圖物件）尚未討論，先留接口。
     */
    function onNodeClick(node) {
        log('點擊節點（原分頁 focus 尚未實作）：', node.county + node.town, node.lat, node.lon);
    }

    // ════════════════════════════════════════════════════════════════
    // 啟動與重新注入
    // Google Maps 是 SPA：切換路線、改交通方式、拖曳路徑都會重繪面板，
    // 注入的按鈕會被銷毀，所以要持續監看並重新注入（注入前先檢查是否已存在）。
    // ════════════════════════════════════════════════════════════════

    function boot() {
        injectButton();
        const observer = new MutationObserver(() => {
            if (!document.querySelector('[data-' + PREFIX + '-btn]')) {
                if (state.active) deactivate();     // 面板被重繪，我們的內容也失效了
                injectButton();
            }
        });
        observer.observe(document.body, { childList: true, subtree: true });
        log('啟動完成');
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot);
    } else {
        boot();
    }
})();
