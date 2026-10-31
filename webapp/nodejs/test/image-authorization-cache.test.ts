import assert from "node:assert/strict";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { Hono } from "hono";
import { createClient } from "redis";
import pg from "pg";
import jpeg from "jpeg-js";
import { DB } from "../src/db.ts";
import { apiErrorHandler, APIError } from "../src/api_error.ts";
import { ImageAuthorizationCache, imageAuthorizationControlKey, imageCacheMutationMiddleware } from "../src/image_authorization_cache.ts";
import { getImageHandler } from "../src/image_api.ts";
import { imageSignature } from "../src/image_signature.ts";
import { ImageFiles } from "../src/image_files.ts";
import { newServer, type Env, type HandlerContext } from "../src/server.ts";
import { sha256Hex } from "../src/session.ts";
import { imageNginx } from "./helpers/image-nginx.ts";

const redisPort = process.env.IMAGE_AUTH_REDIS_TEST_PORT;
const pgPort = process.env.IMAGE_AUTH_PG_TEST_PORT;

// Opt-in only: a dedicated empty Redis and a dedicated empty local PostgreSQL.
// No production URL/env file is accepted and no FLUSHDB is ever issued.
test("画像認可キャッシュの地域間整合性・競合・障害", { skip: !redisPort || !pgPort }, async (t) => {
  assert.match(redisPort!, /^\d+$/);
  assert.match(pgPort!, /^\d+$/);
  const redisURL = `redis://127.0.0.1:${redisPort}`;
  let activeRedisURL = redisURL;
  const redis = createClient({ url: redisURL, socket: { reconnectStrategy: false } });
  redis.on("error", () => {});
  await redis.connect();
  t.after(() => { if (redis.isOpen) redis.destroy(); });
  assert.equal(await redis.dbSize(), 0, "requires a fresh dedicated Redis");
  await assert.rejects(new ImageAuthorizationCache(redisURL).connect(), /not safely provisioned/);
  await ImageAuthorizationCache.provision(redisURL);
  await assert.rejects(ImageAuthorizationCache.provision(redisURL), /empty dedicated database/);
  await redis.configSet("appendfsync", "everysec");
  try { await assert.rejects(new ImageAuthorizationCache(redisURL).connect(), /not safely provisioned/); }
  finally { await redis.configSet("appendfsync", "always"); }

  const root = await mkdtemp(join(tmpdir(), "isu15-image-auth-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = {
    region: "asia", logLevel: "error", dbHost: "127.0.0.1", dbPort: pgPort!,
    dbUser: "postgres", dbPassword: "", dbName: "isureal_image_auth_test",
    imageAuthorizationRedisURL: redisURL,
    imageAuthorizationCacheReads: true,
  };
  const admin = new pg.Client({ host: config.dbHost, port: Number(pgPort), user: config.dbUser, database: config.dbName });
  await admin.connect();
  let adminClosed = false;
  t.after(() => adminClosed ? undefined : admin.end());
  assert.equal((await admin.query("SELECT count(*) FROM pg_tables WHERE schemaname='public'")).rows[0].count, "0", "requires a fresh dedicated PostgreSQL DB");
  await admin.query(await readFile(new URL("../../sql/001-schema.sql", import.meta.url), "utf8"));
  const bytes = jpeg.encode({ data: Buffer.from([255, 0, 0, 255]), width: 1, height: 1 }, 80).data;
  await admin.query(`
    INSERT INTO users(id,username,secret_key_hash,display_name,region)
    VALUES('author','author',repeat('ab',32),'author','asia'),
      ('reactor','reactor',repeat('ab',32),'reactor','europe');
  `);
  await admin.query("INSERT INTO login_sessions(id,user_id,token_hash) VALUES('s-author','author',$1),('s-reactor','reactor',$2)", [sha256Hex("author"), sha256Hex("reactor")]);
  await admin.query(`
    INSERT INTO posting_windows(id,region,local_date,starts_at,on_time_deadline)
    SELECT region,region,'2026-10-31',clock_timestamp()-interval '1 minute',clock_timestamp()+interval '1 hour'
    FROM unnest(ARRAY['asia','europe']) region;
    INSERT INTO friendships(id,user_low_id,user_high_id) VALUES('friendship','author','reactor');
  `);
  for (const [id, owner] of [["post-image", "author"], ["reaction", "reactor"], ["profile", "reactor"], ["reactor-post-image", "reactor"]]) {
    await admin.query("INSERT INTO image_objects(id,owner_user_id,data,media_type) VALUES($1,$2,$3,'image/jpeg')", [id, owner, bytes]);
  }
  await admin.query(`
    INSERT INTO posts(id,author_id,posting_window_id,image_id,visibility,location_kind,posted_at)
    VALUES('post','author','asia','post-image','friends','none',clock_timestamp()),
      ('reactor-post','reactor','europe','reactor-post-image','friends','none',clock_timestamp());
    INSERT INTO realmojis(id,post_id,reactor_id,image_id,reaction_type,created_at)
    VALUES('reaction-record','post','reactor','reaction','smile',clock_timestamp());
    UPDATE users SET profile_image_id='profile' WHERE id='reactor';
    UPDATE users SET created_at='2026-10-01';
    UPDATE image_objects SET created_at='2026-10-01';
    UPDATE posting_windows SET created_at='2026-10-01';
    UPDATE posts SET created_at='2026-10-01';
    UPDATE realmojis SET created_at='2026-10-01';
  `);
  await admin.query(await readFile(new URL("../../sql/003-initial-snapshot.sql", import.meta.url), "utf8"));

  const databases: DB[] = [];
  const caches: ImageAuthorizationCache[] = [];
  const ping = DB.prototype.ping;
  const connect = ImageAuthorizationCache.prototype.connect;
  t.mock.method(DB.prototype, "ping", async function(this: DB) { databases.push(this); await ping.call(this); });
  t.mock.method(ImageAuthorizationCache.prototype, "connect", async function(this: ImageAuthorizationCache) { caches.push(this); await connect.call(this); });
  t.after(async () => { caches.forEach(c => c.close()); await Promise.all(databases.map(db => db.end())); });
  let imageQueries = 0;
  const get = DB.prototype.get;
  t.mock.method(DB.prototype, "get", async function<T>(this: DB, sql: string, ...args: unknown[]): Promise<T | undefined> {
    if (/FROM image_objects/.test(sql)) imageQueries++;
    return get.call(this, sql, ...args) as Promise<T | undefined>;
  });
  const apps: Hono<Env>[] = [];
  const directories = ["asia", "europe", "america", "asia"];
  for (const region of directories) {
    apps.push(await newServer({ ...config, region, imageCacheDir: join(root, region) }, 2));
  }
  const env = { incoming: { headersDistinct: {}, socket: { remoteAddress: "203.0.113.1" } } };
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const url = (id: string, expires = exp, key = Buffer.from("ab".repeat(32), "hex")) =>
    `/api/images/${id}?exp=${expires}&sig=${imageSignature(key, id, expires).toString("base64url")}`;
  const request = (region: number, path: string, init?: RequestInit) => apps[region].request(path, init, env);
  const auth = (actor: string) => ({ Authorization: `Bearer ${actor}` });
  async function mutate(action: () => Promise<unknown>, ownerID?: string) {
    const token = await caches[0].beginMutation(ownerID);
    try { await action(); } finally { await caches[0].finishMutation(token); }
  }
  async function warm(id: string) {
    for (let i = 0; i < 3; i++) assert.equal((await request(i, url(id))).status, 200);
  }
  async function forbiddenEverywhere(id: string) {
    for (let i = 0; i < apps.length; i++) assert.equal((await request(i, url(id))).status, 403);
  }

  await t.test("初回はDB、同じURLは別workerも画像SQL 0回、ファイル未配置地域はDBで再生成", async () => {
    imageQueries = 0;
    const cold = await request(0, url("reaction"));
    assert.equal(cold.status, 200);
    assert.equal(imageQueries, 2);
    assert.equal(cold.headers.get("cache-control"), "no-store");
    const uri = cold.headers.get("x-accel-redirect")!;
    assert.deepEqual(await readFile(new ImageFiles(join(root, "asia")).fromURI(uri)!.path), bytes);
    for (const worker of [0, 3]) {
      imageQueries = 0;
      const hit = await request(worker, url("reaction"));
      assert.equal(hit.status, 200);
      assert.equal(hit.headers.get("x-accel-redirect"), uri);
      assert.equal(imageQueries, 0);
    }
    imageQueries = 0;
    assert.equal((await request(1, url("reaction"))).status, 200);
    assert.equal(imageQueries, 2);
    imageQueries = 0;
    assert.equal((await request(1, url("reaction"))).status, 200);
    assert.equal(imageQueries, 0);
    await warm("reaction");
  });

  await t.test("不正署名・期限・重複パラメータはキャッシュを迂回できない", async () => {
    for (const path of [url("reaction", exp, Buffer.alloc(32)), url("reaction", 1), url("reaction") + `&exp=${exp}`, url("reaction") + "&sig=x"]) {
      assert.equal((await request(0, path)).status, 403);
    }
    let calls = 0;
    const clock = t.mock.method(Temporal.Now, "instant", () => Temporal.Instant.fromEpochMilliseconds((++calls === 1 ? exp - 1 : exp + 1) * 1000));
    try { assert.equal((await request(0, url("reaction"))).status, 403); }
    finally { clock.mock.restore(); }
  });

  if (process.env.IMAGE_AUTH_NGINX_TEST === "1") {
    await t.test("実nginxの配信本文・内部URL拒否・署名不正・Rangeを維持して画像SQL 0回", async (t) => {
      const nginx = await imageNginx(databases[0], new ImageFiles(join(root, "asia"), 0), caches[0]);
      t.after(() => nginx.close());
      const path = url("reaction");
      imageQueries = 0;
      const response = await nginx.request(path);
      assert.equal(response.status, 200);
      assert.deepEqual(response.body, bytes);
      assert.equal(response.headers["content-type"], "image/jpeg");
      assert.ok(response.headers["cache-control"]!.split(/,\s*/).every(value => value === "no-store"));
      assert.equal(imageQueries, 0);
      const range = await nginx.request(path, { Range: "bytes=0-1" });
      assert.equal(range.status, 200);
      assert.deepEqual(range.body, bytes);
      assert.equal((await nginx.request(url("reaction", exp, Buffer.alloc(32)))).status, 403);
      const params = new URL(path, "http://test").searchParams;
      const entry = await caches[0].lookup("reaction", String(exp), params.get("sig")!);
      assert.equal((await nginx.request(entry!.image!.uri)).status, 404);
    });
  }

  if (process.env.IMAGE_AUTH_CPU_BENCH === "1") {
    await t.test("合成画像GETのCPU比較（実環境の得点・CPU低下率とは区別）", async () => {
      const baseline = await newServer({ ...config, imageAuthorizationRedisURL: undefined, imageCacheDir: join(root, "asia") }, 2);
      const path = url("reaction");
      for (let i = 0; i < 50; i++) {
        await baseline.request(path, undefined, env);
        await request(0, path);
      }
      const results: { mode: string; requests: number; cpuMs: number; elapsedMs: number; imageQueries: number }[] = [];
      for (let round = 0; round < 5; round++) {
        const modes = round % 2 ? ["redis", "baseline"] : ["baseline", "redis"];
        for (const mode of modes) {
          imageQueries = 0;
          const cpu = process.cpuUsage();
          const start = performance.now();
          for (let i = 0; i < 250; i++) {
            const response = mode === "redis" ? await request(0, path) : await baseline.request(path, undefined, env);
            assert.equal(response.status, 200);
          }
          const elapsedMs = performance.now() - start;
          const used = process.cpuUsage(cpu);
          results.push({ mode, requests: 250, cpuMs: (used.user + used.system) / 1000, elapsedMs, imageQueries });
        }
      }
      t.diagnostic(JSON.stringify({ syntheticImageGET: results }));
    });
  }

  await t.test("プロフィール画像の削除成功後、全地域で即座に403", async () => {
    await warm("profile");
    const barrierOnly = await newServer({ ...config, imageAuthorizationCacheReads: false, imageCacheDir: join(root, "europe") }, 2);
    imageQueries = 0;
    assert.equal((await barrierOnly.request(url("profile"), undefined, env)).status, 200);
    assert.equal(imageQueries, 2);
    const saved = (await admin.query("SELECT * FROM image_objects WHERE id='profile'")).rows[0];
    assert.equal((await barrierOnly.request("/api/me/profile-image", { method: "DELETE", headers: auth("reactor") }, env)).status, 204);
    await forbiddenEverywhere("profile");
    await mutate(async () => {
      await admin.query("INSERT INTO image_objects(id,owner_user_id,data,media_type,created_at) VALUES($1,$2,$3,$4,$5)", [saved.id, saved.owner_user_id, saved.data, saved.media_type, saved.created_at]);
      await admin.query("UPDATE users SET profile_image_id='profile' WHERE id='reactor'");
    }, "reactor");
  });

  await t.test("RealMoji差し替え成功後、旧URLは全地域で403、新画像は取得可能", async () => {
    await warm("reaction");
    const body = new FormData();
    body.set("image", new Blob([new Uint8Array(bytes)], { type: "image/jpeg" }), "fixture.jpg");
    body.set("reactionType", "smile");
    const response = await request(1, "/api/posts/post/realmojis", { method: "POST", headers: { ...auth("reactor"), "Transfer-Encoding": "chunked" }, body });
    assert.equal(response.status, 201, await response.clone().text());
    const reaction = await response.json();
    await forbiddenEverywhere("reaction");
    for (let i = 0; i < 3; i++) assert.equal((await request(i, reaction.imageUrl)).status, 200);
    assert.equal((await request(0, `/api/realmojis/${reaction.id}`, { method: "DELETE", headers: auth("author") })).status, 204);
    for (let i = 0; i < 3; i++) assert.equal((await request(i, reaction.imageUrl)).status, 403);
    await mutate(() => admin.query("UPDATE realmojis SET replaced_at=NULL WHERE id='reaction-record'"), "reactor");
  });

  await t.test("投稿削除で投稿画像と他ユーザーのRealMoji画像も無効化", async () => {
    await warm("reaction"); await warm("post-image");
    assert.equal((await request(0, "/api/posts/post", { method: "DELETE", headers: auth("author") })).status, 204);
    await forbiddenEverywhere("post-image"); await forbiddenEverywhere("reaction");
    await mutate(() => admin.query("UPDATE posts SET deleted_at=NULL WHERE id='post'"));
  });

  await t.test("投稿者の退会で別所有者のRealMojiも即時無効化", async () => {
    await warm("reaction"); await warm("post-image");
    assert.equal((await request(0, "/api/me/account-deletion", { method: "POST", headers: auth("author") })).status, 204);
    await forbiddenEverywhere("reaction"); await forbiddenEverywhere("post-image");
    await mutate(async () => {
      await admin.query("UPDATE users SET status='active',deleted_at=NULL WHERE id='author'");
      await admin.query("UPDATE login_sessions SET active=true,invalidated_at=NULL,reason=NULL WHERE user_id='author'");
    });
  });

  await t.test("無効化前に読み始めた古いDB結果は、更新後に再登録できない", async () => {
    await warm("reaction");
    const path = url("reaction");
    const params = new URL(path, "http://test").searchParams;
    const lookup = await caches[0].lookup("reaction", params.get("exp")!, params.get("sig")!);
    assert.ok(lookup?.image);
    const ticket = await caches[0].snapshot(lookup, "reactor");
    assert.ok(ticket);
    await mutate(() => admin.query("UPDATE realmojis SET deleted_at=clock_timestamp() WHERE id='reaction-record'"), "reactor");
    await caches[0].publish(ticket, { uri: lookup.image.uri, mediaType: "image/jpeg" }, exp);
    assert.equal((await caches[1].lookup("reaction", params.get("exp")!, params.get("sig")!))?.image, undefined);
    await forbiddenEverywhere("reaction");
    await mutate(() => admin.query("UPDATE realmojis SET deleted_at=NULL WHERE id='reaction-record'"), "reactor");
  });

  await t.test("所有者検索とepoch取得の間に鍵が変わっても旧署名を登録しない", async () => {
    let changed = false;
    const wrapped = { async get<T>(sql: string, ...args: unknown[]) {
      const row = await databases[0].get<T>(sql, ...args);
      if (!changed) {
        changed = true;
        await mutate(() => admin.query("UPDATE users SET secret_key_hash=repeat('cd',32) WHERE id='reactor'"), "reactor");
      }
      return row;
    } } as DB;
    const app = new Hono<Env>().onError(apiErrorHandler);
    app.get("/api/images/:imageId", getImageHandler({ config, db: wrapped, imageFiles: new ImageFiles(join(root, "asia"), 0), imageAuthorizationCache: caches[0] } as HandlerContext));
    try {
      assert.equal((await app.request(url("profile", exp + 50))).status, 403);
      await forbiddenEverywhere("profile");
      for (let i = 0; i < 3; i++) assert.equal((await request(i, url("profile", exp, Buffer.from("cd".repeat(32), "hex")))).status, 200);
    } finally {
      await mutate(() => admin.query("UPDATE users SET secret_key_hash=repeat('ab',32) WHERE id='reactor'"), "reactor");
    }
  });

  await t.test("更新中は該当所有者だけDB確認し、別所有者のhitは維持、並行writerを数える", async () => {
    await warm("profile"); await warm("post-image");
    const first = await caches[0].beginMutation("reactor");
    const second = await caches[1].beginMutation("reactor");
    imageQueries = 0;
    assert.equal((await request(0, url("profile"))).status, 200);
    assert.ok(imageQueries >= 1);
    imageQueries = 0;
    assert.equal((await request(0, url("post-image"))).status, 200);
    assert.equal(imageQueries, 0);
    const otherOwnerURL = url("post-image", exp + 1);
    assert.equal((await request(0, otherOwnerURL)).status, 200);
    imageQueries = 0;
    assert.equal((await request(0, otherOwnerURL)).status, 200);
    assert.equal(imageQueries, 0, "unrelated ongoing writes must not prevent admission");
    await caches[0].finishMutation(first);
    imageQueries = 0;
    assert.equal((await request(0, url("profile"))).status, 200);
    assert.ok(imageQueries >= 1);
    await caches[1].finishMutation(second);
    await request(0, url("profile"));
    imageQueries = 0;
    assert.equal((await request(0, url("profile"))).status, 200);
    assert.equal(imageQueries, 0);
  });

  await t.test("4xxはrollback完了後にgateを解放、5xxの不確定な結果はgateを保持", async () => {
    const h = { imageAuthorizationCache: caches[0] } as HandlerContext;
    const app = new Hono<Env>().onError(apiErrorHandler);
    app.post("/invalid", imageCacheMutationMiddleware(h, "global"), () => { throw new APIError(400, "invalid_post"); });
    app.post("/uncertain", imageCacheMutationMiddleware(h, "global"), () => { throw new APIError(503, "fixture_failure"); });
    assert.equal((await app.request("/invalid", { method: "POST" })).status, 400);
    assert.equal(await redis.hGet(imageAuthorizationControlKey, "total"), "0");
    assert.equal((await app.request("/uncertain", { method: "POST" })).status, 503);
    assert.equal(await redis.hGet(imageAuthorizationControlKey, "total"), "1");
    await warm("profile");
    imageQueries = 0;
    await request(0, url("profile"));
    assert.ok(imageQueries >= 1);
    // Test-only recovery after all fixture operations have finished.
    const writers = Object.keys(await redis.hGetAll(imageAuthorizationControlKey)).filter(k => k.startsWith("writer:"));
    assert.equal(writers.length, 1);
    await caches[0].finishMutation(writers[0].slice("writer:".length));
  });

  await t.test("initialize相当の全体gateと実resetで、追加画像を失効し初期画像を再利用", async () => {
    await warm("profile");
    await mutate(async () => {
      await admin.query("INSERT INTO image_objects(id,owner_user_id,data,media_type) VALUES('runtime-image','reactor',$1,'image/jpeg')", [bytes]);
      await admin.query("UPDATE users SET profile_image_id='runtime-image' WHERE id='reactor'");
    }, "reactor");
    await warm("runtime-image");
    await mutate(() => admin.query(readFileSQL));
    await forbiddenEverywhere("runtime-image");
    await warm("profile");
    imageQueries = 0;
    assert.equal((await request(3, url("profile"))).status, 200);
    assert.equal(imageQueries, 0);
  });

  await t.test("アプリ再起動後も有効画像を取得でき、ファイル消失時はDBから復元", async () => {
    const app = await newServer({ ...config, imageCacheDir: join(root, "asia") }, 2);
    imageQueries = 0;
    const hit = await app.request(url("profile"), undefined, env);
    assert.equal(hit.status, 200);
    assert.equal(imageQueries, 0);
    const file = new ImageFiles(join(root, "asia")).fromURI(hit.headers.get("x-accel-redirect")!)!;
    await rm(file.path);
    imageQueries = 0;
    assert.equal((await app.request(url("profile"), undefined, env)).status, 200);
    assert.ok(imageQueries >= 1);
    assert.deepEqual(await readFile(file.path), bytes);
  });

  if (process.env.IMAGE_AUTH_REDIS_TEST_CONTAINER) {
    await t.test("Redis再起動でも未完了gateが残り、古い画像を配信しない", async () => {
      const container = process.env.IMAGE_AUTH_REDIS_TEST_CONTAINER!;
      assert.match(container, /^isu15-image-auth-[a-z0-9-]+$/);
      await warm("reaction");
      const token = await caches[0].beginMutation("reactor");
      await admin.query("UPDATE realmojis SET deleted_at=clock_timestamp() WHERE id='reaction-record'");
      execFileSync("docker", ["kill", "--signal", "KILL", container], { stdio: "pipe" });
      execFileSync("docker", ["start", container], { stdio: "pipe" });
      const deadline = performance.now() + 10_000;
      for (;;) {
        try {
          assert.equal(execFileSync("docker", ["exec", container, "redis-cli", "ping"], { stdio: "pipe" }).toString().trim(), "PONG");
          break;
        } catch {
          assert.ok(performance.now() < deadline, "Redis did not restart");
          await new Promise(r => setTimeout(r, 20));
        }
      }
      // Existing disconnected clients must use DB; new processes restore gates from AOF.
      await forbiddenEverywhere("reaction");
      // Docker's automatically published host port can change after start.
      const restartedPort = execFileSync("docker", ["port", container, "6379"], { stdio: "pipe" }).toString().trim().split(":").at(-1)!;
      assert.match(restartedPort, /^\d+$/);
      const restored = new ImageAuthorizationCache(`redis://127.0.0.1:${restartedPort}`);
      activeRedisURL = `redis://127.0.0.1:${restartedPort}`;
      await restored.connect();
      const params = new URL(url("reaction"), "http://test").searchParams;
      assert.equal((await restored.lookup("reaction", String(exp), params.get("sig")!))?.image, undefined);
      await restored.finishMutation(token);
      restored.close();
    });
  }

  await t.test("Redis接続断時は画像GETをDBへ戻し、更新ハンドラーを開始しない", async () => {
    caches[0].close();
    let writes = 0;
    const h = { config, db: databases[0], imageFiles: new ImageFiles(join(root, "asia"), 0), imageAuthorizationCache: caches[0] } as HandlerContext;
    const app = new Hono<Env>().onError(apiErrorHandler);
    app.get("/api/images/:imageId", getImageHandler(h));
    app.post("/write", imageCacheMutationMiddleware(h, "global"), (c) => { writes++; return c.body(null, 204); });
    imageQueries = 0;
    assert.equal((await app.request(url("profile"))).status, 200);
    assert.ok(imageQueries >= 1);
    assert.equal((await app.request("/write", { method: "POST" })).status, 503);
    assert.equal(writes, 0);
  });

  await t.test("デプロイ準備はDB接続が残れば拒否し、全API停止後だけ世代と残存gateを更新", async () => {
    const script = new URL("../src/prepare_image_authorization_deployment.ts", import.meta.url).pathname;
    const options = { env: { ...process.env, ISUREAL_DB_HOST: '127.0.0.1', ISUREAL_DB_PORT: pgPort!,
      ISUREAL_DB_USER: 'postgres', ISUREAL_DB_PASSWORD: '', ISUREAL_DB_NAME: config.dbName,
      ISUREAL_IMAGE_AUTH_REDIS_URL: activeRedisURL }, stdio: 'pipe' as const };
    assert.throws(() => execFileSync(process.execPath, [script, '--all-writers-stopped'], options));
    for (const cache of caches) cache.close();
    for (const db of databases.splice(0)) await db.end();
    await admin.end(); adminClosed = true;
    const client = new ImageAuthorizationCache(activeRedisURL);
    await client.connect();
    try {
      await client.beginMutation('reactor');
      execFileSync(process.execPath, [script, '--all-writers-stopped'], options);
      const params = new URL(url('profile'), 'http://test').searchParams;
      const lookup = await client.lookup('profile', String(exp), params.get('sig')!);
      assert.equal(lookup?.image, undefined);
      assert.ok(await client.snapshot(lookup!, 'reactor'), 'orphaned gates are cleared only after quiescence');
      execFileSync(process.execPath, [script, '--all-writers-stopped'], options);
      assert.ok(await client.snapshot(lookup!, 'reactor'), 'repeated deployment preparation is safe');
    } finally { client.close(); }
  });

});

const readFileSQL = await readFile(new URL("../../sql/reset.sql", import.meta.url), "utf8");
