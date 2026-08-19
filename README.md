# browser-tools

放各種瀏覽器端小工具（userscript 為主，不排除其他形式）的 repo。
每支工具各自一個資料夾，`@downloadURL` 一旦寫進使用者的 userscript 管理器就不能再變，所以路徑一開始就固定下來。

## 工具總覽

| 工具 | 說明 | 安裝 | 細節 |
|---|---|---|---|
| [診斷面板骨架](diagnostic-panel/DiagnosticPanel.user.js) | 可複用的診斷面板：相對時間戳、開始/停止、一鍵複製；任務專屬邏輯只需替換探針區塊 | [安裝](https://raw.githubusercontent.com/bgtsai/browser-tools/main/diagnostic-panel/DiagnosticPanel.user.js) | — |
| [Route Rain 路線降雨預報](route-rain/RouteRain.user.js) | 在 Google Maps 路線面板加一顆「路雨」按鈕，列出沿途各鄉鎮在不同出發時間下的降雨機率 | [安裝](https://raw.githubusercontent.com/bgtsai/browser-tools/main/route-rain/RouteRain.user.js) | [route-rain/README.md](route-rain/README.md) |

**資料夾底下有自己的 `README.md` 的，代表這個工具本身有值得另外說明的架構（例如背後有自動化資料管線、需要使用者自行設定的憑證）；只有一個檔案的簡單工具，這份總覽表格就是全部說明，不另開文件。**

## 版本控制

版本號只記在檔案內部（`@version` 與檔案內的版本紀錄，如果有的話），
完整逐次修改歷史看 `git log`。每支工具的 `@version` 必須嚴格遞增，
因為 Tampermonkey／ScriptCat 是用版本號比大小判斷要不要自動更新，不是比對內容。

這條規則適用於本 repo 底下所有工具，不限單一資料夾。
