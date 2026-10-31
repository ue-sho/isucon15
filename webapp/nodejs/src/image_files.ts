import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, rename, rm, statfs } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { logWarn } from "./response.ts";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

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
  readonly preparedDirectories = new Set<string>();

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

  fromURI(uri: string): ImageFileRef | undefined {
    const relative = uri.match(/^\/_isureal_images\/((?:initial|runtime\/[0-9a-f-]{36})\/([0-9a-f]{2})\/([0-9a-f]{64})\.(?:jpg|png))$/);
    if (!relative || relative[2] !== relative[3].slice(0, 2)) return undefined;
    return { uri, path: join(this.directory, relative[1]) };
  }

  // 一括書き出し専用。全ファイルの内容をsyncfsしてからrenameする。
  // 同期前のファイルは.tmpなので画像APIから参照されない。
  async putBatch(entries: { file: ImageFileRef; data: Uint8Array<ArrayBuffer> }[]): Promise<void> {
    if (!entries.length) return;
    await mkdir(this.directory, { recursive: true, mode: 0o755 });
    await chmod(this.directory, 0o755);
    const space = await statfs(this.directory);
    if (space.bavail * space.bsize < this.minFreeBytes + entries.reduce((sum, e) => sum + e.data.byteLength, 0)) {
      throw new Error("image export stopped: disk space or write failure");
    }
    const staged = entries.map(e => ({ ...e, temporary: e.file.path + "." + randomUUID() + ".tmp", published: false }));
    try {
      for (const parent of new Set(entries.map(e => dirname(e.file.path)))) {
        if (this.preparedDirectories.has(parent)) continue;
        await mkdir(parent, { recursive: true, mode: 0o755 });
        await chmod(parent, 0o755);
        this.preparedDirectories.add(parent);
      }
      for (let start = 0; start < staged.length; start += 32) {
        const writes = await Promise.allSettled(staged.slice(start, start + 32).map(async e => {
          const handle = await open(e.temporary, "wx", 0o644);
          try { await handle.writeFile(e.data); await handle.chmod(0o644); }
          finally { await handle.close(); }
        }));
        const failed = writes.find(w => w.status === "rejected");
        if (failed?.status === "rejected") throw failed.reason;
      }
      await execFileAsync("sync", ["-f", this.directory]);
      for (let start = 0; start < staged.length; start += 32) {
        const renames = await Promise.allSettled(staged.slice(start, start + 32).map(async e => {
          await rename(e.temporary, e.file.path);
          e.published = true;
        }));
        const failed = renames.find(w => w.status === "rejected");
        if (failed?.status === "rejected") throw failed.reason;
      }
      await execFileAsync("sync", ["-f", this.directory]);
    } finally {
      await Promise.allSettled(staged.filter(e => !e.published).map(e => rm(e.temporary, { force: true })));
    }
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
        // DBに永続化済みの派生キャッシュ。write完了後のrenameで公開し、
        // リクエスト中のfsyncは省く。消失時はDBから再生成できる。
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
