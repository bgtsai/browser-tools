"""RouteRain v1.0.0 地圖色帶＋開啟時把路線移進可見區（第 2 批）。
用法：python3 test_ribbon.py ../RouteRain.user.js [--shots 目錄] [--engines chromium,firefox]
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
src = src.replace(HOOK, "    window.__rr = { state, injectStyle, buildPanel, render, deactivate, fitRouteIntoView, readViewport, applyPalette };\n    if (false) {")
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
    pg.click('#toggle')                       # Google 左側面板收著（打開時腳本會收）
    pg.add_script_tag(content=fixture)
    pg.add_script_tag(content=src)
    pg.evaluate(OPEN)
    pg.wait_for_timeout(100)
    shot = lambda n: a.shots and engine == 'chromium' and pg.screenshot(path=f'{a.shots}/{n}.png')

    info = pg.evaluate("""(() => { const s = document.getElementById('rr-ribbon'); const cv = document.getElementById('map');
      return { sib: !!s && s.previousElementSibling === cv, paths: s ? s.querySelectorAll('path').length : 0,
        strokes: s ? [...s.querySelectorAll('path')].map(p => [p.getAttribute('stroke'), +p.getAttribute('stroke-width')]) : [] }; })()""")
    check('色帶插在地圖畫布正後面', info['sib'], info)
    L = pg.evaluate("""(() => { const s = document.getElementById('rr-ribbon');
      const v = sel => [...s.querySelectorAll(sel)].map(p => [p.getAttribute('stroke'), +p.getAttribute('stroke-width'), +(p.getAttribute('stroke-opacity') || 1)]);
      return { glow: v('g[filter] path'), body: v(':scope > path'), scan: !!s.querySelector('rect[mask][fill^="url"]'),
        blur: +(s.querySelector('feGaussianBlur') || {getAttribute: () => 0}).getAttribute('stdDeviation') }; })()""")
    order = [w for _, w, _ in L['body']]
    check('沒有 Google 藍外框；先畫全部外框（14）再畫填色（10）', '#1967d2' not in [s for s, _, _ in L['body']] and order == sorted(order, reverse=True) and set(order) == {14, 10}, order)
    check('光暈：模糊 5、寬 24、第 3 級填色', L['blur'] == 5 and L['glow'] and all(s == '#9d5cde' and w == 24 for s, w, _ in L['glow']), L['glow'][:3])
    check('S1 掃描線：色帶範圍內的橫線', L['scan'])
    # 21:30 出發：大同區 20% 第 1 級、中山區／松山區 30% 第 2 級，交界漸變
    fills = [s for s, w, _ in L['body'] if w == 10]
    check('最早一欄的色帶：第 1 級→第 2 級、中間有漸變色', 'rgb(236,221,248)' in fills and 'rgb(201,160,235)' in fills and len(set(fills)) > 4, fills)
    ga = sorted(set(o for _, _, o in L['glow']))
    check('光暈強度：第 1 級 0.15、第 2 級 0.30，交界內插', ga[0] == 0.15 and ga[-1] == 0.3 and len(ga) > 3, ga)
    # 投影位置：路線起點對得上獨立算出的座標
    start = pg.evaluate("(() => { const d = document.querySelector('#rr-ribbon path').getAttribute('d'); const m = d.match(/^M([-\\d.]+) ([-\\d.]+)/); return [+m[1], +m[2]]; })()")
    exp = pg.evaluate(f"({PROJ})(25.05, 121.51)")
    check('色帶起點＝經緯度投影到螢幕的位置', abs(start[0] - exp[0]) < 0.2 and abs(start[1] - exp[1]) < 0.2, (start, exp))
    shot('r1_open')

    # 指到第 48 欄（次日 09:30）：中山區 30% 雷陣雨 → 第 3 級；地圖標出那個點
    cell = pg.evaluate("(() => { const e = document.querySelectorAll('.rr-row')[4].querySelectorAll('.rr-c')[48].getBoundingClientRect(); return [e.left + 6, e.top + 6]; })()")
    pg.mouse.move(*cell)
    cols = set(p.get_attribute('stroke') for p in pg.query_selector_all('#rr-ribbon > path[stroke-width="10"]'))
    check('指到第 48 欄：色帶換成那一欄（含第 3 級）', 'rgb(157,92,222)' in cols, sorted(cols))
    # 換配色：色帶重畫成 M 藍，不重算路線
    pg.evaluate("window.__rr.applyPalette('m')")
    cols = set(p.get_attribute('stroke') for p in pg.query_selector_all('#rr-ribbon > path[stroke-width="10"]'))
    shot('r2m_hover_m')
    check('換成 M 藍：色帶即時重畫', 'rgb(74,125,198)' in cols and 'rgb(157,92,222)' not in cols, sorted(cols)[:4])
    pg.evaluate("window.__rr.applyPalette('k2')")
    mk = pg.evaluate("(() => { const c = document.querySelector('#rr-ribbon circle'); return c ? [+c.getAttribute('cx'), +c.getAttribute('cy')] : null; })()")
    exp = pg.evaluate(f"({PROJ})(25.054, 121.526)")
    check('指到某格：地圖上標出那個點', mk and abs(mk[0] - exp[0]) < 0.2 and abs(mk[1] - exp[1]) < 0.2, (mk, exp))
    shot('r2_hover')
    pg.mouse.move(cell[0], cell[1] + 16)
    mk2 = pg.evaluate("(() => { const c = document.querySelector('#rr-ribbon circle'); return c ? +c.getAttribute('cx') : null; })()")
    check('同一欄換列：標記點跟著移', mk2 is not None and mk2 > mk[0], (mk2, mk))
    pg.mouse.move(700, 100)
    check('離開面板：標記點消失', pg.evaluate("!document.querySelector('#rr-ribbon circle')"))

    # 拖動地圖：按下就淡出；放開後網址延遲更新，穩定後重畫在新位置
    before = start
    pg.evaluate("__map.delayMs = 800")
    pg.mouse.move(900, 200); pg.mouse.down()
    check('按下地圖：色帶淡出', pg.evaluate("document.getElementById('rr-ribbon').style.opacity") == '0')
    pg.mouse.move(800, 150, steps=5)
    pg.wait_for_timeout(900)
    check('還按著：不重畫', pg.evaluate("document.getElementById('rr-ribbon').style.opacity") == '0')
    pg.mouse.up()
    # 這段假地圖放開 800ms 後才更新網址：期間畫的話會畫在舊位置（腳本另有「網址變了就重畫」
    # 會把它蓋過去，所以要在網址更新前看；450ms 時輪詢（每 200ms）一定已經跑過兩次）
    pg.wait_for_timeout(450)
    check('剛放開（網址還沒更新）：還沒重畫', pg.evaluate("document.getElementById('rr-ribbon').style.opacity") == '0')
    pg.wait_for_timeout(1800)
    pg.evaluate("__map.delayMs = 300")
    after = pg.evaluate("(() => { const d = document.querySelector('#rr-ribbon path').getAttribute('d'); const m = d.match(/^M([-\\d.]+) ([-\\d.]+)/); return [+m[1], +m[2]]; })()")
    exp = pg.evaluate(f"({PROJ})(25.05, 121.51)")
    check('網址穩定後淡入、畫在新位置', pg.evaluate("document.getElementById('rr-ribbon').style.opacity") == '1' and abs(after[0] - exp[0]) < 0.2 and abs(after[0] - before[0] - (-100)) < 1, (before, after, exp))
    # 閒著的時候不能有自己觸發自己的變動（例如每輪重寫 aria-label → boot 的觀察者 → 再重寫）
    n0 = pg.evaluate("(() => { window.__mut = 0; new MutationObserver(ms => { window.__mut += ms.length; }).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['aria-label'] }); return 0; })()")
    pg.wait_for_timeout(1000)
    m = pg.evaluate("window.__mut")
    check('閒著 1 秒：沒有自己觸發的 DOM 變動', m == 0, m)
    # Google 的 DOM 一直在變：拖完之後頁面持續有變動，色帶照樣要在網址穩定後回來
    pg.evaluate("window.__churn = setInterval(() => { const i = document.createElement('i'); document.body.appendChild(i); setTimeout(() => i.remove(), 50); }, 100)")
    pg.mouse.move(900, 250); pg.mouse.down(); pg.mouse.move(850, 250, steps=3); pg.mouse.up()
    pg.wait_for_timeout(2000)
    check('頁面一直有 DOM 變動：色帶仍在網址穩定後淡入', pg.evaluate("document.getElementById('rr-ribbon').style.opacity") == '1')
    pg.evaluate("clearInterval(window.__churn)")
    # 滾輪也算
    pg.mouse.move(900, 300); pg.mouse.wheel(0, -120)
    check('滾輪：色帶淡出', pg.evaluate("document.getElementById('rr-ribbon').style.opacity") == '0')
    pg.wait_for_timeout(1600)
    check('滾輪停下、網址穩定後淡入', pg.evaluate("document.getElementById('rr-ribbon').style.opacity") == '1')
    # 在自己面板裡捲動不算
    pg.mouse.move(400, 850); pg.mouse.wheel(0, 120)
    check('在面板裡捲動：色帶不淡出', pg.evaluate("document.getElementById('rr-ribbon').style.opacity") == '1')

    # 收合：色帶保留
    pg.click('[data-rr-act="collapse"]')
    check('收合後色帶保留', pg.evaluate("document.querySelectorAll('#rr-ribbon path').length") > 1)
    pg.click('[data-rr-act="collapse"]')

    # 移進可見區：先把地圖移到很遠、拉很近，路線完全在畫面外
    pg.evaluate("(() => { Object.assign(__map, { lat: 25.10, lon: 121.62, zoom: 17 }); location.hash = `/maps/dir/a/b/@25.1000000,121.6200000,17.00z`; })()")
    pg.wait_for_timeout(1500)
    pg.evaluate("window.__rr.fitRouteIntoView()")
    pg.wait_for_function("window.__rr.state && window.__map.drags > 0", timeout=10000)
    pg.wait_for_timeout(9000)
    res = pg.evaluate("""(() => { const pr = document.getElementById('rr-panel').getBoundingClientRect();
      const s = document.getElementById('rr-ribbon'); const d = [...s.querySelectorAll('path')][0].getAttribute('d');
      const xs = [], ys = []; d.replace(/[ML]([-\\d.]+) ([-\\d.]+)/g, (_, x, y) => { xs.push(+x); ys.push(+y); });
      return { box: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)], panelTop: pr.top,
        zoom: window.__rr.readViewport().zoom, drags: __map.drags, wheels: __map.wheels, op: s.style.opacity }; })()""")
    bx = res['box']
    check('移進可見區：整條路線在面板上方、右側讓出 64', bx[0] >= 0 and bx[1] >= 0 and bx[2] <= 1512 - 64 and bx[3] <= res['panelTop'], res)
    cx, cy = (bx[0] + bx[2]) / 2, (bx[1] + bx[3]) / 2
    check('路線中心靠近可見區中心（±20）', abs(cx - (48 + 1512 - 64 - 48) / 2) < 20 and abs(cy - (48 + res['panelTop'] - 48) / 2) < 20, (cx, cy, res['panelTop']))
    check('拉遠到放得下（zoom 比 17 小）', res['zoom'] < 17 and res['wheels'] > 0, res)
    check('做完色帶淡入', res['op'] == '1', res['op'])
    shot('r3_fit')
    # 已經在可見區就不動
    d0, w0 = res['drags'], res['wheels']
    pg.evaluate("window.__rr.fitRouteIntoView()"); pg.wait_for_timeout(1500)
    n = pg.evaluate("[__map.drags, __map.wheels]")
    check('已經在可見區：不再移動', n == [d0, w0], (n, d0, w0))

    pg.evaluate("window.__rr.deactivate()")
    check('關閉：色帶移除', pg.evaluate("!document.getElementById('rr-ribbon')"))
    check('沒有頁面錯誤', not errs, errs)
    b.close()

with sync_playwright() as pw:
    for e in a.engines.split(','):
        run(e, pw)
print('全部通過' if not fails else f'失敗 {len(fails)} 項：' + '、'.join(fails))
sys.exit(1 if fails else 0)
