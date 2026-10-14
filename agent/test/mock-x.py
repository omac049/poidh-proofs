# Mock of the two X API calls the signer makes, for test-post.sh. It checks each request's
# OAuth 1.0a signature on its own (independently of x.mjs) and logs accepted posts to argv[2].
import base64, hashlib, hmac, http.server, json, sys, urllib.parse as up
KEYS = dict(ck='ck-test-1234', cs='cs-test-5678', at='at-test-9012', ats='ats-test-3456')
q = lambda s: up.quote(s, safe='~')
state = {'next': 9001}

def signed_ok(handler):
    h = handler.headers.get('Authorization', '')
    if not h.startswith('OAuth '): return False
    p = {up.unquote(k.strip()): up.unquote(v.strip().strip('"')) for k, v in (x.split('=', 1) for x in h[6:].split(','))}
    sig = p.pop('oauth_signature', '')
    if p.get('oauth_consumer_key') != KEYS['ck'] or p.get('oauth_token') != KEYS['at']: return False
    ps = '&'.join(f'{k}={v}' for k, v in sorted((q(k), q(v)) for k, v in p.items()))
    base = '&'.join(['POST', q(f'http://127.0.0.1:{handler.server.server_port}{handler.path}'), q(ps)])
    want = base64.b64encode(hmac.new(f"{q(KEYS['cs'])}&{q(KEYS['ats'])}".encode(), base.encode(), hashlib.sha1).digest()).decode()
    return hmac.compare_digest(sig, want)

class H(http.server.BaseHTTPRequestHandler):
    def reply(self, code, obj):
        b = json.dumps(obj).encode(); self.send_response(code); self.send_header('Content-Type', 'application/json'); self.send_header('Content-Length', str(len(b))); self.end_headers(); self.wfile.write(b)
    def do_POST(self):
        body = self.rfile.read(int(self.headers.get('Content-Length', 0)))
        if not signed_ok(self): return self.reply(401, {'title': 'Unauthorized', 'detail': 'Unauthorized', 'status': 401})
        if self.path == '/2/media/upload':
            if b'name="media"' not in body or b'tweet_image' not in body or b'\x89PNG' not in body: return self.reply(400, {'title': 'Invalid Request', 'detail': 'bad upload'})
            state['next'] += 1; return self.reply(200, {'data': {'id': str(state['next']), 'media_key': f"3_{state['next']}"}})
        if self.path == '/2/tweets':
            req = json.loads(body)
            if 'DUPLICATE' in req.get('text', ''): return self.reply(403, {'title': 'Forbidden', 'detail': 'You are not allowed to create a Tweet with duplicate content.', 'status': 403})
            state['next'] += 1
            with open(sys.argv[2], 'a') as f: f.write(json.dumps(req) + '\n')
            return self.reply(201, {'data': {'id': str(state['next']), 'text': req['text']}})
        self.reply(404, {'title': 'Not Found'})
    def log_message(self, *a): pass

http.server.ThreadingHTTPServer(('127.0.0.1', int(sys.argv[1])), H).serve_forever()
