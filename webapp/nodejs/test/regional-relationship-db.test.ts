import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { promisify } from "node:util";
import { serve } from "@hono/node-server";
import pg from "pg";
import { DB, type Tx } from "../src/db.ts";
import { newServer } from "../src/server.ts";
import { sha256Hex } from "../src/session.ts";
import { regionalNginx } from "./helpers/regional-nginx.ts";

const docker = promisify(execFile);
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
type Region = "asia" | "europe" | "america";
type User = { id: string; region: Region };
type Reply = { status: number; body: any };
type Hook = (sql: string, args: unknown[], pid: number) => Promise<void>;

// 自分専用のPG16を起動・破棄するopt-in。外部DB URLや実サービスのenvは受け付けない。
test("関係更新の地域転送 / 実nginx・認証・隔離PostgreSQL 16", {
  skip: process.env.REGIONAL_RELATIONSHIP_TEST !== "1", timeout: 120000,
}, async (t) => {
  const container = "isu15-regional-relationships-" + randomUUID();
  const servers: ReturnType<typeof serve>[] = [];
  const databases: DB[] = [];
  const proxies: Awaited<ReturnType<typeof regionalNginx>>[] = [];
  let admin: pg.Client | undefined, started = false;
  t.after(async () => {
    await Promise.allSettled(proxies.map((proxy) => proxy.close()));
    await Promise.all(servers.map((server) => new Promise<void>((resolve) => {
      server.close(() => resolve());
      if ("closeAllConnections" in server) server.closeAllConnections();
    })));
    await Promise.allSettled(databases.map((db) => db.end()));
    await admin?.end();
    if (started) await docker("docker", ["stop", "--time", "1", container]);
  });
  await docker("docker", ["run", "--detach", "--rm", "--name", container,
    "--publish", "127.0.0.1::5432", "--tmpfs", "/var/lib/postgresql/data",
    "--env", "POSTGRES_HOST_AUTH_METHOD=trust", "--env", "POSTGRES_DB=relationships_test",
    "postgres:16", "-c", "statement_timeout=10000"]);
  started = true;
  const published = await docker("docker", ["port", container, "5432/tcp"]);
  const port = Number(published.stdout.trim().split(":").at(-1));
  const connection = { host: "127.0.0.1", port, user: "postgres", database: "relationships_test" };
  for (let attempt = 0; attempt < 100; attempt++) {
    const client = new pg.Client(connection);
    try { await client.connect(); admin = client; break; }
    catch { await client.end(); await pause(50); }
  }
  assert.ok(admin, "disposable PostgreSQL did not start");
  const control = admin;
  await control.query(await readFile(new URL("../../sql/001-schema.sql", import.meta.url), "utf8"));
  const config = { region: "asia", logLevel: "error", dbHost: connection.host, dbPort: String(port),
    dbUser: "postgres", dbPassword: "", dbName: connection.database };
  // newServerが生成した実DBを閉じ、競合時だけ実Txのロック取得後に待合せを入れる。
  const ping = DB.prototype.ping;
  t.mock.method(DB.prototype, "ping", async function(this: DB) { databases.push(this); await ping.call(this); });
  const hooks = new Map<DB, Hook>();
  const begin = DB.prototype.begin;
  t.mock.method(DB.prototype, "begin", async function(this: DB) {
    const tx = await begin.call(this), hook = hooks.get(this);
    if (!hook) return tx;
    const { pid } = (await tx.get<{ pid: number }>("SELECT pg_backend_pid() AS pid"))!;
    return new Proxy(tx, { get(target, key) {
      const method = Reflect.get(target, key, target);
      if (typeof method !== "function") return method;
      if (key !== "get") return method.bind(target);
      return async (sql: string, ...args: unknown[]) => {
        const row = await target.get(sql, ...args);
        await hook(sql, args, pid);
        return row;
      };
    } }) as Tx;
  });
  const local = new Map<Region, { url: string; db: DB; port: number }>();
  const near = new Map<Region, { url: string; db: DB; port: number }>();
  async function app(region: Region) {
    const handler = await newServer({ ...config, region }, 2);
    const db = databases.at(-1)!;
    const server = serve({ fetch: handler.fetch, hostname: "127.0.0.1", port: 0 });
    servers.push(server);
    if (!server.listening) await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    return { url: `http://127.0.0.1:${address.port}`, db, port: address.port };
  }
  for (const region of ["asia", "europe", "america"] as const) local.set(region, await app(region));
  const edges = new Map<Region, string>([["asia", local.get("asia")!.url]]);
  for (const region of ["europe", "america"] as const) {
    near.set(region, await app(region));
    const proxy = await regionalNginx(region === "europe" ? "europe1" : "america1", local.get(region)!.port, near.get(region)!.port);
    proxies.push(proxy); edges.set(region, proxy.url);
  }
  let serial = 0;
  async function user(region: Region, certified = false): Promise<User> {
    const id = `fixture-${String(++serial).padStart(4, "0")}`;
    await control.query("INSERT INTO users(id,username,secret_key_hash,display_name,region,account_type) VALUES($1::text,$1::text,repeat('ab',32),$1::text,$2,$3)", [id, region, certified ? "certified_public" : "regular"]);
    await control.query("INSERT INTO login_sessions(id,user_id,token_hash) VALUES($1::text,$1::text,$2)", [id, sha256Hex(id)]);
    return { id, region };
  }
  async function request(actor: User, path: string, method = "GET", data?: unknown, url = edges.get(actor.region)!, headers: Record<string, string> = {}): Promise<Reply> {
    const response = await fetch(url + path, { method, signal: AbortSignal.timeout(10000),
      headers: { Authorization: `Bearer ${actor.id}`, "X-Client-IP": "203.0.113.7", "X-Country-Code": actor.region === "europe" ? "GB" : "US",
        ...(data === undefined ? {} : { "Content-Type": "application/json" }), ...headers },
      body: data === undefined ? undefined : JSON.stringify(data) });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  }
  const send = (a: User, b: User, url?: string) => request(a, "/api/friend-requests", "POST", { recipientId: b.id }, url);
  const action = (a: User, id: string, verb: string) => request(a, `/api/friend-requests/${id}/${verb}`, "POST");
  async function expect(response: Promise<Reply>, status: number, error?: string) {
    const result = await response;
    assert.equal(result.status, status, JSON.stringify(result));
    if (error) assert.equal(result.body.error, error);
    return result.body;
  }
  async function list(actor: User, kind: string) {
    return (await expect(request(actor, `/api/relationships/${kind}`), 200)).items as { relationId: string; user: { id: string } }[];
  }
  async function count(table: string, a: User, b: User) {
    const columns = { friendships: ["user_low_id", "user_high_id"], friend_requests: ["requester_id", "recipient_id"],
      follows: ["follower_id", "followee_id"], block_relations: ["blocker_id", "blocked_id"] }[table]!;
    return Number((await control.query(`SELECT count(*) FROM ${table} WHERE (${columns[0]}=$1 AND ${columns[1]}=$2) OR (${columns[0]}=$2 AND ${columns[1]}=$1)`, [a.id, b.id])).rows[0].count);
  }

  for (const region of ["europe", "america"] as const) {
    await t.test(`${region}: 全9更新・認証・地域拒否・他地域の即時読取`, async () => {
      const actor = await user(region), peer = await user("asia"), publicUser = await user("asia", true);
      const foreign = await user(region === "europe" ? "america" : "europe");
      const updates = [["/api/friend-requests", "POST"],
        ...["accept", "reject", "cancel"].map((verb) => [`/api/friend-requests/id/${verb}`, "POST"]),
        [`/api/friendships/${peer.id}`, "DELETE"],
        ...["follows", "blocks"].flatMap((kind) => ["PUT", "DELETE"].map((method) => [`/api/${kind}/${peer.id}`, method]))];
      for (const [path, method] of updates) {
        for (const authorization of ["", "Bearer invalid"]) {
          await expect(request(actor, path!, method!, { recipientId: peer.id }, undefined, { Authorization: authorization }), 401, "invalid_session");
        }
        await expect(request(foreign, path!, method!, { recipientId: peer.id }, edges.get(region)), 403, "region_mismatch");
      }
      // 国コードによってDB由来の地域を上書きできない。
      await expect(request(actor, `/api/follows/${publicUser.id}`, "PUT", undefined, undefined, { "X-Country-Code": "JP" }), 204);
      assert.deepEqual((await list(publicUser, "followers")).map((item) => item.user.id), [actor.id]);
      await expect(request(actor, `/api/follows/${publicUser.id}`, "DELETE"), 204);
      assert.deepEqual(await list(publicUser, "followers"), []);
      const pending = await expect(send(actor, peer), 201);
      assert.equal(pending.status, "pending");
      assert.equal((await list(peer, "incoming-requests"))[0]?.relationId, pending.relationId);
      await expect(action(peer, pending.relationId, "accept"), 200);
      assert.deepEqual((await list(peer, "friends")).map((item) => item.user.id), [actor.id]);
      await expect(request(actor, `/api/friendships/${peer.id}`, "DELETE"), 204);
      assert.deepEqual(await list(peer, "friends"), []);
      const incoming = await expect(send(peer, actor), 201);
      await expect(action(actor, incoming.relationId, "accept"), 200);
      assert.deepEqual((await list(peer, "friends")).map((item) => item.user.id), [actor.id]);
      await expect(request(actor, `/api/friendships/${peer.id}`, "DELETE"), 204);
      const rejected = await expect(send(peer, actor), 201);
      assert.equal((await expect(action(actor, rejected.relationId, "reject"), 200)).status, "rejected");
      assert.deepEqual(await list(peer, "outgoing-requests"), []);
      const cancelled = await expect(send(actor, peer), 201);
      assert.equal((await expect(action(actor, cancelled.relationId, "cancel"), 200)).status, "cancelled");
      assert.deepEqual(await list(peer, "incoming-requests"), []);
      await expect(request(actor, `/api/blocks/${peer.id}`, "PUT"), 204);
      await expect(send(peer, actor), 409, "relationship_conflict");
      await expect(request(actor, `/api/blocks/${peer.id}`, "DELETE"), 204);
      await expect(send(peer, actor), 201);
      for (const [path, method] of [["/api/friend-requests", "GET"], ["/api/friend-requests/id/accept", "DELETE"],
        [`/api/friendships/${peer.id}`, "PUT"], [`/api/follows/${peer.id}`, "POST"], [`/api/blocks/${peer.id}`, "PATCH"],
        ["/api/friend-requests/id/accept/extra", "POST"]]) {
        assert.deepEqual(await request(actor, path!, method!), await request(actor, path!, method!, undefined, local.get(region)!.url));
      }
      await expect(action(actor, "id", "unknown"), 403, "relationship_action_forbidden");
    });
  }

  // 時間差の推測ではなくpg_blocking_pidsで同じユーザー行の実際の待機を確認する。
  async function race(db: DB, lockedID: string, first: () => Promise<Reply>, second: () => Promise<Reply>) {
    const held = Promise.withResolvers<number>(), release = Promise.withResolvers<void>();
    let taken = false, waiter: Promise<Reply> | undefined;
    hooks.set(db, async (sql, args, pid) => {
      if (!taken && sql.includes("FROM users") && sql.includes("FOR NO KEY UPDATE") && args[0] === lockedID) {
        taken = true; held.resolve(pid); await release.promise;
      }
    });
    const holder = first();
    try {
      const pid = await Promise.race([held.promise, holder.then(() => { throw new Error("holder did not acquire expected user lock"); }),
        new Promise<never>((_, reject) => { const timer = setTimeout(() => reject(new Error("lock gate timeout")), 5000); timer.unref(); })]);
      waiter = second();
      const deadline = Date.now() + 5000;
      for (;;) {
        const result = await control.query("SELECT pid FROM pg_stat_activity WHERE wait_event_type='Lock' AND $1::int=ANY(pg_blocking_pids(pid))", [pid]);
        if (result.rowCount) break;
        assert.ok(Date.now() < deadline, "expected real PostgreSQL lock contention");
        await pause(10);
      }
      release.resolve();
      return await Promise.all([holder, waiter]);
    } finally {
      release.resolve(); hooks.delete(db);
      await Promise.allSettled([holder, ...(waiter ? [waiter] : [])]);
    }
  }

  await t.test("同向き申請: 転送先と旧地域プロセスが競合してもpendingは1件", async () => {
    const a = await user("europe"), b = await user("america");
    const replies = await race(near.get("europe")!.db, b.id, () => send(a, b), () => send(a, b, local.get("europe")!.url));
    assert.deepEqual(replies.map((r) => r.status), [201, 409]);
    assert.equal(await count("friend_requests", a, b), 1);
    assert.equal((await list(b, "incoming-requests")).length, 1);
  });
  await t.test("逆向き申請: 両地域の転送先が競合してもfriendshipは1件", async () => {
    const a = await user("europe"), b = await user("america");
    const replies = await race(near.get("europe")!.db, b.id, () => send(a, b), () => send(b, a));
    assert.deepEqual(replies.map((r) => [r.status, r.body.status]), [[201, "pending"], [201, "accepted"]]);
    assert.equal(await count("friend_requests", a, b), 1);
    assert.equal(await count("friendships", a, b), 1);
    assert.deepEqual((await list(b, "friends")).map((i) => i.user.id), [a.id]);
  });
  for (const blockFirst of [false, true]) {
    await t.test(`acceptとblock: ${blockFirst ? "block" : "accept"}が先にロック`, async () => {
      const a = await user("europe"), b = await user("america");
      const pending = await expect(send(a, b), 201);
      const accept = () => action(b, pending.relationId, "accept");
      const block = () => request(a, `/api/blocks/${b.id}`, "PUT");
      const replies = await race(near.get(blockFirst ? "europe" : "america")!.db, b.id,
        blockFirst ? block : accept, blockFirst ? accept : block);
      assert.deepEqual(replies.map((r) => r.status), blockFirst ? [204, 403] : [200, 204]);
      assert.equal(await count("friendships", a, b), 0);
      assert.equal(await count("block_relations", a, b), 1);
      assert.deepEqual(await list(b, "friends"), []);
    });
    await t.test(`followとblock: ${blockFirst ? "block" : "follow"}が先にロック`, async () => {
      const a = await user("europe"), b = await user("america", true);
      const follow = () => request(a, `/api/follows/${b.id}`, "PUT");
      const block = () => request(b, `/api/blocks/${a.id}`, "PUT");
      const replies = await race(near.get(blockFirst ? "america" : "europe")!.db, b.id,
        blockFirst ? block : follow, blockFirst ? follow : block);
      assert.deepEqual(replies.map((r) => r.status), blockFirst ? [204, 409] : [204, 204]);
      assert.equal(await count("follows", a, b), 0);
      assert.equal(await count("block_relations", a, b), 1);
      assert.deepEqual(await list(b, "followers"), []);
    });
    await t.test(`退会と申請: ${blockFirst ? "退会" : "申請"}が先にロック`, async () => {
      const a = await user("europe"), b = await user("america");
      const create = () => send(a, b);
      const remove = () => request(b, "/api/me/account-deletion", "POST");
      const replies = await race(blockFirst ? local.get("america")!.db : near.get("europe")!.db, b.id,
        blockFirst ? remove : create, blockFirst ? create : remove);
      assert.deepEqual(replies.map((r) => r.status), blockFirst ? [204, 404] : [201, 204]);
      assert.equal((await control.query("SELECT status FROM users WHERE id=$1", [b.id])).rows[0].status, "deleted");
      assert.deepEqual(await list(a, "outgoing-requests"), []);
      await expect(send(a, b), 404, "relationship_not_found");
    });
  }
});
