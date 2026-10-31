"""ローカル専用。ISUTOOLS_NGINX_PROXY_TEST=1でDocker内nginxを検証する。

本番への接続、コンテナ配置、サービス操作は行わない。
"""
import contextlib
import http.server
import json
import os
from pathlib import Path
import socket
import subprocess
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
import uuid

ROOT = Path(__file__).resolve().parents[2]


def free_port():
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        return sock.getsockname()[1]


@contextlib.contextmanager
def backend(label):
    calls = []

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            body = self.rfile.read(int(self.headers.get('Content-Length', '0')))
            calls.append(self.path)
            if self.path.endswith('disconnect=1'):
                self.connection.close()
                return
            status = 409 if self.path.endswith('conflict=1') else 200
            result = json.dumps(dict(
                backend=label, path=self.path, method=self.command,
                body=body.decode(), authorization=self.headers.get('Authorization'),
                client_ip=self.headers.get('X-Client-IP'), country=self.headers.get('X-Country-Code'),
            )).encode()
            self.send_response(status)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(result)))
            self.end_headers()
            self.wfile.write(result)

        do_POST = do_GET

        def log_message(self, *args):
            pass

    server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
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
    def test_real_nginx_routing_and_forwarding(self):
        with backend('local') as (local_port, local_calls):
            for host, port, region in [('europe1', 8081, 'europe'), ('america1', 8082, 'america')]:
                with self.subTest(host=host), backend(region) as (remote_port, remote_calls):
                    with tempfile.TemporaryDirectory(prefix='isu15-regional-nginx-') as directory:
                        root = Path(directory)
                        edge_port = free_port()
                        upstream = (ROOT / host / 'etc/nginx/conf.d/isureal-regional-api.conf').read_text()
                        self.assertIn(f'192.168.1.10:{port}', upstream)
                        upstream = upstream.replace(f'192.168.1.10:{port}', f'127.0.0.1:{remote_port}')
                        site = (ROOT / host / 'etc/nginx/sites-available/isureal.conf').read_text()
                        site = site.replace('listen 80 default_server', f'listen {edge_port} default_server')
                        site = site.replace('127.0.0.1:8080', f'127.0.0.1:{local_port}')
                        site = site.replace('/etc/nginx/snippets/', f'/repo/{host}/etc/nginx/snippets/')
                        (root / 'nginx.conf').write_text(f'''
worker_processes 1;
pid /test/nginx.pid;
error_log /test/error.log;
events {{ worker_connections 128; }}
http {{
  access_log off;
  client_body_temp_path /test/body;
  proxy_temp_path /test/proxy;
  fastcgi_temp_path /test/fastcgi;
  uwsgi_temp_path /test/uwsgi;
  scgi_temp_path /test/scgi;
  {upstream}
  {site}
}}
''')
                        name = 'isu15-regional-test-' + uuid.uuid4().hex[:10]
                        common = ['docker', 'run', '--rm', '--user', f'{os.getuid()}:{os.getgid()}', '--entrypoint', 'nginx', '--network', 'host', '-v', f'{root}:/test', '-v', f'{ROOT}:/repo:ro']
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

                            def request(path, method='GET', body=None):
                                req = urllib.request.Request(f'http://127.0.0.1:{edge_port}{path}', data=body, method=method, headers={
                                    'Authorization': 'Bearer fixture', 'X-Client-IP': '203.0.113.7', 'X-Country-Code': 'GB' if region == 'europe' else 'US',
                                    'Content-Type': 'multipart/form-data; boundary=fixture',
                                })
                                try:
                                    return urllib.request.urlopen(req, timeout=3)
                                except urllib.error.HTTPError as response:
                                    return response

                            for path in ['/api/posts', '/api/feeds/friends', '/api/posting-window/current', '/api/posts/me/current']:
                                with request(path + '?cursor=a%2Fb&x=1') as response:
                                    self.assertEqual(response.status, 200)
                                    payload = json.load(response)
                                    self.assertEqual(payload['backend'], region)
                                    self.assertEqual(payload['path'], path + '?cursor=a%2Fb&x=1')
                                    self.assertEqual(payload['authorization'], 'Bearer fixture')
                                    self.assertEqual(payload['client_ip'], '203.0.113.7')
                                    self.assertEqual(payload['country'], 'GB' if region == 'europe' else 'US')
                            image_body = b'--fixture\r\nJPEG-upload\r\n--fixture--\r\n'
                            with request('/api/posts', 'POST', image_body) as response:
                                payload = json.load(response)
                                self.assertEqual(payload['method'], 'POST')
                                self.assertEqual(payload['body'].encode(), image_body)
                            for path in ['/api/posts/post-id', '/api/feeds/public', '/api/feeds/friends-of-friends', '/api/feeds/friends/', '/api/images/image-id', '/api/me/profile-image', '/api/initialize', '/api/notifications', '/api/me/export']:
                                with request(path) as response:
                                    self.assertEqual(json.load(response)['backend'], 'local')
                            with request('/api/posts?conflict=1', 'POST', b'fixture') as response:
                                self.assertEqual(response.status, 409)
                                self.assertEqual(json.load(response)['backend'], region)
                            before_remote, before_local = len(remote_calls), len(local_calls)
                            with request('/api/posts?disconnect=1', 'POST', b'fixture') as response:
                                self.assertEqual(response.status, 502)
                            self.assertEqual(len(remote_calls), before_remote + 1)
                            self.assertEqual(len(local_calls), before_local)
                        finally:
                            subprocess.run(['docker', 'stop', name], check=True, capture_output=True)


if __name__ == '__main__':
    unittest.main()
