# browser-tools

放各種瀏覽器端小工具（userscript 為主，不排除其他形式）的 repo。
每支工具各自一個資料夾，`@downloadURL` 一旦寫進使用者的 userscript 管理器就不能再變，所以路徑一開始就固定下來。

## 工具總覽

| 工具 | 說明 | 安裝 |
|---|---|---|
| [診斷面板骨架](diagnostic-panel/DiagnosticPanel.user.js) | 可複用的通用診斷面板：相對時間戳、開始/停止、一鍵複製，任務專屬邏輯只需替換探針區塊 | [安裝](https://raw.githubusercontent.com/bgtsai/browser-tools/main/diagnostic-panel/DiagnosticPanel.user.js) |
| [地圖操作手段測試](map-probe/MapProbe.user.js) | 一次性診斷工具：在與 route-rain 相同的沙箱環境下，逐一測試八種地圖移動與縮放手段是否可用、以及會不會誤改路線 | [安裝](https://raw.githubusercontent.com/bgtsai/browser-tools/main/map-probe/MapProbe.user.js) |
| [Route Rain 路線降雨預報](route-rain/RouteRain.user.js) | 在 Google Maps 路線面板加一顆「路雨」按鈕，列出沿途各鄉鎮在不同出發時間下的降雨機率；資料來自 Google Routes API 與中央氣象署開放資料 | [安裝](https://raw.githubusercontent.com/bgtsai/browser-tools/main/route-rain/RouteRain.user.js) |

## 版本控制

同 `claude-knowledge-base` 的慣例：版本號只記在檔案內部（`@version` 與檔案內的版本紀錄，如果有的話），
完整逐次修改歷史看 `git log`。每支工具的 `@version` 必須嚴格遞增，
因為 Tampermonkey／ScriptCat 是用版本號比大小判斷要不要自動更新，不是比對內容。

## API 金鑰

`route-rain` 需要兩組金鑰，**不寫在腳本裡**，改由使用者自行輸入後存在瀏覽器本機
（Tampermonkey 選單 →「設定 API 金鑰」）：

- Google Maps API 金鑰（Routes API）
- 中央氣象署開放資料授權碼

原因：自動更新需要 `@downloadURL` 指向公開網址，腳本內容必然是公開的；
金鑰若寫進原始碼就等於公開在 GitHub 上。
