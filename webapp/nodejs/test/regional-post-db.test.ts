import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { promisify } from "node:util";
import { serve } from "@hono/node-server";
import jpeg from "jpeg-js";
import pg from "pg";
import { DB } from "../src/db.ts";
import { newServer } from "../src/server.ts";
import { sha256Hex } from "../src/session.ts";
import { regionalNginx } from "./helpers/regional-nginx.ts";
import { delayedTCP } from "./helpers/delayed-tcp.ts";

const docker = promisify(execFile);
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
type Region = "asia" | "europe" | "america";

// 本番envや外部DBを受け取らず、自分の隔離PG・nginxだけを起動する。
test("海外の投稿転送 / 実nginx・multipart・認証・隔離PG16", {
  skip: process.env.REGIONAL_POST_TEST !== "1", timeout: 120000,
}, async (t) => {
  const container = "isu15-regional-post-" + randomUUID();
  const servers: ReturnType<typeof serve>[] = [];
  const databases: DB[] = [];
  const proxies: Awaited<ReturnType<typeof regionalNginx>>[] = [];
  const links: Awaited<ReturnType<typeof delayedTCP>>[] = [];
  let admin: pg.Client | undefined, started = false;
  t.after(async () => {
    await Promise.allSettled(proxies.map((proxy) => proxy.close()));
    await Promise.all(servers.map((server) => new Promise<void>((resolve) => {
      server.close(() => resolve());
      if ("closeAllConnections" in server) server.closeAllConnections();
    })));
    await Promise.allSettled(databases.map((db) => db.end()));
    await Promise.allSettled(links.map((link) => link.close()));
    await admin?.end();
    if (started) await docker("docker", ["stop", "--time", "1", container]);
  });
  await docker("docker", ["run", "--detach", "--rm", "--name", container,
    "--publish", "127.0.0.1::5432", "--tmpfs", "/var/lib/postgresql/data",
    "--env", "POSTGRES_HOST_AUTH_METHOD=trust", "--env", "POSTGRES_DB=regional_post_test", "postgres:16"]);
  started = true;
  const published = await docker("docker", ["port", container, "5432/tcp"]);
  const connection = { host: "127.0.0.1", port: Number(published.stdout.trim().split(":").at(-1)), user: "postgres", database: "regional_post_test" };
  for (let attempt = 0; attempt < 100; attempt++) {
    const client = new pg.Client(connection);
    try { await client.connect(); admin = client; break; }
    catch { await client.end(); await pause(50); }
  }
  assert.ok(admin);
  const control = admin;
  await control.query(await readFile(new URL("../../sql/001-schema.sql", import.meta.url), "utf8"));
  await control.query(`INSERT INTO posting_windows(id,region,local_date,starts_at,on_time_deadline)
    SELECT r,r,'2026-10-31',clock_timestamp()-interval '1 minute',clock_timestamp()+interval '1 hour'
    FROM unnest(ARRAY['asia','europe','america']) r;
    INSERT INTO ip_bans(ip,banned_until) VALUES ('203.0.113.254',clock_timestamp()+interval '1 hour');`);
  const config = { region: "asia", logLevel: "error", dbHost: connection.host, dbPort: String(connection.port), dbUser: "postgres", dbPassword: "", dbName: connection.database };
  const ping = DB.prototype.ping;
  t.mock.method(DB.prototype, "ping", async function (this: DB) { databases.push(this); await ping.call(this); });
  async function app(region: Region, kind: string, dbPort = connection.port) {
    const handler = await newServer({ ...config, region, dbPort: String(dbPort) }, 2);
    const server = serve({ hostname: "127.0.0.1", port: 0, fetch: async (request, env) => {
      const result = await handler.fetch(request, env);
      const headers = new Headers(result.headers);
      headers.set("X-Test-Backend", kind);
      return new Response(result.body, { status: result.status, headers });
    } });
    servers.push(server);
    if (!server.listening) await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address(); assert.ok(address && typeof address !== "string");
    return { url: `http://127.0.0.1:${address.port}`, port: address.port, server };
  }
  const asia = await app("asia", "asia");
  const image = Buffer.from(jpeg.encode({ data: randomBytes(512 * 512 * 4), width: 512, height: 512 }, 80).data);
  assert.ok(image.length > 200 * 1024, "実multipart画像の転送量を小さなfixtureだけで済ませない");
  let serial = 0;
  async function user(region: Region) {
    const id = `post-user-${++serial}`;
    await control.query("INSERT INTO users(id,username,secret_key_hash,display_name,region) VALUES($1::text,$1::text,repeat('ab',32),$1::text,$2)", [id, region]);
    await control.query("INSERT INTO login_sessions(id,user_id,token_hash) VALUES($1,$1,$2)", [id, sha256Hex(id)]);
    return id;
  }
  function headers(id: string, country = "JP") {
    return { Authorization: `Bearer ${id}`, "X-Client-IP": "203.0.113.7", "X-Country-Code": country };
  }
  function body(data: Uint8Array = image) {
    const form = new FormData();
    form.set("image", new Blob([new Uint8Array(data)], { type: "image/jpeg" }), "photo.jpg");
    form.set("caption", "投稿 ✨ + & 日本語"); form.set("visibility", "friends"); form.set("location_kind", "none");
    return form;
  }
  const post = (url: string, id: string, extra: Record<string, string> = {}, data?: Uint8Array) => fetch(url + "/api/posts", {
    method: "POST", headers: { ...headers(id), ...extra }, body: body(data), signal: AbortSignal.timeout(10000),
  });
  for (const region of ["europe", "america"] as const) {
    const local = await app(region, "local"), near = await app(region, "near");
    const proxy = await regionalNginx(region === "europe" ? "europe1" : "america1", local.port, near.port);
    proxies.push(proxy);
    await t.test(`${region}: multipartの全画像バイトと他地域への即時反映`, async () => {
      const actor = await user(region), peer = await user("asia");
      await control.query("INSERT INTO friendships(id,user_low_id,user_high_id) VALUES($1,LEAST($2::text,$3::text),GREATEST($2::text,$3::text))", [`friend-${actor}`, actor, peer]);
      const peerPost = await post(asia.url, peer); assert.equal(peerPost.status, 201); await peerPost.arrayBuffer();
      const result = await post(proxy.url, actor);
      assert.equal(result.status, 201, await result.clone().text());
      assert.equal(result.headers.get("X-Test-Backend"), "near");
      const created = await result.json();
      assert.equal(created.author.id, actor); assert.equal(created.postingWindowId, region);
      assert.equal(created.caption, "投稿 ✨ + & 日本語");
      const imageID = new URL(created.imageUrl, proxy.url).pathname.split("/").at(-1)!;
      const stored = (await control.query("SELECT data FROM image_objects WHERE id=$1", [imageID])).rows[0].data;
      assert.deepEqual(stored, image);
      const fetched = await fetch(proxy.url + created.imageUrl);
      assert.equal(fetched.status, 200); assert.deepEqual(Buffer.from(await fetched.arrayBuffer()), image);
      const feed = await fetch(asia.url + "/api/feeds/friends", { headers: headers(peer) });
      assert.equal(feed.status, 200);
      assert.deepEqual((await feed.json()).items.map((item: any) => item.id), [created.id]);
      const mine = await fetch(proxy.url + "/api/posts/me/current", { headers: headers(actor) });
      assert.equal((await mine.json()).id, created.id);
      const duplicate = await post(proxy.url, actor);
      assert.equal(duplicate.status, 409); await duplicate.arrayBuffer();
    });
    await t.test(`${region}: 認証・地域・IP・不正JPEGを従来どおり拒否`, async () => {
      const actor = await user(region), foreign = await user("asia");
      for (const [id, extra, status, error] of [
        [actor, { Authorization: "" }, 401, "invalid_session"],
        [actor, { Authorization: "Bearer invalid" }, 401, "invalid_session"],
        [foreign, {}, 403, "region_mismatch"],
        [actor, { "X-Client-IP": "203.0.113.254" }, 403, "ip_banned"],
      ] as const) {
        const result = await post(proxy.url, id, extra);
        assert.equal(result.status, status); assert.equal(result.headers.get("X-Test-Backend"), "near");
        assert.equal((await result.json()).error, error);
      }
      const invalid = await post(proxy.url, actor, {}, new Uint8Array([1, 2, 3]));
      assert.equal(invalid.status, 400); assert.equal((await invalid.json()).error, "invalid_post");
      assert.equal((await control.query("SELECT count(*) FROM posts WHERE author_id=$1", [actor])).rows[0].count, "0");
      for (const method of ["GET", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"]) {
        const remote = await fetch(proxy.url + "/api/posts", { method, headers: headers(actor) });
        const direct = await fetch(local.url + "/api/posts", { method, headers: headers(actor) });
        assert.equal(remote.headers.get("X-Test-Backend"), "local");
        assert.equal(remote.status, direct.status); assert.equal(remote.headers.get("Allow"), direct.headers.get("Allow"));
        assert.equal(await remote.text(), await direct.text());
      }
    });
    await t.test(`${region}: 同時投稿は1件だけ確定し、接続失敗を別アプリへ再試行しない`, async () => {
      const actor = await user(region);
      const replies = await Promise.all([post(proxy.url, actor), post(proxy.url, actor)]);
      assert.deepEqual(replies.map(r => r.status).sort(), [201, 409]);
      await Promise.all(replies.map(r => r.arrayBuffer()));
      assert.equal((await control.query("SELECT count(*) FROM posts WHERE author_id=$1", [actor])).rows[0].count, "1");
      const fail = await user(region);
      await new Promise<void>((resolve) => {
        near.server.close(() => resolve());
        if ("closeAllConnections" in near.server) near.server.closeAllConnections();
      });
      const response = await post(proxy.url, fail);
      assert.equal(response.status, 502); await response.arrayBuffer();
      assert.equal((await control.query("SELECT count(*) FROM posts WHERE author_id=$1", [fail])).rows[0].count, "0");
    });
  }

  if (process.env.REGIONAL_POST_BENCH_RTT_MS) {
    await t.test("代表JPEG・実nginxによる配置比較（模擬RTT・帯域制限なし）", async () => {
      const rtt = Number(process.env.REGIONAL_POST_BENCH_RTT_MS);
      const sqlLink = await delayedTCP(connection.port, rtt); links.push(sqlLink);
      const remote = await app("europe", "remote-sql", sqlLink.port);
      const near = await app("europe", "forward-http");
      const httpLink = await delayedTCP(near.port, rtt); links.push(httpLink);
      const proxy = await regionalNginx("europe1", remote.port, httpLink.port); proxies.push(proxy);
      const peer = await user("asia");
      const peerResponse = await post(asia.url, peer); assert.equal(peerResponse.status, 201);
      const peerPost = await peerResponse.json();
      const modes = {
        "remote-sql": { url: remote.url, link: sqlLink },
        "forward-http": { url: proxy.url, link: httpLink },
      };
      const samples: Record<string, { postMs: number; feedMs: number; uploadedBytes: number; downloadedBytes: number }[]> = { "remote-sql": [], "forward-http": [] };
      for (let run = -1; run < 4; run++) {
        const order = run % 2 ? ["remote-sql", "forward-http"] as const : ["forward-http", "remote-sql"] as const;
        for (const mode of order) {
          const target = modes[mode], actor = await user("europe");
          await control.query("INSERT INTO friendships(id,user_low_id,user_high_id) VALUES($1,LEAST($2::text,$3::text),GREATEST($2::text,$3::text))", [`friend-${actor}`, actor, peer]);
          const uploaded = () => sqlLink.uploadedBytes + httpLink.uploadedBytes;
          const downloaded = () => sqlLink.downloadedBytes + httpLink.downloadedBytes;
          const sent = uploaded(), received = downloaded();
          const start = performance.now();
          const result = await post(target.url, actor); assert.equal(result.status, 201);
          const created = await result.json();
          const postMs = performance.now() - start, feedStart = performance.now();
          // friendsフィードはmainですでにDB近傍へ転送済み。前後とも同じ経路にする。
          const feed = await fetch(proxy.url + "/api/feeds/friends", { headers: headers(actor) });
          assert.equal(feed.status, 200);
          assert.deepEqual((await feed.json()).items.map((item: any) => item.id), [peerPost.id]);
          const feedMs = performance.now() - feedStart;
          const imageID = new URL(created.imageUrl, target.url).pathname.split("/").at(-1)!;
          assert.deepEqual((await control.query("SELECT data FROM image_objects WHERE id=$1", [imageID])).rows[0].data, image);
          if (run >= 0) samples[mode].push({ postMs, feedMs, uploadedBytes: uploaded() - sent, downloadedBytes: downloaded() - received });
        }
      }
      const average = (values: number[]) => Math.round(values.reduce((sum, x) => sum + x, 0) / values.length);
      console.log("[regional-post-large-image]", JSON.stringify({ imageBytes: image.length, syntheticRttMs: rtt, samples: 4, warmups: 1,
        caveat: "same Mac; HTTP vs SQL location; no bandwidth shaping or shared-host CPU contention; includes real nginx on forward path",
        results: Object.fromEntries(Object.entries(samples).map(([mode, values]) => [mode, {
          postMeanMs: average(values.map(x => x.postMs)), feedMeanMs: average(values.map(x => x.feedMs)),
          uploadedMeanBytes: average(values.map(x => x.uploadedBytes)), downloadedMeanBytes: average(values.map(x => x.downloadedBytes)),
        }])), raw: samples }));
    });
  }
});
