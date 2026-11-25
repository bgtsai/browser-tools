"""RouteRain v1.4.1 點格子：釘住那一欄並把地圖移到那個點（使用者選 C1；照 v0.77.0 原樣停在畫面中心）。
用法：python3 test_focus.py ../RouteRain.user.js [--shots 目錄] [--engines chromium,firefox]
假地圖見 harness.html 的 __fakeMapOn：視野只寫在網址，放開後延遲才更新。
"""
import sys, json, pathlib, argparse
from playwright.sync_api import sync_playwright

ap = argparse.ArgumentParser()
ap.add_argument('script'); ap.add_argument('--shots'); ap.add_argument('--engines', default='chromium,firefox')
a = ap.parse_args()
HERE = pathlib.Path(__file__).parent
src = pathlib.Path(a.script).read_text(encoding='utf-8')
HOOK = "    if (document.readyState === 'loading') {"
assert src.count(HOOK) == 1
TAIL = "    if (document.readyState === 'loading') {\n        document.addEventListener('DOMContentLoaded', boot);\n    } else {\n        boot();\n    }"
assert src.count(TAIL) == 1, '啟動段的寫法變了，測試要跟著改'
src = src.replace(TAIL, HOOK + "\n    }")
src = src.replace(HOOK, "    window.__rr = { state, injectStyle, buildPanel, render, deactivate, fitRouteIntoView, readViewport, visibleMapArea };\n    if (false) {")
# boot() 才會掛「地圖被操作就淡出」的監聽：測試要它，但不要它注入按鈕
src = src.replace("    window.__rr = {", "    window.__rrBoot = boot;\n    window.__rr = {", 1)
fixture = (HERE / 'fixture.js').read_text(encoding='utf-8')
OPEN = """() => { const rr = window.__rr; window.__fakeMapOn(); window.__rrBoot(); rr.injectStyle();
  const p = rr.buildPanel(); document.body.appendChild(p);
  rr.state.panel = p; rr.state.body = p.querySelector('.rr-body'); rr.state.active = true;
  rr.render(rr.state.body, window.__fixture(rr)); return true; }"""
# 跟腳本無關的獨立投影，拿來對答案
PROJ = """(lat, lon) => { const m = location.hash.match(/@(-?[\\d.]+),(-?[\\d.]+),([\\d.]+)z/);
  const P = (la, lo, z) => { const w = 256 * 2 ** z, s = Math.sin(la * Math.PI / 180);
    return { x: (lo + 180) / 360 * w, y: (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * w }; };
  const z = +m[3], c = P(+m[1], +m[2], z), p = P(lat, lon, z);
  return [innerWidth / 2 + p.x - c.x, innerHeight / 2 + p.y - c.y]; }"""

fails = []
def check(name, ok, detail=''):
    print(('  OK  ' if ok else '  FAIL') + ' ' + name + ('' if ok else '  ' + str(detail)))
    if not ok: fails.append(name)

def run(engine, pw):
    print(f'== {engine}')
    b = getattr(pw, engine).launch()
    pg = b.new_page(viewport={'width': 1512, 'height': 888})
    errs = []
    pg.on('pageerror', lambda e: errs.append(str(e)))
    pg.goto((HERE / 'harness.html').as_uri())
    pg.click('#toggle')
    pg.add_script_tag(content=fixture)
    pg.add_script_tag(content=src)
    pg.evaluate(OPEN)
    pg.wait_for_timeout(300)
    # 點第 5 列（松江路，nodes[4]）第 49 欄的格子
    cell = pg.evaluate("(() => { const e = document.querySelectorAll('.rr-row')[4].querySelectorAll('.rr-c')[48].getBoundingClientRect(); return [e.left + 6, e.top + 6]; })()")
    d0 = pg.evaluate("__map.drags + __map.wheels")
    pg.mouse.click(*cell)
    pg.wait_for_function("__map.drags > 0", timeout=10000)
    pg.wait_for_timeout(12000)
    res = pg.evaluate("""(() => { const n = window.__fixture(window.__rr).nodes[4]; const a = window.__rr.visibleMapArea();
      const p = (""" + PROJ + """)(n.lat, n.lon);
      return { p, area: [a.left, a.top, a.right, a.bottom], zoom: window.__rr.readViewport().zoom,
        pinned: !!document.querySelector('.rr-pin'), pinnedMs: window.__rr.state.pinnedMs, moves: __map.drags + __map.wheels }; })()""")
    a = res['area']; cx, cy = 1512 / 2, 888 / 2      # 畫面（畫布）中心：Google 滾輪縮放的錨點
    check('點格子：那一欄被釘住', res['pinnedMs'] is not None, res)
    check('地圖拉近到 17 級（±0.3）', abs(res['zoom'] - 17) <= 0.3, res)
    check('那個點停在畫面中心（±25）', abs(res['p'][0] - cx) <= 25 and abs(res['p'][1] - cy) <= 25, (res['p'], cx, cy))
    check('點在可見區內、不被面板蓋住', a[1] <= res['p'][1] <= a[3], res)
    # 把地圖移走，取消釘住時才看得出有沒有被移回來
    pg.evaluate("(() => { Object.assign(__map, { lat: 25.03, lon: 121.50, zoom: 15 }); location.hash = `/maps/dir/a/b/@25.0300000,121.5000000,15.00z`; })()")
    pg.wait_for_timeout(1500)
    m1 = pg.evaluate("__map.drags + __map.wheels")
    pg.mouse.click(*pg.evaluate("(() => { const e = document.querySelectorAll('.rr-row')[4].querySelectorAll('.rr-c')[48].getBoundingClientRect(); return [e.left + 6, e.top + 6]; })()"))
    pg.wait_for_timeout(2500)
    res2 = pg.evaluate("({ pinnedMs: window.__rr.state.pinnedMs, moves: __map.drags + __map.wheels })")
    check('再點一次：取消釘住、不動地圖', res2['pinnedMs'] is None and res2['moves'] == m1, (res2, m1))
    # 點摘要條（不是格子）只釘住、不動地圖
    sumxy = pg.evaluate("(() => { const e = document.querySelector('.rr-sum').getBoundingClientRect(); return [e.left + 60 * 13 + 6, e.top + 4]; })()")
    pg.mouse.click(*sumxy)
    pg.wait_for_timeout(2000)
    res3 = pg.evaluate("({ pinnedMs: window.__rr.state.pinnedMs, moves: __map.drags + __map.wheels })")
    check('點摘要條：只釘住、不動地圖', res3['pinnedMs'] is not None and res3['moves'] == m1, (res3, m1))
    # 移動途中離開路線地圖（進街景）：這一趟要停手，不能在街景裡繼續拖
    cell2 = pg.evaluate("(() => { const e = document.querySelectorAll('.rr-row')[8].querySelectorAll('.rr-c')[30].getBoundingClientRect(); return [e.left + 6, e.top + 6]; })()")
    pg.mouse.click(*cell2)
    pg.wait_for_function("__map.drags + __map.wheels > " + str(res3['moves']), timeout=10000)
    pg.evaluate("(() => { __map.path = '/maps/@25.0550000,121.5300000,3a,75y,90t'; location.hash = '/maps/@25.0550000,121.5300000,3a,75y,90t/data=x'; })()")
    pg.wait_for_timeout(1200)
    s1 = pg.evaluate("__map.drags + __map.wheels")
    pg.wait_for_timeout(6000)
    s2 = pg.evaluate("__map.drags + __map.wheels")
    check('移動途中進街景：停手、不再拖', s2 == s1, (s1, s2))
    # 從很低的縮放層級、很遠的地方點（大範圍路線）：一次就要對準，不能要點兩次
    pg.evaluate("(() => { Object.assign(__map, { lat: 24.95, lon: 121.30, zoom: 11 }); __map.path = '/maps/dir/a/b'; location.hash = `/maps/dir/a/b/@24.9500000,121.3000000,11.00z`; })()")
    pg.wait_for_timeout(1500)
    w0 = pg.evaluate("__map.drags + __map.wheels")
    cell3 = pg.evaluate("(() => { const e = document.querySelectorAll('.rr-row')[6].querySelectorAll('.rr-c')[20].getBoundingClientRect(); return [e.left + 6, e.top + 6]; })()")
    pg.mouse.click(*cell3)
    pg.wait_for_function("__map.drags + __map.wheels > " + str(w0), timeout=10000)
    # 移動分好幾段，段與段之間會等網址停穩（最多 3 秒）：連續 4 秒沒動才算做完
    prev, still = -1, 0
    for _ in range(60):
        cur = pg.evaluate("__map.drags + __map.wheels")
        still = still + 1 if cur == prev else 0
        if still >= 5: break
        prev = cur; pg.wait_for_timeout(800)
    res4 = pg.evaluate("""(() => { const n = window.__fixture(window.__rr).nodes[6];
      const p = (""" + PROJ + """)(n.lat, n.lon); return { p, zoom: window.__rr.readViewport().zoom }; })()""")
    check('從 11 級點：一次就拉近到 17 級、停在畫面中心（±25）', abs(res4['zoom'] - 17) <= 0.3 and abs(res4['p'][0] - cx) <= 25 and abs(res4['p'][1] - cy) <= 25, res4)
    check('沒有頁面錯誤', not errs, errs)
    b.close()

with sync_playwright() as pw:
    for e in a.engines.split(','):
        run(e, pw)
print('全部通過' if not fails else f'失敗 {len(fails)} 項：{fails}')
sys.exit(1 if fails else 0)
