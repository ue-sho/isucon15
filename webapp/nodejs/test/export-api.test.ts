import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { Hono } from "hono";
import JSZip from "jszip";
import pg from "pg";
import { apiErrorHandler } from "../src/api_error.ts";
import { DB } from "../src/db.ts";
import { exportPostsHandler } from "../src/export_api.ts";
import { regionMiddleware } from "../src/region.ts";
import { sessionMiddleware, sha256Hex } from "../src/session.ts";
import type { Env, HandlerContext } from "../src/server.ts";
import { referenceExportHandler } from "./helpers/export-reference.ts";

const port = Number(process.env.EXPORT_TEST_PG_PORT);
test("export: 実PGのZIP・JSON・画像バイトと認証/地域/更新を従来実装と比較", { skip: !port }, async (t) => {
  assert.ok(port > 0 && port < 65536);
  const config = { region: "asia", logLevel: "error", dbHost: "127.0.0.1", dbPort: String(port), dbUser: "postgres", dbPassword: "", dbName: `export_api_${Date.now()}` };
  const admin = new pg.Client({ host: "127.0.0.1", port, user: "postgres", database: "postgres" });
  await admin.connect();
  try { await admin.query(`CREATE DATABASE ${config.dbName}`); } finally { await admin.end(); }
  const client = new pg.Client({ host: "127.0.0.1", port, user: "postgres", database: config.dbName });
  await client.connect();
  t.after(() => client.end());
  await client.query(await readFile(new URL("../../sql/001-schema.sql", import.meta.url), "utf8"));
  const db = new DB(config, 2);
  t.after(() => db.end());
  const h = { db, config } as HandlerContext;
  const app = new Hono<Env>();
  app.onError(apiErrorHandler);
  app.use(sessionMiddleware(h, true), regionMiddleware(h));
  app.get("/new", exportPostsHandler(h));
  app.get("/old", referenceExportHandler(h));
  const stamp = Temporal.Instant.from("2026-10-31T05:07:22Z");
  t.mock.method(Temporal.Now, "instant", () => stamp);
  for (const id of ["viewer", "other"]) {
    await client.query("INSERT INTO users(id,username,secret_key_hash,display_name,region,bio) VALUES($1,$1,$2,'日本語<&>','asia','bio')", [id, "ab".repeat(32)]);
    await client.query("INSERT INTO login_sessions(id,user_id,token_hash) VALUES($1,$1,$2)", [id, sha256Hex(id)]);
  }
  await client.query(`INSERT INTO posting_windows(id,region,local_date,starts_at,on_time_deadline,ended_at) VALUES
    ('old','asia','2025-01-01','2025-01-01','2025-01-01 00:01:00','2025-01-02'),
    ('recent','asia','2026-10-31','2026-10-31','2026-10-31 00:01:00',NULL)`);
  const headers = { Authorization: "Bearer viewer" };
  async function compare(expectedCount: number) {
    const [oldResponse, newResponse] = await Promise.all([app.request("/old", { headers }), app.request("/new", { headers })]);
    assert.equal(newResponse.status, 200);
    assert.equal(oldResponse.status, 200);
    for (const header of ["content-type", "content-disposition", "cache-control"]) assert.equal(newResponse.headers.get(header), oldResponse.headers.get(header));
    assert.equal(newResponse.headers.get("cache-control"), "no-store");
    const oldZip = await JSZip.loadAsync(await oldResponse.arrayBuffer(), { checkCRC32: true });
    const newZip = await JSZip.loadAsync(await newResponse.arrayBuffer(), { checkCRC32: true });
    assert.deepEqual(Object.keys(newZip.files), Object.keys(oldZip.files));
    for (const name of Object.keys(oldZip.files)) assert.deepEqual(await newZip.file(name)!.async("nodebuffer"), await oldZip.file(name)!.async("nodebuffer"), name);
    const items = JSON.parse(await newZip.file("posts.json")!.async("string"));
    assert.equal(items.length, expectedCount);
    assert.equal(Object.keys(newZip.files).length, expectedCount + 1);
    items.forEach((item: { imagePath: string }, index: number) => assert.equal(item.imagePath, `images/${String(index + 1).padStart(6, "0")}.jpg`));
    return { items, zip: newZip };
  }
  await t.test("0件もposts.jsonが空配列のZIPを返す", async () => { await compare(0); });
  const bytes = new Map<string, Buffer>();
  for (let i = 0; i < 64; i++) {
    const id = String(i).padStart(3, "0");
    const data = Buffer.from(Array.from({ length: [0, 1, 2, 3, 57, 58, 59, 256, 65537][i % 9]! }, (_, n) => n % 256));
    bytes.set(`post-${id}`, data);
    const old = i % 2 === 0;
    const postedAt = old ? "2025-01-01T00:00:00.123456Z" : "2026-10-31T00:02:00.123456Z";
    await client.query("INSERT INTO image_objects(id,owner_user_id,data,media_type,created_at) VALUES($1,'viewer',$2,'image/jpeg',$3)", [`image-${id}`, data, postedAt]);
    await client.query(`INSERT INTO posts(id,author_id,posting_window_id,image_id,caption,visibility,location_kind,latitude,longitude,locality,posted_at)
      VALUES($1,'viewer',$2,$3,$4,$5,'locality',35.12345,139.12345,'東京',$6)`, [`post-${id}`, old ? "old" : "recent", `image-${id}`, "caption<&>\u2028\u2029日本語", old ? "friends" : "public", postedAt]);
  }
  await client.query("UPDATE users SET profile_image_id='image-001' WHERE id='viewer'");
  await client.query("INSERT INTO posts(id,author_id,posting_window_id,image_id,visibility,location_kind,posted_at) VALUES('foreign','other','old','image-000','public','none','2025-01-01'),('missing','viewer','old','missing-image','public','none','2025-01-01')");
  await t.test("50件を超える履歴・全バイト値・base64改行・padding・順序・署名を維持", async () => {
    const { items, zip } = await compare(64);
    const expected = [...bytes.keys()].sort((a, b) => Number(a.slice(-3)) % 2 - Number(b.slice(-3)) % 2 || a.localeCompare(b));
    assert.deepEqual(items.map((p: { id: string }) => p.id), expected);
    for (const item of items) assert.deepEqual(await zip.file(item.imagePath)!.async("nodebuffer"), bytes.get(item.id));
    assert.equal(items[0].postedAt, "2025-01-01T00:00:00.123456Z");
    assert.equal(items[0].onTime, true);
    assert.equal(items.at(-1).onTime, false);
  });
  await t.test("削除・caption変更・画像更新を次の応答へ反映", async () => {
    await client.query("UPDATE posts SET deleted_at=clock_timestamp() WHERE id='post-000'");
    await client.query("UPDATE posts SET caption='changed' WHERE id='post-001'");
    const changed = Buffer.from([255, 0, 128, 13, 10, 1]);
    await client.query("UPDATE image_objects SET data=$1 WHERE id='image-001'", [changed]);
    const { items, zip } = await compare(63);
    const item = items.find((p: { id: string }) => p.id === "post-001");
    assert.equal(item.caption, "changed");
    assert.deepEqual(await zip.file(item.imagePath)!.async("nodebuffer"), changed);
    assert.ok(!items.some((p: { id: string }) => p.id === "post-000"));
  });
  await t.test("認証失効・退会・地域不一致は従来どおり拒否", async () => {
    assert.equal((await app.request("/new")).status, 401);
    await client.query("UPDATE users SET region='europe' WHERE id='viewer'");
    assert.equal((await app.request("/new", { headers })).status, 403);
    await client.query("UPDATE users SET region='asia',status='deleted' WHERE id='viewer'");
    assert.equal((await app.request("/new", { headers })).status, 401);
    await client.query("UPDATE users SET status='active' WHERE id='viewer'");
    await client.query("UPDATE login_sessions SET active=false WHERE user_id='viewer'");
    assert.equal((await app.request("/new", { headers })).status, 401);
  });
  await t.test("別接続とデータ再作成後も以前の画像を再利用しない", async () => {
    await client.query("UPDATE login_sessions SET active=true WHERE user_id='viewer'");
    await client.query("DELETE FROM posts");
    await client.query("UPDATE users SET profile_image_id=NULL");
    await client.query("DELETE FROM image_objects");
    await compare(0);
    await client.query("INSERT INTO image_objects(id,owner_user_id,data,media_type,created_at) VALUES('image-000','viewer',$1,'image/jpeg','2026-10-31')", [Buffer.from([1, 2, 3])]);
    await client.query("INSERT INTO posts(id,author_id,posting_window_id,image_id,visibility,location_kind,posted_at) VALUES('post-000','viewer','recent','image-000','public','none','2026-10-31')");
    const { zip } = await compare(1);
    assert.deepEqual(await zip.file("images/000001.jpg")!.async("nodebuffer"), Buffer.from([1, 2, 3]));
  });
});
