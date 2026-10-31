import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Hono } from "hono";
import pg from "pg";
import jpeg from "jpeg-js";
import { apiErrorHandler } from "../src/api_error.ts";
import { DB } from "../src/db.ts";
import { getImageHandler } from "../src/image_api.ts";
import { imageSignature } from "../src/image_signature.ts";
import { ImageFiles } from "../src/image_files.ts";
import { imageNginx } from "./helpers/image-nginx.ts";
import type { Env, HandlerContext } from "../src/server.ts";

// Explicit opt-in: use a fresh disposable PostgreSQL on localhost, never the contest DB.
const port = process.env.IMAGE_SQL_TEST_PORT;
test("image API with PostgreSQL partitions", { skip: !port }, async (t) => {
  const config = {
    dbHost: "127.0.0.1", dbPort: port!, dbUser: "postgres", dbPassword: "",
    dbName: process.env.IMAGE_SQL_TEST_DB ?? "isureal_image_index_test", region: "asia", logLevel: "error",
  };
  const admin = new pg.Client({ host: config.dbHost, port: Number(port), user: config.dbUser, database: config.dbName });
  await admin.connect();
  t.after(() => admin.end());
  const tables = await admin.query("SELECT count(*) FROM pg_tables WHERE schemaname='public'");
  assert.equal(tables.rows[0].count, "0", "requires a fresh disposable database");
  await admin.query(await readFile(new URL("../../sql/001-schema.sql", import.meta.url), "utf8"));
  await admin.query(`
    INSERT INTO users(id,username,secret_key_hash,display_name,region,status)
    SELECT name,name,repeat('ab',32),name,'asia',CASE WHEN name='inactive' THEN 'deleted' ELSE 'active' END
    FROM unnest(ARRAY['reactor','author','other','inactive']) name;
    INSERT INTO users(id,username,secret_key_hash,display_name,region)
    SELECT 'bulk-user-'||n,'bulk-user-'||n,repeat('ab',32),'fixture','asia' FROM generate_series(1,5000) n;
    INSERT INTO posting_windows(id,region,local_date,starts_at,on_time_deadline)
    VALUES('window','asia','2026-10-01','2026-10-01','2026-10-02');
    INSERT INTO posts(id,author_id,posting_window_id,image_id,visibility,location_kind,posted_at)
    SELECT 'bulk-post-'||n,'author','window','bulk-image-'||n,'public','none','2026-10-01' FROM generate_series(1,30000) n;
    INSERT INTO realmojis(id,post_id,reactor_id,image_id,reaction_type,created_at)
    SELECT 'bulk-r-'||n,'bulk-post-'||n,'reactor','bulk-r-image-'||n,'smile','2026-10-01' FROM generate_series(1,30000) n;
    INSERT INTO image_objects(id,owner_user_id,data,media_type,created_at)
    SELECT name,CASE WHEN name='inactive-reactor' THEN 'inactive' ELSE 'reactor' END,
      decode('010203','hex'),'image/jpeg','2026-10-01 01:02:03.123456+00'
    FROM unnest(ARRAY['valid','replaced','deleted','wrong-reactor','deleted-post','inactive-author','inactive-reactor','orphan','profile','post-image']) name;
    INSERT INTO posts(id,author_id,posting_window_id,image_id,visibility,location_kind,posted_at,deleted_at)
    SELECT 'p-'||name,CASE WHEN name='inactive-author' THEN 'inactive' ELSE 'author' END,
      'window','p-image-'||name,'public','none','2026-10-01',CASE WHEN name='deleted-post' THEN '2026-10-02'::timestamptz END
    FROM unnest(ARRAY['valid','replaced','deleted','wrong-reactor','deleted-post','inactive-author','inactive-reactor']) name;
    INSERT INTO realmojis(id,post_id,reactor_id,image_id,reaction_type,created_at,replaced_at,deleted_at)
    SELECT 'r-'||name,'p-'||name,CASE WHEN name='wrong-reactor' THEN 'other' WHEN name='inactive-reactor' THEN 'inactive' ELSE 'reactor' END,
      name,'smile','2026-10-01',CASE WHEN name='replaced' THEN '2026-10-02'::timestamptz END,
      CASE WHEN name='deleted' THEN '2026-10-02'::timestamptz END
    FROM unnest(ARRAY['valid','replaced','deleted','wrong-reactor','deleted-post','inactive-author','inactive-reactor']) name;
    INSERT INTO posts(id,author_id,posting_window_id,image_id,visibility,location_kind,posted_at)
    VALUES('p-post-image','reactor','window','post-image','public','none','2026-10-01');
    UPDATE users SET profile_image_id='profile' WHERE id='reactor';
    ANALYZE;
  `);
  const db = new DB(config, 1);
  t.after(() => db.end());
  const exp = Math.floor(Date.now() / 1000) + 3600;
  function url(id: string, expires = exp, key = Buffer.from("ab".repeat(32), "hex")) {
    return `/api/images/${id}?exp=${expires}&sig=${imageSignature(key,id,expires).toString("base64url")}`;
  }
  async function request(path: string, afterOwner?: () => Promise<unknown>, imageFiles?: ImageFiles) {
    const calls: { sql: string; args: unknown[] }[] = [];
    const wrapped = { async get<T>(sql: string, ...args: unknown[]) {
      calls.push({ sql, args });
      const row = await db.get<T>(sql, ...args);
      if (calls.length === 1) await afterOwner?.();
      return row;
    } } as DB;
    const app = new Hono<Env>().onError(apiErrorHandler);
    app.get("/api/images/:imageId", getImageHandler({ db: wrapped, imageFiles } as HandlerContext));
    return { response: await app.request(path), calls };
  }
  async function forbidden(response: Response) {
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: "image_forbidden" });
    assert.equal(response.headers.get("cache-control"), "no-store");
  }
  for (const id of ["valid", "profile", "post-image", "replaced", "deleted", "wrong-reactor", "deleted-post", "inactive-author", "inactive-reactor", "orphan", "missing"]) {
    await t.test(id, async () => {
      const { response, calls } = await request(url(id));
      if (["valid", "profile", "post-image"].includes(id)) {
        assert.equal(response.status, 200);
        assert.equal(response.headers.get("content-type"), "image/jpeg");
        assert.equal(response.headers.get("cache-control"), "no-store");
        assert.deepEqual(Buffer.from(await response.arrayBuffer()), Buffer.from([1,2,3]));
        assert.equal(calls.length, 2);
      } else await forbidden(response);
    });
  }
  for (const timestamp of ["2024-08-31T23:59:59.123456Z", "2024-09-01T00:00:00.000001Z", "2026-10-28T05:59:59.999999Z", "2026-10-28T15:00:00+09:00", "2027-08-01T00:00:00.123456Z"]) {
    await t.test(`partition boundary ${timestamp}`, async () => {
      await admin.query("INSERT INTO image_objects(id,owner_user_id,data,media_type,created_at) VALUES('boundary','reactor',$1,'image/png',$2)", [Buffer.from([4,5,6]),timestamp]);
      await admin.query("UPDATE users SET profile_image_id='boundary' WHERE id='reactor'");
      try {
        const { response, calls } = await request(url("boundary"));
        assert.equal(response.status, 200);
        assert.equal(response.headers.get("content-type"), "image/png");
        assert.deepEqual(Buffer.from(await response.arrayBuffer()), Buffer.from([4,5,6]));
        assert.equal((calls[1].args[1] as Temporal.Instant).epochNanoseconds, Temporal.Instant.from(timestamp).epochNanoseconds);
      } finally {
        await admin.query("UPDATE users SET profile_image_id='profile' WHERE id='reactor'");
        await admin.query("DELETE FROM image_objects WHERE id='boundary'");
      }
    });
  }
  const races = [
    ["valid", "UPDATE realmojis SET replaced_at=clock_timestamp() WHERE id='r-valid'", "UPDATE realmojis SET replaced_at=NULL WHERE id='r-valid'"],
    ["valid", "UPDATE realmojis SET deleted_at=clock_timestamp() WHERE id='r-valid'", "UPDATE realmojis SET deleted_at=NULL WHERE id='r-valid'"],
    ["valid", "UPDATE posts SET deleted_at=clock_timestamp() WHERE id='p-valid'", "UPDATE posts SET deleted_at=NULL WHERE id='p-valid'"],
    ["valid", "UPDATE users SET status='deleted' WHERE id='author'", "UPDATE users SET status='active' WHERE id='author'"],
    ["valid", "UPDATE users SET status='deleted' WHERE id='reactor'", "UPDATE users SET status='active' WHERE id='reactor'"],
    ["profile", "UPDATE users SET profile_image_id=NULL WHERE id='reactor'", "UPDATE users SET profile_image_id='profile' WHERE id='reactor'"],
  ];
  for (const [id, change, restore] of races) {
    await t.test(`rechecks after owner lookup: ${change}`, async () => {
      try { await forbidden((await request(url(id), () => admin.query(change))).response); }
      finally { await admin.query(restore); }
    });
  }
  await t.test("image removed after owner lookup", async () => {
    await admin.query("CREATE TEMP TABLE saved_image AS SELECT * FROM image_objects WHERE id='valid'");
    try { await forbidden((await request(url("valid"), () => admin.query("DELETE FROM image_objects WHERE id='valid'"))).response); }
    finally { await admin.query("INSERT INTO image_objects SELECT * FROM saved_image"); }
  });
  await t.test("invalid signature never reads image body", async () => {
    const { response, calls } = await request(url("valid", exp, Buffer.alloc(32)));
    await forbidden(response);
    assert.equal(calls.length, 1);
  });
  await t.test("expired URL never queries database", async () => {
    const { response, calls } = await request(url("valid", 1));
    await forbidden(response);
    assert.equal(calls.length, 0);
  });
  await t.test("expiry is checked again after body lookup", async (t) => {
    let nowCalls = 0;
    t.mock.method(Temporal.Now, "instant", () => Temporal.Instant.fromEpochMilliseconds((++nowCalls === 1 ? exp-1 : exp+1)*1000));
    const { response, calls } = await request(url("valid"));
    await forbidden(response);
    assert.equal(calls.length, 2);
  });
  await t.test("generic plan prunes 35 partitions and searches users by PK", async () => {
    const { calls } = await request(url("valid"));
    await admin.query("SET plan_cache_mode=force_generic_plan");
    await admin.query("PREPARE image_body AS " + calls[1].sql);
    const plan = await admin.query("EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) EXECUTE image_body('valid','2026-10-01 01:02:03.123456+00','reactor')");
    function flatten(node: any): any[] { return [node, ...(node.Plans ?? []).flatMap(flatten)]; }
    const nodes = flatten(plan.rows[0]["QUERY PLAN"][0].Plan);
    assert.ok(nodes.some(n => n["Subplans Removed"] === 35));
    assert.ok(nodes.some(n => n["Index Name"] === "users_pkey" && n.Alias === "u"));
    assert.ok(!nodes.some(n => n["Node Type"] === "Seq Scan" && n.Alias === "u"));
    assert.equal(nodes.filter(n => n["Relation Name"]?.startsWith("image_objects_") && n["Actual Loops"] > 0).length, 1);
  });

  await t.test("ファイル配信のcold/warm・失効・版変更・全地域の初期化", async (t) => {
    await admin.query(await readFile(new URL("../../sql/003-initial-snapshot.sql", import.meta.url), "utf8"));
    const migration = await readFile(new URL("../../sql/migrations/20261031-image-file-generation.up.sql", import.meta.url), "utf8");
    await admin.query(migration);
    await admin.query(migration);
    const directory = await mkdtemp(join(tmpdir(), "isu15-image-api-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const files = new ImageFiles(join(directory, "region-a"), 0);
    const otherRegion = new ImageFiles(join(directory, "region-b"), 0);
    const original = Buffer.from([1, 2, 3]);
    await t.test("base64転送でJPEG・PNG・全バイト値を直接応答・ファイル・fallbackへ復元", async () => {
      const fixtures = [
        { mediaType: "image/jpeg", data: jpeg.encode({ width: 2, height: 1, data: Buffer.from([255, 0, 0, 255, 0, 0, 255, 255]) }, 90).data },
        { mediaType: "image/png", data: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==", "base64") },
        // 多数のbase64改行と、0x00・非UTF-8を含む200KiBの合成データも検証する。
        { mediaType: "image/png", data: Buffer.from(Array.from({ length: 200 * 1024 }, (_, i) => i & 255)) },
        { mediaType: "image/png", data: Buffer.alloc(0) },
      ];
      const transferFiles = new ImageFiles(join(directory, "base64"), 0);
      const full = new ImageFiles(join(directory, "base64-full"), Number.MAX_SAFE_INTEGER);
      try {
        for (const { mediaType, data } of fixtures) {
          await admin.query("UPDATE image_objects SET data=$1, media_type=$2 WHERE id='valid'", [data, mediaType]);
          const direct = await request(url("valid"));
          assert.equal(direct.response.status, 200);
          assert.equal(direct.response.headers.get("content-type"), mediaType);
          assert.deepEqual(Buffer.from(await direct.response.arrayBuffer()), data);
          const cold = await request(url("valid"), undefined, transferFiles);
          assert.equal(cold.response.status, 200);
          const uri = cold.response.headers.get("x-accel-redirect")!;
          assert.ok(uri);
          assert.deepEqual(await readFile(join(transferFiles.directory, uri.slice("/_isureal_images/".length))), data);
          const warm = await request(url("valid"), undefined, transferFiles);
          assert.equal(warm.response.status, 200);
          assert.equal(warm.response.headers.get("x-accel-redirect"), uri);
          assert.match(warm.calls[1].sql, /SELECT NULL::text AS data_base64/);
          const fallback = await request(url("valid"), undefined, full);
          assert.equal(fallback.response.status, 200);
          assert.equal(fallback.response.headers.get("x-accel-redirect"), null);
          assert.deepEqual(Buffer.from(await fallback.response.arrayBuffer()), data);
        }
      } finally {
        await admin.query("UPDATE image_objects SET data=$1, media_type='image/jpeg' WHERE id='valid'", [original]);
      }
    });
    const cold = await request(url("valid"), undefined, files);
    assert.equal(cold.response.status, 200);
    const uri = cold.response.headers.get("x-accel-redirect")!;
    assert.match(uri, /^\/_isureal_images\/initial\/[a-f0-9]{2}\/[a-f0-9]{64}\.jpg$/);
    assert.equal((await cold.response.arrayBuffer()).byteLength, 0);
    assert.deepEqual(await readFile(join(files.directory, uri.slice("/_isureal_images/".length))), original);
    const warm = await request(url("valid"), undefined, new ImageFiles(files.directory, 0));
    assert.equal(warm.response.headers.get("x-accel-redirect"), uri);
    assert.match(warm.calls[1].sql, /SELECT NULL::text AS data_base64/);
    const regionB = await request(url("valid"), undefined, otherRegion);
    assert.equal(regionB.response.headers.get("x-accel-redirect"), uri);
    assert.deepEqual(await readFile(join(otherRegion.directory, uri.slice("/_isureal_images/".length))), original);

    for (const [id, change, restore] of races) {
      try {
        assert.equal((await request(url(id), undefined, files)).response.status, 200);
        await forbidden((await request(url(id), () => admin.query(change), files)).response);
      } finally { await admin.query(restore); }
    }
    await forbidden((await request(url("valid", exp, Buffer.alloc(32)), undefined, files)).response);
    await forbidden((await request(url("valid", 1), undefined, files)).response);
    await t.test("書き出し中に期限が過ぎたらredirectを返さない", async (t) => {
      let calls = 0;
      t.mock.method(Temporal.Now, "instant", () => Temporal.Instant.fromEpochMilliseconds((++calls < 3 ? exp-1 : exp+1)*1000));
      const result = await request(url("post-image"), undefined, files);
      await forbidden(result.response);
      assert.equal(result.response.headers.get("x-accel-redirect"), null);
    });
    try {
      const result = await request(url("valid"), () => admin.query("UPDATE image_objects SET data=$1 WHERE id='valid'", [Buffer.from([9, 8])]), files);
      await forbidden(result.response);
      const changed = await request(url("valid"), undefined, files);
      assert.notEqual(changed.response.headers.get("x-accel-redirect"), uri);
    } finally { await admin.query("UPDATE image_objects SET data=$1 WHERE id='valid'", [original]); }
    const fallback = await request(url("valid"), undefined, new ImageFiles(join(directory, "full"), Number.MAX_SAFE_INTEGER));
    assert.equal(fallback.response.status, 200);
    assert.equal(fallback.response.headers.get("x-accel-redirect"), null);
    assert.deepEqual(Buffer.from(await fallback.response.arrayBuffer()), original);

    const created = (await admin.query("INSERT INTO image_objects(id,owner_user_id,data,media_type) VALUES('new-after-snapshot','other',$1,'image/png') RETURNING created_at::text", [Buffer.from([4, 5])])).rows[0].created_at;
    await admin.query("UPDATE users SET profile_image_id='new-after-snapshot' WHERE id='other'");
    const newURI = (await request(url("new-after-snapshot"), undefined, files)).response.headers.get("x-accel-redirect");
    assert.ok(newURI?.endsWith(".png"));
    const beforeReset = (await request(url("valid"), undefined, files)).response.headers.get("x-accel-redirect");
    const started = performance.now();
    await admin.query(await readFile(new URL("../../sql/reset.sql", import.meta.url), "utf8"));
    assert.ok(performance.now() - started < 60000, "synthetic reset must finish within 60 seconds");
    const afterReset = await request(url("valid"), undefined, files);
    assert.equal(afterReset.response.status, 200);
    assert.equal(afterReset.response.headers.get("x-accel-redirect"), beforeReset);
    assert.match(afterReset.calls[1].sql, /SELECT NULL::text AS data_base64/);
    assert.equal((await request(url("valid"), undefined, otherRegion)).response.headers.get("x-accel-redirect"), beforeReset);
    assert.deepEqual(await readFile(join(files.directory, afterReset.response.headers.get("x-accel-redirect")!.slice("/_isureal_images/".length))), original);
    await forbidden((await request(url("new-after-snapshot"), undefined, files)).response);
    // 同じIDと作成日時を再利用しても、旧ファイルの内容を使わない。
    await admin.query("INSERT INTO image_objects(id,owner_user_id,data,media_type,created_at) VALUES('new-after-snapshot','other',$1,'image/png',$2)", [Buffer.from([8, 9]), created]);
    await admin.query("UPDATE users SET profile_image_id='new-after-snapshot' WHERE id='other'");
    const reused = await request(url("new-after-snapshot"), undefined, files);
    assert.notEqual(reused.response.headers.get("x-accel-redirect"), newURI);
    assert.deepEqual(await readFile(join(files.directory, reused.response.headers.get("x-accel-redirect")!.slice("/_isureal_images/".length))), Buffer.from([8, 9]));

    await t.test("同一URLのwarm取得は1 SQLで認可し、更新・削除・鍵変更を即時反映", async () => {
      let queries = 0;
      const wrapped = { async get<T>(sql: string, ...args: unknown[]) {
        queries++;
        return db.get<T>(sql, ...args);
      } } as DB;
      const app = new Hono<Env>().onError(apiErrorHandler);
      app.get("/api/images/:imageId", getImageHandler({ db: wrapped, imageFiles: files } as HandlerContext));
      const first = await app.request(url("valid"));
      const uri = first.headers.get("x-accel-redirect");
      queries = 0;
      const fetch = () => app.request(url("valid"));
      assert.equal((await fetch()).status, 200);
      assert.equal(queries, 1);
      queries = 0;
      assert.equal((await fetch()).headers.get("x-accel-redirect"), uri);
      assert.equal(queries, 1);
      await admin.query("UPDATE image_signature_cache_state SET generation=generation+1 WHERE singleton");
      queries = 0;
      assert.equal((await fetch()).status, 200);
      assert.equal(queries, 3);
      await admin.query("UPDATE initial_data_boundary SET image_cache_generation=gen_random_uuid()::text");
      queries = 0;
      assert.equal((await fetch()).status, 200);
      assert.equal(queries, 3);
      try {
        await admin.query("UPDATE image_objects SET data=$1 WHERE id='valid'", [Buffer.from([7, 8])]);
        queries = 0;
        const updated = await fetch();
        assert.equal(updated.status, 200);
        assert.notEqual(updated.headers.get("x-accel-redirect"), uri);
        assert.equal(queries, 3);
        await admin.query("UPDATE realmojis SET deleted_at=clock_timestamp() WHERE id='r-valid'");
        await forbidden(await fetch());
        await admin.query("UPDATE realmojis SET deleted_at=NULL WHERE id='r-valid'");
        assert.equal((await fetch()).status, 200);
        await admin.query("UPDATE users SET secret_key_hash=repeat('cd',32) WHERE id='reactor'");
        await forbidden(await fetch());
      } finally {
        await admin.query("UPDATE users SET secret_key_hash=repeat('ab',32) WHERE id='reactor'");
        await admin.query("UPDATE realmojis SET deleted_at=NULL WHERE id='r-valid'");
        await admin.query("UPDATE image_objects SET data=$1 WHERE id='valid'", [original]);
      }
    });

    if (process.env.IMAGE_FILE_NGINX_TEST === "1") {
      const nginx = await imageNginx(db, files);
      try {
        const response = await nginx.request(url("valid"));
        assert.equal(response.status, 200);
        assert.equal(response.headers["content-type"], "image/jpeg");
        assert.ok(String(response.headers["cache-control"]).includes("no-store"));
        assert.equal(response.headers["x-accel-redirect"], undefined);
        assert.deepEqual(response.body, original);
        const png = await nginx.request(url("new-after-snapshot"));
        assert.equal(png.headers["content-type"], "image/png");
        assert.deepEqual(png.body, Buffer.from([8, 9]));
        const internalURI = afterReset.response.headers.get("x-accel-redirect")!;
        assert.equal((await nginx.request(internalURI)).status, 404);
        assert.equal((await nginx.request("/_isureal_images/../etc/passwd")).status, 404);
        const ranged = await nginx.request(url("valid"), { Range: "bytes=0-0", "If-Modified-Since": "Fri, 01 Jan 2100 00:00:00 GMT" });
        assert.equal(ranged.status, 200);
        assert.deepEqual(ranged.body, original);
        assert.equal((await nginx.request(url("valid", exp, Buffer.alloc(32)))).status, 403);
        assert.equal((await nginx.request(url("valid", 1))).status, 403);
        try {
          await admin.query("UPDATE posts SET deleted_at=clock_timestamp() WHERE id='p-valid'");
          assert.equal((await nginx.request(url("valid"))).status, 403);
        } finally { await admin.query("UPDATE posts SET deleted_at=NULL WHERE id='p-valid'"); }
      } finally { await nginx.close(); }
    }
  });
});
