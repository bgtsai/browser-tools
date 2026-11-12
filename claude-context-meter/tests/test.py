import json,sys
from playwright.sync_api import sync_playwright
SRC=open(sys.argv[1]).read();CID='aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';BASE='http://127.0.0.1:8767'
def run(p,name,mode,pre=None):
    b=getattr(p,name).launch();ctx=b.new_context();pg=ctx.new_page()
    pg.goto(BASE+'/mode/'+mode);pg.add_init_script(SRC)
    if pre: pg.add_init_script(pre)
    pg.goto(BASE+'/chat/'+CID);pg.wait_for_timeout(4500)
    s=pg.evaluate('JSON.stringify({last:window.__ccm.last,err:window.__ccm.err,sent:window.__sent||[],badge:document.getElementById("ccm-badge")&&document.getElementById("ccm-badge").textContent,input:document.querySelector("[data-testid=chat-input]").innerText})')
    pg.screenshot(path=f'/tmp/ccm_{name}_{mode}.png');b.close();return json.loads(s)
with sync_playwright() as p:
  for name in ['chromium','firefox']:
    a=run(p,name,'calib'); L=a['last']
    # 校正點之前：10000+5000+/context(8/3.5)=15002.3；之後新增 m4(輸出)+m5
    ok1=L and L['calib'] and L['calib']['total']==404400 and abs(L['fixed']-134900)<1 and abs(L['k']-269500/15002.29)<0.01
    ok2=L and 404400 < L['C'] < 404400+19*3000      # 只加上之後的部分，不含分支外的 99999 字
    ok3=a['badge'] and '上下文 4' in a['badge']
    ok4=a['sent']==[]                                # 已有校正點，不自動送
    c=run(p,name,'nocalib'); M=c['last']
    ok5=M and M['calib'] is None and M['source']=='預設值' and abs(M['C']-(135000+1.82*16000))<2
    ok6=c['sent']==['/context']                      # 沒校正點、≥2 則訊息 → 自動送一次
    d=run(p,name,'nocalib',pre="document.addEventListener('DOMContentLoaded',()=>{document.querySelector('[data-testid=chat-input]').innerText='使用者打到一半'})")
    ok7=d['sent']==[] and d['input']=='使用者打到一半'   # 輸入框有字就不送，也不動那些字
    print(name,a['badge'],'|',c['badge'])
    for k,v in dict(calib_parse=ok1,anchored_C=ok2,badge=ok3,no_auto_when_calib=ok4,default_no_calib=ok5,auto_ctx_sent=ok6,no_auto_when_typing=ok7).items(): print('  ',k,'PASS' if v else 'FAIL')
