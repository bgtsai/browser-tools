# browser-tools 交接

每支工具各自一個資料夾，總覽見 README.md。這裡只放「進行中」工具的交接。

## claude-context-meter（Claude 上下文用量）— 進行中

### 目前狀態（2026-11-12）
- v0.2.0：標籤搬到頁首（⌄ 右邊、交接鈕左邊，class `ccm-meter`；交接腳本 v1.2.0 會排在它後面），只顯示 `NN%`／`NN%・建議換串`，70% 黃、80% 紅。
- v0.1.0（a748d39），使用者已在 Chrome 安裝；真實頁面驗證可用：標籤顯示用量與「建議換串」，k 自動校正。
- 準確度：用前一次 /context 的 k 預測下一次，誤差 +3.6%（k 1.82 → 1.735）。
- 設計與預設值見 `claude-context-meter/README.md`；背景與資料來源比較見知識庫 22 號第 ⑧ 節。
- 診斷用的 `claude-usage-probe/`（v1.2.0）任務已完成，使用者可以停用。

### 下一步（依序）
1. **介面**：位置與標籤內容已定（v0.2.0）。剩點開的詳細面板（A2：詳細資料＋「校正」鈕手動送 /context）要先討論資訊層次，定案後才問要不要畫 mockup。**做之前先問。**
   - 另一支待做：claude-context-usage-grid 收成兩層（「顯示用量詳細資料」→ 圖形總結 →「顯示原始資料」），使用者已定案。
2. **把用量帶給 Claude**：送出訊息時自動在訊息尾端附一行短標記（例 `[ctx 62%・26.1萬]`），Claude 每輪讀得到、可照 01 第 ⑫ 條主動建議換串。會改動使用者送出的訊息，**做之前先問**要不要做、標記格式。
3. **Claude → 腳本**：Claude 回覆裡放固定格式的「下一階段約 N 輪」，腳本讀到就更新判斷（目前固定 15 輪）。依第 2 點的決定一起討論。
4. **未測**：對話被自動壓縮後對話樹會不會變短；Firefox 實機。

### 怎麼測
- 夾具：`cd claude-context-meter/tests && python3 server.py &`，再 `python3 test.py ../ClaudeContextMeter.user.js`（Chromium＋Firefox 各 7 項）。新規則要用改壞版反證，先印替換次數。
- 真實頁面：使用者 Chrome 裝了 Claude in Chrome，可開自己的分頁讀 `window.__ccm.last`、對話樹、送 `/context`（不呼叫模型、輸出約 3 千 token 會進上下文，別常送）。
- 自己發工作階段 GET 要帶 `anthropic-version: 2023-06-01`。
