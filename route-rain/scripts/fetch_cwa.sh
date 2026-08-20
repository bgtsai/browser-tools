#!/bin/bash
set -euo pipefail

CITY_LIST="臺北市,F-D0047-061 新北市,F-D0047-069 基隆市,F-D0047-049 桃園市,F-D0047-005 新竹市,F-D0047-053 新竹縣,F-D0047-009 苗栗縣,F-D0047-013 臺中市,F-D0047-073 彰化縣,F-D0047-017 南投縣,F-D0047-021 雲林縣,F-D0047-025 嘉義市,F-D0047-057 嘉義縣,F-D0047-029 臺南市,F-D0047-077 高雄市,F-D0047-065 屏東縣,F-D0047-033 宜蘭縣,F-D0047-001 花蓮縣,F-D0047-041 臺東縣,F-D0047-037 澎湖縣,F-D0047-045 金門縣,F-D0047-085 連江縣,F-D0047-081"

CWA_KEY="${CWA_API_TOKEN:?請設定 CWA_API_TOKEN 環境變數}"
SLEEP_BETWEEN=2
CONNECT_TIMEOUT=5
MAX_TIME=120
SPEED_LIMIT=1
SPEED_TIME=20

REPO_ROOT="$(pwd)"
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
    raw=$(curl -s --connect-timeout "$CONNECT_TIMEOUT" --max-time "$MAX_TIME" --speed-limit "$SPEED_LIMIT" --speed-time "$SPEED_TIME" "$url" || true)
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

TRIGGER_TIME="${TRIGGER_TIME:?TRIGGER_TIME 未設定}"
title_time=$(TZ=Asia/Taipei date -d "$TRIGGER_TIME" +"%H:%M")
title_date=$(TZ=Asia/Taipei date -d "$TRIGGER_TIME" +"%Y.%m.%d")
item_title="${color} ${title_time} ${title_date}｜${reason}"

if [ -z "$retry_log" ]; then retry_display="（本次無）"; else retry_display=$(printf '%b' "$retry_log" | awk 'NF' | awk 'NR>1{printf "<br>\n"} {printf "%s", $0}'); fi
if [ -z "$fail_log" ]; then fail_display="（本次無）"; else fail_display=$(printf '%b' "$fail_log" | awk 'NF' | awk 'NR>1{printf "<br>\n"} {printf "%s", $0}'); fi

item_desc="【摘要】成功 ${fetched_count}/${total_count} 縣市<br>
<br>
【重試紀錄】<br>
${retry_display}<br>
<br>
【失敗紀錄】<br>
${fail_display}"

pub_date=$(date -u +"%a, %d %b %Y %H:%M:%S +0000")
guid="route-rain-$(date -u +%s)"

# 組出這次的新 item，交給 Python 用真正的 XML 解析器處理「保留最近 20 筆」，
# 不再用 grep/sed 這種逐行文字比對（多行內容跨行時容易漏掉，見 KB 17 第⑦條相關教訓）
mkdir -p "$(dirname "$RSS_FILE")"

NEW_ITEM_TITLE="$item_title" \
NEW_ITEM_DESC="$item_desc" \
NEW_ITEM_PUBDATE="$pub_date" \
NEW_ITEM_GUID="$guid" \
RSS_FILE="$RSS_FILE" \
python3 << 'PYEOF'
import os
import xml.etree.ElementTree as ET

rss_file = os.environ["RSS_FILE"]
new_title = os.environ["NEW_ITEM_TITLE"]
new_desc = os.environ["NEW_ITEM_DESC"]
new_pubdate = os.environ["NEW_ITEM_PUBDATE"]
new_guid = os.environ["NEW_ITEM_GUID"]

items = []  # 每筆是 (title, desc, pubdate, guid) 的 tuple
if os.path.exists(rss_file):
    try:
        tree = ET.parse(rss_file)
        channel = tree.getroot().find("channel")
        if channel is not None:
            for it in channel.findall("item"):
                t = it.findtext("title", default="")
                d = it.findtext("description", default="")
                p = it.findtext("pubDate", default="")
                g = it.findtext("guid", default="")
                items.append((t, d, p, g))
    except ET.ParseError:
        # 舊檔案格式壞掉就當作沒有歷史，不要讓整支腳本掛掉
        items = []

# 新的一筆放最前面，保留最近 20 筆
items = [(new_title, new_desc, new_pubdate, new_guid)] + items
items = items[:20]

lines = []
lines.append('<?xml version="1.0" encoding="UTF-8"?>')
lines.append('<rss version="2.0"><channel>')
lines.append('<title>Route Rain 氣象快取更新狀態</title>')
lines.append('<description>路線降雨預報 — GitHub Actions 氣象快取抓取執行紀錄</description>')
lines.append('<link>https://github.com/bgtsai/browser-tools</link>')
for t, d, p, g in items:
    lines.append(
        f'<item><title>{t}</title>'
        f'<description><![CDATA[{d}]]></description>'
        f'<pubDate>{p}</pubDate>'
        f'<guid isPermaLink="false">{g}</guid></item>'
    )
lines.append('</channel></rss>')

with open(rss_file, "w", encoding="utf-8") as f:
    f.write("\n".join(lines) + "\n")
PYEOF

echo "已寫入 $RSS_FILE"
echo "SUMMARY_TITLE=${item_title}" >> "${GITHUB_STEP_SUMMARY:-/dev/null}" 2>/dev/null || true
echo "$item_title"
