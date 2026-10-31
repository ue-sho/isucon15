import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Hono, type Handler } from "hono";
import pg from "pg";
import { apiErrorHandler } from "../../src/api_error.ts";
import { DB } from "../../src/db.ts";
import type { Env, HandlerContext } from "../../src/server.ts";
import { backfillUserSearch } from "../../src/user_search.ts";

export const searchBaseline = "993e1b0dd58d68d7b63e77bff26d046d2a0173b3";
const root = fileURLToPath(new URL("../../../..", import.meta.url));

export async function legacySearch() {
  const directory = await mkdtemp(join(tmpdir(), "isureal-search-reference-"));
  try {
    const archive = execFileSync("git", ["archive", searchBaseline, "webapp/nodejs/src"], { cwd: root });
    execFileSync("tar", ["-x", "-C", directory], { input: archive });
    await symlink(join(root, "webapp/nodejs/node_modules"), join(directory, "webapp/nodejs/node_modules"));
    const module = await import(pathToFileURL(join(directory, "webapp/nodejs/src/user_read_api.ts")).href);
    const errors = await import(pathToFileURL(join(directory, "webapp/nodejs/src/api_error.ts")).href);
    return { handler: module.searchUsersHandler as (h: HandlerContext) => Handler<Env>, errorHandler: errors.apiErrorHandler as typeof apiErrorHandler, close: () => rm(directory, { recursive: true }) };
  } catch (error) { await rm(directory, { recursive: true }); throw error; }
}

export function searchConfig(port: string) {
  assert.match(port, /^\d+$/);
  return { region: "asia", logLevel: "error", dbHost: "127.0.0.1", dbPort: port, dbUser: "postgres", dbPassword: "", dbName: "isureal_search_test" };
}

export async function searchDatabase(port: string) {
  const config = searchConfig(port);
  const admin = new pg.Client({ host: config.dbHost, port: Number(port), user: config.dbUser, database: config.dbName });
  await admin.connect();
  const db = new DB(config, 2);
  return { config, admin, db, async close() { await db.end(); await admin.end(); } };
}

export const sqlFile = (file: string) => readFile(join(root, "webapp/sql", file), "utf8");

export function searchApp(handler: (h: HandlerContext) => Handler<Env>, db: DB, errorHandler = apiErrorHandler) {
  const app = new Hono<Env>().onError(errorHandler);
  app.use("*", async (c, next) => {
    c.set("session", { userID: "viewer", region: "asia", token: "", tokenHash: "", createdAt: Temporal.Instant.from("2026-10-31T00:00:00Z") });
    await next();
  });
  app.get("/api/users", handler({ db } as HandlerContext));
  return app;
}

export async function searchFixture(admin: pg.Client, db: DB, count = 80) {
  await admin.query(`INSERT INTO users(id,username,secret_key_hash,display_name,bio,region,account_type,created_at)
    SELECT 'u-'||lpad(n::text,6,'0'),'name_'||lpad(n::text,6,'0'),repeat('ab',32),
      'common'||CASE WHEN n<=49 THEN ' n49' ELSE '' END||CASE WHEN n<=50 THEN ' n50' ELSE '' END||CASE WHEN n<=51 THEN ' n51' ELSE '' END,
      repeat('非公開bio',20),'asia',CASE WHEN n%2=0 THEN 'certified_public' ELSE 'regular' END,'2026-10-01'
    FROM generate_series(1,$1::int) n`, [count]);
  const specials = [
    ['viewer','viewer','common n49 n50 n51','active'],
    ['blocked-out','blocked-out','common n49 n50 n51','active'],
    ['blocked-in','blocked-in','common n49 n50 n51','active'],
    ['deleted','deleted','common n49 n50 n51','deleted'],
    ['accent','accent','Cafe\u0301 Ångström','active'],
    ['eszett','eszett','Straße ẞ ligature ﬃ','active'],
    ['greek','greek','ΟΣ Σςσ İıI','active'],
    ['kana','kana','カ\u3099 は\u309a 😀𐐀','active'],
    ['literal','literal','literal % _ \\ a:b|c 空 白','active'],
    ['literal-decoy','literal-decoy','literal XYZ','active'],
    ['username-only','username_token','unrelated','active'],
    ['display-only','unrelated','username_token','active'],
    ['separate','ab','cd','active'],
    ['tie-a','same','common','active'], ['tie-b','same','common','active'],
  ];
  for (const [id, username, name, status] of specials) {
    await admin.query(`INSERT INTO users(id,username,secret_key_hash,display_name,bio,region,status,created_at)
      VALUES($1,$2,repeat('ab',32),$3,'private','asia',$4,'2026-10-01')`, [id,username,name,status]);
  }
  await admin.query(`INSERT INTO block_relations(id,blocker_id,blocked_id,created_at) VALUES
    ('out','viewer','blocked-out','2026-10-01'),('in','blocked-in','viewer','2026-10-01');
    INSERT INTO friendships(id,user_low_id,user_high_id) VALUES('friend','u-000001','viewer')`);
  await admin.query(await sqlFile("003-initial-snapshot.sql"));
  await backfillUserSearch(db);
  await admin.query("ANALYZE users; ANALYZE block_relations");
}

// Counts actual PostgreSQL protocol bytes, not JSON serialization size.
// Optional RTT is synthetic and has no WAN bandwidth/CPU contention model.
export async function searchWire(targetPort: number, rttMs = 0) {
  let bytes = 0;
  const sockets = new Set<net.Socket>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  function later(callback: () => void) {
    if (!rttMs) { callback(); return; }
    const timer = setTimeout(() => { timers.delete(timer); callback(); }, rttMs / 2);
    timers.add(timer);
  }
  const server = net.createServer((downstream) => {
    const upstream = net.connect(targetPort, "127.0.0.1");
    for (const socket of [upstream, downstream]) {
      sockets.add(socket); socket.setNoDelay(true);
      socket.on("close", () => sockets.delete(socket));
    }
    downstream.on("error", () => upstream.destroy());
    upstream.on("error", () => downstream.destroy());
    downstream.on("data", (chunk) => later(() => { if (!upstream.destroyed) upstream.write(chunk); }));
    upstream.on("data", (chunk) => { bytes += chunk.length; later(() => { if (!downstream.destroyed) downstream.write(chunk); }); });
    downstream.on("end", () => later(() => upstream.end()));
    upstream.on("end", () => later(() => downstream.end()));
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address() as net.AddressInfo;
  return { port: String(address.port), get bytes() { return bytes; }, async close() {
    for (const timer of timers) clearTimeout(timer);
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  } };
}
