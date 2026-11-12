import asyncio, threading, time, http.server, socketserver, json
import websockets
U='{"type":"assistant","message":{"usage":{"input_tokens":3,"cache_read_input_tokens":123456,"cache_creation_input_tokens":789,"output_tokens":42}}}'
PAGE=b'''<html><body><p>fixture</p><script>
const ws=new WebSocket('ws://127.0.0.1:8766/');window.__wsReady=new Promise(r=>ws.onmessage=()=>r(1));
fetch('/stream').then(r=>r.text()).then(t=>window.__fetchDone=1);
const x=new XMLHttpRequest();x.open('GET','/xhr');x.onload=()=>window.__xhrDone=1;x.send();
const es=new EventSource('/sse');es.onmessage=()=>{window.__esDone=1;es.close()};
fetch('/decoy').then(r=>r.text());
</script></body></html>'''
ORG='11111111-2222-3333-4444-555555555555';CID='aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';N={'n':0}
PAGE2=('<html><body><script>fetch("/api/organizations/'+ORG+'/ping");fetch("/v1/code/sessions/cse_TEST?omit_bound_device=true").then(()=>fetch("/claudeai-rpc/anthropic.bard.api.v1alpha.ConversationService/PerformAction",{method:"POST"}));</script></body></html>').encode()
class H(http.server.BaseHTTPRequestHandler):
    protocol_version='HTTP/1.1'
    def log_message(self,*a):pass
    def do_POST(self):
        self._send(b'ok','application/proto')
    def do_GET(self):
        p=self.path
        if p=='/':self._send(PAGE,'text/html')
        elif p=='/reset':N['n']=0;self._send(b'ok','text/plain')
        elif p=='/chat/'+CID:self._send(PAGE2,'text/html')
        elif p.startswith('/api/organizations/'+ORG+'/ping'):self._send(b'{}','application/json')
        elif p.startswith('/v1/code/sessions/cse_TEST'):
            N['n']+=1;k=min(N['n'],6)//2
            self._send(json.dumps({"data":{"usage":{"cache_read_tokens":1000+k*100,"cache_write_tokens":10,"input_tokens":1,"output_tokens":5+k}},"status_category":"working"}).encode(),'application/json')
        elif p.startswith('/api/organizations/'+ORG+'/chat_conversations/'+CID):
            self._send(json.dumps({"uuid":CID,"chat_messages":[{"uuid":"m1","content":[{"type":"text","text":"SECRET"},{"type":"tool_use"}]}]}).encode(),'application/json')
        elif p=='/stream':
            self.send_response(200);self.send_header('content-type','text/event-stream');self.send_header('transfer-encoding','chunked');self.end_headers()
            s=b'{"x":{"cache_read_input_tokens":555}}';cut=s.index(b"cache_read")+4
            for part in (s[:cut],s[cut:]):
                self.wfile.write(b'%x\r\n%s\r\n'%(len(part),part));self.wfile.flush();time.sleep(0.3)
            self.wfile.write(b'0\r\n\r\n')
        elif p=='/xhr':self._send(U.encode(),'application/json')
        elif p=='/decoy':self._send(json.dumps({"text":'reply mentions \\"input_tokens\\": 5 in prose'}).encode(),'application/json')
        elif p=='/sse':
            body=('data: '+U+'\n\n').encode();self.send_response(200);self.send_header('content-type','text/event-stream');self.send_header('content-length',str(len(body)));self.end_headers();self.wfile.write(body)
    def _send(self,b,ct):
        self.send_response(200);self.send_header('content-type',ct);self.send_header('content-length',str(len(b)));self.end_headers();self.wfile.write(b)
class S(socketserver.ThreadingMixIn,http.server.HTTPServer):daemon_threads=True;allow_reuse_address=True
threading.Thread(target=S(('127.0.0.1',8765),H).serve_forever,daemon=True).start()
async def h(ws):
    await ws.send(U); await ws.send(U.encode())
    await asyncio.sleep(5)
async def main():
    async with websockets.serve(h,'127.0.0.1',8766): await asyncio.sleep(3600)
asyncio.run(main())
