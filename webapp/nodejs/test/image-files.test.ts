import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat, symlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { ImageFiles } from "../src/image_files.ts";

const generation = "11111111-1111-4111-8111-111111111111";
const stamp = Temporal.Instant.from("2026-10-31T03:00:00.123456Z");
const body = Buffer.from([1, 2, 3, 4]);

test("画像ファイルの原子的な公開・再起動後の再利用・版と世代の分離", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "isu15-image-files-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const files = new ImageFiles(join(root, "images"), 0);
  const reference = files.reference(generation, "../../id?exp=1", "owner", stamp, "123", "image/jpeg")!;
  assert.match(reference.uri, /^\/_isureal_images\/runtime\/[0-9a-f-]{36}\/[a-f0-9]{2}\/[a-f0-9]{64}\.jpg$/);
  assert.equal(await files.has(reference), false);
  assert.deepEqual(await Promise.all(Array.from({ length: 8 }, () => files.put(reference, body))), Array(8).fill(true));
  assert.equal(await files.has(reference), true);
  assert.deepEqual(await readFile(reference.path), body);
  assert.equal((await stat(reference.path)).mode & 0o777, 0o644);
  assert.equal((await readdir(dirname(reference.path))).length, 1);
  assert.equal(await new ImageFiles(files.directory).has(reference), true);
  for (const ref of [
    files.reference("22222222-2222-4222-8222-222222222222", "../../id?exp=1", "owner", stamp, "123", "image/jpeg")!,
    files.reference(generation, "../../id?exp=1", "owner", stamp, "124", "image/jpeg")!,
    files.reference(generation, "../../id?exp=1", "other", stamp, "123", "image/jpeg")!,
  ]) {
    assert.notEqual(ref.path, reference.path);
    assert.equal(await files.has(ref), false);
  }
  const png = files.reference(generation, "png", "owner", stamp, "1", "image/png")!;
  assert.ok(png.uri.endsWith(".png"));
  assert.equal(files.reference(generation, "other", "owner", stamp, "1", "image/gif"), undefined);
  assert.throws(() => files.reference("invalid", "id", "owner", stamp, "1", "image/jpeg"));
  assert.throws(() => new ImageFiles("relative"));
  await rm(reference.path);
  await symlink("/etc/passwd", reference.path);
  assert.equal(await files.has(reference), false);
});

test("容量不足・書き出し失敗では公開せずDBへのfallbackが可能", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "isu15-image-files-full-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const files = new ImageFiles(root, Number.MAX_SAFE_INTEGER);
  const ref = files.reference(generation, "id", "owner", stamp, "1", "image/jpeg")!;
  assert.equal(await files.put(ref, body), false);
  assert.equal(await files.has(ref), false);
  const broken = new ImageFiles(join(ref.path, "not-a-directory"), 0);
  // 親を通常ファイルにしてmkdirの失敗を再現する。
  const good = new ImageFiles(root, 0);
  assert.equal(await good.put(ref, body), true);
  const target = broken.reference(generation, "id", "owner", stamp, "1", "image/jpeg")!;
  assert.equal(await broken.put(target, body), false);
});
