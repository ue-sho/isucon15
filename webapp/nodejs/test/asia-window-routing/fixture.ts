// Test-only process: production newServer and the installed Hono adapter, pool=2.
import { serve, type HttpBindings } from '@hono/node-server';
import type { IncomingMessage } from 'node:http';
import { newServer } from '../../src/server.ts';
const app = await newServer({ region: 'asia', dbHost: '127.0.0.1', dbPort: process.env.TEST_PG_PORT!,
  dbUser: 'postgres', dbPassword: '', dbName: 'nginx_test', logLevel: 'debug' }, 2);
const active = new Set<IncomingMessage>();
let requests = 0, maxRSS = 0, maxReadableLength = 0;
const sample = () => {
  maxRSS = Math.max(maxRSS, process.memoryUsage().rss);
  for (const r of active) maxReadableLength = Math.max(maxReadableLength, r.readableLength);
};
const timer = setInterval(sample, 20);
const server = serve({ hostname: '0.0.0.0', port: 0, fetch: async (request, bindings) => {
  const env = bindings as HttpBindings;
  if (new URL(request.url).pathname === '/__fixture_stats') {
    sample();
    return Response.json({ pid: process.pid, requests, active: active.size, maxRSS, maxReadableLength,
      rss: process.memoryUsage().rss, cpu: process.cpuUsage() });
  }
  requests++;
  const incoming = env.incoming;
  active.add(incoming);
  env.outgoing.once('close', () => active.delete(incoming));
  if (request.headers.get('x-test-probe') === 'echo') {
    return Response.json({ instance: process.env.TEST_INSTANCE, method: request.method, url: request.url,
      authorization: request.headers.get('authorization'), country: request.headers.get('x-country-code'),
      ip: request.headers.get('x-client-ip'), connection: request.headers.get('connection'),
      body: await request.text() });
  }
  if (request.headers.get('x-test-probe') === 'disconnect') {
    incoming.socket.destroy();
    return new Response(null, { status: 503 });
  }
  return app.fetch(request, env);
} });
if (!server.listening) await new Promise<void>(resolve => server.once('listening', resolve));
const addr = server.address();
if (!addr || typeof addr === 'string') throw new Error('no port');
process.send!({ port: addr.port });
process.on('message', (message: { reset?: boolean }) => {
  if (message.reset) { maxRSS = process.memoryUsage().rss; maxReadableLength = 0; }
});
process.on('SIGTERM', () => { clearInterval(timer); server.close(); process.exit(0); });
