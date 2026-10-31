import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { serve } from "@hono/node-server";
import jpeg from "jpeg-js";
import pg from "pg";
import { DB } from "../src/db.ts";
import { newServer } from "../src/server.ts";
import { sha256Hex } from "../src/session.ts";

// ローカルの新規テストDBのみ。実サービスの設定を読まない。
const port = process.env.REGIONAL_API_TEST_PG_PORT;
test("地域別アプリの投稿と共有DBの即時反映", { skip: !port }, async (t) => {
  const config = { region: "asia", logLevel: "error", dbHost: "127.0.0.1", dbPort: port!, dbUser: "postgres", dbPassword: "", dbName: "isureal_regional_api_test" };
  const admin = new pg.Client({ host: config.dbHost, port: Number(port), user: config.dbUser, database: config.dbName });
  await admin.connect();
  t.after(() => admin.end());
  assert.equal((await admin.query("SELECT count(*) FROM pg_tables WHERE schemaname='public'")).rows[0].count, "0", "requires a new disposable DB");
  await admin.query(await readFile(new URL("../../sql/001-schema.sql", import.meta.url), "utf8"));
  for (const region of ["asia", "europe", "america"]) {
    await admin.query("INSERT INTO users(id,username,secret_key_hash,display_name,region) VALUES ($1::text,$1::text,$2::text,$1::text,$3::text),($4::text,$4::text,$2::text,$4::text,$3::text)", [region, "ab".repeat(32), region, region + "-friend"]);
    await admin.query("INSERT INTO login_sessions(id,user_id,token_hash) VALUES($1::text,$1::text,$2::text),($3::text,$3::text,$4::text)", [region, sha256Hex(region), region + "-friend", sha256Hex(region + "-friend")]);
    await admin.query("INSERT INTO friendships(id,user_low_id,user_high_id) VALUES($1::text,$1::text,$2::text)", [region, region + "-friend"]);
    await admin.query("INSERT INTO posting_windows(id,region,local_date,starts_at,on_time_deadline) VALUES($1::text,$1::text,'2026-10-31',clock_timestamp()-interval '1 minute',clock_timestamp()+interval '1 hour')", [region]);
  }
  const databases: DB[] = [];
  const ping = DB.prototype.ping;
  t.mock.method(DB.prototype, "ping", async function(this: DB) { databases.push(this); await ping.call(this); });
  t.after(async () => { await Promise.all(databases.map((db) => db.end())); });
  const servers: ReturnType<typeof serve>[] = [];
  const urls = new Map<string, string>();
  for (const region of ["asia", "europe", "america"]) {
    const app = await newServer({ ...config, region }, 2);
    const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
    servers.push(server);
    if (!server.listening) await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    urls.set(region, `http://127.0.0.1:${address.port}`);
  }
  t.after(async () => { await Promise.all(servers.map((s) => new Promise<void>((resolve, reject) => s.close((err) => err ? reject(err) : resolve())))); });
  const image = jpeg.encode({ data: Buffer.from([255, 0, 0, 255]), width: 1, height: 1 }, 80).data;
  async function post(region: string, user: string) {
    const body = new FormData();
    body.set("image", new Blob([new Uint8Array(image)], { type: "image/jpeg" }), "fixture.jpg");
    body.set("caption", "fixture"); body.set("visibility", "friends"); body.set("location_kind", "none");
    return fetch(urls.get(region)! + "/api/posts", { method: "POST", headers: { Authorization: `Bearer ${user}`, "X-Client-IP": "203.0.113.1" }, body });
  }
  for (const region of ["europe", "america"]) {
    const created = await post(region, region);
    assert.equal(created.status, 201, await created.clone().text());
    const item = await created.json();
    assert.equal(item.postingWindowId, region);
    assert.equal((await post(region, region)).status, 409);
    assert.equal((await post("asia", region)).status, 403);
    assert.equal((await post(region, region + "-friend")).status, 201);
    const headers = { Authorization: `Bearer ${region}-friend`, "X-Client-IP": "203.0.113.2" };
    const response = await fetch(urls.get(region)! + "/api/feeds/friends", { headers });
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).items.map((i: any) => i.id), [item.id]);
    const current = await fetch(urls.get(region)! + "/api/posting-window/current", { headers });
    const state = await current.json();
    assert.equal(state.window.region, region);
    assert.equal(state.hasPosted, true);
    const mine = await fetch(urls.get(region)! + "/api/posts/me/current", { headers });
    assert.equal(mine.status, 200);
    assert.equal((await mine.json()).author.id, region + "-friend");
    // 別アプリ側でのブロック書込成功後、転送先のフィードでも直ちに反映する。
    await admin.query("INSERT INTO block_relations(id,blocker_id,blocked_id) VALUES($1::text,$1::text,$2::text)", [region, region + "-friend"]);
    const blocked = await fetch(urls.get(region)! + "/api/feeds/friends", { headers });
    assert.deepEqual((await blocked.json()).items, []);
  }
});
