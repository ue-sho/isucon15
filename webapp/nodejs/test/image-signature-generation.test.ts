import assert from "node:assert/strict";
import { execFile, fork, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { promisify } from "node:util";
import pg from "pg";
import { referenceImageSignature } from "./image-signature-cache-reference.ts";

// Opt-in only. Always starts its own loopback-only PG16 container with a fixed
// test database; no database URL, host, credentials, or production env is used.
const enabled = process.env.IMAGE_SIGNATURE_GENERATION_TEST === "1";
const docker = promisify(execFile);
const database = "image_signature_generation_test";
const regions = ["asia", "europe", "america"] as const;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function within<T>(promise: PromiseLike<T>, ms = 10000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("isolated generation test timed out")), ms);
    })]);
  } finally { clearTimeout(timer); }
}

type Reply = { id?: number; ready?: boolean; error?: string; pid?: number; status?: number;
  hmacCalls?: number; queries?: number; body?: string; contentType?: string; closed?: boolean };

class Worker {
  readonly child: ChildProcess;
  readonly ready: Promise<Reply>;
  readonly region: string;
  #sequence = 0;
  #pending = new Map<number, { resolve: (reply: Reply) => void; reject: (error: Error) => void }>();
  #stderr = "";
  constructor(region: string, port: number, wall: number) {
    this.region = region;
    this.child = fork(fileURLToPath(new URL("./fixtures/image-signature-worker.ts", import.meta.url)), [], {
      execArgv: [], stdio: ["ignore", "ignore", "pipe", "ipc"],
      env: { PATH: process.env.PATH, SIGNATURE_FIXTURE_PORT: String(port),
        SIGNATURE_FIXTURE_WALL: String(wall), SIGNATURE_FIXTURE_REGION: region },
    });
    this.child.stderr?.on("data", (chunk: Buffer) => { this.#stderr = (this.#stderr + chunk.toString()).slice(-2000); });
    this.ready = new Promise<Reply>((resolve, reject) => {
      this.child.on("message", (reply: Reply) => {
        if (reply.ready) { resolve(reply); return; }
        const pending = this.#pending.get(reply.id!);
        if (!pending) return;
        this.#pending.delete(reply.id!);
        if (reply.error) pending.reject(new Error(reply.error));
        else pending.resolve(reply);
      });
      this.child.once("error", reject);
      this.child.once("exit", (code, signal) => {
        const error = new Error(`fixture exited ${code}/${signal}: ${this.#stderr}`);
        reject(error);
        for (const pending of this.#pending.values()) pending.reject(error);
        this.#pending.clear();
      });
    });
  }
  command(command: { op: "request"; path: string; token?: string } | { op: "unscoped" } | { op: "close" }): Promise<Reply> {
    const id = ++this.#sequence;
    return within(new Promise<Reply>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.child.send({ ...command, id }, (error) => {
        if (error) { this.#pending.delete(id); reject(error); }
      });
    }));
  }
  async close(): Promise<void> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    try { await this.command({ op: "close" }); }
    finally { if (this.child.connected) this.child.disconnect(); this.child.kill(); }
  }
}

test("signature cache generations / six isolated workers and real PostgreSQL reset", { skip: !enabled, timeout: 120000 }, async (t) => {
  const container = `isucon15-signature-generation-${randomUUID()}`;
  let admin: pg.Client | undefined;
  const workers: Worker[] = [];
  await docker("docker", ["run", "--detach", "--rm", "--name", container,
    "--label", "isucon15.test=image-signature-generation", "--publish", "127.0.0.1::5432",
    "--tmpfs", "/var/lib/postgresql/data", "--env", "POSTGRES_HOST_AUTH_METHOD=trust",
    "--env", `POSTGRES_DB=${database}`, "postgres:16",
    "-c", "statement_timeout=10000", "-c", "log_statement=none"], { timeout: 20000 });
  t.after(async () => {
    await Promise.allSettled(workers.map((worker) => worker.close()));
    await admin?.end();
    await docker("docker", ["stop", "--time", "1", container], { timeout: 10000 });
  });
  const { stdout: binding } = await docker("docker", ["port", container, "5432/tcp"]);
  const port = Number(binding.trim().split(":").at(-1));
  assert.ok(port > 0);
  const connection = { host: "127.0.0.1", port, user: "postgres", database };
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    const probe = new pg.Client(connection);
    try { await probe.connect(); ready = true; } catch { /* container is starting */ }
    finally { await probe.end(); }
    if (ready) break;
    await sleep(100);
  }
  assert.ok(ready, "the disposable PostgreSQL must start");
  admin = new pg.Client(connection);
  await admin.connect();
  assert.match((await admin.query("SHOW server_version")).rows[0].server_version, /^16\./);
  await admin.query(await readFile(new URL("../../sql/001-schema.sql", import.meta.url), "utf8"));
  await t.test("real migrations preserve application ownership, reject duplicate up, and support down/up", async () => {
    // pg rejects errors itself. Remove only psql's error-stop directive; retain
    // the transaction, timeouts, SET LOCAL ROLE, and all DDL exactly as shipped.
    async function migration(name: "up" | "down") {
      const source = await readFile(new URL(`../../sql/migrations/20261031-image-signature-cache-state.${name}.sql`, import.meta.url), "utf8");
      const sql = source.replace(/^\\set ON_ERROR_STOP on\r?\n/gm, "");
      assert.doesNotMatch(sql, /^\\/m, "unexpected psql directive must not be silently ignored");
      return sql;
    }
    const up = await migration("up");
    const down = await migration("down");
    await admin!.query("CREATE ROLE isureal LOGIN; GRANT CREATE ON SCHEMA public TO isureal");
    // Simulate an existing deployment that predates the new table.
    await admin!.query("DROP TABLE image_signature_cache_state");
    await admin!.query(up);
    const owner = async () => (await admin!.query("SELECT pg_get_userbyid(relowner) AS owner FROM pg_class WHERE oid='image_signature_cache_state'::regclass")).rows[0].owner;
    assert.equal(await owner(), "isureal", "running the migration as postgres must not create a postgres-owned state table");
    await admin!.query("BEGIN; SET LOCAL ROLE isureal");
    try {
      assert.equal((await admin!.query("SELECT current_user AS role")).rows[0].role, "isureal");
      assert.equal((await admin!.query("SELECT generation::text FROM image_signature_cache_state WHERE singleton")).rows[0].generation, "1");
      assert.equal((await admin!.query("UPDATE image_signature_cache_state SET generation=generation+1 WHERE singleton RETURNING generation::text")).rows[0].generation, "2");
    } finally { await admin!.query("ROLLBACK"); }
    await assert.rejects(admin!.query(up), (error: unknown) => (error as { code?: string }).code === "42P07");
    await admin!.query("ROLLBACK");
    assert.equal(await owner(), "isureal");
    assert.equal((await admin!.query("SELECT generation::text FROM image_signature_cache_state WHERE singleton")).rows[0].generation, "1");
    await admin!.query("SET ROLE isureal");
    try { await admin!.query(down); }
    finally { await admin!.query("RESET ROLE"); }
    assert.equal((await admin!.query("SELECT to_regclass('image_signature_cache_state') AS relation")).rows[0].relation, null);
    await admin!.query(up);
    assert.equal(await owner(), "isureal");
  });
  for (const region of regions) {
    await admin.query(`INSERT INTO users(id,username,secret_key_hash,display_name,profile_image_id,region,created_at)
      VALUES($1::text,$1::text,repeat('ab',32),$1::text,$2,$3,'2026-10-01')`, [`user-${region}`, `profile-${region}`, region]);
    await admin.query(`INSERT INTO image_objects(id,owner_user_id,data,media_type,created_at)
      VALUES($1,$2,decode('010203','hex'),'image/jpeg','2026-10-01')`, [`profile-${region}`, `user-${region}`]);
  }
  await admin.query(await readFile(new URL("../../sql/003-initial-snapshot.sql", import.meta.url), "utf8"));
  const resetSQL = await readFile(new URL("../../sql/reset.sql", import.meta.url), "utf8");
  const generation = async () => (await admin!.query("SELECT generation::text FROM image_signature_cache_state WHERE singleton")).rows[0].generation as string;
  assert.equal(await generation(), "1");
  const seedSessions = async () => {
    for (const region of regions) {
      const token = `session-${region}`;
      await admin!.query(`INSERT INTO login_sessions(id,user_id,token_hash) VALUES($1,$2,$3)`,
        [token, `user-${region}`, createHash("sha256").update(token).digest("hex")]);
    }
  };
  await seedSessions();
  const wall = Math.floor(Date.now() / 1000) * 1000;
  const exp = wall / 1000 + 86400;
  const imagePath = (region: string) => `/api/images/profile-${region}?exp=${exp}&sig=${referenceImageSignature(Buffer.from("ab".repeat(32), "hex"), `profile-${region}`, exp).toString("base64url")}`;
  async function spawnWorker(region: string) {
    const worker = new Worker(region, port, wall);
    workers.push(worker);
    await within(worker.ready);
    return worker;
  }
  for (const region of regions) for (let i = 0; i < 2; i++) await spawnWorker(region);
  assert.equal(new Set((await Promise.all(workers.map((worker) => worker.ready))).map((reply) => reply.pid)).size, 6);

  async function request(worker: Worker, kind: "me" | "image", expectedHmac: number, expectedStatus = 200) {
    const reply = await worker.command({ op: "request", path: kind === "me" ? "/api/me" : imagePath(worker.region), token: `session-${worker.region}` });
    assert.equal(reply.status, expectedStatus, `${worker.region} ${kind}: ${reply.body}`);
    assert.equal(reply.hmacCalls, expectedHmac, `${worker.region} ${kind}: crypto calls`);
    assert.equal(reply.queries, expectedStatus === 500 ? 1 : 2, "no separate generation round trip");
    if (expectedStatus === 200) {
      if (kind === "image") assert.equal(reply.body, "010203");
      else assert.equal(JSON.parse(reply.body!).profileImageUrl, imagePath(worker.region));
    }
  }
  async function coldThenWarm(worker: Worker, first: "me" | "image") {
    await request(worker, first, 1000);
    await request(worker, first, 0);
    await request(worker, first === "me" ? "image" : "me", 0);
  }

  await t.test("six processes warm through real authentication and owner lookups", async () => {
    for (let i = 0; i < 6; i++) await coldThenWarm(workers[i], i % 2 ? "image" : "me");
  });
  await t.test("one real reset invalidates every worker without restarting processes", async () => {
    await admin!.query(resetSQL);
    assert.equal(await generation(), "2");
    await seedSessions();
    for (let i = 0; i < 6; i++) await coldThenWarm(workers[i], i % 2 ? "me" : "image");
  });
  await t.test("an idle worker and a newly started worker observe the reset on first use", async () => {
    await admin!.query(resetSQL);
    assert.equal(await generation(), "3");
    await seedSessions();
    await coldThenWarm(workers[0], "me");
    await coldThenWarm(workers[5], "image");
    await coldThenWarm(await spawnWorker("europe"), "me");
  });
  await t.test("missing generation bypasses cache reuse and makes reset fail before data changes", async () => {
    await admin!.query("DELETE FROM image_signature_cache_state WHERE singleton");
    try {
      await assert.rejects(admin!.query(resetSQL), /image signature cache generation is missing/);
      await admin!.query("ROLLBACK");
      assert.equal((await admin!.query("SELECT count(*)::integer AS count FROM login_sessions")).rows[0].count, 3,
        "a missing generation must abort reset before sessions are truncated");
      for (const kind of ["image", "me", "image", "me"] as const) await request(workers[0], kind, 1000);
      for (let i = 0; i < 2; i++) assert.equal((await workers[0].command({ op: "unscoped" })).hmacCalls, 1000);
    } finally {
      await admin!.query("INSERT INTO image_signature_cache_state(singleton,generation) VALUES(true,4)");
    }
    await coldThenWarm(workers[0], "image");
  });
  await t.test("generation SQL failure fails closed instead of falling back to cached signatures", async () => {
    await admin!.query("ALTER TABLE image_signature_cache_state RENAME TO signature_state_unavailable");
    try {
      await request(workers[0], "image", 0, 500);
      await request(workers[0], "me", 0, 500);
    } finally {
      await admin!.query("ALTER TABLE signature_state_unavailable RENAME TO image_signature_cache_state");
    }
    await request(workers[0], "image", 0);
  });
  await t.test("a failed reset rolls back its generation increment and data changes together", async () => {
    assert.match(resetSQL, /COMMIT;/);
    await assert.rejects(admin!.query(resetSQL.replace(/COMMIT;/, "SELECT 1/0; COMMIT;")), /division by zero/);
    await admin!.query("ROLLBACK");
    assert.equal(await generation(), "4");
    assert.equal((await admin!.query("SELECT count(*)::integer AS count FROM login_sessions")).rows[0].count, 3);
    await request(workers[0], "me", 0);
  });
  await t.test("two real resets serialize at the generation row and both commit", async () => {
    const locker = new pg.Client(connection);
    const first = new pg.Client(connection);
    const second = new pg.Client(connection);
    await Promise.all([locker.connect(), first.connect(), second.connect()]);
    try {
      await locker.query("BEGIN");
      await locker.query("SELECT generation FROM image_signature_cache_state WHERE singleton FOR UPDATE");
      const pids = await Promise.all([first, second].map(async (client) => (await client.query("SELECT pg_backend_pid() AS pid")).rows[0].pid as number));
      const resets = Promise.all([first.query(resetSQL), second.query(resetSQL)]);
      // Attach a rejection handler immediately while we inspect the deterministic lock barrier.
      void resets.catch(() => {});
      let waiting = false;
      for (let i = 0; i < 100; i++) {
        const result = await admin!.query("SELECT count(*)::integer AS count FROM pg_stat_activity WHERE pid=ANY($1::int[]) AND wait_event_type='Lock'", [pids]);
        if (result.rows[0].count === 2) { waiting = true; break; }
        await sleep(20);
      }
      assert.ok(waiting, "both resets must wait for the shared generation lock");
      await locker.query("COMMIT");
      await within(resets);
      assert.equal(await generation(), "6");
      await seedSessions();
      await coldThenWarm(workers[0], "image");
    } finally {
      await locker.query("ROLLBACK");
      await Promise.all([locker.end(), first.end(), second.end()]);
    }
  });
});
