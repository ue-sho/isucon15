import { Worker } from "node:worker_threads";
import type { JPEGImage } from "./jpeg.ts";

type Waiter = {
  resolve: () => void;
  reject: (error: unknown) => void;
  signal?: AbortSignal;
  abort: () => void;
};
type Decoded = { data: ArrayBuffer; image: JPEGImage | null };

// アプリプロセスごとに最大1デコード。待機中は本文を読み込まない。
// DB接続や認可結果をworkerに渡さず、完全なJPEG検証だけを分離する。
export class JPEGDecoder {
  readonly #workerURL: URL;
  #worker?: Worker;
  #busy = false;
  #closed = false;
  #waiters: Waiter[] = [];
  #pending?: { resolve: (value: Decoded) => void; reject: (error: unknown) => void };

  constructor(workerURL = new URL("./jpeg_worker.ts", import.meta.url)) {
    this.#workerURL = workerURL;
  }

  async decode(readBody: () => Promise<ArrayBuffer>, signal?: AbortSignal): Promise<{ data: Buffer; image: JPEGImage | null }> {
    await this.#acquire(signal);
    try {
      signal?.throwIfAborted();
      const data = await readBody();
      signal?.throwIfAborted();
      if (this.#closed) throw new Error("JPEG decoder closed");
      const bytes = new Uint8Array(data);
      // jpeg-jsもSOI不一致は必ず拒否する。寸法だけで完全検証を省略しない。
      if (bytes.length < 2 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
        return { data: Buffer.from(data), image: null };
      }
      const worker = this.#getWorker();
      worker.ref();
      const decoded = await new Promise<Decoded>((resolve, reject) => {
        this.#pending = { resolve, reject };
        try { worker.postMessage(data, [data]); }
        catch (error) {
          this.#pending = undefined;
          worker.unref();
          reject(error);
        }
      });
      signal?.throwIfAborted();
      return { data: Buffer.from(decoded.data), image: decoded.image };
    } finally {
      this.#release();
    }
  }

  #getWorker(): Worker {
    if (this.#worker) return this.#worker;
    // HTTP profiler等のpreloadを画像検証threadで再実行しない。
    const worker = new Worker(this.#workerURL, { execArgv: [], env: { ...process.env, NODE_OPTIONS: "" } });
    this.#worker = worker;
    worker.on("message", (value: Decoded) => {
      if (this.#worker !== worker) return;
      const pending = this.#pending;
      this.#pending = undefined;
      worker.unref();
      pending?.resolve(value);
    });
    const failed = (error: Error) => {
      if (this.#worker !== worker) return;
      this.#worker = undefined;
      const pending = this.#pending;
      this.#pending = undefined;
      worker.unref();
      pending?.reject(error);
    };
    worker.on("error", failed);
    worker.on("exit", (code) => failed(new Error(`JPEG worker exited (${code})`)));
    worker.unref();
    return worker;
  }

  async #acquire(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    if (this.#closed) throw new Error("JPEG decoder closed");
    if (!this.#busy) {
      this.#busy = true;
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const waiter: Waiter = { resolve, reject, signal, abort: () => {
        const index = this.#waiters.indexOf(waiter);
        if (index >= 0) this.#waiters.splice(index, 1);
        reject(signal!.reason);
      } };
      this.#waiters.push(waiter);
      signal?.addEventListener("abort", waiter.abort, { once: true });
    });
  }

  #release(): void {
    const waiter = this.#waiters.shift();
    if (waiter) {
      waiter.signal?.removeEventListener("abort", waiter.abort);
      waiter.resolve();
    } else {
      this.#busy = false;
    }
  }

  async close(): Promise<void> {
    this.#closed = true;
    const error = new Error("JPEG decoder closed");
    for (const waiter of this.#waiters.splice(0)) {
      waiter.signal?.removeEventListener("abort", waiter.abort);
      waiter.reject(error);
    }
    this.#pending?.reject(error);
    this.#pending = undefined;
    const worker = this.#worker;
    this.#worker = undefined;
    await worker?.terminate();
  }
}
