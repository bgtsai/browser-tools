"""RouteRain v1.6.0：色帶畫進 Google 地圖的 WebGL 畫面。
用法：python3 test_gl.py ../RouteRain.user.js [--engines chromium,firefox]
用一個仿 Google 的假 WebGL 頁面：兩組 shader 原始碼長度跟真的一樣（3457/1628＝讀相機、1111/1069＝文字），
每幀依序 清畫面 → 相機程式上傳 中心高位/低位/矩陣/倍率 → 文字程式畫一塊黑色「標籤」。
"""
import sys, pathlib, argparse
from playwright.sync_api import sync_playwright

ap = argparse.ArgumentParser()
ap.add_argument('script'); ap.add_argument('--engines', default='chromium,firefox')
a = ap.parse_args()
HERE = pathlib.Path(__file__).parent
src = pathlib.Path(a.script).read_text(encoding='utf-8')
HOOK = "    if (document.readyState === 'loading') {"
TAIL = "    if (document.readyState === 'loading') {\n        document.addEventListener('DOMContentLoaded', boot);\n    } else {\n        boot();\n    }"
assert src.count(TAIL) == 1
src = src.replace(TAIL, HOOK + "\n    }")
src = src.replace(HOOK, "    window.__rr = { state, glr, glLive, buildRibbonMesh, glRequestRedraw, applyPalette, PALETTES };\n    if (false) {")
fixture = (HERE / 'fixture.js').read_text(encoding='utf-8')

PAGE = r"""<!doctype html><html><body style="margin:0">
<canvas class="H1VXrf" id="cv" width="400" height="300" style="width:400px;height:300px;display:block"></canvas>
<script>
window.__gm={}; window.GM_getValue=(k,d)=> k in __gm ? __gm[k] : d; window.GM_setValue=(k,v)=>{__gm[k]=v;};
window.GM_registerMenuCommand=()=>{}; window.GM_setClipboard=()=>{}; window.GM_xmlhttpRequest=()=>{}; window.GM_getResourceText=()=>'{}';
window.unsafeWindow=window;
const pad = (s, n) => { s += '\n//'; while (s.length < n) s += 'x'; return s.slice(0, n); };
const cv = document.getElementById('cv');
const gl = cv.getContext('webgl', { premultipliedAlpha: true, preserveDrawingBuffer: false });
const mk = (vs, fs, lv, lf) => { const sh = (t, s) => { const o = gl.createShader(t); gl.shaderSource(o, s); gl.compileShader(o); return o; };
  const p = gl.createProgram(); gl.attachShader(p, sh(gl.VERTEX_SHADER, pad(vs, lv))); gl.attachShader(p, sh(gl.FRAGMENT_SHADER, pad(fs, lf))); gl.linkProgram(p); return p; };
const VS = 'attribute vec2 a;uniform vec3 c,d;uniform mat4 n;uniform float s;void main(){gl_Position=vec4(a,0.,1.);}';
const FS = 'precision mediump float;void main(){gl_FragColor=vec4(0.,0.,0.,1.);}';
const cam = mk(VS, FS, 3457, 1628), text = mk(VS, FS, 1111, 1069), blit = mk(VS, FS, 174, 152);
const buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf);
// 標籤：畫面中心右邊 40～60 px、中線上下 10 px 的黑塊（剛好壓在色帶上）
const X = px => px / 200, Y = py => -py / 150;
gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([X(40),Y(-10), X(60),Y(-10), X(60),Y(10), X(40),Y(-10), X(60),Y(10), X(40),Y(10)]), gl.STATIC_DRAW);
window.CAM = { cx: 0.8375, cy: 0.4281, S: 256 * 2 ** 15 };
const hi = v => Math.fround(v);
window.frames = 0; window.px = {};
window.frame = () => {
  window.frames++;
  gl.viewport(0, 0, 400, 300); gl.clearColor(1, 1, 1, 1); gl.clear(gl.COLOR_BUFFER_BIT); gl.disable(gl.BLEND);
  if (window.blitOnly) { gl.useProgram(blit); } else {
  gl.useProgram(cam);
  const L = n => gl.getUniformLocation(cam, n);
  gl.uniform3fv(L('c'), [hi(CAM.cx), hi(CAM.cy), 0]);
  gl.uniform3fv(L('d'), [CAM.cx - hi(CAM.cx), CAM.cy - hi(CAM.cy), 0]);
  gl.uniformMatrix4fv(L('n'), false, [2/400,0,0,0, 0,-2/300,0,0, 0,0,0,0, 0,0,0,1]);
  gl.uniform1f(L('s'), CAM.S);
  }
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.useProgram(text);
  const abKeep = gl.getParameter(gl.ARRAY_BUFFER_BINDING) === buf;   // 注入發生在這次 useProgram 裡
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  const al = gl.getAttribLocation(text, 'a'); gl.enableVertexAttribArray(al); gl.vertexAttribPointer(al, 2, gl.FLOAT, false, 0, 0);
  gl.drawArrays(gl.TRIANGLES, 0, 6);
  const rd = (x, y) => { const o = new Uint8Array(4); gl.readPixels(x, 299 - y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, o); return Array.from(o); };
  window.px = { ribbon: rd(100, 150), ribbon2: rd(100, 151), ribbon3: rd(100, 152), label: rd(250, 150), up: rd(100, 140), glow: rd(100, 162), far: rd(100, 220),
    right: rd(330, 150), prog: gl.getParameter(gl.CURRENT_PROGRAM) === text, ab: abKeep,
    blend: gl.isEnabled(gl.BLEND) };
};
window.renderSoon = () => requestAnimationFrame(window.frame);
</script></body></html>"""

fails = []
def check(name, ok, detail=''):
    print(('  OK  ' if ok else '  FAIL') + ' ' + name + ('' if ok else '  ' + str(detail)))
    if not ok: fails.append(name)

def run(engine, pw):
    print(f'== {engine}')
    b = getattr(pw, engine).launch()
    pg = b.new_page(viewport={'width': 400, 'height': 300})
    errs = []
    pg.on('pageerror', lambda e: errs.append(str(e)))
    if not pg.evaluate("!!document.createElement('canvas').getContext('webgl')"):
        # 無頭 Firefox 在這個環境沒有 WebGL：只確認腳本照常載入、不會誤判成 WebGL 模式
        pg.set_content('<html><body></body></html>')
        pg.evaluate("() => { window.__gm={}; window.GM_getValue=(k,d)=>d; window.GM_setValue=()=>{}; window.GM_registerMenuCommand=()=>{}; window.GM_setClipboard=()=>{}; window.GM_xmlhttpRequest=()=>{}; window.GM_getResourceText=()=>'{}'; window.unsafeWindow=window; }")
        pg.add_script_tag(content=fixture); pg.add_script_tag(content=src)
        check('（沒有 WebGL）腳本照常載入、不進 WebGL 模式', pg.evaluate("!window.__rr.glLive()") and not errs, errs)
        b.close(); return
    pg.set_content(PAGE)
    pg.add_script_tag(content=fixture)
    pg.add_script_tag(content=src)
    # 水平一條路線穿過畫面中心：左半第 1 級、右半第 4 級（世界座標 ＝ 中心 ± px / S）
    pg.evaluate("""() => { const rr = window.__rr, C = window.CAM, w = px => C.cx + px / C.S;
      rr.state.active = true;
      rr.glr.scene = { runs: [ { level: 0, pts: [[w(-180), C.cy], [w(0), C.cy]] }, { level: 3, pts: [[w(0), C.cy], [w(180), C.cy]] } ],
        pal: rr.PALETTES.k2, marker: null };
      window.renderSoon(); }""")
    pg.wait_for_timeout(300)
    r = pg.evaluate("({ px: window.px, frame: window.__rr.glr.frame, live: window.__rr.glLive(), broken: window.__rr.glr.broken, hasTick: !!window.__rr.glr.tick })")
    px = r['px']
    check('認出兩組程式、注入成功', r['frame'] >= 1 and r['live'] and not r['broken'], r)
    f0 = (236, 221, 248)
    near = lambda c, t, tol=6: all(abs(c[i] - t[i]) <= tol for i in range(3))
    rows = [px['ribbon'], px['ribbon2'], px['ribbon3']]
    check('色帶第 1 級填色畫在路線位置（含掃描線變暗的列）', any(near(c, f0) for c in rows), rows)
    check('S1 掃描線：相鄰三列裡有一列變暗', any(near(c, [round(v * (1 - 0.28)) for v in f0], 8) for c in rows), rows)
    check('地名（文字程式畫的黑塊）蓋在色帶上面', px['label'][:3] == [0, 0, 0], px['label'])
    check('第 4 級填色畫在右半段', near(px['right'], (95, 36, 159)), px['right'])
    check('光暈：中線外 12 px 有淡紫、遠處仍是白', px['glow'][:3] != [255, 255, 255] and px['far'][:3] == [255, 255, 255], (px['glow'], px['far']))
    check('GL 狀態還原：目前程式、ARRAY_BUFFER、BLEND 都是 Google 原本的', px['prog'] and px['ab'] and px['blend'] is False, px)
    check('記住了會畫地圖的 rAF 回呼', r['hasTick'])
    # 內容變了、地圖沒動：靠記下的回呼要求重畫
    n0 = pg.evaluate("window.frames")
    pg.evaluate("""() => { const rr = window.__rr; rr.glr.scene.pal = rr.PALETTES.m; rr.glRequestRedraw(); }""")
    pg.wait_for_timeout(300)
    r2 = pg.evaluate("({ n: window.frames, px: window.px })")
    check('要求重畫：不用動地圖也重畫一幀、換成 M 藍', r2['n'] > n0 and near(r2['px']['right'], (40, 71, 116)), r2)
    # 靜止時 Google 只把畫好的底圖貼上來（不重算相機）：色帶也要在
    pg.evaluate("() => { window.blitOnly = true; window.renderSoon(); }")
    pg.wait_for_timeout(200)
    bp = pg.evaluate("window.px")
    check('只貼底圖的幀也畫色帶（靜止時不會消失）', near(bp['right'], (40, 71, 116)), bp)
    pg.evaluate("() => { window.blitOnly = false; }")
    # 要求重畫要節流：同一刻請 5 次只多畫 1 幀；Google 剛畫過（地圖在動）就不請
    pg.wait_for_timeout(300)
    n1 = pg.evaluate("window.frames")
    pg.evaluate("() => { for (let i = 0; i < 5; i++) window.__rr.glRequestRedraw(); }")
    pg.wait_for_timeout(300)
    n2 = pg.evaluate("window.frames")
    check('同一刻請 5 次重畫只多畫 1 幀', n2 - n1 == 1, (n1, n2))
    pg.evaluate("() => { window.frame(); window.__rr.glRequestRedraw(); }")
    pg.wait_for_timeout(300)
    n3 = pg.evaluate("window.frames")
    check('Google 剛畫過就不另外請它重畫', n3 - n2 == 1, (n2, n3))
    # 連續帶子：轉角處前後兩段共用頂點（不再各自一塊四邊形）
    sh = pg.evaluate("""() => { const rr = window.__rr; const pts = []; for (let i = 0; i < 40; i++) pts.push({ x: i * 4, y: (i % 2) * 3 });
      const v = rr.buildRibbonMesh([{ level: 1, pts }], rr.PALETTES.k2, null); const n = v.length / 14; const g = [];
      for (let i = 0; i < n; i++) if (v[i*14+6] === 0) g.push([v[i*14] + v[i*14+2]*v[i*14+4], v[i*14+1] + v[i*14+3]*v[i*14+4]]);
      let shared = 0, quads = g.length / 6;
      for (let q = 0; q + 1 < quads; q++) { const endA = g[q*6+2], startB = g[(q+1)*6]; if (Math.abs(endA[0]-startB[0]) < 1e-4 && Math.abs(endA[1]-startB[1]) < 1e-4) shared++; }
      return { quads, shared }; }""")
    check('轉角處相鄰兩段的光暈共用頂點（沒有重疊或缺口）', sh['quads'] == 39 and sh['shared'] == 38, sh)
    # 平移（只改 uniform、不重建網格）：相機往南 10 px → 路線在畫面上往上 10 px
    mv = pg.evaluate("""() => { const rr = window.__rr, C = window.CAM, w = px => C.cx + px / C.S;
      rr.glr.scene = { runs: [ { level: 0, pts: [[w(-180), C.cy], [w(0), C.cy]] }, { level: 3, pts: [[w(0), C.cy], [w(180), C.cy]] } ], pal: rr.PALETTES.k2, marker: null };
      window.frame(); const m1 = rr.glr.built.verts; C.cy += 10 / C.S; window.frame(); const r = { up: window.px.up, same: rr.glr.built.verts === m1 }; C.cy -= 10 / C.S; return r; }""")
    check('平移只改 uniform：路線跟著移動且沒重建網格', (near(mv['up'], f0) or near(mv['up'], [round(v * 0.72) for v in f0], 8)) and mv['same'], mv)
    # 長路線縮小看：幾千個點擠在幾百 px 裡，注入要快（v1.6.2 實機一幀 400 ms）且不能每幀重算
    perf = pg.evaluate("""() => { const rr = window.__rr, C = window.CAM, w = px => C.cx + px / C.S; const pts = [];
      for (let i = 0; i < 6000; i++) pts.push([w(-150 + i * 0.05), C.cy + Math.sin(i / 7) * 2 / C.S]);
      rr.glr.scene = { runs: [{ level: 1, pts: pts.slice(0, 3001) }, { level: 3, pts: pts.slice(3000) }], pal: rr.PALETTES.k2, marker: null };
      const t0 = performance.now(); window.frame(); const t1 = performance.now(); const m1 = rr.glr.built.verts;
      C.cx += 20 / C.S; C.S *= 1.2; window.frame(); const same = rr.glr.built.verts === m1; C.S *= 1.8; window.frame(); const rebuilt = rr.glr.built.verts !== m1; C.S /= 2.16; C.cx -= 20 / C.S;
      return { first: t1 - t0, same, rebuilt, verts: m1.length / 14 }; }""")
    check('長路線（6000 點）注入一幀 < 30 ms、點數有略過', perf['first'] < 30 and perf['verts'] < 6000, perf)
    check('平移＋縮放不到半級沿用網格、超過半級才重建', perf['same'] and perf['rebuilt'], perf)
    # 色帶網格（純函式）
    m = pg.evaluate("""() => { const rr = window.__rr; const v = rr.buildRibbonMesh([{ level: 0, pts: [{x:0,y:0},{x:100,y:0}] }, { level: 2, pts: [{x:100,y:0},{x:200,y:0}] }], rr.PALETTES.k2, {x: 50, y: 0});
      const n = v.length / 14, kinds = {}; let gmin = 9, gmax = 0;
      for (let i = 0; i < n; i++) { const k = v[i*14+6]; kinds[k] = (kinds[k]||0)+1; if (k === 0) { gmin = Math.min(gmin, v[i*14+13]); gmax = Math.max(gmax, v[i*14+13]); } }
      return { n, kinds, gmin, gmax, firstGlow: v[6] === 0 }; }""")
    check('網格：先光暈、再本體、最後標記點；交界有漸變小段', m['firstGlow'] and m['kinds'].get('2') == 6 and m['kinds'].get('0', 0) > 12, m)
    check('光暈強度從第 1 級 0.15 漸變到第 3 級 0.45', abs(m['gmin'] - 0.15) < 1e-6 and abs(m['gmax'] - 0.45) < 1e-6, m)
    # 認不出文字程式（Google 改版）→ 不注入、不算 live
    pg2 = b.new_page(viewport={'width': 400, 'height': 300})
    pg2.set_content(PAGE.replace('1111, 1069', '1112, 1069'))
    pg2.add_script_tag(content=fixture); pg2.add_script_tag(content=src)
    pg2.evaluate("() => { window.__rr.state.active = true; window.renderSoon(); }")
    pg2.wait_for_timeout(300)
    r3 = pg2.evaluate("({ live: window.__rr.glLive(), frame: window.__rr.glr.frame })")
    check('認不出文字程式：不注入、退回 SVG', not r3['live'] and r3['frame'] == 0, r3)
    check('沒有頁面錯誤', not errs, errs)
    b.close()

with sync_playwright() as pw:
    for e in a.engines.split(','):
        run(e, pw)
print('全部通過' if not fails else f'失敗 {len(fails)} 項：' + '、'.join(fails))
sys.exit(1 if fails else 0)
