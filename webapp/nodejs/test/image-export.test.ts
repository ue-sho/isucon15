import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DB } from "../src/db.ts";
import { exportImageFiles } from "../src/export_image_files.ts";
import { ImageFiles, imageFileGenerationSQL } from "../src/image_files.ts";

const port = process.env.IMAGE_EXPORT_TEST_PORT;
test("全画像の一括書き出し・再実行・世代変更・失敗後の復旧", { skip: !port }, async (t) => {
  const config = { dbHost: "127.0.0.1", dbPort: port!, dbUser: "postgres", dbPassword: "", dbName: process.env.IMAGE_EXPORT_TEST_DB ?? "image_export_test", region: "asia", logLevel: "error" };
  const db = new DB(config, 1);
  t.after(() => db.end());
  assert.equal((await db.get<{ count: number }>("SELECT count(*) FROM pg_tables WHERE schemaname='public'"))!.count, 0, "fresh disposable DB required");
  await db.exec("CREATE TABLE initial_data_boundary (image_cache_generation text, created_at timestamptz)");
  await db.exec("INSERT INTO initial_data_boundary VALUES (gen_random_uuid()::text, now() + interval '1 day')");
  await db.exec("CREATE TABLE users (id text PRIMARY KEY, region text)");
  await db.exec("INSERT INTO users VALUES ('owner', 'asia')");
  await db.exec("CREATE TABLE image_objects (id text, owner_user_id text, created_at timestamptz, media_type text, data bytea)");
  await db.exec(`INSERT INTO image_objects SELECT n::text, 'owner', now(), CASE WHEN n=1025 THEN 'image/gif' WHEN n%2=0 THEN 'image/png' ELSE 'image/jpeg' END, decode('010203','hex') FROM generate_series(1,1025) n`);
  const root = await mkdtemp(join(tmpdir(), "image-export-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const files = new ImageFiles(join(root, "images"), 0);
  assert.deepEqual(await exportImageFiles(db, files), { written: 1024, existing: 0, unsupported: 1, bytes: 3072 });
  assert.deepEqual(await exportImageFiles(db, files), { written: 0, existing: 1024, unsupported: 1, bytes: 0 });
  const row = await db.get<any>(`SELECT i.*, i.xmin::text AS version, ${imageFileGenerationSQL} AS generation FROM image_objects i CROSS JOIN initial_data_boundary b WHERE i.id='1'`);
  assert.deepEqual(await readFile(files.reference(row.generation, row.id, row.owner_user_id, row.created_at, row.version, row.media_type)!.path), Buffer.from([1,2,3]));
  await db.exec("UPDATE initial_data_boundary SET image_cache_generation=gen_random_uuid()::text");
  assert.equal((await exportImageFiles(db, files)).existing, 1024);
  await assert.rejects(exportImageFiles(db, new ImageFiles(join(root, "full"), Number.MAX_SAFE_INTEGER)), /disk space/);
  assert.equal((await exportImageFiles(db, files)).existing, 1024);
  assert.equal((await exportImageFiles(db, new ImageFiles(join(root, "europe"), 0), "europe")).written, 0);
  assert.equal((await exportImageFiles(db, new ImageFiles(join(root, "asia"), 0), "asia")).written, 1024);
  class ResetDuringWrite extends ImageFiles {
    reset = false;
    override async putBatch(entries: Parameters<ImageFiles["putBatch"]>[0]) {
      if (!this.reset) {
        this.reset = true;
        const other = new DB(config, 1);
        try { await other.exec("UPDATE initial_data_boundary SET image_cache_generation=gen_random_uuid()::text"); }
        finally { await other.end(); }
      }
      return super.putBatch(entries);
    }
  }
  await assert.rejects(exportImageFiles(db, new ResetDuringWrite(join(root, "reset"), 0)), /rerun export/);
});
