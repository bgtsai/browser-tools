# Route Rain

Google Maps Tampermonkey 使用者腳本，疊加中央氣象署降雨預報在路線規劃上。

## （選填）使用者需要自行提供的 Token

腳本本身**不內建任何憑證**。**預設情況下完全不需要任何 token**——直接讀取 GitHub 上這份每小時自動更新的快取即可正常運作。

只有在下列情況，才需要使用者透過 Tampermonkey 選單自行輸入、存在瀏覽器本機：

- **中央氣象署開放資料授權碼**：GitHub 快取來源失敗時的 fallback，或使用者想跳過快取、即時查詢最新資料時才會用到

**為什麼不能寫死在腳本裡**：自動更新需要 `@downloadURL` 指向公開網址，代表腳本原始碼本身必然是公開的——token 若寫進原始碼，就等於把它公開貼在 GitHub 上，任何人都看得到。

> 註：早期版本另外需要 Google Maps API token（Routes API），後來腳本改成直接讀取 Google Maps 頁面上已經算好的路線資料，不再另外呼叫 Routes API，這組 token 已經不需要了。

## 這個資料夾底下的檔案

| 檔案 | 用途 |
|---|---|
| `RouteRain.user.js` | Tampermonkey 使用者腳本本體，安裝進瀏覽器的就是這支 |
| `cwa_cache.json` | 全台 22 縣市 368 個鄉鎮的降雨預報快取，由下方的 GitHub Actions 自動維護，每小時整點 30 分更新 |
| `route_rain_status.xml` | 上述快取更新流程的執行狀態 RSS，供監控用（見下方訂閱網址） |
| `tw_town_boundaries_moi1140318.json` | 台灣鄉鎮界線資料，供腳本判斷路線經過哪個鄉鎮用，跟氣象快取是各自獨立的資料 |
| `scripts/fetch_cwa.sh` | 產生 `cwa_cache.json` 與 `route_rain_status.xml` 的抓取腳本，由 GitHub Actions 排程執行 |

## 氣象快取怎麼運作

排程定義在 `.github/workflows/route_rain_cwa_fetch.yml`，每小時整點 30 分（UTC `30 * * * *`）自動觸發：

1. 循序打中央氣象署 22 縣市 API，取得未來 96 小時降雨機率與天氣現象
2. 精簡成 `縣市/鄉鎮` 為 key 的格式（見下方資料格式），跟現有快取合併（單次抓取失敗的鄉鎮會沿用上次成功的資料）
3. 寫回 `cwa_cache.json`、`route_rain_status.xml`，`git commit` 推回本 repo

也可以在 GitHub 網頁的 Actions 分頁手動觸發（`workflow_dispatch`），不用等排程。

## 監控：訂閱執行狀態 RSS

```
https://raw.githubusercontent.com/bgtsai/browser-tools/main/route-rain/route_rain_status.xml
```

用一般 RSS 閱讀器訂閱上面這個網址即可（**不要用 `api.github.com/repos/.../contents/...` 這種網址，那個回傳的是包了一層 JSON 的格式，RSS 閱讀器解析不了**）。每次執行會產生一則新項目：

- 🟢 一切正常
- 🟡 有重試但最終成功
- 🔴 有縣市資料缺漏，或推送失敗

內容包含具體診斷（哪個縣市失敗、失敗原因、中央氣象署原始回應片段等），保留最近 20 筆紀錄。

## cwa_cache.json 格式

```json
{
  "_meta": {
    "fetched_at_utc": "2026-08-19T02:55:13Z",
    "fetched_at_tw": "2026-08-19 10:55:13 +08:00",
    "stale_this_run": []
  },
  "towns": {
    "臺北市/松山區": [
      ["2026-08-19T12:00:00+08:00", "20", "多雲"],
      ...
    ]
  }
}
```

- `towns` 的 key 是 `縣市/鄉鎮` 複合字串（不是單純鄉鎮名，避免跨縣市同名鄉鎮互相覆蓋，例如「中正區」臺北市、基隆市都有）
- 每筆值是 `[時間, 降雨機率, 天氣現象]`，涵蓋未來 96 小時（32 個 3 小時區間）
- `stale_this_run`：這次執行中，哪些鄉鎮沒抓到新資料、沿用了上次的舊值

## 目前狀態

- ✅ GitHub Actions 抓取管線：正式運作中
- ✅ `RouteRain.user.js`：已整合，**預設使用這份 GitHub 快取**（`forecastSourceMode` 預設值 `github`），GitHub 來源失敗時自動退回直連中央氣象署 API，並在畫面上標示目前實際使用的來源
