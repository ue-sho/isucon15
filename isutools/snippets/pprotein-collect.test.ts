// node --experimental-strip-types --test isutools/snippets/pprotein-collect.test.ts
import { test } from "node:test";
import assert from "node:assert";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { triggerPproteinCollect } from "./pprotein-collect.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function startServer(handler: http.RequestListener) {
  const server = http.createServer(handler);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return { server, url: `http://127.0.0.1:${port}` };
}

test("calls collect when enabled", async (t) => {
  const paths: string[] = [];
  const { server, url } = await startServer((req, res) => {
    paths.push(req.url ?? "");
    res.end();
  });
  t.after(() => server.close());
  process.env.PPROTEIN_ENABLED = "1";
  process.env.PPROTEIN_URL = url;
  triggerPproteinCollect();
  await sleep(300);
  assert.deepStrictEqual(paths, ["/api/group/collect"]);
});

test("does nothing when PPROTEIN_ENABLED=0", async (t) => {
  let called = 0;
  const { server, url } = await startServer((_req, res) => {
    called++;
    res.end();
  });
  t.after(() => server.close());
  process.env.PPROTEIN_ENABLED = "0";
  process.env.PPROTEIN_URL = url;
  triggerPproteinCollect();
  await sleep(300);
  assert.strictEqual(called, 0);
});

test("returns synchronously even if server hangs", async (t) => {
  const { server, url } = await startServer(() => {
    /* never responds */
  });
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  process.env.PPROTEIN_ENABLED = "1";
  process.env.PPROTEIN_URL = url;
  const started = performance.now();
  const ret = triggerPproteinCollect();
  assert.strictEqual(ret, undefined);
  assert.ok(performance.now() - started < 50);
});

test("does not throw when server is unreachable", async () => {
  process.env.PPROTEIN_ENABLED = "1";
  process.env.PPROTEIN_URL = "http://127.0.0.1:1";
  assert.doesNotThrow(() => triggerPproteinCollect());
  await sleep(300);
});
