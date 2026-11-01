import assert from "node:assert/strict";
import { execFile, fork } from "node:child_process";
import { once } from "node:events";
import { serve } from "@hono/node-server";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import { promisify } from "node:util";
import { Hono } from "hono";
import pg from "pg";
import { openPostingWindowHandler } from "../src/admin_posting_window_api.ts";
import { apiErrorHandler } from "../src/api_error.ts";
import type { Config } from "../src/config.ts";
import { DB, type Row, type Tx } from "../src/db.ts";
import { getNotificationsHandler } from "../src/notification_api.ts";
import { notificationChannel } from "../src/notification_wakeup.ts";
import type { Env, HandlerContext } from "../src/server.ts";

const docker = promisify(execFile);
const enabled = process.env.NOTIFICATION_COMMIT_TEST === "1";

async function until(check: () => Promise<boolean> | boolean, message = "condition timed out") {
  const deadline = performance.now() + 4000;
  while (!await check()) {
    assert.ok(performance.now() < deadline, message);
    await sleep(5);
  }
}

class ObservedDB extends DB {
  beforeCommit: () => Promise<void> = async () => {};
  commitBefore = 0;
  commitAfter = 0;
  polls = 0;
  pollFinishedAt = 0;
  selecting = 0;
  afterSelect: () => Promise<void> = async () => {};
  override async begin(): Promise<Tx> {
    const tx = await super.begin();
    return new Proxy(tx, { get: (target, key) => {
      if (key === "commit") return async () => {
        await this.beforeCommit();
        this.commitBefore = performance.now();
        await target.commit();
        this.commitAfter = performance.now();
      };
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    } });
  }
  override async select<T = Row>(sql: string, ...args: unknown[]): Promise<T[]> {
    if (!sql.includes("WITH ORDINALITY")) return super.select<T>(sql, ...args);
    assert.equal(++this.selecting, 1, "poll queries must not overlap");
    try {
      const result = await super.select<T>(sql, ...args);
      this.polls++;
      this.pollFinishedAt = performance.now();
      await this.afterSelect();
      return result;
    } finally { this.selecting--; }
  }
}

test("通知commit起床 / isolated PostgreSQL 16", { skip: !enabled, timeout: 120000 }, async (t) => {
  // This suite creates its own container; it never reads service credentials/URLs.
  const name = `isucon15-notification-${randomUUID()}`;
  await docker("docker", ["run", "--detach", "--rm", "--name", name,
    "--label", "isucon15.test=notification-commit", "--publish", "127.0.0.1::5432",
    "--tmpfs", "/var/lib/postgresql/data", "--env", "POSTGRES_HOST_AUTH_METHOD=trust",
    "postgres:16", "-c", "statement_timeout=5000", "-c", "log_statement=none"], { timeout: 20000 });
  let admin: pg.Client | undefined;
  t.after(async () => {
    await admin?.end();
    await docker("docker", ["stop", "--time", "1", name], { timeout: 10000 });
  });
  const { stdout } = await docker("docker", ["port", name, "5432/tcp"]);
  const port = Number(stdout.trim().split(":").at(-1));
  assert.ok(port > 0);
  const connection = { host: "127.0.0.1", port, user: "postgres", database: "postgres" };
  await until(async () => {
    const probe = new pg.Client(connection);
    try { await probe.connect(); return true; } catch { return false; } finally { await probe.end(); }
  });
  admin = new pg.Client(connection);
  await admin.connect();
  const version = (await admin.query("SHOW server_version")).rows[0].server_version;
  assert.match(version, /^16\./);
  t.diagnostic(`PostgreSQL ${version}; Node ${process.version}; loopback; synthetic fixtures`);
  const schema = await readFile(new URL("../../sql/001-schema.sql", import.meta.url), "utf8");
  let serial = 0;

  async function fixture(st: TestContext, mode: "notify" | "poll" = "notify") {
    const database = `notification_${++serial}`;
    await admin!.query(`CREATE DATABASE ${database}`);
    const control = new pg.Client({ ...connection, database });
    await control.connect();
    await control.query(schema);
    await control.query(`INSERT INTO users(id,username,secret_key_hash,display_name,region)
      VALUES ('alice','alice',repeat('0',64),'Alice','asia'), ('bob','bob',repeat('0',64),'Bob','asia')`);
    const config: Config = { region: "asia", dbHost: "127.0.0.1", dbPort: String(port), dbUser: "postgres",
      dbPassword: "", dbName: database, logLevel: "error" };
    const workers = new Set<DB>();
    const aborts: AbortController[] = [];
    const releases: (() => void)[] = [];
    function worker() {
      const db = new ObservedDB(config, 2);
      const app = new Hono<Env>();
      app.onError(apiErrorHandler);
      app.use("*", async (c, next) => {
        c.set("session", { userID: c.req.header("x-user") ?? "alice", region: "asia", token: "", tokenHash: "", createdAt: Temporal.Now.instant() });
        await next();
      });
      const h = { db, config } as unknown as HandlerContext;
      let listener: ReturnType<DB["createNotificationWakeup"]> | undefined;
      app.get("/notifications", getNotificationsHandler(h, (wake) => {
        if (mode === "poll") return { start() {}, stop() {} };
        return listener = db.createNotificationWakeup(wake);
      }));
      app.post("/open", openPostingWindowHandler(h));
      async function subscribe(user = "alice") {
        const abort = new AbortController();
        aborts.push(abort);
        const response = await app.request("/notifications", { signal: abort.signal, headers: { "x-user": user } });
        let done = false;
        const text = response.text().then(body => { done = true; return { body, receivedAt: performance.now() }; });
        return { text, abort: () => abort.abort(), done: () => done };
      }
      async function open(day: number) {
        const body = JSON.stringify({ region: "asia", localDate: `2026-11-${String(day).padStart(2, "0")}`, onTimeSeconds: 3600 });
        return app.request("/open", { method: "POST", body,
          headers: { "Content-Type": "application/json", "Content-Length": String(Buffer.byteLength(body)) } });
      }
      const result = { db, app, listener, subscribe, open, close: async () => { workers.delete(db); await db.end(); } };
      workers.add(db);
      return result;
    }
    function gate() {
      const reached = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      releases.push(release.resolve);
      return { reached: reached.promise, release: release.resolve, hold: async () => { reached.resolve(); await release.promise; } };
    }
    st.after(async () => {
      releases.forEach(f => f());
      aborts.forEach(abort => abort.abort());
      await Promise.all([...workers].map(db => db.end()));
      await control.end();
    });
    const first = worker();
    async function settled(w = first) {
      await until(() => w.db.polls > 0 && w.db.selecting === 0);
      await sleep(30); // allow the LISTEN catch-up poll to finish before scheduling a race
    }
    return { ...first, control, database, worker, gate, settled };
  }

  await t.test("commit前の不可視性、rollbackではイベントも配送もなく、commit後は1件", async st => {
    const f = await fixture(st);
    const received: string[] = [];
    f.control.on("notification", message => { received.push(message.payload ?? ""); });
    await f.control.query(`LISTEN ${notificationChannel}`);
    const sub = await f.subscribe();
    await f.settled();
    const gate = f.gate();
    f.db.beforeCommit = gate.hold;
    const opening = f.open(1);
    await gate.reached;
    await sleep(550);
    assert.equal(sub.done(), false);
    assert.equal((await f.control.query("SELECT count(*)::int AS n FROM notifications")).rows[0].n, 0);
    assert.equal(received.length, 0);
    gate.release();
    assert.equal((await opening).status, 201);
    const delivered = await sub.text;
    assert.equal((delivered.body.match(/data:/g) ?? []).length, 1);
    await until(() => received.length === 1);

    const rollbackSub = await f.subscribe();
    f.db.beforeCommit = async () => { throw new Error("synthetic rollback after pg_notify"); };
    assert.equal((await f.open(2)).status, 500);
    await sleep(550);
    assert.equal(rollbackSub.done(), false);
    assert.equal(received.length, 1);
    assert.equal((await f.control.query("SELECT count(*)::int AS n FROM posting_windows")).rows[0].n, 1);
  });

  await t.test("poll取得後のcommit、実行中の接続追加・切断、多重NOTIFYでも再照会は直列", async st => {
    const f = await fixture(st);
    const gate = f.gate();
    f.db.afterSelect = gate.hold;
    const removed = await f.subscribe();
    await gate.reached;
    const kept = await f.subscribe("bob");
    removed.abort();
    assert.equal((await removed.text).body, "");
    assert.equal((await f.open(1)).status, 201);
    for (let i = 0; i < 5; i++) await f.control.query(`SELECT pg_notify('${notificationChannel}', '')`);
    assert.equal(kept.done(), false);
    f.db.afterSelect = async () => {};
    gate.release();
    const delivered = await kept.text;
    assert.equal((delivered.body.match(/data:/g) ?? []).length, 1);
    const polls = f.db.polls;
    await sleep(550);
    assert.equal(f.db.polls, polls);
  });

  await t.test("LISTEN登録前にcommitした通知を登録後の照会で回収", async st => {
    const f = await fixture(st);
    const original = f.listener!.connect.bind(f.listener!);
    // Model a missed LISTEN setup during connection establishment.
    f.listener!.connect = async () => {};
    const sub = await f.subscribe();
    await f.settled();
    assert.equal(f.listener!.clients.size, 0);
    assert.equal((await f.open(1)).status, 201);
    assert.equal(sub.done(), false);
    f.listener!.connect = original;
    // Drop only this fixture's pool sockets so the next poll reconnects and LISTENs.
    await f.control.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()");
    const delivered = await sub.text;
    assert.match(delivered.body, /postingWindowId/);
    assert.ok(delivered.receivedAt - f.db.commitAfter < 1000);
  });

  await t.test("LISTEN接続断・再接続とイベント取りこぼしは通常pollで回収", async st => {
    const f = await fixture(st);
    const sub = await f.subscribe();
    await f.settled();
    const clients = [...f.listener!.clients.keys()];
    assert.ok(clients.length > 0);
    // Only this fixture's isolated DB is targeted; the control session is excluded.
    await f.control.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()");
    await until(() => f.listener!.clients.size === 0);
    // Keep LISTEN temporarily disabled: commit must still be found by polling.
    f.listener!.stop();
    assert.equal((await f.open(1)).status, 201);
    const result = await sub.text;
    assert.match(result.body, /postingWindowId/);
    assert.ok(result.receivedAt - f.db.commitAfter < 1000);
    const later = await f.subscribe();
    await until(() => f.listener!.clients.size > 0);
    assert.equal((await f.open(2)).status, 201);
    assert.match((await later.text).body, /postingWindowId/);
  });

  await t.test("pool全接続が長いTx中でも保持数を増やさず、解放後の通常pollで回収", async st => {
    const f = await fixture(st);
    const sub = await f.subscribe();
    await f.settled();
    const tx1 = await f.db.begin();
    const tx2 = await f.db.begin();
    st.after(() => Promise.all([tx1.rollback(), tx2.rollback()]));
    assert.equal((await f.control.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()")).rows[0].n, 2);
    const other = f.worker();
    assert.equal((await other.open(1)).status, 201);
    await sleep(550);
    assert.equal(sub.done(), false);
    assert.ok(f.listener!.clients.size <= 2);
    await tx1.rollback();
    await tx2.rollback();
    assert.match((await sub.text).body, /postingWindowId/);
    assert.ok(f.listener!.clients.size <= 2);
  });

  await t.test("現在地域・退会・終了期間とstartsAt後の接続を起床時にもDBで除外", async st => {
    const f = await fixture(st);
    const moved = await f.subscribe("alice");
    const deleted = await f.subscribe("bob");
    await f.settled();
    const gate = f.gate();
    f.db.beforeCommit = gate.hold;
    const open = f.open(1);
    await gate.reached;
    const late = await f.subscribe("alice");
    // Membership writes wait on the opening Tx in production. Stop delivery
    // here so the committed membership state can be rechecked deterministically.
    f.listener!.stop();
    const pollGate = f.gate();
    f.db.afterSelect = pollGate.hold;
    await pollGate.reached;
    gate.release();
    assert.equal((await open).status, 201);
    await f.control.query("UPDATE users SET region='europe' WHERE id='alice'");
    await f.control.query("UPDATE users SET status='deleted' WHERE id='bob'");
    f.db.afterSelect = async () => {};
    pollGate.release();
    assert.equal((await moved.text).body, "");
    assert.equal((await deleted.text).body, "");
    assert.equal((await late.text).body, "");
    await f.control.query("UPDATE users SET region='asia', status='active'");
    const before = await f.subscribe();
    await f.settled();
    f.listener!.stop();
    f.db.beforeCommit = async () => {};
    assert.equal((await f.open(2)).status, 201);
    await f.control.query("UPDATE posting_windows SET ended_at=clock_timestamp() WHERE ended_at IS NULL");
    f.listener!.wake();
    await sleep(550);
    assert.equal(before.done(), false);
  });

  await t.test("startsAtからcommitまでの途中接続には送らず、以前からの接続には送る", async st => {
    const f = await fixture(st);
    const early = await f.subscribe();
    await f.settled();
    const gate = f.gate();
    f.db.beforeCommit = gate.hold;
    const opening = f.open(1);
    await gate.reached;
    const late = await f.subscribe();
    gate.release();
    assert.equal((await opening).status, 201);
    assert.match((await early.text).body, /postingWindowId/);
    await sleep(550);
    assert.equal(late.done(), false);
  });

  await t.test("複数workerとworker再生成、snapshot/reset後も新しい期間だけ配信", async st => {
    const f = await fixture(st);
    await f.control.query(await readFile(new URL("../../sql/003-initial-snapshot.sql", import.meta.url), "utf8"));
    const second = f.worker();
    const firstSub = await f.subscribe();
    const secondSub = await second.subscribe();
    await f.settled();
    await f.settled(second);
    assert.equal((await f.open(1)).status, 201);
    const bodies = await Promise.all([firstSub.text, secondSub.text]);
    assert.equal(bodies[0].body, bodies[1].body);
    assert.ok(f.listener!.clients.size <= 2 && second.listener!.clients.size <= 2);
    await second.close();
    assert.equal(second.listener!.clients.size, 0);
    assert.equal(second.listener!.disposed, true);
    const restarted = f.worker();
    const postRestart = await restarted.subscribe();
    const postReset = await f.subscribe();
    await f.control.query(await readFile(new URL("../../sql/reset.sql", import.meta.url), "utf8"));
    assert.equal((await f.control.query("SELECT count(*)::int AS n FROM notifications")).rows[0].n, 0);
    assert.equal((await f.open(1)).status, 201);
    assert.match((await postRestart.text).body, /postingWindowId/);
    assert.match((await postReset.text).body, /postingWindowId/);
  });

  await t.test("別Nodeプロセスの2workerへHTTP SSE配信し、終了・再起動後にも配信", async st => {
    const f = await fixture(st);
    const processes: ReturnType<typeof fork>[] = [];
    st.after(async () => {
      for (const child of processes) {
        if (child.exitCode !== null) continue;
        const exit = once(child, "exit");
        child.kill("SIGTERM");
        await exit;
      }
    });
    async function spawnWorker() {
      const child = fork(new URL("./fixtures/notification-worker.ts", import.meta.url), [String(port), f.database],
        { stdio: ["ignore", "ignore", "inherit", "ipc"] });
      processes.push(child);
      const [{ port: httpPort }] = await once(child, "message");
      return { child, subscribe: () => fetch(`http://127.0.0.1:${httpPort}/notifications`).then(response => response.text()) };
    }
    const first = await spawnWorker();
    const second = await spawnWorker();
    const subscribers = [first.subscribe(), second.subscribe()];
    await until(async () => (await f.control.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()")).rows[0].n === 2);
    await sleep(30);
    assert.equal((await f.open(1)).status, 201);
    const bodies = await Promise.all(subscribers);
    assert.equal(bodies[0], bodies[1]);
    assert.equal((bodies[0].match(/data:/g) ?? []).length, 1);
    const exited = once(first.child, "exit");
    first.child.kill("SIGTERM");
    await exited;
    const restarted = await spawnWorker();
    const next = restarted.subscribe();
    await sleep(100);
    assert.equal((await f.open(2)).status, 201);
    assert.match(await next, /postingWindowId/);
  });

  await t.test("commit→SSE本文受信を通常pollと比較（ローカル、scoreとは別）", async st => {
    const samples: Record<string, number[]> = { poll: [], notify: [] };
    const upper: Record<string, number[]> = { poll: [], notify: [] };
    const commitRTT: Record<string, number[]> = { poll: [], notify: [] };
    for (const mode of ["poll", "notify", "notify", "poll"] as const) {
      const f = await fixture(st, mode);
      const server = serve({ fetch: f.app.fetch, hostname: "127.0.0.1", port: 0 });
      await once(server, "listening");
      const address = server.address();
      assert.ok(address && typeof address !== "string");
      st.after(() => { if ("closeAllConnections" in server) server.closeAllConnections(); server.close(); });
      for (let i = 1; i <= 4; i++) {
        const pollsBefore = f.db.polls;
        const received = fetch(`http://127.0.0.1:${address.port}/notifications`).then(async response => {
          assert.match(await response.text(), /postingWindowId/);
          return performance.now();
        });
        await until(() => f.db.polls > pollsBefore);
        await sleep(30);
        await sleep(i * 35);
        assert.equal((await f.open(i)).status, 201);
        const receivedAt = await received;
        // Actual DB commit lies between request send and acknowledgement.
        // Record both endpoints; do not label the acknowledgement as DB commit.
        samples[mode].push(receivedAt - f.db.commitAfter);
        upper[mode].push(receivedAt - f.db.commitBefore);
        commitRTT[mode].push(f.db.commitAfter - f.db.commitBefore);
      }
    }
    const summary = (values: number[]) => {
      const ordered = [...values].sort((a,b) => a-b);
      return { n: values.length, median: (ordered[3] + ordered[4]) / 2, min: ordered[0], max: ordered.at(-1) };
    };
    st.diagnostic(JSON.stringify({ metric: "DB commit -> loopback HTTP SSE body received (ms), lower/upper bounds from COMMIT send/ack",
      poll: { lower: summary(samples.poll), upper: summary(upper.poll) },
      notify: { lower: summary(samples.notify), upper: summary(upper.notify) }, commitRTTms: commitRTT }));
    assert.ok(summary(samples.notify).median < summary(samples.poll).median);
  });
});
