import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test, type TestContext } from "node:test";
import { promisify } from "node:util";
import { Hono } from "hono";
import jpeg from "jpeg-js";
import pg from "pg";
import { openPostingWindowHandler } from "../src/admin_posting_window_api.ts";
import { deleteAccountHandler } from "../src/account_deletion_api.ts";
import { apiErrorHandler } from "../src/api_error.ts";
import type { Config } from "../src/config.ts";
import { DB, type Tx } from "../src/db.ts";
import { getFeedHandler } from "../src/feed_api.ts";
import { IPBanList } from "../src/ip_ban.ts";
import { createPostHandler, deletePostHandler } from "../src/post_api.ts";
import type { Env } from "../src/server.ts";
import { loginHandler, registerHandler, updateMeHandler } from "../src/user_api.ts";
import { legacyCreatePostHandler } from "./fixtures/post-create-legacy.ts";

// Opt-in: starts its own disposable PG16 container, never accepts a database URL.
const enabled = process.env.POST_WINDOW_LOCK_TEST === "1";
const docker = promisify(execFile);
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const isPrepare = (sql: string) => sql === "SELECT * FROM public.isureal_prepare_post($1)";
const isPostSave = (sql: string) => sql.includes("WITH image AS (");
const isUserLock = (sql: string) => isPrepare(sql) || sql.startsWith("SELECT id") && sql.includes("FROM users") && sql.includes("FOR NO KEY UPDATE");
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
  transformSQL = (sql: string) => sql;

  override async begin(): Promise<Tx> {
    await this.hook({ phase: "before", sql: "BEGIN", args: [], pid: 0 });
    const tx = await super.begin();
    const { pid } = (await tx.get<{ pid: number }>("SELECT pg_backend_pid() AS pid"))!;
    await this.hook({ phase: "after", sql: "BEGIN", args: [], pid });
    return new Proxy(tx, {
      get: (target, property) => {
        const value = Reflect.get(target, property, target);
        if (typeof value !== "function") return value;
        if (!["get", "select", "exec", "commit"].includes(String(property))) return value.bind(target);
        return async (...args: unknown[]) => {
          if (property !== "commit") args[0] = this.transformSQL(String(args[0]));
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
    "-c", "statement_timeout=5000", "-c", "log_statement=none",
    "-c", "track_commit_timestamp=on"], { timeout: 20000 });
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
    await control.query(await readFile(new URL("../../sql/migrations/20261031-post-db-call.up.sql", import.meta.url), "utf8"));
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
    app.post("/test/legacy/posts", legacyCreatePostHandler(context));
    app.delete("/api/posts/:postId", deletePostHandler(context));
    app.post("/api/admin/posting-window", openPostingWindowHandler(context));
    app.patch("/api/me", updateMeHandler(context));
    app.post("/api/auth/register", registerHandler(context));
    app.post("/api/auth/login", loginHandler(context));
    app.delete("/api/me", deleteAccountHandler(context));
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
    function post(user = "alice", path = "/api/posts", options: { image?: Uint8Array; visibility?: string; location?: Record<string, string> } = {}) {
      const body = new FormData();
      body.set("image", new Blob([new Uint8Array(options.image ?? image)], { type: "image/jpeg" }), "test.jpg");
      body.set("caption", "synthetic 日本語📸");
      body.set("visibility", options.visibility ?? "friends");
      body.set("location_kind", "none");
      for (const [key, value] of Object.entries(options.location ?? {})) body.set(key, value);
      return request(path, { method: "POST", body }, user);
    }
    function open(localDate = "2026-11-01", region = "asia") {
      return request("/api/admin/posting-window", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ region, localDate, onTimeSeconds: 3600 }) });
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

  await t.test("window opening does not block posts, login or non-region profile updates", async (st) => {
    const f = await fixture(st);
    await f.control.query("UPDATE users SET secret_key_hash=$1 WHERE id='alice'", [createHash("sha256").update("secret").digest("hex")]);
    const gate = f.gate();
    let held = false;
    f.db.hook = (e) => {
      if (e.phase === "after" && e.sql === "SELECT pg_advisory_xact_lock(20261031, 1)" && !held) {
        held = true; return gate.hold(e);
      }
    };
    const opening = f.open();
    await within(gate.reached);
    assert.equal((await within(f.post())).status, 201);
    assert.equal((await within(f.request("/api/me", { method: "PATCH", headers: { "Content-Type": "application/json" },
      body: '{"displayName":"Updated"}' }))).status, 200);
    assert.equal((await within(f.request("/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" },
      body: '{"username":"alice","secretKey":"secret"}' }))).status, 200);
    gate.release();
    assert.equal((await opening).status, 201);
  });

  for (const operation of ["register", "move", "delete"] as const) {
    for (const first of ["window", "membership"] as const) {
      await t.test(`${first} first serializes ${operation} with notification membership`, async (st) => {
        const f = await fixture(st);
        const gate = f.gate();
        const waiting = Promise.withResolvers<QueryEvent>();
        const exclusive = "SELECT pg_advisory_xact_lock(20261031, 1)";
        const shared = "SELECT pg_advisory_xact_lock_shared(20261031, 1)";
        let held = false;
        f.db.hook = (e) => {
          if (e.phase === "before" && e.sql === (first === "window" ? shared : exclusive)) waiting.resolve(e);
          if (e.phase === "after" && e.sql === (first === "window" ? exclusive : shared) && !held) {
            held = true; return gate.hold(e);
          }
        };
        const mutate = () => operation === "move" ? f.move() : operation === "delete"
          ? f.request("/api/me", { method: "DELETE" })
          : f.request("/api/auth/register", { method: "POST", headers: { "Content-Type": "application/json" },
            body: '{"username":"carol","displayName":"Carol","region":"asia"}' });
        const a = first === "window" ? f.open() : mutate();
        const holder = await within(gate.reached);
        const b = first === "window" ? mutate() : f.open();
        await f.blocked((await within(waiting.promise)).pid, holder.pid);
        gate.release();
        const [ra, rb] = await Promise.all([a, b]);
        const opened = first === "window" ? ra : rb;
        const changed = first === "window" ? rb : ra;
        assert.equal(opened.status, 201);
        assert.equal(changed.status, operation === "register" ? 201 : operation === "delete" ? 204 : 200);
        const { id } = await opened.json();
        const recipients = (await f.control.query("SELECT user_id FROM notifications WHERE posting_window_id=$1 ORDER BY user_id", [id])).rows.map(r => r.user_id);
        if (first === "window") assert.deepEqual(recipients, ["alice", "bob"]);
        else if (operation === "register") {
          assert.equal(recipients.length, 3);
          assert.ok(recipients.includes("alice") && recipients.includes("bob"));
        } else assert.deepEqual(recipients, ["bob"]);
      });
    }
  }

  await t.test("distinct registrations share membership lock without serializing each other", async (st) => {
    const f = await fixture(st);
    const gate = f.gate();
    let held = false;
    f.db.hook = (e) => {
      if (e.phase === "after" && e.sql === "SELECT pg_advisory_xact_lock_shared(20261031, 1)" && !held) {
        held = true; return gate.hold(e);
      }
    };
    const register = (username: string) => f.request("/api/auth/register", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, displayName: username, region: "asia" }),
    });
    const first = register("carol");
    await within(gate.reached);
    assert.equal((await within(register("dave"))).status, 201);
    gate.release();
    assert.equal((await first).status, 201);
  });

  await t.test("notification failure rolls back period switch and releases advisory lock", async (st) => {
    const f = await fixture(st);
    await f.control.query(`CREATE FUNCTION reject_notification() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'synthetic notification failure'; END $$;
      CREATE TRIGGER reject_notification BEFORE INSERT ON notifications FOR EACH ROW EXECUTE FUNCTION reject_notification()`);
    assert.equal((await f.open()).status, 500);
    assert.deepEqual((await f.control.query("SELECT id FROM posting_windows WHERE region='asia' AND ended_at IS NULL")).rows, [{ id: "asia-old" }]);
    assert.equal((await f.control.query("SELECT count(*)::int AS n FROM notifications")).rows[0].n, 0);
    await f.control.query("DROP TRIGGER reject_notification ON notifications");
    assert.equal((await within(f.move())).status, 200);
    assert.equal((await within(f.open())).status, 201);
  });

  await t.test("same-region concurrent openings serialize and duplicate date returns 409", async (st) => {
    const f = await fixture(st);
    const results = await Promise.all([f.open(), f.open()]);
    assert.deepEqual(results.map(r => r.status).sort(), [201, 409]);
    assert.equal((await f.open("2026-11-02")).status, 201);
    assert.equal((await f.control.query("SELECT count(*)::int AS n FROM posting_windows WHERE region='asia' AND ended_at IS NULL")).rows[0].n, 1);
  });

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
    f.db.hook = (e) => { if (e.phase === "after" && isPostSave(e.sql) && e.args[1] === "alice") return gate.hold(e); };
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
      if (e.phase === "after" && isPostSave(e.sql)) return gate.hold(e);
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

  await t.test("switch-first prepares from a fresh snapshot and keeps the successor window lock shared", async (st) => {
    const f = await fixture(st);
    const adminGate = f.gate();
    const retryGate = f.gate();
    const searchStarted = Promise.withResolvers<QueryEvent>();
    const closeStarted = Promise.withResolvers<QueryEvent>();
    let firstAdmin = true;
    let postingPID = 0;
    let preparedWindow: string | undefined;
    f.db.hook = (e) => {
      if (e.phase === "before" && e.sql === "COMMIT" && firstAdmin) { firstAdmin = false; return adminGate.hold(e); }
      if (isPrepare(e.sql)) {
        if (e.phase === "before" && !postingPID) { postingPID = e.pid; searchStarted.resolve(e); }
        if (e.phase === "after" && e.pid === postingPID) {
          preparedWindow = (e.result as { window_id: string }).window_id;
          return retryGate.hold(e);
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
    assert.equal(preparedWindow, next.id);
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
    f.db.hook = (e) => { if (e.phase === "after" && isPrepare(e.sql)) searches++; };
    const response = await f.post();
    assert.equal(response.status, 409);
    assert.equal(searches, 1);
    assert.deepEqual(await f.counts(), { posts: 0, images: 0, deleted: 0 });
  });

  await t.test("post-first region change waits on the user; same-date cross-region repost stays forbidden", async (st) => {
    const f = await fixture(st);
    const gate = f.gate();
    const moving = Promise.withResolvers<QueryEvent>();
    f.db.hook = (e) => {
      if (e.phase === "after" && isPrepare(e.sql)) return gate.hold(e);
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
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM image_objects WHERE id = NEW.image_id) THEN
          RAISE EXCEPTION 'image must have been inserted first';
        END IF;
        RAISE EXCEPTION 'synthetic post insert failure after image';
      END $$;
      CREATE TRIGGER reject_test_post BEFORE INSERT ON posts FOR EACH ROW EXECUTE FUNCTION reject_test_post()`);
    const response = await f.post();
    assert.equal(response.status, 500);
    assert.equal((await response.json()).error, "synthetic post insert failure after image");
    assert.deepEqual(await f.counts(), { posts: 0, images: 0, deleted: 0 });
    await f.control.query("DROP TRIGGER reject_test_post ON posts");
    assert.equal((await f.post()).status, 201);
    assert.deepEqual(await f.counts(), { posts: 1, images: 1, deleted: 0 });
  });

  await t.test("post-first deletion waits and the replacement remains limited to two deletions", async (st) => {
    const f = await fixture(st);
    const first = await f.post();
    const id = (await first.json()).id;
    const gate = f.gate();
    const waiting = Promise.withResolvers<QueryEvent>();
    f.db.hook = (e) => {
      if (e.phase === "after" && isPrepare(e.sql)) return gate.hold(e);
      if (e.phase === "before" && isUserLock(e.sql) && !isPrepare(e.sql)) waiting.resolve(e);
    };
    const posting = f.post(); // rejects after the held count read
    const holder = await within(gate.reached);
    const deleting = f.request(`/api/posts/${id}`, { method: "DELETE" });
    await f.blocked((await within(waiting.promise)).pid, holder.pid);
    gate.release();
    assert.equal((await posting).status, 409);
    assert.equal((await deleting).status, 204);
    f.db.hook = () => {};
    assert.equal((await f.post()).status, 201);
    assert.deepEqual(await f.counts(), { posts: 2, images: 2, deleted: 1 });
  });

  for (const first of ["post", "withdrawal"] as const) {
    await t.test(`${first} first serializes withdrawal and post without reviving the account`, async (st) => {
      const f = await fixture(st);
      const gate = f.gate();
      const waiting = Promise.withResolvers<QueryEvent>();
      let held = false;
      f.db.hook = (e) => {
        const hold = first === "post" ? isPrepare(e.sql) : e.sql.startsWith("UPDATE users SET status");
        const wait = first === "post" ? isUserLock(e.sql) && !isPrepare(e.sql) : isPrepare(e.sql);
        if (e.phase === "after" && hold && !held) { held = true; return gate.hold(e); }
        if (e.phase === "before" && wait) waiting.resolve(e);
      };
      const a = first === "post" ? f.post() : f.request("/api/me", { method: "DELETE" });
      const holder = await within(gate.reached);
      const b = first === "post" ? f.request("/api/me", { method: "DELETE" }) : f.post();
      await f.blocked((await within(waiting.promise)).pid, holder.pid);
      gate.release();
      const [ra, rb] = await Promise.all([a, b]);
      assert.equal((first === "post" ? ra : rb).status, first === "post" ? 201 : 500);
      // Missing active user keeps the old must()/NoRowsError behavior.
      if (first === "withdrawal") assert.deepEqual(await rb.json(), { error: "sql: no rows in result set" });
      assert.equal((await f.control.query("SELECT status FROM users WHERE id='alice'")).rows[0].status, "deleted");
      assert.equal((await f.control.query("SELECT count(*)::int AS n FROM posts WHERE deleted_at IS NULL")).rows[0].n, first === "post" ? 1 : 0);
    });
  }

  await t.test("postedAt uses the application clock after prepare, with microsecond deadline boundaries", async (st) => {
    const f = await fixture(st);
    const deadline = Temporal.Instant.from("2026-10-31T12:00:00.123456Z");
    await f.control.query("UPDATE posting_windows SET starts_at=$1, on_time_deadline=$2 WHERE id='asia-old'",
      [deadline.subtract({ seconds: 60 }).toString(), deadline.toString()]);
    let appTime = deadline.subtract({ seconds: 120 });
    st.mock.method(Temporal.Now, "instant", () => appTime);
    let sampledAfterPrepare = 0;
    f.db.hook = (e) => {
      if (e.phase === "after" && isPrepare(e.sql)) { appTime = deadline; sampledAfterPrepare++; }
    };
    const onTime = await f.post();
    assert.equal(onTime.status, 201);
    const body = await onTime.json();
    assert.equal(body.postedAt, deadline.toString());
    assert.equal(body.onTime, true);
    assert.equal(body.lateSeconds, 0);
    const stored = (await f.control.query("SELECT p.posted_at, i.created_at, i.data FROM posts p JOIN image_objects i ON i.id=p.image_id")).rows[0];
    assert.equal(stored.posted_at.getTime(), stored.created_at.getTime());
    assert.deepEqual(stored.data, image);
    assert.equal(sampledAfterPrepare, 1);
    await f.control.query("DELETE FROM posts; DELETE FROM image_objects");
    f.db.hook = () => {};
    for (const [microseconds, seconds] of [[1, 0], [999999, 0], [1000000, 1], [2000001, 2]]) {
      appTime = deadline.add({ microseconds });
      const late = await f.post();
      assert.equal(late.status, 201);
      const item = await late.json();
      assert.equal(item.postedAt, appTime.toString());
      assert.equal(item.onTime, false);
      assert.equal(item.lateSeconds, seconds);
      await f.control.query("DELETE FROM posts; DELETE FROM image_objects");
    }
    appTime = deadline.subtract({ seconds: 61 });
    assert.equal((await f.post()).status, 409);
    assert.deepEqual(await f.counts(), { posts: 0, images: 0, deleted: 0 });
  });

  await t.test("image bytes and every saved post attribute match the legacy path", async (st) => {
    const f = await fixture(st);
    const locations: Record<string, string>[] = [{ location_kind: "none" },
      { location_kind: "exact", latitude: "-90", longitude: "180" },
      { location_kind: "approximate", locality: "東京都 📍" }];
    for (const visibility of ["friends", "friends_of_friends", "public"]) {
      for (const location of locations) {
        const results = [];
        for (const path of ["/test/legacy/posts", "/api/posts"]) {
          const response = await f.post("alice", path, { visibility, location });
          assert.equal(response.status, 201);
          const body = await response.json();
          const saved = (await f.control.query(`SELECT caption, visibility, location_kind, latitude, longitude, locality,
            author_id, posting_window_id, data, owner_user_id, media_type,
            p.posted_at = i.created_at AS equal_timestamp
            FROM posts p JOIN image_objects i ON i.id = p.image_id`)).rows[0];
          assert.equal(saved.equal_timestamp, true);
          assert.deepEqual(saved.data, image);
          results.push({ saved, author: body.author, location: body.location, onTime: body.onTime, lateSeconds: body.lateSeconds });
          await f.control.query("DELETE FROM posts; DELETE FROM image_objects");
        }
        assert.deepEqual(results[1], results[0]);
      }
    }
    let began = 0;
    f.db.hook = (e) => { if (e.sql === "BEGIN" && e.phase === "before") began++; };
    const invalid = await f.post("alice", "/api/posts", { image: new Uint8Array([1, 2, 3]) });
    assert.equal(invalid.status, 400);
    assert.deepEqual(await invalid.json(), { error: "invalid_post" });
    assert.equal(began, 0);
  });

  await t.test("migration reapplication, fresh schema recreation and down/up keep the write path usable", async (st) => {
    const f = await fixture(st);
    const up = await readFile(new URL("../../sql/migrations/20261031-post-db-call.up.sql", import.meta.url), "utf8");
    await f.control.query(up);
    await f.control.query(await readFile(new URL("../../sql/003-initial-snapshot.sql", import.meta.url), "utf8"));
    assert.equal((await f.post()).status, 201);
    await f.control.query(await readFile(new URL("../../sql/reset.sql", import.meta.url), "utf8"));
    await f.control.query("SET session_replication_role=origin");
    assert.deepEqual(await f.counts(), { posts: 0, images: 0, deleted: 0 });
    assert.equal((await f.post()).status, 201);
    // schema bootstrap drops/recreates tables, while reset.sql only deletes rows.
    await f.control.query(schema);
    await f.control.query(`INSERT INTO users(id, username, secret_key_hash, display_name, region)
      VALUES ('alice','alice',repeat('0',64),'Alice','asia');
      INSERT INTO posting_windows(id,region,local_date,starts_at,on_time_deadline)
      VALUES ('asia-old','asia','2026-10-31',clock_timestamp()-interval '1 minute',clock_timestamp()+interval '1 hour')`);
    assert.equal((await f.post()).status, 201);
    await f.control.query(await readFile(new URL("../../sql/migrations/20261031-post-db-call.down.sql", import.meta.url), "utf8"));
    assert.equal((await f.control.query("SELECT to_regprocedure('public.isureal_prepare_post(text)') AS f")).rows[0].f, null);
    await f.control.query("DELETE FROM posts; DELETE FROM image_objects");
    assert.equal((await f.post("alice", "/test/legacy/posts")).status, 201);
    await f.control.query(up);
    await f.control.query(`CREATE ROLE post_call_writer;
      GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO post_call_writer;
      SET ROLE post_call_writer;
      BEGIN`);
    try {
      const prepared = (await f.control.query("SELECT * FROM public.isureal_prepare_post('alice')")).rows[0];
      assert.equal(prepared.author.id, "alice");
      assert.equal(prepared.active, "1");
    } finally { await f.control.query("ROLLBACK; RESET ROLE"); }
  });

  await t.test("same-condition legacy/new comparison: SQL calls, DB Tx and user-lock holding time", async (st) => {
    const f = await fixture(st);
    await f.control.query(`CREATE TABLE post_call_timing(xid xid NOT NULL, began_at timestamptz NOT NULL, locked_at timestamptz NOT NULL)`);
    // Only this synthetic fixture instruments the lock acquisition. Commit times
    // come from PG's track_commit_timestamp, so both durations use the DB clock.
    const up = await readFile(new URL("../../sql/migrations/20261031-post-db-call.up.sql", import.meta.url), "utf8");
    await f.control.query(up.replace("FOR NO KEY UPDATE;", `FOR NO KEY UPDATE;
      INSERT INTO post_call_timing VALUES(pg_current_xact_id()::text::xid, transaction_timestamp(), clock_timestamp());`));
    f.db.transformSQL = (sql) => isUserLock(sql) && !isPrepare(sql) ? `WITH locked AS MATERIALIZED (${sql}),
      timing AS (INSERT INTO post_call_timing SELECT pg_current_xact_id()::text::xid,
        transaction_timestamp(), clock_timestamp() FROM locked RETURNING xid)
      SELECT locked.* FROM locked CROSS JOIN timing` : sql;
    for (const delay of [0, 30]) {
      const measurements: Record<string, { calls: number; tx: number; lock: number; http: number }[]> = { legacy: [], current: [] };
      for (const [index, mode] of ["legacy", "current", "legacy", "current", "current", "legacy", "legacy", "current", "current", "legacy"].entries()) {
        let calls = 0;
        f.db.hook = async (e) => {
          if (e.phase === "before") calls++;
          if (e.phase === "after" && delay) await sleep(delay);
        };
        const started = performance.now();
        const response = await f.post("alice", mode === "legacy" ? "/test/legacy/posts" : "/api/posts");
        const http = performance.now() - started;
        assert.equal(response.status, 201);
        assert.equal(calls, mode === "legacy" ? 7 : 4);
        const timing = (await f.control.query(`SELECT
          (extract(epoch FROM (pg_xact_commit_timestamp(xid)-began_at))*1000)::float8 AS tx,
          (extract(epoch FROM (pg_xact_commit_timestamp(xid)-locked_at))*1000)::float8 AS lock
          FROM post_call_timing`)).rows[0];
        assert.ok(timing.tx >= timing.lock && timing.lock >= 0);
        if (index >= 2) measurements[mode].push({ calls, tx: timing.tx, lock: timing.lock, http });
        await f.control.query("DELETE FROM posts; DELETE FROM image_objects; DELETE FROM post_call_timing");
      }
      const means = Object.fromEntries(Object.entries(measurements).map(([mode, rows]) => [mode,
        Object.fromEntries(["calls", "tx", "lock", "http"].map(key => [key,
          Number((rows.reduce((sum, row) => sum + row[key as keyof typeof row], 0) / rows.length).toFixed(3))]))]));
      st.diagnostic(`synthetic per-SQL return delay=${delay}ms; 1 warmup + 4 samples/mode; ${JSON.stringify(means)}`);
    }
  });
});
