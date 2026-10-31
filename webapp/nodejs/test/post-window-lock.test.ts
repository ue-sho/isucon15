import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test, type TestContext } from "node:test";
import { promisify } from "node:util";
import { Hono } from "hono";
import jpeg from "jpeg-js";
import pg from "pg";
import { openPostingWindowHandler } from "../src/admin_posting_window_api.ts";
import { apiErrorHandler } from "../src/api_error.ts";
import type { Config } from "../src/config.ts";
import { DB, type Tx } from "../src/db.ts";
import { getFeedHandler } from "../src/feed_api.ts";
import { IPBanList } from "../src/ip_ban.ts";
import { createPostHandler, deletePostHandler } from "../src/post_api.ts";
import type { Env } from "../src/server.ts";
import { updateMeHandler } from "../src/user_api.ts";

// Opt-in: starts its own disposable PG16 container, never accepts a database URL.
const enabled = process.env.POST_WINDOW_LOCK_TEST === "1";
const docker = promisify(execFile);
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const isWindowSelect = (sql: string) => sql.startsWith("SELECT id, local_date, starts_at FROM posting_windows");
const isUserLock = (sql: string) => sql.startsWith("SELECT id") && sql.includes("FROM users") && sql.includes("FOR NO KEY UPDATE");
const isWindowEnd = (sql: string) => sql.startsWith("UPDATE posting_windows SET ended_at");

async function within<T>(promise: PromiseLike<T>, message = "operation timed out"): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), 5000);
    })]);
  } finally {
    clearTimeout(timer);
  }
}

type QueryEvent = { phase: "before" | "after"; sql: string; args: unknown[]; result?: unknown; pid: number };
type Hook = (event: QueryEvent) => Promise<void> | void;

// Wrap real Tx methods only to schedule races; all SQL/results use the real DB.
class ObservedDB extends DB {
  hook: Hook = () => {};

  override async begin(): Promise<Tx> {
    const tx = await super.begin();
    const { pid } = (await tx.get<{ pid: number }>("SELECT pg_backend_pid() AS pid"))!;
    return new Proxy(tx, {
      get: (target, property) => {
        const value = Reflect.get(target, property, target);
        if (typeof value !== "function") return value;
        if (!["get", "select", "exec", "commit"].includes(String(property))) return value.bind(target);
        return async (...args: unknown[]) => {
          const event = { sql: property === "commit" ? "COMMIT" : String(args[0]), args: args.slice(1), pid };
          await this.hook({ ...event, phase: "before" });
          const result = await value.apply(target, args);
          await this.hook({ ...event, phase: "after", result });
          return result;
        };
      },
    });
  }
}

test("post window locking / isolated PostgreSQL 16", { skip: !enabled, timeout: 120000 }, async (t) => {
  const container = `isucon15-post-window-${randomUUID()}`;
  let admin: pg.Client | undefined;
  await docker("docker", ["run", "--detach", "--rm", "--name", container,
    "--label", "isucon15.test=post-window-lock", "--publish", "127.0.0.1::5432",
    "--tmpfs", "/var/lib/postgresql/data", "--env", "POSTGRES_HOST_AUTH_METHOD=trust",
    "--env", "POSTGRES_DB=post_window_test", "postgres:16",
    "-c", "statement_timeout=5000", "-c", "log_statement=none"], { timeout: 20000 });
  t.after(async () => {
    await admin?.end();
    await docker("docker", ["stop", "--time", "1", container], { timeout: 10000 });
  });
  const { stdout: binding } = await docker("docker", ["port", container, "5432/tcp"]);
  const port = Number(binding.trim().split(":").at(-1));
  assert.ok(port > 0);
  const connection = { host: "127.0.0.1", port, user: "postgres", database: "post_window_test" };
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    const probe = new pg.Client(connection);
    try { await probe.connect(); ready = true; } catch { /* fresh server is starting */ }
    finally { await probe.end(); }
    if (ready) break;
    await sleep(100);
  }
  assert.ok(ready, "isolated PostgreSQL must be ready");
  admin = new pg.Client(connection);
  await admin.connect();
  const version = (await admin.query("SHOW server_version")).rows[0].server_version as string;
  assert.match(version, /^16\./);
  assert.equal((await admin.query("SHOW default_transaction_isolation")).rows[0].default_transaction_isolation, "read committed");
  t.diagnostic(`PostgreSQL ${version}; Node ${process.version}; read committed; synthetic fixtures only`);
  const schema = await readFile(new URL("../../sql/001-schema.sql", import.meta.url), "utf8");
  const image = jpeg.encode({ data: Buffer.from([40, 80, 120, 255]), width: 1, height: 1 }, 80).data;
  let databaseNumber = 0;

  async function fixture(st: TestContext) {
    const database = `post_window_${++databaseNumber}`;
    await admin!.query(`CREATE DATABASE ${database}`);
    const control = new pg.Client({ ...connection, database });
    await control.connect();
    // The production schema is loaded only into this new, empty database.
    await control.query(schema);
    const config: Config = { region: "asia", dbHost: "127.0.0.1", dbPort: String(port), dbUser: "postgres",
      dbPassword: "", dbName: database, logLevel: "error" };
    const db = new ObservedDB(config, 8);
    const app = new Hono<Env>();
    app.onError(apiErrorHandler);
    app.use(async (c, next) => {
      c.set("session", { userID: c.req.header("x-test-user") ?? "alice", region: "asia", token: "test",
        tokenHash: "test", createdAt: Temporal.Now.instant() });
      await next();
    });
    const context = { db, config, ipBans: new IPBanList() };
    app.post("/api/posts", createPostHandler(context));
    app.delete("/api/posts/:postId", deletePostHandler(context));
    app.post("/api/admin/posting-window", openPostingWindowHandler(context));
    app.patch("/api/me", updateMeHandler(context));
    app.get("/api/feeds/:feed", getFeedHandler(context));
    await control.query(`INSERT INTO users (id, username, secret_key_hash, display_name, region)
      VALUES ('alice', 'alice', repeat('0', 64), 'Alice', 'asia'), ('bob', 'bob', repeat('0', 64), 'Bob', 'asia')`);
    await control.query(`INSERT INTO friendships (id, user_low_id, user_high_id) VALUES ('friendship', 'alice', 'bob')`);
    await control.query(`INSERT INTO posting_windows (id, region, local_date, starts_at, on_time_deadline)
      VALUES ('asia-old', 'asia', '2026-10-31', clock_timestamp() - interval '1 minute', clock_timestamp() + interval '1 hour'),
             ('europe-old', 'europe', '2026-10-31', clock_timestamp() - interval '1 minute', clock_timestamp() + interval '1 hour')`);
    const pending: Promise<Response>[] = [];
    const releases: (() => void)[] = [];
    st.after(async () => {
      releases.forEach((release) => release());
      await Promise.allSettled(pending);
      await db.end();
      await control.end();
    });
    function request(path: string, init: RequestInit = {}, user = "alice") {
      const result = (async () => {
        const req = new Request(`http://localhost${path}`, { ...init, headers: { ...init.headers, "x-test-user": user } });
        if (init.body) {
          // Hono's in-process requests need the framing header bind.hasBody expects.
          const body = await req.arrayBuffer();
          req.headers.set("Content-Length", String(body.byteLength));
          return app.request(new Request(req, { body }));
        }
        return app.request(req);
      })();
      pending.push(result);
      return result;
    }
    function post(user = "alice") {
      const body = new FormData();
      body.set("image", new Blob([new Uint8Array(image)], { type: "image/jpeg" }), "test.jpg");
      body.set("caption", "synthetic");
      body.set("visibility", "friends");
      body.set("location_kind", "none");
      return request("/api/posts", { method: "POST", body }, user);
    }
    function open(localDate = "2026-11-01") {
      return request("/api/admin/posting-window", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ region: "asia", localDate, onTimeSeconds: 3600 }) });
    }
    function move() {
      return request("/api/me", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: '{"region":"europe"}' });
    }
    function gate() {
      const reached = Promise.withResolvers<QueryEvent>();
      const release = Promise.withResolvers<void>();
      releases.push(release.resolve);
      return { reached: reached.promise, release: release.resolve, hold: async (event: QueryEvent) => {
        reached.resolve(event);
        await within(release.promise, "test gate not released");
      } };
    }
    async function blocked(waiter: number, holder: number) {
      const deadline = performance.now() + 3000;
      while (performance.now() < deadline) {
        const { rows } = await control.query(`SELECT wait_event_type, pg_blocking_pids(pid) AS blockers,
          EXISTS(SELECT 1 FROM pg_locks l WHERE l.pid = a.pid AND NOT granted) AS waiting
          FROM pg_stat_activity a WHERE pid = $1`, [waiter]);
        if (rows[0]?.wait_event_type === "Lock" && rows[0]?.waiting && rows[0]?.blockers.includes(holder)) return;
        await sleep(10);
      }
      assert.fail("expected PostgreSQL lock wait on the held transaction");
    }
    async function counts() {
      return (await control.query(`SELECT (SELECT count(*)::int FROM posts) AS posts,
        (SELECT count(*)::int FROM image_objects) AS images,
        (SELECT count(*)::int FROM posts WHERE deleted_at IS NOT NULL) AS deleted`)).rows[0];
    }
    return { db, control, config, request, post, open, move, gate, blocked, counts };
  }

  await t.test("PG16: SHARE shares with SHARE but blocks non-key UPDATE; KEY SHARE does not", async (st) => {
    const f = await fixture(st);
    const a = await f.db.begin();
    const b = await f.db.begin();
    try {
      await a.get("SELECT id FROM posting_windows WHERE id = 'asia-old' FOR SHARE");
      await b.get("SELECT id FROM posting_windows WHERE id = 'asia-old' FOR SHARE");
      await b.exec("SET LOCAL lock_timeout = '100ms'");
      await assert.rejects(b.exec("UPDATE posting_windows SET ended_at = clock_timestamp() WHERE id = 'asia-old'"), { code: "55P03" });
    } finally { await b.rollback(); await a.rollback(); }
    await using keyShare = await f.db.begin();
    await using update = await f.db.begin();
    await keyShare.get("SELECT id FROM posting_windows WHERE id = 'asia-old' FOR KEY SHARE");
    await update.exec("SET LOCAL lock_timeout = '100ms'");
    assert.equal(await update.exec("UPDATE posting_windows SET ended_at = clock_timestamp() WHERE id = 'asia-old'"), 1);
  });

  await t.test("different users finish concurrently; image/post become visible together; friends feed sees both", async (st) => {
    const f = await fixture(st);
    const gate = f.gate();
    f.db.hook = (e) => { if (e.phase === "after" && e.sql.startsWith("INSERT INTO image_objects") && e.args[1] === "alice") return gate.hold(e); };
    const first = f.post();
    await within(gate.reached);
    assert.deepEqual(await f.counts(), { posts: 0, images: 0, deleted: 0 });
    const second = await within(f.post("bob"), "different user serialized behind first post");
    assert.equal(second.status, 201);
    assert.deepEqual(await f.counts(), { posts: 1, images: 1, deleted: 0 });
    gate.release();
    const firstResponse = await first;
    assert.equal(firstResponse.status, 201);
    assert.deepEqual(await f.counts(), { posts: 2, images: 2, deleted: 0 });
    const firstBody = await firstResponse.json();
    const secondBody = await second.json();
    for (const [user, id] of [["alice", secondBody.id], ["bob", firstBody.id]]) {
      const response = await f.request("/api/feeds/friends", {}, user);
      assert.equal(response.status, 200);
      assert.deepEqual((await response.json()).items.map((item: { id: string }) => item.id), [id]);
    }
  });

  await t.test("same user waits on users row and receives 409 without a second image", async (st) => {
    const f = await fixture(st);
    const gate = f.gate();
    const waiting = Promise.withResolvers<QueryEvent>();
    let userLocks = 0;
    f.db.hook = (e) => {
      if (e.phase === "before" && isUserLock(e.sql) && ++userLocks === 2) waiting.resolve(e);
      if (e.phase === "after" && e.sql.startsWith("INSERT INTO image_objects")) return gate.hold(e);
    };
    const first = f.post();
    const holder = await within(gate.reached);
    const second = f.post();
    await f.blocked((await within(waiting.promise)).pid, holder.pid);
    gate.release();
    assert.equal((await first).status, 201);
    assert.equal((await second).status, 409);
    assert.deepEqual(await (await second).json(), { error: "post_slot_unavailable" });
    assert.deepEqual(await f.counts(), { posts: 1, images: 1, deleted: 0 });
  });

  await t.test("period switch waits until post COMMIT, then a new post uses the next window", async (st) => {
    const f = await fixture(st);
    const gate = f.gate();
    const waiting = Promise.withResolvers<QueryEvent>();
    let pause = true;
    f.db.hook = (e) => {
      if (e.phase === "before" && e.sql === "COMMIT" && pause) { pause = false; return gate.hold(e); }
      if (e.phase === "before" && isWindowEnd(e.sql)) waiting.resolve(e);
    };
    const posting = f.post();
    const holder = await within(gate.reached);
    const switching = f.open();
    await f.blocked((await within(waiting.promise)).pid, holder.pid);
    assert.deepEqual(await f.counts(), { posts: 0, images: 0, deleted: 0 });
    gate.release();
    assert.equal((await posting).status, 201);
    assert.equal((await switching).status, 201);
    const next = await (await switching).json();
    const second = await f.post("bob");
    assert.equal(second.status, 201);
    assert.equal((await second.json()).postingWindowId, next.id);
    assert.equal((await (await posting).json()).postingWindowId, "asia-old");
    assert.equal((await f.control.query("SELECT count(*)::int AS n FROM notifications WHERE posting_window_id = $1", [next.id])).rows[0].n, 2);
  });

  await t.test("switch-first rechecks the ended row, retries with a fresh snapshot and keeps the retry lock shared", async (st) => {
    const f = await fixture(st);
    const adminGate = f.gate();
    const retryGate = f.gate();
    const searchStarted = Promise.withResolvers<QueryEvent>();
    const closeStarted = Promise.withResolvers<QueryEvent>();
    let firstAdmin = true;
    let postingPID = 0;
    const results: unknown[] = [];
    f.db.hook = (e) => {
      if (e.phase === "before" && e.sql === "COMMIT" && firstAdmin) { firstAdmin = false; return adminGate.hold(e); }
      if (isWindowSelect(e.sql)) {
        if (e.phase === "before" && !postingPID) { postingPID = e.pid; searchStarted.resolve(e); }
        if (e.phase === "after" && e.pid === postingPID) {
          results.push(e.result);
          if (results.length === 2) return retryGate.hold(e);
        }
      }
      if (e.phase === "before" && isWindowEnd(e.sql) && !firstAdmin) closeStarted.resolve(e);
    };
    const switching = f.open();
    const adminHolder = await within(adminGate.reached);
    const posting = f.post();
    await f.blocked((await within(searchStarted.promise)).pid, adminHolder.pid);
    adminGate.release();
    assert.equal((await switching).status, 201);
    const next = await (await switching).json();
    const retryHolder = await within(retryGate.reached);
    assert.equal(results.length, 2);
    assert.equal(results[0], undefined);
    assert.equal((results[1] as { id: string }).id, next.id);
    const second = await within(f.post("bob"), "retry query serialized another user");
    assert.equal(second.status, 201);
    const closing = f.open("2026-11-02");
    await f.blocked((await within(closeStarted.promise)).pid, retryHolder.pid);
    retryGate.release();
    assert.equal((await posting).status, 201);
    assert.equal((await (await posting).json()).postingWindowId, next.id);
    assert.equal((await closing).status, 201);
  });

  await t.test("no active window after both searches returns 409 with no image", async (st) => {
    const f = await fixture(st);
    await f.control.query("UPDATE posting_windows SET ended_at = clock_timestamp() WHERE region = 'asia'");
    let searches = 0;
    f.db.hook = (e) => { if (e.phase === "after" && isWindowSelect(e.sql)) searches++; };
    const response = await f.post();
    assert.equal(response.status, 409);
    assert.equal(searches, 2);
    assert.deepEqual(await f.counts(), { posts: 0, images: 0, deleted: 0 });
  });

  await t.test("post-first region change waits on the user; same-date cross-region repost stays forbidden", async (st) => {
    const f = await fixture(st);
    const gate = f.gate();
    const moving = Promise.withResolvers<QueryEvent>();
    f.db.hook = (e) => {
      if (e.phase === "after" && isWindowSelect(e.sql)) return gate.hold(e);
      if (e.phase === "before" && e.sql.startsWith("UPDATE users SET")) moving.resolve(e);
    };
    const posting = f.post();
    const holder = await within(gate.reached);
    const move = f.move();
    await f.blocked((await within(moving.promise)).pid, holder.pid);
    gate.release();
    assert.equal((await posting).status, 201);
    assert.equal((await (await posting).json()).postingWindowId, "asia-old");
    assert.equal((await move).status, 200);
    assert.equal((await f.post()).status, 409);
  });

  await t.test("region-change-first post waits then reads the new region", async (st) => {
    const f = await fixture(st);
    const gate = f.gate();
    const posting = Promise.withResolvers<QueryEvent>();
    f.db.hook = (e) => {
      if (e.phase === "after" && e.sql.startsWith("UPDATE users SET")) return gate.hold(e);
      if (e.phase === "before" && isUserLock(e.sql)) posting.resolve(e);
    };
    const moving = f.move();
    const holder = await within(gate.reached);
    const post = f.post();
    await f.blocked((await within(posting.promise)).pid, holder.pid);
    gate.release();
    assert.equal((await moving).status, 200);
    assert.equal((await post).status, 201);
    assert.equal((await (await post).json()).postingWindowId, "europe-old");
  });

  await t.test("second deletion serializes with repost; two-deletion cap also survives a region change", async (st) => {
    const f = await fixture(st);
    const first = await f.post();
    const firstID = (await first.json()).id;
    assert.equal(first.status, 201);
    assert.equal((await f.request(`/api/posts/${firstID}`, { method: "DELETE" })).status, 204);
    const second = await f.post();
    assert.equal(second.status, 201);
    const secondID = (await second.json()).id;
    const gate = f.gate();
    const waiting = Promise.withResolvers<QueryEvent>();
    let deletionLocked = false;
    f.db.hook = (e) => {
      if (e.phase === "after" && e.sql.startsWith("UPDATE posts SET deleted_at")) { deletionLocked = true; return gate.hold(e); }
      if (e.phase === "before" && isUserLock(e.sql) && deletionLocked) waiting.resolve(e);
    };
    const deleting = f.request(`/api/posts/${secondID}`, { method: "DELETE" });
    const holder = await within(gate.reached);
    const posting = f.post();
    await f.blocked((await within(waiting.promise)).pid, holder.pid);
    gate.release();
    assert.equal((await deleting).status, 204);
    assert.equal((await posting).status, 409);
    assert.equal((await f.request(`/api/posts/${secondID}`, { method: "DELETE" })).status, 404);
    assert.deepEqual(await f.counts(), { posts: 2, images: 2, deleted: 2 });
    assert.equal((await f.move()).status, 200);
    assert.equal((await f.post()).status, 409);
  });

  await t.test("failure after real image INSERT rolls back both records and releases locks", async (st) => {
    const f = await fixture(st);
    await f.control.query(`CREATE FUNCTION reject_test_post() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'synthetic post insert failure'; END $$;
      CREATE TRIGGER reject_test_post BEFORE INSERT ON posts FOR EACH ROW EXECUTE FUNCTION reject_test_post()`);
    let imageInserted = false;
    f.db.hook = (e) => { if (e.phase === "after" && e.sql.startsWith("INSERT INTO image_objects")) imageInserted = true; };
    assert.equal((await f.post()).status, 500);
    assert.ok(imageInserted);
    assert.deepEqual(await f.counts(), { posts: 0, images: 0, deleted: 0 });
    await f.control.query("DROP TRIGGER reject_test_post ON posts");
    assert.equal((await f.post()).status, 201);
    assert.deepEqual(await f.counts(), { posts: 1, images: 1, deleted: 0 });
  });
});
