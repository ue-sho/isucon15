import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, rename, rm, statfs } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { logWarn } from "./response.ts";

export type ImageFileRef = { path: string; uri: string };

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
    if (!/^[0-9a-f-]{36}$/.test(generation) || !version) throw new Error("invalid image cache generation/version");
    const hash = createHash("sha256").update(JSON.stringify([generation, id, owner, createdAt.toString(), version, mediaType])).digest("hex");
    const name = `${hash}.${extension}`;
    return { path: join(this.directory, hash.slice(0, 2), name), uri: `/_isureal_images/${hash.slice(0, 2)}/${name}` };
  }

  async has(file: ImageFileRef): Promise<boolean> {
    try { return (await lstat(file.path)).isFile(); }
    catch { return false; }
  }

  async put(file: ImageFileRef, data: Uint8Array<ArrayBuffer>): Promise<boolean> {
    const parent = join(this.directory, file.uri.split("/")[2]);
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
