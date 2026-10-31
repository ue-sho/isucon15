import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import type pg from "pg";
import { notificationChannel, PoolNotificationWakeup } from "../src/notification_wakeup.ts";

test("LISTENは借用前に1回、payloadを使わず起床し、終了時にlistenerを解放する", async () => {
  const client = new EventEmitter();
  const queries: string[] = [];
  Object.assign(client, { query: async (sql: string) => { queries.push(sql); } });
  let wakes = 0;
  const listener = new PoolNotificationWakeup();
  listener.wake = () => { wakes++; };
  listener.start();
  await listener.connect(client as pg.ClientBase);
  queries.push("BEGIN");
  await listener.connect(client as pg.ClientBase);
  assert.deepEqual(queries, [`LISTEN ${notificationChannel}`, "BEGIN"]);
  await Promise.resolve();
  assert.equal(wakes, 1, "LISTEN完了後にDBの再照会を要求");
  client.emit("notification", { channel: "unrelated" });
  assert.equal(wakes, 1);
  client.emit("notification", { channel: notificationChannel, payload: "not notification data" });
  assert.equal(wakes, 2);
  listener.stop();
  client.emit("notification", { channel: notificationChannel });
  assert.equal(wakes, 2);
  listener.start();
  await listener.connect(client as pg.ClientBase);
  assert.equal(queries.length, 2, "SSE再接続でLISTENを繰り返さない");
  client.emit("end");
  assert.equal(listener.clients.size, 0);
  assert.equal(client.listenerCount("notification"), 0);
  listener.dispose();
  assert.equal(listener.disposed, true);
});

test("LISTEN失敗の再試行は新しい物理接続時のみ、指数backoff・上限30秒、成功で解除", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 100000 });
  const client = new EventEmitter();
  let attempts = 0;
  let fail = true;
  Object.assign(client, { query: async () => { attempts++; if (fail) throw new Error("synthetic LISTEN failure"); } });
  const listener = new PoolNotificationWakeup();
  listener.start();
  for (const delay of [250, 500, 1000, 2000, 4000, 8000, 16000, 30000, 30000]) {
    const before = attempts;
    await listener.connect(client as pg.ClientBase);
    assert.equal(attempts, before + 1);
    assert.equal(listener.retryAt - Date.now(), delay);
    await listener.connect(client as pg.ClientBase);
    assert.equal(attempts, before + 1);
    assert.equal(client.listenerCount("notification"), 0);
    t.mock.timers.tick(delay);
  }
  fail = false;
  await listener.connect(client as pg.ClientBase);
  assert.equal(listener.retryDelay, 250);
  assert.equal(listener.retryAt, 0);
  listener.dispose();
  assert.equal(client.listenerCount("end"), 0);
  assert.equal(client.listenerCount("notification"), 0);
});
