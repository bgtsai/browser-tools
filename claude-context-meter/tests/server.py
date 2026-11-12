# 夾具伺服器：模擬 claude.ai 的對話頁、工作階段 GET、對話樹（每次請求重讀狀態）
import http.server, socketserver, json, threading
ORG='11111111-2222-3333-4444-555555555555'
MODE={'tree':'calib'}  # calib：有 /context 校正點；nocalib：沒有
CTX='## Context Usage\n\n**Model:** x  \n**Tokens:** 404.4k / 1m (40%)\n\n| Category | Tokens | Percentage |\n|---|---|---|\n| Messages | 269.5k | 26.9% |\n'
def tree(cid):
    msgs=[]
    def add(uuid,sender,content):
        msgs.append({"uuid":uuid,"parent_message_uuid":msgs[-1]["uuid"] if msgs else "00000000-0000-4000-8000-000000000000","sender":sender,"content":content,"attachments":[]})
    add('m1','human',[{"type":"text","text":"a"*35000}])          # 35000/3.5 = 10000
    add('m2','assistant',[{"type":"text","text":"中"*5000}])       # 5000
    if MODE['tree']=='calib':
        add('m3','human',[{"type":"text","text":"/context"}])
        add('m4','assistant',[{"type":"text","text":CTX}])
    add('m5','human',[{"type":"text","text":"中"*1000}])           # 1000
    # 分支外的訊息不應計入
    side={"uuid":'x1',"parent_message_uuid":'m1',"sender":'assistant',"content":[{"type":"text","text":"中"*99999}]}
    return {"current_leaf_message_uuid":msgs[-1]["uuid"],"chat_messages":msgs+[side]}
PAGE='''<html><body style="background:#fff"><div data-testid="chat-header"><div data-testid="session-title-split" style="display:flex;align-items:center"><h2><button>標題</button></h2><button aria-haspopup="menu" style="width:28px;height:28px">v</button><button class="cho-btn">交接對話串</button></div></div>
<script>window.__redraw=()=>{const s=document.querySelector('[data-testid=session-title-split]');s.innerHTML=s.innerHTML.replace(/<span[^>]*ccm-meter[^>]*>.*?<\/span>/,'')}</script><div data-testid="chat-input" contenteditable="true"></div>
<button data-testid="chat-input-send" onclick="window.__sent=(window.__sent||[]).concat(document.querySelector('[data-testid=chat-input]').innerText);document.querySelector('[data-testid=chat-input]').innerText=''">send</button>
<script>fetch("/api/organizations/%s/ping").then(()=>fetch("/v1/code/sessions/cse_TEST?omit_bound_device=true"));</script></body></html>'''%ORG
class H(http.server.BaseHTTPRequestHandler):
    protocol_version='HTTP/1.1'
    def log_message(self,*a):pass
    def do_GET(self):
        p=self.path
        if p.startswith('/mode/'):MODE['tree']=p[6:];self._s(b'ok','text/plain')
        elif p.startswith('/chat/'):self._s(PAGE.encode(),'text/html')
        elif '/chat_conversations/' in p:self._s(json.dumps(tree(p)).encode(),'application/json')
        else:self._s(b'{}','application/json')
    def _s(self,b,ct):
        self.send_response(200);self.send_header('content-type',ct);self.send_header('content-length',str(len(b)));self.end_headers();self.wfile.write(b)
class S(socketserver.ThreadingMixIn,http.server.HTTPServer):daemon_threads=True;allow_reuse_address=True
S(('127.0.0.1',8767),H).serve_forever()
