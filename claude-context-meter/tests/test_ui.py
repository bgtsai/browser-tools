# v0.3.0 介面：詳細面板、〔校正〕停用、底部燈帶顏色與優先序。用法：python3 test_ui.py ../ClaudeContextMeter.user.js
import sys
from playwright.sync_api import sync_playwright
SRC=open(sys.argv[1],encoding='utf-8').read();CID='aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';BASE='http://127.0.0.1:8767'
fails=0
def check(n,c,d=''):
    global fails; print(('  PASS ' if c else '  FAIL ')+n,d); fails+=(not c)
def page(p,name,mode):
    b=getattr(p,name).launch();pg=b.new_page(viewport={'width':1000,'height':600})
    pg.goto(BASE+'/mode/'+mode);pg.add_init_script(SRC);pg.goto(BASE+'/chat/'+CID);pg.wait_for_timeout(4000);return b,pg
kind="(document.querySelector('.ccm-strip')||{dataset:{}}).dataset.kind||''"
with sync_playwright() as p:
  for name in ['chromium','firefox']:
    print(name)
    for mode,want in [('calib','blue'),('y','yellow'),('r','red')]:
        b,pg=page(p,name,mode); k=pg.evaluate(kind)
        col=pg.evaluate("(()=>{const f=document.querySelector('.ccm-strip>div');return f?getComputedStyle(f).backgroundColor:''})()")
        check(f'燈帶 {mode} → {want}',k==want,f'{k} {col}')
        if mode!='calib': check(f'{mode} 同時建議換串（驗優先序）','建議換串' in pg.inner_text('.ccm-meter'),pg.inner_text('.ccm-meter'))
        if mode=='r': pg.screenshot(path=f'/tmp/ccm_ui_{name}_red.png')
        if mode!='calib': b.close(); continue
        pg.click('.ccm-meter'); pg.wait_for_timeout(200)
        g=pg.evaluate("(()=>{const a=document.querySelector('.ccm-meter').getBoundingClientRect(),p=document.querySelector('.ccm-panel');if(!p)return null;const r=p.getBoundingClientRect();return {dl:Math.round(r.left-a.left),gap:Math.round(r.top-a.bottom),txt:p.innerText}})()")
        check('點標籤開面板、左緣切齊',g and g['dl']==0 and g['gap']==8,str(g and {k:g[k] for k in ('dl','gap')}))
        check('面板內容層次',g and '/ 100 萬' in g['txt'] and '後回本' in g['txt'] and ('建議換' in g['txt'] or '不用換' in g['txt']) and '固定部分 F' in g['txt'] and '校正' in g['txt'],(g or {}).get('txt','').replace('\n',' | '))
        pg.screenshot(path=f'/tmp/ccm_ui_{name}_panel.png')
        pg.keyboard.press('Escape'); pg.wait_for_timeout(100)
        check('Esc 關面板',pg.query_selector('.ccm-panel') is None)
        pg.click('.ccm-meter'); pg.wait_for_timeout(100); pg.mouse.click(500,400); pg.wait_for_timeout(100)
        check('點外面關面板',pg.query_selector('.ccm-panel') is None)
        pg.click('.ccm-meter'); pg.wait_for_timeout(100)
        pg.evaluate("document.querySelector('[data-testid=chat-input]').innerText='打到一半'"); pg.wait_for_timeout(900)
        st=pg.evaluate("[document.querySelector('.ccm-calib').getAttribute('aria-disabled'),document.querySelector('.ccm-why').textContent]")
        pg.click('.ccm-calib',force=True); pg.wait_for_timeout(400)
        sent=pg.evaluate("window.__sent||[]")
        check('輸入框有字：校正停用＋原因、不送',st==['true','輸入框有字，先送出或清空'] and sent==[],f'{st} {sent}')
        pg.evaluate("document.querySelector('[data-testid=chat-input]').innerText=''"); pg.wait_for_timeout(900)
        pg.click('.ccm-calib'); pg.wait_for_timeout(1500)
        sent=pg.evaluate("window.__sent||[]")
        check('輸入框空：校正送出 /context',sent==['/context'],str(sent))
        b.close()
print('全部通過' if not fails else f'{fails} 項失敗')
