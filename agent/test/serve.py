import http.server, functools, sys
class H(http.server.SimpleHTTPRequestHandler):
    def do_GET(self):
        if self.path == '/redir':
            self.send_response(302); self.send_header('Location', 'http://localhost:8099/proofs/omars-agent-claim-1484.png'); self.end_headers(); return
        if self.path == '/redir-ok':
            self.send_response(302); self.send_header('Location', '/proofs/omars-agent-claim-1484.png'); self.end_headers(); return
        return super().do_GET()
    def log_message(self, *a): pass
http.server.ThreadingHTTPServer(('127.0.0.1', 8099), functools.partial(H, directory=sys.argv[1])).serve_forever()
