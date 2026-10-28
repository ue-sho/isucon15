'use strict';
// node --test isutools/profiler
const { test } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PROFILER = path.join(__dirname, 'profiler.cjs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let nextPort = 16060 + Math.floor(Math.random() * 1000);

function startApp(profilerPath, port, code = 'setInterval(() => {}, 1000)') {
  const child = spawn(process.execPath, ['--require', profilerPath, '-e', code], {
    env: { ...process.env, ISUTOOLS_PROFILER_PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderrText = '';
  child.stderr.on('data', (d) => (child.stderrText += d));
  return child;
}

async function waitListening(port) {
  for (let i = 0; i < 50; i++) {
    try {
      await fetch(`http://127.0.0.1:${port}/`);
      return;
    } catch {
      await sleep(100);
    }
  }
  throw new Error(`port ${port} not listening`);
}

const alive = (child) => child.exitCode === null && child.signalCode === null;

test('serves gzip pprof profile', async (t) => {
  const port = nextPort++;
  const app = startApp(PROFILER, port);
  t.after(() => app.kill());
  await waitListening(port);
  const res = await fetch(`http://127.0.0.1:${port}/debug/pprof/profile?seconds=1`);
  assert.strictEqual(res.status, 200);
  const body = Buffer.from(await res.arrayBuffer());
  assert.strictEqual(body[0], 0x1f);
  assert.strictEqual(body[1], 0x8b);
  const notFound = await fetch(`http://127.0.0.1:${port}/other`);
  assert.strictEqual(notFound.status, 404);
});

test('second process with same port keeps running', async (t) => {
  const port = nextPort++;
  const first = startApp(PROFILER, port);
  t.after(() => first.kill());
  await waitListening(port);
  const second = startApp(PROFILER, port);
  t.after(() => second.kill());
  await sleep(2000);
  assert.ok(alive(second), `second process died: ${second.stderrText}`);
});

test('app survives when pprof module is missing', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'isutools-profiler-'));
  const copy = path.join(dir, 'profiler.cjs');
  fs.copyFileSync(PROFILER, copy);
  const app = startApp(copy, nextPort++);
  t.after(() => app.kill());
  await sleep(1500);
  assert.ok(alive(app), 'app should keep running');
  assert.match(app.stderrText, /isutools profiler/);
});

test('does not keep process alive', async () => {
  const app = startApp(PROFILER, nextPort++, '1');
  const started = Date.now();
  await new Promise((resolve) => app.on('exit', resolve));
  assert.ok(Date.now() - started < 2000, 'process should exit promptly');
  assert.strictEqual(app.exitCode, 0);
});

// npm / npx / tsx などのランチャーは NODE_OPTIONS を子プロセスに引き継ぐ。
// ランチャー側がポートを取ると本物のアプリを計測できないため、ランチャーでは待ち受けない。
for (const launcher of [
  ['bin', 'npm'],
  ['bin', 'npx'],
  ['node_modules', 'npm', 'bin', 'npm-cli.js'],
  ['node_modules', 'tsx', 'dist', 'cli.mjs'],
]) {
  test(`does not listen inside launcher ${launcher.join('/')}`, async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'isutools-launcher-'));
    const script = path.join(dir, ...launcher);
    fs.mkdirSync(path.dirname(script), { recursive: true });
    fs.writeFileSync(script, 'setInterval(() => {}, 1000)\n');
    const port = nextPort++;
    const child = spawn(process.execPath, ['--require', PROFILER, script], {
      env: { ...process.env, ISUTOOLS_PROFILER_PORT: String(port) },
      stdio: 'ignore',
    });
    t.after(() => child.kill());
    await sleep(1500);
    assert.ok(alive(child));
    await assert.rejects(fetch(`http://127.0.0.1:${port}/`));
  });
}
