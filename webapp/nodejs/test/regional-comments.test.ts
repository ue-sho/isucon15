import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { test } from "node:test";
import { promisify } from "node:util";
import { serve } from "@hono/node-server";
import pg from "pg";
import { DB } from "../src/db.ts";
import { newServer } from "../src/server.ts";
import { sha256Hex } from "../src/session.ts";
import { commentsNginx } from "./helpers/comments-nginx.ts";
import { delayedTCP } from "./helpers/delayed-tcp.ts";

const docker = promisify(execFile);
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const enabled = process.env.REGIONAL_COMMENTS_TEST === "1";
const regions = ["europe", "america"] as const;
type Region = typeof regions[number];
const host = (region: Region) => region === "europe" ? "europe1" : "america1";
async function listen(server: Server) {
  if (!server.listening) await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "0.0.0.0", resolve); });
  const address = server.address(); assert.ok(address && typeof address !== "string"); return address.port;
}
async function close(server: Server) {
  await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });
}

for (const region of regions) test(`${region}: 実nginxのPOST限定・転送情報・切断/503の再送禁止`, { skip: !enabled }, async (t) => {
  const calls = { local: [] as string[], regional: [] as string[] };
  function backend(label: keyof typeof calls) {
    return createServer(async (req, res) => {
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk);
      calls[label].push(req.url!);
      if (req.url!.endsWith("disconnect=1")) { req.socket.destroy(); return; }
      res.writeHead(req.url!.endsWith("unavailable=1") ? 503 : 200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ label, uri: req.url, method: req.method, headers: req.headers, body: Buffer.concat(chunks).toString() }));
    });
  }
  const local = backend("local"), regional = backend("regional");
  t.after(async () => { await Promise.all([close(local), close(regional)]); });
  const localPort = await listen(local), regionalPort = await listen(regional);
  const edge = await commentsNginx(host(region), localPort, regionalPort, { backupPort: localPort });
  t.after(() => edge.close());
  const headers = { Authorization: "Bearer fixture", "X-Client-IP": "203.0.113.7", "X-Country-Code": region === "europe" ? "GB" : "US",
    "X-Region": "asia", "X-Forwarded-For": "198.51.100.9", "Content-Type": "application/json" };
  const path = "/api/posts/post%2Did/comments?cursor=a%2Fb&x=1&x=2";
  const body = JSON.stringify({ body: "日本語 é 🙂" + "x".repeat(20000) });
  const response = await fetch(edge.url + path, { method: "POST", headers, body });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.label, "regional"); assert.equal(result.uri, path); assert.equal(result.method, "POST"); assert.equal(result.body, body);
  for (const [key, value] of Object.entries(headers)) assert.equal(result.headers[key.toLowerCase()], value);
  assert.equal(result.headers.host, "127.0.0.1"); // 既存のproxy_set_header Host $host（port除去）。
  for (const method of ["GET", "HEAD", "DELETE", "PUT", "PATCH", "OPTIONS"]) {
    const before = calls.local.length;
    const reply = await fetch(edge.url + path, { method, headers }); await reply.arrayBuffer();
    assert.equal(calls.local.length, before + 1, method);
  }
  for (const path of ["/api/posts", "/api/posts/id", "/api/posts/id/comments/", "/api/posts/id/comments/extra",
    "/api/posts/id/realmojis", "/api/comments/id", "/api/realmojis/id", "/api/posts/a/b/comments"]) {
    const reply = await fetch(edge.url + path, { method: "POST", headers, body });
    assert.equal((await reply.json()).label, "local", path);
  }
  for (const [query, status] of [["disconnect=1", 502], ["unavailable=1", 503]] as const) {
    const beforeLocal = calls.local.length, beforeRegional = calls.regional.length;
    const reply = await fetch(edge.url + "/api/posts/id/comments?" + query, { method: "POST", headers, body });
    assert.equal(reply.status, status); await reply.arrayBuffer();
    assert.equal(calls.regional.length, beforeRegional + 1); assert.equal(calls.local.length, beforeLocal);
  }
});

test("コメント地域転送: 隔離PG16・旧新応答一致・模擬RTT比較", { skip: !enabled, timeout: 180000 }, async (t) => {
  const container = "isu15-comments-pg-" + randomUUID();
  const servers: Server[] = [], databases: DB[] = [];
  const edges: Awaited<ReturnType<typeof commentsNginx>>[] = [], links: Awaited<ReturnType<typeof delayedTCP>>[] = [];
  let admin: pg.Client | undefined, started = false;
  t.after(async () => {
    await Promise.allSettled(edges.map((edge) => edge.close()));
    await Promise.allSettled(servers.map(close));
    await Promise.allSettled(databases.map((db) => db.end()));
    await Promise.allSettled(links.map((link) => link.close()));
    await admin?.end();
    if (started) await docker("docker", ["stop", "--time", "1", container]);
  });
  await docker("docker", ["run", "--detach", "--rm", "--name", container, "--publish", "127.0.0.1::5432", "--tmpfs", "/var/lib/postgresql/data",
    "--env", "POSTGRES_HOST_AUTH_METHOD=trust", "--env", "POSTGRES_DB=comments_test", "postgres:16", "-c", "statement_timeout=10000"]);
  started = true;
  const port = Number((await docker("docker", ["port", container, "5432/tcp"])).stdout.trim().split(":").at(-1));
  for (let attempt = 0; attempt < 100; attempt++) {
    const client = new pg.Client({ host: "127.0.0.1", port, user: "postgres", database: "comments_test" });
    try { await client.connect(); admin = client; break; } catch { await client.end(); await pause(50); }
  }
  assert.ok(admin); const control = admin;
  await control.query(await readFile(new URL("../../sql/001-schema.sql", import.meta.url), "utf8"));
  const ping = DB.prototype.ping;
  t.mock.method(DB.prototype, "ping", async function(this: DB) { databases.push(this); await ping.call(this); });
  const config = { logLevel: "error", dbHost: "127.0.0.1", dbPort: String(port), dbUser: "postgres", dbPassword: "", dbName: "comments_test" };
  async function app(region: Region, dbPort = port) {
    const handler = await newServer({ ...config, region, dbPort: String(dbPort) }, 2);
    const server = serve({ fetch: handler.fetch, createServer, hostname: "0.0.0.0", port: 0 }) as Server; servers.push(server);
    if (!server.listening) await new Promise<void>((resolve) => server.once("listening", resolve));
    return listen(server);
  }
  let serial = 0;
  async function user(region: Region, posted = true) {
    const id = `fixture-${++serial}`;
    await control.query("INSERT INTO users(id,username,secret_key_hash,display_name,region) VALUES($1::text,$1::text,repeat('ab',32),$1::text,$2)", [id, region]);
    await control.query("INSERT INTO login_sessions(id,user_id,token_hash) VALUES($1::text,$1::text,$2)", [id, sha256Hex(id)]);
    if (posted) await control.query("INSERT INTO posts(id,author_id,posting_window_id,image_id,visibility,location_kind,posted_at) VALUES($1::text,$1::text,$2,'fixture-image','friends','none',clock_timestamp())", [id, region]);
    return id;
  }
  const routes = new Map<Region, { old: string; next: string }>();
  for (const region of regions) {
    await control.query("INSERT INTO posting_windows(id,region,local_date,starts_at,on_time_deadline) VALUES($1::text,$1::text,'2026-10-31',clock_timestamp()-interval '1 minute',clock_timestamp()+interval '1 hour')", [region]);
    const local = await app(region), near = await app(region);
    const old = await commentsNginx(host(region), local, near, { legacy: true }); edges.push(old);
    const next = await commentsNginx(host(region), local, near); edges.push(next);
    routes.set(region, { old: old.url, next: next.url });
  }
  async function request(url: string, actor: string, post: string, body = "日本語 é 🙂", headers: Record<string, string> = {}) {
    const response = await fetch(url + `/api/posts/${post}/comments?x=a%2Fb&x=2`, { method: "POST", signal: AbortSignal.timeout(15000),
      headers: { Authorization: `Bearer ${actor}`, "Content-Type": "application/json", "X-Client-IP": "203.0.113.7", "X-Country-Code": "JP", ...headers },
      body: JSON.stringify({ body }) });
    return { status: response.status, body: await response.json() };
  }
  async function same(region: Region, actor: string, post: string, status: number, error?: string, body?: string, headers?: Record<string, string>) {
    const route = routes.get(region)!;
    const count = async () => Number((await control.query("SELECT count(*) FROM comments")).rows[0].count);
    const before = await count();
    const replies = [];
    for (const url of [route.old, route.next]) {
      const reply = await request(url, actor, post, body, headers); assert.equal(reply.status, status, JSON.stringify(reply));
      if (status === 201) {
        const row = (await control.query("SELECT body,author_id,post_id FROM comments WHERE id=$1", [reply.body.id])).rows[0];
        assert.deepEqual(row, { body: body ?? "日本語 é 🙂", author_id: actor, post_id: post });
        assert.ok(Temporal.Instant.from(reply.body.createdAt));
        const reads = [];
        for (const base of [route.old, route.next]) {
          const read = await fetch(base + `/api/posts/${post}/comments`, { headers: { Authorization: `Bearer ${actor}` } });
          assert.equal(read.status, 200);
          const comments = await read.json();
          assert.ok(comments.items.some((item: { id: string }) => item.id === reply.body.id), "successful write is immediately readable on the original GET path");
          reads.push(comments);
        }
        assert.deepEqual(reads[1], reads[0]);
        // 生成されたIDとDB時刻だけがリクエストごとに異なる。
        replies.push({ ...reply, body: { ...reply.body, id: "generated", createdAt: "generated" } });
      } else { assert.equal(reply.body.error, error); replies.push(reply); }
    }
    assert.deepEqual(replies[1], replies[0]);
    assert.equal(await count(), before + (status === 201 ? 2 : 0), "each success writes once; rejection does not write");
  }
  for (const region of regions) await t.test(`${region}: 正常・権限・block双方向・退会・無効session・地域・IP BAN`, async () => {
    const actor = await user(region), owner = await user(region), unposted = await user(region, false);
    const foreign = await user(region === "europe" ? "america" : "europe");
    await same(region, actor, owner, 403, "interaction_forbidden");
    const pair = [actor, owner].sort();
    await control.query("INSERT INTO friendships(id,user_low_id,user_high_id) VALUES($1,$2,$3)", [randomUUID(), ...pair]);
    await same(region, actor, owner, 201);
    await same(region, owner, owner, 201);
    await same(region, unposted, owner, 403, "interaction_forbidden");
    await same(region, foreign, owner, 403, "region_mismatch");
    for (const auth of ["", "Bearer invalid", "Basic fixture"]) await same(region, actor, owner, 401, "invalid_session", undefined, { Authorization: auth });
    await same(region, actor, "missing", 403, "interaction_forbidden");
    await same(region, actor, owner, 400, "invalid_interaction", "");
    for (const [blocker, blocked] of [[actor, owner], [owner, actor]]) {
      const id = randomUUID();
      await control.query("INSERT INTO block_relations(id,blocker_id,blocked_id) VALUES($1,$2,$3)", [id, blocker, blocked]);
      await same(region, actor, owner, 403, "interaction_forbidden");
      await control.query("DELETE FROM block_relations WHERE id=$1", [id]);
    }
    await control.query("UPDATE users SET status='deleted',deleted_at=clock_timestamp() WHERE id=$1", [owner]);
    await same(region, actor, owner, 403, "interaction_forbidden");
    await control.query("UPDATE users SET status='active',deleted_at=NULL WHERE id=$1", [owner]);
    await control.query("UPDATE posting_windows SET ended_at=clock_timestamp() WHERE id=$1", [region]);
    await same(region, actor, owner, 403, "interaction_forbidden");
    await control.query("UPDATE posting_windows SET ended_at=NULL WHERE id=$1", [region]);
    await control.query("UPDATE login_sessions SET active=false WHERE user_id=$1", [actor]);
    await same(region, actor, owner, 401, "invalid_session");
    await control.query("UPDATE login_sessions SET active=true WHERE user_id=$1", [actor]);
    await control.query("UPDATE users SET status='deleted',deleted_at=clock_timestamp() WHERE id=$1", [actor]);
    await same(region, actor, owner, 401, "invalid_session");
    await control.query("UPDATE users SET status='active',deleted_at=NULL WHERE id=$1", [actor]);
    await control.query("INSERT INTO ip_bans(ip,banned_until) VALUES('203.0.113.99',clock_timestamp()+interval '1 hour') ON CONFLICT(ip) DO NOTHING");
    await pause(210);
    await same(region, actor, owner, 403, "ip_banned", undefined, { "X-Client-IP": "203.0.113.99" });
  });
  const rttMs = Number(process.env.REGIONAL_COMMENTS_RTT_MS ?? 0);
  if (rttMs) for (const region of regions) await t.test(`${region}: 旧新の模擬RTT比較`, async () => {
    const dbLink = await delayedTCP(port, rttMs); links.push(dbLink);
    const local = await app(region, dbLink.port), near = await app(region);
    const httpLink = await delayedTCP(near, rttMs); links.push(httpLink);
    const old = await commentsNginx(host(region), local, near, { legacy: true }); edges.push(old);
    const next = await commentsNginx(host(region), local, httpLink.port); edges.push(next);
    const actor = await user(region), owner = await user(region);
    await control.query("UPDATE posts SET visibility='public' WHERE id=$1", [owner]);
    const targets = { old: old.url, next: next.url }, times = { old: [] as number[], next: [] as number[] };
    for (const mode of ["old", "next"] as const) assert.equal((await request(targets[mode], actor, owner)).status, 201);
    // 各4回、ABBA ABBA。双方が実nginx、同じDB・pool2・JSON・権限処理を通る。
    for (const mode of ["old", "next", "next", "old", "old", "next", "next", "old"] as const) {
      const start = performance.now(); assert.equal((await request(targets[mode], actor, owner)).status, 201);
      times[mode].push(Math.round(performance.now() - start));
    }
    console.log("[regional-comments-rtt]", JSON.stringify({ region, rttMs, warmupsPerMode: 1, samplesMs: times,
      meanMs: Object.fromEntries(Object.entries(times).map(([mode, values]) => [mode, Math.round(values.reduce((a, b) => a + b) / values.length)])) }));
  });
});
