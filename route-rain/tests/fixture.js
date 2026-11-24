// 測試資料：mockup v3 的 11 個點（民生西路177號 → 捷運南京三民站），出發 21:30 起 96 欄
window.__fixture = function (rr) {
  const PLACES = [
    ['民生西路177號',0,'大同區','origin'],['雙連站',2,'大同區'],['中山北路二段',3,'中山區'],
    ['長安東路一段',5,'中山區'],['松江路',6,'中山區'],['建國北路',7,'中山區'],
    ['龍江路',8,'中山區'],['復興北路',9,'松山區'],['南京東路四段',11,'松山區'],
    ['南京東路五段',12,'松山區'],['捷運南京三民站',14,'松山區','destination']];
  const t0 = new Date(2026,10,24,21,30,0,0).getTime();
  const nodes = PLACES.map(([name,min,town,kind],i)=>({placeName:name, sec:min*60, county:'臺北市', town,
    kind:kind||null, part:[1,1], lat:25.05+i*0.001, lon:121.51+i*0.004}));
  const departures = []; for(let i=0;i<96;i++) departures.push(new Date(t0+i*15*60000));
  // 每個鄉鎮 3 小時一格：[機率, 天氣]
  const B = {
    '大同區':[[20,'多雲'],[30,'短暫陣雨'],[10,'多雲'],[10,'晴'],[20,'多雲'],[40,'短暫陣雨'],[60,'短暫陣雨或雷雨'],[30,'陣雨'],[null,''],[null,'']],
    '中山區':[[30,'陣雨'],[40,'陣雨'],[20,'多雲'],[10,'晴'],[30,'午後短暫雷陣雨'],[50,'陣雨'],[70,'雷陣雨'],[40,'陣雨'],[20,'多雲'],[null,'']],
    '松山區':[[30,'陣雨'],[40,'陣雨'],[20,'多雲'],[20,'多雲'],[30,'陣雨'],[60,'雷陣雨'],[80,'豪雨'],[40,'陣雨'],[30,'陣雨'],[null,'']]};
  const base = new Date(2026,10,24,21,0,0,0).getTime();
  const forecast = new Map();
  for (const [town, blocks] of Object.entries(B)) forecast.set('臺北市|'+town,
    blocks.map(([pop,weather],k)=>({startMs:base+k*3*3600e3, endMs:base+(k+1)*3*3600e3, pop, weather, code:'0'+k})));
  const meta = {matchNote:'測試', timeBasis:'依路況', routeDistanceMeters:5300, capturedAt:Date.now(),
    mode:{mode:'TWO_WHEELER', via:'測試'}, selected:{distanceMeters:5300, durationSec:840, distanceText:'5.3 公里', durationText:'14 分'},
    callCount:0, failures:[], fetchedAt:Date.now(), fromCache:true, source:'github', altCount:1};
  // 路線上的點：每兩個取樣點之間插 8 點，時間線性內插
  const timeline = [];
  nodes.forEach((n, i) => { const m = nodes[i + 1]; if (!m) { timeline.push({ sec: n.sec, lat: n.lat, lon: n.lon }); return; }
    for (let k = 0; k < 8; k++) { const f = k / 8; timeline.push({ sec: n.sec + (m.sec - n.sec) * f, lat: n.lat + (m.lat - n.lat) * f, lon: n.lon + (m.lon - n.lon) * f }); } });
  return { nodes, departures, forecast, totalSec:14*60, timeline, meta };
};
