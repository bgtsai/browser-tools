"""RouteRain v1.2.0 自動隱藏、暫停膠囊、讓位、點地點自動收合（第 3 批）。
用法：python3 test_modes.py ../RouteRain.user.js [--shots 目錄] [--engines chromium,firefox]
用 harness 的假地圖，改網址（hash）與假的 Google 左側面板模擬各種畫面。
"""
import sys, pathlib, argparse
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
src = src.replace(HOOK, "    window.__rrBoot = boot;\n    window.__rr = { state, injectStyle, buildPanel, render, deactivate, layoutPanel };\n    if (false) {")
fixture = (HERE / 'fixture.js').read_text(encoding='utf-8')
OPEN = """() => { const rr = window.__rr; window.__fakeMapOn(); window.__rrBoot(); rr.injectStyle();
  const p = rr.buildPanel(); document.body.appendChild(p);
  rr.state.panel = p; rr.state.body = p.querySelector('.rr-body'); rr.state.active = true;
  rr.render(rr.state.body, window.__fixture(rr)); return true; }"""

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
    pg.click('#toggle')                       # 打開時腳本已經把左側面板收起來
    pg.add_script_tag(content=fixture)
    pg.add_script_tag(content=src)
    pg.evaluate(OPEN)
    pg.wait_for_timeout(200)
    shot = lambda n: a.shots and engine == 'chromium' and pg.screenshot(path=f'{a.shots}/{n}.png')
    go = lambda h: (pg.evaluate(f"location.hash = {h!r}"), pg.wait_for_timeout(250))
    R = lambda sel: pg.evaluate(f"(() => {{ const e = document.querySelector('{sel}'); if (!e) return null; const r = e.getBoundingClientRect(); return [r.left, r.top, r.width, r.height]; }})()")
    vis = lambda sel: pg.evaluate(f"(() => {{ const e = document.querySelector('{sel}'); return !!e && e.getClientRects().length > 0 && getComputedStyle(e).display !== 'none'; }})()")
    ribbon_shown = lambda: pg.evaluate("(() => { const e = document.getElementById('rr-ribbon'); return !!e && e.style.display !== 'none' && e.querySelectorAll('path').length > 1; })()")

    check('路線地圖：面板與色帶都在、沒有膠囊', vis('#rr-panel') and ribbon_shown() and not vis('.rr-cap'))
    # 先釘住一欄、拖矮，之後看能不能恢復原狀
    cell = pg.evaluate("(() => { const e = document.querySelectorAll('.rr-row')[2].querySelectorAll('.rr-c')[40].getBoundingClientRect(); return [e.left + 6, e.top + 6]; })()")
    pg.mouse.click(*cell); pg.mouse.move(700, 100)
    # v1.4.0 起點格子會把地圖移過去（假地圖放開後才寫網址）：等它做完，免得跟後面的街景搶網址
    pg.wait_for_function("__map.drags + __map.wheels > 0", timeout=10000)
    # 移動分好幾段，段與段之間會等網址停穩（最多 3 秒）：連續 4 秒沒動才算做完
    prev, still = -1, 0
    for _ in range(60):
        cur = pg.evaluate("__map.drags + __map.wheels")
        still = still + 1 if cur == prev else 0
        if still >= 5: break
        prev = cur; pg.wait_for_timeout(800)
    gr = R('.rr-grip'); gx, gy = gr[0] + gr[2] / 2, gr[1] + 4
    pg.mouse.move(gx, gy); pg.mouse.down(); pg.mouse.move(gx, gy + 60, steps=4)
    hd = R('#rr-panel')[3]
    # 拖拉中視窗變了（重排會跑）：高度不能被重排蓋回去
    pg.set_viewport_size({'width': 1500, 'height': 888}); pg.wait_for_timeout(200)
    check('拖拉中重排：不蓋掉正在拖的高度', abs(R('#rr-panel')[3] - hd) < 0.5, (R('#rr-panel')[3], hd))
    pg.mouse.up()
    pg.set_viewport_size({'width': 1512, 'height': 888}); pg.wait_for_timeout(200)
    h0 = R('#rr-panel')[3]; sel0 = pg.text_content('.rr-sel')

    # 進街景
    go('/maps/@25.0550000,121.5300000,3a,75y,90t/data=x')
    check('街景：面板與色帶自動隱藏', not vis('#rr-panel') and not ribbon_shown())
    cap = R('.rr-cap')
    check('街景：膠囊在左下 24px、高 36', cap and cap[0] == 24 and abs(cap[1] + cap[3] - (888 - 24)) < 0.5 and cap[3] == 36, cap)
    check('膠囊文字', pg.text_content('.rr-cap') == '旅途中的雨・暫停', pg.text_content('.rr-cap'))
    shot('m1_street')
    # 回到路線：恢復原狀（高度、釘住的欄）、膠囊消失
    go('/maps/dir/a/b/@25.0550000,121.5300000,15.00z'); pg.wait_for_timeout(1200)   # 網址變了，色帶等穩定才重畫
    check('回到路線：面板與色帶恢復、膠囊消失', vis('#rr-panel') and ribbon_shown() and not vis('.rr-cap'))
    check('恢復原本的高度與釘住的欄', abs(R('#rr-panel')[3] - h0) < 0.5 and pg.text_content('.rr-sel') == sel0, (R('#rr-panel')[3], h0, pg.text_content('.rr-sel'), sel0))

    # 使用者自己收合的：去街景再回來，不會被自動展開
    pg.click('[data-rr-act="collapse"]')
    go('/maps/@25.0550000,121.5300000,3a,75y,90t/data=x'); go('/maps/dir/a/b/@25.0550000,121.5300000,15.00z')
    check('使用者自己收合的：回到路線仍是收合', R('#rr-panel')[3] == 40 and pg.text_content('[data-rr-act="collapse"]') == '展開')
    pg.click('[data-rr-act="collapse"]')

    # 其他畫面（另外搜尋地點，路線面板不在）：隱藏，膠囊讓開圖層縮圖
    pg.evaluate("document.getElementById('opt').remove()")
    go('/maps/place/x/@25.0550000,121.5300000,15.00z')
    cap = R('.rr-cap')
    check('其他畫面：隱藏、膠囊左緣 110', not vis('#rr-panel') and cap and cap[0] == 110, cap)
    # 點膠囊叫回
    pg.click('.rr-cap')
    check('點膠囊：面板叫回、膠囊消失（色帶不畫：路線不在地圖上）', vis('#rr-panel') and not vis('.rr-cap') and not ribbon_shown())
    go('/maps/dir/a/b/@25.0550000,121.5300000,15.00z'); pg.wait_for_timeout(1200)
    check('之後回到路線：正常顯示', vis('#rr-panel') and ribbon_shown())
    pg.evaluate("(() => { const d = document.createElement('div'); d.style.padding = '20px'; d.innerHTML = '<button id=\"opt\">選項</button>'; document.getElementById('side').appendChild(d); })()")

    # 使用者自己打開左側面板：底部面板讓位（左緣＝開關鈕右緣＋9）
    pg.click('#toggle')
    pg.wait_for_timeout(200)
    t = R('#toggle'); p = R('#rr-panel')
    check('左側面板打開：底部面板左緣讓到開關鈕右邊', p[0] == t[0] + t[2] + 9 and abs(p[0] + p[2] - (1512 - 64)) < 0.5, (t, p))
    sc = pg.evaluate("(() => { const s = document.querySelector('.rr-scroll'); return [s.scrollWidth, s.clientWidth]; })()")
    check('放不下就橫捲', sc[0] > sc[1], sc)
    shot('m2_sidebar')
    pg.click('#toggle'); pg.wait_for_timeout(200)
    p = R('#rr-panel')
    check('左側面板收起：撐回滿寬', p[0] == 0 and p[2] == 1512 - 64, p)

    # 點地圖上的地點：Google 並排打開路線＋地點卡 → 自動收合成標題列；太窄就藏「沿路最高」
    pg.evaluate("""(() => { const side = document.getElementById('side'); side.classList.remove('off'); side.style.width = '912px';
      const t = document.getElementById('toggle'); t.setAttribute('aria-label', '收合側邊面板'); t.style.left = '920px'; })()""")
    go('/maps/place/x/@25.0550000,121.5300000,15.00z'); pg.wait_for_timeout(1200)
    p = R('#rr-panel')
    check('點地點：自動收合成標題列、讓到地點卡右邊', p[3] == 40 and p[0] == 952 and pg.text_content('[data-rr-act="collapse"]') == '展開', p)
    check('標題列太窄：藏「沿路最高」、名稱與按鈕留著', not vis('.rr-max') and vis('.rr-name'))
    check('點地點：色帶保留', ribbon_shown())
    btns = pg.evaluate("[...document.querySelectorAll('.rr-tb')].map(b => b.getBoundingClientRect().right)")
    check('按鈕沒有被擠出面板', max(btns) <= p[0] + p[2], (btns, p))
    shot('m3_place')
    # 關掉地點卡、回到路線：自動展開
    pg.evaluate("""(() => { const side = document.getElementById('side'); side.style.width = ''; side.classList.add('off');
      const t = document.getElementById('toggle'); t.setAttribute('aria-label', '展開側邊面板'); t.style.left = '0px'; })()""")
    go('/maps/dir/a/b/@25.0550000,121.5300000,15.00z')
    p = R('#rr-panel')
    check('回到路線：自動展開、滿寬、「沿路最高」與出發→抵達回來', p[3] > 40 and p[0] == 0 and vis('.rr-max') and vis('.rr-sel'), p)
    # 地點狀態下自己按〔展開〕：之後不會又被收回去
    pg.evaluate("""(() => { const side = document.getElementById('side'); side.style.width = '912px'; side.classList.remove('off');
      const t = document.getElementById('toggle'); t.setAttribute('aria-label', '收合側邊面板'); t.style.left = '920px'; })()""")
    go('/maps/place/y/@25.0550000,121.5300000,15.00z')
    pg.click('[data-rr-act="collapse"]')
    pg.evaluate("document.body.appendChild(document.createElement('i'))")   # 觸發一次重排
    pg.wait_for_timeout(200)
    check('地點狀態下按〔展開〕：維持展開', R('#rr-panel')[3] > 40)

    # 視窗縮放：boot() 的 resize 監聽會重排
    pg.set_viewport_size({'width': 1200, 'height': 888}); pg.wait_for_timeout(300)
    p = R('#rr-panel')
    check('視窗變窄：面板跟著重排（左側面板開著時寬＝1200−64−左緣）', abs(p[0] + p[2] - (1200 - 64)) < 0.5, p)
    pg.set_viewport_size({'width': 1512, 'height': 888})

    pg.evaluate("window.__rr.deactivate()")
    check('關閉：膠囊也移除', pg.evaluate("!document.querySelector('.rr-cap')"))
    check('沒有頁面錯誤', not errs, errs)
    b.close()

with sync_playwright() as pw:
    for e in a.engines.split(','):
        run(e, pw)
print('全部通過' if not fails else f'失敗 {len(fails)} 項：' + '、'.join(fails))
sys.exit(1 if fails else 0)
