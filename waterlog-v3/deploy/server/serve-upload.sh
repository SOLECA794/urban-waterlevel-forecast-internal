#!/bin/bash
# serve-upload.sh — 在服务器上临时起一个只接收文件的 HTTP 口
#
# 用途：本地 → 服务器传部署包。SSH 没有密钥、云助手分块传输 14MB 要上千次往返，
# 都比不上「临时开一个口，post 完就关」。这个脚本起一个极小的 Python HTTP 服务，
# 只处理 PUT，写到 /root/upload/<文件名>，收到 __DONE__ 就自己退出。
#
# 用法（服务器）：setsid nohup bash serve-upload.sh 8299 <本次令牌> > /root/upload.log 2>&1 &
# 用法（本地）：  curl -T pkg.tar.gz http://114.55.31.135:8299/pkg.tar.gz
set -euo pipefail

PORT="${1:?用法: serve-upload.sh <端口> <令牌>}"
TOKEN="${2:?缺少令牌}"
DEST=/root/upload
mkdir -p "$DEST"

exec /usr/bin/python3.11 - "$PORT" "$TOKEN" "$DEST" <<'PY'
import http.server, os, socketserver, sys
port, token, dest = int(sys.argv[1]), sys.argv[2], sys.argv[3]

class H(http.server.BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def _deny(self):
        self.send_response(403); self.send_header('Content-Length', '0'); self.end_headers()

    def do_PUT(self):
        if self.headers.get('X-Token') != token:
            return self._deny()
        name = os.path.basename(self.path.lstrip('/'))
        if not name:
            return self._deny()
        length = int(self.headers.get('Content-Length', 0))
        path = os.path.join(dest, name)
        with open(path, 'wb') as f:
            left = length
            while left > 0:
                chunk = self.rfile.read(min(1 << 20, left))
                if not chunk:
                    break
                f.write(chunk); left -= len(chunk)
        self.send_response(200)
        self.send_header('Content-Length', '2'); self.end_headers()
        self.wfile.write(b'ok')
        print(f'[upload] {name} {os.path.getsize(path)}B', flush=True)

    def do_POST(self):
        if self.path.rstrip('/') == '/__DONE__':
            if self.headers.get('X-Token') != token:
                return self._deny()
            self.send_response(200); self.send_header('Content-Length','2'); self.end_headers()
            self.wfile.write(b'ok'); self.wfile.flush()
            print('[upload] DONE, exiting', flush=True)
            import threading, os as _os
            threading.Timer(0.5, lambda: _os._exit(0)).start()

    def log_message(self, *a):
        pass

socketserver.TCPServer.allow_reuse_address = True
with socketserver.ThreadingTCPServer(('0.0.0.0', port), H) as srv:
    print(f'[upload] listening :{port} -> {dest}', flush=True)
    srv.serve_forever()
PY
