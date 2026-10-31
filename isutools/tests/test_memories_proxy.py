"""実nginxによるMemoriesの転送先・ヘッダー・境界の検証（ローカルのみ）。"""
import gzip
import json
import os
from pathlib import Path
import socket
import subprocess
import tempfile
import time
import unittest
import urllib.error
import urllib.request
import uuid

from test_regional_api_proxy import BACKEND_HOST, ROOT, backend, docker_network, free_port


@unittest.skipUnless(os.getenv('ISUTOOLS_NGINX_PROXY_TEST') == '1', 'local nginx integration opt-in')
class MemoriesProxyTest(unittest.TestCase):
    def test_only_memories_are_forwarded_to_asia2(self):
        with backend('asia1') as (local_port, local_calls), backend('asia2') as (memory_port, memory_calls):
            with tempfile.TemporaryDirectory(prefix='isureal-memories-nginx-') as directory:
                root = Path(directory)
                edge_port = free_port()
                nginx = ROOT / 'asia1/etc/nginx'
                upstream = (nginx / 'conf.d/isureal-memories-api.conf').read_text()
                self.assertIn('192.168.4.10:8080', upstream)
                upstream = upstream.replace('192.168.4.10:8080', f'{BACKEND_HOST}:{memory_port}')
                local = (nginx / 'conf.d/isureal-local-api.conf').read_text().replace('127.0.0.1:8080', f'{BACKEND_HOST}:{local_port}')
                site = (nginx / 'sites-available/isureal.conf').read_text()
                site = site.replace('listen 80 default_server', f'listen {edge_port} default_server')
                site = site.replace('/etc/nginx/snippets/', '/repo/asia1/etc/nginx/snippets/')
                gzip_config = '\n'.join(line for line in (nginx / 'nginx.conf').read_text().splitlines() if line.strip().startswith('gzip'))
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
  {local}
  {gzip_config}
  {site}
}}
''')
                name = 'isureal-memories-test-' + uuid.uuid4().hex[:10]
                common = ['docker', 'run', '--rm', '--user', f'{os.getuid()}:{os.getgid()}', '--entrypoint', 'nginx', *docker_network(edge_port), '-v', f'{root}:/test', '-v', f'{ROOT}:/repo:ro']
                result = subprocess.run(common + ['nginx:1.24', '-e', 'stderr', '-t', '-c', '/test/nginx.conf'], capture_output=True)
                self.assertEqual(result.returncode, 0, result.stderr.decode())
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

                    def request(path, method='GET', encoding='identity'):
                        req = urllib.request.Request(f'http://127.0.0.1:{edge_port}{path}', method=method, headers={
                            'Authorization': 'Bearer fixture', 'X-Client-IP': '203.0.113.7',
                            'X-Country-Code': 'JP', 'Accept-Encoding': encoding,
                        })
                        try:
                            return urllib.request.urlopen(req, timeout=3)
                        except urllib.error.HTTPError as response:
                            return response

                    for path in ['/api/memories?month=2026-10&beforePostedAt=2026-10-10T00%3A00%3A00Z&beforeId=a%2Fb', '/api/memories/2026-10-10?beforeId=x', '/api/memories/invalid-date']:
                        with request(path) as response:
                            payload = json.load(response)
                            self.assertEqual(payload['backend'], 'asia2')
                            self.assertEqual(payload['path'], path)
                            self.assertEqual(payload['authorization'], 'Bearer fixture')
                            self.assertEqual(payload['client_ip'], '203.0.113.7')
                            self.assertEqual(payload['country'], 'JP')
                    for path in ['/api/memories/', '/api/memories/2026-10-10/extra', '/api/memories-extra', '/api/me/export', '/api/posts', '/api/feeds/friends', '/api/images/image-id', '/api/initialize', '/api/notifications']:
                        with request(path) as response:
                            self.assertEqual(json.load(response)['backend'], 'asia1', path)
                    with request('/api/memories?conflict=1') as response:
                        self.assertEqual(response.status, 409)
                        self.assertEqual(json.load(response)['backend'], 'asia2')
                    with request('/api/memories?gzip=1', encoding='gzip') as response:
                        self.assertEqual(response.headers.get('Content-Encoding'), 'gzip')
                        self.assertEqual(json.loads(gzip.decompress(response.read()))['padding'], 'x' * 4000)
                    before_local, before_memory = len(local_calls), len(memory_calls)
                    with request('/api/memories?disconnect=1') as response:
                        self.assertEqual(response.status, 502)
                    self.assertEqual(len(local_calls), before_local)
                    self.assertEqual(len(memory_calls), before_memory + 1, '切断したリクエストを再送しない')
                finally:
                    subprocess.run(['docker', 'stop', name], check=True, capture_output=True)


if __name__ == '__main__':
    unittest.main()
