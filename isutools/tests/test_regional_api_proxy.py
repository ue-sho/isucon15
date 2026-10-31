"""ローカル専用。ISUTOOLS_NGINX_PROXY_TEST=1でDocker内nginxを検証する。

本番への接続、コンテナ配置、サービス操作は行わない。
"""
import contextlib
import gzip
import shutil
import http.server
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
import uuid

ROOT = Path(__file__).resolve().parents[2]
BACKEND_HOST = 'host.docker.internal' if sys.platform == 'darwin' else '127.0.0.1'


def docker_network(port):
    # Docker Desktopのhost network機能を有効にする操作を試験の前提にしない。
    return ['-p', f'127.0.0.1:{port}:{port}'] if sys.platform == 'darwin' else ['--network', 'host']


def free_port():
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        return sock.getsockname()[1]


@contextlib.contextmanager
def backend(label):
    calls = []

    class Handler(http.server.BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"
        def do_GET(self):
            body = self.rfile.read(int(self.headers.get('Content-Length', '0')))
            calls.append(self.path)
            if self.path.endswith('disconnect=1'):
                self.close_connection = True
                self.connection.close()
                return
            status = 409 if self.path.endswith('conflict=1') else 503 if self.path.endswith('unavailable=1') else 200
            result = json.dumps(dict(
                backend=label, path=self.path, method=self.command,
                body=body.decode(), authorization=self.headers.get('Authorization'),
                client_ip=self.headers.get('X-Client-IP'), country=self.headers.get('X-Country-Code'),
                padding="x" * 4000 if self.path.endswith("gzip=1") else "",
            )).encode()
            self.send_response(status)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(result)))
            self.end_headers()
            self.wfile.write(result)

        do_POST = do_GET
        do_PUT = do_GET
        do_DELETE = do_GET
        do_PATCH = do_GET
        do_OPTIONS = do_GET

        def log_message(self, *args):
            pass

    server = http.server.ThreadingHTTPServer(('0.0.0.0' if sys.platform == 'darwin' else '127.0.0.1', 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield server.server_port, calls
    finally:
        server.shutdown()
        server.server_close()
        thread.join()


@unittest.skipUnless(os.getenv('ISUTOOLS_NGINX_PROXY_TEST') == '1', 'local nginx integration opt-in')
class RegionalAPIProxyTest(unittest.TestCase):
    def test_complete_production_configs_parse(self):
        for host in ['asia1', 'europe1', 'america1']:
            with self.subTest(host=host), tempfile.TemporaryDirectory(prefix='isu15-nginx-config-') as directory:
                root = Path(directory) / 'nginx'
                shutil.copytree(ROOT / host / 'etc/nginx', root, symlinks=True)
                (root / 'sites-enabled').mkdir(exist_ok=True)
                (root / 'modules-enabled').mkdir(exist_ok=True)
                result = subprocess.run(['docker', 'run', '--rm', '--entrypoint', 'nginx', '-v', f'{root}:/etc/nginx:ro', 'nginx:1.24', '-t'], capture_output=True)
                self.assertEqual(result.returncode, 0, result.stderr.decode())

    def test_real_nginx_routing_and_forwarding(self):
        with backend('local') as (local_port, local_calls):
            for host, port, region in [('europe1', 8081, 'europe'), ('america1', 8082, 'america')]:
                with self.subTest(host=host), backend(region) as (remote_port, remote_calls):
                    with tempfile.TemporaryDirectory(prefix='isu15-regional-nginx-') as directory:
                        root = Path(directory)
                        edge_port = free_port()
                        upstream = (ROOT / host / 'etc/nginx/conf.d/isureal-regional-api.conf').read_text()
                        self.assertIn(f'192.168.1.10:{port}', upstream)
                        upstream = upstream.replace(f'192.168.1.10:{port}', f'{BACKEND_HOST}:{remote_port} max_fails=0')
                        # 試験だけ予備upstreamを追加。snippetのoffがなければ再送される条件。
                        upstream = upstream.replace('  keepalive 16;', f'  server {BACKEND_HOST}:{local_port} backup;\n  keepalive 16;')
                        site = (ROOT / host / 'etc/nginx/sites-available/isureal.conf').read_text()
                        # 下の再送用テスト設定を対象外経路へ継承させない（本来の既定値）。
                        site = site.replace('location /api/ {', 'location /api/ {\n    proxy_next_upstream error timeout;')
                        site = site.replace('listen 80 default_server', f'listen {edge_port} default_server')
                        local_upstream = (ROOT / host / 'etc/nginx/conf.d/isureal-local-api.conf').read_text().replace('127.0.0.1:8080', f'{BACKEND_HOST}:{local_port}')
                        gzip_config = '\n'.join(line for line in (ROOT / host / 'etc/nginx/nginx.conf').read_text().splitlines() if line.strip().startswith('gzip'))
                        site = site.replace('/etc/nginx/snippets/', f'/repo/{host}/etc/nginx/snippets/')
                        (root / 'nginx.conf').write_text(f'''
worker_processes 1;
pid /test/nginx.pid;
error_log /test/error.log;
events {{ worker_connections 128; }}
http {{
  access_log off;
  proxy_next_upstream error timeout http_503 non_idempotent;
  client_body_temp_path /test/body;
  proxy_temp_path /test/proxy;
  fastcgi_temp_path /test/fastcgi;
  uwsgi_temp_path /test/uwsgi;
  scgi_temp_path /test/scgi;
  {upstream}
  {local_upstream}
  {gzip_config}
  {site}
}}
''')
                        name = 'isu15-regional-test-' + uuid.uuid4().hex[:10]
                        common = ['docker', 'run', '--rm', '--user', f'{os.getuid()}:{os.getgid()}', '--entrypoint', 'nginx', *docker_network(edge_port), '-v', f'{root}:/test', '-v', f'{ROOT}:/repo:ro']
                        check = subprocess.run(common + ['nginx:1.24', '-e', 'stderr', '-t', '-c', '/test/nginx.conf'], capture_output=True)
                        self.assertEqual(check.returncode, 0, check.stderr.decode())
                        subprocess.run(common + ['-d', '--name', name, 'nginx:1.24', '-c', '/test/nginx.conf', '-g', 'daemon off;'], check=True, capture_output=True)
                        try:
                            for _ in range(100):
                                try:
                                    with socket.create_connection(('127.0.0.1', edge_port), timeout=.1):
                                        break
                                except OSError:
                                    time.sleep(.02)
                            else:
                                self.fail((root / 'error.log').read_text())

                            def request(path, method='GET', body=None, encoding='identity'):
                                req = urllib.request.Request(f'http://127.0.0.1:{edge_port}{path}', data=body, method=method, headers={
                                    'Authorization': 'Bearer fixture', 'X-Client-IP': '203.0.113.7', 'X-Country-Code': 'GB' if region == 'europe' else 'US',
                                    'Content-Type': 'multipart/form-data; boundary=fixture', 'Accept-Encoding': encoding,
                                })
                                try:
                                    return urllib.request.urlopen(req, timeout=3)
                                except urllib.error.HTTPError as response:
                                    return response

                            for path in ['/api/feeds/friends', '/api/posting-window/current', '/api/posts/me/current']:
                                with request(path + '?cursor=a%2Fb&x=1') as response:
                                    self.assertEqual(response.status, 200)
                                    payload = json.load(response)
                                    self.assertEqual(payload['backend'], region)
                                    self.assertEqual(payload['path'], path + '?cursor=a%2Fb&x=1')
                                    self.assertEqual(payload['authorization'], 'Bearer fixture')
                                    self.assertEqual(payload['client_ip'], '203.0.113.7')
                                    self.assertEqual(payload['country'], 'GB' if region == 'europe' else 'US')
                            updates = [('/api/friend-requests', 'POST'), ('/api/auth/login', 'POST')]
                            updates += [(f'/api/friend-requests/request%2Did/{action}', 'POST') for action in ['accept', 'reject', 'cancel']]
                            updates += [('/api/friendships/user%2Did', 'DELETE')]
                            updates += [(f'/api/{kind}/user%2Did', method) for kind in ['follows', 'blocks'] for method in ['PUT', 'DELETE']]
                            for path, method in updates:
                                body = b'{"recipientId":"target","text":"\\u65e5"}'
                                with request(path + '?cursor=a%2Fb&x=1&x=2', method, body) as response:
                                    self.assertEqual(response.status, 200)
                                    payload = json.load(response)
                                    self.assertEqual(payload['backend'], region)
                                    self.assertEqual(payload['method'], method)
                                    self.assertEqual(payload['path'], path + '?cursor=a%2Fb&x=1&x=2')
                                    self.assertEqual(payload['body'].encode(), body)
                                    self.assertEqual(payload['authorization'], 'Bearer fixture')
                                    self.assertEqual(payload['client_ip'], '203.0.113.7')
                                    self.assertEqual(payload['country'], 'GB' if region == 'europe' else 'US')
                                allowed = {m for p, m in updates if p == path}
                                for unsupported in {'GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'} - allowed:
                                    with request(path, unsupported) as response:
                                        self.assertEqual(json.load(response)['backend'], 'local')
                                # 完了応答を受け取れない更新を再送・localへfallbackしない。
                                before_remote, before_local = len(remote_calls), len(local_calls)
                                with request(path + '?disconnect=1', method, body) as response:
                                    self.assertEqual(response.status, 502)
                                self.assertEqual(len(remote_calls), before_remote + 1)
                                self.assertEqual(len(local_calls), before_local)
                                before_remote, before_local = len(remote_calls), len(local_calls)
                                with request(path + '?unavailable=1', method, body) as response:
                                    self.assertEqual(response.status, 503)
                                    self.assertEqual(json.load(response)['backend'], region)
                                self.assertEqual(len(remote_calls), before_remote + 1)
                                self.assertEqual(len(local_calls), before_local)
                                with request(path + '?conflict=1', method, body) as response:
                                    self.assertEqual(response.status, 409)
                                    self.assertEqual(json.load(response)['backend'], region)
                            for path, method in [
                                ('/api/relationships/friends', 'GET'), ('/api/me/account-deletion', 'POST'),
                                ('/api/friend-requests/', 'POST'), ('/api/friend-requests/id/unknown', 'POST'),
                                ('/api/friend-requests/id/accept/extra', 'POST'), ('/api/friendships/id/', 'DELETE'),
                                ('/api/follows/id/extra', 'PUT'), ('/api/blocks/', 'DELETE'),
                                ('/api/auth/login/', 'POST'), ('/api/auth/login/extra', 'POST'),
                                ('/api/auth/register', 'POST'), ('/api/auth/logout', 'POST'),
                            ]:
                                with request(path, method) as response:
                                    self.assertEqual(json.load(response)['backend'], 'local')
                            image_body = b'--fixture\r\nJPEG-upload\r\n--fixture--\r\n'
                            with request('/api/posts', 'POST', image_body) as response:
                                payload = json.load(response)
                                self.assertEqual(payload['backend'], 'local')
                                self.assertEqual(payload['method'], 'POST')
                                self.assertEqual(payload['body'].encode(), image_body)
                            for path in ['/api/posts', '/api/posts/post-id', '/api/feeds/public', '/api/feeds/friends-of-friends', '/api/feeds/friends/', '/api/images/image-id', '/api/me/profile-image', '/api/initialize', '/api/notifications', '/api/me/export']:
                                with request(path) as response:
                                    self.assertEqual(json.load(response)['backend'], 'local')
                            with request('/api/posts?conflict=1', 'POST', b'fixture') as response:
                                self.assertEqual(response.status, 409)
                                self.assertEqual(json.load(response)['backend'], 'local')
                            with request('/api/feeds/public?gzip=1', encoding='gzip') as response:
                                self.assertEqual(response.headers.get('Content-Encoding'), 'gzip')
                                self.assertEqual(json.loads(gzip.decompress(response.read()))['padding'], 'x' * 4000)
                            with request('/api/notifications?gzip=1', encoding='gzip') as response:
                                self.assertIsNone(response.headers.get('Content-Encoding'))
                                self.assertEqual(json.load(response)['padding'], 'x' * 4000)
                            before_remote, before_local = len(remote_calls), len(local_calls)
                            with request('/api/posts?disconnect=1', 'POST', b'fixture') as response:
                                self.assertEqual(response.status, 502)
                            self.assertEqual(len(remote_calls), before_remote)
                            self.assertEqual(len(local_calls), before_local + 1)
                        finally:
                            subprocess.run(['docker', 'stop', name], check=True, capture_output=True)


if __name__ == '__main__':
    unittest.main()
