import assert from "node:assert/strict";
import { test } from "node:test";
import { Hono } from "hono";
import { apiErrorHandler } from "../src/api_error.ts";
import type { Row } from "../src/db.ts";
import { getNotificationsHandler } from "../src/notification_api.ts";
import { getMyCurrentPostHandler } from "../src/post_api.ts";
import type { Env, HandlerContext } from "../src/server.ts";

const stamp = Temporal.Instant.from("2026-10-31T02:00:00Z");
function appFor(db: object) {
  const app = new Hono<Env>();
  app.onError(apiErrorHandler);
  app.use("*", async (c, next) => {
    c.set("session", { userID: "viewer", region: "asia", token: "", tokenHash: "", createdAt: stamp });
    await next();
  });
  const h = { db } as HandlerContext;
  app.get("/current", getMyCurrentPostHandler(h));
  app.get("/notifications", getNotificationsHandler(h));
  return app;
}

for (const exists of [false, true]) {
  test(`現在投稿: ${exists ? "投稿あり" : "投稿なし"}を1往復で返す`, async () => {
    let queries = 0;
    const row: Row = {
      id: "post", author_id: "viewer", posting_window_id: "old-region-window", image_id: "image", caption: "caption", visibility: "friends",
      location_kind: "none", latitude: null, longitude: null, locality: null, posted_at: stamp, on_time_deadline: stamp, window_ended_at: stamp,
      "author.id": "viewer", "author.username": "viewer", "author.secret_key_hash": "ab".repeat(32), "author.display_name": "name",
      "author.bio": "bio", "author.profile_image_id": null, "author.region": "asia", "author.account_type": "normal", "author.status": "active",
    };
    const app = appFor({ select: async (sql: string, ...args: unknown[]) => {
      queries++;
      assert.deepEqual(args, ["viewer"]);
      assert.match(sql, /current.local_date = w.local_date/);
      assert.match(sql, /current.region = u.region/);
      // 地域移動前の終了した枠の投稿も同じlocal_dateなら返す。
      assert.doesNotMatch(sql, /w.ended_at IS NULL/);
      return exists ? [row] : [];
    } });
    const response = await app.request("/current");
    assert.equal(response.status, exists ? 200 : 404);
    const body = await response.json();
    if (exists) {
      assert.equal(body.id, "post");
      assert.equal(body.postingWindowId, "old-region-window");
      assert.equal(body.author.id, "viewer");
      assert.equal(body.onTime, true);
    } else assert.equal(body.error, "post_not_found");
    assert.equal(queries, 1);
  });
}

for (const inactive of [false, true]) {
  test(`通知: 通知なしの待機後に${inactive ? "退会・地域変更で終了" : "1件送信して終了"}`, async () => {
    let polls = 0;
    const app = appFor({ get: async (sql: string, ...args: unknown[]) => {
      return { clock_timestamp: stamp };
    }, select: async (sql: string, ...args: unknown[]) => {
      polls++;
      assert.deepEqual(args, [["viewer"], [stamp.toString()], ["asia"]]);
      assert.match(sql, /u.status = 'active' AND u.region = recipient.region/);
      assert.match(sql, /LEFT JOIN LATERAL/);
      assert.match(sql, /n.created_at > recipient.connected_at AND w.ended_at IS NULL/);
      if (polls === 1) return [{ slot: 0, user_id: "viewer", id: null }];
      if (inactive) return [{ slot: 0, user_id: null, id: null }];
      return [{ slot: 0, user_id: "viewer", id: "notification", posting_window_id: "window", region: "asia", created_at: stamp }];
    } });
    const response = await app.request("/notifications");
    assert.equal(response.headers.get("content-type"), "text/event-stream");
    const body = await response.text();
    assert.equal(polls, 2);
    assert.equal(body, inactive ? "" : `data: ${JSON.stringify({ id: "notification", postingWindowId: "window", region: "asia", createdAt: stamp.toString() })}\n\n`);
  });
}

const testPort = process.env.ROUNDTRIPS_TEST_PG_PORT;
test("実PostgreSQL: 同日投稿と通知の選別・失効", { skip: !testPort }, async (t) => {
  const { readFile } = await import("node:fs/promises");
  const { default: pg } = await import("pg");
  const { DB } = await import("../src/db.ts");
  // 実サービスの設定は読まず、新規のローカル専用DBだけで検証する。
  const config = { region: "asia", logLevel: "error", dbHost: "127.0.0.1", dbPort: testPort!, dbUser: "postgres", dbPassword: "", dbName: `isureal_roundtrips_${Date.now()}` };
  const admin = new pg.Client({ host: config.dbHost, port: Number(testPort), user: "postgres", database: "postgres" });
  await admin.connect();
  try { await admin.query(`CREATE DATABASE ${config.dbName}`); } finally { await admin.end(); }
  const client = new pg.Client({ host: config.dbHost, port: Number(testPort), user: "postgres", database: config.dbName });
  await client.connect();
  t.after(() => client.end());
  await client.query(await readFile(new URL("../../sql/001-schema.sql", import.meta.url), "utf8"));
  const db = new DB(config, 2);
  t.after(() => db.end());
  const app = appFor(db);
  await client.query("INSERT INTO users(id,username,secret_key_hash,display_name,region) VALUES ('viewer','viewer',$1,'viewer','asia')", ["ab".repeat(32)]);
  await client.query(`INSERT INTO posting_windows(id,region,local_date,starts_at,on_time_deadline,ended_at) VALUES
    ('old','europe','2026-10-31',clock_timestamp(),clock_timestamp(),clock_timestamp()),
    ('current','asia','2026-10-31',clock_timestamp(),clock_timestamp(),NULL),
    ('previous','asia','2026-10-30',clock_timestamp(),clock_timestamp(),clock_timestamp())`);
  await client.query(`INSERT INTO posts(id,author_id,posting_window_id,image_id,visibility,location_kind,posted_at) VALUES
    ('old-date','viewer','previous','image','public','none',clock_timestamp()),
    ('same-date','viewer','old','image','friends','none',clock_timestamp())`);
  const response = await app.request("/current");
  assert.equal(response.status, 200);
  assert.equal((await response.json()).id, "same-date");
  await client.query("UPDATE posts SET deleted_at=clock_timestamp() WHERE id='same-date'");
  assert.equal((await app.request("/current")).status, 404);
  await client.query(`INSERT INTO notifications(id,user_id,posting_window_id,created_at) VALUES
    ('ended','viewer','old',clock_timestamp()+interval '1 second'),
    ('stale','viewer','previous',clock_timestamp()-interval '1 minute'),
    ('fresh','viewer','current',clock_timestamp()+interval '1 second')`);
  const body = await (await app.request("/notifications")).text();
  assert.match(body, /"id":"fresh"/);
  assert.doesNotMatch(body, /ended|stale/);
  // 同じユーザーでも接続時刻ごとに判定。created_atと等しい通知は送らない。
  const fresh = await db.get<{ created_at: Temporal.Instant }>("SELECT created_at FROM notifications WHERE id='fresh'");
  let connections = 0;
  let checked!: () => void;
  const checkedBatch = new Promise<void>((resolve) => { checked = resolve; });
  const cutoffApp = appFor({
    get: async () => ({ clock_timestamp: connections++ === 0 ? fresh!.created_at : fresh!.created_at.subtract({ microseconds: 1 }) }),
    select: async (sql: string, ...args: unknown[]) => {
      const rows = await db.select(sql, ...args);
      assert.equal(rows.length, 2);
      assert.equal(rows.find((row) => row.slot === 0)!.id, null);
      assert.equal(rows.find((row) => row.slot === 1)!.id, "fresh");
      checked();
      return rows;
    },
  });
  const [atCutoff, beforeCutoff] = await Promise.all([cutoffApp.request("/notifications"), cutoffApp.request("/notifications")]);
  await checkedBatch;
  await atCutoff.body!.cancel();
  assert.match(await beforeCutoff.text(), /"id":"fresh"/);
  await client.query("UPDATE users SET region='europe' WHERE id='viewer'");
  assert.equal(await (await app.request("/notifications")).text(), "");
  await client.query("UPDATE users SET region='asia',status='deleted' WHERE id='viewer'");
  assert.equal(await (await app.request("/notifications")).text(), "");
  assert.equal((await app.request("/current")).status, 404);
});
