// Local-only comparison. Requires a fresh disposable PostgreSQL DB on loopback.
// EXPORT_BENCH_PG_PORT=<port> EXPORT_BENCH_MIB_PER_SECOND=2 node test/export-transfer.bench.ts
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import net from "node:net";
import { Transform } from "node:stream";
import { performance } from "node:perf_hooks";
import { Hono } from "hono";
import pg from "pg";
import JSZip from "jszip";
import { DB, type Row } from "../src/db.ts";
import { exportPostsHandler } from "../src/export_api.ts";
import type { Env, HandlerContext } from "../src/server.ts";
import { referenceExportHandler } from "./helpers/export-reference.ts";

const port = Number(process.env.EXPORT_BENCH_PG_PORT);
assert.ok(port > 0 && port < 65536, "set EXPORT_BENCH_PG_PORT to a local disposable PG");
const rate = Number(process.env.EXPORT_BENCH_MIB_PER_SECOND ?? "0") * 1024 * 1024;
assert.ok(Number.isFinite(rate) && rate >= 0);
const database = `export_transfer_${Date.now()}`;
const admin = new pg.Client({ host: "127.0.0.1", port, user: "postgres", database: "postgres" });
await admin.connect();
await admin.query(`CREATE DATABASE ${database}`);
await admin.end();
const seed = new pg.Client({ host: "127.0.0.1", port, user: "postgres", database });
await seed.connect();
await seed.query(await readFile(new URL("../../sql/001-schema.sql", import.meta.url), "utf8"));
await seed.query("INSERT INTO users(id,username,secret_key_hash,display_name,region) VALUES('viewer','viewer',$1,'viewer','asia')", ["ab".repeat(32)]);
await seed.query("INSERT INTO posting_windows(id,region,local_date,starts_at,on_time_deadline,ended_at) VALUES('window','asia','2026-01-01','2026-01-01','2026-01-01','2026-01-02')");
const count = 100;
const image = randomBytes(50 * 1024);
for (let i = 0; i < count; i++) {
  await seed.query("INSERT INTO image_objects(id,owner_user_id,data,media_type,created_at) VALUES($1,'viewer',$2,'image/jpeg','2026-01-01')", [`image-${i}`, image]);
  await seed.query("INSERT INTO posts(id,author_id,posting_window_id,image_id,caption,visibility,location_kind,posted_at) VALUES($1,'viewer','window',$2,'caption','public','none','2026-01-01')", [`post-${i}`, `image-${i}`]);
}
await seed.query("ANALYZE");
await seed.end();

let receivedBytes = 0;
const sockets = new Set<net.Socket>();
const proxy = net.createServer((downstream) => {
  const upstream = net.connect(port, "127.0.0.1");
  for (const socket of [downstream, upstream]) {
    sockets.add(socket);
    socket.setNoDelay(true);
    socket.on("close", () => sockets.delete(socket));
  }
  const transfer = new Transform({ transform(chunk: Buffer, _encoding, callback) {
    receivedBytes += chunk.length;
    if (rate) setTimeout(() => callback(null, chunk), Math.ceil(chunk.length / rate * 1000));
    else callback(null, chunk);
  } });
  downstream.on("error", () => upstream.destroy());
  upstream.on("error", () => downstream.destroy());
  downstream.pipe(upstream);
  upstream.pipe(transfer).pipe(downstream);
});
await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
const address = proxy.address();
assert.ok(address && typeof address !== "string");
const config = { region: "asia", logLevel: "error", dbHost: "127.0.0.1", dbPort: String(address.port), dbUser: "postgres", dbPassword: "", dbName: database };
const db = new DB(config, 1);
await db.ping();
const stamp = Temporal.Instant.from("2026-10-31T05:07:22Z");
Temporal.Now.instant = () => stamp;
let mode = "hex";
let queryMs = 0;
const measuredDB = {
  get: db.get.bind(db),
  select: async (sql: string, ...args: unknown[]) => {
    const start = performance.now();
    const rows = await db.select<Row>(sql, ...args);
    queryMs = performance.now() - start;
    return rows;
  },
};
const app = new Hono<Env>();
app.use(async (c, next) => { c.set("session", { userID: "viewer", region: "asia", token: "", tokenHash: "", createdAt: stamp }); await next(); });
app.get("/base64", exportPostsHandler({ db: measuredDB } as unknown as HandlerContext));
app.get("/hex", referenceExportHandler({ db: measuredDB } as unknown as HandlerContext));
const results: Record<string, unknown>[] = [];
try {
  for (let sample = -1; sample < 3; sample++) {
    for (mode of (sample % 2 === 0 ? ["base64", "hex"] : ["hex", "base64"])) {
      const before = receivedBytes;
      const start = performance.now();
      const response = await app.request(`/${mode}`);
      assert.equal(response.status, 200);
      const bytes = new Uint8Array(await response.arrayBuffer());
      const elapsedMs = performance.now() - start;
      const zip = await JSZip.loadAsync(bytes, { checkCRC32: true });
      const items = JSON.parse(await zip.file("posts.json")!.async("string"));
      assert.equal(items.length, count);
      for (const item of items) assert.deepEqual(await zip.file(item.imagePath)!.async("nodebuffer"), image);
      if (sample >= 0) results.push({ mode, sample, receivedBytes: receivedBytes - before, elapsedMs: Math.round(elapsedMs), selectMs: Math.round(queryMs), assemblyAndUserMs: Math.round(elapsedMs - queryMs), zipBytes: bytes.length });
    }
  }
  console.log(JSON.stringify({ node: process.version, database, count, imageBytes: count * image.length, mibPerSecond: rate / 1024 / 1024, warmupsPerMode: 1, results }, null, 2));
} finally {
  await db.end();
  for (const socket of sockets) socket.destroy();
  await new Promise<void>((resolve, reject) => proxy.close((err) => err ? reject(err) : resolve()));
}
