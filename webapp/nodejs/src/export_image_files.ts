import { configFromEnv } from "./config.ts";
import { DB, type Queryer } from "./db.ts";
import { ImageFiles, imageFileGenerationSQL } from "./image_files.ts";
import { pathToFileURL } from "node:url";

type Image = {
  id: string; owner_user_id: string; created_at: Temporal.Instant;
  image_version: string; media_type: string; data: Uint8Array<ArrayBuffer>;
  image_file_generation: string;
};

// 単一スナップショットのcursorを使い、画像全体をメモリへ載せない。
export async function exportImageFiles(db: DB, files: ImageFiles) {
  const result = { written: 0, existing: 0, unsupported: 0, bytes: 0 };
  await using tx = await db.begin();
  await tx.exec("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
  const boundary = await tx.get<{ image_cache_generation: string }>("SELECT image_cache_generation FROM initial_data_boundary");
  if (!boundary) throw new Error("missing image cache generation");
  await tx.exec(`DECLARE image_export NO SCROLL CURSOR FOR
    SELECT i.id, i.owner_user_id, i.created_at, i.xmin::text AS image_version, i.media_type, i.data,
      ${imageFileGenerationSQL} AS image_file_generation
    FROM image_objects i CROSS JOIN initial_data_boundary b`);
  for (;;) {
    const rows = await tx.select<Image>("FETCH FORWARD 512 FROM image_export");
    if (!rows.length) break;
    for (let start = 0; start < rows.length; start += 8) {
    const writes = await Promise.allSettled(rows.slice(start, start + 8).map(async (row) => {
      const file = files.reference(row.image_file_generation, row.id, row.owner_user_id, row.created_at, row.image_version, row.media_type);
      if (!file) { result.unsupported++; return; }
      if (await files.has(file)) { result.existing++; return; }
      if (!await files.put(file, row.data)) throw new Error("image export stopped: disk space or write failure");
      result.written++;
      result.bytes += row.data.byteLength;
    }));
    const failed = writes.find((write) => write.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
    }
    if ((result.written + result.existing + result.unsupported) % 6400 === 0) console.log(JSON.stringify({ progress: true, ...result }));
  }
  await tx.exec("CLOSE image_export");
  await tx.commit();
  await assertGeneration(db, boundary.image_cache_generation);
  return result;
}

async function assertGeneration(db: Queryer, expected: string) {
  const current = await db.get<{ image_cache_generation: string }>("SELECT image_cache_generation FROM initial_data_boundary");
  if (current?.image_cache_generation !== expected) throw new Error("initialization changed image generation; rerun export after initialization");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const config = configFromEnv();
  if (!config.imageCacheDir) throw new Error("ISUREAL_IMAGE_CACHE_DIR is required");
  const db = new DB(config, 1);
  try {
    console.log(JSON.stringify(await exportImageFiles(db, new ImageFiles(config.imageCacheDir))));
  } finally { await db.end(); }
}
