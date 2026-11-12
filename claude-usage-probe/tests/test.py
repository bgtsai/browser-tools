import json,sys
from playwright.sync_api import sync_playwright
SRC=open(sys.argv[1]).read()
with sync_playwright() as p:
  for name in ['chromium','firefox']:
    b=getattr(p,name).launch();pg=b.new_page()
    pg.add_init_script(SRC)
    pg.goto('http://127.0.0.1:8765/');pg.wait_for_timeout(2500)
    st=pg.locator('#cup-panel').inner_text()
    pg.evaluate("navigator.clipboard.writeText=t=>{window.__out=t;return Promise.resolve()}")
    pg.click('#cup-panel button:has-text(\"複製結果\")')
    o=json.loads(pg.evaluate('window.__out'))
    srcs=[e['src'] for e in o['L'] if 'hits' in e]
    def has(s):return any(s in x for x in srcs)
    hitobj=[h for e in o['L'] if 'hits' in e for h in e['hits'] if h.get('obj')]
    checks={'fetch stream (key split across chunks)':any(h.get('key')=='cache_read_input_tokens' for e in o['L'] if 'hits' in e and '/stream' in e['src'] for h in e['hits']),'xhr':has('/xhr'),'websocket text':any(x.startswith('ws ') for x in srcs),'sse':any(x.startswith('es ') for x in srcs),'decoy not hit':not has('/decoy'),'usage obj parsed':bool(hitobj) and '123456' in hitobj[0]['obj'],'binary ws seen':o['T']['binary']>=1}
    print(name,'|',st.replace('\n',' '));[print('  ',k,'PASS' if v else 'FAIL') for k,v in checks.items()]
    pg.screenshot(path=f'/tmp/cupt/{name}.png');b.close()
