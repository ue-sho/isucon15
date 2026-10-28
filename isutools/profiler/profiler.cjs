'use strict';
// isutools: NODE_OPTIONS=--require で読み込む pprof エンドポイント。
//   GET /debug/pprof/profile?seconds=N → @datadog/pprof の time profile（gzip 済み pprof 形式）
// アプリを絶対に落とさないこと: 失敗はすべて console.error に出して諦める。
try {
  const http = require('node:http');
  const pprof = require('@datadog/pprof');
  const port = Number(process.env.ISUTOOLS_PROFILER_PORT || 6060);

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname !== '/debug/pprof/profile') {
      res.writeHead(404).end();
      return;
    }
    const seconds = Number(url.searchParams.get('seconds')) || 30;
    try {
      const profile = await pprof.time.profile({ durationMillis: seconds * 1000 });
      const buf = await pprof.encode(profile);
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' }).end(buf);
    } catch (e) {
      res.writeHead(500).end(String(e));
    }
  });
  // cluster 等で複数プロセスが読み込んだ場合、最初にポートを取れたプロセスだけが待ち受ける
  server.on('error', (e) => {
    if (e.code !== 'EADDRINUSE') console.error('[isutools profiler]', e);
  });
  server.listen(port);
  server.unref();
} catch (e) {
  console.error('[isutools profiler] disabled:', e && e.message);
}
