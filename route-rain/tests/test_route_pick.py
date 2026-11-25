"""RouteRain v1.3.0：色帶畫的一定是 Google 畫面上選中的那一條。
用法：python3 test_route_pick.py ../RouteRain.user.js [--engines chromium,firefox]
機制（2026-11-25 實測）：網址 !5i{n}＝清單第 n 條（沒有＝0）；換交通方式／停靠點 Google 才重新請求；
清單列收起後仍在 DOM 裡、文字讀得到。
"""
import sys, json, pathlib, argparse
from playwright.sync_api import sync_playwright

ap = argparse.ArgumentParser()
ap.add_argument('script'); ap.add_argument('--engines', default='chromium,firefox')
a = ap.parse_args()
HERE = pathlib.Path(__file__).parent
src = pathlib.Path(a.script).read_text(encoding='utf-8')
TAIL = "    if (document.readyState === 'loading') {\n        document.addEventListener('DOMContentLoaded', boot);\n    } else {\n        boot();\n    }"
assert src.count(TAIL) == 1, '啟動段的寫法變了，測試要跟著改'
src = src.replace(TAIL, "    window.__rr = { state, selectedIndexFromUrl, routeDataKey, routeSignature, readSelectedRowText,\n"
                        "      routeMismatchReason, keepIfDirections, directionsFor, parseDirections, drawRibbon,\n"
                        "      injectStyle, buildPanel, render, ownFetchText };\n    window.__rrBoot = boot;")
fixture = (HERE / 'fixture.js').read_text(encoding='utf-8')

STOPS = ('!4m13!4m12!1m5!1m1!1s0x3442a96af5585867:0x5204e48e7582d80f!2m2!1d121.5170088!2d25.0573522'
         '!1m5!1m1!1s0x3442ab944379f0b5:0xf03e8edae6bd3ecb!2m2!1d121.563858!2d25.051429')
BASE = 'https://www.google.com/maps/dir/A/B/@25.04,121.53,15z/data=!3m1!4b1'
URL0 = BASE + STOPS + '?entry=ttu'                 # 最佳路線、第 0 條
URL1 = BASE + STOPS + '!5i1?entry=ttu'             # 點了清單第 2 條
URL_MOTO = BASE + STOPS + '!3e9?entry=ttu'         # 換成機車

def alt(meters, dtext, sec, ttext, tsec, ttext2, lat0):
    """一條替代路線：摘要＋一段一步＋座標（緯度 1e7 倍的差分）"""
    summary = [None, None, [meters, dtext], [sec, ttext], None, None, None, None, None, None, [[tsec, ttext2]]]
    seg = [[None, None, None, [sec], None, None, None, None, None, None, [[tsec]]],
           [[None, [[[None, None, [meters], [sec]]]]]]]
    geo = [[int(lat0 * 1e7), 1000, 1000], [int(121.517 * 1e7), 20000, 20000]]
    return [summary, [seg]], geo

def directions(alts):
    rows = [x[0] for x in alts]; geos = [x[1] for x in alts]
    root = [[None, rows, None, None, None, None, None, geos]]
    return ")]}'\n" + json.dumps(root, ensure_ascii=False) + ' ' * 1200

# 「最佳路線」頁籤：機車 5.3／開車 5.2／機車另一條 5.3（距離跟第 0 條一樣，只差 3 公尺）
D1 = directions([alt(5319, '5.3 公里', 1013, '17 分', 900, '15 分', 25.057),
                 alt(5166, '5.2 公里', 1017, '17 分', 1140, '19 分', 25.050),
                 alt(5316, '5.3 公里', 1349, '22 分', 1349, '22 分', 25.040)])
D2 = D1.replace('15 分', '16 分')                  # Google 依路況更新：同一條路線、內容不同

fails = []
def check(name, ok, detail=''):
    print(('  OK  ' if ok else '  FAIL') + ' ' + name + ('' if ok else '  ' + str(detail)))
    if not ok: fails.append(name)

ROWS_HTML = """([sel, texts]) => { document.getElementById('rows')?.remove();
  const wrap = document.createElement('div'); wrap.id = 'rows'; wrap.style.cssText = 'width:0;height:0;overflow:hidden';
  texts.forEach(([d, t], i) => { const r = document.createElement('div'); r.className = 'x UgZKXd';
    r.innerHTML = `<span class="Fk3sm">${t}</span><span class="ivN21e">${d}</span>` +
      (i === sel ? '<button>詳細資料</button><button>預覽</button>' : '');
    wrap.appendChild(r); });
  document.body.appendChild(wrap); }"""
LIST = [['5.3 公里', '15 分'], ['5.2 公里', '19 分'], ['5.3 公里', '22 分']]

def run(engine, pw):
    print(f'== {engine}')
    b = getattr(pw, engine).launch()
    pg = b.new_page(viewport={'width': 1512, 'height': 888})
    errs = []
    pg.on('pageerror', lambda e: errs.append(str(e)))
    pg.goto((HERE / 'harness.html').as_uri())
    pg.add_script_tag(content=fixture)
    pg.add_script_tag(content=src)
    ev = lambda js, *args: pg.evaluate(js, *args)

    # ① 選哪一條：只看網址 !5i
    idx = ev(f"[__rr.selectedIndexFromUrl({json.dumps(URL0)}), __rr.selectedIndexFromUrl({json.dumps(URL1)})]")
    check('網址沒有 !5i＝第 0 條、!5i1＝第 1 條', idx == [0, 1], idx)
    idx = ev("__rr.selectedIndexFromUrl('https://www.google.com/maps/dir/A!5i3/B/@1,2,3z/data=!3m1?x=!5i2')")
    check('!5i 只認 data= 段（地名、查詢字串裡的不算）', idx == 0, idx)
    k = ev(f"[__rr.routeDataKey({json.dumps(URL0)}) === __rr.routeDataKey({json.dumps(URL1)}),"
           f" __rr.routeSignature({json.dumps(URL0)}) !== __rr.routeSignature({json.dumps(URL1)}),"
           f" __rr.routeDataKey({json.dumps(URL0)}) !== __rr.routeDataKey({json.dumps(URL_MOTO)})]")
    check('點別條：資料身分不變、畫面簽章變了（要重算）', k[:2] == [True, True], k)
    check('換交通方式：資料身分變了', k[2], k)

    # ② 清單選中那列：收起來（尺寸 0）也讀得到
    ev(ROWS_HTML, [1, LIST])
    row = ev("__rr.readSelectedRowText()")
    check('讀到選中那列（有兩顆按鈕的）', row and row['distanceText'] == '5.2 公里' and row['durationText'] == '19 分', row)
    ev("document.getElementById('rows').remove()")
    check('沒有清單列時回 null', ev("__rr.readSelectedRowText()") is None)

    # ③ 核對：一致＝''、對不上寫原因、讀不到清單＝null（無法核對）
    r = ev(f"""(() => {{ const all = __rr.parseDirections({json.dumps(D1)});
      return [__rr.routeMismatchReason(all[1], {{distanceText:'5.2 公里', durationText:'19 分'}}),
              __rr.routeMismatchReason(all[1], {{distanceText:'5.2 公里', durationText:'30 分'}}),
              __rr.routeMismatchReason(all[0], {{distanceText:'5.2 公里', durationText:'19 分'}}),
              __rr.routeMismatchReason(all[1], null)]; }})()""")
    check('時間等於依路況：一致', r[0] == '', r)
    check('時間跟清單不同、距離相同：仍算一致（不比時間）', r[1] == '', r)
    check('距離不同：寫出原因（只寫距離）', bool(r[2]) and '距離' in r[2] and '時間' not in r[2], r)
    check('讀不到清單：null', r[3] is None, r)

    # ④ 資料要屬於這條路線；等 Google 的回應（先改網址、回應後到）
    res = ev(f"""(async () => {{ const s = __rr.state; history.replaceState(null, '', location.pathname + '#x');
      s.sawIntercept = true; s.capturedDirections = null;
      const key = 'K-moto';
      // 舊路線的資料不算：dataKey 不同
      s.capturedDirections = {{ text: 'old', dataKey: 'K-best', at: 1 }};
      setTimeout(() => {{ s.capturedDirections = {{ text: 'new', dataKey: key, at: 2 }}; }}, 400);
      const t0 = performance.now(); const got = await __rr.directionsFor(key);
      return [got && got.text, Math.round(performance.now() - t0)]; }})()""")
    check('等到這條路線的資料才用（不拿別條路線的）', res[0] == 'new' and 300 <= res[1] < 2500, res)
    res = ev("""(async () => { const s = __rr.state; s.sawIntercept = true;
      s.capturedDirections = { text: 'old', dataKey: 'K-best', at: 1 };
      const t0 = performance.now(); const got = await __rr.directionsFor('K-moto');
      return [got, Math.round(performance.now() - t0)]; })()""")
    check('等不到就回 null，不拿別條的', res[0] is None and res[1] >= 2900, res)

    # ⑤ 攔到同一條路線的新資料就重算；自己補抓的不觸發
    res = ev(f"""(() => {{ const s = __rr.state; const out = [];
      s.active = true; s.body = document.body; s.capturedDirections = null;
      s.lastRouteKeyHref = location.href;          // 測試頁網址沒有 data=：資料身分是 ''
      clearTimeout(s.rerunTimer); s.rerunTimer = null;
      __rr.keepIfDirections('/maps/preview/directions?x', {json.dumps(D1)}); out.push(s.rerunTimer !== null);
      clearTimeout(s.rerunTimer); s.rerunTimer = null;
      __rr.keepIfDirections('/maps/preview/directions?x', {json.dumps(D1)}); out.push(s.rerunTimer !== null);
      __rr.keepIfDirections('/maps/preview/directions?x', {json.dumps(D2)}); out.push(s.rerunTimer !== null);
      clearTimeout(s.rerunTimer); s.rerunTimer = null;
      __rr.keepIfDirections('/maps/preview/directions?x', {json.dumps(D1)}, 'refetch'); out.push(s.rerunTimer !== null);
      clearTimeout(s.rerunTimer); s.rerunTimer = null; s.active = false;
      return out; }})()""")
    check('第一次收到同一條路線的資料：重算', res[0], res)
    check('內容一樣：不重算', res[1] is False, res)
    check('Google 更新了內容：重算', res[2], res)
    check('自己補抓的：不重算（不繞圈）', res[3] is False, res)

    # ⑥ 自己補抓的請求也會經過攔截器：要跳過，不能被當成 Google 的請求
    pg.route('https://www.google.com/maps/preview/directions*', lambda route: route.fulfill(
        status=200, body=D1, headers={'Access-Control-Allow-Origin': 'null', 'Access-Control-Allow-Credentials': 'true',
                                      'Content-Type': 'application/json'}))
    res = ev("""(async () => { const s = __rr.state; s.capturedDirections = null; s.sawIntercept = false; s.active = false;
      const u = 'https://www.google.com/maps/preview/directions?own=1';
      const t = await __rr.ownFetchText(u);
      await new Promise(r => setTimeout(r, 300));   // 攔截器是讀 clone 之後才收，要等它
      const own = [t.length > 1000, s.capturedDirections === null, s.sawIntercept, s.ownFetches.size];
      await (await fetch('https://www.google.com/maps/preview/directions?google=1', { credentials: 'include' })).text();
      await new Promise(r => setTimeout(r, 200));
      return own.concat([s.capturedDirections && s.capturedDirections.source, s.sawIntercept]); })()""")
    check('自己補抓：拿得到內容、攔截器不收、不算 Google 請求過', res[:4] == [True, True, False, 0], res)
    check('Google 自己的請求：照樣攔到', res[4:] == ['intercept', True], res)

    # ⑦ 對不上就不畫色帶
    res = ev("""(() => { const rr = window.__rr; window.__fakeMapOn(); window.__rrBoot(); rr.injectStyle();
      const p = rr.buildPanel(); document.body.appendChild(p);
      rr.state.panel = p; rr.state.body = p.querySelector('.rr-body'); rr.state.active = true;
      rr.render(rr.state.body, window.__fixture(rr));
      const n = () => document.querySelectorAll('#rr-ribbon path').length;
      const before = n(); rr.state.routeMismatch = '距離 5.3 公里／清單 5.2 公里'; rr.drawRibbon();
      const after = n(); rr.state.routeMismatch = ''; rr.drawRibbon();
      return [before, after, n()]; })()""")
    check('一致時有畫色帶、對不上就清空、恢復一致又畫回來', res[0] > 0 and res[1] == 0 and res[2] > 0, res)
    check('沒有頁面錯誤', not errs, errs)
    b.close()

with sync_playwright() as pw:
    for e in a.engines.split(','):
        run(e, pw)
print('通過' if not fails else f'失敗 {len(fails)} 項：{fails}')
sys.exit(1 if fails else 0)
