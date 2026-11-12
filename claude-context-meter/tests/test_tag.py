# v0.4.0 送出時附用量標記。用法：python3 test_tag.py ../ClaudeContextMeter.user.js
import sys,re
from playwright.sync_api import sync_playwright
SRC=open(sys.argv[1],encoding='utf-8').read();CID='aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';BASE='http://127.0.0.1:8767'
TAG=re.compile(r'\[ctx \d+%・[\d.]+萬\]$')
fails=0
def check(n,c,d=''):
    global fails; print(('  PASS ' if c else '  FAIL ')+n,d); fails+=(not c)
def typ(pg,t): pg.click('[data-testid=chat-input]'); pg.keyboard.type(t)
with sync_playwright() as p:
  for name in ['chromium','firefox']:
    print(name); b=getattr(p,name).launch();pg=b.new_page()
    pg.goto(BASE+'/mode/calib');pg.add_init_script(SRC);pg.goto(BASE+'/chat/'+CID);pg.wait_for_timeout(4000)
    sent=lambda: pg.evaluate('window.__sent||[]')
    typ(pg,'你好'); pg.click('[data-testid=chat-input-send]'); pg.wait_for_timeout(400)
    s=sent(); check('送出鈕：尾端附標記',len(s)==1 and s[0].startswith('你好') and bool(TAG.search(s[0].strip())),repr(s))
    typ(pg,'第二則'); pg.keyboard.press('Enter'); pg.wait_for_timeout(400)
    s=sent(); check('Enter：尾端附標記',len(s)==2 and s[1].startswith('第二則') and bool(TAG.search(s[1].strip())),repr(s[-1:]))
    typ(pg,'/context'); pg.keyboard.press('Enter'); pg.wait_for_timeout(400)
    s=sent(); check('/ 開頭不加標記',len(s)==3 and s[2].strip()=='/context',repr(s[-1:]))
    typ(pg,'已有 [ctx 1%・1.0萬]'); pg.click('[data-testid=chat-input-send]'); pg.wait_for_timeout(400)
    s=sent(); check('已有標記不重複加',len(s)==4 and s[3].strip()=='已有 [ctx 1%・1.0萬]',repr(s[-1:]))
    b.close()
print('全部通過' if not fails else f'{fails} 項失敗')
