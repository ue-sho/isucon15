import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";
import { Hono } from "hono";
import { getNotificationsHandler } from "../src/notification_api.ts";
import type { Env, HandlerContext } from "../src/server.ts";

const stamp = Temporal.Instant.from("2026-10-31T02:00:00Z");
function setup(select: (sql: string, users: string[], times: string[], regions: string[]) => Promise<object[]>) {
  const db = { get: async () => ({ clock_timestamp: stamp }), select };
  const app = new Hono<Env>();
  app.use("*", async (c, next) => {
    c.set("session", { userID: c.req.header("user") ?? "viewer", region: "asia", token: "", tokenHash: "", createdAt: stamp });
    await next();
  });
  app.get("/", getNotificationsHandler({ db } as unknown as HandlerContext));
  return app;
}
function notification(slot: number, user: string) {
  return { slot, user_id: user, id: `notification-${user}`, posting_window_id: "window", region: "asia", created_at: stamp };
}

for (const connections of [100, 257]) {
  test(`${connections}接続を256件以下のバッチにまとめ、1件送信後にpollを停止する`, async () => {
    let queries = 0;
    let recipients = 0;
    const app = setup(async (_sql, users, times, regions) => {
      queries++;
      recipients += users.length;
      assert.ok(users.length <= 256);
      assert.deepEqual(times, users.map(() => stamp.toString()));
      assert.deepEqual(regions, users.map(() => "asia"));
      return users.map((user, slot) => notification(slot, user));
    });
    const responses = await Promise.all(Array.from({ length: connections }, (_, i) => app.request("/", { headers: { user: `user-${i}` } })));
    const bodies = await Promise.all(responses.map((response) => response.text()));
    for (let i = 0; i < connections; i++) assert.match(bodies[i], new RegExp(`"id":"notification-user-${i}"`));
    assert.equal(recipients, connections);
    assert.equal(queries, Math.ceil(connections / 256));
    await sleep(550);
    assert.equal(queries, Math.ceil(connections / 256));
  });
}

test("同一ユーザーの複数接続も独立して配信する", async () => {
  const app = setup(async (_sql, users) => users.map((user, slot) => notification(slot, user)));
  const responses = await Promise.all([app.request("/"), app.request("/")]);
  for (const response of responses) assert.match(await response.text(), /notification-viewer/);
});

test("遅いSQL中に追加・切断された接続を扱い、pollを重ねない", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let started!: () => void;
  const starting = new Promise<void>((resolve) => { started = resolve; });
  let queries = 0;
  let running = 0;
  const app = setup(async (_sql, users) => {
    assert.equal(++running, 1);
    queries++;
    if (queries === 1) { started(); await gate; }
    running--;
    return users.map((user, slot) => notification(slot, user));
  });
  const abort = new AbortController();
  const first = await app.request("/", { signal: abort.signal });
  await starting;
  const second = await app.request("/", { headers: { user: "second" } });
  const cancelled = await app.request("/", { headers: { user: "cancelled" } });
  await cancelled.body!.cancel();
  abort.abort();
  assert.equal(await first.text(), "");
  await sleep(550);
  assert.equal(queries, 1);
  release();
  assert.match(await second.text(), /notification-second/);
  assert.equal(queries, 2);
});

test("待機中の接続がすべて切断されたらpollを止める", async () => {
  let queries = 0;
  let polled!: () => void;
  const ready = new Promise<void>((resolve) => { polled = resolve; });
  const app = setup(async (_sql, users) => {
    queries++;
    polled();
    return users.map((user, slot) => ({ slot, user_id: user, id: null }));
  });
  const response = await app.request("/");
  await ready;
  await response.body!.cancel();
  await sleep(550);
  assert.equal(queries, 1);
});
