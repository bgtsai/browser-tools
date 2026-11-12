import json,sys
from playwright.sync_api import sync_playwright
SRC=open(sys.argv[1]).read()
with sync_playwright() as p:
  for name in ['chromium','firefox']:
    b=getattr(p,name).launch();pg=b.new_page();pg.goto('http://127.0.0.1:8765/reset');pg.add_init_script(SRC)
    pg.goto('http://127.0.0.1:8765/chat/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');pg.wait_for_timeout(9000)
    pg.evaluate("navigator.clipboard.writeText=t=>{window.__out=t;return Promise.resolve()}")
    pg.click('#cup-panel button:has-text(\"複製結果\")');o=json.loads(pg.evaluate('window.__out'))
    ch=[x for x in o['POLLS'] if 'usage' in x]
    checks={'session url learned':bool(o['PS']['sessionUrl']),'poll started by PerformAction':any('PerformAction' in x.get('event','') for x in o['POLLS']),
      'changes recorded >=3':len(ch)>=3,'delta computed':any(x['delta_in']==100 for x in ch),'no dup when unchanged':len(ch)<=4,
      'tree ok':o['TREE'] and o['TREE'].get('messages')==1 and o['TREE']['contentTypes']=={'text':1,'tool_use':1},'tree has no content':'SECRET' not in json.dumps(o['TREE'])}
    print(name,'|',pg.locator('#cup-panel').inner_text().replace('\n',' / '));[print('  ',k,'PASS' if v else 'FAIL') for k,v in checks.items()]
    pg.screenshot(path=f'/tmp/cupt/poll_{name}.png');b.close()
