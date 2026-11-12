# browser-tools 交接

每支工具各自一個資料夾，總覽見 README.md。這裡只放「進行中」工具的交接。

## claude-context-meter（Claude 上下文用量）— 進行中

### 目前狀態（2026-11-12）
- v0.4.0：送出訊息時尾端附 `[ctx NN%・X萬]`（Enter 與送出鈕都攔，下一格再按送出鈕放行；/ 開頭、已有標記不加）。真實編輯器是 tiptap／ProseMirror，插入會變新段落（實測）；Firefox 實機送出已確認。
- v0.3.0：點標籤開詳細面板（含〔校正〕）、視窗底部三色呼吸燈帶（紅≥80%＞黃≥70%＞藍建議換串），照 mockup 定案。
- v0.2.0：標籤搬到頁首（⌄ 右邊、交接鈕左邊，class `ccm-meter`；交接腳本 v1.2.0 會排在它後面），只顯示 `NN%`／`NN%・建議換串`，70% 黃、80% 紅。
- v0.1.0（a748d39），使用者已在 Chrome 安裝；真實頁面驗證可用：標籤顯示用量與「建議換串」，k 自動校正。
- 準確度：用前一次 /context 的 k 預測下一次，誤差 +3.6%（k 1.82 → 1.735）。
- 設計與預設值見 `claude-context-meter/README.md`；背景與資料來源比較見知識庫 22 號第 ⑧ 節。
- 診斷用的 `claude-usage-probe/`（v1.2.0）任務已完成，使用者可以停用。

### 下一步（依序）
1. **介面**：已完成（v0.3.0），待實機確認。
   - claude-context-usage-grid v1.1.0 已收成兩層（「顯示用量詳細資料」→ 方格圖 →「顯示原始資料」），待實機確認。
2. **把用量帶給 Claude**：已完成（v0.4.0）。2026-11-12 Firefox 實機確認：送出後訊息尾端有 `[ctx 49%・49.4萬]`、Claude 讀得到（更新腳本後要重新整理頁面才生效）。Chrome 實機待確認。01 v2.49 已改成讀標記。
3. **Claude → 腳本**：Claude 回覆裡放固定格式的「下一階段約 N 輪」，腳本讀到就更新判斷（目前固定 15 輪）。**做之前先問**格式。
4. **未測**：對話被自動壓縮後對話樹會不會變短；Firefox 實機只確認了用量標記，頁首標籤、面板、燈帶、〔校正〕還沒確認；Chrome 實機 v0.2.0 之後都還沒確認。

### 怎麼測
- 夾具：`cd claude-context-meter/tests && python3 server.py &`，再 `python3 test.py ../ClaudeContextMeter.user.js`（9 項）、`python3 test_ui.py ../ClaudeContextMeter.user.js`（11 項）、`python3 test_tag.py ../ClaudeContextMeter.user.js`（4 項），都是 Chromium＋Firefox。新規則要用改壞版反證，先印替換次數。
- 真實頁面：使用者 Chrome 裝了 Claude in Chrome，可開自己的分頁讀 `window.__ccm.last`、對話樹、送 `/context`（不呼叫模型、輸出約 3 千 token 會進上下文，別常送）。
- 自己發工作階段 GET 要帶 `anthropic-version: 2023-06-01`。
