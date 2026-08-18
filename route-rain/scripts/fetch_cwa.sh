#!/bin/bash
set -euo pipefail

CITY_LIST="臺北市,F-D0047-061 新北市,F-D0047-069 基隆市,F-D0047-049 桃園市,F-D0047-005 新竹市,F-D0047-053 新竹縣,F-D0047-009 苗栗縣,F-D0047-013 臺中市,F-D0047-073 彰化縣,F-D0047-017 南投縣,F-D0047-021 雲林縣,F-D0047-025 嘉義市,F-D0047-057 嘉義縣,F-D0047-029 臺南市,F-D0047-077 高雄市,F-D0047-065 屏東縣,F-D0047-033 宜蘭縣,F-D0047-001 花蓮縣,F-D0047-041 臺東縣,F-D0047-037 澎湖縣,F-D0047-045 金門縣,F-D0047-085 連江縣,F-D0047-081"

CWA_KEY="${CWA_API_TOKEN:?請設定 CWA_API_TOKEN 環境變數}"
SLEEP_BETWEEN=2
CONNECT_TIMEOUT=5
MAX_TIME=20

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA_FILE="${REPO_ROOT}/route-rain/cwa_cache.json"
RSS_FILE="${REPO_ROOT}/route-rain/route_rain_status.xml"

TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT

missing_list=""
fetched_count=0
had_retry=0
retry_log=""
fail_log=""
total_count=0

for pair in $CITY_LIST; do
  total_count=$((total_count + 1))
  city_name=${pair%%,*}
  dataid=${pair##*,}
  url="https://opendata.cwa.gov.tw/api/v1/rest/datastore/${dataid}?Authorization=${CWA_KEY}&format=JSON"

  attempt=1
  city_ok=0
  city_retried=0
  fail_reason=""

  while [ "$attempt" -le 2 ]; do
    echo "→ 請求 ${city_name}(${dataid}) 第${attempt}次"
    req_start=$(date +%s)
    raw=$(curl -s --connect-timeout "$CONNECT_TIMEOUT" --max-time "$MAX_TIME" "$url" || true)
    req_end=$(date +%s)
    echo "← ${city_name} 耗時$((req_end - req_start))秒 長度$(printf '%s' "$raw" | wc -c)bytes"

    if [ -n "$raw" ]; then
      if printf '%s' "$raw" | jq -c --arg city "$city_name" '
          .records.Locations[0].Location // [] | map({
            ("\($city)/\(.LocationName)"): (
              (.WeatherElement[] | select(.ElementName=="3小時降雨機率") | .Time) as $rain |
              (.WeatherElement[] | select(.ElementName=="天氣現象") | .Time) as $wx |
              [ range(0; ($rain|length)) as $i |
                [ $rain[$i].StartTime,
                  $rain[$i].ElementValue[0].ProbabilityOfPrecipitation,
                  ($wx[$i].ElementValue[0].Weather // null) ]
              ]
            )
          }) | add
        ' > "${TMPDIR}/${dataid}.json" 2>"${TMPDIR}/${dataid}.err"; then
        content_check=$(cat "${TMPDIR}/${dataid}.json")
        if [ -n "$content_check" ] && [ "$content_check" != "null" ] && [ "$content_check" != "{}" ]; then
          city_ok=1
          break
        else
          fail_reason="資料為空"
          snippet=$(printf '%s' "$raw" | tr '\r\n' '  ' | tr -s ' ' | cut -c1-150)
          echo "  ${city_name} 資料為空，原始片段：${snippet}"
        fi
      else
        fail_reason="解析失敗"
        jq_err=$(tr '\r\n' '  ' < "${TMPDIR}/${dataid}.err" | tr -s ' ' | cut -c1-150)
        snippet=$(printf '%s' "$raw" | tr '\r\n' '  ' | tr -s ' ' | cut -c1-150)
        echo "  ${city_name} 解析失敗，jq錯誤：${jq_err}，原始片段：${snippet}"
      fi
    else
      fail_reason="空回應"
    fi

    if [ "$attempt" -eq 1 ]; then
      city_retried=1
      sleep 2
    fi
    attempt=$((attempt + 1))
  done

  if [ "$city_ok" = "1" ]; then
    fetched_count=$((fetched_count + 1))
    if [ "$city_retried" = "1" ]; then
      had_retry=1
      retry_log="${retry_log}$(date -u +%H:%M:%S) ${city_name} 重試成功\n"
    fi
  else
    missing_list="${missing_list}${city_name} "
    fail_log="${fail_log}$(date -u +%H:%M:%S) ${city_name} 失敗（${fail_reason}）\n"
  fi
  echo "  ${city_name} 結果=${city_ok} 重試=${city_retried} 失敗原因=${fail_reason:-無}"
  sleep "$SLEEP_BETWEEN"
done

echo "抓取階段結束，成功 ${fetched_count}/${total_count}"

# 驗證每個檔案、排除損毀的
valid_files=()
for f in "${TMPDIR}"/*.json; do
  [ -e "$f" ] || continue
  if jq empty "$f" >/dev/null 2>&1; then
    valid_files+=("$f")
  else
    echo "  發現損毀檔案，排除：$f"
  fi
done

if [ "${#valid_files[@]}" -gt 0 ]; then
  new_towns=$(jq -s 'add // {}' "${valid_files[@]}")
else
  new_towns='{}'
fi

# 合併舊資料（直接讀本機 checkout 出來的檔案，不需要打 API）
echo "$new_towns" > "${TMPDIR}/new_towns.json"
if [ -f "$DATA_FILE" ]; then
  jq -c '.towns // {}' "$DATA_FILE" > "${TMPDIR}/old_towns.json" 2>/dev/null || echo '{}' > "${TMPDIR}/old_towns.json"
else
  echo '{}' > "${TMPDIR}/old_towns.json"
fi

jq -s '.[0] * .[1]' "${TMPDIR}/old_towns.json" "${TMPDIR}/new_towns.json" > "${TMPDIR}/merged_towns.json" 2>/dev/null || cp "${TMPDIR}/new_towns.json" "${TMPDIR}/merged_towns.json"
jq -n --slurpfile old "${TMPDIR}/old_towns.json" --slurpfile new "${TMPDIR}/new_towns.json" '(($old[0] | keys) - ($new[0] | keys))' > "${TMPDIR}/stale.json" 2>/dev/null || echo '[]' > "${TMPDIR}/stale.json"

utc_now=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
tw_now=$(TZ=Asia/Taipei date +"%Y-%m-%d %H:%M:%S +08:00")

mkdir -p "$(dirname "$DATA_FILE")"
jq -n --arg utc "$utc_now" --arg tw "$tw_now" \
  --slurpfile towns "${TMPDIR}/merged_towns.json" --slurpfile stale "${TMPDIR}/stale.json" \
  '{_meta: {fetched_at_utc: $utc, fetched_at_tw: $tw, stale_this_run: $stale[0]}, towns: $towns[0]}' \
  > "$DATA_FILE"

echo "已寫入 $DATA_FILE"

# ── 組 RSS ──────────────────────────────────
if [ -n "$missing_list" ]; then
  color="🔴"; reason="資料缺漏"
elif [ "$had_retry" = "1" ]; then
  color="🟡"; reason="抓取重試"
else
  color="🟢"; reason="一切正常"
fi

title_time=$(TZ=Asia/Taipei date +"%H:%M")
title_date=$(TZ=Asia/Taipei date +"%Y.%m.%d")
item_title="${color} ${title_time} ${title_date}｜${reason}"

if [ -z "$retry_log" ]; then retry_display="（本次無）"; else retry_display=$(printf '%b' "$retry_log" | awk 'NF' | awk 'NR>1{printf "&lt;br&gt;"} {printf "%s", $0}'); fi
if [ -z "$fail_log" ]; then fail_display="（本次無）"; else fail_display=$(printf '%b' "$fail_log" | awk 'NF' | awk 'NR>1{printf "&lt;br&gt;"} {printf "%s", $0}'); fi

item_desc="【摘要】成功 ${fetched_count}/${total_count} 縣市&lt;br&gt;&lt;br&gt;【重試紀錄】&lt;br&gt;${retry_display}&lt;br&gt;&lt;br&gt;【失敗紀錄】&lt;br&gt;${fail_display}"

pub_date=$(date -u +"%a, %d %b %Y %H:%M:%S +0000")
guid="route-rain-$(date -u +%s)"

# 保留最近 20 筆既有 item（如果 RSS 檔案已存在）
mkdir -p "$(dirname "$RSS_FILE")"
existing_items=""
if [ -f "$RSS_FILE" ]; then
  existing_items=$(sed -n '/<item>/,/<\/item>/p' "$RSS_FILE" | head -c 200000)
fi

{
  echo '<?xml version="1.0" encoding="UTF-8"?>'
  echo '<rss version="2.0"><channel>'
  echo '<title>Route Rain 氣象快取更新狀態</title>'
  echo '<description>路線降雨預報 — GitHub Actions 氣象快取抓取執行紀錄</description>'
  echo '<link>https://github.com/bgtsai/browser-tools</link>'
  echo "<item><title>${item_title}</title><description><![CDATA[${item_desc}]]></description><pubDate>${pub_date}</pubDate><guid isPermaLink=\"false\">${guid}</guid></item>"
  if [ -n "$existing_items" ]; then
    printf '%s\n' "$existing_items" | grep -o '<item>.*</item>' | head -19
  fi
  echo '</channel></rss>'
} > "$RSS_FILE"

echo "已寫入 $RSS_FILE"
echo "SUMMARY_TITLE=${item_title}" >> "${GITHUB_STEP_SUMMARY:-/dev/null}" 2>/dev/null || true
echo "$item_title"
