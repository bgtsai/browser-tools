// ==UserScript==
// @name         Claude 額度冷卻翻頁鐘
// @namespace    https://github.com/bgtsai/browser-tools
// @version      1.18.2
// @description  Claude.ai 額度用完時，全螢幕顯示翻頁鐘倒數剩餘冷卻時間
// @author       bgtsai
// @match        https://claude.ai/*
// @grant        unsafeWindow
// @grant        GM_registerMenuCommand
// @grant        GM_setValue
// @grant        GM_getValue
// @run-at       document-idle
// @downloadURL  https://raw.githubusercontent.com/bgtsai/browser-tools/main/cooldown-flipclock/CooldownFlipClock.user.js
// @updateURL    https://raw.githubusercontent.com/bgtsai/browser-tools/main/cooldown-flipclock/CooldownFlipClock.user.js
// @license      MIT
// ==/UserScript==

/*
 * ============================================================
 * 開發階段說明（Phase 1）
 * ============================================================
 * 這一版只做「翻頁鐘元件本體」，偵測 Claude.ai 額度用完的邏輯還沒接上。
 * 測試方式：在 Console 執行 __cfcTest(秒數)，例如：
 *   __cfcTest(90000)   // 模擬還剩 25 小時
 *   __cfcTest(5000)    // 模擬還剩 1 小時 23 分
 *   __cfcTest(90)      // 模擬還剩 1 分 30 秒
 * 會立刻用假的目標時間開出全螢幕翻頁鐘。
 *
 * 下一階段（Phase 2）要做的事：
 *   1. DOM 監看 Claude.ai 跳出「已達用量上限」提示的文字/元素（優先）
 *   2. Hook fetch/XHR，攔截傳送訊息時若回應為額度限制錯誤，取出 resets_at 當 backup
 *   兩者都命中同一個「額度用完」事件時，取得 resets_at（或畫面上顯示的重置時間）
 *   換算成 unix timestamp，呼叫 CFC.show(epochSeconds) 即可。
 * ============================================================
 */

(function () {
  "use strict";

  // 真正的頁面 window（跳脫 Tampermonkey 沙盒）。@grant unsafeWindow 會讓腳本跑在獨立沙盒，
  // 沙盒裡的 window 跟頁面實際的 window 是兩個不同物件——覆寫 fetch/XHR 這類要攔截「頁面自己呼叫」
  // 的內建函式，一定要用 unsafeWindow，用 window 只會覆寫到沙盒自己的副本，攔截不到頁面真正的請求。
  const target = typeof unsafeWindow !== "undefined" ? unsafeWindow : window;

  /* ------------------------------------------------------------
   * 使用者設定：直接改這裡
   * ------------------------------------------------------------ */
  // 翻頁鐘配色主題預設值："dark"（黑底白字）或 "light"（白底黑字）——
  // 這只是「還沒有任何持久化選擇時」的初始值，畫面上的膠囊開關切換後會覆蓋，並記住使用者的選擇。
  // 注意：主題只影響翻頁鐘本體的配色，全螢幕遮罩（蓋住頁面背景的那層）固定維持不透明黑色，不受這個設定影響。
  const CFC_THEME = "dark";
  const THEME_STORAGE_KEY = "cfc_theme";

  // 用量到這個百分比視為「這個視窗已經用盡」——沒有官方文件保證確切門檻，這是保守估計值。
  // 短週期（five_hour）跟長週期（seven_day）各自獨立一個參數，不共用同一個數字——
  // 兩個視窗的特性可能不一樣，之後如果只有其中一個誤判，可以只調那一個，不會互相牽動。
  const EXHAUST_THRESHOLD_SHORT = 97; // 短週期（five_hour）
  const EXHAUST_THRESHOLD_LONG = 97;  // 長週期（seven_day）

  function getCurrentTheme() {
    if (typeof GM_getValue !== "undefined") {
      return GM_getValue(THEME_STORAGE_KEY, CFC_THEME);
    }
    return CFC_THEME;
  }
  function setCurrentTheme(theme) {
    if (typeof GM_setValue !== "undefined") {
      GM_setValue(THEME_STORAGE_KEY, theme);
    }
  }

  /* ------------------------------------------------------------
   * 翻頁鐘核心：vendored from PButcher/flipdown v0.3.2 (MIT License)
   * https://github.com/PButcher/flipdown
   * 原始碼未修改（僅由 babel 編譯後的 dist/flipdown.min.js 直接內嵌），
   * 選擇這支函式庫的理由：純 JS/CSS、無外部相依、<11KB、CSS transition 驅動翻頁動畫。
   * 我們的客製化（顯示哪兩組欄位、全螢幕外殼）全部寫在下面的 CFC 命名空間裡，
   * 不碰這段原始碼本身，方便之後要更新上游版本時直接整段替換。
   * ------------------------------------------------------------ */
  /* eslint-disable */
  !(function () {
    "use strict";
    function _typeof(a) {
      return (
        (_typeof =
          "function" == typeof Symbol && "symbol" == typeof Symbol.iterator
            ? function (a) {
                return typeof a;
              }
            : function (a) {
                return a &&
                  "function" == typeof Symbol &&
                  a.constructor === Symbol &&
                  a !== Symbol.prototype
                  ? "symbol"
                  : typeof a;
              }),
        _typeof(a)
      );
    }
    function _classCallCheck(a, b) {
      if (!(a instanceof b))
        throw new TypeError("Cannot call a class as a function");
    }
    function _defineProperties(a, b) {
      for (var c, d = 0; d < b.length; d++)
        (c = b[d]),
          (c.enumerable = c.enumerable || !1),
          (c.configurable = !0),
          "value" in c && (c.writable = !0),
          Object.defineProperty(a, c.key, c);
    }
    function _createClass(a, b, c) {
      return b && _defineProperties(a.prototype, b), c && _defineProperties(a, c), a;
    }
    var FlipDown = (function () {
      var b = Math.floor;
      function a(b) {
        var c = 1 < arguments.length && void 0 !== arguments[1] ? arguments[1] : "flipdown",
          d = 2 < arguments.length && void 0 !== arguments[2] ? arguments[2] : {};
        if (
          (_classCallCheck(this, a),
          "number" != typeof b)
        )
          throw new Error(
            "FlipDown: Constructor expected unix timestamp, got ".concat(_typeof(b), " instead."),
          );
        "object" === _typeof(c) && ((d = c), (c = "flipdown")),
          (this.version = "0.3.2"),
          (this.initialised = !1),
          (this.now = this._getTime()),
          (this.epoch = b),
          (this.countdownEnded = !1),
          (this.hasEndedCallback = null),
          (this.element = document.getElementById(c)),
          (this.rotors = []),
          (this.rotorLeafFront = []),
          (this.rotorLeafRear = []),
          (this.rotorTops = []),
          (this.rotorBottoms = []),
          (this.countdown = null),
          (this.daysRemaining = 0),
          (this.clockValues = {}),
          (this.clockStrings = {}),
          (this.clockValuesAsString = []),
          (this.prevClockValuesAsString = []),
          (this.opts = this._parseOptions(d)),
          this._setOptions();
      }
      return (
        _createClass(a, [
          {
            key: "start",
            value: function a() {
              return (
                this.initialised || this._init(),
                (this.countdown = setInterval(this._tick.bind(this), 1e3)),
                this
              );
            },
          },
          {
            key: "ifEnded",
            value: function b(a) {
              return (
                (this.hasEndedCallback = function () {
                  a(), (this.hasEndedCallback = null);
                }),
                this
              );
            },
          },
          {
            key: "_getTime",
            value: function a() {
              return new Date().getTime() / 1e3;
            },
          },
          {
            key: "_hasCountdownEnded",
            value: function a() {
              return 0 > this.epoch - this.now
                ? ((this.countdownEnded = !0),
                  null != this.hasEndedCallback &&
                    (this.hasEndedCallback(), (this.hasEndedCallback = null)),
                  !0)
                : ((this.countdownEnded = !1), !1);
            },
          },
          {
            key: "_parseOptions",
            value: function c(a) {
              var b = ["Days", "Hours", "Minutes", "Seconds"];
              return (
                a.headings && 4 === a.headings.length && (b = a.headings),
                { theme: a.hasOwnProperty("theme") ? a.theme : "dark", headings: b }
              );
            },
          },
          {
            key: "_setOptions",
            value: function a() {
              this.element.classList.add("flipdown__theme-".concat(this.opts.theme));
            },
          },
          {
            key: "_init",
            value: function h() {
              (this.initialised = !0),
                (this.daysremaining = this._hasCountdownEnded()
                  ? 0
                  : b((this.epoch - this.now) / 86400).toString().length);
              for (
                var a = 2 >= this.daysremaining ? 2 : this.daysremaining, c = 0;
                c < a + 6;
                c++
              )
                this.rotors.push(this._createRotor(0));
              for (var d = [], c = 0; c < a; c++) d.push(this.rotors[c]);
              this.element.appendChild(this._createRotorGroup(d, 0));
              for (var e, f = a, c = 0; 3 > c; c++) {
                e = [];
                for (var g = 0; 2 > g; g++) e.push(this.rotors[f]), f++;
                this.element.appendChild(this._createRotorGroup(e, c + 1));
              }
              return (
                (this.rotorLeafFront = Array.prototype.slice.call(
                  this.element.getElementsByClassName("rotor-leaf-front"),
                )),
                (this.rotorLeafRear = Array.prototype.slice.call(
                  this.element.getElementsByClassName("rotor-leaf-rear"),
                )),
                (this.rotorTop = Array.prototype.slice.call(
                  this.element.getElementsByClassName("rotor-top"),
                )),
                (this.rotorBottom = Array.prototype.slice.call(
                  this.element.getElementsByClassName("rotor-bottom"),
                )),
                this._tick(),
                this._updateClockValues(!0),
                this
              );
            },
          },
          {
            key: "_createRotorGroup",
            value: function e(a, b) {
              var c = document.createElement("div");
              c.className = "rotor-group";
              var d = document.createElement("div");
              return (
                (d.className = "rotor-group-heading"),
                d.setAttribute("data-before", this.opts.headings[b]),
                c.appendChild(d),
                appendChildren(c, a),
                c
              );
            },
          },
          {
            key: "_createRotor",
            value: function h() {
              var a = 0 < arguments.length && void 0 !== arguments[0] ? arguments[0] : 0,
                b = document.createElement("div"),
                c = document.createElement("div"),
                d = document.createElement("figure"),
                e = document.createElement("figure"),
                f = document.createElement("div"),
                g = document.createElement("div");
              return (
                (b.className = "rotor"),
                (c.className = "rotor-leaf"),
                (d.className = "rotor-leaf-rear"),
                (e.className = "rotor-leaf-front"),
                (f.className = "rotor-top"),
                (g.className = "rotor-bottom"),
                (d.textContent = a),
                (f.textContent = a),
                (g.textContent = a),
                appendChildren(b, [c, f, g]),
                appendChildren(c, [d, e]),
                b
              );
            },
          },
          {
            key: "_tick",
            value: function c() {
              this.now = this._getTime();
              var a = 0 >= this.epoch - this.now ? 0 : this.epoch - this.now;
              (this.clockValues.d = b(a / 86400)),
                (a -= 86400 * this.clockValues.d),
                (this.clockValues.h = b(a / 3600)),
                (a -= 3600 * this.clockValues.h),
                (this.clockValues.m = b(a / 60)),
                (a -= 60 * this.clockValues.m),
                (this.clockValues.s = b(a)),
                this._updateClockValues(),
                this._onTick && this._onTick(),
                this._hasCountdownEnded();
            },
          },
          {
            key: "_updateClockValues",
            value: function e() {
              function a() {
                var a = this;
                this.rotorTop.forEach(function (b, c) {
                  b.textContent != a.clockValuesAsString[c] &&
                    (b.textContent = a.clockValuesAsString[c]);
                });
              }
              function b() {
                var a = this;
                this.rotorLeafRear.forEach(function (b, c) {
                  if (b.textContent != a.clockValuesAsString[c]) {
                    (b.textContent = a.clockValuesAsString[c]),
                      b.parentElement.classList.add("flipped");
                    var d = setInterval(
                      function () {
                        b.parentElement.classList.remove("flipped"), clearInterval(d);
                      }.bind(a),
                      500,
                    );
                  }
                });
              }
              var c = this,
                d = !!(0 < arguments.length && void 0 !== arguments[0]) && arguments[0];
              (this.clockStrings.d = pad(this.clockValues.d, 2)),
                (this.clockStrings.h = pad(this.clockValues.h, 2)),
                (this.clockStrings.m = pad(this.clockValues.m, 2)),
                (this.clockStrings.s = pad(this.clockValues.s, 2)),
                (this.clockValuesAsString = (
                  this.clockStrings.d + this.clockStrings.h + this.clockStrings.m + this.clockStrings.s
                ).split("")),
                this.rotorLeafFront.forEach(function (a, b) {
                  a.textContent = c.prevClockValuesAsString[b];
                }),
                this.rotorBottom.forEach(function (a, b) {
                  a.textContent = c.prevClockValuesAsString[b];
                }),
                d
                  ? (a.call(this), b.call(this))
                  : (setTimeout(a.bind(this), 500), setTimeout(b.bind(this), 500)),
                (this.prevClockValuesAsString = this.clockValuesAsString);
            },
          },
        ]),
        a
      );
    })();
    function pad(a, b) {
      return (a = a.toString()), a.length < b ? pad("0" + a, b) : a;
    }
    function appendChildren(a, b) {
      b.forEach(function (b) {
        a.appendChild(b);
      });
    }
    (window.__CFC_FlipDown = FlipDown);
  })();
  /* eslint-enable */

  /* ------------------------------------------------------------
   * 樣式：vendored from PButcher/flipdown src/flipdown.css (MIT License)，
   * 僅調整尺寸與配色以符合全螢幕呈現，翻頁動畫邏輯（transform/transition）未變動。
   * 另外加上我們自訂的全螢幕外殼樣式、以及「依 phase 隱藏兩組欄位」的規則。
   * ------------------------------------------------------------ */
  const style = document.createElement("style");
  style.textContent = `
    /* ===== 尺寸網格 =====
     * 全部尺寸／間距先在 1920px 寬的設計基準下敲定為 8px 網格的整數倍，
     * 再換算成 vw 讓整體跟著可視區域寬度等比縮放（不是寫死 px）。
     * --cfc-u 代表「1 個網格單位」= 8px（在 1920px 寬時），
     * 下面每個尺寸都寫成 calc(var(--cfc-u) * N)，N 即為「幾個 8px」，方便之後要調整網格基準時只改一個變數。
     * 換算：N(單位) × 8px ÷ 1920px × 100 = N × 0.41667vw
     */
    /* ===== vendored flipdown 主題（改為單一自訂配色，取消 dark/light 切換） ===== */
    #cfc-flipdown.flipdown {
      overflow: visible;
      display: inline-block;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      font-weight: 700;
    }
    #cfc-flipdown .rotor-group {
      position: relative;
      float: left;
      padding-right: var(--cfc-group-gap, calc(var(--cfc-u) * 15)); /* 120px 保底，JS 量測後會覆蓋成實際值 */
    }
    #cfc-flipdown .rotor-group:last-child { padding-right: 0; }
    #cfc-flipdown .rotor-group-heading:before {
      display: block;
      height: calc(var(--cfc-u) * 14); /* 112px */
      line-height: calc(var(--cfc-u) * 14);
      text-align: center;
      content: attr(data-before);
      font-size: calc(var(--cfc-u) * 3); /* 24px */
      letter-spacing: 0.2em;
      color: rgba(255,255,255,0.55);
      font-weight: 500;
    }
    #cfc-flipdown .rotor {
      position: relative;
      float: left;
      width: calc(var(--cfc-u) * 30);  /* 240px */
      height: calc(var(--cfc-u) * 44); /* 352px（÷2＝176px，整除 8px，翻頁上下半才會精準對齊） */
      margin: 0 calc(var(--cfc-u) * 2) 0 0; /* 16px */
      border-radius: calc(var(--cfc-u) * 3); /* 24px */
      font-size: calc(var(--cfc-u) * 32); /* 256px */
      text-align: center;
      perspective: calc(var(--cfc-u) * 100); /* 800px（原 288px）——加大透視距離，減少翻頁時「靠近放大」的畸變感 */
    }
    #cfc-flipdown .rotor:last-child { margin-right: 0; }
    #cfc-flipdown .rotor-top,
    #cfc-flipdown .rotor-bottom {
      overflow: hidden;
      position: absolute;
      width: calc(var(--cfc-u) * 30);  /* 240px */
      height: calc(var(--cfc-u) * 22); /* 176px */
      /* 永久停留在 GPU 合成層，跟 rotor-leaf（因為有 transform + preserve-3d 而被提升到合成層的翻頁葉片）
         用同一種渲染路徑——兩種路徑對文字的次像素定位處理方式不同，動畫結束時從葉片切換回這裡顯示，
         文字落點會相差不到 1px，肉眼看起來就是往上跳一下。統一渲染路徑後就不會有這個落差。 */
      transform: translateZ(0);
    }
    #cfc-flipdown .rotor-leaf {
      z-index: 1;
      position: absolute;
      width: calc(var(--cfc-u) * 30);  /* 240px */
      height: calc(var(--cfc-u) * 44); /* 352px */
      transform-style: preserve-3d;
      transition: transform 0s;
    }
    #cfc-flipdown .rotor-leaf.flipped {
      transform: rotateX(-180deg);
      transition: all 0.5s ease-in-out;
    }
    #cfc-flipdown .rotor-leaf-front,
    #cfc-flipdown .rotor-leaf-rear {
      overflow: hidden;
      position: absolute;
      width: calc(var(--cfc-u) * 30);  /* 240px */
      height: calc(var(--cfc-u) * 22); /* 176px */
      margin: 0;
      transform: rotateX(0deg);
      backface-visibility: hidden;
      -webkit-backface-visibility: hidden;
    }
    #cfc-flipdown .rotor-leaf-front { line-height: calc(var(--cfc-u) * 44); border-radius: calc(var(--cfc-u) * 3) calc(var(--cfc-u) * 3) 0 0; }
    #cfc-flipdown .rotor-leaf-rear  { line-height: 0;     border-radius: 0 0 calc(var(--cfc-u) * 3) calc(var(--cfc-u) * 3); transform: rotateX(-180deg); }
    #cfc-flipdown .rotor-top    { line-height: calc(var(--cfc-u) * 44); border-radius: calc(var(--cfc-u) * 3) calc(var(--cfc-u) * 3) 0 0; }
    #cfc-flipdown .rotor-bottom {
      bottom: 0;
      line-height: 0;
      border-radius: 0 0 calc(var(--cfc-u) * 3) calc(var(--cfc-u) * 3);
      clip-path: inset(2px 0 0 0); /* 固定值，不隨翻頁狀態變動：裁掉文字反鋸齒邊緣殘留在裁切線上的淺色像素 */
    }
    /* .rotor 容器本身的底色改用下半色（而不是跟 rotor-top 共用上半色）——
       這樣 rotor-bottom 被 clip-path 挖空後，露出來的正好是 .rotor 自己的底色，
       顏色天生就對，不需要再疊一層東西去蓋，也不用擔心疊色塊的 z-index 堆疊順序 */
    #cfc-flipdown .rotor { color: var(--cfc-color-top-text); background-color: var(--cfc-color-bottom-bg); }
    #cfc-flipdown .rotor-top,
    #cfc-flipdown .rotor-leaf-front { color: var(--cfc-color-top-text); background-color: var(--cfc-color-top-bg); }
    #cfc-flipdown .rotor-bottom,
    #cfc-flipdown .rotor-leaf-rear  { color: var(--cfc-color-bottom-text); background-color: var(--cfc-color-bottom-bg); }
    #cfc-flipdown .rotor:after {
      /* 中線黑線：純色塊填滿，不用 border-top（避免旁邊 3D 旋轉造成的反鋸齒不穩定）。
         粗細 2px、往下偏移 1px，數值是使用者用可調面板實測確認的。
         z-index 拉到跟 #cfc-overlay 同等級，確保絕對在最上層。 */
      content: '';
      position: absolute;
      left: 0;
      top: calc(50% + 1px);
      width: calc(var(--cfc-u) * 30); /* 240px，跟 rotor 同寬 */
      height: 2px;
      transform: translateY(-50%);
      background-color: #000;
      z-index: 2147483647;
      pointer-events: none;
    }

    /* ===== 依 phase 隱藏兩組欄位（同一時間只顯示相鄰兩組） ===== */
    /* rotor-group 產生順序固定：1=天 2=時 3=分 4=秒 */
    #cfc-flipdown[data-phase="day-hour"] .rotor-group:nth-child(3),
    #cfc-flipdown[data-phase="day-hour"] .rotor-group:nth-child(4) { display: none; }
    #cfc-flipdown[data-phase="hour-min"] .rotor-group:nth-child(1),
    #cfc-flipdown[data-phase="hour-min"] .rotor-group:nth-child(4) { display: none; }
    #cfc-flipdown[data-phase="min-sec"] .rotor-group:nth-child(1),
    #cfc-flipdown[data-phase="min-sec"] .rotor-group:nth-child(2) { display: none; }

    /* 消除間距的規則原本只認 DOM 上真正的 :last-child（秒），但「目前可見的最後一組」
       在 day-hour/hour-min 這兩個 phase 底下分別是「時」「分」，DOM 結構上它們後面還接著被
       隱藏的欄位，並不是 :last-child，會被誤判成「還要留間距給下一組」，多出一段看不見、
       但確實占用版面寬度的空間，導致整體時鐘的可視內容被推歪、看起來不置中。
       這裡用 phase 選擇器精準指定「這個 phase 下真正可見的最後一組」，強制清除它的間距。 */
    #cfc-flipdown[data-phase="day-hour"] .rotor-group:nth-child(2),
    #cfc-flipdown[data-phase="hour-min"] .rotor-group:nth-child(3) { padding-right: 0; }

    /* ===== 兩組可見欄位之間的閃爍冒號 =====
     * 目的：分／秒以外的欄位（天+時、時+分）翻頁間隔可能長達一分鐘以上，
     * 畫面會有很長一段時間完全靜止，使用者容易誤以為卡住了；加一個每秒閃爍的冒號，
     * 模擬一般數位時鐘的效果，持續給視覺回饋。
     * 用 phase 選擇器精準指定「目前可見的第一組欄位」的 ::before/::after 當作上下兩個圓點，
     * 不用通用的 :not(:last-child) —— 那樣會選到「可見欄位」跟「已隱藏欄位」之間也畫一個冒號，
     * 因為 :last-child 是看 DOM 結構、不是看目前可見與否。
     * 大小／位置不用猜測值：由 JS 在畫面建立時實際量測目前生效的字型（可能被使用者的字型替換
     * 腳本蓋掉）畫出「:」字元的真實尺寸，再量測轉輪跟標題的實際渲染高度算出數字視覺中心，
     * 寫入下面這些 CSS 變數；這裡的數值只是量測失敗時的保底預設值。 */
    #cfc-flipdown[data-phase="day-hour"] .rotor-group:nth-child(1)::before,
    #cfc-flipdown[data-phase="day-hour"] .rotor-group:nth-child(1)::after,
    #cfc-flipdown[data-phase="hour-min"] .rotor-group:nth-child(2)::before,
    #cfc-flipdown[data-phase="hour-min"] .rotor-group:nth-child(2)::after,
    #cfc-flipdown[data-phase="min-sec"] .rotor-group:nth-child(3)::before,
    #cfc-flipdown[data-phase="min-sec"] .rotor-group:nth-child(3)::after {
      content: '';
      position: absolute;
      right: var(--cfc-colon-right, calc(var(--cfc-u) * 6.5));
      width: var(--cfc-colon-dot-size, calc(var(--cfc-u) * 2));
      height: var(--cfc-colon-dot-size, calc(var(--cfc-u) * 2));
      border-radius: 50%;
      background: var(--cfc-color-colon);
      pointer-events: none;
      transform: translateY(-50%); /* top 值代表圓心座標，這裡才會真正置中在那個座標上，不是用 top 當方塊上緣 */
      /* 閃爍改用 CSS animation：交給瀏覽器合成執行緒跑，主執行緒忙碌時不會被延後、誤差也不會累積。
         起點由 JS 在每次 _tick（翻頁鐘跳秒的同一時刻）重新啟動這段 animation 來校準——
         見 CFC 裡設定的 flipdownInstance._onTick，這樣冒號跟數字跳動是同一個事件驅動的，
         要卡一起卡，不會像兩個各自獨立的計時器那樣慢慢漂移。 */
      animation: var(--cfc-colon-anim, cfc-colon-blink) 1s linear infinite;
    }
    /* _tick 觸發的瞬間＝翻頁動畫開始的時刻，動畫長度 500ms 剛好佔每一輪的前半段（0~50%），
       後半段才是翻完靜止的狀態。所以前半暗、後半亮，就是「動畫進行中不亮、靜止時才亮」。
       用「49.99%/50% 相鄰兩個關鍵影格」做硬切，不用 steps()——steps(1,end) 會把整段壓成單一階段、
       讓中間的 50% 完全失效（整秒都停在起始值，最後一刻才跳），是之前改了沒效果的原因。 */
    @keyframes cfc-colon-blink {
      0%      { opacity: 0.15; }
      49.99%  { opacity: 0.15; }
      50%     { opacity: 1; }
      100%    { opacity: 1; }
    }
    #cfc-flipdown[data-phase="day-hour"] .rotor-group:nth-child(1)::before,
    #cfc-flipdown[data-phase="hour-min"] .rotor-group:nth-child(2)::before,
    #cfc-flipdown[data-phase="min-sec"] .rotor-group:nth-child(3)::before {
      top: calc(var(--cfc-colon-center, calc(var(--cfc-u) * 36)) - var(--cfc-colon-half-gap, calc(var(--cfc-u) * 6)));
    }
    #cfc-flipdown[data-phase="day-hour"] .rotor-group:nth-child(1)::after,
    #cfc-flipdown[data-phase="hour-min"] .rotor-group:nth-child(2)::after,
    #cfc-flipdown[data-phase="min-sec"] .rotor-group:nth-child(3)::after {
      top: calc(var(--cfc-colon-center, calc(var(--cfc-u) * 36)) + var(--cfc-colon-half-gap, calc(var(--cfc-u) * 6)));
    }

    /* ===== 我們自己的全螢幕外殼 ===== */
    /* --cfc-u 定義在這一層（外殼），往下會自然繼承給 #cfc-flipdown，兩邊共用同一套網格 */
    #cfc-overlay {
      --cfc-u: 0.41667vw; /* 1 網格單位 = 8px（基準寬度 1920px） */
      /* 顏色變數。--cfc-color-top-*／--cfc-color-bottom-* 是疊在轉輪方塊上的顏色，
         .cfc-theme-light 會覆蓋這兩組；其餘（標題／冒號／關閉鈕）都疊在下面這個遮罩本身
         固定不透明黑色的背景上，不隨主題變動，兩個主題共用同一組淺色配色。 */
      --cfc-color-top-bg: #1c1c1e;
      --cfc-color-top-text: #f5f5f5;
      --cfc-color-bottom-bg: #262628; /* rotor-bottom / rotor-leaf-rear 共用底色 */
      --cfc-color-bottom-text: #e8e8e8;
      --cfc-color-title: rgba(255,255,255,0.7);
      --cfc-color-colon: rgba(255,255,255,0.85);
      --cfc-color-close-text: rgba(255,255,255,0.8);
      --cfc-color-close-border: rgba(255,255,255,0.25);
      --cfc-color-close-bg: rgba(255,255,255,0.06);
      --cfc-color-close-bg-hover: rgba(255,255,255,0.16);
      position: fixed;
      inset: 0;
      z-index: 2147483647;
      background: rgba(10, 10, 12, 0.85); /* 固定不透明黑色，不隨主題改變 */
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: calc(var(--cfc-u) * 4); /* 32px */
      -webkit-backdrop-filter: blur(16px);
      backdrop-filter: blur(16px);
    }
    /* 淺色主題：整組色彩變數覆蓋成白底黑字，遮罩本身的 background（上面那行）刻意不在這裡覆蓋，
       維持固定不透明黑色。 */
    /* 淺色主題只覆蓋「疊在轉輪方塊上」的顏色（上下半的底色與文字色）——
       標題文字、冒號圓點、關閉鈕，這三個都疊在遮罩本身固定不透明黑色的背景上，
       不是疊在轉輪的彩色方塊上，所以不該跟著主題切換，維持原本給深色背景看的淺色配色。 */
    #cfc-overlay.cfc-theme-light {
      --cfc-color-top-bg: #f5f5f5;
      --cfc-color-top-text: #1c1c1e;
      --cfc-color-bottom-bg: #e3e3e5;
      --cfc-color-bottom-text: #333336;
    }
    #cfc-overlay .cfc-title {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      font-size: calc(var(--cfc-u) * 2); /* 16px */
      color: var(--cfc-color-title);
      letter-spacing: 0.05em;
    }
    /* 預覽模式（還有額度，不是真的用盡）：標題改綠色，跟真的用盡的樣式做出區別 */
    #cfc-overlay.cfc-preview .cfc-title {
      color: rgba(74, 222, 128, 0.9); /* 柔和的綠色 */
    }
    /* 重置時間文字：外殼的 flex gap 是對所有子元素一視同仁的固定值，但「標題→色塊」這段距離
       其實還隔著「時/分」標籤本身的高度（112px），「色塊→這段文字」中間沒有對應的東西，
       兩邊視覺間距天生不對稱。額外補上等於標籤高度的 margin-top，讓兩邊看起來一樣寬。 */
    #cfc-overlay .cfc-reset-time {
      margin-top: calc(var(--cfc-u) * 14); /* 112px，等於 .rotor-group-heading:before 的高度 */
    }
    #cfc-overlay .cfc-close {
      position: absolute;
      bottom: calc(var(--cfc-u) * 3); /* 24px */
      right: calc(var(--cfc-u) * 4);  /* 32px */
      width: calc(var(--cfc-u) * 6);  /* 48px */
      height: calc(var(--cfc-u) * 6); /* 48px */
      box-sizing: border-box; /* 跟膠囊一致，明確宣告不依賴頁面全域設定 */
      border-radius: 50%;
      border: 1px solid var(--cfc-color-close-border);
      background: var(--cfc-color-close-bg);
      color: var(--cfc-color-close-text);
      font-size: calc(var(--cfc-u) * 3.5); /* 28px，圖示放大，圓圈維持 48px 不變 */
      line-height: 1;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: background 0.15s ease;
    }
    #cfc-overlay .cfc-close:hover { background: var(--cfc-color-close-bg-hover); }

    /* 主題切換膠囊開關：日／月圖示，放在右上角。
       邊距對齊規則：右邊距跟關閉鈕的右邊距相同（calc(*4)）；上邊距的數值等於關閉鈕的下邊距（calc(*3)）。
       尺寸：高度比照關閉鈕（48px），維持 2:1 比例，寬度 96px。
       thumb（實心圓＋圖示）疊在最上層滑動，另一側用淺灰色的靜態圖示提示「切過去會變成什麼」——
       這是 mockup 裡驗證過沒問題的結構，直接套用，不要再自己重新設計。 */
    #cfc-overlay .cfc-theme-toggle {
      position: absolute;
      top: calc(var(--cfc-u) * 3);   /* 24px，數值等於關閉鈕的 bottom */
      right: calc(var(--cfc-u) * 4); /* 32px，跟關閉鈕的 right 相同 */
      width: calc(var(--cfc-u) * 12);  /* 96px */
      height: calc(var(--cfc-u) * 6); /* 48px，跟關閉鈕同高 */
      box-sizing: border-box;
      border-radius: calc(var(--cfc-u) * 6);
      border: 1px solid var(--cfc-color-close-border);
      background: var(--cfc-color-close-bg);
      cursor: pointer;
      padding: 0;
      transition: background 0.15s ease;
    }
    #cfc-overlay .cfc-theme-toggle:hover { background: var(--cfc-color-close-bg-hover); }
    #cfc-overlay .cfc-theme-toggle-thumb {
      position: absolute;
      top: 50%;
      left: var(--cfc-toggle-far, 51px); /* 預設（深色主題）：thumb 停在右側。用 JS 量測膠囊實際渲染尺寸算出來，不是猜的 */
      transform: translateY(-50%);
      z-index: 2;
      width: var(--cfc-toggle-dot, 38px);  /* 邊距歸零、直徑＝膠囊實際高度，JS 量測後套用 */
      height: var(--cfc-toggle-dot, 38px);
      border-radius: 50%;
      background: var(--cfc-color-close-text);
      display: flex;
      align-items: center;
      justify-content: center;
      transition: left 0.2s ease;
    }
    #cfc-overlay .cfc-theme-toggle-thumb svg { width: 20px; height: 20px; }
    /* 淺色主題啟用時：thumb 滑到左側 */
    #cfc-overlay.cfc-theme-light .cfc-theme-toggle-thumb {
      left: 0;
    }
    #cfc-overlay .cfc-theme-toggle-thumb .cfc-theme-toggle-icon-sun,
    #cfc-overlay .cfc-theme-toggle-thumb .cfc-theme-toggle-icon-moon {
      color: #1c1c1e; /* 固定深色，thumb 本身是淺色實心圓，圖示要用深色才有對比 */
      opacity: 0;
      position: absolute;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      transition: opacity 0.15s ease;
    }
    #cfc-overlay .cfc-theme-toggle-thumb .cfc-theme-toggle-icon-moon { opacity: 1; } /* 深色主題（預設）：thumb 顯示月亮 */
    #cfc-overlay.cfc-theme-light .cfc-theme-toggle-thumb .cfc-theme-toggle-icon-sun { opacity: 1; }
    #cfc-overlay.cfc-theme-light .cfc-theme-toggle-thumb .cfc-theme-toggle-icon-moon { opacity: 0; }
    /* 未選中那端：淺灰色靜態圖示，淡淡提示切過去會變成什麼 */
    #cfc-overlay .cfc-theme-toggle-ghost {
      position: absolute;
      top: 50%;
      left: 0; /* 預設（深色主題）：ghost 顯示在左側（太陽，代表切過去會變淺色），邊距歸零 */
      transform: translateY(-50%);
      z-index: 1;
      width: var(--cfc-toggle-dot, 38px);
      height: var(--cfc-toggle-dot, 38px);
      display: flex;
      align-items: center;
      justify-content: center;
      color: var(--cfc-color-close-text);
      opacity: 0.28;
      pointer-events: none;
      transition: left 0.2s ease;
    }
    #cfc-overlay .cfc-theme-toggle-ghost svg { width: 20px; height: 20px; }
    #cfc-overlay.cfc-theme-light .cfc-theme-toggle-ghost {
      left: var(--cfc-toggle-far, 51px); /* 淺色主題啟用時：ghost 換到右側，顯示月亮（代表切回去會變深色） */
    }
    #cfc-overlay .cfc-theme-toggle-ghost .cfc-theme-toggle-icon-sun { display: block; } /* 深色主題（預設）：ghost 顯示太陽，代表切過去會變淺色 */
    #cfc-overlay.cfc-theme-light .cfc-theme-toggle-ghost .cfc-theme-toggle-icon-sun { display: none; }
    #cfc-overlay .cfc-theme-toggle-ghost .cfc-theme-toggle-icon-moon { display: none; }
    #cfc-overlay.cfc-theme-light .cfc-theme-toggle-ghost .cfc-theme-toggle-icon-moon { display: block; } /* 淺色主題啟用時：ghost 顯示月亮，代表切回去會變深色 */

    /* 常駐開啟按鈕：不在 #cfc-overlay 底下（overlay 關閉時會整個被移除），直接掛在 body 上。
       位置基準是右下角，實際位置 = 基準位置 + 可調偏移量（--cfc-reopen-offset-x/y，預設 0），
       要微調位置直接改這兩個變數即可，不用動其他數值。 */
    :root {
      --cfc-reopen-offset-x: -7px; /* 正值往左移，負值往右移（因為是往 right 方向疊加） */
      --cfc-reopen-offset-y: -12px; /* 正值往上移，負值往下移（因為是往 bottom 方向疊加） */
    }
    #cfc-reopen {
      position: fixed;
      bottom: calc(var(--cfc-u, 0.41667vw) * 3 + var(--cfc-reopen-offset-y)); /* 基準 24px + 偏移 */
      right: calc(var(--cfc-u, 0.41667vw) * 4 + var(--cfc-reopen-offset-x));  /* 基準 32px + 偏移 */
      z-index: 2147483647;
      width: calc(var(--cfc-u, 0.41667vw) * 6);  /* 48px，維持點擊熱區大小 */
      height: calc(var(--cfc-u, 0.41667vw) * 6); /* 48px */
      background: transparent;
      border: none;
      color: #333; /* 深灰色圖示，不再用圓形底色 */
      font-size: calc(var(--cfc-u, 0.41667vw) * 3); /* 24px */
      line-height: 1;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      opacity: 0.85;
      transition: opacity 0.15s ease;
    }
    #cfc-reopen:hover { opacity: 1; }
    @media (max-width: 640px) {
      #cfc-reopen { width: 40px; height: 40px; font-size: 16px; }
    }

    /* 手機版維持固定 px（不繼續跟 vw 縮小）——窄螢幕上 vw 換算出來的字級會小到看不清楚，
       這裡改成一組獨立的、同樣是 8px 網格倍數的「下限尺寸」 */
    @media (max-width: 640px) {
      #cfc-flipdown .rotor { width: 48px; height: 80px; font-size: 48px; margin-right: 8px; }
      #cfc-flipdown .rotor-top, #cfc-flipdown .rotor-bottom,
      #cfc-flipdown .rotor-leaf, #cfc-flipdown .rotor-leaf-front,
      #cfc-flipdown .rotor-leaf-rear, #cfc-flipdown .rotor:after { width: 48px; }
      #cfc-flipdown .rotor-leaf { height: 80px; }
      #cfc-flipdown .rotor-top, #cfc-flipdown .rotor-leaf-front { line-height: 80px; }
      #cfc-flipdown .rotor-top, #cfc-flipdown .rotor-bottom,
      #cfc-flipdown .rotor-leaf-front, #cfc-flipdown .rotor-leaf-rear { height: 40px; }
      #cfc-flipdown .rotor-group { padding-right: var(--cfc-group-gap, 24px); }
      #cfc-flipdown .rotor-group-heading:before { font-size: 16px; height: 24px; line-height: 24px; }
      /* 同樣的置中修正：手機版也要清除「目前可見最後一組」的間距（見桌面版註解），
         冒號圓點大小/位置不用另外寫死，JS 量測時會讀到手機版當下實際生效的字型跟尺寸。 */
      #cfc-flipdown[data-phase="day-hour"] .rotor-group:nth-child(2),
      #cfc-flipdown[data-phase="hour-min"] .rotor-group:nth-child(3) { padding-right: 0; }
      #cfc-overlay .cfc-close { width: 40px; height: 40px; font-size: 16px; bottom: 16px; right: 16px; }
      #cfc-overlay .cfc-theme-toggle { top: 16px; right: 16px; }
      #cfc-overlay .cfc-title { font-size: 16px; }
      #cfc-overlay .cfc-reset-time { margin-top: 24px; }
      #cfc-overlay { gap: 24px; }
    }
  `;
  document.head.appendChild(style);

  /* ------------------------------------------------------------
   * CFC 命名空間：我們自己的邏輯（phase 判斷、全螢幕外殼、開關）
   * ------------------------------------------------------------ */
  const CFC = (() => {
    let overlayEl = null;
    let flipdownInstance = null;
    let phaseTimer = null;
    let lastEpoch = null; // 記錄目前倒數的目標時間，關閉後重新開啟時要沿用同一個目標，不能歸零重算
    let lastIsPreview = false; // 連同預覽模式狀態一起記住，重新開啟時樣式才不會跑掉
    let reopenBtn = null; // 常駐的重新開啟按鈕（不隨 overlay 一起被移除）

    // 相鄰兩組欄位的切換門檻：>=1天 顯示「天+時」；>=1小時 顯示「時+分」；否則「分+秒」
    // 這是直接切換（無翻頁動畫）——原因：翻頁鐘的物理結構是「固定位置的轉輪」，
    // 欄位整組消失/出現不是轉輪能表現的動作，只有同一位置的數字變化才適合翻頁。
    function computePhase(remainingSeconds) {
      if (remainingSeconds >= 86400) return "day-hour";
      if (remainingSeconds >= 3600) return "hour-min";
      return "min-sec";
    }

    function updatePhase(epochSeconds) {
      if (!flipdownInstance) return;
      const remaining = Math.max(0, epochSeconds - Date.now() / 1000);
      const phase = computePhase(remaining);
      const el = document.getElementById("cfc-flipdown");
      if (el && el.getAttribute("data-phase") !== phase) {
        el.setAttribute("data-phase", phase);
      }
    }

    function ensureReopenBtn() {
      if (reopenBtn) return reopenBtn;
      reopenBtn = document.createElement("button");
      reopenBtn.id = "cfc-reopen";
      reopenBtn.innerHTML = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7.5v5l3 2"/></svg>';
      reopenBtn.setAttribute("aria-label", "開啟額度冷卻倒數畫面");
      reopenBtn.addEventListener("click", () => {
        if (lastEpoch != null && lastEpoch - Date.now() / 1000 > 0) {
          show(lastEpoch, lastIsPreview); // 有進行中的倒數，沿用原本目標時間跟模式，不重新計算
        } else if (typeof target.__cfcManualCheck === "function") {
          target.__cfcManualCheck(); // 沒有進行中的倒數，改成即時查詢（跟 GM 選單同一套邏輯，含用量確認）
        }
      });
      document.body.appendChild(reopenBtn);
      return reopenBtn;
    }
    ensureReopenBtn(); // 常駐按鈕，腳本載入時就建立、預設顯示，不等第一次關閉才出現

    function close() {
      if (phaseTimer) {
        clearInterval(phaseTimer);
        phaseTimer = null;
      }
      if (flipdownInstance && flipdownInstance.countdown) {
        clearInterval(flipdownInstance.countdown);
      }
      flipdownInstance = null;
      if (overlayEl) {
        overlayEl.remove();
        overlayEl = null;
      }
      ensureReopenBtn().style.display = "flex"; // 常駐按鈕，關閉全螢幕畫面後一律顯示
    }

    // epochSeconds：目標時間（unix timestamp，秒）
    // isPreview：true＝還有額度（手動查詢時用量未達門檻），顯示「預覽」樣式；false／省略＝真的額度用盡
    function show(epochSeconds, isPreview) {
      close(); // 避免重複開啟（close() 內部的「留重新開啟按鈕」判斷這裡也會跑到，等等再蓋掉）
      lastEpoch = epochSeconds;
      lastIsPreview = !!isPreview;
      if (reopenBtn) reopenBtn.style.display = "none"; // 畫面開啟中，不需要重新開啟按鈕

      overlayEl = document.createElement("div");
      overlayEl.id = "cfc-overlay";
      if (isPreview) overlayEl.classList.add("cfc-preview");
      if (getCurrentTheme() === "light") overlayEl.classList.add("cfc-theme-light");

      const title = document.createElement("div");
      title.className = "cfc-title";
      title.textContent = isPreview ? "距離本輪額度重置時間還剩餘" : "額度已用盡，等待恢復中";
      overlayEl.appendChild(title);

      const clockEl = document.createElement("div");
      clockEl.id = "cfc-flipdown";
      clockEl.className = "flipdown";
      overlayEl.appendChild(clockEl);

      // 重置時間顯示：沿用標題的樣式（cfc-title），外殼本身已經用 flex + gap 控制間距、
      // align-items:center 自動置中，不需要另外用 JS 量測寬度去手動置中。
      const resetTimeEl = document.createElement("div");
      resetTimeEl.className = "cfc-title cfc-reset-time";
      resetTimeEl.textContent = "額度重計時間 " + formatResetTime(epochSeconds);
      overlayEl.appendChild(resetTimeEl);

      // 主題切換膠囊：日／月圖示，點擊切換深色／淺色，選擇會持久記住
      const themeToggle = document.createElement("button");
      themeToggle.className = "cfc-theme-toggle";
      themeToggle.setAttribute("aria-label", "切換深色／淺色主題");
      themeToggle.innerHTML =
        '<span class="cfc-theme-toggle-ghost">' +
        '<svg class="cfc-theme-toggle-icon-sun" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4.5"/><path d="M12 2.5v3M12 18.5v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2.5 12h3M18.5 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/></svg>' +
        '<svg class="cfc-theme-toggle-icon-moon" width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z"/></svg>' +
        "</span>" +
        '<span class="cfc-theme-toggle-thumb">' +
        '<svg class="cfc-theme-toggle-icon-sun" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4.5"/><path d="M12 2.5v3M12 18.5v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2.5 12h3M18.5 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/></svg>' +
        '<svg class="cfc-theme-toggle-icon-moon" width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z"/></svg>' +
        "</span>";
      themeToggle.addEventListener("click", () => {
        const next = overlayEl.classList.toggle("cfc-theme-light") ? "light" : "dark";
        setCurrentTheme(next);
      });
      overlayEl.appendChild(themeToggle);

      const closeBtn = document.createElement("button");
      closeBtn.className = "cfc-close";
      closeBtn.textContent = "\u2715"; // ✕
      closeBtn.setAttribute("aria-label", "關閉");
      closeBtn.addEventListener("click", close);
      overlayEl.appendChild(closeBtn);

      document.body.appendChild(overlayEl);
      applyToggleMetrics(); // 量測膠囊實際渲染出來的高度，算出圓圈直徑（＝膠囊高度，邊距歸零）跟靠右停駐位置

      const FlipDown = window.__CFC_FlipDown;
      flipdownInstance = new FlipDown(epochSeconds, "cfc-flipdown", {
        theme: "dark", // 我們的 CSS 已覆蓋配色，這裡只是滿足函式庫必填參數
        headings: ["天", "時", "分", "秒"],
      }).start();
      flipdownInstance.ifEnded(() => {
        setTimeout(() => close(), 5000); // 倒數歸零＝額度已恢復，延遲 5 秒讓使用者看到 00:00:00 再自動關閉
      });

      // 除錯掛鉤：暴露實例本體，方便 Console 直接操控（例如降速測試時覆寫 _getTime）
      target.__cfcInstance = flipdownInstance;

      applyColonMetrics(); // DOM 已經建好，量測目前實際生效的字型跟版面尺寸，套到冒號的 CSS 變數

      updatePhase(epochSeconds);
      phaseTimer = setInterval(() => updatePhase(epochSeconds), 1000);

      // 冒號閃爍跟數字跳動同步：掛在函式庫內部的 _tick（跳秒的核心函式，我們在 vendored 原始碼裡
      // 加了這個掛鉤點）上，每次跳秒就把 CSS animation 從頭重新播放一次。
      // 為什麼要重啟：animation 本身由瀏覽器合成執行緒跑、節奏穩定，但如果放著不管，它的起點跟
      // 數字跳動的時間點是各自獨立的，久了會漂移；每秒重新對時一次，兩者就永遠是同一個事件驅動的。
      flipdownInstance._onTick = () => {
        const el = document.getElementById("cfc-flipdown");
        if (!el) return;
        el.style.setProperty("--cfc-colon-anim", "none");
        void el.offsetWidth; // 強制瀏覽器立刻重算樣式，animation 才會真的從頭開始，不是被合併掉
        el.style.removeProperty("--cfc-colon-anim");
      };
    }

    // 冒號圓點的大小／位置不用猜測值：實際量測目前生效的字型（可能被使用者的字型替換腳本蓋掉）
    // 畫出「:」字元的真實尺寸，再量測轉輪跟標題的實際渲染高度算出數字視覺中心。只需要在畫面
    // 建立時量一次（不同 phase 之間轉輪本身尺寸不變，只是顯示/隱藏切換，不用每次 phase 切換都重量）。
    // 膠囊裡圓圈的直徑跟位置不用猜測值：量測膠囊實際渲染出來的 clientHeight（已經是瀏覽器算好的
    // 內部可用高度，不用自己再去扣邊框、猜 box-sizing 怎麼算），直徑＝這個值、邊距＝0（圓圈頂滿
    // 膠囊上下緣），靠右停駐位置＝膠囊實際寬度－直徑。
    // 格式化重置時間：YYYY年M月D日 星期X HH:MM，用瀏覽器本地時區（跟倒數計時本身用的時間基準一致）
    function formatResetTime(epochSeconds) {
      const d = new Date(epochSeconds * 1000);
      const weekdays = ["日", "一", "二", "三", "四", "五", "六"];
      const pad2 = (n) => String(n).padStart(2, "0");
      return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 星期${weekdays[d.getDay()]} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
    }

    function applyToggleMetrics() {
      const pill = document.querySelector(".cfc-theme-toggle");
      if (!pill) return;
      const dot = pill.clientHeight; // 內部可用高度（不含邊框），直徑對齊這個值，圓圈才會頂滿上下緣不溢出
      const far = pill.clientWidth - dot; // 內部可用寬度（不含邊框）減去直徑，才是正確的靠右停駐位置
      pill.style.setProperty("--cfc-toggle-dot", dot + "px");
      pill.style.setProperty("--cfc-toggle-far", far + "px");
    }

    function applyColonMetrics() {
      const flipEl = document.getElementById("cfc-flipdown");
      const rotorTop = flipEl && flipEl.querySelector(".rotor-top");
      const headingEl = flipEl && flipEl.querySelector(".rotor-group-heading");
      const rotorEl = flipEl && flipEl.querySelector(".rotor");
      if (!flipEl || !rotorTop || !headingEl || !rotorEl) return;

      const cs = getComputedStyle(rotorTop);
      const fontSizePx = parseFloat(cs.fontSize) || 256;

      let dotSize, halfGap;
      try {
        const canvas = document.createElement("canvas");
        const ctx = canvas.getContext("2d");
        ctx.font = `${cs.fontWeight} ${fontSizePx}px ${cs.fontFamily}`;
        const m = ctx.measureText(":");
        // 用緊貼字形墨水邊緣的量測值（actualBoundingBox），不是含左右留白的總佔位寬度（m.width）——
        // 冒號字元的總佔位寬度比「一顆圓點的實際直徑」大上一截，直接拿來當圓點直徑會量出過大的結果。
        const inkWidth = (m.actualBoundingBoxLeft || 0) + (m.actualBoundingBoxRight || 0);
        const ascent = m.actualBoundingBoxAscent || fontSizePx * 0.35;
        const descent = m.actualBoundingBoxDescent || fontSizePx * 0.05;
        dotSize = Math.max(2, Math.round(inkWidth || fontSizePx * 0.09));
        // halfGap＝圓心到垂直中心的距離。ascent+descent 量到的是整個冒號字形（兩點＋中間空隙）
        // 的外緣到外緣高度，要再扣掉半顆圓點的半徑，才會是「圓心」而不是「外緣」的位置。
        halfGap = Math.max(dotSize * 0.6, Math.round((ascent + descent) / 2 - dotSize / 2));
      } catch (e) {
        console.warn("[Claude額度冷卻翻頁鐘] 量測冒號字型失敗，改用保底預設值:", e);
        dotSize = Math.round(fontSizePx * 0.09);
        halfGap = Math.round(fontSizePx * 0.16);
      }

      // 標題高度 + 半個轉輪高度＝數字在 rotor-group 這個容器裡的實際垂直視覺中心
      const headingHeight = headingEl.getBoundingClientRect().height;
      const rotorHeight = rotorEl.getBoundingClientRect().height;
      const centerOffset = headingHeight + rotorHeight / 2;

      // 整體間距（rotor-group 的 padding-right）不再是寫死的網格值，改成跟著圓點大小走：
      // 圓點本身 + 左右各留一個圓點直徑當呼吸空間，跟著字型大小一起動態縮放。
      const groupGap = Math.round(dotSize * 3);
      const rightOffset = Math.round((groupGap - dotSize) / 2);

      flipEl.style.setProperty("--cfc-colon-dot-size", dotSize + "px");
      flipEl.style.setProperty("--cfc-colon-half-gap", halfGap + "px");
      flipEl.style.setProperty("--cfc-colon-center", centerOffset + "px");
      flipEl.style.setProperty("--cfc-colon-right", rightOffset + "px");
      flipEl.style.setProperty("--cfc-group-gap", groupGap + "px");
    }

    return { show, close };
  })();

  /* ------------------------------------------------------------
   * Phase 2：偵測額度用完 + 自動觸發
   * ------------------------------------------------------------ */

  // 已知限制：這兩個 class 是 Tailwind 產生的工具類名，UI 改版時很可能失效，
  // 且目前沒有更穩定的 data-testid / aria-label 可用（已實際用檢查器確認過 DOM 結構）。
  // 依使用者明確指示：只判斷這段結構「存在與否」，不比對裡面的文字內容。
  const LIMIT_SELECTOR = "div.min-w-0.break-words > div.text-sm";

  let orgId = null;
  let limitActive = false; // 避免同一次額度用完期間，元件持續存在時重複觸發
  let checkDebounceTimer = null;

  const _origFetch = target.fetch.bind(target);
  target.fetch = function (...args) {
    const url = typeof args[0] === "string" ? args[0] : args[0] instanceof Request ? args[0].url : "";
    onApiActivity(url);
    return _origFetch(...args);
  };
  const _origXHROpen = target.XMLHttpRequest.prototype.open;
  target.XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    if (typeof url === "string") onApiActivity(url);
    return _origXHROpen.call(this, method, url, ...rest);
  };

  // 每次攔截到 claude.ai 自己發出的 org-scoped API 請求（聊天、送出訊息等大多數請求都走這個路徑前綴），
  // 才 debounce 檢查一次 DOM——取代原本全頁面持續 MutationObserver（串流輸出文字時 DOM 幾乎每個字都在變動，
  // 那樣會被觸發得非常頻繁）。順便取得 orgId（只需要成功一次）。
  function onApiActivity(url) {
    if (!url) return;
    const m = url.match(/\/api\/organizations\/([0-9a-f-]{36})/i);
    if (!m) return;
    if (!orgId) orgId = m[1];
    if (checkDebounceTimer) clearTimeout(checkDebounceTimer);
    checkDebounceTimer = setTimeout(checkLimitDom, 600);
  }

  function checkLimitDom() {
    const exists = !!document.querySelector(LIMIT_SELECTOR);
    if (exists && !limitActive) {
      handleLimitDetected();
    } else if (!exists && limitActive) {
      handleLimitCleared();
    }
  }

  // 依序嘗試三個端點（沿用既有腳本驗證過的做法），同時取得「短期視窗」（five_hour）跟
  // 「長期視窗」（seven_day）兩者的 resets_at 與 utilization——實際能不能送出訊息，
  // 兩個視窗都要有餘額才行，所以判斷「什麼時候能用」時兩個都要看，不能只看其中一個。
  async function fetchWindowsData() {
    if (!orgId) return null;
    const endpoints = [
      `https://claude.ai/api/organizations/${orgId}/usage`,
      `https://claude.ai/api/organizations/${orgId}/rate_limit_status`,
      `https://claude.ai/api/organizations/${orgId}/limits`,
    ];
    for (const url of endpoints) {
      try {
        const res = await _origFetch(url, { credentials: "include", headers: { Accept: "application/json" } });
        if (res.status === 404 || !res.ok) continue;
        const data = await res.json();
        const windows = {};
        if (data && data.five_hour) {
          windows.five_hour = { resets_at: data.five_hour.resets_at, utilization: data.five_hour.utilization };
        }
        if (data && data.seven_day) {
          windows.seven_day = { resets_at: data.seven_day.resets_at, utilization: data.seven_day.utilization };
        }
        if (!windows.five_hour && !windows.seven_day && data && Array.isArray(data.rate_limits)) {
          for (const item of data.rate_limits) {
            const label = String(item.window_duration || item.type || "").toLowerCase();
            if (/5h|five.?hour|session/.test(label)) {
              windows.five_hour = { resets_at: item.resets_at || item.reset_at, utilization: item.utilization };
            }
            if (/7d|seven.?day|week/.test(label)) {
              windows.seven_day = { resets_at: item.resets_at || item.reset_at, utilization: item.utilization };
            }
          }
        }
        if (windows.five_hour || windows.seven_day) return windows;
      } catch (e) {
        console.warn("[Claude額度冷卻翻頁鐘] 查詢用量失敗:", url, e);
      }
    }
    return null;
  }

  function toEpoch(resetsAt) {
    if (resetsAt == null) return null;
    const t = typeof resetsAt === "string" ? new Date(resetsAt).getTime() / 1000 : resetsAt;
    return Number.isNaN(t) ? null : t;
  }

  // 真的被擋住時使用：判斷哪個視窗真的用盡。只有一個用盡就回報那個；
  // 兩個都用盡，回報時間離現在比較遠的那個（因為兩個視窗都要有餘額才能真正送出訊息）。
  // 如果兩個視窗的用量資料都不明確（欄位缺失、門檻抓不準），保守回報較遠的那個，
  // 避免使用者提早重試又再次被擋。
  function pickBlockedEpoch(windows) {
    const fh = windows.five_hour;
    const sd = windows.seven_day;
    const fhExhausted = fh && fh.utilization != null && fh.utilization >= EXHAUST_THRESHOLD_SHORT;
    const sdExhausted = sd && sd.utilization != null && sd.utilization >= EXHAUST_THRESHOLD_LONG;
    const fhEpoch = fh ? toEpoch(fh.resets_at) : null;
    const sdEpoch = sd ? toEpoch(sd.resets_at) : null;
    if (fhExhausted && sdExhausted) {
      const candidates = [fhEpoch, sdEpoch].filter((v) => v != null);
      return candidates.length ? Math.max(...candidates) : null;
    }
    if (fhExhausted && fhEpoch != null) return fhEpoch;
    if (sdExhausted && sdEpoch != null) return sdEpoch;
    const candidates = [fhEpoch, sdEpoch].filter((v) => v != null);
    return candidates.length ? Math.max(...candidates) : null;
  }

  // 還有額度時（預覽模式）固定回報短期視窗，不管長期視窗
  function pickPreviewEpoch(windows) {
    const fh = windows.five_hour;
    return fh ? toEpoch(fh.resets_at) : null;
  }

  async function handleLimitDetected() {
    if (limitActive) return;
    limitActive = true;
    const windows = await fetchWindowsData();
    const epoch = windows ? pickBlockedEpoch(windows) : null;
    if (epoch != null) {
      CFC.show(epoch, false);
    } else {
      console.warn("[Claude額度冷卻翻頁鐘] 偵測到額度用完，但取不到 resets_at，未顯示倒數畫面");
    }
  }

  function handleLimitCleared() {
    limitActive = false;
  }

  const limitFallbackTimer = setInterval(checkLimitDom, 60000); // 保底輪詢：避免提示出現當下剛好沒有任何 API 活動被攔截到而漏抓

  // 頁面載入當下也檢查一次，避免腳本注入時額度剛好已經用完、錯過第一次觸發
  checkLimitDom();

  // 手動觸發共用邏輯：查兩個視窗的資料，短期視窗用量到門檻就視為「真的用盡」，
  // 回報邏輯照 pickBlockedEpoch；否則視為「還有額度」，回報短期視窗的 resets_at（預覽模式）。
  async function manualCheckAndShow() {
    const windows = await fetchWindowsData();
    if (!windows) {
      alert("[Claude額度冷卻翻頁鐘] 查不到用量資料，可能還沒有任何 API 請求被攔截到（orgId 未知）。");
      return;
    }
    const fh = windows.five_hour;
    const looksBlocked = fh && fh.utilization != null && fh.utilization >= EXHAUST_THRESHOLD_SHORT;
    const epoch = looksBlocked ? pickBlockedEpoch(windows) : pickPreviewEpoch(windows);
    if (epoch == null) {
      alert("[Claude額度冷卻翻頁鐘] 查得到用量資料，但沒有 resets_at 可用。");
      return;
    }
    limitActive = true;
    CFC.show(epoch, !looksBlocked);
  }
  target.__cfcManualCheck = manualCheckAndShow; // 讓 CFC 常駐按鈕（定義在檔案較前面、作用域不同）也能呼叫同一套邏輯

  // 手動觸發機制：萬一自動偵測失效（例如選擇器跟著 UI 改版失效），
  // 使用者可以從 Tampermonkey 圖示選單手動叫出倒數畫面，不用等自動偵測。
  if (typeof GM_registerMenuCommand !== "undefined") {
    GM_registerMenuCommand("手動開啟額度冷卻倒數", manualCheckAndShow);
  }

  // ---- Phase 1 測試用掛鉤：Console 執行 __cfcTest(秒數) 立即開出假倒數 ----
  target.__cfcTest = function (secondsFromNow) {
    const epoch = Date.now() / 1000 + Number(secondsFromNow || 90);
    CFC.show(epoch);
  };
  target.__cfcClose = CFC.close;

  console.log("[Claude額度冷卻翻頁鐘] Phase 1 已載入。Console 執行 __cfcTest(秒數) 測試，例如 __cfcTest(90000)");
})();
