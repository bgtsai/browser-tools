// ==UserScript==
// @name         Claude 額度冷卻翻頁鐘
// @namespace    https://github.com/bgtsai/browser-tools
// @version      1.2.0
// @description  Claude.ai 額度用完時，全螢幕顯示翻頁鐘倒數剩餘冷卻時間
// @author       bgtsai
// @match        https://claude.ai/*
// @grant        unsafeWindow
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
      padding-right: calc(var(--cfc-u) * 15); /* 120px */
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
    #cfc-flipdown .rotor { color: #f5f5f5; background-color: var(--cfc-color-bottom-bg); }
    #cfc-flipdown .rotor-top,
    #cfc-flipdown .rotor-leaf-front { color: #f5f5f5; background-color: #1c1c1e; }
    #cfc-flipdown .rotor-bottom,
    #cfc-flipdown .rotor-leaf-rear  { color: #e8e8e8; background-color: var(--cfc-color-bottom-bg); }
    #cfc-flipdown .rotor:after {
      content: '';
      z-index: 2;
      position: absolute;
      bottom: 0; left: 0;
      width: calc(var(--cfc-u) * 30); height: calc(var(--cfc-u) * 22); /* 240px / 176px */
      border-radius: 0 0 calc(var(--cfc-u) * 3) calc(var(--cfc-u) * 3);
      border-top: solid 1px #000;
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

    /* ===== 我們自己的全螢幕外殼 ===== */
    /* --cfc-u 定義在這一層（外殼），往下會自然繼承給 #cfc-flipdown，兩邊共用同一套網格 */
    #cfc-overlay {
      --cfc-u: 0.41667vw; /* 1 網格單位 = 8px（基準寬度 1920px） */
      --cfc-color-bottom-bg: #262628; /* rotor-bottom / rotor-leaf-rear 共用底色 */
      position: fixed;
      inset: 0;
      z-index: 2147483647;
      background: rgba(10, 10, 12, 0.85);
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: calc(var(--cfc-u) * 4); /* 32px */
      -webkit-backdrop-filter: blur(6px);
      backdrop-filter: blur(6px);
    }
    #cfc-overlay .cfc-title {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      font-size: calc(var(--cfc-u) * 2); /* 16px */
      color: rgba(255,255,255,0.7);
      letter-spacing: 0.05em;
    }
    #cfc-overlay .cfc-close {
      position: absolute;
      bottom: calc(var(--cfc-u) * 3); /* 24px */
      right: calc(var(--cfc-u) * 4);  /* 32px */
      width: calc(var(--cfc-u) * 6);  /* 48px */
      height: calc(var(--cfc-u) * 6); /* 48px */
      border-radius: 50%;
      border: 1px solid rgba(255,255,255,0.25);
      background: rgba(255,255,255,0.06);
      color: rgba(255,255,255,0.8);
      font-size: calc(var(--cfc-u) * 3); /* 24px */
      line-height: 1;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: background 0.15s ease;
    }
    #cfc-overlay .cfc-close:hover { background: rgba(255,255,255,0.16); }

    /* 常駐重新開啟按鈕：不在 #cfc-overlay 底下（overlay 關閉時會整個被移除），
       直接掛在 body 上，位置與關閉鈕相同（右下角），視覺樣式也比照。 */
    #cfc-reopen {
      position: fixed;
      bottom: calc(var(--cfc-u, 0.41667vw) * 3); /* 24px */
      right: calc(var(--cfc-u, 0.41667vw) * 4);  /* 32px */
      z-index: 2147483647;
      width: calc(var(--cfc-u, 0.41667vw) * 6);  /* 48px */
      height: calc(var(--cfc-u, 0.41667vw) * 6); /* 48px */
      border-radius: 50%;
      border: 1px solid rgba(255,255,255,0.25);
      background: rgba(30,30,32,0.9);
      color: rgba(255,255,255,0.85);
      font-size: calc(var(--cfc-u, 0.41667vw) * 3); /* 24px */
      line-height: 1;
      cursor: pointer;
      align-items: center;
      justify-content: center;
      transition: background 0.15s ease;
    }
    #cfc-reopen:hover { background: rgba(50,50,54,0.95); }
    @media (max-width: 640px) {
      #cfc-reopen { width: 40px; height: 40px; font-size: 16px; bottom: 16px; right: 16px; }
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
      #cfc-flipdown .rotor-leaf-front, #cfc-flipdown .rotor-leaf-rear,
      #cfc-flipdown .rotor:after { height: 40px; }
      #cfc-flipdown .rotor-group { padding-right: 24px; }
      #cfc-flipdown .rotor-group-heading:before { font-size: 16px; height: 24px; line-height: 24px; }
      #cfc-overlay .cfc-close { width: 40px; height: 40px; font-size: 16px; bottom: 16px; right: 16px; }
      #cfc-overlay .cfc-title { font-size: 16px; }
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
      reopenBtn.innerHTML = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9" stroke-dasharray="2.5 3"/><path d="M12 7.5v5l3 2"/></svg>';
      reopenBtn.setAttribute("aria-label", "重新開啟倒數畫面");
      reopenBtn.style.display = "none";
      reopenBtn.addEventListener("click", () => {
        if (lastEpoch != null && lastEpoch - Date.now() / 1000 > 0) {
          show(lastEpoch); // 沿用原本的目標時間，不重新計算
        }
      });
      document.body.appendChild(reopenBtn);
      return reopenBtn;
    }

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
      // 倒數還沒結束的話，留一顆常駐按鈕讓使用者可以再打開
      if (lastEpoch != null && lastEpoch - Date.now() / 1000 > 0) {
        ensureReopenBtn().style.display = "flex";
      }
    }

    // epochSeconds：目標時間（unix timestamp，秒）
    function show(epochSeconds) {
      close(); // 避免重複開啟（close() 內部的「留重新開啟按鈕」判斷這裡也會跑到，等等再蓋掉）
      lastEpoch = epochSeconds;
      if (reopenBtn) reopenBtn.style.display = "none"; // 畫面開啟中，不需要重新開啟按鈕

      overlayEl = document.createElement("div");
      overlayEl.id = "cfc-overlay";

      const title = document.createElement("div");
      title.className = "cfc-title";
      title.textContent = "額度已用完，等待恢復中";
      overlayEl.appendChild(title);

      const clockEl = document.createElement("div");
      clockEl.id = "cfc-flipdown";
      clockEl.className = "flipdown";
      overlayEl.appendChild(clockEl);

      const closeBtn = document.createElement("button");
      closeBtn.className = "cfc-close";
      closeBtn.textContent = "\u2715"; // ✕
      closeBtn.setAttribute("aria-label", "關閉");
      closeBtn.addEventListener("click", close);
      overlayEl.appendChild(closeBtn);

      document.body.appendChild(overlayEl);

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

      updatePhase(epochSeconds);
      phaseTimer = setInterval(() => updatePhase(epochSeconds), 1000);
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

  const _origFetch = window.fetch.bind(window);
  window.fetch = function (...args) {
    const url = typeof args[0] === "string" ? args[0] : args[0] instanceof Request ? args[0].url : "";
    captureOrgId(url);
    return _origFetch(...args);
  };
  const _origXHROpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    if (typeof url === "string") captureOrgId(url);
    return _origXHROpen.call(this, method, url, ...rest);
  };

  function captureOrgId(url) {
    if (!url || orgId) return;
    const m = url.match(/\/api\/organizations\/([0-9a-f-]{36})/i);
    if (m) orgId = m[1];
  }

  // 依序嘗試三個端點（沿用既有腳本驗證過的做法），取得 five_hour.resets_at 換算成 unix timestamp（秒）
  async function fetchResetEpoch() {
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
        let resetsAt = data && data.five_hour ? data.five_hour.resets_at : null;
        if (!resetsAt && data && Array.isArray(data.rate_limits)) {
          const item = data.rate_limits.find((r) => /5h|five.?hour|session/i.test(String(r.window_duration || r.type || "")));
          resetsAt = item ? item.resets_at || item.reset_at : null;
        }
        if (resetsAt) {
          const t = typeof resetsAt === "string" ? new Date(resetsAt).getTime() / 1000 : resetsAt;
          if (!Number.isNaN(t)) return t;
        }
      } catch (e) {
        console.warn("[Claude額度冷卻翻頁鐘] 查詢用量失敗:", url, e);
      }
    }
    return null;
  }

  async function handleLimitDetected() {
    if (limitActive) return;
    limitActive = true;
    const epoch = await fetchResetEpoch();
    if (epoch != null) {
      CFC.show(epoch);
    } else {
      console.warn("[Claude額度冷卻翻頁鐘] 偵測到額度用完，但取不到 resets_at，未顯示倒數畫面");
    }
  }

  function handleLimitCleared() {
    limitActive = false;
  }

  const limitObserver = new MutationObserver(() => {
    const exists = !!document.querySelector(LIMIT_SELECTOR);
    if (exists && !limitActive) {
      handleLimitDetected();
    } else if (!exists && limitActive) {
      handleLimitCleared();
    }
  });
  limitObserver.observe(document.body, { childList: true, subtree: true });

  // 頁面載入當下也檢查一次，避免腳本注入時額度剛好已經用完、錯過第一次 DOM 變化
  if (document.querySelector(LIMIT_SELECTOR)) {
    handleLimitDetected();
  }

  // ---- Phase 1 測試用掛鉤：Console 執行 __cfcTest(秒數) 立即開出假倒數 ----
  const target = typeof unsafeWindow !== "undefined" ? unsafeWindow : window;
  target.__cfcTest = function (secondsFromNow) {
    const epoch = Date.now() / 1000 + Number(secondsFromNow || 90);
    CFC.show(epoch);
  };
  target.__cfcClose = CFC.close;

  console.log("[Claude額度冷卻翻頁鐘] Phase 1 已載入。Console 執行 __cfcTest(秒數) 測試，例如 __cfcTest(90000)");
})();
