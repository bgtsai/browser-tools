// routeMask（依線段樣式分組認路線）的單元測試：node test_route_mask.js ../RouteRain.user.js [--mutants]
// 從腳本用 acorn 依節點範圍抽出 routeMask 與相依的純函式／常數，餵假的線段資料（每筆 20 bytes：int16×4 起訖、uint16×2 樣式）。
const fs = require('fs'), path = require('path');
const acorn = require(require.resolve('acorn', { paths: [process.cwd(), '/home/claude/jstools'] }));
const NAMES = ['RT_NEAR', 'RT_NEAR_SHARE', 'RT_SAMPLES', 'RT_PARALLEL', 'RT_MAX_BREAKS', 'RT_CELL', 'segMid', 'nearIdx', 'nearRoute', 'SEL_FILL', 'SEL_FILL_TOL', 'RT_COLOR_MISS_MAX', 'isSelFill', 'routeMask'];

function extract(src) {
    const ast = acorn.parse(src, { ecmaVersion: 2022 });
    const out = {};
    (function walk(n) {
        if (!n || typeof n !== 'object') return;
        if (n.type === 'FunctionDeclaration' && NAMES.includes(n.id.name)) out[n.id.name] = src.slice(n.start, n.end);
        if (n.type === 'VariableDeclaration') for (const d of n.declarations)
            if (d.id.name && NAMES.includes(d.id.name)) out[d.id.name] = 'const ' + src.slice(d.start, d.end) + ';';
        for (const k in n) if (k !== 'parent') { const v = n[k]; Array.isArray(v) ? v.forEach(walk) : (v && typeof v.type === 'string' && walk(v)); }
    })(ast);
    const miss = NAMES.filter(x => !out[x]);
    if (miss.length) throw new Error('抽不到：' + miss);
    return new Function(NAMES.map(x => out[x]).join('\n') + '\nreturn { routeMask, RT_CELL, isSelFill, RT_COLOR_MISS_MAX };')();
}

function run(src) {
    const { routeMask, RT_CELL, isSelFill, RT_COLOR_MISS_MAX } = extract(src);
    // 世界座標：k＝[x0,y0,_,w]，端點＝k.xy＋D·w/16。取 w＝16e-7 → 1 單位 D ＝ 1e-7 世界（約 4 m）
    const k = [0.8376, 0.4281, 16, 16e-7];
    const W = (dx, dy) => [k[0] + dx * 1e-7, k[1] + dy * 1e-7];
    // 我們的路線：沿 x 軸 0～2000（約 8 km）
    const pts = []; for (let x = 0; x <= 2000; x += 100) pts.push(W(x, 0));
    const grid = new Map();
    pts.forEach((p, i) => { const kk = Math.floor(p[0] / RT_CELL) + ',' + Math.floor(p[1] / RT_CELL); (grid.get(kk) || grid.set(kk, []).get(kk)).push(i); });
    const geo = { pts, grid };
    const pack = segs => { const buf = new ArrayBuffer(segs.length * 20), dv = new DataView(buf);
        segs.forEach((s, i) => { for (let j = 0; j < 4; j++) dv.setInt16(i * 20 + j * 2, s[j], true); dv.setUint16(i * 20 + 8, s[4], true); dv.setUint16(i * 20 + 10, s[5], true); });
        return new Uint8Array(buf); };
    const chain = (out, style, xy) => { for (let i = 0; i + 1 < xy.length; i++) out.push([...xy[i], ...xy[i + 1], ...style]); };
    // 路線批：①選中路線（90,2）沿路線 0→1000，外框＋本體兩趟 ②替代路線（90,0）只共用起點一小段、往北走遠
    const A = [];
    const route = []; for (let x = 0; x <= 1000; x += 50) route.push([x, 0]);
    chain(A, [90, 2], route); chain(A, [90, 2], route);
    const alt = [[0, 0], [50, 0], [50, 300], [50, 600], [400, 600], [800, 600], [1000, 600], [1000, 0]];
    chain(A, [90, 0], alt); chain(A, [90, 0], alt);
    // ③另一條替代路線在終點附近岔出去（圖磚裡只剩離路線 40 單位內、約 160 m 的一截，往南垂直走）
    const fork = [[1000, 0], [1000, -10], [1000, -20], [1000, -30], [1000, -40]];
    chain(A, [90, 1], fork); chain(A, [90, 1], fork);
    const mA = routeMask(pack(A), A.length, k, geo);
    const of = (segs, m, st) => segs.map((s, i) => (s[4] === st[0] && s[5] === st[1] ? (m ? m[i] : 0) : null)).filter(v => v !== null);
    const all = (a, v) => a.length > 0 && a.every(x => x === v);
    // 圖磚批：路線底下那條路本身（172,0：一條連續線、貼著路線）＋路線旁很多條短街（173,0：斷點很多）
    const B = [];
    chain(B, [172, 0], route); chain(B, [172, 0], route);
    for (let x = 0; x < 1000; x += 60) chain(B, [173, 0], [[x, -30], [x, 30]]);
    const mB = routeMask(pack(B), B.length, k, geo);
    const checks = [
        ['路線批混了替代路線：選中路線的線段全部認成路線', all(of(A, mA, [90, 2]), 1)],
        ['替代路線（只共用起點一小段）不算', all(of(A, mA, [90, 0]), 0)],
        ['替代路線在路線旁岔出去的一截（距離都在門檻內、但方向垂直）不算', all(of(A, mA, [90, 1]), 0)],
        ['圖磚批（有斷點很多的街道組）整批不算，連路線底下那條路也不算', mB === null],
        ['沒有線段回 null', routeMask(new Uint8Array(0), 0, k, geo) === null],
    ];
    // 顏色（v1.11.2）：假的樣式表——代號 → 「本體/外框」；判斷規則同腳本（本體色＝選中色才算，顏色從沒對上才退回幾何）
    const mkStyle = colors => { const S = { hits: 0, miss: 0 }; return {
        S,
        pairOf: (x, y) => colors[x + ',' + y] || null,
        isRoute(p) { const y = isSelFill(p); if (y) S.hits++; return y; },
        known() { return S.hits > 0; },
        fallback() { return !S.hits && S.miss >= RT_COLOR_MISS_MAX; },
        miss() { if (!S.hits) S.miss++; },
    }; };
    const SEL = '35.3.142.255/69.14.251.255', SELJAM = '35.3.142.255/189.43.43.255', ALT = '51.49.243.255/184.201.253.255', ALTJAM = '48.47.247.255/212.54.81.255', ST = '199.208.215.255/216.224.231.255';
    const st1 = mkStyle({ '90,2': SEL, '90,0': ALT, '90,1': ALT, '91,0': ALT, '92,0': ALTJAM, '172,0': ST, '173,0': ST, '500,0': SELJAM });
    // 路線批：替代路線跟選中路線共用整段（汽車走同一段國道）——兩組都「沿著」
    const C = [];
    chain(C, [90, 2], route); chain(C, [90, 2], route);
    chain(C, [91, 0], route); chain(C, [91, 0], route);
    const mC = routeMask(pack(C), C.length, k, geo, null, st1);
    checks.push(['替代路線跟選中路線共用整段：只換選中那組', !!mC && all(of(C, mC, [90, 2]), 1) && all(of(C, mC, [91, 0]), 0)]);
    // 只有替代路線的批次（v1.11.1 實機：這種批次讓替代色被學進去、三條全塗）
    const D = [];
    chain(D, [91, 0], route); chain(D, [91, 0], route);
    chain(D, [92, 0], route); chain(D, [92, 0], route);
    let mD; for (let r = 0; r < 5; r++) mD = routeMask(pack(D), D.length, k, geo, null, st1);
    checks.push(['只有替代路線（含塞車色）的批次，沿著也不算', mD === null]);
    // 圖磚批裡混了一段塞車的選中路線（本體同、外框不同、代號也不同）
    const B2 = B.slice(); chain(B2, [500, 0], [[1200, 0], [1300, 0], [1400, 0]]);
    const mB2 = routeMask(pack(B2), B2.length, k, geo, null, st1);
    checks.push(['圖磚批裡路況色（外框不同）的選中路線照樣換色', !!mB2 && all(of(B2, mB2, [500, 0]), 1)]);
    checks.push(['同一批圖磚的街道還是不換色', !!mB2 && all(of(B2, mB2, [172, 0]), 0) && all(of(B2, mB2, [173, 0]), 0)]);
    checks.push(['顏色容許差：#26068b 算、#3331f3 不算', isSelFill('38.6.139.255/0.0.0.255') && !isSelFill(ALT)]);
    // Google 換配色：選中路線變成沒見過的顏色 → 累積後退回幾何判斷
    const st2 = mkStyle({ '90,2': '10.120.40.255/0.0.0.255', '90,0': ALT, '90,1': ALT });
    let mE; for (let r = 0; r <= RT_COLOR_MISS_MAX; r++) mE = routeMask(pack(A), A.length, k, geo, null, st2);
    checks.push(['顏色一直對不上：退回幾何判斷，選中路線照樣換色', !!mE && all(of(A, mE, [90, 2]), 1)]);
    const mE0 = routeMask(pack(A), A.length, k, geo, null, mkStyle({ '90,2': '10.120.40.255/0.0.0.255', '90,0': ALT, '90,1': ALT }));
    checks.push(['剛開始顏色對不上時不退回（先不塗）', mE0 === null]);
    return checks;
}

const file = process.argv[2] || '../RouteRain.user.js';
const src = fs.readFileSync(file, 'utf8');
const base = run(src);
let bad = 0;
for (const [name, ok] of base) { console.log((ok ? '  OK   ' : '  FAIL ') + name); if (!ok) bad++; }
if (bad) { console.log('失敗 ' + bad); process.exit(1); }
console.log('全部通過');
if (process.argv.includes('--mutants')) {
    // 反證：每個改壞版至少要有一項檢查失敗
    const mutants = [
        ['斷點不設上限', s => s.replace('const RT_MAX_BREAKS = 3;', 'const RT_MAX_BREAKS = 1e9;')],
        ['不分組（整批一起判斷）', s => s.replace('const b = i * 20, key = dv.getUint16(b + 8, true) * 65536 + dv.getUint16(b + 10, true);', 'const b = i * 20, key = 0;')],
        ['只看單組斷點（v1.10.0）', s => s.replace('            if (tile) continue;\n', '            if (g.breaks > RT_MAX_BREAKS) continue;\n')],
        ['不看方向', s => s.replace('if (!U2 || !L2 || dot * dot >= RT_PARALLEL * RT_PARALLEL * U2 * L2) return true;', 'return true;')],
        ['不看顏色（v1.10.x）', s => s.replace('if (pair && style.isRoute(pair)) { take(g); continue; }', '')],
        ['顏色不符照樣靠幾何（v1.11.x）', s => s.replace('if (g.colorOnly) { style.miss(); continue; }', '')],
        ['容許差太寬', s => s.replace('const SEL_FILL_TOL = 8;', 'const SEL_FILL_TOL = 120;')],
        ['不退回幾何', s => s.replace('if (pair && !style.fallback())', 'if (pair)')],
        ['一開始就退回', s => s.replace('if (pair && !style.fallback())', 'if (pair && false)')],
        ['不看貼不貼著', s => s.replace('if (hit < m * RT_NEAR_SHARE) continue;', '')],
    ];
    let miss = 0;
    for (const [name, f] of mutants) {
        const m = f(src);
        if (m === src) { console.log('  反證沒替換到：' + name); miss++; continue; }
        let caught;
        try { caught = run(m).some(([, ok]) => !ok); } catch (e) { caught = 'error ' + e.message; }
        console.log((caught === true ? '  抓到 ' : '  沒抓到 ') + name + (typeof caught === 'string' ? '（' + caught + '）' : ''));
        if (caught !== true) miss++;
    }
    if (miss) process.exit(1);
}
