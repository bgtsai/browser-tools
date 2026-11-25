// ==UserScript==
// @name         Route Rain — 路線降雨預報
// @namespace    https://github.com/bgtsai/browser-tools
// @version      1.5.1
// @description  在 Google Maps 路線畫面底部加一個時間軸面板，顯示沿途各點在不同出發時間下的降雨機率
// @author       bgtsai
// @match        https://www.google.com/maps*
// @icon         https://www.google.com/maps/about/images/icons/maps_512dp.png
// @connect      opendata.cwa.gov.tw
// @connect      raw.githubusercontent.com
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

    // @match 用 /maps* 而不是 /maps/*：後者要求路徑必須以「/maps/」開頭（含斜線），
    // 因此 https://www.google.com/maps 與 .../maps?entry=… 都不會注入。
    // 而「先開 Google Maps、再規劃路線」的起點常常正是這兩種——
    // 一開始沒被注入，後面再怎麼改網址都沒用，因為 SPA 不會重新載入頁面，
    // @match 只在載入時判斷一次。

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

    // 底部時間軸面板（v1.0.0 介面重構；數值照 mockup v3，1512×888 視窗 1:1）
    // 96 欄要一次放下：欄距 13（色塊 12＋間距 1）× 96 ＝ 1248，加地點欄 140 ＝ 1388，
    // 1512 寬的視窗扣掉右側 64 還有 1448，放得下。
    const PANEL_RIGHT_GAP_PX = 64;             // 右側讓出給 Google 的縮放鈕與街景小人
    const PANEL_TITLE_H_PX = 40;               // 標題列高度（收合時整個面板只剩這麼高）
    const PANEL_DEFAULT_H_PX = 288;            // 使用者還沒拖拉過時的面板高度
    const PANEL_MAP_MIN_PX = 80;               // 拖拉上限：面板上方至少留這麼多地圖
    const PANEL_MIN_ROWS = 3;                  // 拖拉下限：至少看得到這麼多列
    const CELL_PX = 12;                        // 色塊邊長
    const COL_PITCH_PX = 13;                   // 每欄節距（色塊＋1px 間距）
    const ROW_PITCH_PX = 16;                   // 每列節距
    const LABEL_W_PX = 140;                    // 左側地點欄寬度（sticky）
    const LABEL_TIME_W_PX = 36;                // 地點欄裡時間的固定寬度，靠右對齊才排得整齊
    // 標頭各層的 y。整點圓 18、15 分小點 4 都是偶數，軸線也取 2px，
    // 圓心才會落在線的正中、而且左右也對得上 12px 色塊的中心（03 第④節奇偶數原則）。
    // mockup 的軸線 1px、小點 3px 會落在半像素，這裡各加 1px。
    const PIN_Y_PX = 1;                        // 已釘住那一欄的 ▼
    const SUM_Y_PX = 12;                       // 「沿路最濕」摘要條
    const SUM_H_PX = 8;
    const AXIS_Y_PX = 34;                      // 時間軸線（2px 高，中心在 35）
    const HOUR_DOT_PX = 20;                    // 整點圓（含白圈；18 時兩位數字只剩約 14 px 寬太擠）
    const HOUR_RING_PX = 2;                    // 整點圓外的白圈
    const QUARTER_DOT_PX = 4;                  // 15 分小點
    const HEAD_H_PX = 52;                      // 標頭總高（sticky）
    const GRID_BOTTOM_PAD_PX = 8;              // 最後一列下方的留白
    const COLBOX_PAD_PX = 2;                   // 欄框比色塊每邊多出的寬度

    // 地圖上的路線色帶：每段外框用該級的外框色（v1.5.0 起不再墊 Google 藍外框，
    // 新配色最淺級有自己的外框色）。疊在 Google 路線上，蓋住它才不會兩條線並排。
    const RIBBON_W_PX = 10;                    // 填色寬
    // 外框寬（每邊露出 2px）。必須蓋得住底下 Google 的路線：15 級實測 Google 線約 12 px
    // （深邊 2＋填色 7～8＋深邊 2），10 px 時兩側會露深藍；再留每邊 1 px 給投影偏移 → 14（使用者看比較頁定的）
    const RIBBON_FRAME_W_PX = 14;
    const RIBBON_BLEND_PX = 36;                // 兩級交界前後共這麼長（螢幕 px）逐漸變色，不硬接
    const RIBBON_PIECE_PX = 3;                 // 交界漸變區切成這麼長的小段各自上色
    // 光暈：色帶下墊一層模糊的寬線，顏色用同色系第 3 級填色（最深那級才像發光、不像陰影）。
    // 強度跟雨勢走：第 1～4 級不透明度依序，使用者定「最強到 0.6，其他依次降」
    const RIBBON_GLOW_EXTRA_PX = 10;           // 光暈比外框寬這麼多
    const RIBBON_GLOW_BLUR_PX = 5;             // feGaussianBlur 的 stdDeviation
    const RIBBON_GLOW_ALPHA = [0.15, 0.3, 0.45, 0.6];
    // S1 掃描線：色帶上固定不動的橫向細線（每 SCAN_PITCH_PX 一條、高 1px）
    const RIBBON_SCAN_PITCH_PX = 3;
    const RIBBON_SCAN_ALPHA = 0.28;
    const RIBBON_MIN_STEP_PX = 2;              // 投影後離上一點不到這麼遠就略過，點數少一個量級
    const RIBBON_FADE_MS = 150;                // 地圖一被操作就淡出
    // 拖動中網址的 @ 不更新，放開約 0.5 秒才更新（12 第④節實測）：
    // 最後一次操作後至少等這麼久，而且連續兩次輪詢網址都沒變，才重畫
    const RIBBON_IDLE_MS = 700;
    const RIBBON_POLL_MS = 200;
    const MARK_R_PX = 9;                       // 指到某格時，地圖上標出那個點的圈
    // 開啟時把整條路線移進面板上方的可見區
    const FIT_MARGIN_PX = 48;                  // 路線離可見區四邊至少留這麼多
    const FIT_MAX_ZOOM = 17;                   // 很短的路線也不拉得比這更近（跟 Google 點節點的層級一致）
    // 自動隱藏與讓位（mockup 第 5～7 區）
    const SIDEBAR_GAP_PX = 9;                  // 左側面板被打開時，底部面板左緣離展開鈕右緣（mockup：519→528）
    const CAPSULE_BOTTOM_PX = 24;              // 暫停膠囊離下緣
    const CAPSULE_LEFT_PX = 24;                // 街景畫面左下沒有「圖層」縮圖，貼左下
    const CAPSULE_LEFT_LAYERS_PX = 110;        // 地圖畫面左下有「圖層」縮圖（72＋左 24＋間距），要讓開
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
    // ── 點格子把地圖移到那個點（v0.77.0 的做法，v1.4.0 搬回來）──
    // 與 Google 自己一致：實測點路線節點時，它一律縮放到整數 17.00
    //（18.03→17.00、16.17→17.00，一個往下一個往上都精準落在 17）
    const MAP_FOCUS_ZOOM = 17;                 // 點擊節點時要拉近到的縮放層級
    const PAN_MS_PER_SCREEN = 300;             // 每多移動一個畫面寬就多這麼久
    const PAN_MAX_MS = 900;                    // 平移最長時長
    const ARC_MAX_ZOOM_OUT = 10;               // 拉遠的級數上限（台北→高雄這種極遠距離需要 9 級）
    const CONVERGE_MIN_EFFECT = 0.5;           // 一次修正的實際改善量，至少要有該次拖曳量的一半；
                                               // 也用於「再點同一個節點」時判斷不必動作
    const DEAD_ZONE_PX = 50;                   // 停滯時若剩下的誤差在此範圍內，視為抖動、接受它
    // 滾輪縮放的實測結果（間隔 vs 每事件縮放量）：
    //   16ms → 0.000 級（完全無效，那正是 requestAnimationFrame 的間隔）
    //   30ms → 0.256 級（打折）
    //   50ms 以上 → 0.320 級（滿效率）
    // 因此縮放不能用 rAF 逐影格送，必須用固定間隔串接。
    const WHEEL_INTERVAL_MS = 50;              // 滾輪事件間隔，低於 30ms 會被整批忽略
    const WHEEL_ZOOM_PER_EVENT = 0.32;         // 每個事件的縮放量（50ms 間隔下實測）
    // 拖曳時游標不能離開畫布，單次手勢最多只能移動約 0.4 個畫面；超過就分幾次拖。
    const DRAG_MAX_SCREENS = 0.6;              // 單次拖曳的位移上限（畫面數）；
                                               // 方向感知的按下點讓行程從 0.4 提高到 0.6
    const SAFE_PRESS_MIN_PX = 60;              // 按下點至少要離路線這麼遠，否則會被判定為拖曳路線
    const PRESS_EDGE_MARGIN_PX = 40;           // 按下點與拖曳終點都要離畫布邊緣這麼遠
    // ── 收斂 ──
    const PAN_TOLERANCE_PX = 15;               // 路線中心離可見區中心這麼近就算到位
    const SETTLE_POLL_MS = 250;                // 輪詢間隔；連續兩次相同即視為停止
    const SETTLE_TIMEOUT_MS = 3000;            // 等待上限，逾時就用當下的值繼續
    const PAN_MAX_ITERATIONS = 5;              // 修正的次數上限
    const ZOOM_TOLERANCE = 0.3;                // 縮放層級與目標差距在此範圍內即可
    const MIN_WORK_ZOOM = 5;                   // 把路線移進可見區時，拉遠的下限
    const ROUTE_CHANGE_DEBOUNCE_MS = 600;      // 路線改變後等它安定再重算（ms）
    const DEPART_STEP_MIN = 15;                // 出發時間欄距（分鐘）
    const DEPART_COLUMNS_MAX = 96;             // 欄數上限（96 欄 × 15 分 = 24 小時）
                                               // 預報涵蓋 96 小時、可排到約 370 欄，但步行模式節點多，
                                               // 格數會上萬；第一版先封頂，確認效能後再放寬
    const SIDEBAR_MAX_X_PX = 520;              // 左側面板的寬度上限；用來篩掉地圖上的搜尋框

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
    const KEY_SOURCE_MODE = 'forecastSourceMode';   // 'github'（預設）｜'api'
    const KEY_PANEL_HEIGHT = 'panelHeight';         // 使用者拖拉過的面板高度（px）
    const KEY_PALETTE = 'ribbonPalette';            // 'k2'｜'m'

    function getSourceMode() {
        const v = GM_getValue(KEY_SOURCE_MODE, 'github');
        return v === 'api' ? 'api' : 'github';
    }

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
        // 左側面板的收合／展開鈕（2026-11-24 實測；收起後 aria-label 換成「展開」）
        sidebarCollapse: 'button[aria-label="收合側邊面板"]',
        sidebarExpand: 'button[aria-label="展開側邊面板"]',
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

    // 降雨機率分級：0～20／30～40／50～60／70% 以上
    const RAIN_LEVELS = [{ maxPct: 20 }, { maxPct: 40 }, { maxPct: 60 }, { maxPct: 100 }];
    // 兩套配色（2026-11-25 使用者選定，在〔設定〕切換，預設 K2 紫）。LCh 固定色相 312／278，
    // 填色 L* 90／72／52／30、外框 L* 62／48／32／14，一級比一級重；最淺級外框取中間調。
    // 色帶、格子、圖例都從這裡取色，切換時不重算路線。
    const PALETTES = {
        k2: { name: 'K2 紫', fill: ['#ecddf8', '#c9a0eb', '#9d5cde', '#5f249f'],
            out: ['#b57dea', '#944be2', '#6622af', '#320d5b'] },
        m: { name: 'M 藍', fill: ['#dbe2f8', '#95b1eb', '#4a7dc6', '#284774'],
            out: ['#6097ea', '#3d73bb', '#274c7f', '#0f2440'] },
    };
    const PALETTE_DEFAULT = 'k2';
    // 查不到預報：比兩套最淺級都深的灰＋斜線（使用者選 N1＋斜線），格子跟色帶共用
    const RAIN_NA_COLOR = '#c3c7cc';
    const RAIN_NA_OUT = '#9aa0a6';
    const RAIN_NA_STRIPES = 'repeating-linear-gradient(135deg,transparent 0 3px,rgba(255,255,255,.75) 3px 4px)';
    // 雷雨、大雨不是機率問題，是後果問題：機率加這麼多再查表（剛好往上一級，紫封頂）
    const RAIN_BUMP_PCT = 20;

    function getPaletteKey() {
        const v = GM_getValue(KEY_PALETTE, PALETTE_DEFAULT);
        return PALETTES[v] ? v : PALETTE_DEFAULT;
    }
    // 還沒套用過（例如還沒打開面板）就讀儲存的選擇
    const currentPalette = () => PALETTES[state.paletteKey || getPaletteKey()];
    /** 格子、摘要條、圖例共用的 class：顏色由面板根節點上的 CSS 變數決定，換配色只改變數 */
    const levelClass = rain => PREFIX + (rain ? '-l' + rain.level : '-na');
    /** 把配色寫成面板根節點上的 CSS 變數，並重畫色帶（不重算路線） */
    function applyPalette(key) {
        state.paletteKey = PALETTES[key] ? key : PALETTE_DEFAULT;
        const pal = currentPalette();
        const root = document.documentElement;
        pal.fill.forEach((v, i) => root.style.setProperty(`--${PREFIX}-f${i}`, v));
        pal.out.forEach((v, i) => root.style.setProperty(`--${PREFIX}-o${i}`, v));
        if (state.ribbon) state.ribbon.cache = null;
        drawRibbon();
    }

    const state = {
        instanceId: Math.random().toString(36).slice(2, 8),  // 區分同一支腳本的不同次載入
        active: false,
        panel: null,                // 底部面板的根元素（掛在 document.body）
        body: null,                 // 面板裡放格線或訊息的那一層
        view: null,                 // 目前畫出來的資料與互動狀態，見 render()
        collapsed: false,           // 使用者按了〔收合〕
        pinnedMs: null,             // 已釘住那一欄的出發時刻；重算後用它找回同一欄
        sidebarCollapsedByUs: false,
        needFit: false,             // 這次打開還沒把路線移進可見區
        pageMode: 'route',          // 'route'｜'place'｜'street'｜'other'，見 detectPageMode()
        autoCollapsed: false,       // 點了地圖上的地點，自動收合成標題列（不是使用者按的）
        forceShown: false,
        paletteKey: null,            // 目前配色，見 applyPalette()；null＝還沒套用，讀儲存值          // 自動隱藏期間按了暫停膠囊，硬叫回來
        sawSidebarToggle: false,    // 這次打開後看過 Google 左側面板的開關鈕（拿來當地標）
        capsule: null,              // 暫停膠囊
        layoutKey: '',              // 上次排面板時的「左側面板右緣｜視窗寬」
        ribbon: null,               // 地圖色帶的狀態，見 ensureRibbon()// Google 左側面板是我們收起來的（關閉時才展開回去）
        lastSelected: null,         // { key, names }：左側面板收著時讀不到地點名稱，同一條路線沿用上次的
        initialDataKey: '',         // 頁面載入當下的路線（停靠點＋交通方式）；只有它能用 preload 補抓
        usedCaptureAt: 0,           // 這次畫面用的是哪一份路線資料（capturedDirections.at）
        routeMismatch: '',          // 選出來的路線跟 Google 清單上選中那列對不上：不畫色帶，ⓘ 變紅
        lastRouteKey: '',
        lastRouteKeyHref: '',
        ownFetches: new Set(),      // 自己補抓的網址：它也會經過攔截器，要跳過，不然會被當成 Google 的請求
        focusSeq: 0,                // 點格子移動地圖的第幾趟；新的一趟開始，舊的就停手
        sidebarCollapseDone: false, // 這次打開已經收過 Google 左側面板（重算時不再收）
        sawIntercept: false,        // 頁面載入後攔到過 Google 自己的路線請求（之後畫面用的就不是 preload 那份）
        capturedDirections: null,   // 攔截到的 /maps/preview/directions 回應
        gToken: '',                 // Google 內部端點的 session 權杖
        routePoints: null,          // 目前顯示路線的座標，用來算出離路線夠遠的按下點
        rerunTimer: null,
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
     * Google 畫面上選的是第幾條：寫在網址 data= 段的 !5i{n}，沒有就是第 0 條。
     * 實測（2026-11-25）：點清單第 2 條，網址多出 !5i1，Google 不重新請求、用手上那份換一條畫；
     * 回應裡 alternatives 的順序＝清單順序。所以用這個編號直接取資料，不再用距離去猜——
     * 「最佳路線」頁籤會混合交通方式，機車 5319 m 跟大眾運輸 5316 m 用距離分不出來。
     */
    function selectedIndexFromUrl(href) {
        const data = String(href).split('/data=')[1] || '';
        const m = data.split('?')[0].match(/!5i(\d+)/);
        return m ? +m[1] : 0;
    }

    /**
     * 清單上選中那一列的文字（拿來核對，不拿來挑路線）。
     * 左側面板收起後清單列仍在 DOM 裡、只是尺寸 0，文字照樣讀得到（2026-11-25 實測），
     * 所以這裡不用 findPanel()（它要求高度 > 400）。
     */
    function readSelectedRowText() {
        const rows = [...document.querySelectorAll('div[class*="' + SITE_SELECTORS.routeRowClassHint + '"]')];
        const row = rows.find(r => r.querySelectorAll('button').length >= 2);
        if (!row) return null;
        const pick = hint => {
            const el = row.querySelector('[class*="' + hint + '"]');
            return el ? el.textContent.trim() : '';
        };
        const durationText = pick(SITE_SELECTORS.durationClassHint);
        const distanceText = pick(SITE_SELECTORS.distanceClassHint);
        if (!durationText && !distanceText) return null;
        return {
            durationText, distanceText,
            durationSec: parseDurationText(durationText),
            distanceMeters: parseDistanceText(distanceText),
        };
    }

    /**
     * 選出來的路線跟清單上選中那列是不是同一條：距離字串要一樣，
     * 時間字串要等於「依路況」或「不含路況」其中一個（面板可能顯示任一種）。
     * 回傳空字串＝一致；讀不到清單列時回傳 null（無法核對）。
     */
    function routeMismatchReason(alt, row) {
        if (!row) return null;
        const reasons = [];
        if (row.distanceText && alt.distanceText && row.distanceText !== alt.distanceText) {
            reasons.push(`距離 ${alt.distanceText}／清單 ${row.distanceText}`);
        }
        const times = [alt.trafficText, alt.durationText].filter(Boolean);
        if (row.durationText && times.length && !times.includes(row.durationText)) {
            reasons.push(`時間 ${times.join(' 或 ')}／清單 ${row.durationText}`);
        }
        return reasons.join('，');
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

    function keepIfDirections(url, text, source) {
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
        // 記下這份資料屬於哪一條路線（停靠點＋交通方式）。實測 Google 先改網址、再發請求，
        // 回應到的時候網址已經是新路線了，所以用回應當下的網址。
        const dataKey = routeDataKey(location.href);
        const prev = state.capturedDirections;
        state.capturedDirections = {
            text, at: Date.now(), url: String(url), altCount: usable.length, dataKey,
            source: source || 'intercept',
        };
        if (source !== 'refetch') state.sawIntercept = true;
        log('已收下路線資料', (text.length / 1024).toFixed(1) + 'KB｜可用路線', usable.length, '條｜來源',
            source || '攔截');
        // Google 自己重新規劃（依路況更新、改了路線）時，畫面上的清單會換掉，
        // 網址卻可能完全沒變——以前只看網址，色帶就一直停在舊路線（2026-11-25 實測）。
        // 攔到同一條路線的新資料、內容又不一樣，就重算。自己補抓的不觸發，免得繞圈。
        if (source !== 'refetch' && state.active && state.body &&
            (!prev || prev.text !== text) && dataKey === routeDataKey(state.lastRouteKeyHref || '')) {
            log('攔到這條路線的新資料，重新計算');
            clearTimeout(state.rerunTimer);
            state.rerunTimer = setTimeout(rerun, ROUTE_CHANGE_DEBOUNCE_MS);
        }
    }

    /**
     * 頁面初次載入時，Google 有時用 HTML 裡的 <link rel=preload> 預先抓路線資料，
     * 網頁之後直接用那份、不再經過 fetch／XHR，攔截器就完全看不到（實測 2026-11-18，
     * 10 個途經點的機車路線：整頁只有一個 initiatorType=link 的 directions 請求）。
     * 而且那個網址帶 sig= 參數，回應是二進位（application/octet-stream），不是 JSON。
     * 實測拿掉 sig 重送同一個網址就回 JSON，內容跟 Google 自己切換交通方式時
     * 發的 XHR 完全一致（距離、時間、座標數都相同）。
     * 所以攔截器沒收到東西時，改從頁面找出那個 preload 網址、拿掉 sig 自己請求一次。
     */
    const DIRECTIONS_WAIT_MS = 3000;          // 路線改了之後等 Google 自己那份資料回來的上限（ms）
    const DIRECTIONS_POLL_MS = 200;

    /**
     * 拿「這條路線」（停靠點＋交通方式）的資料，而且是 Google 自己收到的那份。
     * 網址先變、Google 的請求後到（實測差約 1 秒），所以先等一下；
     * 只有 Google 從頁面載入後都沒再請求過（畫面用的還是 preload 那份）才自己補抓。
     */
    async function directionsFor(dataKey) {
        const match = () => {
            const c = state.capturedDirections;
            return c && c.dataKey === dataKey ? c : null;
        };
        const until = Date.now() + DIRECTIONS_WAIT_MS;
        while (!match() && state.sawIntercept && Date.now() < until) {
            await new Promise(r => setTimeout(r, DIRECTIONS_POLL_MS));
        }
        if (!match() && !state.sawIntercept) await refetchPreloadedDirections();
        return match();
    }

    /** 拿掉 sig 重送同一個路線網址，回傳 { text, at, url, source:'refetch' }；失敗回 null */
    async function refetchDirections(url) {
        if (!url) return null;
        try {
            const u = new URL(url, location.href);
            u.searchParams.delete('sig');
            const text = await ownFetchText(u.href);
            keepIfDirections(u.href, text, 'refetch');
            const c = state.capturedDirections;
            return c && c.text === text ? c : null;
        } catch (err) {
            log('重抓路線資料失敗｜', err.message);
            return null;
        }
    }

    /**
     * 自己補抓路線資料。用網頁的 fetch（要帶 Google 的 cookie），但它已經被我們攔截了——
     * 不跳過的話，同一份會再以「攔截」收一次，被當成 Google 自己的請求（2026-11-25 實機看到）。
     */
    async function ownFetchText(href) {
        state.ownFetches.add(href);
        try {
            const res = await pageWindow().fetch(href, { credentials: 'include' });
            return await res.text();
        } finally {
            state.ownFetches.delete(href);
        }
    }

    async function refetchPreloadedDirections() {
        const isDir = u => DIRECTIONS_URL_RE.test(String(u || ''));
        const urls = [...document.querySelectorAll('link[href]')].map(l => l.href).filter(isDir);
        try {
            for (const e of performance.getEntriesByType('resource')) {
                if (isDir(e.name) && !urls.includes(e.name)) urls.push(e.name);
            }
        } catch (err) { log('讀不到 performance 紀錄｜', err.message); }
        if (!urls.length) { log('頁面上找不到 preload 的路線網址'); return; }
        for (const raw of urls) {
            try {
                const u = new URL(raw, location.href);
                u.searchParams.delete('sig');
                const text = await ownFetchText(u.href);
                keepIfDirections(u.href, text, 'refetch');   // 內部會驗證能解析才收下
                if (state.capturedDirections) {
                    log('攔截器沒收到，改用頁面 preload 網址（去掉 sig）重新取得路線資料');
                    return;
                }
            } catch (err) {
                log('重抓 preload 路線網址失敗｜', err.message);
            }
        }
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
                const reqUrl = String((args[0] && args[0].url) || args[0]);
                if (state.ownFetches.has(reqUrl)) return origFetch.apply(this, args);
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
            // 每段（停靠點之間）的兩種時間：[0][3] 不含路況、[0][10][0] 依路況。
            // 步驟層只有不含路況的秒數，依路況時間只到路段這一層（見 applyPanelTiming）。
            const segTimes = segments.map(seg => ({
                freeSec: (seg[0] && seg[0][3] && seg[0][3][0]) || 0,
                trafficSec: (seg[0] && seg[0][10] && seg[0][10][0] && seg[0][10][0][0]) || 0,
            }));
            // 注意：leg 的分界**不是**使用者設定的停靠點。實測只有起訖兩點的路線，
            // Google 仍會切成兩個 leg（第二個只有一步、三百多公尺，是抵達前的最後一小段）。
            // 停靠點要從網址的 data= 段取得，那裡才明確區分「停靠站」與「拖曳控制點」。
            for (let si = 0; si < segments.length; si++) {
                const seg = segments[si];
                for (const leg of (seg[1] || [])) {
                    for (const st of (leg[1] || [])) {
                        steps.push({
                            seg: si,
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
                segTimes,
                // 摘要的 [10][0] 是面板顯示的依路況時間；[3] 是不含路況
                trafficSec: (summary[10] && summary[10][0] && summary[10][0][0]) || 0,
                trafficText: (summary[10] && summary[10][0] && summary[10][0][1]) || '',
            });
        }
        return out;
    }

    /**
     * 讓時程跟面板上使用者看到的時間一致。
     *
     * 回應裡同時有兩種時間：摘要 [3]（不含路況）與 [10][0]（依路況，面板通常顯示這個）。
     * 實測（2026-11-18，107 公里機車路線）：[3] = 3 小時 29 分，[10][0] = 2 小時 46 分 = 面板。
     * 不寫死用哪一種：拿面板顯示的時間去比，哪一種比較接近就用哪一種——
     * 交通方式、出發時間設定不同時，面板顯示的可能是任一種。
     *
     * 選到依路況時，步驟層沒有依路況的秒數，只有路段（停靠點之間）有，
     * 所以每段裡的步驟秒數依該段比例縮放（各段比例 0.74～0.87 不等，不能整條同一個比例）。
     * 某段沒有依路況時間時，那段沿用原本秒數。
     */
    function applyPanelTiming(alt, selected) {
        const panelSec = selected && selected.durationSec;
        let useTraffic = alt.trafficSec > 0;
        if (useTraffic && panelSec) {
            useTraffic = Math.abs(alt.trafficSec - panelSec) <= Math.abs(alt.totalSec - panelSec);
        }
        if (!useTraffic) {
            alt.timeBasis = alt.trafficSec > 0 ? '不含路況（與面板較接近）' : '不含路況（資料沒有路況時間）';
            return alt;
        }
        const steps = alt.steps.map(st => {
            const seg = alt.segTimes && alt.segTimes[st.seg];
            const ratio = seg && seg.freeSec > 0 && seg.trafficSec > 0 ? seg.trafficSec / seg.freeSec : 1;
            return { ...st, sec: st.sec * ratio };
        });
        return {
            ...alt, steps,
            totalSec: alt.trafficSec,
            durationText: alt.trafficText || alt.durationText,
            timeBasis: '依路況',
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
    // 天氣 → 顏色級數
    // ════════════════════════════════════════════════════════════════

    const SEEN_WEATHER_CODES = new Set();       // 記錄實際出現過的代碼，用真實使用補完官方拿不到的完整清單

    /**
     * 一格預報 → { pop, eff, level, baseLevel, reason }（顏色由目前配色依 level 決定）；沒有機率時回 null。
     *
     * 取代 v0.x 的 severityOf()＋洋紅疊色：第二個變數疊在色相上，四級配色時
     * 一格會有 8 種顏色，在 12px 的格子上分不出來。改成「雷雨／大雨就把機率提高
     * RAIN_BUMP_PCT 再查表」，顏色只剩四種，往上一級的意思是「當成更可能淋到」。
     * 官方天氣現象代碼表拿不到完整版，所以看中文描述裡的字，不看代碼。
     */
    function rainOf(row) {
        if (!row || row.pop == null) return null;
        if (row.code) SEEN_WEATHER_CODES.add(row.code);
        const text = row.weather || '';
        const reason = text.includes('雷') ? '雷陣雨'
            : text.includes('豪雨') ? '豪雨'
            : text.includes('大雨') ? '大雨' : '';
        const pop = Math.round(row.pop / 10) * 10;
        const eff = Math.min(100, pop + (reason ? RAIN_BUMP_PCT : 0));
        const levelOf = pct => RAIN_LEVELS.findIndex(l => pct <= l.maxPct);
        const level = levelOf(eff);
        return { pop: row.pop, eff, level, baseLevel: levelOf(pop), reason };
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
                    // key 用「縣市|鄉鎮」複合字串，避免跨縣市同名鄉鎮（中山區、中正區等）互相覆蓋，
                    // 與第 1003 行 runs 分組時使用的複合 key 格式一致。
                    forecast.set(county + '|' + loc.LocationName, [...merged.values()].sort((a, b) => a.startMs - b.startMs));
                }
            } catch (err) {
                failures.push(`${county}（${err.message}）`);
            }
        }
        log('CWA 呼叫', byCounty.size, '次，取得', forecast.size, '個鄉鎮的預報');
        if (SEEN_WEATHER_CODES.size) log('本次出現的天氣現象代碼：', [...SEEN_WEATHER_CODES].join(','));
        return { forecast, failures, callCount: byCounty.size };
    }

    const GITHUB_CACHE_URL =
        'https://raw.githubusercontent.com/bgtsai/browser-tools/main/route-rain/cwa_cache.json';

    /**
     * 從 NAS/Huginn 端維護的 GitHub 快取抓整份資料。
     * towns 的 key 已經是「縣市/鄉鎮」，轉成內部統一使用的「縣市|鄉鎮」格式。
     * 不篩選路線目前用到的鄉鎮——整份抓下來存進本機快取，往後切換/調整路線
     * 只是換一次 Map 查詢，不必為了新鄉鎮再打一次 GitHub。
     */
    async function fetchForecastFromGitHub(nodes) {
        const raw = await gmRequest({ url: GITHUB_CACHE_URL });
        const json = JSON.parse(raw);
        if (!json || typeof json.towns !== 'object') {
            throw new Error('GitHub 快取格式非預期（缺少 towns）');
        }
        const forecast = new Map();
        for (const [compositeName, rows] of Object.entries(json.towns)) {
            const key = compositeName.replace('/', '|');
            forecast.set(key, rows.map(([startIso, pop, weather]) => {
                const startMs = Date.parse(startIso);
                return {
                    startMs,
                    endMs: startMs + 3 * 3600 * 1000,
                    pop: pop == null ? null : +pop,
                    weather: weather ?? null,
                    code: null,
                };
            }));
        }
        const staleList = (json._meta && json._meta.stale_this_run) || [];
        log('GitHub 快取抓取完成，', forecast.size, '個鄉鎮，最後更新於',
            json._meta && json._meta.fetched_at_tw,
            staleList.length ? `（其中 ${staleList.length} 個鄉鎮 NAS 端沿用舊資料）` : '');
        // stale_this_run 只代表 NAS 端該鄉鎮這次抓取失敗、沿用舊值，資料仍存在，
        // 不算「整體取得失敗」，不觸發 fallback 到直連 API。
        return { forecast, failures: [], callCount: 1, fetchedAtRemote: json._meta && json._meta.fetched_at_tw };
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
    function cacheShortfall(cache, neededKeys) {
        const now = Date.now();
        const missing = [], stale = [];
        for (const t of neededKeys) {
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
        const neededKeys = [...new Set(nodes.map(n => n.county + '|' + n.town))];
        const cache = loadCache();
        const shortfall = cacheShortfall(cache, neededKeys);

        if (!shortfall) {
            const forecast = new Map(neededKeys.map(k => [k, cache[k].rows]));
            const oldest = Math.min(...neededKeys.map(k => cache[k].at));
            log('【氣象】沿用快取，未呼叫資料來源。',
                neededKeys.length, '個鄉鎮齊全，最舊一筆為',
                Math.round((Date.now() - oldest) / 60000), '分鐘前取得');
            return { forecast, failures: [], callCount: 0, fetchedAt: oldest, fromCache: true, source: 'cache' };
        }
        log('【氣象】快取不可用，將重新取得資料。原因：' + shortfall.reason +
            '｜本次需要 ' + neededKeys.length + ' 個鄉鎮');

        const mode = getSourceMode();
        const sourceLabel = { github: 'GitHub 快取', api: '中央氣象署 API' };
        if (onFetchStart) onFetchStart(sourceLabel[mode]);

        let res, source;
        if (mode === 'github') {
            try {
                res = await fetchForecastFromGitHub(nodes);
                source = 'github';
                if (res.failures.length) throw new Error(res.failures.join('；'));
            } catch (err) {
                warn('【氣象】GitHub 來源失敗，改用直連中央氣象署 API。原因：' + err.message);
                if (onFetchStart) onFetchStart('中央氣象署 API（GitHub 失敗，改直連）');
                res = await fetchForecast(auth, nodes);
                source = 'api-fallback';
            }
        } else {
            res = await fetchForecast(auth, nodes);
            source = 'api';
        }

        if (!res.failures.length) {
            saveCache(res.forecast);
            log('【氣象】已取得資料並寫入快取（來源：' + source + '）');
        } else {
            warn('【氣象】有縣市取得失敗，不寫入快取（下次仍會重新呼叫）');
        }
        return { ...res, fetchedAt: Date.now(), fromCache: false, source };
    }

    function lookupForecast(forecast, county, town, whenMs) {
        const rows = forecast.get(county + '|' + town);
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

        const field = (labelText, hintHtml, value, name) => `
<label class="${PREFIX}-f">
  <span class="${PREFIX}-flabel">${labelText}</span>
  <span class="${PREFIX}-hint">${hintHtml}</span>
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

        const CWA_KEY_PATTERN = /^CWA-[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/;

        const curMode = getSourceMode();
        // 配色選了就即時套用（預覽）；取消／Esc／點背景關掉時改回原本的
        const curPal = state.paletteKey || getPaletteKey();
        box.innerHTML = `
<div class="${PREFIX}-mtitle">設定</div>
<div class="${PREFIX}-f">
  <span class="${PREFIX}-flabel">色帶配色</span>
  <div class="${PREFIX}-pals">${Object.entries(PALETTES).map(([k, pal]) => `
    <label class="${PREFIX}-palopt"><input type="radio" name="palette" value="${k}" ${k === curPal ? 'checked' : ''}>
      ${pal.name}<span class="${PREFIX}-palbar">${pal.fill.map((f, i) =>
        `<i style="background:${f};box-shadow:inset 0 0 0 1px ${pal.out[i]}"></i>`).join('')}</span></label>`).join('')}
  </div>
</div>
<label class="${PREFIX}-f">
  <span class="${PREFIX}-flabel">降雨資料來源</span>
  <select name="sourceMode">
    <option value="github" ${curMode === 'github' ? 'selected' : ''}>GitHub 快取（推薦，失敗自動改直連）</option>
    <option value="api" ${curMode === 'api' ? 'selected' : ''}>直連中央氣象署 API</option>
  </select>
</label>
<div class="${PREFIX}-info-zone">
  <div class="${PREFIX}-source-desc">
    <div class="${PREFIX}-source-desc-title">GitHub 快取</div>
    <div class="${PREFIX}-source-desc-body">讀取每小時更新的快取，減緩氣象署主機壓力；失敗時自動改走直連 API。</div>
  </div>
  <div class="${PREFIX}-source-desc">
    <div class="${PREFIX}-source-desc-title">直連中央氣象署 API</div>
    <div class="${PREFIX}-source-desc-body">即時查詢，需先在下方填妥授權碼。</div>
  </div>
</div>
${field('API 授權碼',
    `於中央氣象署 <a href="https://opendata.cwa.gov.tw/" target="_blank" rel="noopener">opendata.cwa.gov.tw</a> ` +
    `註冊帳號即可取得 API 授權碼<br>（格式為 <b>CWA-</b> 開頭）`,
    cur.cwa, 'cwa')}
<div class="${PREFIX}-danger-zone">
  <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true" class="${PREFIX}-danger-icon">
    <path fill="currentColor" d="M12 3.2 1.6 21h20.8L12 3.2Zm0 4.4 7.6 12.2H4.4L12 7.6Zm-.9 4.4h1.8v4.4h-1.8v-4.4Zm0 5.6h1.8v1.8h-1.8v-1.8Z"/>
  </svg>
  <div class="${PREFIX}-danger-text">授權碼只存在你自己的瀏覽器，不會上傳，也不會出現在腳本原始碼中。</div>
</div>
<div class="${PREFIX}-modal-warn" data-${PREFIX}-warn style="display:none"></div>
<div class="${PREFIX}-mact">
  <button type="button" class="${PREFIX}-mbtn" data-${PREFIX}-cancel>取消</button>
  <button type="button" class="${PREFIX}-mbtn ${PREFIX}-primary" data-${PREFIX}-save>儲存</button>
</div>`;

        back.appendChild(box);
        document.body.appendChild(back);
        box.querySelector('input[name="cwa"]')?.focus();

        const warnBox = box.querySelector(`[data-${PREFIX}-warn]`);
        const showWarn = msg => {
            warnBox.textContent = msg;
            warnBox.style.display = '';
        };
        const hideWarn = () => { warnBox.style.display = 'none'; };

        const close = () => {
            back.remove();
            if (state.paletteKey !== curPal) applyPalette(curPal);
        };
        box.querySelectorAll('input[name="palette"]').forEach(r =>
            r.addEventListener('change', () => applyPalette(r.value)));

        const selectEl = box.querySelector('select[name="sourceMode"]');
        let lastValidMode = curMode;
        selectEl.addEventListener('change', () => {
            if (selectEl.value === 'api') {
                const key = box.querySelector('input[name="cwa"]').value.trim();
                if (!CWA_KEY_PATTERN.test(key)) {
                    showWarn('選擇「直連 API」前，請先在下方填入正確格式的 API 授權碼（CWA-…）。');
                    selectEl.value = lastValidMode;
                    return;
                }
            }
            hideWarn();
            lastValidMode = selectEl.value;
        });

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
            if (ev.target.closest('[data-' + PREFIX + '-cancel]')) { close(); return; }
            if (ev.target.closest('[data-' + PREFIX + '-save]')) {
                const get = n => box.querySelector(`input[name="${n}"]`).value.trim();
                const cwaValue = get('cwa');
                const modeValue = selectEl.value;
                if (modeValue === 'api' && !CWA_KEY_PATTERN.test(cwaValue)) {
                    showWarn(cwaValue
                        ? '授權碼格式不正確（應為 CWA- 開頭的完整格式），無法儲存。'
                        : '已選擇「直連 API」，但尚未填入授權碼，無法儲存。');
                    return;
                }
                const palValue = state.paletteKey;
                const sourceChanged = cwaValue !== (cur.cwa || '') || modeValue !== curMode;
                GM_setValue(KEY_CWA, cwaValue);
                GM_setValue(KEY_SOURCE_MODE, modeValue);
                GM_setValue(KEY_PALETTE, palValue);
                back.remove();
                log('設定已儲存');
                // 只換配色不重算路線（已經套用了）；資料來源或授權碼有改才重抓
                if (sourceChanged) rerun();
            }
        });
        back.addEventListener('click', ev => { if (ev.target === back) close(); });
        document.addEventListener('keydown', function esc(ev) {
            if (!back.isConnected) { document.removeEventListener('keydown', esc); return; }
            if (ev.key === 'Escape') { close(); document.removeEventListener('keydown', esc); }
        });
    }

    GM_registerMenuCommand('設定', openSettings);

    // 診斷做在腳本自己身上，不透過另一支腳本去讀 DOM 屬性——
    // 那樣多一層依賴，而那層依賴出過事（面板的探針被換掉，資料就沒人讀了）。
    GM_registerMenuCommand('複製上次定位診斷（debug）', () => {
        const logText = document.documentElement.getAttribute('data-' + PREFIX + '-log') || '';
        const lines = logText.trim().split('\n').filter(Boolean);
        const text = lines.length
            ? '=== route-rain 定位診斷 ===\n' + lines.join('\n')
            : '（還沒有診斷資料，請先打開一次「旅途中的雨」）';
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
        const P = PREFIX;
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
.${PREFIX}-modal-back{position:fixed;inset:0;background:rgba(32,33,36,.45);z-index:2147483100;
  display:flex;align-items:center;justify-content:center}
.${PREFIX}-modal{background:#fff;border-radius:12px;padding:22px 24px;width:420px;max-width:92vw;
  box-shadow:0 12px 40px rgba(0,0,0,.3);font-family:inherit;color:#202124}
.${PREFIX}-mtitle{font-size:17px;font-weight:600;margin-bottom:16px}
.${PREFIX}-f{display:block;margin-bottom:16px}
.${PREFIX}-flabel{display:block;font-size:14px;font-weight:600;margin-bottom:2px}
.${PREFIX}-f select{font-size:13px;padding:8px 10px;border-radius:6px;border:1px solid #dadce0;
  width:100%;background:#fff;color:#202124;font-family:inherit}
.${PREFIX}-hint{display:block;font-size:11.5px;color:#5f6368;margin-bottom:6px;line-height:1.6;padding-left:10px}
.${PREFIX}-hint a{color:#1a73e8;text-decoration:underline}
.${PREFIX}-info-zone{border:1px solid rgba(26,115,232,.18);border-radius:8px;
  background:rgba(26,115,232,.05);padding:10px 12px;margin-bottom:20px}
.${PREFIX}-source-desc{padding-left:2px;margin-bottom:8px}
.${PREFIX}-source-desc:last-child{margin-bottom:0}
.${PREFIX}-source-desc-title{font-size:12px;font-weight:600;color:#202124;margin-bottom:1px}
.${PREFIX}-source-desc-body{font-size:11.5px;color:#5f6368;line-height:1.6;padding-left:10px}
.${PREFIX}-danger-zone{display:flex;gap:8px;align-items:flex-start;border:1px solid rgba(180,40,40,.25);
  border-radius:8px;background:rgba(180,40,40,.04);padding:10px 12px;margin-bottom:20px}
.${PREFIX}-danger-icon{color:rgba(160,40,40,.6);flex-shrink:0;margin-top:1px}
.${PREFIX}-danger-text{font-size:11.5px;color:rgba(140,60,60,.75);line-height:1.5}
.${PREFIX}-modal-warn{font-size:12.5px;color:#c5221f;background:#fce8e6;border-radius:6px;
  padding:8px 10px;margin-bottom:14px;line-height:1.5}
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
/* ── 底部時間軸面板 ──
   掛在 document.body、fixed 定位，不進 Google 的渲染範圍（理由見 positionButton 的註解）。
   文字層次只用字級與顏色分，不用字重：很多預設字型沒有粗體，粗細差異看不出來。 */
.${P}-panel{position:fixed;left:0;bottom:0;z-index:2147482000;background:#fff;
  border-top:1px solid rgba(0,0,0,.10);border-right:1px solid rgba(0,0,0,.10);border-radius:0 8px 0 0;
  box-shadow:0 -2px 10px rgba(0,0,0,.10);display:flex;flex-direction:column;box-sizing:border-box;
  font-family:"Google Sans Text",Roboto,"Noto Sans TC",Arial,sans-serif;color:#202124}
.${P}-panel *{box-sizing:border-box}
.${P}-grip{position:absolute;top:0;left:0;right:0;height:8px;cursor:ns-resize;z-index:5;touch-action:none}
.${P}-grip::after{content:"";position:absolute;left:50%;top:3px;width:32px;height:4px;margin-left:-16px;
  border-radius:2px;background:#dadce0}
.${P}-grip:hover::after,.${P}-panel.${P}-dragging .${P}-grip::after{background:#9aa0a6}
.${P}-panel.${P}-collapsed .${P}-grip{display:none}
.${P}-title{height:${PANEL_TITLE_H_PX}px;flex:0 0 auto;display:flex;align-items:center;gap:14px;
  padding:6px 12px 0 16px;white-space:nowrap;overflow:hidden}
.${P}-name{font-size:16px;color:#202124}
.${P}-sel{font-size:14px;color:#3c4043;font-variant-numeric:tabular-nums}
.${P}-max{font-size:14px;color:#3c4043;display:inline-flex;align-items:center;gap:6px}
.${P}-max i{width:12px;height:12px;border-radius:2px;display:inline-block;box-shadow:inset 0 0 0 1px rgba(0,0,0,.12)}
.${P}-sp{flex:1}
.${P}-ib,.${P}-tb{height:28px;border-radius:14px;border:1px solid #dadce0;background:#fff;cursor:pointer;
  display:inline-flex;align-items:center;justify-content:center;padding:0;font-family:inherit;flex:0 0 auto}
.${P}-ib{width:28px;color:#5f6368}
.${P}-ib.${P}-has-warn{border-color:#d93025;color:#d93025}
.${P}-tb{width:56px;color:#1a73e8;font-size:13px}
.${P}-ib:hover,.${P}-tb:hover{background:#f1f3f4}
.${P}-ib[aria-expanded="true"]{background:#e8f0fe}
.${P}-body{flex:1;min-height:0;position:relative}
.${P}-panel.${P}-collapsed .${P}-body{display:none}
.${P}-panel.${P}-nomax .${P}-max{display:none}
.${P}-panel.${P}-tight .${P}-title{gap:8px}
.${P}-panel.${P}-nosel .${P}-sel{display:none}
.${P}-panel.${P}-autohide{display:none}
/* 暫停膠囊：自動隱藏期間浮在地圖左下角，點它叫回面板 */
.${P}-cap{position:fixed;bottom:${CAPSULE_BOTTOM_PX}px;z-index:2147482000;height:36px;padding:0 16px 0 12px;
  border-radius:18px;background:#fff;box-shadow:0 1px 4px rgba(0,0,0,.3);display:none;align-items:center;gap:8px;
  font-size:14px;color:#202124;white-space:nowrap;border:0;cursor:pointer;
  font-family:"Google Sans Text",Roboto,"Noto Sans TC",Arial,sans-serif}
.${P}-cap.${P}-on{display:inline-flex}
.${P}-cap:hover{background:#f1f3f4}
.${P}-cap .${P}-pz{width:18px;height:18px;border-radius:50%;background:#e8f0fe;display:inline-flex;
  align-items:center;justify-content:center}
.${P}-cap .${P}-s{color:#5f6368}
/* overflow-anchor:none：內容一變動瀏覽器就會自己調捲動位置，地名陸續補上時會亂跳 */
.${P}-scroll{position:absolute;inset:0;overflow:auto;overscroll-behavior:contain;overflow-anchor:none}
.${P}-inner{position:relative}
.${P}-head{position:sticky;top:0;z-index:4;height:${HEAD_H_PX}px;background:#fff;display:flex}
/* 標頭左側那格：sticky 疊在標頭的 sticky 裡，橫捲時也留在左邊 */
.${P}-corner{position:sticky;left:0;z-index:3;width:${LABEL_W_PX}px;flex:0 0 ${LABEL_W_PX}px;height:100%;
  background:#fff;padding:0 8px 0 16px}
.${P}-sumlab{position:absolute;left:16px;top:${SUM_Y_PX + SUM_H_PX / 2 - 8}px;height:16px;line-height:16px;
  font-size:11px;color:#80868b}
.${P}-prog{position:absolute;left:16px;top:${AXIS_Y_PX + 1 - 8}px;height:16px;line-height:16px;
  font-size:11px;color:#80868b;font-variant-numeric:tabular-nums;transition:opacity .5s ease}
.${P}-prog.${P}-done{opacity:0}
.${P}-marks{position:absolute;left:0;top:0;height:100%}
.${P}-sum{position:absolute;top:${SUM_Y_PX}px;width:${CELL_PX}px;height:${SUM_H_PX}px;border-radius:1px;
  box-shadow:inset 0 0 0 1px rgba(0,0,0,.12)}
.${P}-axis{position:absolute;top:${AXIS_Y_PX}px;height:2px;background:#dadce0}
.${P}-hour{position:absolute;top:${AXIS_Y_PX + 1 - HOUR_DOT_PX / 2}px;width:${HOUR_DOT_PX}px;height:${HOUR_DOT_PX}px;
  box-sizing:border-box;border-radius:50%;background:#1a73e8;border:${HOUR_RING_PX}px solid #fff;
  box-shadow:0 1px 3px rgba(60,64,67,.4),0 1px 1px rgba(60,64,67,.15);font-size:11px;color:#fff;letter-spacing:-.3px;
  display:flex;align-items:center;justify-content:center;font-variant-numeric:tabular-nums}
.${P}-q{position:absolute;top:${AXIS_Y_PX + 1 - QUARTER_DOT_PX / 2}px;width:${QUARTER_DOT_PX}px;
  height:${QUARTER_DOT_PX}px;border-radius:50%;background:#bdc1c6}
.${P}-pin{position:absolute;top:${PIN_Y_PX}px;width:${CELL_PX}px;height:8px;display:none;pointer-events:none}
.${P}-pin svg{display:block}
.${P}-rows{position:relative}
.${P}-row{display:flex;height:${ROW_PITCH_PX}px}
.${P}-lab{position:sticky;left:0;z-index:2;width:${LABEL_W_PX}px;flex:0 0 ${LABEL_W_PX}px;height:${ROW_PITCH_PX}px;
  padding:0 8px 0 16px;display:flex;align-items:center;gap:4px;background:#fff}
.${P}-lab.${P}-hl{background:#e8f0fe}
.${P}-p{font-size:12px;color:#3c4043;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1 1 0;min-width:0}
.${P}-m{font-size:11px;color:#80868b;flex:0 0 ${LABEL_TIME_W_PX}px;text-align:right;white-space:nowrap;
  font-variant-numeric:tabular-nums}
.${P}-c{width:${CELL_PX}px;height:${CELL_PX}px;flex:0 0 ${CELL_PX}px;margin:${(ROW_PITCH_PX - CELL_PX) / 2}px
  ${COL_PITCH_PX - CELL_PX}px 0 0;border-radius:2px;box-shadow:inset 0 0 0 1px rgba(0,0,0,.12)}
/* 欄框分成標頭與格線兩段：標頭是 sticky，畫成一整塊的話上下捲動時會跟標頭錯開。
   樣式是細邊＋往外的光暈（使用者看比較頁定的，粗框太雜）；兩段接縫處用 clip-path 切掉光暈，
   否則接縫會多出一道橫向的光 */
.${P}-cbh,.${P}-cbr{position:absolute;width:${CELL_PX + COLBOX_PAD_PX * 2}px;box-sizing:border-box;
  border:1px solid #202124;box-shadow:0 0 8px 2px rgba(32,33,36,.6);pointer-events:none;display:none;z-index:3}
.${P}-cbh{top:${SUM_Y_PX - COLBOX_PAD_PX}px;bottom:0;border-bottom:0;border-radius:3px 3px 0 0;
  clip-path:inset(-12px -12px 0 -12px)}
.${P}-cbr{top:0;border-top:0;border-radius:0 0 3px 3px;clip-path:inset(0 -12px -12px -12px)}
.${P}-cbh.${P}-hov,.${P}-cbr.${P}-hov{border-color:#1a73e8;box-shadow:0 0 8px 2px rgba(26,115,232,.6);z-index:4}
.${P}-msg{padding:12px 16px;font-size:13px;color:#3c4043;line-height:1.7;white-space:pre-wrap}
.${P}-msg b{color:#1a73e8}
/* ⓘ 點開的說明：圖例與資料來源 */
.${P}-pop{position:absolute;right:12px;bottom:calc(100% + 8px);width:380px;background:#fff;border-radius:8px;
  box-shadow:0 2px 12px rgba(0,0,0,.25);padding:12px 14px;font-size:12px;color:#3c4043;line-height:1.7;display:none}
.${P}-pop.${P}-open{display:block}
.${P}-pop h4{margin:0 0 6px;font-size:14px;font-weight:400;color:#202124}
.${P}-lg{display:flex;flex-wrap:wrap;gap:4px 14px;margin-bottom:6px}
.${P}-lg span{display:inline-flex;align-items:center;gap:5px}
.${P}-lg i{width:12px;height:12px;border-radius:2px;display:inline-block;box-shadow:inset 0 0 0 1px rgba(0,0,0,.12)}
.${P}-note{font-size:11px;color:#80868b;border-top:1px solid #e8eaed;margin-top:8px;padding-top:6px}
.${P}-warn{color:#c5221f}
/* 雨勢四級與無資料：顏色是 applyPalette() 寫在根節點的 CSS 變數，換配色不用重畫格子。
   [class] 是為了壓過 .${P}-max i、.${P}-lg i 這類 (0,1,1) 的選擇器。
   格子不加外框也不加光暈（使用者看比較頁定的：外框太雜、光暈會滲到只隔 1 px 的隔壁格） */
${[0, 1, 2, 3].map(i => `[class].${P}-l${i}{background:var(--${P}-f${i});box-shadow:none}`).join('\n')}
/* 預設值：applyPalette() 會在根節點寫 inline 變數覆蓋，這裡讓還沒套用時也有顏色 */
:root{${currentPalette().fill.map((v, i) => `--${P}-f${i}:${v};--${P}-o${i}:${currentPalette().out[i]}`).join(';')}}
[class].${P}-na{background:${RAIN_NA_COLOR} ${RAIN_NA_STRIPES};box-shadow:none}
/* 設定裡的「色帶配色」：兩個選項各附四級小色條 */
.${PREFIX}-pals{display:flex;gap:8px}
.${PREFIX}-palopt{flex:1 1 0;display:flex;align-items:center;gap:8px;border:1px solid #dadce0;border-radius:8px;
  padding:8px 10px;cursor:pointer;font-size:14px;color:#3c4043}
.${PREFIX}-palopt:has(input:checked){border-color:#1a73e8;background:#e8f0fe}
.${PREFIX}-palopt input{margin:0}
.${PREFIX}-palbar{display:inline-flex;gap:1px;margin-left:auto}
.${PREFIX}-palbar i{width:12px;height:12px;border-radius:2px;display:inline-block}
.${PREFIX}-tip{position:fixed;z-index:2147483000;pointer-events:none;display:none;background:#202124;
  color:#fff;border-radius:8px;padding:9px 12px;font-size:12px;line-height:1.6;
  box-shadow:0 6px 20px rgba(0,0,0,.25);max-width:300px}
.${PREFIX}-tip .${PREFIX}-k{color:#9aa0a6;display:inline-block;min-width:60px}
.${PREFIX}-ttl{font-size:14px;color:#fff;line-height:1.35;margin-bottom:2px}
/* 標籤放在名稱左側，字級與名稱相同（14px）——同級才夠醒目 */
.${PREFIX}-ttl em{display:inline-block;margin-right:8px;padding:1px 9px;border-radius:11px;
  background:rgba(138,180,248,.25);color:#aecbfa;font-size:14px;font-style:normal;white-space:nowrap}
/* 行政區是次要資訊：字小一級、亮度降下來，才有主次之分 */
.${PREFIX}-sub{font-size:11.5px;color:rgba(255,255,255,.62);line-height:1.4;margin-bottom:6px}
`;
        const el = document.createElement('style');
        el.id = PREFIX + '-style';
        el.textContent = css;
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
    function positionButton(btn, optionsBtn) {
        const r = optionsBtn.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) {
            btn.style.setProperty('display', 'none', 'important');
            return;
        }
        btn.style.setProperty('display', 'inline-flex', 'important');
        btn.style.setProperty('top', Math.round(r.top) + 'px', 'important');
        btn.style.setProperty('height', Math.round(r.height) + 'px', 'important');

        // 面板往下捲時「選項」會往上跑，按鈕跟著上去就會疊到搜尋框那一區。
        // 按鈕掛在 document.body、與 Google 面板是不同的堆疊脈絡，
        // 調 z-index 不保險（而且當初移到 body 正是為了避開它的渲染範圍）；
        // 改成把超出面板內容區上緣的部分裁掉，視覺上就是滑進上面那塊的下方。
        const panel = findPanel();
        const limit = panel ? panel.getBoundingClientRect().top : 0;
        const over = limit - r.top;
        if (over >= r.height) {
            // 整顆都在上緣之外，直接收起來
            btn.style.setProperty('display', 'none', 'important');
            return;
        }
        btn.style.setProperty('clip-path',
            over > 0 ? `inset(${Math.ceil(over)}px 0 0 0)` : 'none', 'important');
        // 開啟或關閉都固定在「選項」左邊，不蓋住它——使用者隨時能點「選項」修改路線，
        // 不需要先關掉我們的表格才能碰到它。（先前開啟時會蓋住選項模仿 Google 的
        // 「按下展開、原位變關閉」效果，但那樣使用者臨時想改路線就必須先關表格。）
        btn.style.removeProperty('min-width');
        btn.style.setProperty('background', 'transparent', 'important');
        btn.style.setProperty('left',
            Math.round(r.left - btn.offsetWidth - BUTTON_GAP_PX) + 'px', 'important');
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
        if (first) {
            if (first.textContent !== label) first.textContent = label;
            rest.forEach(n => { if (n.textContent) n.textContent = ''; });
        } else btn.appendChild(document.createTextNode(label));
        // 一樣也不要重寫：寫入同樣的值仍會產生一筆變動紀錄，而 boot() 有看 aria-label——
        // 每一輪都寫就變成「寫→變動→重排→寫」的無限迴圈（v1.2.0 開發時踩到）
        if (btn.getAttribute('aria-label') !== label) btn.setAttribute('aria-label', label);
    }

    // ════════════════════════════════════════════════════════════════
    // Google 左側面板：打開時收起、關閉時展開回去
    // ════════════════════════════════════════════════════════════════

    const isShown = el => !!el && el.getClientRects().length > 0;

    function collapseGoogleSidebar() {
        const btn = document.querySelector(SITE_SELECTORS.sidebarCollapse);
        if (!isShown(btn)) return;
        btn.click();
        state.sidebarCollapsedByUs = true;
        log('已收起 Google 左側面板');
    }

    /** 只展開我們自己收起來的；使用者自己收的不動 */
    function restoreGoogleSidebar() {
        if (!state.sidebarCollapsedByUs) return;
        state.sidebarCollapsedByUs = false;
        const btn = document.querySelector(SITE_SELECTORS.sidebarExpand);
        if (isShown(btn)) { btn.click(); log('已展開 Google 左側面板'); }
    }

    // ════════════════════════════════════════════════════════════════
    // 自動隱藏、暫停膠囊、點地點自動收合
    // ════════════════════════════════════════════════════════════════

    /**
     * 目前是哪一種畫面。判斷用網址＋地標元素兩者（12 第⑤節）：只看網址會把「同一個情境裡
     * 網址暫時換格式」誤判成離開；只看元素又分不出地點卡是「路線旁並排的」還是「另外搜尋的」。
     *   route ：路線地圖（/maps/dir/，不是街景）
     *   place ：點了地圖上的地點——Google 把「路線」和「地點卡」並排打開，路線還在地圖上
     *           （/maps/place/ 而且路線面板的「選項」還在）
     *   street：街景（網址的 @ 那段有 ,3a,）
     *   other ：其他（另外搜尋了地點、首頁…），路線不在地圖上
     */
    function detectPageMode() {
        const href = location.href;
        if (/\/@[^/]*,3a,/.test(href)) return 'street';
        const toggleBtn = document.querySelector(SITE_SELECTORS.sidebarCollapse) ||
            document.querySelector(SITE_SELECTORS.sidebarExpand);
        if (toggleBtn) state.sawSidebarToggle = true;
        // 地標：左側面板的開關鈕。只在這次打開後看過它時才要求——
        // Google 改了 aria-label 的話，寧可只靠網址，也不要整個面板永遠被藏起來
        const landmark = !state.sawSidebarToggle || !!toggleBtn;
        if (href.includes('/maps/dir/') && landmark) return 'route';
        if (href.includes('/maps/place/') && landmark && findOptionsButton()) return 'place';
        return 'other';
    }

    /** 路線還畫在地圖上（色帶才有意義） */
    const mapShowsRoute = () => state.pageMode === 'route' || state.pageMode === 'place';

    function applyPageMode(mode) {
        if (mode === state.pageMode) return;
        const prev = state.pageMode;
        state.pageMode = mode;
        state.forceShown = false;
        // 離開路線地圖：正在跑的「點格子移動地圖」作廢。只在 alive() 檢查時看畫面不夠——
        // 街景只待一下就回來的話，檢查時又是路線地圖，舊的那趟會接著拖（v1.4.0 無頭測試抓到）
        if (mode !== 'route') state.focusSeq++;
        // 點地點自動收合；回到路線自動展開（使用者自己按〔收合〕的 state.collapsed 不動）
        state.autoCollapsed = mode === 'place';
        log('畫面切換', prev, '→', mode);
        applyCollapsed();
        applyVisibility();
        drawRibbon();
    }

    function applyVisibility() {
        if (!state.panel) return;
        const hidden = !mapShowsRoute() && !state.forceShown;
        state.panel.classList.toggle(PREFIX + '-autohide', hidden);
        if (hidden) { hideTip(); toggleInfo(false); }
        const cap = ensureCapsule();
        cap.classList.toggle(PREFIX + '-on', hidden);
        // 街景左下沒有「圖層」縮圖；其他畫面有，要讓開
        cap.style.left = (state.pageMode === 'street' ? CAPSULE_LEFT_PX : CAPSULE_LEFT_LAYERS_PX) + 'px';
    }

    function ensureCapsule() {
        if (state.capsule && state.capsule.isConnected) return state.capsule;
        const P = PREFIX;
        const cap = document.createElement('button');
        cap.type = 'button';
        cap.className = P + '-cap';
        cap.title = '叫回「旅途中的雨」面板';
        cap.innerHTML = `<span class="${P}-pz"><svg width="8" height="8" viewBox="0 0 8 8" aria-hidden="true">` +
            '<rect x="1" y="0" width="2" height="8" fill="#1a73e8"/><rect x="5" y="0" width="2" height="8" fill="#1a73e8"/>' +
            `</svg></span>${BUTTON_LABEL}<span class="${P}-s">・暫停</span>`;
        cap.addEventListener('click', () => {
            state.forceShown = true;
            applyVisibility();
            layoutPanel();
        });
        document.body.appendChild(cap);
        state.capsule = cap;
        return cap;
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
    /** 路線資料的身分：停靠點＋交通方式。換這兩個 Google 會重新請求資料 */
    function routeDataKey(href) {
        const parsed = parseRouteFromUrl(href);
        if (!parsed || !parsed.points.length) return '';
        return parsed.points
            .map(p => `${p.kind}:${p.lat.toFixed(6)},${p.lon.toFixed(6)}`)
            .join('|') + '|3e' + (parsed.urlTravelCode || '');
    }

    /** 畫面上的路線：資料身分＋選第幾條（!5i）。點清單別條只改 !5i、不重新請求，也要重算 */
    function routeSignature(href) {
        const key = routeDataKey(href);
        return key ? key + '|5i' + selectedIndexFromUrl(href) : '';
    }

    /** 開著面板時偵測到路線改變（例如切換交通方式）就重跑一次 */
    function scheduleRerunIfRouteChanged() {
        if (!state.active || !state.body) return;
        const key = routeSignature(location.href);
        if (!key || key === state.lastRouteKey) return;
        log('偵測到路線改變，重新計算');
        state.lastRouteKey = key;
        state.lastRouteKeyHref = location.href;
        clearTimeout(state.rerunTimer);
        // 切換交通方式時網址可能連續變動幾次，等安定下來再跑，避免重複請求
        state.rerunTimer = setTimeout(rerun, ROUTE_CHANGE_DEBOUNCE_MS);
    }

    function rerun() {
        if (!state.active || !state.body) return;
        const body = state.body;
        clearBody(body);
        run(body).catch(err => {
            warn(err);
            clearBody(body);
            showMessage(body, '出錯了：' + err.message);
        });
    }

    const ICON_INFO = '<svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">' +
        '<circle cx="7" cy="7" r="6" fill="none" stroke="currentColor" stroke-width="1.4"/>' +
        '<rect x="6.3" y="6" width="1.4" height="4.5" rx=".7" fill="currentColor"/>' +
        '<circle cx="7" cy="4" r=".9" fill="currentColor"/></svg>';
    const ICON_PIN = '<svg width="12" height="8" viewBox="0 0 12 8" aria-hidden="true">' +
        '<path d="M1 0h10L6 7z" fill="#202124"/></svg>';

    function buildPanel() {
        const P = PREFIX;
        const panel = document.createElement('div');
        panel.id = P + '-panel';
        panel.className = P + '-panel';
        panel.innerHTML =
            `<div class="${P}-grip" title="拖拉調整高度"></div>` +
            `<div class="${P}-title">` +
            `<span class="${P}-name">${BUTTON_LABEL}</span>` +
            `<span class="${P}-sel"></span>` +
            `<span class="${P}-max"></span>` +
            `<span class="${P}-sp"></span>` +
            `<button type="button" class="${P}-ib" data-${P}-act="info" aria-expanded="false" ` +
            `title="圖例與資料來源">${ICON_INFO}</button>` +
            `<button type="button" class="${P}-tb" data-${P}-act="collapse">收合</button>` +
            `<button type="button" class="${P}-tb" data-${P}-act="settings">設定</button>` +
            `<button type="button" class="${P}-tb" data-${P}-act="close">關閉</button>` +
            `</div>` +
            `<div class="${P}-body"></div>` +
            `<div class="${P}-pop" role="dialog"></div>`;
        panel.addEventListener('click', ev => {
            const b = ev.target.closest('[data-' + P + '-act]');
            if (!b) return;
            const act = b.getAttribute('data-' + P + '-act');
            if (act === 'close') deactivate();
            else if (act === 'collapse') setCollapsed(!isCollapsed());
            else if (act === 'settings') openSettings();
            else if (act === 'info') toggleInfo();
        });
        bindGrip(panel);
        return panel;
    }

    function toggleInfo(force) {
        const pop = state.panel && state.panel.querySelector('.' + PREFIX + '-pop');
        const ib = state.panel && state.panel.querySelector('.' + PREFIX + '-ib');
        if (!pop || !ib) return;
        const open = force !== undefined ? force : !pop.classList.contains(PREFIX + '-open');
        pop.classList.toggle(PREFIX + '-open', open);
        ib.setAttribute('aria-expanded', String(open));
    }

    /**
     * 〔收合〕〔展開〕。看起來收著（不管是使用者收的、還是點地點自動收的）時按下去就是展開，
     * 自動收合也一併取消——使用者明確要看，就不要在他看的時候又收回去。
     */
    function setCollapsed(on) {
        state.collapsed = on;
        if (!on) state.autoCollapsed = false;
        applyCollapsed();
    }

    const isCollapsed = () => state.collapsed || state.autoCollapsed;

    function applyCollapsed() {
        if (!state.panel) return;
        const on = isCollapsed();
        state.panel.classList.toggle(PREFIX + '-collapsed', on);
        const b = state.panel.querySelector('[data-' + PREFIX + '-act="collapse"]');
        if (b) b.textContent = on ? '展開' : '收合';
        hideTip();
        layoutPanel();
    }

    /** 格線完整畫出來要多高（標題列＋標頭＋全部列＋留白） */
    function contentHeight() {
        const v = state.view;
        if (!v) return PANEL_DEFAULT_H_PX;
        return PANEL_TITLE_H_PX + HEAD_H_PX + v.nodes.length * ROW_PITCH_PX + GRID_BOTTOM_PAD_PX +
            (v.scrollbarH || 0);
    }

    function heightBounds() {
        const full = contentHeight();
        const v = state.view;
        const minRows = v ? Math.min(PANEL_MIN_ROWS, v.nodes.length) : PANEL_MIN_ROWS;
        const min = Math.min(full, PANEL_TITLE_H_PX + HEAD_H_PX + minRows * ROW_PITCH_PX);
        const max = Math.max(min, Math.min(full, innerHeight - PANEL_MAP_MIN_PX));
        return { min, max };
    }

    /** 依視窗、使用者拖拉的高度、收合狀態排面板；可以重複呼叫 */
    function layoutPanel() {
        const panel = state.panel;
        if (!panel) return;
        // Google 左側面板開著（使用者自己按展開、或點了地點）：左緣讓到它的開關鈕右邊
        const left = sidebarRightEdge();
        panel.style.left = left + 'px';
        panel.style.width = Math.max(0, innerWidth - PANEL_RIGHT_GAP_PX - left) + 'px';
        fitTitle();
        if (panel.classList.contains(PREFIX + '-dragging')) return;   // 拖拉中由 bindGrip 自己設高度
        if (isCollapsed()) { panel.style.height = PANEL_TITLE_H_PX + 'px'; return; }
        // 還在顯示訊息（處理中、錯誤）時不撐高，只要訊息放得下
        if (!state.view) { panel.style.height = 'auto'; return; }
        const { min, max } = heightBounds();
        const want = GM_getValue(KEY_PANEL_HEIGHT, PANEL_DEFAULT_H_PX);
        panel.style.height = Math.round(Math.max(min, Math.min(max, want))) + 'px';
    }

    /** Google 左側面板開著時它的右緣（開關鈕右邊再空一點）；收著時回 0 */
    function sidebarRightEdge() {
        const btn = document.querySelector(SITE_SELECTORS.sidebarCollapse);
        if (!isShown(btn)) return 0;
        const r = btn.getBoundingClientRect();
        // 開關鈕在面板右緣外側。量到離譜的位置（地圖剩不到 200px）多半是量錯，不讓
        return r.right > 0 && r.right < innerWidth - PANEL_RIGHT_GAP_PX - 200 ? Math.round(r.right) + SIDEBAR_GAP_PX : 0;
    }

    /**
     * 標題列放不下時依序退讓：先藏「沿路最高」（mockup 第 7 區），再把間距從 14 縮成 8，
     * 最後才藏「出發→抵達」。名稱與按鈕一定留著——按鈕被擠出去就關不掉了。
     * （mockup 第 7 區的 496px 實際放不下「名稱＋出發→抵達＋四顆按鈕」，要縮到第三步）
     */
    function fitTitle() {
        const panel = state.panel;
        const title = panel && panel.querySelector('.' + PREFIX + '-title');
        if (!title) return;
        const steps = [PREFIX + '-nomax', PREFIX + '-tight', PREFIX + '-nosel'];
        panel.classList.remove(...steps);
        for (const cls of steps) {
            if (title.scrollWidth <= title.clientWidth) break;
            panel.classList.add(cls);
        }
    }

    function bindGrip(panel) {
        const grip = panel.querySelector('.' + PREFIX + '-grip');
        grip.addEventListener('pointerdown', ev => {
            if (ev.button !== 0) return;
            ev.preventDefault();
            grip.setPointerCapture(ev.pointerId);
            panel.classList.add(PREFIX + '-dragging');
            const startY = ev.clientY;
            const startH = panel.getBoundingClientRect().height;
            const { min, max } = heightBounds();
            let h = startH;
            const move = e => {
                h = Math.round(Math.max(min, Math.min(max, startH + (startY - e.clientY))));
                panel.style.height = h + 'px';
            };
            const up = () => {
                grip.removeEventListener('pointermove', move);
                grip.removeEventListener('pointerup', up);
                grip.removeEventListener('pointercancel', up);
                panel.classList.remove(PREFIX + '-dragging');
                // 拖到底（整張都放得下）就記成「放得下就全放」，下次換一條更長的路線也是滿的
                GM_setValue(KEY_PANEL_HEIGHT, h >= max ? 99999 : h);
            };
            grip.addEventListener('pointermove', move);
            grip.addEventListener('pointerup', up);
            grip.addEventListener('pointercancel', up);
        });
    }

    function deactivate() {
        clearTimeout(state.rerunTimer);
        const btn = document.querySelector('[data-' + PREFIX + '-btn]');
        if (btn) btn.removeAttribute('data-' + PREFIX + '-on');
        if (state.panel) state.panel.remove();
        state.panel = null;
        state.body = null;
        state.view = null;
        hideTip();
        removeRibbon();
        if (state.capsule) { state.capsule.remove(); state.capsule = null; }
        restoreGoogleSidebar();
        state.active = false;
        ensureButton();
        log('已關閉');
    }

    function activate() {
        injectStyle();
        applyPalette(getPaletteKey());
        if (!findPanel()) { alert('找不到路線面板，請先在 Google Maps 規劃好路線。'); return; }

        state.lastRouteKey = routeSignature(location.href);
        state.lastRouteKeyHref = location.href;
        state.sidebarCollapseDone = false;
        state.collapsed = false;
        state.autoCollapsed = false;
        state.forceShown = false;
        state.sawSidebarToggle = false;
        state.pageMode = 'route';
        const panel = buildPanel();
        document.body.appendChild(panel);
        state.panel = panel;
        state.body = panel.querySelector('.' + PREFIX + '-body');
        state.view = null;
        state.active = true;
        state.needFit = true;
        layoutPanel();
        const btn = document.querySelector('[data-' + PREFIX + '-btn]');
        if (btn) btn.setAttribute('data-' + PREFIX + '-on', '1');
        ensureButton();
        rerun();
    }

    function clearBody(wrap) {
        wrap.innerHTML = '';
        if (wrap === state.body) { state.view = null; hideTip(); layoutPanel(); }
    }

    function showMessage(wrap, html) {
        const d = document.createElement('div');
        d.className = PREFIX + '-msg';
        d.innerHTML = html;
        wrap.appendChild(d);
        if (wrap === state.body) layoutPanel();
    }

    // ════════════════════════════════════════════════════════════════
    // 主流程
    // ════════════════════════════════════════════════════════════════

    async function run(wrap) {
        const routeKey = routeSignature(location.href);
        const keys = getKeys();
        const sourceMode = getSourceMode();
        if (sourceMode === 'api' && !keys.cwa) {
            showMessage(wrap,
                '目前設定為「直連中央氣象署 API」，但還沒設定授權碼。<br><br>' +
                '到 opendata.cwa.gov.tw 免費註冊即可取得，格式為 <b>CWA-…</b><br>' +
                '路線資料直接取自頁面，不需要 Google 金鑰。<br><br>' +
                '授權碼只會存在你自己的瀏覽器裡，不會出現在腳本原始碼中。<br><br>' +
                '請從 Tampermonkey 選單的「設定」填入，或按下方按鈕；也可以改選 GitHub 快取來源，不需要授權碼。');
            const openBtn = document.createElement('button');
            openBtn.className = PREFIX + '-mbtn ' + PREFIX + '-primary';
            openBtn.textContent = '開啟設定';
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
        // 左側面板收著時讀不到地點名稱（尺寸是 0），同一條路線（停靠點＋交通方式）沿用上次讀到的
        const dataKey = routeDataKey(location.href);
        const cachedSel = state.lastSelected && state.lastSelected.key === dataKey ? state.lastSelected : null;
        const index = selectedIndexFromUrl(location.href);
        const modeInfo = detectTravelMode(parsed.urlTravelCode);
        log('網址解析：停靠站/控制點共', parsed.points.length, '個；網址選中第', index, '條（!5i）');
        if (modeInfo.mode === null) {
            clearBody(wrap);
            showMessage(wrap, `目前選的交通方式（<b>${modeInfo.label || '未知'}</b>）` +
                'Routes API 不支援，無法計算沿途座標與時間。<br><br>' +
                '可用的有：開車、機車、單車、步行、大眾運輸。');
            return;
        }

        clearBody(wrap);
        showMessage(wrap, '處理中…');
        let data = await directionsFor(dataKey);
        if (!data) {
            clearBody(wrap);
            showMessage(wrap,
                '還沒拿到這條路線的資料。\n\n' +
                '本工具直接讀取 Google Maps 自己算好的路線，不另外呼叫 API，' +
                '因此必須在 Google 取得路線時就在場。\n\n' +
                '請重新整理頁面後再按一次；若剛安裝或更新腳本，也需要重新整理。');
            return;
        }
        // 不能先濾掉不可用的再取編號：編號對的是 Google 清單的順序
        let all = parseDirections(data.text);
        let chosen = all[index];
        if (!chosen || chosen.points.length < 2 || !chosen.steps.length) {
            clearBody(wrap);
            showMessage(wrap, chosen
                ? `Google 選中的這條（第 ${index + 1} 條）沒有沿途路段資料，例如大眾運輸，算不出沿途的雨。`
                : `Google 選中第 ${index + 1} 條，但路線資料裡只有 ${all.length} 條，請重新整理頁面後再試。`);
            return;
        }
        // 核對：Google 清單上選中那列的距離與時間要跟這條一樣；對不上就不畫色帶（寧可不畫，也不畫錯的）
        const row = readSelectedRowText();
        let mismatch = routeMismatchReason(chosen, row);
        if (mismatch) {
            // 手上的資料可能比 Google 畫面舊（它換清單時不一定經過我們看得到的請求）：
            // 用同一個網址重抓一次「現在」的規劃，再核對一次
            log('選中的路線跟清單對不上（', mismatch, '），重抓一次再核對');
            const fresh = await refetchDirections(data.url);
            const again = fresh && parseDirections(fresh.text)[index];
            if (again && again.points.length > 1 && again.steps.length &&
                routeMismatchReason(again, row) === '') {
                data = fresh; all = parseDirections(fresh.text); chosen = again; mismatch = '';
            }
        }
        state.routeMismatch = mismatch || '';
        state.usedCaptureAt = data.at;
        if (mismatch) log('選中的路線跟清單對不上：', mismatch);
        const matchNote = `網址選中第 ${index + 1} 條（共 ${all.length} 條）` +
            (mismatch === null ? '，清單讀不到、未核對' : mismatch ? `，跟清單對不上（${mismatch}）` : '，跟清單一致');
        const alt = applyPanelTiming(chosen, row);
        log('時間依據：', alt.timeBasis, '｜總時程', Math.round(alt.totalSec / 60), '分',
            row && row.durationText ? `｜清單 ${row.durationText}` : '');

        state.routePoints = alt.points;   // 供計算安全按下點
        const { timeline, steps, totalSec } = buildTimeline(alt);
        if (!timeline.length) throw new Error('Routes API 回傳的路徑沒有可用的座標');
        // 起點、使用者設定的停靠點、目的地——這三類是使用者自己規劃的位置，
        // 一定要出現在表格裡，不能因為「取中點」而被略過
        let names = readEndpointNames();
        if (!names.length && cachedSel) names = cachedSel.names;
        state.lastSelected = { key: dataKey, names };
        // 資料都讀完了才收 Google 的左側面板：收起後路線面板尺寸變 0，起訖名稱讀不到（2026-11-24 實測）。
        // 只在按開「旅途中的雨」後的第一次收：之後的重算多半是使用者打開左側面板選別條路線觸發的，
        // 再收回去他就得重開一次（2026-11-25 實機，使用者決定）
        if (!state.sidebarCollapseDone) {
            state.sidebarCollapseDone = true;
            collapseGoogleSidebar();
        }
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
                FORECAST_HORIZON_HOURS + ' 小時），無法產生時間軸。');
            return;
        }

        clearBody(wrap);
        const lastArrive = new Date(departures[departures.length - 1].getTime() + totalSec * 1000);
        const { forecast, failures, callCount, fetchedAt, fromCache, source } =
            await getForecast(keys.cwa, nodes,
                (sourceLabel) => { clearBody(wrap); showMessage(wrap, `正在向${sourceLabel}取得降雨預報…`); });

        log('即將繪製的前 3 列：', nodes.slice(0, 3).map(n =>
            `+${Math.round(n.sec / 60)}分 ${n.county || '?'}${n.town || '?'}` +
            `${n.kind ? '[' + n.kind + ']' : ''}`).join('　│　'),
            '／總列數', nodes.length);
        clearBody(wrap);
        render(wrap, {
            nodes, departures, forecast, totalSec, timeline,
            meta: {
                matchNote,
                timeBasis: alt.timeBasis,
                routeDistanceMeters: alt.totalMeters,
                capturedAt: state.capturedDirections.at,
                mode: modeInfo,
                selected: row,
                callCount,
                failures,
                fetchedAt,
                fromCache,
                source,
                altCount: all.length,
            },
        });
        // 格線先出現，地點名稱在背景陸續補上——36 個節點要十幾秒，
        // 讓使用者盯著「處理中」等那麼久沒有必要。名稱寫進節點物件，
        // 每補一批就重寫地點欄的文字（只動文字，不重畫格子）。
        const view = state.view;
        // 每次打開只移一次：之後換路線重算時，使用者多半正在看地圖的某一處
        if (state.needFit) {
            state.needFit = false;
            fitRouteIntoView().catch(err => warn('移動地圖失敗：', err.message));
        }
        const prog = wrap.querySelector('.' + PREFIX + '-prog');
        if (prog) prog.textContent = `地名 0／${nodes.length}`;
        fillPlaceNames(nodes, (done, total) => {
            if (!view || state.view !== view) return;          // 已經重算過，這批是舊的
            refreshRowLabels(view);
            if (!prog || !prog.isConnected) return;
            prog.textContent = `地名 ${done}／${total}`;
            if (done >= total) {
                prog.classList.add(PREFIX + '-done');
                setTimeout(() => { if (prog.isConnected) prog.textContent = ''; }, 600);
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

    const pad2 = n => String(n).padStart(2, '0');
    const clockOf = d => pad2(d.getHours()) + ':' + pad2(d.getMinutes());

    /**
     * 節點要顯示的名稱：使用者自己設的名稱 ＞ Google 反向地理編碼 ＞ 鄉鎮名。
     * 第二行（addr）照 Google 彈窗的排法放行政區；查不到才退回導航指示的路名。
     */
    function nodeTitle(n) {
        let title, addr = '';
        if (n.placeName) {
            // 面板輸入框的內容是「名稱＋地址」連在一起（例如
            // 「乾華十八王公廟 253新北市石門區乾華里阿里磅1-1號」），以郵遞區號為界拆開。
            // 只在「名稱 空白 郵遞區號…」這種形式才拆：像「住家（103臺北市…）」
            // 的地址是包在括號裡的別名，拆了會變成「住家（」這種殘缺的標題。
            const m = /[（(]/.test(n.placeName)
                ? null
                : n.placeName.match(/^(.+?)\s+(\d{3}\s*[一-龥]{2,3}[市縣].*)$/);
            if (m) { title = m[1].trim(); addr = m[2].trim(); }
            else { title = n.placeName; addr = (n.county || '') + (n.town || ''); }
        } else if (n.place && n.place.title) {
            title = n.place.title;
            addr = n.place.area || '';
        } else {
            title = (n.county || '') + (n.town || '（未知區域）');
            addr = n.road ? n.road + (n.roadBorrowed ? '（附近）' : '') : '';
        }
        return { title, addr };
    }

    /** 地點欄右側的時間：起點寫「出發」、終點寫「抵達」，中間寫出發後幾分 */
    function nodeTimeLabel(n) {
        if (n.kind === 'origin') return KIND_LABEL.origin;
        if (n.kind === 'destination') return KIND_LABEL.destination;
        return '+' + Math.round(n.sec / 60) + '分';
    }

    function refreshRowLabels(view) {
        view.rowEls.forEach((rowEl, ri) => {
            const p = rowEl.querySelector('.' + PREFIX + '-p');
            const t = nodeTitle(view.nodes[ri]).title;
            if (p.textContent !== t) { p.textContent = t; p.title = t; }
        });
    }

    function render(wrap, data) {
        const P = PREFIX;
        const { nodes, departures, forecast, totalSec, timeline, meta } = data;
        const cols = departures.length;
        const colX = ci => LABEL_W_PX + ci * COL_PITCH_PX;       // 第 ci 欄色塊的左緣

        // 先算好每一格的級數，互動時只查表
        const cells = nodes.map(n => departures.map(d =>
            rainOf(lookupForecast(forecast, n.county, n.town, d.getTime() + n.sec * 1000))));
        // 每欄「沿路最濕」：提高級數之後最濕的那一格（同級取機率較高的）
        const wettest = departures.map((_, ci) => {
            let best = null, bestRow = -1;
            cells.forEach((row, ri) => {
                const c = row[ci];
                if (c && (!best || c.eff > best.eff || (c.eff === best.eff && c.pop > best.pop))) {
                    best = c; bestRow = ri;
                }
            });
            return { rain: best, row: bestRow };
        });

        const innerW = colX(cols) + GRID_BOTTOM_PAD_PX;
        const rowsH = nodes.length * ROW_PITCH_PX;
        const parts = [];
        parts.push(`<div class="${P}-scroll"><div class="${P}-inner" style="width:${innerW}px">`);
        // 標頭：摘要條、時間刻度、▼、標頭那一段的欄框
        parts.push(`<div class="${P}-head" style="width:${innerW}px"><div class="${P}-marks" style="width:${innerW}px">`);
        wettest.forEach((w, ci) => {
            parts.push(`<div class="${P}-sum ${levelClass(w.rain)}" style="left:${colX(ci)}px"></div>`);
        });
        parts.push(`<div class="${P}-axis" style="left:${colX(0)}px;width:${cols * COL_PITCH_PX - 1}px"></div>`);
        departures.forEach((d, ci) => {
            const cx = colX(ci) + CELL_PX / 2;
            parts.push(d.getMinutes() === 0
                ? `<div class="${P}-hour" style="left:${cx - HOUR_DOT_PX / 2}px">${d.getHours()}</div>`
                : `<div class="${P}-q" style="left:${cx - QUARTER_DOT_PX / 2}px"></div>`);
        });
        parts.push(`<div class="${P}-pin">${ICON_PIN}</div>`);
        parts.push(`<div class="${P}-cbh ${P}-pinbox"></div><div class="${P}-cbh ${P}-hov"></div>`);
        parts.push(`</div><div class="${P}-corner"><span class="${P}-sumlab">沿路最濕</span>` +
            `<span class="${P}-prog"></span></div></div>`);
        // 格線
        parts.push(`<div class="${P}-rows" style="height:${rowsH}px">`);
        nodes.forEach((n, ri) => {
            const t = nodeTitle(n).title;
            parts.push(`<div class="${P}-row"><div class="${P}-lab">` +
                `<span class="${P}-p" title="${escapeHtml(t)}">${escapeHtml(t)}</span>` +
                `<span class="${P}-m">${nodeTimeLabel(n)}</span></div>`);
            for (let ci = 0; ci < cols; ci++) {
                const c = cells[ri][ci];
                parts.push(`<span class="${P}-c ${levelClass(c)}"></span>`);
            }
            parts.push('</div>');
        });
        parts.push(`<div class="${P}-cbr ${P}-pinbox" style="height:${rowsH + COLBOX_PAD_PX}px"></div>` +
            `<div class="${P}-cbr ${P}-hov" style="height:${rowsH + COLBOX_PAD_PX}px"></div>`);
        parts.push('</div></div></div>');
        wrap.innerHTML = parts.join('');

        const scroll = wrap.querySelector('.' + P + '-scroll');
        const view = {
            nodes, departures, forecast, totalSec, timeline, meta, cells, wettest,
            pointNode: assignPointsToNodes(timeline || [], nodes),
            scroll,
            rowEls: [...wrap.querySelectorAll('.' + P + '-row')],
            hoverCol: null, hoverRow: null,
            pinnedCol: null,
            scrollbarH: 0,
        };
        // 已釘住的欄重算後找回同一個出發時刻；不在新的範圍內就取消
        if (state.pinnedMs != null) {
            const ci = departures.findIndex(d => d.getTime() === state.pinnedMs);
            if (ci >= 0) view.pinnedCol = ci; else state.pinnedMs = null;
        }
        state.view = view;
        fillInfo(view);
        layoutPanel();
        // 橫向放不下時會多一條捲軸，高度要把它算進去，不然最後一列被捲軸蓋住
        view.scrollbarH = scroll.offsetHeight - scroll.clientHeight;
        if (view.scrollbarH) layoutPanel();
        updateShownColumn();
        bindInteractions(view);
    }

    const escapeHtml = s => String(s).replace(/[&<>"]/g, c =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

    /** 目前顯示哪一欄：滑鼠指到的 ＞ 已釘住的 ＞ 最早一欄 */
    function shownColumn(view) {
        if (view.hoverCol != null) return view.hoverCol;
        if (view.pinnedCol != null) return view.pinnedCol;
        return 0;
    }

    function updateShownColumn() {
        const view = state.view;
        if (!view || !state.panel) return;
        const P = PREFIX;
        const ci = shownColumn(view);
        const dep = view.departures[ci];
        const arrive = new Date(dep.getTime() + view.totalSec * 1000);
        state.panel.querySelector('.' + P + '-sel').textContent =
            `${clockOf(dep)} 出發 → ${clockOf(arrive)} 抵達`;
        const w = view.wettest[ci].rain;
        state.panel.querySelector('.' + P + '-max').innerHTML = w
            ? `<i class="${levelClass(w)}"></i>沿路最高 ${w.pop}%${w.reason ? '・' + w.reason : ''}`
            : '';
        fitTitle();
        const place = (sel, col) => {
            view.scroll.querySelectorAll(sel).forEach(el => {
                if (col == null) { el.style.display = 'none'; return; }
                el.style.display = 'block';
                el.style.left = (LABEL_W_PX + col * COL_PITCH_PX - COLBOX_PAD_PX) + 'px';
            });
        };
        place('.' + P + '-pinbox', view.pinnedCol);
        place('.' + P + '-hov', view.hoverCol);
        const pin = view.scroll.querySelector('.' + P + '-pin');
        if (view.pinnedCol == null) pin.style.display = 'none';
        else {
            pin.style.display = 'block';
            pin.style.left = (LABEL_W_PX + view.pinnedCol * COL_PITCH_PX) + 'px';
        }
        drawRibbon();
    }

    /** ⓘ 的內容：圖例、資料來源、警告（有警告時 ⓘ 變紅） */
    function fillInfo(view) {
        const P = PREFIX;
        const { nodes, totalSec, meta } = view;
        const pop = state.panel.querySelector('.' + P + '-pop');
        const ib = state.panel.querySelector('.' + P + '-ib');
        const chip = (cls, text) => `<span><i class="${cls}"></i>${text}</span>`;
        const lines = [
            `節點 ${nodes.length} 個，涵蓋 ${new Set(nodes.map(n => n.county + n.town)).size} 個鄉鎮，` +
                `總行程 ${Math.round(totalSec / 60)} 分`,
            `路徑資料：取自頁面本身（${Math.round((Date.now() - meta.capturedAt) / 1000)} 秒前攔截），未呼叫任何 API`,
            meta.fromCache
                ? `氣象資料：沿用本機快取（${Math.round((Date.now() - meta.fetchedAt) / 60000)} 分鐘前取得）`
                : `氣象資料：從${{
                    github: 'GitHub 快取',
                    api: '中央氣象署 API（直連）',
                    'api-fallback': '中央氣象署 API（GitHub 失敗，改直連）',
                }[meta.source] || meta.source || '未知來源'}取得，呼叫 ${meta.callCount} 次`,
            `交通方式 ${meta.mode.mode}（判斷依據：${meta.mode.via}）`,
            `路線比對：${meta.matchNote}`,
            `時間依據：${meta.timeBasis || '不含路況'}`,
        ];
        const warnings = [];
        // 選出來的路線跟 Google 清單上選中那列對不上：色帶不畫（drawRibbon 看 state.routeMismatch）
        if (state.routeMismatch) {
            warnings.push(`⚠ 這條路線跟 Google 清單上選中的那條對不上（${state.routeMismatch}），` +
                '地圖色帶先不畫，表格的時間也可能不對。');
        }
        if (meta.failures && meta.failures.length) warnings.push(`取得失敗：${meta.failures.join('、')}`);
        pop.innerHTML =
            `<h4>降雨機率</h4><div class="${P}-lg">` +
            chip(P + '-l0', '0～20%') + chip(P + '-l1', '30・40%') +
            chip(P + '-l2', '50・60%') + chip(P + '-l3', '70% 以上') +
            chip(P + '-na', '無資料') + '</div>' +
            `<div>有雷陣雨、大雨或豪雨時，顏色提高一級（最深一級封頂）。</div>` +
            `<div>每一列是路線上的一個點、每一欄是一個出發時間；「沿路最濕」是那個出發時間沿路最濕的一格。</div>` +
            warnings.map(w => `<div class="${P}-warn">${w}</div>`).join('') +
            `<div class="${P}-note">${lines.map(l => `<div>${l}</div>`).join('')}</div>`;
        ib.classList.toggle(P + '-has-warn', warnings.length > 0);
    }

    function hideTip() {
        const tip = document.getElementById(PREFIX + '-tip');
        if (tip) tip.style.display = 'none';
    }

    /** 指到、點擊：全部掛在捲動容器上委派，格子本身不掛任何 listener */
    function bindInteractions(view) {
        const P = PREFIX;
        let tip = document.getElementById(P + '-tip');
        if (!tip) {
            tip = document.createElement('div');
            tip.id = P + '-tip';
            tip.className = P + '-tip';
            document.body.appendChild(tip);
        }
        const scroll = view.scroll;
        const inner = scroll.firstElementChild;

        /** 游標落在哪一欄、哪一列（標頭與地點欄是 sticky，要用可見位置判斷） */
        const hit = ev => {
            const sr = scroll.getBoundingClientRect();
            const ir = inner.getBoundingClientRect();
            const vx = ev.clientX - sr.left, vy = ev.clientY - sr.top;
            if (vx < LABEL_W_PX || vx >= scroll.clientWidth || vy >= scroll.clientHeight) return null;
            const x = ev.clientX - ir.left - LABEL_W_PX;
            const ci = Math.floor(x / COL_PITCH_PX);
            if (ci < 0 || ci >= view.departures.length) return null;
            if (vy < HEAD_H_PX) return { ci, ri: null, onCell: false };
            const ri = Math.floor((ev.clientY - ir.top - HEAD_H_PX) / ROW_PITCH_PX);
            if (ri < 0 || ri >= view.nodes.length) return { ci, ri: null, onCell: false };
            // 色塊之間的 1px 間距也算同一格，免得滑過去 tooltip 一閃一閃
            return { ci, ri, onCell: true };
        };

        const setHover = (ci, ri) => {
            if (view.hoverRow !== ri) {
                if (view.hoverRow != null) view.rowEls[view.hoverRow].firstElementChild.classList.remove(P + '-hl');
                if (ri != null) view.rowEls[ri].firstElementChild.classList.add(P + '-hl');
                view.hoverRow = ri;
                if (view.hoverCol === ci) drawRibbon();   // 只換列：標記點要跟著移
            }
            if (view.hoverCol !== ci) { view.hoverCol = ci; updateShownColumn(); }
        };

        const showTip = (ci, ri, ev) => {
            const n = view.nodes[ri];
            const dep = view.departures[ci];
            const arrive = new Date(dep.getTime() + n.sec * 1000);
            const row = lookupForecast(view.forecast, n.county, n.town, arrive.getTime());
            const rain = view.cells[ri][ci];
            const k = s => `<span class="${P}-k">${s}</span>`;
            const { title, addr } = nodeTitle(n);
            tip.innerHTML =
                `<div class="${P}-ttl">` + (n.kind ? `<em>${KIND_LABEL[n.kind]}</em>` : '') +
                escapeHtml(title) + '</div>' +
                (addr ? `<div class="${P}-sub">${escapeHtml(addr)}</div>` : '') +
                k('出發時間') + clockOf(dep) + '<br>' +
                k('抵達時刻') + clockOf(arrive) + `（出發後 ${Math.round(n.sec / 60)} 分）<br>` +
                k('降雨機率') + (rain
                    ? rain.pop + '%' + (rain.reason ? '・' + rain.reason +
                        (rain.level > rain.baseLevel ? '（顏色提高一級）' : '') : '')
                    : '無資料') + '<br>' +
                k('天氣現象') + (row && row.weather ? escapeHtml(row.weather) : '—') +
                (n.part[1] > 1 ? `<br>${k('本鄉鎮')}第 ${n.part[0]}／${n.part[1]} 個取樣點` : '') +
                (n.isFlap ? `<br>${k('備註')}此處為行政區交界，來回穿越` : '');
            tip.style.display = 'block';
            const off = 14;
            const r = tip.getBoundingClientRect();
            let x = ev.clientX + off, y = ev.clientY + off;
            if (x + r.width > innerWidth - 8) x = ev.clientX - r.width - off;
            if (y + r.height > innerHeight - 8) y = ev.clientY - r.height - off;
            tip.style.left = x + 'px';
            tip.style.top = y + 'px';
        };

        scroll.addEventListener('mousemove', ev => {
            const h = hit(ev);
            if (!h) { setHover(null, null); tip.style.display = 'none'; return; }
            setHover(h.ci, h.ri);
            if (h.onCell) showTip(h.ci, h.ri, ev); else tip.style.display = 'none';
        });
        scroll.addEventListener('mouseleave', () => { setHover(null, null); tip.style.display = 'none'; });
        // 捲動時游標下的格子換了，但不會有 mousemove：先收起來，等下一次移動
        scroll.addEventListener('scroll', () => { setHover(null, null); tip.style.display = 'none'; });
        scroll.addEventListener('click', ev => {
            const h = hit(ev);
            if (!h) return;
            // 點一下釘住這一欄，再點同一欄取消。
            // 點在格子上（不是摘要條、刻度）而且是釘住，就把地圖移到那個點並拉近（使用者選 C1，2026-11-25）；
            // 取消釘住不動地圖
            view.pinnedCol = view.pinnedCol === h.ci ? null : h.ci;
            state.pinnedMs = view.pinnedCol == null ? null : view.departures[h.ci].getTime();
            updateShownColumn();
            const node = h.onCell && view.pinnedCol === h.ci ? view.nodes[h.ri] : null;
            if (node && Number.isFinite(node.lat) && Number.isFinite(node.lon)) {
                log('點格子，地圖移到', (node.county || '') + (node.town || ''));
                focusMapOn(node.lat, node.lon).catch(err => warn('移動地圖失敗｜', err.message));
            }
        });
    }

    // ── 把地圖視野移到指定座標 ──
    //
    // 為什麼不用改網址：實測發現 Google 是「把內部狀態寫進網址」，不是從網址讀視野。
    // 我們改了網址，它的路由發現與內部狀態不一致，隨即改回去——網址是結果不是輸入。
    // 也找不到可呼叫的地圖物件（window 上沒有任何具備 panTo/setCenter 的東西，
    // google.maps 也不存在）。可行的是對畫布送出滑鼠事件模擬拖曳，實測有效。

    // ════════════════════════════════════════════════════════════════
    // 地圖上的路線色帶
    // ════════════════════════════════════════════════════════════════

    /**
     * 路線上每一點歸給時間最近的那一列（取樣點），色帶就用那一列在這一欄的顏色。
     * 分界取相鄰兩列時間的中點，跟格線「一列代表一段路」的意思一致。
     */
    function assignPointsToNodes(timeline, nodes) {
        const out = new Int32Array(timeline.length);
        let k = 0;
        for (let i = 0; i < timeline.length; i++) {
            while (k < nodes.length - 1 && timeline[i].sec > (nodes[k].sec + nodes[k + 1].sec) / 2) k++;
            out[i] = k;
        }
        return out;
    }

    /** 目前視野下「經緯度 → 視窗座標」。地圖畫布一直是整個視窗，左側面板開關都不影響 */
    function screenProjector() {
        const canvas = findMapCanvas();
        const vp = readViewport();
        if (!canvas || !vp) return null;
        const r = canvas.getBoundingClientRect();
        const c = projectToPixel(vp.lat, vp.lon, vp.zoom);
        const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
        return (lat, lon) => {
            const p = projectToPixel(lat, lon, vp.zoom);
            return { x: cx + p.x - c.x, y: cy + p.y - c.y };
        };
    }

    /**
     * 色帶插在地圖畫布的正後面，當它的兄弟節點（只新增、不搬動 Google 的節點，01 第⑤條）。
     * 2026-11-24 真實頁面實測：畫布所在的容器是 z-index:0 的堆疊脈絡，後面還有地名那層畫布、
     * 路線時間小卡等 DOM——插在畫布後面，地名、側邊面板、縮放鈕、圖層縮圖自然都疊在色帶上面。
     * 掛在 body 用 fixed 的話，色帶會蓋過 Google 的側邊面板與所有控制項。拖動地圖後節點仍在。
     */
    function ensureRibbon() {
        const canvas = findMapCanvas();
        const rb = state.ribbon;
        if (rb && rb.el.isConnected && (!canvas || rb.el.parentElement === canvas.parentElement)) return rb;
        const el = rb ? rb.el : document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        el.id = PREFIX + '-ribbon';
        el.setAttribute('aria-hidden', 'true');
        el.style.cssText = 'left:0;top:0;pointer-events:none;overflow:visible;' +
            `transition:opacity ${RIBBON_FADE_MS}ms ease;opacity:${rb && rb.faded ? 0 : 1};` +
            (canvas ? 'position:absolute' : 'position:fixed;z-index:1');
        if (canvas) canvas.after(el); else document.body.appendChild(el);
        if (rb) { rb.cache = null; return rb; }
        state.ribbon = { el, drawnKey: null, seenKey: null, cache: null, faded: false, pressed: false, lastActivity: 0,
            pollKey: null, pollTimer: null };
        return state.ribbon;
    }

    function removeRibbon() {
        if (!state.ribbon) return;
        clearTimeout(state.ribbon.pollTimer);
        state.ribbon.el.remove();
        state.ribbon = null;
    }

    /** 路線投影到螢幕的點，依「這一段屬於哪一列」切成幾條；同一個視野只算一次 */
    function projectedRuns(view, rb) {
        const key = viewportKey() + '|' + innerWidth + 'x' + innerHeight;
        if (rb.cache && rb.cache.key === key && rb.cache.view === view) return rb.cache.runs;
        const proj = screenProjector();
        if (!proj) return null;
        const tl = view.timeline;
        const runs = [];
        let cur = null, last = null;
        for (let i = 0; i < tl.length; i++) {
            const node = view.pointNode[i];
            const p = proj(tl[i].lat, tl[i].lon);
            if (!cur || cur.node !== node) {
                // 新的一段從上一段的最後一點接起，兩段之間才不會斷開
                cur = { node, pts: last ? [last] : [] };
                runs.push(cur);
            } else if (i < tl.length - 1 && last &&
                Math.abs(p.x - last.x) < RIBBON_MIN_STEP_PX && Math.abs(p.y - last.y) < RIBBON_MIN_STEP_PX) {
                continue;
            }
            cur.pts.push(p);
            last = p;
        }
        rb.cache = { key, view, runs };
        return runs;
    }

    const svgPath = pts => pts.map((p, i) => (i ? 'L' : 'M') + p.x.toFixed(1) + ' ' + p.y.toFixed(1)).join('');


    const hexRgb = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
    const mixHex = (a, b, t) => {
        const A = hexRgb(a), B = hexRgb(b);
        return 'rgb(' + A.map((v, i) => Math.round(v + (B[i] - v) * t)).join(',') + ')';
    };
    /** 連續級數 x（0～3，可有小數）在色票上的顏色：相鄰兩級之間線性內插 */
    const colorAtLevel = (cols, x) => {
        const i = Math.min(cols.length - 2, Math.floor(x));
        return mixHex(cols[i], cols[i + 1], Math.min(1, Math.max(0, x - i)));
    };

    /**
     * 色帶的 SVG 圖層：光暈 → 外框 → 填色 → 掃描線。
     * runs：[{ pts:[{x,y}], level:0～3｜null(無資料) }]，相鄰兩段共用接點。
     *
     * 交界前後 RIBBON_BLEND_PX/2 內把級數當連續值內插，切成 RIBBON_PIECE_PX 小段各自上色；
     * 交界以外整段同色，合成一條 path（點數少，接縫也不會有圓頭疊出的深淺）。
     * 外框全部畫完才畫填色：外框的圓頭才不會壓到前一段的填色。
     * 無資料那段不內插（灰色混紫色沒有意義），也不發光。
     */
    function ribbonLayers(runs) {
        const pal = currentPalette();
        // 攤平成一條折線，記下每個點的累積長度與交界位置
        const pts = [], lv = [];
        const bounds = [];            // { s, from, to }
        let s = 0;
        runs.forEach((r, ri) => {
            // 交界＝這一段的第一個點，也就是上一段的最後一點
            if (ri > 0 && pts.length && runs[ri - 1].level !== r.level) {
                bounds.push({ s, from: runs[ri - 1].level, to: r.level });
            }
            r.pts.forEach((p, k) => {
                if (ri > 0 && k === 0 && pts.length) return;   // 接點跟上一段重複
                if (pts.length) s += Math.hypot(p.x - pts[pts.length - 1].x, p.y - pts[pts.length - 1].y);
                pts.push({ x: p.x, y: p.y, s });
                lv.push(r.level);
            });
        });
        const half = RIBBON_BLEND_PX / 2;
        // 某距離的級數：交界附近線性過渡；有一邊是無資料就硬接
        const levelAt = (d, own) => {
            for (const b of bounds) {
                if (b.from == null || b.to == null) continue;
                if (Math.abs(d - b.s) < half) return b.from + (b.to - b.from) * (d - (b.s - half)) / RIBBON_BLEND_PX;
            }
            return own;
        };
        // 切小段：交界附近每 RIBBON_PIECE_PX 一段，其他整條線段一段
        const pieces = [];            // { a:{x,y}, b:{x,y}, x }
        for (let i = 1; i < pts.length; i++) {
            const p0 = pts[i - 1], p1 = pts[i];
            const len = p1.s - p0.s;
            if (len <= 0) continue;
            const own = lv[i];
            const near = bounds.some(b => b.from != null && b.to != null && p0.s < b.s + half && p1.s > b.s - half);
            const n = near ? Math.max(1, Math.ceil(len / RIBBON_PIECE_PX)) : 1;
            for (let k = 0; k < n; k++) {
                const t0 = k / n, t1 = (k + 1) / n;
                const a = { x: p0.x + (p1.x - p0.x) * t0, y: p0.y + (p1.y - p0.y) * t0 };
                const b = { x: p0.x + (p1.x - p0.x) * t1, y: p0.y + (p1.y - p0.y) * t1 };
                pieces.push({ a, b, x: own == null ? null : levelAt(p0.s + len * (t0 + t1) / 2, own) });
            }
        }
        // 相鄰同色的小段合成一條 path
        const groups = [];
        for (const pc of pieces) {
            const key = pc.x == null ? 'na' : pc.x.toFixed(2);
            const g = groups[groups.length - 1];
            if (g && g.key === key) g.d.push('L' + pc.b.x.toFixed(1) + ' ' + pc.b.y.toFixed(1));
            else groups.push({ key, x: pc.x, d: ['M' + pc.a.x.toFixed(1) + ' ' + pc.a.y.toFixed(1),
                'L' + pc.b.x.toFixed(1) + ' ' + pc.b.y.toFixed(1)] });
        }
        const cap = 'fill="none" stroke-linecap="round" stroke-linejoin="round"';
        // 光暈的小段用平頭：半透明的圓頭彼此重疊會疊出更亮的點（交界處一顆顆亮斑），模糊後看不出缺角
        const capButt = 'fill="none" stroke-linecap="butt" stroke-linejoin="round"';
        const layer = (w, colFn, extra, caps = cap) => groups.map(g => {
            const col = colFn(g.x);
            return col ? `<path d="${g.d.join('')}" stroke="${col}" stroke-width="${w}" ${caps} ${extra(g.x) || ''}/>` : '';
        }).join('');
        const out = [];
        const id = PREFIX + '-rb';
        out.push(`<defs><filter id="${id}-glow" x="-50%" y="-50%" width="200%" height="200%">` +
            `<feGaussianBlur stdDeviation="${RIBBON_GLOW_BLUR_PX}"/></filter>` +
            `<pattern id="${id}-scan" width="4" height="${RIBBON_SCAN_PITCH_PX}" patternUnits="userSpaceOnUse">` +
            `<rect width="4" height="1" fill="#000" fill-opacity="${RIBBON_SCAN_ALPHA}"/></pattern>` +
            `<mask id="${id}-mask"><path d="${svgPath(pts)}" stroke="#fff" stroke-width="${RIBBON_FRAME_W_PX}" ${cap}/></mask></defs>`);
        // 光暈：強度依連續級數內插（第 1 級也有）
        const alphaAt = x => {
            const i = Math.min(2, Math.floor(x));
            return RIBBON_GLOW_ALPHA[i] + (RIBBON_GLOW_ALPHA[i + 1] - RIBBON_GLOW_ALPHA[i]) * Math.min(1, x - i);
        };
        out.push(`<g filter="url(#${id}-glow)">` + layer(RIBBON_FRAME_W_PX + RIBBON_GLOW_EXTRA_PX,
            x => x == null ? null : pal.fill[2], x => `stroke-opacity="${alphaAt(x).toFixed(2)}"`, capButt) + '</g>');
        out.push(layer(RIBBON_FRAME_W_PX, x => x == null ? RAIN_NA_OUT : colorAtLevel(pal.out, x), () => ''));
        out.push(layer(RIBBON_W_PX, x => x == null ? RAIN_NA_COLOR : colorAtLevel(pal.fill, x), () => ''));
        // S1 掃描線：整片橫線，只留色帶範圍內
        if (pts.length > 1) {
            const xs = pts.map(p => p.x), ys = pts.map(p => p.y), pad = RIBBON_FRAME_W_PX;
            const x0 = Math.min(...xs) - pad, y0 = Math.min(...ys) - pad;
            out.push(`<rect x="${x0.toFixed(0)}" y="${y0.toFixed(0)}" width="${(Math.max(...xs) + pad - x0).toFixed(0)}" ` +
                `height="${(Math.max(...ys) + pad - y0).toFixed(0)}" fill="url(#${id}-scan)" mask="url(#${id}-mask)"/>`);
        }
        return out;
    }

    /** 照目前顯示的那一欄重畫色帶；指到某格時另外標出那個點 */
    function drawRibbon() {
        const view = state.view;
        if (!state.active || !view || !view.timeline || !view.timeline.length) {
            if (state.ribbon) state.ribbon.el.innerHTML = '';
            return;
        }
        const rb = ensureRibbon();
        // 對不上 Google 畫面上那條時寧可不畫，也不畫錯的
        if (state.routeMismatch) { rb.el.innerHTML = ''; return; }
        // 進了街景之類路線地圖不在的畫面：色帶收起來，資料留著
        rb.el.style.display = mapShowsRoute() ? '' : 'none';
        if (rb.faded) return;                      // 地圖操作中，等穩定後由 settleRibbon 重畫
        const runs = projectedRuns(view, rb);
        if (!runs) { rb.el.innerHTML = ''; return; }
        // 投影出來的是視窗座標；色帶在畫布的容器裡，要扣掉容器的位置（實測是 0,0，但不寫死）
        const host = rb.el.parentElement.getBoundingClientRect();
        const ox = rb.el.style.position === 'fixed' ? 0 : host.left;
        const oy = rb.el.style.position === 'fixed' ? 0 : host.top;
        rb.el.setAttribute('width', Math.round(rb.el.style.position === 'fixed' ? innerWidth : host.width));
        rb.el.setAttribute('height', Math.round(rb.el.style.position === 'fixed' ? innerHeight : host.height));
        rb.el.setAttribute('viewBox', `${ox} ${oy} ${rb.el.getAttribute('width')} ${rb.el.getAttribute('height')}`);
        const ci = shownColumn(view);
        const parts = [];
        parts.push(...ribbonLayers(runs.map(r => {
            const c = view.cells[r.node][ci];
            return { pts: r.pts, level: c ? c.level : null };
        })));
        if (view.hoverRow != null && view.hoverCol != null) {
            const n = view.nodes[view.hoverRow];
            const proj = screenProjector();
            if (proj) {
                const p = proj(n.lat, n.lon);
                parts.push(`<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${MARK_R_PX}" fill="#fff" ` +
                    `fill-opacity=".85" stroke="#202124" stroke-width="3"/>` +
                    `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="4" fill="#202124"/>`);
            }
        }
        rb.el.innerHTML = parts.join('');
        rb.drawnKey = viewportKey();
    }

    /**
     * 地圖被操作了：先淡出，等網址穩定再重畫。
     * 網址是唯一讀得到的視野來源，拖動中它不會變——拿舊網址畫只會跟地圖錯開。
     * @param pressed 是按下（拖動可能還在進行，放開前都不重畫）
     */
    function noteMapActivity(pressed) {
        const rb = state.ribbon;
        if (!rb) return;
        if (pressed) rb.pressed = true;
        rb.lastActivity = Date.now();
        if (!rb.faded) { rb.faded = true; rb.el.style.opacity = '0'; }
        if (!rb.pollTimer) rb.pollTimer = setTimeout(settleRibbon, RIBBON_POLL_MS);
    }

    function settleRibbon() {
        const rb = state.ribbon;
        if (!rb) return;
        rb.pollTimer = null;
        const key = viewportKey();
        const quiet = !rb.pressed && Date.now() - rb.lastActivity >= RIBBON_IDLE_MS;
        if (!quiet || key !== rb.pollKey) {
            rb.pollKey = key;
            rb.pollTimer = setTimeout(settleRibbon, RIBBON_POLL_MS);
            return;
        }
        rb.faded = false;
        drawRibbon();
        rb.el.style.opacity = '1';
    }

    // ════════════════════════════════════════════════════════════════
    // 開啟時把整條路線移進面板上方的可見區
    // ════════════════════════════════════════════════════════════════

    /** 可見區：面板上緣以上、右側讓給 Google 控制項的那塊 */
    function visibleMapArea() {
        const top = FIT_MARGIN_PX;
        const panelTop = state.panel ? state.panel.getBoundingClientRect().top : innerHeight;
        return {
            left: FIT_MARGIN_PX, top,
            right: innerWidth - PANEL_RIGHT_GAP_PX - FIT_MARGIN_PX,
            bottom: Math.max(top + 100, panelTop - FIT_MARGIN_PX),
        };
    }

    /** 路線外框在目前視野下的螢幕範圍 */
    // ── 點格子：把地圖移到那個點並拉近（從 v0.77.0 照原樣搬回來）──
    //
    // 目標必須是「畫面（畫布）中心」，不能改成別的點：Google 的滾輪縮放以畫面中心為錨點，
    // 只有停在中心的點拉近時不會跑掉。改成別的點（例如底部面板上方的可見區中心），
    // 偏移在拉近 N 級時放大 2^N 倍——v1.4.0 就這樣改過，從 11 級拉到 17 級時偏了幾千 px、
    // 要點兩次才對準。面板蓋不到畫面中心（實測面板上緣 773、中心 476，視窗高 953）。
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
            /** 目標相對於畫面中心的像素位移（必須是畫面中心，見本段開頭：縮放錨點） */
            offsetTo(lat, lon) {
                const c = projectToPixel(this.lat, this.lon, this.zoom);
                const t = projectToPixel(lat, lon, this.zoom);
                return { dx: c.x - t.x, dy: c.y - t.y };
            },
        };
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
    async function correctIfNeeded(canvas, lat, lon, alive = () => true) {
        // ── 第一步：確認縮放到位，不到就補 ──
        // 動作本身已經等過視野反映，這裡直接讀值即可
        let settled = lastSettled;
        for (let z = 0; z < 3; z++) {
            const vp = readViewport();
            if (!vp) break;
            const diff = MAP_FOCUS_ZOOM - vp.zoom;
            if (Math.abs(diff) <= ZOOM_TOLERANCE) break;
            writeDiag({ step: 'zoom-fix', round: z, realZoom: vp.zoom, need: +diff.toFixed(2) });
            if (!alive()) return null;   // 換了點、或離開路線地圖（例如進街景）就停手
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
            if (!alive()) return null;   // 換了點、或離開路線地圖（例如進街景）就停手
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
        // 動畫要好幾秒：期間又點了別的格子，或離開路線地圖（進街景、點地點；見 applyPageMode），
        // 這一趟就停手——不然它會在街景裡繼續拖、把網址改回路線（v1.4.0 無頭測試抓到）
        const seq = ++state.focusSeq;
        const alive = () => seq === state.focusSeq;
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
            if (!alive()) return;   // 換了點、或離開路線地圖（例如進街景）就停手
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
            if (!alive()) return;   // 換了點、或離開路線地圖（例如進街景）就停手
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
        if (!alive()) return;   // 換了點、或離開路線地圖（例如進街景）就停手
        const applied = await smoothZoom(canvas, MAP_FOCUS_ZOOM - model.zoom);
        model.applyZoom(applied);
        writeDiag({ step: 'after-zoom-in', settled: lastSettled,
            modelZoom: +model.zoom.toFixed(2),
            realZoom: (readViewport() || {}).zoom });

        // ④ 動畫全部結束後才讀真實視野、校正累積誤差。
        //    只在這裡等一次，而不是每個階段都等。
        const finalDist = await correctIfNeeded(canvas, lat, lon, alive);
        const vpEnd = readViewport();
        writeDiag({
            step: 'done', target: [+lat.toFixed(5), +lon.toFixed(5)],
            screens: +screens.toFixed(2), arcZoomOut: arcOut, pans,
            modelZoom: +model.zoom.toFixed(2), realZoom: vpEnd ? vpEnd.zoom : null,
            finalDistPx: finalDist === null ? null : Math.round(finalDist),
            errorKm: vpEnd ? +(haversine(vpEnd.lat, vpEnd.lon, lat, lon) / 1000).toFixed(3) : null,
        });
    }

    function routeScreenBox(timeline) {
        const proj = screenProjector();
        if (!proj) return null;
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const t of timeline) {
            const p = proj(t.lat, t.lon);
            if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
            if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
        }
        return { minX, minY, maxX, maxY, cx: (minX + maxX) / 2, cy: (minY + maxY) / 2 };
    }

    /** 把路線中心拖到可見區中心；拖曳一次有行程上限，所以讀實際視野重複幾次 */
    async function panRouteToArea(canvas, timeline) {
        for (let i = 0; i < PAN_MAX_ITERATIONS; i++) {
            const box = routeScreenBox(timeline);
            if (!box) return;
            const a = visibleMapArea();
            const dx0 = (a.left + a.right) / 2 - box.cx;
            const dy0 = (a.top + a.bottom) / 2 - box.cy;
            if (Math.hypot(dx0, dy0) <= PAN_TOLERANCE_PX) return;
            const r = canvas.getBoundingClientRect();
            const dx = Math.max(-r.width * DRAG_MAX_SCREENS, Math.min(r.width * DRAG_MAX_SCREENS, dx0));
            const dy = Math.max(-r.height * DRAG_MAX_SCREENS, Math.min(r.height * DRAG_MAX_SCREENS, dy0));
            await smoothPan(canvas, dx, dy, PAN_MIN_MS, findPressPoint(canvas, dx, dy));
            if (!lastSettled) return;              // 網址沒反映，再拖只會越拖越偏
        }
    }

    async function fitRouteIntoView() {
        const view = state.view;
        const canvas = findMapCanvas();
        const vp = readViewport();
        if (!view || !canvas || !vp || !view.timeline || view.timeline.length < 2) return;
        const tl = view.timeline;
        document.documentElement.removeAttribute('data-' + PREFIX + '-log');   // 每次打開重新記錄
        const box = routeScreenBox(tl);
        const a = visibleMapArea();
        const w = Math.max(1, box.maxX - box.minX), h = Math.max(1, box.maxY - box.minY);
        const fit = vp.zoom + Math.log2(Math.min((a.right - a.left) / w, (a.bottom - a.top) / h));
        const target = Math.max(MIN_WORK_ZOOM, Math.min(FIT_MAX_ZOOM, fit));
        const inside = box.minX >= a.left && box.maxX <= a.right && box.minY >= a.top && box.maxY <= a.bottom;
        const routeKey = routeSignature(location.href);
        writeDiag({ step: 'fit-plan', zoom: vp.zoom, target: +target.toFixed(2), inside,
            box: [box.minX, box.minY, box.maxX, box.maxY].map(Math.round), area: [a.left, a.top, a.right, a.bottom] });
        // 已經整條在可見區、而且不會小到看不清楚（再拉近不到一級）就不動
        if (inside && target - vp.zoom < 1) return;
        // 拉近前先平移：拉近以畫布中心為錨點，先把路線帶到中間，拉近後才不會跑出畫面
        if (target > vp.zoom) await panRouteToArea(canvas, tl);
        if (Math.abs(target - vp.zoom) > ZOOM_TOLERANCE) await smoothZoom(canvas, target - vp.zoom);
        await panRouteToArea(canvas, tl);
        if (routeSignature(location.href) !== routeKey) warn('移動地圖時路線被改動了（拖到路線？）');
        const end = readViewport();
        writeDiag({ step: 'fit-done', zoom: end ? end.zoom : null, box: (() => {
            const b = routeScreenBox(tl); return b ? [b.minX, b.minY, b.maxX, b.maxY].map(Math.round) : null; })() });
    }

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
/** Web Mercator 反投影：世界像素座標 → 經緯度。點格子移動地圖時維護自有視野模型要用 */
    function unprojectFromPixel(x, y, zoom) {
        const world = 256 * Math.pow(2, zoom);
        const lon = x / world * 360 - 180;
        const n = Math.PI - 2 * Math.PI * y / world;
        const lat = 180 / Math.PI * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
        return { lat, lon };
    }

        function projectToPixel(lat, lon, zoom) {
        const world = 256 * Math.pow(2, zoom);
        const x = (lon + 180) / 360 * world;
        const s = Math.sin(lat * Math.PI / 180);
        const y = (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * world;
        return { x, y };
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
                applyPageMode(detectPageMode());
                // 左側面板開關、視窗大小變了才重排：這裡每次 DOM 變動都會跑，重排會強制版面計算
                const lk = sidebarRightEdge() + '|' + innerWidth;
                if (lk !== state.layoutKey) { state.layoutKey = lk; layoutPanel(); }
                // Google 自己移動地圖（點地點、按縮放鈕、鍵盤）時網址的 @ 會變，色帶要跟著重畫。
                // 只在網址「這次跟上次看到的不同」時才算一次操作：Google 的 DOM 一直在變，
                // 拿「跟畫的時候不同」判斷的話，每次變動都會把等待重新計時，色帶永遠回不來
                const rb = state.ribbon;
                const vk = viewportKey();
                if (rb && vk !== rb.seenKey) {
                    rb.seenKey = vk;
                    if (vk !== rb.drawnKey) noteMapActivity(false);
                }
                scheduleRerunIfRouteChanged();
            });
        };
        // 也看 aria-label：Google 左側面板開關時，開關鈕只換 aria-label（收合↔展開），
        // 不一定有節點增減——不看的話底部面板不會讓位
        new MutationObserver(schedule).observe(document.body,
            { childList: true, subtree: true, attributes: true, attributeFilter: ['aria-label'] });
        window.addEventListener('resize', schedule);
        window.addEventListener('scroll', schedule, true);

        // 視窗尺寸變動時重排面板——跟上面的 schedule 分開，因為 schedule 也會被
        // 面板自己內部的捲動觸發（scroll 監聽用了 capture），不需要每次都重排。
        window.addEventListener('resize', () => { if (state.active) { layoutPanel(); drawRibbon(); } });
        // 地圖一被操作就淡出色帶：按下（拖動）、滾輪、方向鍵與 +／−。
        // 自己面板裡的操作不算；按住期間不重畫，放開後才開始等網址穩定。
        const onActivity = ev => {
            if (!state.active || !state.ribbon) return;
            if (state.panel && state.panel.contains(ev.target)) return;
            if (ev.type === 'keydown' && !/^(Arrow|\+|-|=|PageUp|PageDown)/.test(ev.key)) return;
            noteMapActivity(ev.type === 'pointerdown' || ev.type === 'mousedown');
        };
        ['pointerdown', 'mousedown', 'wheel', 'keydown'].forEach(t =>
            window.addEventListener(t, onActivity, { capture: true, passive: true }));
        ['pointerup', 'mouseup', 'pointercancel'].forEach(t => window.addEventListener(t, () => {
            if (state.ribbon && state.ribbon.pressed) { state.ribbon.pressed = false; noteMapActivity(false); }
        }, { capture: true, passive: true }));

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
