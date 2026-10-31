import assert from 'node:assert/strict';
import { execFile, fork } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
import { sha256Hex } from '../../src/session.ts';
export const root = resolve(import.meta.dirname, '../../../..');
export const run = promisify(execFile);
export const headers = { Authorization: 'Bearer owner', 'X-Client-IP': '203.0.113.1', 'X-Country-Code': 'JP' };
export const docker = async (...args: string[]) => (await run('docker', args, { maxBuffer: 1024 * 1024 })).stdout;
export async function database() {
  const name = 'isu15-asia-nginx-pg-' + randomUUID();
  await docker('run', '--rm', '-d', '--name', name, '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', '-e', 'POSTGRES_DB=nginx_test', '-p', '127.0.0.1::5432', 'postgres:16');
  const port = Number((await docker('port', name, '5432/tcp')).trim().split(':').at(-1));
  let db: pg.Client | undefined;
  try {
    for (let i = 0; i < 100; i++) {
      db = new pg.Client({ host: '127.0.0.1', port, user: 'postgres', password: '', database: 'nginx_test' });
      try { await db.connect(); break; } catch (err) { await db.end().catch(() => {}); db = undefined; if (i === 99) throw err; await delay(100); }
    }
    assert.ok(db);
    assert.equal((await db.query("SELECT count(*) FROM pg_tables WHERE schemaname='public'")).rows[0].count, '0');
    await db.query(await readFile(join(root, 'webapp/sql/001-schema.sql'), 'utf8'));
    for (const [id, region] of [['owner', 'asia'], ['other', 'asia'], ['europe', 'europe']]) {
      await db.query('INSERT INTO users(id,username,secret_key_hash,display_name,region) VALUES($1::text,$1::text,$2,$1::text,$3)', [id, 'ab'.repeat(32), region]);
      await db.query('INSERT INTO login_sessions(id,user_id,token_hash) VALUES($1,$1,$2)', [id, sha256Hex(id!)]);
    }
    await db.query("INSERT INTO ip_bans(ip,banned_until) VALUES('203.0.113.99',clock_timestamp()+interval '1 hour')");
    return { db, port, close: async () => { await db!.end(); await docker('stop', '--time', '1', name); } };
  } catch (err) { await db?.end().catch(() => {}); await docker('stop', '--time', '1', name); throw err; }
}
export async function application(pgPort: number, instance: string) {
  const child = fork(join(import.meta.dirname, 'fixture.ts'), [], { env: { PATH: process.env.PATH,
    TEST_PG_PORT: String(pgPort), TEST_INSTANCE: instance, PPROTEIN_ENABLED: '0', NODE_OPTIONS: '' }, silent: true });
  let output = '';
  child.stdout!.on('data', d => output += String(d));
  child.stderr!.on('data', d => output += String(d));
  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('application startup timeout: ' + output.slice(-1000))), 15_000);
    child.once('message', (m: any) => { clearTimeout(timer); resolve(m.port); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`application exited ${code}: ${output.slice(-1000)}`)); });
  });
  const url = `http://127.0.0.1:${port}`;
  return { port, url, child, output: () => output, stats: async () => (await fetch(url + '/__fixture_stats')).json(),
    close: async () => { if (child.exitCode === null && child.signalCode === null) { const exit = once(child, 'exit'); child.kill('SIGTERM'); await exit; } } };
}
export async function nginx(localPort: number, remotePort: number, baseline: boolean, base: string, bodyTimeout?: string) {
  const directory = await mkdtemp(join(tmpdir(), 'isu15-asia-nginx-'));
  const name = 'isu15-asia-nginx-' + randomUUID();
  let started = false;
  const close = async () => { if (started) await docker('stop', '--time', '1', name); await rm(directory, { recursive: true, force: true }); };
  try {
    const backendHost = 'host.docker.internal';
    const configs = join(root, 'asia1/etc/nginx');
    let site = baseline ? (await run('git', ['show', `${base}:asia1/etc/nginx/sites-available/isureal.conf`], { cwd: root })).stdout : await readFile(join(configs, 'sites-available/isureal.conf'), 'utf8');
    site = site.replaceAll('/etc/nginx/snippets/', '/repo/asia1/etc/nginx/snippets/');
    const upstream = (await readFile(join(configs, 'conf.d/isureal-memories-api.conf'), 'utf8')).replace('192.168.4.10:8080', `${backendHost}:${remotePort}`);
    const local = (await readFile(join(configs, 'conf.d/isureal-local-api.conf'), 'utf8')).replace('127.0.0.1:8080', `${backendHost}:${localPort}`);
    const gzip = (await readFile(join(configs, 'nginx.conf'), 'utf8')).split('\n').filter(l => l.trim().startsWith('gzip')).join('\n');
    await writeFile(join(directory, 'nginx.conf'), `worker_processes 1;
pid /test/nginx.pid;
error_log /test/error.log info;
events { worker_connections 2048; }
http {
  log_format test '$request_method $uri $status $upstream_addr $request_length $request_time';
  access_log /test/access.log test;
  client_body_temp_path /test/body;
  proxy_temp_path /test/proxy;
  fastcgi_temp_path /test/fastcgi;
  uwsgi_temp_path /test/uwsgi;
  scgi_temp_path /test/scgi;
  ${bodyTimeout ? `client_body_timeout ${bodyTimeout};` : ''}
  ${gzip}
  ${upstream}
  ${local}
  ${site}
}`);
    const common = ['run', '--rm', '--user', `${process.getuid!()}:${process.getgid!()}`, '--entrypoint', 'nginx',
      '--add-host', 'host.docker.internal:host-gateway', '-v', `${directory}:/test`, '-v', `${root}:/repo:ro`];
    await docker(...common, 'nginx:1.24', '-e', 'stderr', '-t', '-c', '/test/nginx.conf');
    await docker(...common, '-d', '--name', name, '-p', '127.0.0.1::80', 'nginx:1.24', '-c', '/test/nginx.conf', '-g', 'daemon off;');
    started = true;
    const port = Number((await docker('port', name, '80/tcp')).trim().split(':').at(-1));
    const url = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 50; i++) {
      try { await (await fetch(url + '/api/me', { signal: AbortSignal.timeout(1000) })).text(); break; }
      catch (err) { if (i === 49) throw err; await delay(20); }
    }
    const logs = async () => ({ access: await readFile(join(directory, 'access.log'), 'utf8'), error: await readFile(join(directory, 'error.log'), 'utf8') });
    const stats = async () => {
      const out = await docker('exec', name, 'sh', '-c', 'for p in /proc/[0-9]*; do [ "$(cat "$p/comm" 2>/dev/null)" = nginx ] && { cat "$p/status" | sed -n "/VmRSS:/p"; cat "$p/io"; }; done; true');
      const sum = (key: string) => [...out.matchAll(new RegExp('^' + key + ':\\s+(\\d+)', 'gm'))].reduce((n, m) => n + Number(m[1]), 0);
      return { rssKiB: sum('VmRSS'), writeBytes: sum('write_bytes'), writeChars: sum('wchar'), cancelledWriteBytes: sum('cancelled_write_bytes') };
    };
    return { url, port, close, logs, stats };
  } catch (err) { await close(); throw err; }
}
export async function response(url: string, init: RequestInit = {}) {
  const r = await fetch(url, { ...init, headers: { ...headers, ...init.headers }, signal: AbortSignal.timeout(15_000) });
  return { status: r.status, body: await r.text(), allow: r.headers.get('allow') };
}
