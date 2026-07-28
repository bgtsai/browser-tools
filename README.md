# browser-tools

放各種瀏覽器端小工具（userscript 為主，不排除其他形式）的 repo。
每支工具各自一個資料夾，`@downloadURL` 一旦寫進使用者的 userscript 管理器就不能再變，所以路徑一開始就固定下來。

## 工具總覽

| 工具 | 說明 | 安裝 |
|---|---|---|
| [診斷面板骨架](diagnostic-panel/DiagnosticPanel.user.js) | 可複用的通用診斷面板：相對時間戳、開始/停止、一鍵複製，任務專屬邏輯只需替換探針區塊 | [安裝](https://raw.githubusercontent.com/bgtsai/browser-tools/main/diagnostic-panel/DiagnosticPanel.user.js) |

## 版本控制

同 `claude-knowledge-base` 的慣例：版本號只記在檔案內部（`@version` 與檔案內的版本紀錄，如果有的話），
完整逐次修改歷史看 `git log`。每支工具的 `@version` 必須嚴格遞增，
因為 Tampermonkey／ScriptCat 是用版本號比大小判斷要不要自動更新，不是比對內容。
