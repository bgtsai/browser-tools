"""RouteRain v1.0.0 底部時間軸面板的畫面測試（第 1 批）。
用法：python3 test_panel.py ../RouteRain.user.js [--shots 目錄] [--engines chromium,firefox]
腳本本體不改；測試時把收尾的啟動段換成「把內部函式掛到 window.__rr」，再用假資料直接畫。
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
EXPOSE = ("    window.__rr = { state, injectStyle, buildPanel, render, layoutPanel, setCollapsed, rainOf,"
          " collapseGoogleSidebar, restoreGoogleSidebar, deactivate, RAIN_LEVELS };\n")
src = src.replace(HOOK, EXPOSE + "    if (false) {")
fixture = (HERE / 'fixture.js').read_text(encoding='utf-8')
OPEN = """() => { const rr = window.__rr; rr.injectStyle(); const p = rr.buildPanel(); document.body.appendChild(p);
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
    pg.click('#toggle')                       # 打開時腳本會先收起 Google 左側面板；開著的話面板會讓位（test_modes 測）
    pg.add_script_tag(content=fixture)
    pg.add_script_tag(content=src)
    pg.evaluate(OPEN)
    R = lambda sel: pg.evaluate(f"(() => {{ const r = document.querySelector({json.dumps(sel)}).getBoundingClientRect(); return [r.left, r.top, r.width, r.height]; }})()")
    shot = lambda n: a.shots and engine == 'chromium' and pg.screenshot(path=f'{a.shots}/{n}.png')

    pr = R('#rr-panel')
    check('面板貼左下、寬＝視窗−64', pr[0] == 0 and pr[2] == 1512 - 64 and abs(pr[1] + pr[3] - 888) < 0.5, pr)
    # 11 列全放得下：40＋52＋11×16＋8 ＝ 276 < 288，高度＝內容高
    check('內容放得下時高度＝內容高 276', abs(pr[3] - 276) < 0.5, pr[3])
    cells = pg.evaluate("[...document.querySelectorAll('.rr-row')[0].querySelectorAll('.rr-c')].map(e => { const r = e.getBoundingClientRect(); return [r.left, r.top, r.width]; })")
    check('每列 96 格', len(cells) == 96, len(cells))
    lefts = [c[0] for c in cells]
    check('欄距 13、色塊 12、第一格在地點欄 140 之後', all(abs(lefts[i+1]-lefts[i]-13) < 0.01 for i in range(95)) and cells[0][2] == 12 and abs(lefts[0] - 140) < 0.01, lefts[:3])
    check('右端不超出面板', lefts[-1] + 12 <= pr[2], lefts[-1])
    # 刻度：整點圓、15 分小點的中心＝色塊中心，且都在整數像素；軸線中心＝圓心
    marks = pg.evaluate("""(() => { const ax = document.querySelector('.rr-axis').getBoundingClientRect();
      const f = s => [...document.querySelectorAll(s)].map(e => { const r = e.getBoundingClientRect(); return [r.left, r.top, r.width, r.height]; });
      return { ax: [ax.top, ax.height], hour: f('.rr-hour'), q: f('.rr-q') }; })()""")
    axc = marks['ax'][0] + marks['ax'][1] / 2
    hourc = [(h[0] + h[2]/2, h[1] + h[3]/2) for h in marks['hour']]
    check('整點圓 18px、垂直中心＝軸線中心', all(h[2] == 18 for h in marks['hour']) and all(abs(c[1]-axc) < 0.01 for c in hourc), (axc, hourc[:2]))
    cellc = set(round(l + 6, 2) for l in lefts)
    check('整點圓與小點的水平中心＝色塊中心', all(round(c[0], 2) in cellc for c in hourc) and all(round(q[0]+q[2]/2, 2) in cellc for q in marks['q']))
    check('刻度都落在整數像素', all(float(v).is_integer() for m in marks['hour'] + marks['q'] for v in m[:2]))
    check('96 欄＝24 個整點＋72 個小點', len(marks['hour']) == 24 and len(marks['q']) == 72, (len(marks['hour']), len(marks['q'])))
    # 地點欄的時間靠右排整齊
    m = pg.evaluate("[...document.querySelectorAll('.rr-m')].map(e => { const r = e.getBoundingClientRect(); return [r.right, r.width, e.textContent]; })")
    check('時間欄寬 36、右緣全部對齊', len(set(round(x[0], 2) for x in m)) == 1 and all(x[1] == 36 for x in m), m[:3])
    check('起點寫「出發」、終點寫「抵達」、中間寫 +N分', m[0][2] == '出發' and m[-1][2] == '抵達' and m[1][2] == '+2分', [x[2] for x in m])
    # 配色：查表與提高一級
    lv = pg.evaluate("""(() => { const r = window.__rr.rainOf; const c = x => x && x.color;
      return [c(r({pop:20,weather:'多雲'})), c(r({pop:30,weather:'陣雨'})), c(r({pop:30,weather:'午後短暫雷陣雨'})),
              c(r({pop:60,weather:'豪雨'})), c(r({pop:80,weather:'雷陣雨'})), r({pop:null}), r({pop:40,weather:'大雨'}).reason,
              c(r({pop:24,weather:''})), c(r({pop:25,weather:''}))]; })()""")
    check('配色 I 查表＋雷雨大雨提高一級＋紫封頂', lv[:5] == ['#ffffff', '#48e7ff', '#ff72d1', '#af00e0', '#af00e0'] and lv[5] is None and lv[6] == '大雨', lv)
    check('機率先四捨五入到 10%（24→白、25→淺青）', lv[7] == '#ffffff' and lv[8] == '#48e7ff', lv[7:])
    bg = lambda sel, i: pg.evaluate(f"getComputedStyle(document.querySelectorAll({json.dumps(sel)})[{i}]).backgroundColor")
    # 21:30 出發：大同區 21-24 時 20% → 白；中山區 30% 陣雨 → 淺青
    check('格子顏色：大同區 20% 白、中山區 30% 淺青', bg('.rr-row:nth-child(1) .rr-c', 0) == 'rgb(255, 255, 255)' and bg('.rr-row:nth-child(3) .rr-c', 0) == 'rgb(72, 231, 255)')
    check('摘要條＝那一欄最濕的顏色', bg('.rr-sum', 0) == 'rgb(72, 231, 255)')
    na = pg.evaluate("getComputedStyle(document.querySelectorAll('.rr-row')[0].querySelectorAll('.rr-c')[95]).backgroundColor")
    check('查不到預報的格子是灰色', na == 'rgb(236, 239, 241)', na)
    sel = pg.text_content('.rr-sel'); mx = pg.text_content('.rr-max')
    check('剛打開：標題列顯示最早一欄', sel == '21:30 出發 → 21:44 抵達' and mx == '沿路最高 30%', (sel, mx))
    shot('1_open')

    # 指到某格
    def cell_xy(r, c):
        return pg.evaluate(f"(() => {{ const e = document.querySelectorAll('.rr-row')[{r}].querySelectorAll('.rr-c')[{c}].getBoundingClientRect(); return [e.left + 6, e.top + 6]; }})()")
    # 次日 09:30 出發（第 48 欄），中山區 30% 雷陣雨 → 桃紅
    x, y = cell_xy(4, 48)
    pg.mouse.move(x, y)
    hov = R('.rr-cbr.rr-hov')
    check('指到的欄出現藍框，位置＝那一欄', abs(hov[0] - (140 + 48*13 - 2)) < 0.01 and hov[2] == 16, hov)
    sel = pg.text_content('.rr-sel'); mx = pg.text_content('.rr-max')
    check('標題列換成指到的那一欄', sel == '09:30 出發 → 09:44 抵達' and mx == '沿路最高 30%・雷陣雨', (sel, mx))
    tip = pg.inner_text('#rr-tip')
    check('tooltip：降雨機率 30%・雷陣雨（顏色提高一級）', '降雨機率\t30%・雷陣雨（顏色提高一級）' in tip.replace(' ', '\t') or '30%・雷陣雨（顏色提高一級）' in tip, tip)
    check('格子變桃紅', bg('.rr-row:nth-child(5) .rr-c', 48) == 'rgb(255, 114, 209)')
    hl = pg.evaluate("document.querySelectorAll('.rr-lab')[4].classList.contains('rr-hl')")
    check('指到的列地點欄反白', hl)
    shot('2_hover')
    # 移到標頭：只換欄、不出 tooltip
    pg.mouse.move(140 + 10*13 + 6, pr[1] + 40 + 20)
    check('指到標頭只換欄、不出 tooltip', pg.text_content('.rr-sel').startswith('00:00') and pg.evaluate("document.getElementById('rr-tip').style.display") == 'none', pg.text_content('.rr-sel'))

    # 釘住
    x, y = cell_xy(2, 68)
    pg.mouse.click(x, y)
    pg.mouse.move(700, 100)       # 離開面板
    pin = R('.rr-cbr.rr-pinbox')
    piv = R('.rr-pin')
    check('點一下釘住：深框＋▼ 在那一欄', abs(pin[0] - (140 + 68*13 - 2)) < 0.01 and abs(piv[0] - (140 + 68*13)) < 0.01, (pin, piv))
    check('滑鼠移開後顯示釘住的那一欄', pg.text_content('.rr-sel') == '14:30 出發 → 14:44 抵達', pg.text_content('.rr-sel'))
    check('藍框收起', pg.evaluate("document.querySelector('.rr-cbr.rr-hov').style.display") == 'none')
    shot('3_pinned')
    # 優先序要讓兩個條件同時成立：已釘住 68 欄時再指到第 10 欄
    hx, hy = cell_xy(2, 10)
    pg.mouse.move(hx, hy)
    check('已釘住時指到別欄：顯示指到的那欄（指到＞釘住）', pg.text_content('.rr-sel').startswith('00:00'), pg.text_content('.rr-sel'))
    pg.mouse.move(700, 100)
    pg.mouse.click(x, y); pg.mouse.move(700, 100)
    check('再點一次取消、回到最早一欄', pg.text_content('.rr-sel').startswith('21:30') and pg.evaluate("document.querySelector('.rr-pin').style.display") == 'none')

    # ⓘ
    pg.click('[data-rr-act="info"]')
    pop = R('.rr-pop')
    check('ⓘ 打開圖例，在面板上方', pg.is_visible('.rr-pop') and pop[1] + pop[3] <= pr[1], pop)
    shot('4_info')
    pg.click('[data-rr-act="info"]')
    check('再按一次關掉', not pg.is_visible('.rr-pop'))

    # 收合
    pg.click('[data-rr-act="collapse"]')
    pr2 = R('#rr-panel')
    check('收合：只剩 40px 標題列、按鈕字改〔展開〕', pr2[3] == 40 and pg.text_content('[data-rr-act="collapse"]') == '展開' and abs(pr2[1] + 40 - 888) < 0.5, pr2)
    shot('5_collapsed')
    pg.click('[data-rr-act="collapse"]')
    check('展開回原高度', abs(R('#rr-panel')[3] - 276) < 0.5)

    # 拖拉高度：往下拉變矮、存起來；放不下時可以上下捲
    gr = R('.rr-grip')
    gx, gy = gr[0] + gr[2] / 2, gr[1] + 4
    pg.mouse.move(gx, gy); pg.mouse.down(); pg.mouse.move(gx, gy + 100, steps=5); pg.mouse.up()
    h = R('#rr-panel')[3]
    saved = pg.evaluate("window.__gm.panelHeight")
    check('拖拉把手往下 100px → 變矮並記住', abs(h - 176) < 0.5 and saved == 176, (h, saved))
    sc = pg.evaluate("(() => { const s = document.querySelector('.rr-scroll'); s.scrollTop = 1000; return [s.scrollTop, s.scrollHeight, s.clientHeight]; })()")
    check('放不下時可以上下捲', sc[0] > 0, sc)
    hd = R('.rr-head'); sb = R('.rr-scroll')
    check('捲動後標頭留在上方', abs(hd[1] - sb[1]) < 0.5, (hd, sb))
    shot('6_short_scrolled')
    pg.mouse.move(gx, gy + 100); pg.mouse.down(); pg.mouse.move(gx, 0, steps=5); pg.mouse.up()
    check('往上拉到頂：高度停在內容高、記成「全放」', abs(R('#rr-panel')[3] - 276) < 0.5 and pg.evaluate("window.__gm.panelHeight") == 99999, (R('#rr-panel')[3], pg.evaluate("window.__gm.panelHeight")))

    # 視窗變窄：橫向捲動，捲軸不蓋到最後一列
    pg.set_viewport_size({'width': 1000, 'height': 888})
    pg.evaluate("window.__rr.layoutPanel()")  # 這支測試不跑 boot()，視窗 resize 的監聽在 test_modes 測
    pg.wait_for_timeout(100)
    pr3 = R('#rr-panel'); sc = pg.evaluate("(() => { const s = document.querySelector('.rr-scroll'); return [s.scrollWidth, s.clientWidth, s.scrollHeight, s.clientHeight]; })()")
    check('視窗 1000：面板寬 936、可以橫捲', pr3[2] == 936 and sc[0] > sc[1], (pr3, sc))
    check('橫捲軸不蓋到最後一列（不用上下捲）', sc[2] <= sc[3], sc)
    pg.evaluate("document.querySelector('.rr-scroll').scrollLeft = 300")
    lab = R('.rr-row:nth-child(1) .rr-lab'); sb = R('.rr-scroll')
    check('橫捲時地點欄留在左邊', abs(lab[0] - sb[0]) < 0.5, (lab, sb))
    shot('7_narrow_scrolled')
    pg.set_viewport_size({'width': 1512, 'height': 888})
    pg.evaluate("window.__rr.layoutPanel()")

    # Google 左側面板：收起、只展開自己收起來的
    pg.click('#toggle')                       # 先打開，模擬按「旅途中的雨」之前的狀態
    pg.evaluate("window.__rr.collapseGoogleSidebar()")
    check('收起 Google 左側面板', pg.evaluate("document.getElementById('side').classList.contains('off')") and pg.evaluate("window.__rr.state.sidebarCollapsedByUs"))
    pg.evaluate("window.__rr.deactivate()")
    check('關閉：面板移除、左側面板展開回去', pg.evaluate("!document.getElementById('rr-panel') && !document.getElementById('side').classList.contains('off')"))
    pg.click('#toggle')   # 使用者自己收起來
    pg.evaluate(OPEN); pg.evaluate("window.__rr.collapseGoogleSidebar()"); pg.evaluate("window.__rr.deactivate()")
    check('使用者自己收的，關閉時不會被展開', pg.evaluate("document.getElementById('side').classList.contains('off')"))
    check('沒有頁面錯誤', not errs, errs)
    b.close()

with sync_playwright() as pw:
    for e in a.engines.split(','):
        run(e, pw)
print('全部通過' if not fails else f'失敗 {len(fails)} 項：' + '、'.join(fails))
sys.exit(1 if fails else 0)
