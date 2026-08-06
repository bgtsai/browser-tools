// ==UserScript==
// @name         Route Rain — 路線降雨預報
// @namespace    https://github.com/bgtsai/browser-tools
// @version      0.69.0
// @description  在 Google Maps 路線面板加一個「路雨」按鈕，顯示沿途各鄉鎮在不同出發時間下的降雨機率表格
// @author       bgtsai
// @match        https://www.google.com/maps/*
// @icon         https://www.google.com/maps/about/images/icons/maps_512dp.png
// @connect      opendata.cwa.gov.tw
// @connect      www.google.com
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @grant        GM_setClipboard
// @grant        GM_getResourceText
// @grant        unsafeWindow
// @resource     twTowns https://raw.githubusercontent.com/bgtsai/browser-tools/main/route-rain/tw_town_boundaries_moi1140318.json
// @downloadURL  https://raw.githubusercontent.com/bgtsai/browser-tools/main/route-rain/RouteRain.user.js
// @updateURL    https://raw.githubusercontent.com/bgtsai/browser-tools/main/route-rain/RouteRain.user.js
// @run-at       document-start
// ==/UserScript==

/* eslint-disable no-unused-vars */
(function () {
    'use strict';

    // ────────────────────────────────────────────────────────────────
    // 設定常數
    // 命名用功能語意而非數值；時間一律標單位 (ms)/(sec)；排列依執行時序
    // ────────────────────────────────────────────────────────────────

    const PREFIX = 'rr';                       // 自己加到 DOM 上的 class／屬性一律加專案前綴
    const BUTTON_LABEL = '旅途中的雨';         // 注入到面板上的按鈕文字
    const BUTTON_GAP_PX = 8;                   // 注入按鈕與原「選項」之間的間距
    const CLOSE_LABEL = '關閉·回到路線';       // 面板開啟時，按鈕改成這個文字並移到「選項」的位置

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
    const INFO_MAX_W_PX = 860;                 // 資訊區的最大寬度（面板本身不再加寬）
    const HOVER_SETTLE_MS = 160;               // 送出移動事件後，等命中判定跑完再點擊
    // 與 Google 自己一致：實測點路線節點時，它一律縮放到整數 17.00
    //（18.03→17.00、16.17→17.00，一個往下一個往上都精準落在 17）
    const MAP_FOCUS_ZOOM = 17;                 // 點擊節點時要拉近到的縮放層級
    // 離 Google 節點多近就吸附過去。
    //
    // 原本的做法是「避開」，現在反過來：Google 的節點是轉彎、匯流這類
    // 行車動作點，對使用者比我們中間插的取樣點更有意義，所以靠得夠近就直接改用它。
    //
    // 距離可以放得寬，因為看天氣不在乎幾百公尺——氣象資料是 3 小時一格，
    // 500 公尺就算用走的也才偏 6 分鐘，遠不足以跨格。
    // 真正的硬限制是**不能跨到別的鄉鎮**，否則會取到另一個鄉鎮的天氣，
    // 那是實質錯誤；因此同鄉鎮是必要條件，距離只是次要的門檻。
    const NODE_SNAP_M = 500;

    // ── 動畫參數 ──
    // 目標是接近原生的滑順度。先前卡頓的四個成因與對策：
    //   ① 動作被切成很多段    → 整段平移只按下／放開一次，中間持續送 move
    //   ② 每段之間等網址更新  → 先算好整段軌跡再一次播完，只在最後校正一次
    //   ③ 等速移動            → 加上 easeInOutCubic 緩動，起停自然
    //   ④ 縮放一級一級跳      → 改用滾輪（實測是連續的，會出現 17.6z 這種非整數）
    const PAN_MIN_MS = 350;                    // 平移最短時長
    const PAN_MS_PER_SCREEN = 300;             // 每多移動一個畫面寬就多這麼久
    const PAN_MAX_MS = 900;                    // 平移最長時長
    // 滾輪縮放的實測結果（間隔 vs 每事件縮放量）：
    //   16ms → 0.000 級（完全無效，那正是 requestAnimationFrame 的間隔）
    //   30ms → 0.256 級（打折）
    //   50ms 以上 → 0.320 級（滿效率）
    // 因此縮放不能用 rAF 逐影格送，必須用固定間隔串接。
    const WHEEL_INTERVAL_MS = 50;              // 滾輪事件間隔，低於 30ms 會被整批忽略
    const WHEEL_ZOOM_PER_EVENT = 0.32;         // 每個事件的縮放量（50ms 間隔下實測）
    // 拖曳時游標不能離開畫布，單次手勢最多只能移動約 0.4 個畫面。
    // 因此「要不要先拉遠」與「拉遠幾級」都由同一個條件決定：
    // 拉遠到剛好塞得進一次手勢即可，不多拉——多拉一級就多一次圖磚重載。
    const DRAG_MAX_SCREENS = 0.6;              // 單次拖曳的位移上限（畫面數）；
                                               // 方向感知的按下點讓行程從 0.4 提高到 0.6
    const SAFE_PRESS_MIN_PX = 60;              // 按下點至少要離路線這麼遠，否則會被判定為拖曳路線
    const PRESS_EDGE_MARGIN_PX = 40;           // 按下點與拖曳終點都要離畫布邊緣這麼遠
    const ARC_MAX_ZOOM_OUT = 10;               // 拉遠的級數上限（台北→高雄這種極遠距離需要 9 級）
    // ── 收斂與死區 ──
    // 死區不是「距離小於某個值就放棄」，而是「已經沒有縮放、而且再修也修不動」的狀態。
    // 先前把門檻設在 80px（zoom 16 約 173 公尺），等於還沒修完就放棄。
    // 正確的判準是：一直修到改善停滯為止，只有停滯時剩下的誤差才算死區。
    const PAN_TOLERANCE_PX = 15;               // 到這個程度就算已經到位（zoom 16 約 32 公尺）
    const DEAD_ZONE_PX = 50;                   // 停滯時若剩下的誤差在此範圍內，視為抖動、接受它
                                               // 也用於「再點同一個節點」時判斷不必動作
    const CONVERGE_MIN_EFFECT = 0.5;           // 一次修正的實際改善量，至少要有該次拖曳量的一半；
                                               // 不能用固定比例判斷——拖曳有 0.6 畫面的上限，
                                               // 誤差比上限大時本來就只能一次減少一個上限的量
    const SETTLE_POLL_MS = 250;                // 輪詢間隔；連續兩次相同即視為停止
    const SETTLE_TIMEOUT_MS = 3000;            // 等待上限，逾時就用當下的值繼續
    const PAN_MAX_ITERATIONS = 5;              // 修正的次數上限
    const ZOOM_TOLERANCE = 0.3;                // 縮放層級與目標差距在此範圍內即可
    const MIN_WORK_ZOOM = 5;                   // 拉遠的下限
    const ROUTE_CHANGE_DEBOUNCE_MS = 600;      // 路線改變後等它安定再重算（ms）
    const DEPART_STEP_MIN = 15;                // 出發時間欄距（分鐘）
    const DEPART_COLUMNS_MAX = 96;             // 欄數上限（96 欄 × 15 分 = 24 小時）
                                               // 預報涵蓋 96 小時、可排到約 370 欄，但步行模式節點多，
                                               // 格數會上萬；第一版先封頂，確認效能後再放寬
    const TIMELINE_AXIS_Y_PX = 27;             // 時間軸線距標頭頂端的距離
    const HEADER_H_PX = 72;                    // 標頭列高度；要容得下整點圓與其下方的時間標籤，
                                               // 太矮的話標籤會壓到第一列資料
    const SIDEBAR_MAX_X_PX = 520;              // 左側面板的寬度上限；用來篩掉地圖上的搜尋框
    const HOUR_DOT_PX = 20;                    // 整點圓直徑；加上 2px 外環後為 24px，
                                               // 剛好等於欄節距，不會溢出到鄰欄被蓋掉

    // 預報資料
    const FORECAST_HORIZON_HOURS = 96;         // 「未來3天」資料集實測涵蓋 96 小時
    const PLACE_CACHE_MAX = 600;               // 地點名稱快取的筆數上限；座標→名稱不會變，可放久
    const PLACE_GRID = 1e4;                    // 快取以座標取整到小數第 4 位（約 10 公尺）為鍵
    const PLACE_GAP_MS = 120;                  // 連續查詢的間隔，避免對 Google 造成突發流量
    const CACHE_TTL_MS = 30 * 60 * 1000;       // 氣象快取有效期：資料齊全且未超過此時間就直接沿用
    // 儲存鍵
    const KEY_CWA = 'cwaAuthorization';
    const KEY_CWA_CACHE = 'cwaForecastCache';
    const KEY_PLACE_CACHE = 'placeNameCache';

    // ────────────────────────────────────────────────────────────────
    // 依賴 Google Maps DOM 結構的選擇器，集中一處
    // 網站改版時只改這個物件。class 名稱是混淆過的，會隨版本變動——
    // 因此凡是能用「可見文字」或「結構特徵」判斷的，優先用那種方式。
    // ────────────────────────────────────────────────────────────────
    const SITE_SELECTORS = {
        panelCandidate: 'div.m6QErb.WNBkOb.XiKgde',   // 路線面板外層（量到寬 408、高 >400）
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
        lastRouteKey: '',
        capturedDirections: null,   // 攔截到的 /maps/preview/directions 回應
        gToken: '',                 // Google 內部端點的 session 權杖
        routePoints: null,          // 目前顯示路線的座標，用來算出離路線夠遠的按下點
        rerunTimer: null,
        panelBg: '',
        optionsClickHandler: null,
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
        // 把資料版本印出來。檔名要翻目錄才看得到，這樣每次執行都看得見，
        // 想確認「這份對應內政部哪一版」時不必去找檔案。
        const meta = doc._meta || {};
        log('界線資料：', meta.moi_version || '（未標版本）',
            meta.moi_date ? `（內政部 ${meta.moi_date} ／ ${meta.moi_date_roc}）` : '',
            meta.built_at ? `，${meta.built_at} 轉出` : '',
            '，', (doc.towns || []).length, '個鄉鎮');
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
     * data= 段裡有兩種區塊：
     *   …!1s{PlaceID}[!2z{名稱}]!2m2!1d{lng}!2d{lat}   → 正式停靠站
     *   3m4!1m2!1d{lng}!2d{lat}!3s{id}                 → 路徑控制點（手動拖曳產生）
     *
     * 停靠站的前綴數字會浮動，而且**浮動的不只一層**：
     *   路線檢視： !1m5!1m1!1s{PlaceID}!2m2!1d…!2d…
     *   點了景點： !1m6!1m2!1s{PlaceID}!2z{名稱}!2m2!1d…!2d…
     * 早先只放寬了最外層（1m5／1m20），把 1m1 寫死，結果點到景點時
     * 六個停靠站只抓到一個，等於整條路線解析失敗。
     * 因此改為只認 1s{PlaceID} 這個核心錨點，前綴一律不管，
     * 中間的名稱段（!2z…）可有可無。
     */
    function parseRouteFromUrl(href) {
        const m = href.match(/\/data=([^?]+)/);
        if (!m) return null;
        const data = m[1];
        const items = [];
        const stopRe = /1s(0x[0-9a-f]+:0x[0-9a-f]+)(?:!2z[^!]*)?!2m2!1d(-?[\d.]+)!2d(-?[\d.]+)/g;
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
        // 用可見文字定位，不依賴混淆過的 class。
        // 必須排除我們自己注入的按鈕：先前用 cloneNode 時，若文字替換沒套用到，
        // 就會出現一顆文字仍是「選項」的注入按鈕，於是自己找到自己、無限疊加。
        const btns = [...document.querySelectorAll('button')];
        return btns.find(b =>
            !b.hasAttribute('data-' + PREFIX + '-btn') &&
            b.textContent.trim() === SITE_SELECTORS.optionsButtonText) || null;
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
    // 網址 !3e{n} → Routes API travelMode。
    // 這張表只放「實測確認過」的對應，不是照抄常見說法：
    //   0 = 開車（2026-07-30 於面板顯示★開車時實測）
    // 其餘代碼還沒有樣本，留空讓它退回 DOM 判斷；每次執行都會把代碼記進 log，
    // 累積到樣本就補進來。DOM 那條路本身不乾淨（候選裡「大眾運輸」「單車」各出現兩次、
    // 還有「沒有航班」這種不是交通方式的項目），所以有網址代碼時優先用它。
    const URL_TRAVEL_CODE_MODE = {
        '0': 'DRIVE',
    };

    function detectTravelMode(urlTravelCode) {
        const byUrl = URL_TRAVEL_CODE_MODE[urlTravelCode];
        if (byUrl) {
            log('交通方式：由網址代碼 3e' + urlTravelCode + ' 判定為', byUrl);
            return { mode: byUrl, confident: true, via: '網址代碼 3e' + urlTravelCode, label: '' };
        }
        // 交通方式頁籤在面板最上方那一排（開車／大眾運輸／步行／單車…）。
        // 它不一定帶 aria-selected，實測也可能靠 class 或 aria-label 的「已選取」字樣表示，
        // 所以三種訊號都找，並把所有候選記進 log 以便後續補強判斷條件。
        // 對應到 Routes API 的 travelMode。Google Maps 提供的選項比 Routes API 支援的多，
        // 不支援的（航班、叫車）標成 null，之後直接告知使用者，不要退回 DRIVE 硬算出一張錯的表。
        const KEYWORDS = [
            [/步行|走路|walk/i, 'WALK'],
            [/機車|摩托車|two[-\s]?wheel|motorcycl/i, 'TWO_WHEELER'],
            [/自行車|單車|腳踏車|bicycl|bike|cycling/i, 'BICYCLE'],
            [/大眾運輸|公共運輸|大眾交通|轉乘|捷運|公車|transit/i, 'TRANSIT'],
            [/駕駛車輛|開車|駕車|汽車|driv/i, 'DRIVE'],
            [/航班|飛機|flight/i, null],
            [/叫車|共乘|計程車|ride|taxi/i, null],
        ];
        const cands = [...document.querySelectorAll('button,[role="tab"],[role="radio"]')]
            .map(el => ({
                el,
                label: (el.getAttribute('aria-label') || el.getAttribute('data-tooltip') || el.textContent || '').trim(),
                selected: el.getAttribute('aria-selected') === 'true' ||
                    el.getAttribute('aria-checked') === 'true' ||
                    el.getAttribute('aria-pressed') === 'true' ||
                    /selected|active/i.test(String(el.className || '')),
            }))
            .filter(x => x.label && KEYWORDS.some(([re]) => re.test(x.label)));

        log('交通方式候選：', cands.map(x => `${x.selected ? '★' : '　'}${x.label}`).join(' | ') || '（無）',
            '｜網址 3e 代碼=', urlTravelCode);

        const classify = (label, via) => {
            for (const [re, mode] of KEYWORDS) {
                if (re.test(label)) return { mode, confident: true, via, label };
            }
            return null;
        };
        const hit = cands.find(x => x.selected);
        if (hit) {
            const r = classify(hit.label, 'aria/class');
            if (r) return r;
        }
        if (cands.length === 1) {
            const r = classify(cands[0].label, '唯一候選');
            if (r) return { ...r, confident: false };
        }
        return { mode: 'DRIVE', confident: false, via: '預設值', label: '' };
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
                    if (res.status >= 200 && res.status < 300) { resolve(res.responseText); return; }
                    reject(new Error(`HTTP ${res.status}：${String(res.responseText).slice(0, 300)}`));
                },
                onerror: () => reject(new Error('網路錯誤')),
                ontimeout: () => reject(new Error('請求逾時')),
            });
        });
    }


    // ════════════════════════════════════════════════════════════════
    // 攔截 Google Maps 自己算好的路線資料
    //
    // 為什麼不用 Routes API 重算：畫面上既然已經把路線畫出來，資料就在頁面裡。
    // 重算一次不但消耗每日配額，算出來的還不保證跟畫面上完全一致
    //（先前實測出現過「面板顯示 1 小時 16 分、算出來 46 分」的落差）。
    //
    // 攔截器必須在 document-start 就架好：實測「直接開啟已規劃好的網址」時，
    // 那個請求在頁面載入的最初期就發出（0.00s），等到 document-idle 才架就已經錯過。
    // ════════════════════════════════════════════════════════════════

    const DIRECTIONS_URL_RE = /\/maps\/preview\/directions\?/;

    /**
     * 攔到疑似路線資料時，先確認「解析得出可用路線」才收下。
     *
     * 這個端點不只回傳一種東西：點擊格子會改寫網址、觸發 Google 重新請求，
     * 而它可能回傳局部更新或另一種形態的回應。若無條件覆蓋，
     * 原本好好的那份就會被蓋掉，下次解析直接失敗。
     * 因此改成「驗證後才存」，並且永遠保留最後一份可用的。
     */
    // Google 內部端點共用的 session 權杖，格式為 !1s{token}!7e81。
    // 它在同一個頁面的多種請求裡都會出現（directions、place、log204…），
    // 所以順手從攔截器取一次即可，不必另外操作。
    const TOKEN_RE = /!1s([A-Za-z0-9_-]{16,})!7e81/;
    function keepToken(url) {
        if (state.gToken) return;
        const m = String(url).match(TOKEN_RE);
        if (m) {
            state.gToken = m[1];
            log('已取得 Google session 權杖，地點名稱查詢可用');
        }
    }

    function keepIfDirections(url, text) {
        keepToken(url);
        if (!url || !DIRECTIONS_URL_RE.test(String(url))) return;
        if (!text || text.length < 1000) return;
        let alts;
        try {
            alts = parseDirections(text);
        } catch (err) {
            log('攔到 directions 回應但解析不了，保留原本那份｜', err.message,
                '｜大小', (text.length / 1024).toFixed(1) + 'KB');
            return;
        }
        const usable = alts.filter(a => a.points.length > 1 && a.steps.length > 0);
        if (!usable.length) {
            log('攔到 directions 回應但沒有可用路線，保留原本那份｜大小',
                (text.length / 1024).toFixed(1) + 'KB');
            return;
        }
        state.capturedDirections = { text, at: Date.now(), url: String(url), altCount: usable.length };
        log('已收下路線資料', (text.length / 1024).toFixed(1) + 'KB｜可用路線', usable.length, '條');
    }

    /** 真正的網頁 window。用了 GM_* 授權後腳本跑在沙箱裡，很多操作必須經由它才有效 */
    function pageWindow() {
        return (typeof unsafeWindow !== 'undefined' && unsafeWindow) || window;
    }

    function armInterceptors() {
        // 一旦用了任何 GM_* 授權，Tampermonkey 就會把腳本放進沙箱執行，
        // 此處的 window 是包裝過的代理物件——改它的 fetch / XMLHttpRequest
        // 只會動到沙箱自己那份副本，網頁實際使用的那份完全沒被攔到。
        // 必須改 unsafeWindow（真正的網頁 window）才有效。
        // （先前用 @grant none 的診斷腳本攔得到，是因為它本來就跑在網頁環境裡；
        //   拿那個結果推論有 grant 的腳本也會成立，是錯的。）
        const w = pageWindow();
        if (w === window) {
            warn('取不到 unsafeWindow，將在沙箱內攔截——很可能攔不到網頁自己的請求');
        }

        const XHR = w.XMLHttpRequest;
        if (XHR && XHR.prototype) {
            const origOpen = XHR.prototype.open;
            const origSend = XHR.prototype.send;
            XHR.prototype.open = function (method, url) {
                this.__rrUrl = url;
                return origOpen.apply(this, arguments);
            };
            XHR.prototype.send = function () {
                this.addEventListener('load', () => {
                    try { keepIfDirections(this.__rrUrl, this.responseText); } catch (err) { /* 非文字回應 */ }
                });
                return origSend.apply(this, arguments);
            };
        }

        const origFetch = w.fetch;
        if (typeof origFetch === 'function') {
            w.fetch = function (...args) {
                return origFetch.apply(this, args).then(res => {
                    // 一定要 clone：把 body 讀掉會讓網站自己拿不到資料
                    res.clone().text()
                        .then(t => keepIfDirections((args[0] && args[0].url) || args[0], t))
                        .catch(() => {});
                    return res;
                });
            };
        }
        log('攔截器已架設（XHR + fetch）｜環境=', w === window ? '沙箱（可能無效）' : 'unsafeWindow');
    }

    // ── 解析 ──
    // 結構（實測驗證過，數字路徑固定）：
    //   [0][1][r]                     第 r 條替代路線的摘要
    //     [0][2] = [公尺, "35.9 公里", 0]
    //     [0][3] = [秒,   "1 小時 13 分"]
    //     [1][0][1]                   legs 陣列，每個 leg 的 [1] 是 steps
    //       step[0][2] = [公尺, 文字, 0]
    //       step[0][3] = [秒, 文字]
    //       step[0][14]                結構化指示 token，型別碼 2 且帶旗標 1 者為路名
    //   [0][7][r]                     第 r 條路線的座標（與 [0][1] 索引對齊）
    //     [0] 緯度、[1] 經度：第一個元素是絕對值 ×1e7，其餘為差量，累加還原
    //     [4] 海拔差量（未使用）

    function accumulate(deltas) {
        let sum = 0;
        const out = new Array(deltas.length);
        for (let i = 0; i < deltas.length; i++) { sum += deltas[i]; out[i] = sum; }
        return out;
    }

    function roadNamesOf(step) {
        const tokens = (step[0] && step[0][14]) || [];
        const names = [];
        for (const t of tokens) {
            // 型別碼 2 = 文字/道路，14 = 轉彎方向；第二個元素帶旗標 1 表示這是專有名稱
            if (Array.isArray(t) && t[0] === 2 && Array.isArray(t[1]) && t[1][1] === 1) {
                names.push(t[1][0]);
            }
        }
        return names;
    }

    function parseDirections(text) {
        const body = text.replace(/^\)\]\}'\n?/, '');   // Google 慣用的防劫持前綴
        const root = JSON.parse(body);
        const alts = root[0] && root[0][1];
        const geos = root[0] && root[0][7];
        if (!Array.isArray(alts) || !Array.isArray(geos)) {
            const shape = `頂層=${Array.isArray(root) ? 'Array(' + root.length + ')' : typeof root}` +
                `，[0][1]=${Array.isArray(alts) ? 'Array(' + alts.length + ')' : typeof alts}` +
                `，[0][7]=${Array.isArray(geos) ? 'Array(' + geos.length + ')' : typeof geos}`;
            throw new Error('路線資料的結構與預期不符（' + shape + '）');
        }
        const out = [];
        for (let r = 0; r < Math.min(alts.length, geos.length); r++) {
            const summary = alts[r][0];
            // 這一層是「路段」陣列：沒有中途停靠點時只有一段，
            // 每加一個停靠點就多一段。原本只取 [0]，因此加了停靠點之後
            // 第二段以後的步驟全部漏掉——時間軸只涵蓋到第一個停靠點，
            // 後半段的節點被壓縮進那段時間裡，目的地卻用摘要的總時程，落差就露出來。
            const segments = (alts[r][1] || []).filter(s => Array.isArray(s));
            const steps = [];
            // 注意：leg 的分界**不是**使用者設定的停靠點。實測只有起訖兩點的路線，
            // Google 仍會切成兩個 leg（第二個只有一步、三百多公尺，是抵達前的最後一小段）。
            // 停靠點要從網址的 data= 段取得，那裡才明確區分「停靠站」與「拖曳控制點」。
            for (const seg of segments) {
                for (const leg of (seg[1] || [])) {
                    for (const st of (leg[1] || [])) {
                        steps.push({
                            meters: (st[0] && st[0][2] && st[0][2][0]) || 0,
                            sec: (st[0] && st[0][3] && st[0][3][0]) || 0,
                            roads: roadNamesOf(st),
                        });
                    }
                }
            }
            const lat = accumulate(geos[r][0]);
            const lon = accumulate(geos[r][1]);
            const points = new Array(lat.length);
            for (let i = 0; i < lat.length; i++) points[i] = [lat[i] / 1e7, lon[i] / 1e7];
            out.push({
                points, steps,
                totalMeters: (summary[2] && summary[2][0]) || 0,
                totalSec: (summary[3] && summary[3][0]) || 0,
                distanceText: (summary[2] && summary[2][1]) || '',
                durationText: (summary[3] && summary[3][1]) || '',
            });
        }
        return out;
    }

    /** 從替代路線中挑出面板上選中的那一條：用面板顯示的距離與時間比對 */
    function pickAlternative(alts, selected) {
        if (alts.length === 1) return { alt: alts[0], matchNote: '只有一條' };
        if (!selected || selected.distanceMeters == null) {
            return { alt: alts[0], matchNote: '面板讀不到數值，取第一條' };
        }
        let best = null;
        for (const a of alts) {
            const score = Math.abs(a.totalMeters - selected.distanceMeters) /
                Math.max(selected.distanceMeters, 1);
            if (!best || score < best.score) best = { alt: a, score };
        }
        return {
            alt: best.alt,
            matchNote: `比對面板值（${selected.distanceText}）誤差 ${(best.score * 100).toFixed(1)}%`,
        };
    }

    // ════════════════════════════════════════════════════════════════
    // 地點名稱（反向地理編碼）
    //
    // 用 Google 自己的 /maps/preview/reveal——就是在地圖上點一下會冒出
    // 「崁腳里 / 207新北市萬里區」那個彈窗背後的端點。
    //
    // 為什麼不繼續用導航指示裡的路名：那是「某一段路的名稱」，
    // 節點所在的段落若沒有路名就得往前後借，而容忍範圍是時間（±300 秒）；
    // 開車五分鐘可以跑好幾公里，借來的路名常常離節點超過一個螢幕。
    //
    // 實測（真實路徑上 7 個取樣點）全部正確，且回應的 [0] 就是彈窗顯示的兩行：
    //   ["北28鄉道", "207新北市萬里區溪底里"]  → 主名稱 ／ 行政區
    // 座標可任意更換、不需要 cookie；唯一相依是 session 權杖。
    // ════════════════════════════════════════════════════════════════

    function revealUrl(lat, lon, token) {
        // 視野參數實測不影響結果，直接填目標座標即可
        return 'https://www.google.com/maps/preview/reveal?authuser=0&hl=zh-TW&gl=tw' +
            `&pb=!2m9!1m3!1d9403!2d${lon}!3d${lat}!2m0!3m2!1i1658!2i1000!4f13.1` +
            `!3m2!2d${lon}!3d${lat}!4m2!1s${encodeURIComponent(token)}!7e81` +
            '!5m5!2m4!1i96!2i64!3i1!4i8';
    }

    /** 回傳 { title, area }；查不到就回 null，由呼叫端決定要不要退回路名 */
    async function revealPlace(lat, lon, token) {
        const text = await gmRequest({ url: revealUrl(lat, lon, token) });
        const i = text.indexOf('[[');
        if (i < 0) return null;
        const data = JSON.parse(text.slice(i));
        const head = (data[0] || []).filter(x => typeof x === 'string' && x);
        if (!head.length) return null;
        return { title: head[0], area: head[1] || null };
    }

    function placeCacheKey(lat, lon) {
        return Math.round(lat * PLACE_GRID) + ',' + Math.round(lon * PLACE_GRID);
    }

    function loadPlaceCache() {
        try {
            const raw = GM_getValue(KEY_PLACE_CACHE, '');
            const o = raw ? JSON.parse(raw) : {};
            return (o && typeof o === 'object') ? o : {};
        } catch (err) { return {}; }
    }

    /**
     * 一次把所有節點的地點名稱查好。
     *
     * 座標到名稱的對應不會隨時間改變，所以快取可以放很久，不設有效期；
     * 只在筆數超過上限時丟掉最舊的。這讓反覆測試同一條路線幾乎不會再發出請求。
     */
    async function fillPlaceNames(nodes, onProgress) {
        if (!state.gToken) {
            log('沒有 session 權杖，略過地點名稱查詢（沿用導航指示的路名）');
            if (onProgress) onProgress(nodes.length, nodes.length);
            return { hit: 0, fetched: 0 };
        }
        const cache = loadPlaceCache();
        let hit = 0, fetched = 0, failed = 0;
        for (const n of nodes) {
            const key = placeCacheKey(n.lat, n.lon);
            if (cache[key]) {
                n.place = cache[key]; hit++;
                if (onProgress) onProgress(hit + fetched + failed, nodes.length);
                continue;
            }
            try {
                const r = await revealPlace(n.lat, n.lon, state.gToken);
                if (r) { n.place = r; cache[key] = r; fetched++; }
                else failed++;
            } catch (err) {
                failed++;
            }
            if (onProgress) onProgress(hit + fetched + failed, nodes.length);
            await wait(PLACE_GAP_MS);
        }
        // 超量時丟掉最舊的（物件的插入順序即為新舊）
        const keys = Object.keys(cache);
        if (keys.length > PLACE_CACHE_MAX) {
            for (const k of keys.slice(0, keys.length - PLACE_CACHE_MAX)) delete cache[k];
        }
        try { GM_setValue(KEY_PLACE_CACHE, JSON.stringify(cache)); } catch (err) { /* 寫入失敗不影響本次 */ }
        log('地點名稱：快取命中', hit, '／新查詢', fetched, failed ? `／查不到 ${failed}` : '');
        return { hit, fetched };
    }

    // ════════════════════════════════════════════════════════════════
    // 時間軸與節點切分
    // ════════════════════════════════════════════════════════════════

    /**
     * 把座標點與 step 資料組成時間軸。
     *
     * 資料裡沒有「第幾步對應到第幾個座標點」的索引（整包掃過確認沒有），
     * 因此改用累積距離對應：先算出每個點的累積距離，再依各 step 宣告的公尺數
     * 切出邊界，落在哪一段就用那一段的秒數線性內插。
     * 實測座標累加距離與宣告總距離誤差僅 0.01%，這個對應足夠準確。
     */
    function buildTimeline(alt) {
        const pts = alt.points;
        const cum = new Array(pts.length);
        cum[0] = 0;
        for (let i = 1; i < pts.length; i++) {
            cum[i] = cum[i - 1] + haversine(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]);
        }
        const geoTotal = cum[cum.length - 1] || 1;
        const declared = alt.steps.reduce((s, st) => s + st.meters, 0) || geoTotal;
        const scale = geoTotal / declared;   // 消化兩者間的微小差異

        // step 的累積邊界（已換算成「座標尺度」的公尺）
        const bounds = [0];
        const stepTimes = [0];
        for (const st of alt.steps) {
            bounds.push(bounds[bounds.length - 1] + st.meters * scale);
            stepTimes.push(stepTimes[stepTimes.length - 1] + st.sec);
        }

        const timeline = new Array(pts.length);
        let si = 0;
        for (let i = 0; i < pts.length; i++) {
            while (si < alt.steps.length - 1 && cum[i] >= bounds[si + 1]) si++;
            const segLen = bounds[si + 1] - bounds[si];
            const frac = segLen > 0 ? (cum[i] - bounds[si]) / segLen : 0;
            const sec = stepTimes[si] + Math.max(0, Math.min(1, frac)) * alt.steps[si].sec;
            timeline[i] = { sec, lat: pts[i][0], lon: pts[i][1] };
        }
        // 時間軸必須單調遞增，否則後面的二分搜尋會出錯
        for (let i = 1; i < timeline.length; i++) {
            if (timeline[i].sec < timeline[i - 1].sec) timeline[i].sec = timeline[i - 1].sec;
        }

        // 保留一道防呆：步驟與摘要若仍對不上，只記錄不臆測，
        // 免得又用一個推估模型把真正的資料問題蓋掉。
        const stepsTotal = stepTimes[stepTimes.length - 1] || 0;
        const declaredTotal = alt.totalSec || stepsTotal;
        const declaredMeters = alt.totalMeters || declared;
        if (Math.abs(declaredTotal - stepsTotal) > 60 || declared < declaredMeters * 0.9) {
            warn('步驟與摘要不一致：步驟', alt.steps.length, '個、加總',
                Math.round(declared), '公尺 /', Math.round(stepsTotal / 60), '分；',
                '摘要', Math.round(declaredMeters), '公尺 /', Math.round(declaredTotal / 60), '分');
        }

        const steps = alt.steps.map((st, k) => ({
            t0: stepTimes[k], t1: stepTimes[k + 1], roads: st.roads,
        }));
        return {
            timeline, steps,
            totalSec: alt.totalSec || stepTimes[stepTimes.length - 1],
        };
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
    // 使用者自己規劃的三類位置，在表格上要標示出來
    const KIND_LABEL = { origin: '出發', waypoint: '停靠', destination: '抵達' };

    /**
     * 把時間軸切成節點。
     *
     * 基本規則是「同一鄉鎮取中點」，但**使用者自己規劃的點必須保留**——
     * 起點、目的地、以及他設定的中途停靠點。那些是他刻意選的位置，
     * 看不到就等於工具漏掉了他最在意的資訊。
     *
     * 因此切分時改成：某一小段裡若含有這類錨點，就**用錨點取代中點**；
     * 一段裡有好幾個錨點就全部保留，不合併。沒有錨點的段落才取中點。
     *
     * @param anchors [{ sec, kind }]，kind 為 origin／waypoint／destination
     */
    /**
     * 讀出使用者在路線面板上輸入的地點名稱，依 DOM 順序：起點、（停靠站…）、目的地。
     * 網址裡只有 PlaceID 沒有名稱，而使用者認得的是自己打的那串字
     * （例如「野柳女王頭 207新北市萬里區…」），不是鄉鎮名。
     */
    function readEndpointNames() {
        // 輸入框不在 findPanel() 找到的那個容器裡——那是「路線清單」面板，
        // 起點/目的地的搜尋框在它上方，屬於另一個容器。所以改為全頁掃描，
        // 再用「可見、有值、位於左側面板寬度內」篩選，並依畫面上的位置排序。
        const cands = [...document.querySelectorAll('input')]
            .map(el => ({ el, r: el.getBoundingClientRect(), v: (el.value || '').trim() }))
            .filter(o => o.v && o.r.width > 60 && o.r.height > 10 &&
                o.r.left < SIDEBAR_MAX_X_PX && o.el.offsetParent !== null);
        cands.sort((a, b) => a.r.top - b.r.top || a.r.left - b.r.left);
        return cands.map(o => o.v);
    }

    /** 找出時間軸上離指定座標最近的那一點的時刻——用來把停靠站對應到行程時間 */
    function nearestSecOnTimeline(timeline, lat, lon) {
        let best = null, bestD = Infinity;
        for (const p of timeline) {
            const d = (p.lat - lat) * (p.lat - lat) + (p.lon - lon) * (p.lon - lon);
            if (d < bestD) { bestD = d; best = p; }
        }
        return best ? best.sec : null;
    }

    /**
     * 把靠近 Google 節點的中途節點吸附過去，改用 Google 的節點。
     *
     * Google 在路線上畫的白色圓點就是 step 邊界（實測確認），它們是轉彎、
     * 匯流這類行車動作點，對使用者是「記憶點」；我們中間插的取樣點只是
     * 為了取天氣而等分出來的位置，本身沒有意義。靠得夠近時改用它更好，
     * 而且點下去的行為也一致（懸停就會冒出 Google 自己的資訊卡）。
     *
     * 兩個限制：
     *   ・必須同一個鄉鎮——跨了就會取到別的鄉鎮的天氣，那是實質錯誤
     *   ・多個節點吸到同一個 Google 節點時要去重，否則表格會出現重複列
     *
     * 使用者指定的起點／停靠／目的地不動。
     */
    function snapToGoogleNodes(nodes, timeline, steps, townAt) {
        if (!steps || steps.length < 2) return { snapped: 0, removed: 0 };
        const bounds = steps.slice(1).map(s => s.t0);      // 內部邊界，不含起訖
        if (!bounds.length) return { snapped: 0, removed: 0 };

        const used = new Set();
        let snapped = 0;
        for (const n of nodes) {
            if (n.kind) continue;                          // 使用者指定的位置不動
            let bestSec = null, best = Infinity;
            for (const b of bounds) {
                if (b < n.enterSec || b > n.exitSec) continue;   // 超出本鄉鎮區段就不考慮
                const p = positionAt(timeline, b);
                const d = haversine(n.lat, n.lon, p.lat, p.lon);
                if (d < best) { best = d; bestSec = b; }
            }
            if (bestSec === null || best > NODE_SNAP_M) continue;
            const p = positionAt(timeline, bestSec);
            // 同鄉鎮是硬條件：吸過去卻換了鄉鎮，天氣就取錯了。
            // townAt 由呼叫端傳入——鄉鎮查詢的資料只在 buildNodes 內建立，
            // 這裡不能直接用（先前寫成直接呼叫，執行時報 whoAt is not defined）
            const t = townAt ? townAt(p.lat, p.lon) : null;
            if (!t || t.county !== n.county || t.town !== n.town) continue;
            n.sec = bestSec;
            n.lat = p.lat;
            n.lon = p.lon;
            n.isGoogleNode = true;                         // 之後只懸停、不點擊
            n.snappedFrom = Math.round(best);
            snapped++;
        }

        // 去重：多個節點可能吸到同一個 Google 節點
        const kept = [];
        let removed = 0;
        for (const n of nodes) {
            if (n.isGoogleNode) {
                const key = Math.round(n.sec);
                if (used.has(key)) { removed++; continue; }
                used.add(key);
            }
            kept.push(n);
        }
        nodes.length = 0;
        nodes.push(...kept);
        return { snapped, removed };
    }

    function buildNodes(timeline, totalSec, anchors) {
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

        const anchorList = (anchors || []).slice().sort((a, b) => a.sec - b.sec);
        const usedAnchors = new Set();
        // kind 可傳字串或整個錨點物件（後者才帶得出使用者輸入的名稱）
        const makeNode = (sec, p, part, kind) => {
            const pos = positionAt(timeline, sec);
            return {
                sec, lat: pos.lat, lon: pos.lon,
                county: p ? p.county : null, town: p ? p.town : null,
                enterSec: p ? p.t0 : sec, exitSec: p ? p.t1 : sec,
                dwellSec: p ? p.accum : 0,
                part, kind: kind ? kind.kind || kind : null,
                placeName: (kind && kind.name) || null,
                isFlap: p ? Math.abs((p.t1 - p.t0) - p.accum) > 5 : false,
            };
        };

        const nodes = [];
        for (const p of kept) {
            const span = p.t1 - p.t0;
            const n = Math.max(1, Math.floor(span / SUBDIVIDE_SEC) + 1);
            for (let k = 0; k < n; k++) {
                const segStart = p.t0 + span * k / n;
                const segEnd = p.t0 + span * (k + 1) / n;
                // 這一小段裡的錨點；最後一段要含右端點，否則目的地會落在區間外
                const inSeg = anchorList.filter(a =>
                    a.sec >= segStart && (k === n - 1 ? a.sec <= segEnd : a.sec < segEnd));
                if (inSeg.length) {
                    // 錨點取代中點，而且有幾個就保留幾個——使用者規劃的位置不合併
                    for (const a of inSeg) {
                        nodes.push(makeNode(a.sec, p, [k + 1, n], a));
                        usedAnchors.add(a);
                    }
                } else {
                    nodes.push(makeNode(p.t0 + span * (2 * k + 1) / (2 * n), p, [k + 1, n], null));
                }
            }
        }

        // 保險：落在被丟棄的鄉鎮裡、或不屬於任何鄉鎮的錨點，仍然要出現。
        // 起點特別容易走到這裡：出發座標常在建築物內或路網邊緣，
        // 逐點判斷時第一個點未必落在任何鄉鎮多邊形內。
        for (const a of anchorList) {
            if (usedAnchors.has(a)) continue;
            const pos = positionAt(timeline, a.sec);
            let t = whoAt(pos.lat, pos.lon);
            if (!t) {
                // 往後找最近一個判得出鄉鎮的點，總比顯示「未知區域」好
                for (const q of timeline) {
                    if (q.sec < a.sec) continue;
                    const cand = whoAt(q.lat, q.lon);
                    if (cand) { t = cand; break; }
                }
            }
            nodes.push(makeNode(a.sec, t ? { county: t.county, town: t.town,
                t0: a.sec, t1: a.sec, accum: 0 } : null, [1, 1], a));
            log('錨點不在任何保留的鄉鎮區段內，另外補上：', a.kind,
                Math.round(a.sec / 60), '分', t ? `（${t.county}${t.town}）` : '（查不到鄉鎮）');
        }

        nodes.sort((a, b) => a.sec - b.sec);
        nodes.townAt = whoAt;          // 供 snapToGoogleNodes 判斷吸附後是否仍在同鄉鎮
        // 起點沒出現時，要能直接看出是「錨點沒傳進來」還是「配對到哪裡去了」
        log('錨點：', (anchors || []).map(a =>
            `${a.kind}@${Math.round(a.sec / 60)}分`).join('、') || '（無）',
            '／已標記的節點：', nodes.filter(n => n.kind).map(n =>
                `${n.kind}@${Math.round(n.sec / 60)}分`).join('、') || '（無）');
        log('節點數', nodes.length, '／涵蓋鄉鎮', new Set(nodes.map(n => n.county + n.town)).size,
            '／總行程', Math.round(totalSec / 60), '分');
        return nodes;
    }

    // ════════════════════════════════════════════════════════════════
    // 路名抽取
    // ════════════════════════════════════════════════════════════════

    /**
     * 節點所在 step 若沒有路名，前後雙向找時間差最小的；相同時優先取「前」。
     *
     * 路名不再靠解析中文句子。Google 自己的資料就把指示拆成結構化 token，
     * 型別碼 2 且帶旗標者即為道路專有名稱（見 roadNamesOf）。
     * 先前用 12 條正則去比對「進入X」「繼續走X」這類句型，遇到「繼續直行」
     * 這種沒有路名的指示就抓不到，還得再寫一層驗證去過濾誤抓；現在都不需要了。
     */
    function resolveRoadName(steps, sec) {
        let idx = steps.findIndex(s => s.t0 <= sec && sec < s.t1);
        if (idx < 0) idx = steps.length - 1;
        if (idx >= 0 && steps[idx] && steps[idx].roads.length) {
            return { name: steps[idx].roads[0], borrowed: false };
        }
        let best = null;
        for (let j = 0; j < steps.length; j++) {
            if (j === idx || !steps[j].roads.length) continue;
            const gap = j < idx ? Math.max(0, sec - steps[j].t1) : Math.max(0, steps[j].t0 - sec);
            if (gap > ROAD_NAME_MAX_GAP_SEC) continue;
            const dir = j < idx ? 'before' : 'after';
            if (!best || gap < best.gap || (gap === best.gap && dir === 'before')) {
                best = { name: steps[j].roads[0], gap, dir };
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




    /**
     * 依縣市分組批次查詢。LocationName 官方標為 array<string>，可重複帶多個值，
     * 因此呼叫次數只跟「經過幾個縣市」掛勾，不隨鄉鎮數膨脹。
     * 注意：參數名大小寫敏感（LocationName／ElementName），寫成小寫開頭會靜默失效——
     * 伺服器不報錯，只是退回未篩選的完整資料。
     */
    /**
     * 一次把該縣市的完整預報取回來，不帶 timeFrom／timeTo。
     *
     * 實測（新北市 4 個區，各 5 次取中位數）：
     *   下時間段（6 小時）→  4.0 KB / 0.29 秒
     *   不下時間段（96 小時）→ 35.7 KB / 0.45 秒
     * 資料量差 8.9 倍，耗時只差 0.16 秒；一條經過 5 個縣市的路線也只多約 0.8 秒，而且只多這一次。
     *
     * 換來的是：快取一次涵蓋完整 96 小時，往後除非跑到新的鄉鎮或過了 TTL，都不必再打 API。
     * 表格的出發時間上限是 24 小時，加上行程時間仍遠在 96 小時內，全取即一次拿齊。
     *
     * 順帶消掉一整類風險：timeFrom 只要沒對齊 3 小時邊界、或帶錯時區，
     * 氣象署會靜默回傳空陣列而不報錯——不帶這個參數就不會踩到。
     */
    async function fetchForecast(auth, nodes) {
        const byCounty = new Map();
        for (const n of nodes) {
            if (!byCounty.has(n.county)) byCounty.set(n.county, new Set());
            byCounty.get(n.county).add(n.town);
        }
        const forecast = new Map();     // town → [{startMs, endMs, pop, weather, code}]
        const failures = [];

        for (const [county, townSet] of byCounty) {
            const dataid = CWA_DATAID[county];
            if (!dataid) { failures.push(`${county}（沒有對應的 dataid）`); continue; }
            const params = [...townSet].map(t => 'LocationName=' + encodeURIComponent(t)).join('&');
            const url = `https://opendata.cwa.gov.tw/api/v1/rest/datastore/${dataid}` +
                `?Authorization=${encodeURIComponent(auth)}&${params}` +
                `&ElementName=${encodeURIComponent('3小時降雨機率')}` +
                `&ElementName=${encodeURIComponent('天氣現象')}&format=JSON`;
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

    // ── 快取 ──
    // 規則：
    //   1. 每次向氣象署取資料都記下時間
    //   2. 下次先檢查「這次需要的地點與時間範圍」快取裡是否齊全
    //   3. 有缺 → 把這次需要的地點整批重新取（不補差額），並更新時間
    //   4. 沒缺 → 看時間，未超過 CACHE_TTL_MS 就直接沿用
    //
    // 之所以「有缺就整批重取」而不是只補缺的那幾個：氣象署的預報會整批更新，
    // 同一張表裡若混用不同時間點取得的資料，各列的基準會不一致。
    //
    // 但「整批重取」不等於「丟掉其他路線的資料」。舊版把整個 towns 物件覆蓋掉，
    // 結果在兩條路線之間來回切換時，每次都會把上一條的資料洗掉、每次都重打 API。
    // 因此改成逐鄉鎮各自記錄時間戳與涵蓋範圍，寫入時合併。
    // 這樣同一張表用到的鄉鎮仍然來自同一次請求（因為它們是一起重取的），
    // 不會有基準不一致的問題，但別條路線的資料得以保留。

    function loadCache() {
        try {
            const raw = GM_getValue(KEY_CWA_CACHE, '');
            if (!raw) return {};
            const obj = JSON.parse(raw);
            if (!obj || typeof obj !== 'object') return {};
            return obj.towns && obj.fetchedAt ? {} : obj;   // 舊格式直接丟棄，重新建立
        } catch (err) {
            warn('快取讀取失敗，視為沒有快取：', err.message);
            return {};
        }
    }

    /** 把本次取得的資料合併進快取，不動其他鄉鎮 */
    function saveCache(forecast) {
        const cache = loadCache();
        const at = Date.now();
        for (const [name, rows] of forecast) {
            cache[name] = { at, rows };
        }
        try {
            GM_setValue(KEY_CWA_CACHE, JSON.stringify(cache));
        } catch (err) {
            warn('快取寫入失敗（不影響本次結果）：', err.message);
        }
    }

    /**
     * 檢查快取能否滿足這次的需求。
     *
     * 改為全取之後只剩兩個條件：地點有沒有、有沒有過期。
     * 原本還有第三條「時間範圍夠不夠」，那是誤判的主因——
     * 需要的範圍會隨時間往前推移，只要跨過一格就判定不足而整批重取，
     * 但實際上同一個 3 小時格內的資料完全相同，重取毫無意義。
     * 全取讓快取一次涵蓋 96 小時，這個條件就不需要存在了。
     */
    function cacheShortfall(cache, neededTowns) {
        const now = Date.now();
        const missing = [], stale = [];
        for (const t of neededTowns) {
            const e = cache[t];
            if (!e || !e.rows || !e.rows.length) { missing.push(t); continue; }
            if (now - e.at > CACHE_TTL_MS) stale.push(t);
        }
        if (missing.length) {
            return { reason: `快取裡沒有這 ${missing.length} 個鄉鎮：` + missing.join('、') };
        }
        if (stale.length) {
            const age = Math.round((now - Math.min(...stale.map(t => cache[t].at))) / 60000);
            return { reason: `資料已過 ${age} 分鐘（上限 ${CACHE_TTL_MS / 60000} 分鐘）` };
        }
        return null;
    }

    async function getForecast(auth, nodes, onFetchStart) {
        const neededTowns = [...new Set(nodes.map(n => n.town))];
        const cache = loadCache();
        const shortfall = cacheShortfall(cache, neededTowns);

        if (!shortfall) {
            const forecast = new Map(neededTowns.map(t => [t, cache[t].rows]));
            const oldest = Math.min(...neededTowns.map(t => cache[t].at));
            log('【氣象】沿用快取，未呼叫中央氣象署 API。',
                neededTowns.length, '個鄉鎮齊全，最舊一筆為',
                Math.round((Date.now() - oldest) / 60000), '分鐘前取得');
            return { forecast, failures: [], callCount: 0, fetchedAt: oldest, fromCache: true };
        }
        log('【氣象】快取不可用，將呼叫中央氣象署 API。原因：' + shortfall.reason +
            '｜本次需要 ' + neededTowns.length + ' 個鄉鎮');

        if (onFetchStart) onFetchStart();
        const res = await fetchForecast(auth, nodes);
        if (!res.failures.length) {
            saveCache(res.forecast);
            log('【氣象】已呼叫 API 並寫入快取（每個縣市完整 96 小時）');
        } else {
            warn('【氣象】有縣市取得失敗，不寫入快取（下次仍會重新呼叫）');
        }
        return { ...res, fetchedAt: Date.now(), fromCache: false };
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
        // 只剩氣象署一組。路線資料改為攔截頁面自己的請求，不再需要 Google 金鑰。
        return { cwa: GM_getValue(KEY_CWA, '') };
    }

    /**
     * 金鑰設定面板。
     * 用業界慣例的密碼欄型式：輸入框右側嵌一顆眼睛按鈕、以細分隔線隔開，
     * 預設遮蔽（type=password），按下才顯示明碼。
     * 金鑰只存在 GM 儲存空間（使用者自己的瀏覽器），不會出現在腳本原始碼或 repo 裡。
     */
    function openSettings() {
        // 面板完全靠 CSS class 撐版面。從 Tampermonkey 選單呼叫時，
        // 樣式可能還沒注入過（那是在 activate 才做的），漏掉這一步的話
        // 面板會變成沒有樣式的 div 貼在 body 最上面——看不見、卻佔著版面又可以點。
        injectStyle();
        document.getElementById(PREFIX + '-modal')?.remove();
        const cur = getKeys();

        const back = document.createElement('div');
        back.id = PREFIX + '-modal';
        back.className = PREFIX + '-modal-back';

        const box = document.createElement('div');
        box.className = PREFIX + '-modal';

        const field = (labelText, hintText, value, name) => `
<label class="${PREFIX}-f">
  <span class="${PREFIX}-flabel">${labelText}</span>
  <span class="${PREFIX}-hint">${hintText}</span>
  <span class="${PREFIX}-inwrap">
    <input type="password" name="${name}" value="${(value || '').replace(/"/g, '&quot;')}"
           autocomplete="off" spellcheck="false">
    <button type="button" class="${PREFIX}-eye" data-${PREFIX}-eye aria-label="顯示或隱藏內容">
      <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
        <path class="${PREFIX}-eye-open" fill="currentColor"
          d="M12 5c-5 0-9 4.5-9 7s4 7 9 7 9-4.5 9-7-4-7-9-7Zm0 11.5A4.5 4.5 0 1 1 12 7.5a4.5 4.5 0 0 1 0 9Zm0-2.2a2.3 2.3 0 1 0 0-4.6 2.3 2.3 0 0 0 0 4.6Z"/>
        <path class="${PREFIX}-eye-off" fill="currentColor" style="display:none"
          d="M3.3 4.7 4.7 3.3l16 16-1.4 1.4-3-3A10.6 10.6 0 0 1 12 19c-5 0-9-4.5-9-7 0-1.4 1.2-3.3 3.1-4.8L3.3 4.7Zm5.3 5.3A4.5 4.5 0 0 0 12 16.5c.7 0 1.4-.2 2-.5l-1.6-1.6a2.3 2.3 0 0 1-2.8-2.8L8.6 10Zm3.4-5A10.4 10.4 0 0 1 21 12a11 11 0 0 1-2.4 3.3l-1.5-1.5A9 9 0 0 0 18.9 12C18 10.6 15.4 7 12 7c-.4 0-.8 0-1.2.1L9.4 5.7c.8-.2 1.7-.3 2.6-.3Z"/>
      </svg>
    </button>
  </span>
</label>`;

        box.innerHTML = `
<div class="${PREFIX}-mtitle">API 金鑰設定</div>
<div class="${PREFIX}-mdesc">授權碼只存在你自己的瀏覽器，不會上傳，也不在腳本原始碼中。</div>
${field('中央氣象署授權碼', 'opendata.cwa.gov.tw 免費註冊即可取得，格式為 CWA-…', cur.cwa, 'cwa')}
<div class="${PREFIX}-mact">
  <button type="button" class="${PREFIX}-mbtn" data-${PREFIX}-cancel>取消</button>
  <button type="button" class="${PREFIX}-mbtn ${PREFIX}-primary" data-${PREFIX}-save>儲存</button>
</div>`;

        back.appendChild(box);
        document.body.appendChild(back);
        box.querySelector('input')?.focus();

        box.addEventListener('click', ev => {
            const eye = ev.target.closest('[data-' + PREFIX + '-eye]');
            if (eye) {
                const input = eye.parentElement.querySelector('input');
                const show = input.type === 'password';
                input.type = show ? 'text' : 'password';
                eye.querySelector('.' + PREFIX + '-eye-open').style.display = show ? 'none' : '';
                eye.querySelector('.' + PREFIX + '-eye-off').style.display = show ? '' : 'none';
                return;
            }
            if (ev.target.closest('[data-' + PREFIX + '-cancel]')) { back.remove(); return; }
            if (ev.target.closest('[data-' + PREFIX + '-save]')) {
                const get = n => box.querySelector(`input[name="${n}"]`).value.trim();
                GM_setValue(KEY_CWA, get('cwa'));
                back.remove();
                log('金鑰已儲存');
                if (state.active && state.container) {
                    clearBody(state.container);
                    run(state.container).catch(err => {
                        warn(err);
                        clearBody(state.container);
                        showMessage(state.container, '出錯了：' + err.message);
                    });
                }
            }
        });
        back.addEventListener('click', ev => { if (ev.target === back) back.remove(); });
        document.addEventListener('keydown', function esc(ev) {
            if (ev.key === 'Escape') { back.remove(); document.removeEventListener('keydown', esc); }
        });
    }

    GM_registerMenuCommand('設定 API 金鑰', openSettings);

    // 診斷做在腳本自己身上，不透過另一支腳本去讀 DOM 屬性——
    // 那樣多一層依賴，而那層依賴出過事（面板的探針被換掉，資料就沒人讀了）。
    GM_registerMenuCommand('複製上次定位診斷', () => {
        const logText = document.documentElement.getAttribute('data-' + PREFIX + '-log') || '';
        const lines = logText.trim().split('\n').filter(Boolean);
        const text = lines.length
            ? '=== route-rain 定位診斷 ===\n' + lines.join('\n')
            : '（還沒有診斷資料，請先點一次表格中的格子）';
        try {
            GM_setClipboard(text);
            log('診斷已複製到剪貼簿，共', lines.length, '筆');
        } catch (err) {
            // GM_setClipboard 不可用時退回可全選的視窗
            const ta = document.createElement('textarea');
            ta.value = text;
            ta.style.cssText = 'position:fixed;top:10%;left:10%;width:80%;height:60%;z-index:2147483647';
            document.body.appendChild(ta);
            ta.select();
            warn('自動複製失敗，請手動 Ctrl+C 後關閉：', err.message);
        }
    });

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
/* 清空文字節點後仍會與原文疊字，代表原本的字可能來自虛擬元素的 content，
   這裡一併壓掉；另外標示啟用狀態 */
[data-${PREFIX}-btn]::before,[data-${PREFIX}-btn]::after,
[data-${PREFIX}-btn] *::before,[data-${PREFIX}-btn] *::after{content:none !important}
/* 原按鈕若是絕對定位（例如靠右釘住），複製出來的會落在同一個位置而與原按鈕重疊。
   強制回到一般流排版，並讓寬度隨文字撐開，不要沿用原本的固定寬度。 */
/* width:auto 在 display:block 的按鈕上等於撐滿整列，會整個蓋住右側原本的「選項」，
   使用者點「選項」其實點到的是我們這一顆——所以寬度必須改成隨內容收縮。 */
[data-${PREFIX}-btn]{display:inline-flex !important;align-items:center !important;
  width:fit-content !important;min-width:0 !important;max-width:none !important;
  flex:0 0 auto !important;float:none !important;white-space:nowrap !important;
  transform:none !important}
[data-${PREFIX}-btn][data-${PREFIX}-on="1"]{background:#e8f0fe;border-radius:8px}
.${PREFIX}-wrap{font-family:inherit;display:flex;flex-direction:column;padding-top:8px}
.${PREFIX}-modal-back{position:fixed;inset:0;background:rgba(32,33,36,.45);z-index:2147483100;
  display:flex;align-items:center;justify-content:center}
.${PREFIX}-modal{background:#fff;border-radius:12px;padding:22px 24px;width:420px;max-width:92vw;
  box-shadow:0 12px 40px rgba(0,0,0,.3);font-family:inherit;color:#202124}
.${PREFIX}-mtitle{font-size:17px;font-weight:600;margin-bottom:4px}
.${PREFIX}-mdesc{font-size:12.5px;color:#5f6368;line-height:1.6;margin-bottom:18px}
.${PREFIX}-f{display:block;margin-bottom:16px}
.${PREFIX}-flabel{display:block;font-size:13px;font-weight:600;margin-bottom:2px}
.${PREFIX}-hint{display:block;font-size:11.5px;color:#80868b;margin-bottom:6px;line-height:1.5}
/* 膠囊形輸入框，右側嵌眼睛按鈕、以細分隔線隔開 */
.${PREFIX}-inwrap{display:flex;align-items:stretch;border:1px solid #dadce0;border-radius:8px;
  overflow:hidden;background:#fff}
.${PREFIX}-inwrap:focus-within{border-color:#1a73e8;box-shadow:0 0 0 1px #1a73e8}
.${PREFIX}-inwrap input{flex:1;border:0;outline:0;padding:9px 11px;font-size:13px;
  font-family:"SF Mono",Consolas,monospace;background:transparent;color:#202124;min-width:0}
.${PREFIX}-eye{border:0;border-left:1px solid #dadce0;background:transparent;cursor:pointer;
  padding:0 11px;color:#5f6368;display:flex;align-items:center}
.${PREFIX}-eye:hover{background:#f1f3f4;color:#202124}
.${PREFIX}-mact{display:flex;justify-content:flex-end;gap:8px;margin-top:20px}
.${PREFIX}-mbtn{border:0;background:transparent;color:#1a73e8;font-size:13px;font-weight:600;
  padding:8px 16px;border-radius:6px;cursor:pointer;font-family:inherit}
.${PREFIX}-mbtn:hover{background:#f1f3f4}
.${PREFIX}-mbtn.${PREFIX}-primary{background:#1a73e8;color:#fff}
.${PREFIX}-mbtn.${PREFIX}-primary:hover{background:#1765cc}
/* 標題列與分隔線都拿掉了，只留一點上方留白讓表格不要貼著上緣 */
/* scroll-padding-top 讓吸附時把黏在頂端的標頭高度算進去，
   否則列會被標頭切掉一半（就是「不完整的色塊」） */
/* scroll-padding 把「黏在頂端／左側」的標頭尺寸算進去，否則吸附後仍會被標頭切掉半格。
   橫向只保證左側切齊（右側視畫面寬度自然截斷，這是刻意取捨） */
/* overflow-anchor:none 關掉瀏覽器的捲動錨定——內容一有變動它就會自行調整捲動位置，
   跟 scroll-snap 疊在一起會互相打架、造成畫面亂跳 */
.${PREFIX}-scroll{overflow:auto;max-height:calc(100vh - 300px);overflow-anchor:none;
  scroll-snap-type:both proximity;
  scroll-padding-top:${HEADER_H_PX}px;scroll-padding-left:${ROWH_W_PX}px}
.${PREFIX}-msg{padding:14px 12px;font-size:13px;color:#3c4043;line-height:1.7;white-space:pre-wrap}
.${PREFIX}-msg b{color:#1a73e8}
/* 第一列必須明確給標頭的高度。只設 grid-auto-rows 的話，標頭那一列也只有
   PITCH_PX 高，而標頭本身是 HEADER_H_PX——溢出的部分會往下蓋住資料列，
   蓋掉的列數正好是 (HEADER_H_PX − PITCH_PX) ÷ PITCH_PX。
   實測 72px 標頭配 24px 節距，前兩列完全看不到。 */
.${PREFIX}-grid{display:grid;grid-template-rows:${HEADER_H_PX}px;
  grid-auto-rows:${PITCH_PX}px;width:max-content;
  grid-template-columns:${ROWH_W_PX}px repeat(var(--${PREFIX}-cols),${PITCH_PX}px)}
.${PREFIX}-corner{position:sticky;top:0;left:0;z-index:40;background:#fff;height:${HEADER_H_PX}px;
  border-bottom:1px solid #e8eaed;border-right:1px solid #e8eaed;
  display:flex;flex-direction:column;align-items:center;justify-content:center;gap:7px;
  padding:0 8px;box-sizing:border-box}
/* 地名擷取的進度。放在左上角那格——它本來就是空的，而且是 sticky，捲動時一直看得到 */
.${PREFIX}-prog{font-size:10.5px;color:#5f6368;line-height:1.45;text-align:center;white-space:nowrap}
.${PREFIX}-prog b{color:#1a73e8;font-weight:600}
.${PREFIX}-cnt b{color:#1a73e8;font-weight:600}
.${PREFIX}-cnt{font-size:11px;color:#3c4043;text-align:center;white-space:nowrap;
  font-variant-numeric:tabular-nums}
.${PREFIX}-bar{width:${ROWH_W_PX - 24}px;height:3px;border-radius:2px;background:#e8eaed;overflow:hidden}
.${PREFIX}-bar i{display:block;height:100%;background:#1a73e8;border-radius:2px;
  width:0;transition:width .2s ease}
/* 淡出只能套在「內容」上，絕不能套在格子本身。
   這一格是左側地名欄的遮罩：往下捲時地名會從它底下經過，
   靠它的白底擋住。若讓格子本身 opacity 歸零（而且用了 forwards 永久保持），
   遮罩就失效，地名會透出來跟時間軸並排——實測踩過。 */
.${PREFIX}-corner > *{transition:opacity .5s ease}
.${PREFIX}-corner.${PREFIX}-done > *{opacity:0}
/* 只吸附橫向（inline）。此元素縱向是 sticky，若連縱向也吸附，
   它的吸附區會永遠等於當下捲動位置，瀏覽器就不斷把 Y 軸對回它 → 一 hover 就跳回最上面 */
.${PREFIX}-h{position:sticky;top:0;z-index:20;background:#fff;height:${HEADER_H_PX}px;
  border-bottom:1px solid #e8eaed;scroll-snap-align:none start}
.${PREFIX}-h::before{content:"";position:absolute;left:0;right:0;top:${TIMELINE_AXIS_Y_PX}px;height:2px;background:#c7d9fb}
.${PREFIX}-h.${PREFIX}-first::before{left:50%}
.${PREFIX}-h.${PREFIX}-last::before{right:50%}
/* 整點欄疊在鄰欄之上，否則鄰欄的不透明白底會蓋掉圓圈外環，看起來像被裁切 */
.${PREFIX}-h.${PREFIX}-oclock{z-index:21}
.${PREFIX}-dot{position:absolute;top:${TIMELINE_AXIS_Y_PX}px;left:50%;transform:translate(-50%,-50%);
  width:7px;height:7px;border-radius:50%;background:#a9c2e8;box-shadow:0 0 0 3px #fff;
  transition:transform .08s,background .08s}
.${PREFIX}-hour{position:absolute;top:${TIMELINE_AXIS_Y_PX}px;left:50%;transform:translate(-50%,-50%);
  width:${HOUR_DOT_PX}px;height:${HOUR_DOT_PX}px;border-radius:50%;background:#1a73e8;color:#fff;
  font-size:10px;font-weight:700;display:flex;align-items:center;justify-content:center;
  box-shadow:0 0 0 2px #fff;transition:box-shadow .08s,transform .08s}
.${PREFIX}-h.${PREFIX}-hl{z-index:30}
.${PREFIX}-h.${PREFIX}-hl .${PREFIX}-dot{background:#1a73e8;transform:translate(-50%,-50%) scale(1.9)}
.${PREFIX}-h.${PREFIX}-hl .${PREFIX}-hour{transform:translate(-50%,-50%) scale(1.15);
  box-shadow:0 0 0 2px #fff,0 0 0 5px rgba(26,115,232,.42)}
/* 用 visibility 而非 display 切換：display 會改變版面，一改就觸發回流，
   scroll-snap 隨即重新對位——這正是「滑鼠一離開表格就跳回最上面」的來源。
   visibility 不影響版面，切換時不會回流。 */
/* 距離要算 hover 放大後的尺寸：圓放大 1.15 倍再加 5px 光暈，底緣在軸心 +16.5px。
   原本設 +16，標籤的白底正好切掉光暈最下緣。 */
.${PREFIX}-tl{position:absolute;top:${TIMELINE_AXIS_Y_PX + 22}px;left:50%;transform:translateX(-50%);
  font-size:11px;font-weight:700;color:#1a73e8;white-space:nowrap;background:#fff;
  padding:1px 4px;border-radius:3px;visibility:hidden}
.${PREFIX}-h.${PREFIX}-hl .${PREFIX}-tl{visibility:visible}
/* 列標頭：不透明白底＋往左延伸的陰影，避免捲動時內容從左緣露出來 */
/* 只吸附縱向（block）。橫向是 sticky，理由同上 */
.${PREFIX}-rh{position:sticky;left:0;z-index:10;background:#fff;scroll-snap-align:start none;
  display:flex;align-items:center;
  justify-content:flex-end;padding-right:8px;font-size:12px;white-space:nowrap;
  border-right:1px solid #e8eaed;transition:background .08s;gap:6px;
  box-shadow:-20px 0 0 #fff}
.${PREFIX}-rh.${PREFIX}-hl{background:#e8f0fe;box-shadow:-20px 0 0 #e8f0fe}
.${PREFIX}-rh .${PREFIX}-t{font-weight:600;color:#202124}
/* 使用者自己規劃的位置（出發／停靠／抵達）用顏色區分，不加標籤佔空間 */
.${PREFIX}-t.${PREFIX}-key{color:#1a73e8}
/* 固定寬度＋等寬數字：hover 時整欄標籤要在「+504分」與「05:19」之間切換，
   寬度只要有變化就會觸發回流，捲動錨定與 scroll-snap 會跟著重新對位，
   表現出來就是「滑鼠移回表格時整個跳到最上面」。寬度鎖死才不會回流。 */
.${PREFIX}-rh .${PREFIX}-m{color:#80868b;font-size:11px;text-align:right;
  width:46px;flex:0 0 46px;font-variant-numeric:tabular-nums}
.${PREFIX}-rh.${PREFIX}-hl .${PREFIX}-m{color:#1a73e8;font-weight:700}
.${PREFIX}-d{display:flex;align-items:center;justify-content:center}
.${PREFIX}-c{width:${CELL_PX}px;height:${CELL_PX}px;border-radius:2px;cursor:pointer;display:block}
.${PREFIX}-c.${PREFIX}-na{background:repeating-linear-gradient(45deg,#f1f3f4 0 4px,#e0e3e6 4px 8px)}
/* 說明區接在格線正下方、同一個捲動流（不另外開捲軸）；
   sticky left 讓它橫向捲動時始終貼齊左側地點欄，不會被推出畫面 */
.${PREFIX}-info{position:sticky;left:0;width:max-content;max-width:${INFO_MAX_W_PX}px;
  padding:12px 12px 16px;border-top:1px solid #e8eaed;background:#fff}
.${PREFIX}-legend{display:flex;flex-direction:column;gap:6px;font-size:12px;color:#3c4043}
.${PREFIX}-legend div{display:flex;align-items:center}
.${PREFIX}-legend span.${PREFIX}-sw{width:18px;height:18px;border-radius:3px;display:inline-block;
  margin-right:8px;flex:0 0 auto}
.${PREFIX}-scale{display:flex;align-items:center;gap:2px;padding-bottom:10px;font-size:11px;color:#5f6368}
.${PREFIX}-scale i{width:16px;height:14px;display:inline-block}
.${PREFIX}-ttl{font-size:14px;font-weight:600;color:#fff;line-height:1.35;margin-bottom:2px}
/* 標籤放在名稱左側，字級與名稱相同（14px）——同級才夠醒目 */
.${PREFIX}-ttl em{display:inline-block;margin-right:8px;padding:1px 9px;border-radius:11px;
  background:rgba(138,180,248,.25);color:#aecbfa;font-size:14px;font-style:normal;
  font-weight:600;white-space:nowrap}
/* 行政區是次要資訊：字小一級、亮度降下來，才有主次之分 */
.${PREFIX}-sub{font-size:11.5px;color:rgba(255,255,255,.62);line-height:1.4;margin-bottom:6px}
.${PREFIX}-tip{position:fixed;z-index:2147483000;pointer-events:none;display:none;background:#202124;
  color:#fff;border-radius:8px;padding:9px 12px;font-size:12px;line-height:1.6;
  box-shadow:0 6px 20px rgba(0,0,0,.25);max-width:280px}
.${PREFIX}-tip .${PREFIX}-k{color:#9aa0a6;display:inline-block;min-width:60px}
.${PREFIX}-note{font-size:11.5px;color:#80868b;padding-top:10px;line-height:1.7}
.${PREFIX}-note div{margin-bottom:3px}
.${PREFIX}-warn{color:#c5221f;font-weight:600}
`;
        const el = document.createElement('style');
        el.id = PREFIX + '-style';
        el.textContent = css + rules.join('\n');
        document.head.appendChild(el);
    }

    // ════════════════════════════════════════════════════════════════
    // 按鈕注入
    // ════════════════════════════════════════════════════════════════


    /**
     * 放置按鈕。
     *
     * 關鍵限制：不能把按鈕插進 Google 自己管理的容器裡。
     * 診斷證據——按「選項」時，事件路徑是
     *   div.BunUDe > button.OcYctc > div.MlqQ3d > …
     * 路徑裡完全沒有我們的按鈕，但 currentTarget 卻等於我們的按鈕。
     * 兩者同時成立只有一種解釋：<b>我們插進去的那個 &lt;button&gt; 被 Google 的渲染器接管了</b>。
     * 它重繪那一列時看到多出來的子節點，不是移除，而是「就地重用」——
     * 把 class、屬性、內容全部改寫成它預期的「選項」按鈕，
     * 但 DOM 節點本身沒換，所以我們掛上去的事件監聽器還留著。
     * 於是那顆按鈕外觀與行為都變成「選項」，點下去卻執行我們的 toggle；
     * 我們的 data-rr-btn 屬性也被一併抹掉，難怪先前怎麼查都查不到重疊或重複。
     *
     * 因此改成：按鈕掛在 document.body、用 fixed 定位貼齊「選項」左側，
     * 完全不進入 Google 的渲染範圍，它就無從接管。代價是位置要自己維護。
     */
    /**
     * 沿祖先鏈往上找第一個「真正不透明」的背景色。
     * 直接用 getComputedStyle(el).backgroundColor 有個陷阱：多數容器是 rgba(0,0,0,0)，
     * 那是一個非空字串，`|| '#fff'` 這種保護擋不住——「有值」不等於「不透明」。
     * 蓋住底下的「選項」需要真正不透明的底色，否則文字會透出來，看起來就像按鈕沒出現。
     */
    function resolveOpaqueBackground(el) {
        for (let n = el; n && n !== document.documentElement; n = n.parentElement) {
            const bg = getComputedStyle(n).backgroundColor;
            if (!bg) continue;
            const m = bg.match(/rgba?\(([^)]+)\)/);
            if (!m) continue;
            const parts = m[1].split(',').map(s => parseFloat(s));
            const alpha = parts.length > 3 ? parts[3] : 1;
            if (alpha > 0.95) return bg;
        }
        return '#fff';
    }

    function positionButton(btn, optionsBtn) {
        const r = optionsBtn.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) {
            btn.style.setProperty('display', 'none', 'important');
            return;
        }
        btn.style.setProperty('display', 'inline-flex', 'important');
        btn.style.setProperty('top', Math.round(r.top) + 'px', 'important');
        btn.style.setProperty('height', Math.round(r.height) + 'px', 'important');
        if (state.active) {
            // 開啟後沒有其他選項可按，按鈕改成「關閉」並移到「選項」的位置蓋住它，
            // 行為與 Google 自己的面板一致（按下去展開、原位變成關閉）
            // 文字比「選項」長，若沿用它的左緣會往右溢出面板；
            // 改成對齊右緣、往左延伸，剛好把「選項」整個蓋住
            btn.style.setProperty('min-width', Math.round(r.width) + 'px', 'important');
            btn.style.setProperty('left',
                Math.round(r.right - Math.max(btn.offsetWidth, r.width)) + 'px', 'important');
            btn.style.setProperty('background', state.panelBg || '#fff', 'important');
            log('關閉按鈕定位：left=', Math.round(r.left), 'top=', Math.round(r.top),
                'w>=', Math.round(r.width), '底色=', state.panelBg);
        } else {
            btn.style.removeProperty('min-width');
            btn.style.setProperty('background', 'transparent', 'important');
            btn.style.setProperty('left',
                Math.round(r.left - btn.offsetWidth - BUTTON_GAP_PX) + 'px', 'important');
        }
    }

    /**
     * 以「選項」按鈕為範本，做出一顆樣式完全一致的按鈕。
     *
     * 直接沿用它的 class——class 帶著全部樣式，包含 hover、圓角、字色字重，
     * 不必逐項抄屬性，也不必去掃樣式表找 :hover 規則。三顆按鈕
     * （旅途中的雨／關閉／面板內的關閉）都用同一個範本，外觀自然一致。
     *
     * 先前不敢複製，是因為早期用 cloneNode 出過問題；但那次的真因是
     * 「插進 Google 的渲染範圍而被就地重用」，不是複製本身。
     * 現在按鈕掛在 body、又把 class 以外的屬性全部剝掉，複製結構是安全的。
     */
    function buildFromTemplate(referenceBtn, label) {
        const el = referenceBtn.cloneNode(true);
        // 只留 class：jsaction／jslog／aria-*／id 等一律移除，避免帶著別人的行為與識別
        const strip = n => {
            [...n.attributes].forEach(a => { if (a.name !== 'class') n.removeAttribute(a.name); });
        };
        strip(el);
        el.querySelectorAll('*').forEach(strip);

        // 清掉所有文字節點，再把新文字放進原本承載文字的那一層
        const refText = referenceBtn.textContent.trim();
        const holder = [...el.querySelectorAll('*')].reverse()
            .find(x => x.textContent.trim() === refText) || el;
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        const textNodes = [];
        while (walker.nextNode()) textNodes.push(walker.currentNode);
        textNodes.forEach(n => { n.textContent = ''; });
        holder.insertBefore(document.createTextNode(label), holder.firstChild);

        el.type = 'button';
        el.setAttribute('aria-label', label);
        return el;
    }

    function ensureButton() {
        const optionsBtn = findOptionsButton();
        let btn = document.querySelector('[data-' + PREFIX + '-btn]');

        if (!optionsBtn) {
            if (btn) btn.style.setProperty('display', 'none', 'important');
            return false;
        }
        if (!btn) {
            btn = buildFromTemplate(optionsBtn, BUTTON_LABEL);
            btn.setAttribute('data-' + PREFIX + '-btn', '1');
            // 沿用了對方的 class，就可能連帶吃到它帶 !important 的定位或顯示規則。
            // 行內樣式若不加 !important 會輸給那些規則，按鈕就跑到看不見的地方。
            // 這幾項是「按鈕能不能被看到」的關鍵，一律用 important 鎖死。
            [
                ['position', 'fixed'], ['z-index', '2147483000'],
                ['display', 'inline-flex'], ['align-items', 'center'],
                ['visibility', 'visible'], ['opacity', '1'],
                ['margin', '0'], ['transform', 'none'], ['float', 'none'],
                ['inset', 'auto'], ['pointer-events', 'auto'],
            ].forEach(([k, v]) => btn.style.setProperty(k, v, 'important'));

            btn.addEventListener('click', ev => {
                ev.preventDefault();
                ev.stopPropagation();
                toggle('注入按鈕');
            }, true);

            document.body.appendChild(btn);
            log('按鈕已建立（沿用「選項」的 class）並掛在 document.body，避開 Google 的渲染範圍');
        }
        // 文字要更新時，改的是承載文字的那一層，不是整顆按鈕的 textContent
        setButtonLabel(btn, state.active ? CLOSE_LABEL : BUTTON_LABEL);
        positionButton(btn, optionsBtn);
        const br = btn.getBoundingClientRect();
        const cs = getComputedStyle(btn);
        log('按鈕狀態：文字=', JSON.stringify(btn.textContent.trim()),
            '｜rect=', Math.round(br.x) + ',' + Math.round(br.y),
            Math.round(br.width) + 'x' + Math.round(br.height),
            '｜position=', cs.position, 'display=', cs.display,
            'visibility=', cs.visibility, 'opacity=', cs.opacity,
            '｜在 body 底下=', btn.parentElement === document.body,
            '｜視窗=', innerWidth + 'x' + innerHeight);
        return true;
    }

    /** 只換文字、不動結構——直接改 textContent 會把內層的樣式節點一起清掉 */
    function setButtonLabel(btn, label) {
        const walker = document.createTreeWalker(btn, NodeFilter.SHOW_TEXT);
        let first = null;
        const rest = [];
        while (walker.nextNode()) {
            if (!first) first = walker.currentNode; else rest.push(walker.currentNode);
        }
        if (first) { first.textContent = label; rest.forEach(n => { n.textContent = ''; }); }
        else btn.appendChild(document.createTextNode(label));
        btn.setAttribute('aria-label', label);
    }

    // ════════════════════════════════════════════════════════════════
    // 面板切換
    // ════════════════════════════════════════════════════════════════

    function toggle(source) {
        log('toggle 被呼叫，來源=', source || '未標示', '目前狀態=', state.active ? '開啟' : '關閉');
        if (state.active) { deactivate(); return; }
        activate();
    }

    /**
     * 隱藏「灰線以下」的所有區塊。
     * 用結構判斷而非比對 class：找出「選項」那一列，把它之後的兄弟節點全部隱藏，
     * 這樣不管 Google 之後再加什麼區塊都會一併蓋掉（例如「探索附近的地點」）。
     *
     * 必須可重複呼叫：點擊格子會改寫網址並送出 popstate，Google 的路由收到後
     * 會重新渲染整個面板、建立<strong>新的</strong>元素——我們當初設在舊元素上的
     * display:none 對新元素無效，被隱藏的區塊就會重新冒出來把表格往下擠。
     * 因此面板每次變動都要重新套用一次。
     */
    /**
     * 路線的簽章：停靠站與控制點的座標序列，加上交通方式。
     *
     * 不用整段 data= 字串比對——那會把「跟路線無關的變動」也算成換了路線。
     * 實測：點一下地圖上的景點，Google 會導覽到該地點頁面，網址從 /maps/dir/
     * 變成 /maps/place/、data= 也多出名稱與該景點的段落，但**路線完全沒變**。
     * 拿字串比就會判定成換了路線而重算，然後因為解析不到而顯示錯誤，
     * 把原本正常的表格洗掉。
     *
     * 改看路線本身之後，視野位移、網址尾巴多出參數、切換到地點檢視，
     * 全都不會誤觸重算——只有真的改了起訖、停靠站、拖曳路徑或交通方式才會。
     */
    function routeSignature(href) {
        const parsed = parseRouteFromUrl(href);
        if (!parsed || !parsed.points.length) return '';
        return parsed.points
            .map(p => `${p.kind}:${p.lat.toFixed(6)},${p.lon.toFixed(6)}`)
            .join('|') + '|3e' + (parsed.urlTravelCode || '');
    }

    /** 開著表格時偵測到路線改變（例如切換交通方式）就重跑一次 */
    function scheduleRerunIfRouteChanged() {
        if (!state.active || !state.container) return;
        const key = routeSignature(location.href);
        if (!key || key === state.lastRouteKey) return;
        log('偵測到路線改變，重新計算表格');
        state.lastRouteKey = key;
        clearTimeout(state.rerunTimer);
        // 切換交通方式時網址可能連續變動幾次，等安定下來再跑，避免重複請求
        state.rerunTimer = setTimeout(() => {
            if (!state.active || !state.container) return;
            clearBody(state.container);
            run(state.container).catch(err => {
                warn(err);
                clearBody(state.container);
                showMessage(state.container, '出錯了：' + err.message);
            });
        }, ROUTE_CHANGE_DEBOUNCE_MS);
    }

    function applyHiding(panel) {
        const optionsBtn = findOptionsButton();
        const optionsRow = optionsBtn
            ? [...panel.children].find(ch => ch.contains(optionsBtn))
            : null;
        if (!optionsRow) { warn('找不到「選項」那一列，無法判斷要隱藏哪些區塊'); return; }
        const kids = [...panel.children];
        const startIdx = kids.indexOf(optionsRow) + 1;
        for (let i = startIdx; i < kids.length; i++) {
            const el = kids[i];
            if (el === state.container) continue;                 // 我們自己的內容不能藏
            if (state.hiddenBlocks.some(h => h.el === el)) {       // 已記錄過就只補上隱藏
                el.style.display = 'none';
                continue;
            }
            state.hiddenBlocks.push({ el, display: el.style.display });
            el.style.display = 'none';
        }
    }

    function deactivate() {
        if (state.optionsClickHandler) {
            document.removeEventListener('click', state.optionsClickHandler, true);
            state.optionsClickHandler = null;
        }
        const btn = document.querySelector('[data-' + PREFIX + '-btn]');
        if (btn) btn.removeAttribute('data-' + PREFIX + '-on');
        state.hiddenBlocks.forEach(({ el, display }) => { el.style.display = display; });
        state.hiddenBlocks = [];
        if (state.container) { state.container.remove(); state.container = null; }
        const panel = findPanel();
        if (panel && state.originalPanelWidth !== undefined) {
            panel.style.width = state.originalPanelWidth;
        }
        const tip = document.getElementById(PREFIX + '-tip');
        if (tip) tip.remove();
        state.active = false;
        ensureButton();
        log('已關閉');
    }

    function activate() {
        injectStyle();
        const panel = findPanel();
        if (!panel) { alert('找不到路線面板，請先在 Google Maps 規劃好路線。'); return; }

        state.lastRouteKey = routeSignature(location.href);
        state.hiddenBlocks = [];
        applyHiding(panel);
        // 先前會把面板加寬到固定寬度，但實測加寬只影響某一層容器、
        // 表格顯示寬度沒有跟著變，反而把靠右對齊的「選項」推到畫面中央，
        // 連帶讓貼著它定位的關閉按鈕也跑掉。第一版先不動寬度，用橫向捲動即可。
        state.originalPanelWidth = panel.style.width;

        const wrap = document.createElement('div');
        wrap.className = PREFIX + '-wrap';
        wrap.id = PREFIX + '-wrap';

        panel.appendChild(wrap);
        state.container = wrap;
        state.active = true;
        state.panelBg = resolveOpaqueBackground(panel);
        const btn = document.querySelector('[data-' + PREFIX + '-btn]');
        if (btn) btn.setAttribute('data-' + PREFIX + '-on', '1');
        ensureButton();

        // Google 的「選項」面板就展開在灰線以下，而那整段正是我們啟用時隱藏掉的範圍。
        // 若不處理，使用者按「選項」會覺得「沒反應／還是我們的表格」——其實面板開了、只是被藏著。
        // 因此偵測到點擊原本的「選項」時，先把我們的表格收起來，把版面還給它。
        state.optionsClickHandler = ev => {
            const target = ev.target;
            if (!target || !target.closest) return;
            const btnEl = target.closest('button');
            if (!btnEl || btnEl.hasAttribute('data-' + PREFIX + '-btn')) return;
            if (btnEl.textContent.trim() !== SITE_SELECTORS.optionsButtonText) return;
            log('偵測到點擊原本的「選項」，先收起表格把版面讓出來');
            deactivate();
        };
        document.addEventListener('click', state.optionsClickHandler, true);

        run(wrap).catch(err => {
            warn(err);
            clearBody(wrap);
            showMessage(wrap, '出錯了：' + err.message);
        });
    }

    function clearBody(wrap) {
        wrap.innerHTML = '';
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
        if (!keys.cwa) {
            showMessage(wrap,
                '還沒設定中央氣象署授權碼。<br><br>' +
                '到 opendata.cwa.gov.tw 免費註冊即可取得，格式為 <b>CWA-…</b><br>' +
                '路線資料直接取自頁面，不需要 Google 金鑰。<br><br>' +
                '授權碼只會存在你自己的瀏覽器裡，不會出現在腳本原始碼中。<br><br>' +
                '請從 Tampermonkey 選單的「設定 API 金鑰」填入，或按下方按鈕。');
            const openBtn = document.createElement('button');
            openBtn.className = PREFIX + '-mbtn ' + PREFIX + '-primary';
            openBtn.textContent = '開啟金鑰設定';
            openBtn.style.margin = '0 12px';
            openBtn.addEventListener('click', () => { injectStyle(); openSettings(); });
            wrap.appendChild(openBtn);
            return;
        }

        // 中間各階段統一顯示「處理中」，唯獨向氣象署取資料時換成專屬訊息——
        // 這樣畫面上出現那行字，就等於「這次真的動用了氣象署 API」，可以直接用來判斷有沒有走快取
        showMessage(wrap, '處理中…');
        const parsed = parseRouteFromUrl(location.href);
        if (!parsed || parsed.points.length < 2) {
            clearBody(wrap);
            showMessage(wrap, '從網址讀不到路線。請確認已經規劃好路線（網址裡要有 <code>/data=</code> 那一段）。');
            return;
        }
        const panel = findPanel();
        const selected = readSelectedRoute(panel);
        const modeInfo = detectTravelMode(parsed.urlTravelCode);
        log('網址解析：停靠站/控制點共', parsed.points.length, '個；選中路線', selected);
        if (modeInfo.mode === null) {
            clearBody(wrap);
            showMessage(wrap, `目前選的交通方式（<b>${modeInfo.label || '未知'}</b>）` +
                'Routes API 不支援，無法計算沿途座標與時間。<br><br>' +
                '可用的有：開車、機車、單車、步行、大眾運輸。');
            return;
        }

        clearBody(wrap);
        showMessage(wrap, '處理中…');
        if (!state.capturedDirections) {
            clearBody(wrap);
            showMessage(wrap,
                '還沒攔截到這個頁面的路線資料。\n\n' +
                '本工具直接讀取 Google Maps 自己算好的路線，不另外呼叫 API，' +
                '因此必須在頁面載入時就在場。\n\n' +
                '請重新整理頁面後再按一次；若剛安裝或更新腳本，也需要重新整理。');
            return;
        }
        const alts = parseDirections(state.capturedDirections.text)
            .filter(a => a.points.length > 1 && a.steps.length > 0);
        if (!alts.length) {
            clearBody(wrap);
            showMessage(wrap, '攔截到的路線資料裡沒有可用的路線，請重新整理頁面後再試。');
            return;
        }
        const picked = pickAlternative(alts, selected);
        const alt = picked.alt;

        state.routePoints = alt.points;   // 供計算安全按下點
        const { timeline, steps, totalSec } = buildTimeline(alt);
        if (!timeline.length) throw new Error('Routes API 回傳的路徑沒有可用的座標');
        // 起點、使用者設定的停靠點、目的地——這三類是使用者自己規劃的位置，
        // 一定要出現在表格裡，不能因為「取中點」而被略過
        const names = readEndpointNames();
        if (names.length) {
            log('面板讀到的地點名稱：', names.join(' ／ '));
        } else {
            log('讀不到地點名稱。頁面上所有可見輸入框：',
                [...document.querySelectorAll('input')]
                    .filter(el => el.offsetParent !== null)
                    .map(el => {
                        const r = el.getBoundingClientRect();
                        return `[${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}x` +
                            `${Math.round(r.height)}] "${(el.value || '').slice(0, 20)}"`;
                    }).join('　') || '（一個都沒有）');
        }
        const anchors = [{ sec: 0, kind: 'origin', name: names[0] || null }];
        // 中途停靠站取自網址：kind==='stop' 才是使用者加的停靠點，
        // 'via' 是拖曳路線產生的控制點，不算。首尾兩個 stop 是起點與目的地，排除。
        const stops = parsed.points.filter(p => p.kind === 'stop').slice(1, -1);
        stops.forEach((s, i) => {
            const sec = nearestSecOnTimeline(timeline, s.lat, s.lon);
            if (sec !== null) anchors.push({ sec, kind: 'waypoint', name: names[i + 1] || null });
        });
        // 時間軸已在 buildTimeline 拉伸對齊，終點即為總時程
        anchors.push({
            sec: totalSec, kind: 'destination',
            name: names.length > 1 ? names[names.length - 1] : null,
        });
        const nodes = buildNodes(timeline, totalSec, anchors);
        const snap = snapToGoogleNodes(nodes, timeline, steps, nodes.townAt);
        if (snap.snapped || snap.removed) {
            log('吸附到 Google 節點：', snap.snapped, '個中途節點改用 Google 的節點' +
                (snap.removed ? `，並移除 ${snap.removed} 個重複` : ''));
        }
        if (!nodes.length) {
            clearBody(wrap);
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
            clearBody(wrap);
            showMessage(wrap, '這條路線的行程時間超過預報可涵蓋的範圍（' +
                FORECAST_HORIZON_HOURS + ' 小時），無法產生表格。');
            return;
        }

        clearBody(wrap);
        const lastArrive = new Date(departures[departures.length - 1].getTime() + totalSec * 1000);
        const { forecast, failures, callCount, fetchedAt, fromCache } =
            await getForecast(keys.cwa, nodes,
                () => { clearBody(wrap); showMessage(wrap, '正在向中央氣象署取得降雨預報…'); });

        log('即將繪製的前 3 列：', nodes.slice(0, 3).map(n =>
            `+${Math.round(n.sec / 60)}分 ${n.county || '?'}${n.town || '?'}` +
            `${n.kind ? '[' + n.kind + ']' : ''}`).join('　│　'),
            '／總列數', nodes.length);
        clearBody(wrap);
        render(wrap, {
            nodes, departures, forecast, totalSec,
            meta: {
                matchNote: picked.matchNote,
                routeDistanceMeters: alt.totalMeters,
                capturedAt: state.capturedDirections.at,
                mode: modeInfo,
                selected,
                callCount,
                failures,
                fetchedAt,
                fromCache,
                altCount: alts.length,
            },
        });

        // 表格先出現，地點名稱在背景陸續補上——36 個節點要十幾秒，
        // 讓使用者盯著「處理中」等那麼久沒有必要。名稱是寫進節點物件的，
        // tooltip 下次開啟時自然會拿到新值，不需要重繪整張表。
        const corner = document.getElementById(PREFIX + '-corner');
        if (corner) {
            corner.innerHTML =
                `<span class="${PREFIX}-prog">地名擷取中</span>` +
                `<span class="${PREFIX}-cnt"><b>0</b> / ${nodes.length}</span>` +
                `<span class="${PREFIX}-bar"><i></i></span>`;
        }
        fillPlaceNames(nodes, (done, total) => {
            if (!corner || !corner.isConnected) return;
            const num = corner.querySelector('.' + PREFIX + '-cnt b');
            const bar = corner.querySelector('.' + PREFIX + '-bar i');
            if (num) num.textContent = String(done);
            if (bar) bar.style.width = Math.round(done / total * 100) + '%';
            if (done >= total) {
                const p = corner.querySelector('.' + PREFIX + '-prog');
                const cnt = corner.querySelector('.' + PREFIX + '-cnt');
                if (p) p.textContent = '地名已就緒';
                if (cnt) cnt.remove();
                corner.classList.add(PREFIX + '-done');
                setTimeout(() => {
                    if (!corner.isConnected) return;
                    corner.innerHTML = '';
                    corner.classList.remove(PREFIX + '-done');   // 不留殘留狀態
                }, 1300);
            }
        }).catch(err => warn('地點名稱查詢失敗：', err.message));

    }

    // ════════════════════════════════════════════════════════════════
    // 呈現
    // ════════════════════════════════════════════════════════════════

    // 判斷「交通方式是否搞錯」要用距離而不是時間：
    // 我們沒有指定 routingPreference，拿到的是不含即時路況的時間；
    // 面板顯示的則是含路況的時間，開車在尖峰時段差 25% 以上很正常，那不是錯誤。
    // 距離不受路況影響，交通方式若判斷錯（例如把步行算成開車）距離一定也會差很多。
    const DISTANCE_MISMATCH_RATIO = 0.25;      // 距離相對誤差超過此值 → 判定交通方式可能錯誤
    const DURATION_MISMATCH_RATIO = 0.25;      // 距離吻合但時間差超過此值 → 提示路況差異，不是錯誤

    const pad2 = n => String(n).padStart(2, '0');
    const clockOf = d => pad2(d.getHours()) + ':' + pad2(d.getMinutes());

    function render(wrap, data) {
        const { nodes, departures, forecast, totalSec, meta } = data;

        // 捲動容器只包格線；色階、圖例、備註放在容器外，才不會跟著資料一起捲走
        const scroll = document.createElement('div');
        scroll.className = PREFIX + '-scroll';

        const grid = document.createElement('div');
        grid.className = PREFIX + '-grid';
        grid.style.setProperty('--' + PREFIX + '-cols', String(departures.length));

        const parts = ['<div class="' + PREFIX + '-corner" id="' + PREFIX + '-corner"></div>'];
        departures.forEach((d, i) => {
            const isHour = d.getMinutes() === 0;
            const cls = [PREFIX + '-h'];
            if (isHour) cls.push(PREFIX + '-oclock');
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
                `<span class="${PREFIX}-t${n.kind ? ' ' + PREFIX + '-key' : ''}">` +
                `${(n.county || '') + (n.town || '（未知區域）')}</span></div>`);
            for (let ci = 0; ci < departures.length; ci++) {
                const whenMs = departures[ci].getTime() + n.sec * 1000;
                const row = lookupForecast(forecast, n.town, whenMs);
                let cls;
                if (!row || row.pop == null) {
                    cls = `${PREFIX}-c ${PREFIX}-na`;
                } else {
                    const pop = Math.round(row.pop / 10) * 10;
                    const sev = severityOf(row.weather, row.code);
                    cls = `${PREFIX}-c ${PREFIX}-s${sev}-${pop}`;
                }
                parts.push(
                    `<div class="${PREFIX}-d"><span class="${cls}" ` +
                    `data-${PREFIX}-r="${ri}" data-${PREFIX}-c="${ci}"></span></div>`);
            }
        });
        grid.innerHTML = parts.join('');
        scroll.appendChild(grid);

        const info = document.createElement('div');
        info.className = PREFIX + '-info';

        const scale = document.createElement('div');
        scale.className = PREFIX + '-scale';
        scale.innerHTML = '降雨機率 ' +
            Object.keys(PALETTE).map(p => `<i style="background:${PALETTE[p][0]}"></i>`).join('') +
            ' 0→100%';
        info.appendChild(scale);

        const legend = document.createElement('div');
        legend.className = PREFIX + '-legend';
        legend.innerHTML =
            `<div><span class="${PREFIX}-sw" style="background:${PALETTE[60][0]}"></span>不會下雨的天氣型態</div>` +
            `<div><span class="${PREFIX}-sw" style="background:${PALETTE[60][1]}"></span>有可能（局部／短暫／或）</div>` +
            `<div><span class="${PREFIX}-sw" style="background:${PALETTE[60][2]}"></span>基本上會遇到／雷雨・雪</div>`;
        info.appendChild(legend);

        const note = document.createElement('div');
        note.className = PREFIX + '-note';
        const lines = [
            `節點 ${nodes.length} 個`,
            `涵蓋 ${new Set(nodes.map(n => n.county + n.town)).size} 個鄉鎮`,
            `總行程 ${Math.round(totalSec / 60)} 分`,
            `路徑資料：取自頁面本身（${Math.round((Date.now() - meta.capturedAt) / 1000)} 秒前攔截），未呼叫任何 API`,
            meta.fromCache
                ? `氣象資料：沿用快取（${Math.round((Date.now() - meta.fetchedAt) / 60000)} 分鐘前取得）`
                : `氣象資料：本次重新取得，呼叫 ${meta.callCount} 次`,
            `交通方式 ${meta.mode.mode}（判斷依據：${meta.mode.via}）`,
            `路線比對：${meta.matchNote}`,
        ];
        // 安全網：先用距離判斷交通方式有沒有搞錯（距離不受路況影響），
        // 距離吻合才進一步看時間差，而時間差多半只是「含不含即時路況」的差異。
        const shownDist = meta.selected && meta.selected.distanceMeters;
        const shownDur = meta.selected && meta.selected.durationSec;
        let distMismatch = false;
        if (shownDist && meta.routeDistanceMeters) {
            const diff = Math.abs(meta.routeDistanceMeters - shownDist) / shownDist;
            if (diff > DISTANCE_MISMATCH_RATIO) {
                distMismatch = true;
                lines.push(`<span class="${PREFIX}-warn">⚠ 面板顯示 ${meta.selected.distanceText}，` +
                    `但算出來是 ${(meta.routeDistanceMeters / 1000).toFixed(1)} 公里` +
                    `（差 ${Math.round(diff * 100)}%）——交通方式或路線可能判斷錯誤，` +
                    `這張表的抵達時刻不可信。</span>`);
            }
        }
        if (!distMismatch && shownDur) {
            const diff = Math.abs(totalSec - shownDur) / shownDur;
            if (diff > DURATION_MISMATCH_RATIO) {
                lines.push(`面板時間「${meta.selected.durationText}」含即時路況；` +
                    `本表以無路況時間 ${Math.round(totalSec / 60)} 分計算，抵達時刻可能偏早。`);
            }
        }
        if (meta.failures && meta.failures.length) {
            lines.push(`<span class="${PREFIX}-warn">取得失敗：${meta.failures.join('、')}</span>`);
        }
        note.innerHTML = lines.map(l => `<div>${l}</div>`).join('');
        info.appendChild(note);
        // 資訊區放進捲動容器、接在格線之後，才不會多出一條獨立捲軸
        scroll.appendChild(info);
        wrap.appendChild(scroll);

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
                // 顯示順序：使用者自己設的名稱 ＞ Google 反向地理編碼 ＞ 鄉鎮名。
                // 第二行照 Google 彈窗的排法放行政區；查不到才退回導航指示的路名。
                // 照 Google 彈窗的排法：主名稱大而亮、行政區小而暗，拉開主次
                (() => {
                    // 面板輸入框的內容是「名稱＋地址」連在一起（例如
                    // 「乾華十八王公廟 253新北市石門區乾華里阿里磅1-1號」），
                    // 直接整串當標題會又長又擠，還把標籤推到第二行。
                    // 以郵遞區號為界拆開：前段當主名稱、後段當地址。
                    let title, addr = '';
                    if (n.placeName) {
                        // 只在「名稱 空白 郵遞區號…」這種形式才拆。
                        // 像「住家（103臺北市…）」的地址是包在括號裡的別名，
                        // 拆了會變成「住家（」這種殘缺的標題。
                        const m = /[（(]/.test(n.placeName)
                            ? null
                            : n.placeName.match(/^(.+?)\s+(\d{3}\s*[\u4e00-\u9fa5]{2,3}[市縣].*)$/);
                        if (m) { title = m[1].trim(); addr = m[2].trim(); }
                        else { title = n.placeName; addr = (n.county || '') + (n.town || ''); }
                    } else if (n.place && n.place.title) {
                        title = n.place.title;
                        addr = n.place.area || '';
                    } else {
                        title = (n.county || '') + (n.town || '（未知區域）');
                        addr = n.road ? n.road + (n.roadBorrowed ? '（附近）' : '') : '';
                    }
                    return `<div class="${PREFIX}-ttl">` +
                        (n.kind ? `<em>${KIND_LABEL[n.kind]}</em>` : '') + title + '</div>' +
                        (addr ? `<div class="${PREFIX}-sub">${addr}</div>` : '');
                })() +
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

    // ── 把地圖視野移到指定座標 ──
    //
    // 為什麼不用改網址：實測發現 Google 是「把內部狀態寫進網址」，不是從網址讀視野。
    // 我們改了網址，它的路由發現與內部狀態不一致，隨即改回去——網址是結果不是輸入。
    // 也找不到可呼叫的地圖物件（window 上沒有任何具備 panTo/setCenter 的東西，
    // google.maps 也不存在）。可行的是對畫布送出滑鼠事件模擬拖曳，實測有效。

    /** 回傳最大的那張地圖畫布「元素」——呼叫端會直接對它取尺寸與派送事件 */
    function findMapCanvas() {
        const best = [...document.querySelectorAll('canvas')]
            .map(el => ({ el, r: el.getBoundingClientRect() }))
            .filter(o => o.r.width > 200 && o.r.height > 200)
            .sort((a, b) => b.r.width * b.r.height - a.r.width * a.r.height)[0];
        return best ? best.el : null;
    }

    /** 從網址讀出目前視野。Google 會把視野寫進網址，所以這是可靠的來源 */
    function readViewport() {
        const m = location.href.match(/\/@(-?[\d.]+),(-?[\d.]+),([\d.]+)z/);
        if (!m) return null;
        return { lat: +m[1], lon: +m[2], zoom: +m[3] };
    }

    /** Web Mercator：經緯度 → 世界像素座標 */
    function projectToPixel(lat, lon, zoom) {
        const world = 256 * Math.pow(2, zoom);
        const x = (lon + 180) / 360 * world;
        const s = Math.sin(lat * Math.PI / 180);
        const y = (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * world;
        return { x, y };
    }

    /** Web Mercator 反投影：世界像素座標 → 經緯度。維護自有視野模型時需要 */
    function unprojectFromPixel(x, y, zoom) {
        const world = 256 * Math.pow(2, zoom);
        const lon = x / world * 360 - 180;
        const n = Math.PI - 2 * Math.PI * y / world;
        const lat = 180 / Math.PI * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
        return { lat, lon };
    }

    /**
     * 自有的視野模型。
     *
     * 為什麼不每一步都讀網址：網址更新是非同步的，每次都要輪詢等它反映，
     * 實測那些等待佔掉整段動畫 31% 的時間，而且畫面在等待期間完全靜止——
     * 那正是「一段一段、不連續」的來源。
     *
     * 我們自己知道送了幾個滾輪事件、拖了幾像素，可以直接推算新的視野，
     * 讓各階段無縫接續。累積的誤差在最後統一校正一次即可。
     */
    function makeViewModel(vp) {
        return {
            lat: vp.lat, lon: vp.lon, zoom: vp.zoom,
            /** 縮放以畫面中心為錨點，中心座標不變 */
            applyZoom(delta) { this.zoom += delta; },
            /** 拖曳 (dx, dy) 像素：地圖跟著游標走，等於中心往反方向移動 */
            applyPan(dx, dy) {
                const p = projectToPixel(this.lat, this.lon, this.zoom);
                const n = unprojectFromPixel(p.x - dx, p.y - dy, this.zoom);
                this.lat = n.lat; this.lon = n.lon;
            },
            /** 目標相對於畫面中心的像素位移 */
            offsetTo(lat, lon) {
                const c = projectToPixel(this.lat, this.lon, this.zoom);
                const t = projectToPixel(lat, lon, this.zoom);
                return { dx: c.x - t.x, dy: c.y - t.y };
            },
        };
    }

    function dispatchPointer(target, type, x, y, buttons) {
        // 必須用網頁環境的建構子。沙箱建立的事件派送到網頁元素上，
        // 網頁的監聽器不一定認得（Firefox 的沙箱有 Xray 隔離）——
        // 先前在 Console 測試成功卻在腳本裡無效，就是這個差別造成的。
        const w = pageWindow();
        const PE = w.PointerEvent || PointerEvent;
        const ME = w.MouseEvent || MouseEvent;
        const init = {
            bubbles: true, cancelable: true, composed: true, view: w,
            clientX: x, clientY: y, screenX: x, screenY: y,
            button: 0, buttons: buttons,
            pointerId: 1, pointerType: 'mouse', isPrimary: true,
        };
        // pointer 與 mouse 兩套都送：不同實作監聽的種類不同
        target.dispatchEvent(new PE(type, init));
        target.dispatchEvent(new ME(type.replace('pointer', 'mouse'), init));
    }

    // ── 動畫基礎 ──

    const wait = ms => new Promise(r => setTimeout(r, ms));


    /** easeInOutCubic：起步加速、中段快、結尾減速。結尾速度趨近零，慣性問題自然消失 */
    const easeInOutCubic = t => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

    /**
     * 以 requestAnimationFrame 逐影格執行動畫。
     * 不用 setInterval：它跟螢幕更新不同步，會累積誤差與掉影格，
     * rAF 才是與更新節奏對齊的標準做法。
     */
    function animate(durationMs, onFrame) {
        return new Promise(resolve => {
            const t0 = performance.now();
            const tick = (now) => {
                const raw = Math.min(1, (now - t0) / durationMs);
                onFrame(easeInOutCubic(raw), raw);
                if (raw < 1) requestAnimationFrame(tick);
                else resolve();
            };
            requestAnimationFrame(tick);
        });
    }

    /**
     * 一次連續的拖曳手勢：只按下一次、放開一次，中間持續送 move。
     * 先前每段拖曳都是完整手勢，地圖每次獨立結算慣性，才會有段落感與甩飛。
     */
    /** 動作結束後會自行等待視野反映，呼叫端不必處理（理由同 smoothZoom） */
    async function smoothPan(canvas, dx, dy, durationMs, origin) {
        const keyBefore = viewportKey();
        const r = canvas.getBoundingClientRect();
        const cx = origin ? origin.x : r.left + r.width / 2;
        const cy = origin ? origin.y : r.top + r.height / 2;
        dispatchPointer(canvas, 'pointerdown', cx, cy, 1);
        await animate(durationMs, (e) => {
            dispatchPointer(canvas, 'pointermove', cx + dx * e, cy + dy * e, 1);
        });
        // 結尾速度已趨近零（緩動的效果），直接放開不會觸發慣性滑行
        dispatchPointer(canvas, 'pointerup', cx + dx, cy + dy, 0);
        lastSettled = await waitViewportSettled(keyBefore);
    }

    /**
     * 滾輪縮放。
     *
     * 以固定 50ms 間隔送出事件，不用 requestAnimationFrame——實測 16ms 間隔
     * （rAF 的節奏）會讓所有事件被整批忽略，一級都不動。這正是先前
     * 「zoomError=5、縮放完全沒發生」的原因。
     *
     * 滾輪本身的縮放是連續的（會產生 17.6z 這種非整數層級），所以即使不是
     * 逐影格送，視覺上仍然是平滑推近，不像縮放按鈕那樣一級一級跳。
     * 另外它以游標位置為錨點，在畫布中心送出就不會帶偏中心。
     */
    /**
     * @returns 實際套用的縮放量。動作結束後會自行等待視野反映，呼叫端不必處理。
     */
    async function smoothZoom(canvas, deltaZoom) {
        if (Math.abs(deltaZoom) < WHEEL_ZOOM_PER_EVENT / 2) return 0;
        // 自己取動作前的 key。先前由呼叫端傳入，只要傳到舊的 key，
        // waitViewportSettled 的第一段就會立刻通過而退化成會誤判的版本——
        // 實測因此重複拉近、衝到 18.82 級。包進來就不可能配錯。
        const keyBefore = viewportKey();
        const r = canvas.getBoundingClientRect();
        const cx = r.left + r.width / 2;
        const cy = r.top + r.height / 2;
        const w = pageWindow();
        const WE = w.WheelEvent || WheelEvent;
        const events = Math.max(1, Math.round(Math.abs(deltaZoom) / WHEEL_ZOOM_PER_EVENT));
        const sign = deltaZoom > 0 ? -1 : 1;      // deltaY 為負代表放大
        for (let i = 0; i < events; i++) {
            canvas.dispatchEvent(new WE('wheel', {
                bubbles: true, cancelable: true, composed: true, view: w,
                clientX: cx, clientY: cy, deltaY: sign * 120, deltaMode: 0,
            }));
            await wait(WHEEL_INTERVAL_MS);
        }
        lastSettled = await waitViewportSettled(keyBefore);
        return events * WHEEL_ZOOM_PER_EVENT * (deltaZoom > 0 ? 1 : -1);
    }

    /**
     * 挑一個按下點，同時滿足兩個條件：
     *   ① 離路線夠遠——從路線上按下拖曳會被判定成「拖曳路線新增途經點」，
     *      實際改動使用者原本的規劃（實測看過控制點數從 0 變 1）。
     *      不必猜它的判定容差，我們手上就有路線座標，直接算。
     *   ② 讓這次的位移放得下——游標不能拖出畫布，所以要往反方向按下：
     *      要往左拖就從右側按下。這樣單次行程從 0.4 個畫面提高到約 0.6，
     *      需要先拉遠的級數也跟著減少。
     */
    function findPressPoint(canvas, dx, dy) {
        const r = canvas.getBoundingClientRect();
        const M = PRESS_EDGE_MARGIN_PX;
        // 按下點必須讓「按下點 + 位移」仍落在畫布內
        const minX = Math.max(r.left + M, r.left + M - dx);
        const maxX = Math.min(r.right - M, r.right - M - dx);
        const minY = Math.max(r.top + M, r.top + M - dy);
        const maxY = Math.min(r.bottom - M, r.bottom - M - dy);
        const centre = { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
        if (minX > maxX || minY > maxY) return centre;   // 位移超過可用行程，先回中點

        const vp = readViewport();
        const pts = state.routePoints;
        if (!vp || !pts || !pts.length) return centre;

        // 把路線投影到螢幕（取樣即可，判斷遠近不需要每一點）
        const cc = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        const cp = projectToPixel(vp.lat, vp.lon, vp.zoom);
        const screen = [];
        const stride = Math.max(1, Math.floor(pts.length / 300));
        for (let i = 0; i < pts.length; i += stride) {
            const p = projectToPixel(pts[i][0], pts[i][1], vp.zoom);
            screen.push({ x: cc.x + (p.x - cp.x), y: cc.y + (p.y - cp.y) });
        }

        let best = centre, bestDist = -1;
        for (let fx = 0; fx <= 1.0001; fx += 0.25) {
            for (let fy = 0; fy <= 1.0001; fy += 0.25) {
                const cand = { x: minX + (maxX - minX) * fx, y: minY + (maxY - minY) * fy };
                let min = Infinity;
                for (const s of screen) {
                    const d = Math.hypot(s.x - cand.x, s.y - cand.y);
                    if (d < min) min = d;
                    if (min < SAFE_PRESS_MIN_PX) break;
                }
                if (min > bestDist) { bestDist = min; best = cand; }
            }
        }
        return { x: best.x, y: best.y, distToRoute: bestDist };
    }

    const viewportKey = () => (location.href.match(/\/@[^/]+/) || [''])[0];

    // 最近一次動作有沒有等到視野反映。由 smoothZoom／smoothPan 自行設定，
    // 診斷時讀它即可，不必在每個呼叫點各自處理等待。
    let lastSettled = true;

    /**
     * 等到視野「確實變過、而且已經停下來」。
     *
     * 上一版只判斷「連續兩次讀到相同」，那是錯的：網址還沒開始更新時，
     * 連續兩次讀到的也都是舊值，於是誤判為已停穩，把尚未更新的舊值當成真實值。
     * 實測後果：模型明明算對了（11.04），卻被舊值 12 覆蓋，
     * 之後每一步都用錯的層級換算，誤差一路發散到 48 公里。
     *
     * 正確順序是兩段：先等它跟動作前不一樣（確認已反映），再等它不再變（確認已停）。
     *
     * @param prevKey 動作之前的視野字串，用來確認「真的變過了」
     * @returns true=確實變過且停穩；false=逾時（可能沒動，或延遲超過上限）
     */
    async function waitViewportSettled(prevKey) {
        const t0 = Date.now();
        // 第一段：等它跟動作前不同
        let changed = false;
        while (Date.now() - t0 < SETTLE_TIMEOUT_MS) {
            if (viewportKey() !== prevKey) { changed = true; break; }
            await wait(SETTLE_POLL_MS);
        }
        if (!changed) return false;
        // 第二段：等它停止變動
        let last = null;
        while (Date.now() - t0 < SETTLE_TIMEOUT_MS) {
            const key = viewportKey();
            if (key === last) return true;
            last = key;
            await wait(SETTLE_POLL_MS);
        }
        return false;
    }

    /** 目前視野下，目標相對於畫面中心的像素位移 */
    function offsetToTarget(lat, lon) {
        const vp = readViewport();
        if (!vp) return null;
        const c = projectToPixel(vp.lat, vp.lon, vp.zoom);
        const t = projectToPixel(lat, lon, vp.zoom);
        return { dx: c.x - t.x, dy: c.y - t.y, zoom: vp.zoom };
    }

    /** 整段動畫結束後才校正，而且只在誤差夠大時才動——這是流暢度的關鍵取捨 */
    /**
     * 最後校正：等視野真的停穩，量實際誤差，超過門檻就修，修完再量。
     * 迴圈直到到位或次數用盡——這是「結果一定要對」的保證。
     */
    /**
     * 最後校正：等視野確實反映出動作結果，量實際誤差，超過門檻才修，修完再量。
     *
     */
    /**
     * 最後校正：確保結果一定是對的。
     *
     * 關鍵前提是**先讓縮放到位再量位置**。像素距離會隨縮放層級改變，
     * 在還沒縮放完的狀態下量到的數字，跟縮放完之後的數字不能相比——
     * 實測踩過：同一個誤差在 zoom 11.04 量到 727px、在 15.83 量到 20109px，
     * 收斂保護就誤判成「越修越糟」而停手，其實誤差根本沒變。
     *
     */
    async function correctIfNeeded(canvas, lat, lon) {
        // ── 第一步：確認縮放到位，不到就補 ──
        // 動作本身已經等過視野反映，這裡直接讀值即可
        let settled = lastSettled;
        for (let z = 0; z < 3; z++) {
            const vp = readViewport();
            if (!vp) break;
            const diff = MAP_FOCUS_ZOOM - vp.zoom;
            if (Math.abs(diff) <= ZOOM_TOLERANCE) break;
            writeDiag({ step: 'zoom-fix', round: z, realZoom: vp.zoom, need: +diff.toFixed(2) });
            await smoothZoom(canvas, diff);
            settled = lastSettled;
        }

        // ── 第二步：縮放已固定，此時的像素距離才可以互相比較 ──
        let dist = null;
        let lastDist = Infinity;
        let lastApplied = Infinity;
        for (let i = 0; i < PAN_MAX_ITERATIONS; i++) {
            const off = offsetToTarget(lat, lon);
            if (!off) return dist;
            dist = Math.hypot(off.dx, off.dy);
            writeDiag({ step: 'correct', round: i, settled,
                zoom: off.zoom, distPx: Math.round(dist) });
            if (dist <= PAN_TOLERANCE_PX) return dist;      // 已經到位

            if (i > 0) {
                // 這次拖曳「能夠」貢獻的量：要嘛是整段誤差，要嘛被單次上限夾住
                const couldFix = Math.min(lastApplied, lastDist);
                const improved = lastDist - dist;
                if (improved < couldFix * CONVERGE_MIN_EFFECT) {
                    // 改善停滯。此時才判斷是「小到修不動的抖動」還是「真的有問題」
                    writeDiag({ step: 'correct-stall', round: i,
                        distPx: Math.round(dist), improvedPx: Math.round(improved),
                        couldFixPx: Math.round(couldFix),
                        verdict: dist <= DEAD_ZONE_PX ? '抖動，接受' : '無法收斂' });
                    return dist;
                }
            }
            lastDist = dist;

            const r = canvas.getBoundingClientRect();
            const dx = Math.max(-r.width * DRAG_MAX_SCREENS,
                Math.min(r.width * DRAG_MAX_SCREENS, off.dx));
            const dy = Math.max(-r.height * DRAG_MAX_SCREENS,
                Math.min(r.height * DRAG_MAX_SCREENS, off.dy));
            lastApplied = Math.hypot(dx, dy);
            await smoothPan(canvas, dx, dy, PAN_MIN_MS, findPressPoint(canvas, dx, dy));
            settled = lastSettled;
        }
        const off = offsetToTarget(lat, lon);
        return off ? Math.hypot(off.dx, off.dy) : dist;
    }

    /**
     * 已經夠接近就什麼都不做。
     *
     * 沒有這道判斷的話，反覆點同一個節點會在兩個位置之間來回橫跳：
     * 每次都為了幾十像素的誤差再拖一次，而那次拖曳自己又留下差不多的誤差。
     * 對使用者來說那就是「程式有問題」，而不是「更精確」。
     */
    function withinDeadZone(lat, lon) {
        const vp = readViewport();
        if (!vp) return false;
        if (Math.abs(vp.zoom - MAP_FOCUS_ZOOM) > 0.3) return false;   // 縮放層級還不對
        const off = offsetToTarget(lat, lon);
        return off ? Math.hypot(off.dx, off.dy) <= DEAD_ZONE_PX : false;
    }

    async function focusMapOn(lat, lon) {
        if (withinDeadZone(lat, lon)) {
            writeDiag({ step: 'skip', reason: '已在死區內，不動作' });
            log('已經夠接近目標，不動作');
            return;
        }
        const canvas = findMapCanvas();
        const vp0 = readViewport();
        if (!canvas || !vp0) {
            writeDiag({ step: 'abort', reason: !canvas ? '找不到畫布' : '讀不到視野' });
            return;
        }
        const r = canvas.getBoundingClientRect();
        const limX = r.width * DRAG_MAX_SCREENS;
        const limY = r.height * DRAG_MAX_SCREENS;

        // 全程以自有模型推算，不在階段之間讀網址——那些等待會讓畫面靜止，
        // 是「一段一段」感受的主因。誤差留到最後統一校正。
        const model = makeViewModel(vp0);
        const off0 = model.offsetTo(lat, lon);
        const screens = Math.max(Math.abs(off0.dx) / r.width, Math.abs(off0.dy) / r.height);
        const panMs = Math.min(PAN_MAX_MS, PAN_MIN_MS + screens * PAN_MS_PER_SCREEN);

        // ① 太遠先拉遠，拉到剛好塞得進一次手勢即可——多拉一級就多一次圖磚重載
        const arcOut = screens > DRAG_MAX_SCREENS
            ? Math.min(ARC_MAX_ZOOM_OUT,
                Math.ceil(Math.log2(screens / DRAG_MAX_SCREENS)),
                Math.max(0, Math.floor(vp0.zoom - MIN_WORK_ZOOM)))
            : 0;
        writeDiag({ step: 'plan', from: [vp0.lat, vp0.lon, vp0.zoom],
            target: [+lat.toFixed(5), +lon.toFixed(5)],
            screens: +screens.toFixed(2), arcOut, panMs: Math.round(panMs) });

        if (arcOut > 0) {
            const applied = await smoothZoom(canvas, -arcOut);
            model.applyZoom(applied);
            // smoothZoom 內部已等到視野反映，這裡的讀值可以安全採用
            const vpAfterZoom = readViewport();
            if (lastSettled && vpAfterZoom) {
                // 此時的讀值已確認反映了動作，可以安全地校準模型
                model.lat = vpAfterZoom.lat;
                model.lon = vpAfterZoom.lon;
                model.zoom = vpAfterZoom.zoom;
            }
            writeDiag({ step: 'after-arc-out', settled: lastSettled,
                modelZoom: +model.zoom.toFixed(2),
                realZoom: vpAfterZoom ? vpAfterZoom.zoom : null });
        }

        // ② 平移。位移在「拉遠後的層級」重新算——用舊層級會差十幾倍。
        //
        //    最後一輪之後一定要驗證實際位置：**殘留誤差會被接下來的拉近放大 2^N 倍**
        //    （拉近 5 級＝32 倍）。在低縮放層級修，同樣的角度誤差只對應少少的像素，
        //    一次就修得完；等到拉近後才發現，就得拖好幾次而且每次上限只有 0.6 個畫面。
        let pans = 0;
        let lastDist = Infinity;
        let lastApplied = Infinity;
        for (let i = 0; i < PAN_MAX_ITERATIONS; i++) {
            const off = model.offsetTo(lat, lon);
            const dist = Math.hypot(off.dx, off.dy);
            if (dist <= PAN_TOLERANCE_PX) break;
            if (i > 0) {
                // 停滯判斷同樣看「改善量 vs 該次拖曳量」，不用固定比例——
                // 拖曳有上限，誤差比上限大時本來就只能一次減少一個上限的量
                const couldFix = Math.min(lastApplied, lastDist);
                const improved = lastDist - dist;
                if (improved < couldFix * CONVERGE_MIN_EFFECT) {
                    writeDiag({ step: 'pan-stall', round: i,
                        distPx: Math.round(dist), improvedPx: Math.round(improved),
                        couldFixPx: Math.round(couldFix) });
                    break;
                }
            }
            lastDist = dist;
            const dx = Math.max(-limX, Math.min(limX, off.dx));
            const dy = Math.max(-limY, Math.min(limY, off.dy));
            lastApplied = Math.hypot(dx, dy);
            pans++;
            await smoothPan(canvas, dx, dy, i === 0 ? panMs : PAN_MIN_MS,
                findPressPoint(canvas, dx, dy));
            model.applyPan(dx, dy);
            // 平移後的殘留會被接下來的拉近放大 2^N 倍，所以要確認實際位置
            const vpAfterPan = readViewport();
            if (lastSettled && vpAfterPan) {
                model.lat = vpAfterPan.lat;
                model.lon = vpAfterPan.lon;
                model.zoom = vpAfterPan.zoom;
            }
            writeDiag({ step: 'after-pan', round: i, settled: lastSettled,
                remainPx: Math.round(Math.hypot(
                    model.offsetTo(lat, lon).dx, model.offsetTo(lat, lon).dy)) });
        }

        // ③ 拉近到目標層級（滾輪錨定畫面中心，目標會留在原地）。
        //    這裡一定要就地等它跑完：縮放動畫進行中網址不會更新，
        //    若留到後面才用「整段開始前」的舊 key 去等，第一段比對會立刻通過，
        //    退化成「連續兩次讀到相同」而誤判停穩——實測因此重複拉近、衝到 18.82 級。
        const applied = await smoothZoom(canvas, MAP_FOCUS_ZOOM - model.zoom);
        model.applyZoom(applied);
        writeDiag({ step: 'after-zoom-in', settled: lastSettled,
            modelZoom: +model.zoom.toFixed(2),
            realZoom: (readViewport() || {}).zoom });

        // ④ 動畫全部結束後才讀真實視野、校正累積誤差。
        //    只在這裡等一次，而不是每個階段都等。
        const finalDist = await correctIfNeeded(canvas, lat, lon);
        const vpEnd = readViewport();
        writeDiag({
            step: 'done', target: [+lat.toFixed(5), +lon.toFixed(5)],
            screens: +screens.toFixed(2), arcZoomOut: arcOut, pans,
            modelZoom: +model.zoom.toFixed(2), realZoom: vpEnd ? vpEnd.zoom : null,
            finalDistPx: finalDist === null ? null : Math.round(finalDist),
            errorKm: vpEnd ? +(haversine(vpEnd.lat, vpEnd.lon, lat, lon) / 1000).toFixed(3) : null,
        });
    }

    /**
     * 把診斷寫進 DOM 屬性。
     * 沙箱腳本的 console 輸出在網頁主控台看不到（實測完全沒有任何一行），
     * 但 DOM 是沙箱與網頁共用的，這樣就能從網頁環境讀到腳本的內部狀態。
     * 讀法：document.documentElement.dataset.rrDiag
     */
    function writeDiag(obj) {
        try {
            const prev = document.documentElement.getAttribute('data-' + PREFIX + '-log') || '';
            document.documentElement.setAttribute('data-' + PREFIX + '-log',
                (prev + '\n' + JSON.stringify(obj)).slice(-4000));
            document.documentElement.setAttribute('data-' + PREFIX + '-diag',
                JSON.stringify({ t: new Date().toLocaleTimeString(), ...obj }));
        } catch (err) { /* 診斷失敗不影響功能 */ }
    }

    function routeCtrlCount() {
        return ((location.href.match(/\/data=([^?]+)/) || [''])[1].match(/3m4/g) || []).length;
    }

    /**
     * 在畫面中心按一下，讓 Google 顯示它自己的地點資訊卡。
     *
     * 定位結束後目標就在畫面正中央，而節點本來就落在路線上，
     * 所以中心點必定命中路線。單擊是「顯示這個點的資訊」，
     * 與拖曳（會新增途經點）是不同的操作，不會改動路線。
     */
    /**
     * 算出節點實際落在螢幕上的哪一點。
     *
     * 不用畫面中心：地圖偏 15px，那一點就離節點 15px，在 zoom 17 約 16 公尺——
     * 沿路走這段距離可能已經過了路口、換了門牌；節點若在轉彎處，
     * 甚至會落到轉彎後的另一段路上。節點的螢幕位置是算得出來的
     * （最終視野＋節點座標），精度是次像素等級。
     */
    function nodeScreenPoint(canvas, lat, lon) {
        const r = canvas.getBoundingClientRect();
        const off = offsetToTarget(lat, lon);
        let x = r.left + r.width / 2;
        let y = r.top + r.height / 2;
        if (off) { x -= off.dx; y -= off.dy; }
        const M = 4;                                    // 夾在畫布內，避免定位嚴重失敗時落到畫布外
        return {
            x: Math.max(r.left + M, Math.min(r.right - M, x)),
            y: Math.max(r.top + M, Math.min(r.bottom - M, y)),
        };
    }

    /**
     * 只把游標移到節點位置，不點擊——用於使用者自己指定的位置。
     *
     * 那些點在地圖上有 Google 自己的標記，正確的互動方式是「懸停」：
     * 移過去它就會自己冒出資訊卡。點下去反而會觸發它自己的行為
     * （縮放到 17、顯示轉彎卡，或導覽到該地點頁面）。
     *
     * 注意：合成事件不會移動實體游標，只是把事件交給網頁，
     * 所以表格的 tooltip 不會因此關閉——那是預期行為，不是失敗。
     */
    async function hoverOnMap(canvas, lat, lon) {
        const { x, y } = nodeScreenPoint(canvas, lat, lon);
        dispatchPointer(canvas, 'pointermove', x, y, 0);
        await wait(HOVER_SETTLE_MS);
        dispatchPointer(canvas, 'pointermove', x, y, 0);   // 再送一次，確保判定跑完
        writeDiag({ step: 'hover', at: [Math.round(x), Math.round(y)] });
    }

    async function revealOnMap(canvas, lat, lon) {
        const r = canvas.getBoundingClientRect();
        //
        // 點中心等於要求定位必須完美：地圖偏 15px，那一點就離節點 15px，
        // 在 zoom 16 約 32 公尺——沿路走 32 公尺可能已經過了路口、換了門牌，
        // 若節點正好在轉彎處，甚至會落到轉彎後的另一段路上。
        // 而節點的螢幕位置是算得出來的（最終視野＋節點座標），精度是次像素等級，
        // 這樣就把「定位精度」與「點擊精度」解耦，定位的容差也不必為此收緊。
        const { x, y } = nodeScreenPoint(canvas, lat, lon);
        const off = offsetToTarget(lat, lon);
        const before = routeCtrlCount();

        // 點擊之前一定要先「把游標移過去」。
        //
        // Google 的命中判定是在滑鼠移動時做的，結果記在內部狀態裡，
        // 後續的點擊是拿那個狀態決定「點到了什麼」。
        // 我們的流程是「拖曳（一連串 move）→ 縮放（沒有 move）→ 直接按下」，
        // 所以它記著的還是拖曳結束時那個位置的判定結果，
        // 而地圖在那之後又縮放了好幾級，該螢幕位置早已不對應路線——
        // 於是點擊有送出、卻什麼都沒選到。
        //
        // 症狀上看得見：路線上那個「懸停指示點」停在舊位置不動，
        // 縮放後就跑到道路外面去了。
        dispatchPointer(canvas, 'pointermove', x, y, 0);
        await wait(HOVER_SETTLE_MS);
        dispatchPointer(canvas, 'pointermove', x, y, 0);   // 再送一次，確保判定跑完
        await wait(HOVER_SETTLE_MS);

        dispatchPointer(canvas, 'pointerdown', x, y, 1);
        await wait(60);                     // 停頓一下，避免被當成拖曳的起手
        dispatchPointer(canvas, 'pointerup', x, y, 0);
        const w = pageWindow();
        const ME = w.MouseEvent || MouseEvent;
        canvas.dispatchEvent(new ME('click', {
            bubbles: true, cancelable: true, composed: true, view: w,
            clientX: x, clientY: y, button: 0, buttons: 0, detail: 1,
        }));
        await wait(500);
        const after = routeCtrlCount();
        writeDiag({ step: 'reveal-click',
            at: [Math.round(x), Math.round(y)],
            offsetFromCentre: off ? [Math.round(-off.dx), Math.round(-off.dy)] : null,
            ctrlBefore: before, ctrlAfter: after });
        if (after !== before) warn('點擊地圖後途經點數改變了', before, '→', after);
    }

    function onNodeClick(node) {
        document.documentElement.removeAttribute('data-' + PREFIX + '-log');   // 每次點擊重新記錄
        const ctrlBefore = routeCtrlCount();
        const w = pageWindow();
        const canvas = findMapCanvas();
        const vp = readViewport();
        writeDiag({
            step: 'click',
            node: node.county + node.town,
            lat: +node.lat.toFixed(5), lon: +node.lon.toFixed(5),
            env: w === window ? 'sandbox' : 'unsafeWindow',
            hasUnsafeWindow: typeof unsafeWindow !== 'undefined',
            viewport: vp,
            canvas: canvas
                ? Math.round(canvas.getBoundingClientRect().width) + 'x' +
                  Math.round(canvas.getBoundingClientRect().height)
                : null,
            hasPointerEvent: !!(w && w.PointerEvent),
        });
        log('點擊節點', node.county + node.town);
        focusMapOn(node.lat, node.lon).then(async () => {
            const canvas = findMapCanvas();
            // 讓 Google 秀出該點的資訊卡；點在節點的實際螢幕位置，不是畫面中心。
            //
            // 起點／停靠／目的地不點：那是使用者指定的位置，在地圖上多半有
            // Google 自己的標記（甚至本身就是景點），點下去會觸發它自己的行為——
            // 導覽到該地點頁面，把路線檢視換掉。而且那三類的名稱使用者本來就設定了，
            // 我們已經顯示在 tooltip 上，不需要再查。
            if (!canvas) {
                // 沒有畫布就什麼都不做
            } else if (node.kind || node.isGoogleNode) {
                // 這兩類都是 Google 自己的節點（使用者指定的位置、或吸附過去的行車動作點），
                // 正確的互動是懸停——移過去它就會冒出自己的資訊卡；
                // 點下去反而會觸發它自己的行為（縮放、轉彎卡、或導覽到該地點頁面）
                await hoverOnMap(canvas, node.lat, node.lon);
                log('Google 節點，只做懸停不點擊：',
                    node.kind ? KIND_LABEL[node.kind] : '行車動作點');
            } else {
                await revealOnMap(canvas, node.lat, node.lon);
            }
            const after = routeCtrlCount();
            if (after !== ctrlBefore) {
                // 破壞性副作用：模擬拖曳被判定成「拖曳路線新增途經點」
                writeDiag({ step: 'route-modified', before: ctrlBefore, after });
                warn('警告：定位過程改動了路線的途經點', ctrlBefore, '→', after);
            }
        }).catch(err => {
            writeDiag({ step: 'error', message: err.message });
            warn('定位失敗：', err.message);
        });
    }

    // ════════════════════════════════════════════════════════════════
    // 啟動與重新注入
    // Google Maps 是 SPA：切換路線、改交通方式、拖曳路徑都會重繪面板，
    // 注入的按鈕會被銷毀，所以要持續監看並重新注入（注入前先檢查是否已存在）。
    // ════════════════════════════════════════════════════════════════

    function boot() {
        ensureButton();

        // 按鈕不在 Google 的渲染範圍內，所以不會再被它接管；
        // 但因為改用 fixed 定位，位置要自己跟著版面變動更新。
        let pending = false;
        const schedule = () => {
            if (pending) return;
            pending = true;
            requestAnimationFrame(() => {
                pending = false;
                ensureButton();
                if (!state.active) return;
                const panel = findPanel();
                if (!panel) return;
                // 重繪會產生新的區塊，要重新隱藏；我們的內容若被移除也要放回去
                if (state.container && state.container.parentElement !== panel) {
                    panel.appendChild(state.container);
                }
                applyHiding(panel);
                scheduleRerunIfRouteChanged();
            });
        };
        new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true });
        window.addEventListener('resize', schedule);
        window.addEventListener('scroll', schedule, true);

        // Google Maps 是 SPA，換路線只改網址不重新載入頁面。
        // MutationObserver 多半也會被觸發，但直接監看網址變化比較直接可靠：
        // popstate 只涵蓋上一頁/下一頁，程式主動改網址用的是 pushState/replaceState，
        // 那兩個不會發事件，必須自己包一層。
        window.addEventListener('popstate', schedule);
        ['pushState', 'replaceState'].forEach(name => {
            const orig = history[name];
            history[name] = function (...args) {
                const ret = orig.apply(this, args);
                schedule();
                return ret;
            };
        });
        log('啟動完成');
    }

    // 攔截器必須最先架好——實測「直接開啟已規劃好的網址」時，
    // directions 請求在頁面載入的最初期（0.00s）就發出，晚一步就錯過。
    armInterceptors();

    // UI 則要等 DOM 有東西可以掛才啟動
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot);
    } else {
        boot();
    }
})();
