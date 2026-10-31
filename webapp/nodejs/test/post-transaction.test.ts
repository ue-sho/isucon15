import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test, type TestContext } from "node:test";
import { promisify } from "node:util";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import jpeg from "jpeg-js";
import pg from "pg";
import { apiErrorHandler } from "../src/api_error.ts";
import type { Config } from "../src/config.ts";
import { DB } from "../src/db.ts";
import { IPBanList } from "../src/ip_ban.ts";
import { createPostHandler, deletePostHandler } from "../src/post_api.ts";
import { postTransactionSignature } from "../src/post_transaction.ts";
import { newServer, type Env } from "../src/server.ts";
import { sha256Hex } from "../src/session.ts";
import { delayedTCP } from "./helpers/delayed-tcp.ts";

const enabled = process.env.POST_TRANSACTION_TEST === "1";
const docker = promisify(execFile);
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const rpcSQL = `SELECT public.isureal_create_post_v1($1::text,$2::text,$3::text,$4::bytea,$5::text,
  $6::text,$7::text,$8::numeric,$9::numeric,$10::text) AS result`;

test("post transaction / isolated PostgreSQL 16", { skip: !enabled, timeout: 120000 }, async (t) => {
  const container = `isucon15-post-rpc-${randomUUID()}`;
  let admin: pg.Client | undefined;
  await docker("docker", ["run", "--detach", "--rm", "--name", container,
    "--label", "isucon15.test=post-transaction", "--publish", "127.0.0.1::5432",
    "--tmpfs", "/var/lib/postgresql/data", "--env", "POSTGRES_HOST_AUTH_METHOD=trust",
    "--env", "POSTGRES_DB=post_rpc_test", "postgres:16", "-c", "statement_timeout=5000"], { timeout: 20000 });
  t.after(async () => { await admin?.end(); await docker("docker", ["stop", "--time", "1", container], { timeout: 10000 }); });
  const { stdout: binding } = await docker("docker", ["port", container, "5432/tcp"]);
  const port = Number(binding.trim().split(":").at(-1));
  const connection = { host: "127.0.0.1", port, user: "postgres", database: "post_rpc_test" };
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    const probe = new pg.Client(connection);
    try { await probe.connect(); ready = true; } catch { /* isolated PG is starting */ }
    finally { await probe.end(); }
    if (ready) break;
    await sleep(100);
  }
  assert.ok(ready);
  admin = new pg.Client(connection);
  await admin.connect();
  const version = (await admin.query("SHOW server_version")).rows[0].server_version;
  assert.match(version, /^16\./);
  const schema = await readFile(new URL("../../sql/001-schema.sql", import.meta.url), "utf8");
  const up = await readFile(new URL("../../sql/migrations/20261031-post-transaction.up.sql", import.meta.url), "utf8");
  const down = await readFile(new URL("../../sql/migrations/20261031-post-transaction.down.sql", import.meta.url), "utf8");
  const image = Buffer.from(jpeg.encode({ data: Buffer.from([40, 80, 120, 255]), width: 1, height: 1 }, 80).data);
  let number = 0;

  async function fixture(st: TestContext, rtt = 0) {
    const database = `post_rpc_${++number}`;
    await admin!.query(`CREATE DATABASE ${database}`);
    const clients: pg.Client[] = [];
    async function client(user = connection.user) {
      const c = new pg.Client({ ...connection, database, user });
      await c.connect(); clients.push(c); return c;
    }
    const control = await client();
    await control.query(schema);
    assert.equal((await control.query("SELECT to_regprocedure($1) AS function", [postTransactionSignature])).rows[0].function, null);
    await control.query(up);
    const config: Config = { region: "asia", dbHost: "127.0.0.1", dbPort: String(port), dbUser: "postgres",
      dbPassword: "", dbName: database, logLevel: "error" };
    const proxy = rtt ? await delayedTCP(port, rtt) : undefined;
    const db = new DB({ ...config, dbPort: String(proxy?.port ?? port) }, 8);
    let rpcCalls = 0;
    const get = db.get.bind(db);
    db.get = (async (...args: Parameters<DB["get"]>) => {
      if (args[0].includes("isureal_create_post_v1")) rpcCalls++;
      return get(...args);
    }) as DB["get"];
    const makeApp = (rpc: boolean) => {
      const app = new Hono<Env>();
      app.onError(apiErrorHandler);
      app.use(async (c, next) => {
        c.set("session", { userID: c.req.header("x-test-user") ?? "alice", region: "asia", token: "test",
          tokenHash: "test", createdAt: Temporal.Now.instant() });
        await next();
      });
      const context = { db, config, ipBans: new IPBanList(), postTransaction: rpc };
      app.post("/api/posts", createPostHandler(context));
      app.delete("/api/posts/:postId", deletePostHandler(context));
      return app;
    };
    const apps = [makeApp(false), makeApp(true)];
    await control.query(`INSERT INTO users(id,username,secret_key_hash,display_name,region) VALUES
      ('alice','alice',repeat('0',64),'Alice','asia'),('bob','bob',repeat('0',64),'Bob','asia')`);
    await control.query(`INSERT INTO posting_windows(id,region,local_date,starts_at,on_time_deadline) VALUES
      ('asia-old','asia','2026-10-31',clock_timestamp()-interval '1 hour',clock_timestamp()+interval '1 hour'),
      ('europe-old','europe','2026-10-31',clock_timestamp()-interval '1 hour',clock_timestamp()+interval '1 hour')`);
    const pending: Promise<unknown>[] = [];
    st.after(async () => {
      // Release test-only gates before waiting for outstanding statements.
      for (const c of clients) {
        await c.query("ROLLBACK").catch(() => {});
        await c.query("SELECT pg_advisory_unlock_all()").catch(() => {});
      }
      await Promise.allSettled(pending);
      await db.end(); await proxy?.close();
      for (const c of clients) await c.end();
    });
    async function post(user = "alice", fields: Record<string, string> = {}, data = image, rpc = true) {
      const body = new FormData();
      for (const [key, value] of Object.entries({ caption: "投稿 🐈", visibility: "friends", location_kind: "none", ...fields })) body.set(key, value);
      body.set("image", new Blob([new Uint8Array(data)], { type: "image/jpeg" }), "test.jpg");
      const request = new Request("http://localhost/api/posts", { method: "POST", headers: { "x-test-user": user }, body });
      const bytes = await request.arrayBuffer();
      request.headers.set("Content-Length", String(bytes.byteLength));
      return apps[Number(rpc)]!.request(new Request(request, { body: bytes }));
    }
    function args(user = "alice", imageID: string = randomUUID(), postID: string = randomUUID()) {
      return [user, imageID, postID, image, "synthetic", "friends", "none", null, null, null];
    }
    function run(c: pg.Client, values = args()) {
      const p = c.query(rpcSQL, values); pending.push(p); return p;
    }
    async function pid(c: pg.Client) { return (await c.query("SELECT pg_backend_pid() AS pid")).rows[0].pid as number; }
    async function until(predicate: () => Promise<boolean>, description: string) {
      const deadline = performance.now() + 4000;
      while (performance.now() < deadline) { if (await predicate()) return; await sleep(10); }
      assert.fail(description);
    }
    async function blocked(waiter: number, holder: number) {
      await until(async () => (await control.query("SELECT $2::int = ANY(pg_blocking_pids($1)) AS blocked", [waiter, holder])).rows[0].blocked,
        `backend ${waiter} must wait for ${holder}`);
    }
    async function counts() {
      return (await control.query("SELECT (SELECT count(*)::int FROM posts) AS posts,(SELECT count(*)::int FROM image_objects) AS images")).rows[0];
    }
    return { control, db, config, post, apps, client, args, run, pid, until, blocked, counts, rpcCalls: () => rpcCalls };
  }

  const locations: Record<string, string>[] = [
    {}, { visibility: "public", location_kind: "exact", latitude: "35.12345678", longitude: "-122.654321" },
    { visibility: "friends_of_friends", location_kind: "approximate", locality: "京都" },
  ];
  for (const fields of locations) await t.test(`legacy JSON equivalence: ${JSON.stringify(fields)}`, async (st) => {
    const f = await fixture(st);
    const normalize = (body: any) => { const { id, imageUrl, postedAt, ...other } = body; assert.ok(id && imageUrl && postedAt); return other; };
    const old = await f.post("alice", fields, image, false);
    assert.equal(old.status, 201);
    const oldBody = await old.json();
    await f.control.query("TRUNCATE posts, image_objects CASCADE");
    const before = Temporal.Now.instant();
    const updated = await f.post("alice", fields);
    assert.equal(updated.status, 201);
    const body = await updated.json();
    assert.deepEqual(normalize(body), normalize(oldBody));
    assert.ok(Temporal.Instant.compare(Temporal.Instant.from(body.postedAt), before) >= 0);
    assert.ok(Temporal.Instant.compare(Temporal.Instant.from(body.postedAt), Temporal.Now.instant()) <= 0);
    const rows = (await f.control.query("SELECT p.*,i.data,i.created_at AS image_created FROM posts p JOIN image_objects i ON i.id=p.image_id WHERE p.id=$1", [body.id])).rows;
    assert.equal(rows.length, 1); assert.deepEqual(rows[0].data, image);
    assert.equal(rows[0].posted_at.toISOString(), rows[0].image_created.toISOString());
    assert.equal(f.rpcCalls(), 1);
  });

  await t.test("no active window / future window / deleted user / invalid image preserve rejection", async (st) => {
    const f = await fixture(st);
    assert.equal((await f.post("alice", {}, Buffer.from("not jpeg"))).status, 400);
    assert.equal(f.rpcCalls(), 0);
    await f.control.query("UPDATE posting_windows SET starts_at=clock_timestamp()+interval '1 hour'");
    assert.equal((await f.post()).status, 409);
    await f.control.query("UPDATE posting_windows SET ended_at=clock_timestamp()");
    assert.equal((await f.post()).status, 409);
    await f.control.query("UPDATE users SET status='deleted' WHERE id='alice'");
    assert.equal((await f.post()).status, 500);
    assert.deepEqual(await f.counts(), { posts: 0, images: 0 });
  });

  await t.test("two-deletion cap, cross-region same-date gate, lateSeconds and next day", async (st) => {
    const f = await fixture(st);
    await f.control.query("UPDATE posting_windows SET on_time_deadline=clock_timestamp()-interval '10 seconds'");
    for (let n = 0; n < 2; n++) {
      const response = await f.post(); assert.equal(response.status, 201);
      const body = await response.json(); assert.equal(body.onTime, false); assert.ok(body.lateSeconds >= 10);
      assert.equal((await f.post()).status, 409);
      const deletion = await f.apps[1]!.request(`/api/posts/${body.id}`, { method: "DELETE" });
      assert.equal(deletion.status, 204);
      if (n === 0) await f.control.query("UPDATE users SET region='europe' WHERE id='alice'");
    }
    assert.equal((await f.post()).status, 409);
    await f.control.query("UPDATE posting_windows SET local_date='2026-11-01' WHERE region='europe'");
    assert.equal((await f.post()).status, 201);
    assert.deepEqual(await f.counts(), { posts: 3, images: 3 });
  });

  await t.test("concurrent same-user posts serialize and observe fresh count: 201 / 409", async (st) => {
    const f = await fixture(st);
    const responses = await Promise.all([f.post(), f.post()]);
    assert.deepEqual(responses.map(r => r.status).sort(), [201, 409]);
    assert.deepEqual(await f.counts(), { posts: 1, images: 1 });
  });

  await t.test("region change first: row lock wait uses updated user region", async (st) => {
    const f = await fixture(st), writer = await f.client(), moving = await f.client();
    const writerPID = await f.pid(writer), movingPID = await f.pid(moving);
    await moving.query("BEGIN"); await moving.query("UPDATE users SET region='europe' WHERE id='alice'");
    const posting = f.run(writer); await f.blocked(writerPID, movingPID);
    await moving.query("COMMIT");
    assert.equal((await posting).rows[0].result.post.posting_window_id, "europe-old");
  });

  await t.test("window switch first: wait rechecks old row and retries with a fresh snapshot", async (st) => {
    const f = await fixture(st), writer = await f.client(), switching = await f.client();
    const writerPID = await f.pid(writer), switchPID = await f.pid(switching);
    await switching.query("BEGIN");
    await switching.query("UPDATE posting_windows SET ended_at=clock_timestamp() WHERE id='asia-old'");
    await switching.query(`INSERT INTO posting_windows(id,region,local_date,starts_at,on_time_deadline)
      VALUES('asia-next','asia','2026-11-01',clock_timestamp()-interval '1 second',clock_timestamp()+interval '1 hour')`);
    const posting = f.run(writer); await f.blocked(writerPID, switchPID);
    await switching.query("COMMIT");
    assert.equal((await posting).rows[0].result.post.posting_window_id, "asia-next");
  });

  await t.test("post first: shared window allows another user while window close waits until commit", async (st) => {
    const f = await fixture(st), writer = await f.client(), gate = await f.client(), closing = await f.client();
    const writerPID = await f.pid(writer), gatePID = await f.pid(gate), closePID = await f.pid(closing);
    await f.control.query(`CREATE FUNCTION test_gate() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.author_id='alice' THEN PERFORM pg_advisory_xact_lock(20261031,999); END IF; RETURN NEW; END $$;
      CREATE TRIGGER test_gate BEFORE INSERT ON posts FOR EACH ROW EXECUTE FUNCTION test_gate()`);
    await gate.query("SELECT pg_advisory_lock(20261031,999)");
    const posting = f.run(writer); await f.blocked(writerPID, gatePID);
    assert.equal((await f.post("bob")).status, 201);
    const close = closing.query("UPDATE posting_windows SET ended_at=clock_timestamp() WHERE id='asia-old'");
    await f.blocked(closePID, writerPID);
    await gate.query("SELECT pg_advisory_unlock(20261031,999)");
    assert.equal((await posting).rows[0].result.post.posting_window_id, "asia-old");
    assert.equal((await close).rowCount, 1);
    assert.deepEqual(await f.counts(), { posts: 2, images: 2 });
  });

  await t.test("insert error rolls back image and releases locks; next call is usable", async (st) => {
    const f = await fixture(st), c = await f.client();
    await f.control.query("INSERT INTO posts(id,author_id,posting_window_id,image_id,visibility,location_kind,posted_at) VALUES('collision','bob','asia-old','missing','friends','none',clock_timestamp())");
    const args = f.args("alice", "must-rollback", "collision");
    await assert.rejects(f.run(c, args), /duplicate key/);
    assert.equal((await f.control.query("SELECT count(*)::int AS n FROM image_objects WHERE id='must-rollback'")).rows[0].n, 0);
    assert.equal((await f.post()).status, 201);
  });

  await t.test("paused client response cannot extend transaction/window locks", async (st) => {
    const f = await fixture(st), c = await f.client();
    const id = await f.pid(c);
    const stream = (c as unknown as { connection: { stream: { pause(): void; resume(): void } } }).connection.stream;
    let received = false;
    const posting = f.run(c).then(r => { received = true; return r; });
    stream.pause();
    try {
      await f.until(async () => (await f.control.query("SELECT EXISTS(SELECT 1 FROM posts WHERE author_id='alice') AS visible")).rows[0].visible,
        "post must commit before client reads its result");
      assert.equal(received, false);
      const state = (await f.control.query("SELECT state,xact_start FROM pg_stat_activity WHERE pid=$1", [id])).rows[0];
      assert.equal(state.state, "idle"); assert.equal(state.xact_start, null);
      await f.control.query("BEGIN; SET LOCAL lock_timeout='200ms'; SELECT id FROM users WHERE id='alice' FOR UPDATE; UPDATE posting_windows SET ended_at=clock_timestamp() WHERE id='asia-old'; ROLLBACK");
      assert.equal(received, false);
    } finally { stream.resume(); }
    assert.ok((await posting).rows[0].result.post.id);
  });

  await t.test("additive migration can be removed/reapplied and missing function uses legacy path", async (st) => {
    const f = await fixture(st);
    await f.control.query(down);
    assert.equal((await f.db.get<{ enabled: boolean }>("SELECT to_regprocedure($1) IS NOT NULL AS enabled", postTransactionSignature))!.enabled, false);
    assert.equal((await f.post("alice", {}, image, false)).status, 201);
    await f.control.query(up);
    assert.equal((await f.db.get<{ enabled: boolean }>("SELECT to_regprocedure($1) IS NOT NULL AS enabled", postTransactionSignature))!.enabled, true);
    assert.equal((await f.post("bob")).status, 201);
  });

  await t.test("SECURITY INVOKER requires caller table permissions and works for a non-superuser", async (st) => {
    const f = await fixture(st), role = `post_rpc_app_${number}`;
    await f.control.query(`CREATE ROLE ${role} LOGIN; GRANT USAGE ON SCHEMA public TO ${role}`);
    const app = await f.client(role);
    await assert.rejects(f.run(app), /permission denied for table users/);
    assert.deepEqual(await f.counts(), { posts: 0, images: 0 });
    await f.control.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO ${role}`);
    assert.ok((await f.run(app)).rows[0].result.post.id);
    assert.deepEqual(await f.counts(), { posts: 1, images: 1 });
  });

  await t.test("production reset preserves the function, restores users and removes new posts/images", async (st) => {
    const f = await fixture(st);
    await f.control.query(await readFile(new URL("../../sql/003-initial-snapshot.sql", import.meta.url), "utf8"));
    assert.equal((await f.post()).status, 201);
    await f.control.query(await readFile(new URL("../../sql/reset.sql", import.meta.url), "utf8"));
    await f.control.query("SET session_replication_role=origin");
    assert.deepEqual(await f.counts(), { posts: 0, images: 0 });
    assert.equal((await f.post()).status, 201);
  });

  await t.test("real HTTP/newServer discovers RPC; auth/region/JPEG checks and cross-region read remain valid", async (st) => {
    const f = await fixture(st), databases: DB[] = [], servers: ReturnType<typeof serve>[] = [];
    const ping = DB.prototype.ping;
    st.mock.method(DB.prototype, "ping", async function(this: DB) { databases.push(this); await ping.call(this); });
    st.after(async () => {
      for (const server of servers) await new Promise<void>((resolve) => {
        server.close(() => resolve()); if ("closeAllConnections" in server) server.closeAllConnections();
      });
      await Promise.all(databases.map(db => db.end()));
    });
    await f.control.query("UPDATE users SET region='europe' WHERE id='bob'");
    await f.control.query("INSERT INTO friendships(id,user_low_id,user_high_id) VALUES('friend','alice','bob')");
    for (const user of ["alice", "bob"]) await f.control.query("INSERT INTO login_sessions(id,user_id,token_hash) VALUES($1,$1,$2)", [user, sha256Hex(user)]);
    const urls: string[] = [];
    for (const region of ["asia", "europe"]) {
      const app = await newServer({ ...f.config, region }, 2);
      const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 }); servers.push(server);
      if (!server.listening) await new Promise<void>(resolve => server.once("listening", resolve));
      const address = server.address(); assert.ok(address && typeof address !== "string");
      urls.push(`http://127.0.0.1:${address.port}`);
    }
    // RPC must work without an explicit client BEGIN; auth/feed are real SQL too.
    st.mock.method(DB.prototype, "begin", () => { throw new Error("unexpected explicit transaction"); });
    const large = Buffer.from(jpeg.encode({ data: randomBytes(512 * 512 * 4), width: 512, height: 512 }, 80).data);
    async function post(index: number, token: string, data = large) {
      const body = new FormData(); body.set("image", new Blob([new Uint8Array(data)], { type: "image/jpeg" }), "test.jpg");
      body.set("caption", "HTTP 🐈"); body.set("visibility", "friends"); body.set("location_kind", "none");
      return fetch(urls[index] + "/api/posts", { method: "POST", headers: { Authorization: `Bearer ${token}`, "X-Client-IP": "203.0.113.9" }, body });
    }
    assert.equal((await post(0, "missing")).status, 401);
    assert.equal((await post(0, "bob")).status, 403);
    assert.equal((await post(0, "alice", Buffer.from("invalid"))).status, 400);
    const first = await post(0, "alice"); assert.equal(first.status, 201); const item = await first.json();
    assert.equal((await post(1, "bob")).status, 201);
    const feed = await fetch(urls[1] + "/api/feeds/friends", { headers: { Authorization: "Bearer bob", "X-Client-IP": "203.0.113.9" } });
    assert.equal(feed.status, 200); assert.deepEqual((await feed.json()).items.map((p: any) => p.id), [item.id]);
    const downloaded = await fetch(urls[0] + item.imageUrl);
    assert.equal(downloaded.status, 200); assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), large);
    assert.equal((await post(0, "alice")).status, 409);
  });

  if (process.env.POST_TRANSACTION_BENCH_RTT_MS) await t.test("representative JPEG: legacy vs RPC with synthetic RTT", async (st) => {
    const rtt = Number(process.env.POST_TRANSACTION_BENCH_RTT_MS);
    const f = await fixture(st, rtt);
    const large = Buffer.from(jpeg.encode({ data: randomBytes(512 * 512 * 4), width: 512, height: 512 }, 80).data);
    const results: { rpc: boolean; ms: number }[] = [];
    for (const rpc of [false, true, true, false]) {
      for (let n = 0; n < 5; n++) {
        await f.control.query("TRUNCATE posts, image_objects CASCADE");
        const start = performance.now();
        const response = await f.post("alice", {}, large, rpc);
        assert.equal(response.status, 201); await response.json();
        const ms = performance.now() - start;
        assert.deepEqual((await f.control.query("SELECT data FROM image_objects")).rows[0].data, large);
        if (n) results.push({ rpc, ms });
      }
    }
    t.diagnostic(JSON.stringify({ version, rtt, imageBytes: large.length, samples: results,
      note: "Hono handler; auth/IPBan/nginx/real WAN bandwidth/actual CPU saturation excluded; ABBA, each 1 warmup + 4 samples" }));
  });
});
