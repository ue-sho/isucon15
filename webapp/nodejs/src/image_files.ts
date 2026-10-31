import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, rename, rm, statfs } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { logWarn } from "./response.ts";

export type ImageFileRef = { path: string; uri: string };

// resetで残る初期画像は安定した世代を使用。追加画像だけresetの世代に従属させる。
// epochはセッションのタイムゾーンに依存しない。i/bは呼び出し側SQLのalias。
export const imageFileGenerationSQL = `CASE WHEN i.created_at <= b.created_at
  THEN 'initial:' || md5('initial:' || extract(epoch FROM b.created_at)::text)::uuid::text
  ELSE b.image_cache_generation END`;

// DBが正で、ファイルは全地域共通の世代と画像行の版に従属する派生データ。
export class ImageFiles {
  readonly directory: string;
  readonly minFreeBytes: number;

  constructor(directory: string, minFreeBytes = 512 * 1024 * 1024) {
    if (!isAbsolute(directory) || directory === "/") throw new Error("invalid image cache directory");
    this.directory = directory;
    this.minFreeBytes = minFreeBytes;
  }

  reference(generation: string, id: string, owner: string, createdAt: Temporal.Instant, version: string, mediaType: string): ImageFileRef | undefined {
    const extension = mediaType === "image/jpeg" ? "jpg" : mediaType === "image/png" ? "png" : undefined;
    if (!extension) return undefined;
    if (!/^(initial:)?[0-9a-f-]{36}$/.test(generation) || !version) throw new Error("invalid image cache generation/version");
    const hash = createHash("sha256").update(JSON.stringify([generation, id, owner, createdAt.toString(), version, mediaType])).digest("hex");
    const name = `${hash}.${extension}`;
    const scope = generation.startsWith("initial:") ? "initial" : `runtime/${generation}`;
    const relative = `${scope}/${hash.slice(0, 2)}/${name}`;
    return { path: join(this.directory, relative), uri: `/_isureal_images/${relative}` };
  }

  async has(file: ImageFileRef): Promise<boolean> {
    try { return (await lstat(file.path)).isFile(); }
    catch { return false; }
  }

  async put(file: ImageFileRef, data: Uint8Array<ArrayBuffer>): Promise<boolean> {
    const parent = dirname(file.path);
    const temporary = file.path + "." + randomUUID() + ".tmp";
    try {
      await mkdir(parent, { recursive: true, mode: 0o755 });
      await chmod(this.directory, 0o755);
      await chmod(parent, 0o755);
      const space = await statfs(this.directory);
      if (space.bavail * space.bsize < this.minFreeBytes + data.byteLength) return false;
      const handle = await open(temporary, "wx", 0o600);
      try {
        await handle.writeFile(data);
        await handle.chmod(0o644);
        await handle.sync();
      } finally { await handle.close(); }
      // 完全なファイルだけ公開する。別workerと同時でも同じ版の同じ内容になる。
      await rename(temporary, file.path);
      return true;
    } catch {
      logWarn("image file cache unavailable; serving database body");
      return false;
    } finally {
      await rm(temporary, { force: true }).catch(() => {});
    }
  }
}
