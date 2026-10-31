import assert from "node:assert/strict";
import crypto from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import { test } from "node:test";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { apiErrorHandler } from "../src/api_error.ts";
import type { DB } from "../src/db.ts";
import { initializeHandler } from "../src/initialize.ts";
import type { Env, HandlerContext } from "../src/server.ts";
import { newServer } from "../src/server.ts";
import { sha256Hex } from "../src/session.ts";
import { registerHandler, updateMeHandler } from "../src/user_api.ts";
import { searchUsersHandler } from "../src/user_read_api.ts";
import { backfillUserSearch, normalizeSearchText } from "../src/user_search.ts";
import { legacySearch, searchApp, searchDatabase, searchFixture, sqlFile } from "./helpers/user-search.ts";

test("検索正規化の既存Unicode変換を維持", () => {
  for (const [source, expected] of [["Straße", "strasse"], ["ẞ", "ß"], ["Cafe\u0301", "café"], ["Σςσ", "σσς"], ["ﬃ", "ffi"], ["カ\u3099", "ガ"]]) {
    assert.equal(normalizeSearchText(source!), expected);
  }
});

const port = process.env.SEARCH_TEST_PG_PORT;
test("PG16: 旧検索との等価性・保存・reset・同時実行", { skip: !port }, async (t) => {
  const f = await searchDatabase(port!);
  t.after(() => f.close());
  assert.equal((await f.admin.query("SELECT count(*) FROM pg_tables WHERE schemaname='public'")).rows[0].count, "0", "requires a fresh dedicated local DB");
  // Exercise migration from the old schema, not only the new schema file.
  const schema = (await sqlFile("001-schema.sql")).replace(/^  search_(username|display_name) text COLLATE "C",\n/gm, "");
  await f.admin.query(schema);
  await f.admin.query(await sqlFile("003-initial-snapshot.sql"));
  const up = await sqlFile("migrations/20261031-user-search.up.sql");
  await f.admin.query(up); await f.admin.query(up);
  await searchFixture(f.admin, f.db);
  const legacy = await legacySearch();
  t.after(() => legacy.close());
  t.mock.method(Temporal.Now, "instant", () => Temporal.Instant.from("2026-10-31T00:00:00Z"));
  const old = searchApp(legacy.handler, f.db, legacy.errorHandler);
  const current = searchApp(searchUsersHandler, f.db);
  await t.test("検索語とcursorの検証エラーも旧版と一致", async () => {
    for (const path of ["/api/users", "/api/users?q=" + "a".repeat(101), "/api/users?q=a&beforeUsername=name", "/api/users?q=a&beforeId=id"]) {
      const expected = await old.request(path), actual = await current.request(path);
      assert.equal(actual.status, 400); assert.equal(actual.status, expected.status);
      assert.deepEqual(await actual.json(), await expected.json());
    }
  });
  async function request(app: Hono<Env>, q: string, cursor?: { username: string; id: string }) {
    const params = new URLSearchParams({ q });
    if (cursor) { params.set("beforeUsername", cursor.username); params.set("beforeId", cursor.id); }
    const response = await app.request("/api/users?" + params);
    assert.equal(response.status, 200, await response.clone().text());
    return response.json() as Promise<{ items: any[]; hasMore: boolean }>;
  }
  for (const q of ["never-match", "n49", "n50", "n51", "common", "café", "CAFE\u0301", "Å", "SS", "ß", "ẞ", "ﬃ", "ffi", "Σ", "ς", "ΟΣ", "İ", "ı", "ガ", "は\u309a", "😀", "𐐨", "%", "_", "\\", "a:b|c", "空 白", "username_token", "bc", "\0"]) {
    await t.test(`旧版JSON・全ページ一致: ${JSON.stringify(q)}`, async () => {
      let cursor;
      const seen = new Set<string>();
      do {
        const expected = await request(old, q, cursor);
        const actual = await request(current, q, cursor);
        assert.deepEqual(actual, expected);
        for (const item of actual.items) { assert.ok(!seen.has(item.id)); seen.add(item.id); }
        if (!actual.hasMore) break;
        assert.equal(actual.items.length, 50);
        cursor = actual.items.at(-1);
      } while (true);
      const count = ({ "never-match": 0, n49: 49, n50: 50, n51: 51, username_token: 2, bc: 0 } as Record<string, number>)[q];
      if (count !== undefined) assert.equal(seen.size, count);
    });
  }
  await t.test("51件目は署名しない・bio公開条件とブロックを維持", async () => {
    await f.admin.query("UPDATE users SET profile_image_id='profile-'||id WHERE id LIKE 'u-%'");
    const original = crypto.hash;
    let calls = 0;
    crypto.hash = ((...args: Parameters<typeof crypto.hash>) => { calls++; return original(...args); }) as typeof crypto.hash;
    syncBuiltinESMExports();
    try {
      const body = await request(current, "n51");
      assert.equal(body.items.length, 50); assert.equal(body.hasMore, true);
      assert.equal(calls, 50 * 2000);
      assert.equal(body.items.find((u) => u.id === "u-000001").bio, "", "friendship does not expose bio in search");
      assert.notEqual(body.items.find((u) => u.id === "u-000002").bio, "");
      assert.deepEqual(body, await request(old, "n51"));
    } finally { crypto.hash = original; syncBuiltinESMExports(); }
    await f.admin.query("UPDATE users SET profile_image_id=NULL");
  });
  await t.test("DB返却は最大51行・1 SQL、generic planでもcursorを維持", async () => {
    let calls = 0;
    const wrapped = { select: async <T>(sql: string, ...args: unknown[]) => {
      const rows = await f.db.select<T>(sql, ...args);
      calls++; assert.ok(rows.length <= 51); return rows;
    } } as DB;
    assert.deepEqual(await request(searchApp(searchUsersHandler, wrapped), "common"), await request(old, "common"));
    assert.equal(calls, 1);
    await using tx = await f.db.begin();
    await tx.exec("SET LOCAL plan_cache_mode=force_generic_plan");
    const page = await request(current, "common");
    const cursor = page.items.at(-1);
    assert.deepEqual(await request(searchApp(searchUsersHandler, tx as unknown as DB), "common", cursor), await request(old, "common", cursor));
  });

  function writes(db = f.db, userID = "u-000001") {
    const app = new Hono<Env>().onError(apiErrorHandler);
    app.use("*", async (c, next) => { c.set("session", { userID, region: "asia", token: "", tokenHash: "", createdAt: Temporal.Now.instant() }); await next(); });
    app.post("/register", registerHandler({ db } as HandlerContext));
    app.patch("/me", updateMeHandler({ db } as HandlerContext));
    return app;
  }
  async function write(app: Hono<Env>, path: string, body: unknown, method = "PATCH") {
    const text = JSON.stringify(body);
    return app.request(path, { method, headers: { "Content-Type": "application/json", "Content-Length": String(Buffer.byteLength(text)) }, body: text });
  }
  await t.test("登録と表示名変更直後に検索可能・bioのみ更新で検索値を保持", async () => {
    const registered = await write(writes(), "/register", { username: "new_user", displayName: "新規 Straße", region: "asia" }, "POST");
    assert.equal(registered.status, 201);
    assert.equal((await request(current, "新規 STRASSE")).items.length, 1);
    assert.equal((await request(current, "new_user")).items.length, 1);
    const updated = await write(writes(), "/me", { displayName: "変更 Cafe\u0301 %_" });
    assert.equal(updated.status, 200);
    assert.equal((await request(current, "変更 CAFÉ %_")).items[0].id, "u-000001");
    assert.equal((await request(current, "n49")).items.length, 48);
    assert.equal((await write(writes(), "/me", { bio: "different" })).status, 200);
    assert.equal((await request(current, "変更 CAFÉ %_")).items.length, 1);
  });

  function gate() { let release!: () => void; const promise = new Promise<void>((resolve) => { release = resolve; }); return { promise, release }; }
  await t.test("表示名と検索値は同じcommitで見える・未commit検索は旧値", async () => {
    const reached = gate(), resume = gate();
    const wrapped = { begin: async () => {
      const tx = await f.db.begin();
      const get = tx.get.bind(tx);
      tx.get = async <T>(sql: string, ...args: unknown[]) => {
        const row = await get<T>(sql, ...args);
        if (sql.startsWith("UPDATE users SET")) { reached.release(); await resume.promise; }
        return row;
      };
      return tx;
    } } as DB;
    const pending = write(writes(wrapped), "/me", { displayName: "並行 STRASSE" });
    try {
      await reached.promise;
      assert.equal((await request(current, "並行 strasse")).items.length, 0);
      assert.equal((await request(current, "変更 CAFÉ %_")).items.length, 1);
    } finally { resume.release(); }
    assert.equal((await pending).status, 200);
    assert.equal((await request(current, "並行 strasse")).items.length, 1);
    assert.equal((await request(current, "変更 CAFÉ %_")).items.length, 0);
  });
  await t.test("バックフィルの読取後に来た更新を失わない", async () => {
    const reached = gate(), resume = gate();
    const wrapped = { begin: async () => {
      const tx = await f.db.begin(); const select = tx.select.bind(tx);
      tx.select = async <T>(sql: string, ...args: unknown[]) => {
        const rows = await select<T>(sql, ...args);
        if (sql.endsWith("FROM users")) { reached.release(); await resume.promise; }
        return rows;
      }; return tx;
    } } as DB;
    const filling = backfillUserSearch(wrapped);
    await reached.promise;
    const pending = write(writes(), "/me", { displayName: "backfill 後着" });
    try {
      const until = Date.now() + 3000;
      while (true) {
        const waiting = await f.admin.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'UPDATE users SET%'");
        if (waiting.rowCount) break;
        assert.ok(Date.now() < until, "profile writer must wait for backfill lock");
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    } finally { resume.release(); }
    await filling; assert.equal((await pending).status, 200);
    assert.equal((await request(current, "backfill 後着")).items.length, 1);
  });
  await t.test("同じユーザーへの並行更新は行ロック順に検索値も上書き・rollbackで残さない", async () => {
    await using tx = await f.db.begin();
    await tx.exec("UPDATE users SET display_name=$2,search_display_name=$3 WHERE id=$1", "u-000001", "first Straße", normalizeSearchText("first Straße"));
    const pending = write(writes(), "/me", { displayName: "second Café" });
    const until = Date.now() + 3000;
    try {
      while (true) {
        const waiting = await f.admin.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'UPDATE users SET%'");
        if (waiting.rowCount) break;
        assert.ok(Date.now() < until, "second update must wait for the first row lock");
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.notEqual((await f.admin.query("SELECT search_display_name FROM users WHERE id='u-000001'")).rows[0].search_display_name, normalizeSearchText("first Straße"));
    } finally { await tx.commit(); }
    assert.equal((await pending).status, 200);
    assert.equal((await request(current, "first strasse")).items.length, 0);
    assert.equal((await request(current, "second cafe\u0301")).items.length, 1);
    await using rolledBack = await f.db.begin();
    await rolledBack.exec("UPDATE users SET display_name=$2,search_display_name=$3 WHERE id=$1", "u-000001", "rollback Straße", normalizeSearchText("rollback Straße"));
    await rolledBack.rollback();
    assert.equal((await request(current, "rollback strasse")).items.length, 0);
    assert.equal((await request(current, "second café")).items.length, 1);
  });
  await t.test("実reset.sqlのreplicaモードで初期値を復元し再実行できる", async () => {
    await backfillUserSearch(f.db);
    await f.admin.query(await sqlFile("reset.sql"));
    assert.equal((await request(current, "new_user")).items.length, 0);
    assert.equal((await request(current, "backfill 後着")).items.length, 0);
    assert.deepEqual(await request(current, "n49"), await request(old, "n49"));
    assert.equal((await request(current, "n49")).items.length, 49);
    // Repair derived values even if original profile columns have not changed.
    await f.admin.query("UPDATE users SET search_display_name='corrupt' WHERE id='u-000001'");
    await f.admin.query(await sqlFile("reset.sql"));
    assert.equal((await request(current, "n49")).items.length, 49);
    await f.admin.query("SET session_replication_role=origin");
  });
  await t.test("実session/地域middleware: 認証・地域拒否と検索を維持", async () => {
    await f.admin.query("INSERT INTO login_sessions(id,user_id,token_hash) VALUES('viewer','viewer',$1)", [sha256Hex("viewer")]);
    // Keep ownership of the DB created by newServer so the test can close it.
    const { DB: Database } = await import("../src/db.ts");
    const ping = Database.prototype.ping; const opened: DB[] = [];
    const mock = t.mock.method(Database.prototype, "ping", async function(this: DB) { opened.push(this); await ping.call(this); });
    try {
      const asia = await newServer(f.config, 1);
      const europe = await newServer({ ...f.config, region: "europe" }, 1);
      async function listen(app: Hono<Env>) {
        const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
        if (!server.listening) await new Promise<void>((resolve) => server.once("listening", resolve));
        t.after(() => new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve())));
        const address = server.address(); assert.ok(address && typeof address !== "string");
        return `http://127.0.0.1:${address.port}`;
      }
      const asiaURL = await listen(asia), europeURL = await listen(europe);
      const headers = { Authorization: "Bearer viewer", "X-Client-IP": "203.0.113.1" };
      assert.equal((await fetch(asiaURL + "/api/users?q=n49", { headers })).status, 200);
      assert.equal((await fetch(europeURL + "/api/users?q=n49", { headers })).status, 403);
      assert.equal((await fetch(asiaURL + "/api/users?q=n49")).status, 401);
    } finally { mock.mock.restore(); await Promise.all(opened.map((db) => db.end())); }
  });
  await t.test("initializeハンドラーから実init.shとresetを実行", { skip: !process.env.SEARCH_TEST_PSQL_DIR }, async () => {
    const saved = process.env.PATH;
    process.env.PATH = process.env.SEARCH_TEST_PSQL_DIR + ":" + saved;
    try {
      assert.equal((await write(writes(), "/me", { displayName: "initialize changed" })).status, 200);
      await f.admin.query("UPDATE initial_users SET search_display_name=NULL");
      const app = new Hono<Env>().onError(apiErrorHandler).post("/api/initialize", initializeHandler({ db: f.db } as HandlerContext));
      assert.equal((await app.request("/api/initialize", { method: "POST" })).status, 200);
      assert.equal((await request(current, "n49")).items.length, 49);
      assert.equal((await request(current, "initialize changed")).items.length, 0);
    } finally { process.env.PATH = saved; }
  });
});
