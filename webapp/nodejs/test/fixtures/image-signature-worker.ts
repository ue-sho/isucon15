// IPC-only fixture. The parent starts a disposable PostgreSQL and supplies its
// loopback port; this process never reads the application's database variables.
import crypto from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import { Hono } from "hono";
import { apiErrorHandler } from "../../src/api_error.ts";
import { DB } from "../../src/db.ts";
import { getImageHandler } from "../../src/image_api.ts";
import { imageSignature } from "../../src/image_signature.ts";
import { IPBanList } from "../../src/ip_ban.ts";
import { regionMiddleware } from "../../src/region.ts";
import type { Env, HandlerContext } from "../../src/server.ts";
import { sessionMiddleware } from "../../src/session.ts";
import { getMeHandler } from "../../src/user_api.ts";

const port = Number(process.env.SIGNATURE_FIXTURE_PORT);
const wall = Number(process.env.SIGNATURE_FIXTURE_WALL);
const region = process.env.SIGNATURE_FIXTURE_REGION;
if (!process.send || !Number.isInteger(port) || port < 1 || !Number.isFinite(wall)
  || !["asia", "europe", "america"].includes(region ?? "")) {
  throw new Error("requires the isolated generation-test parent");
}

Date.now = () => wall;
Temporal.Now.instant = () => Temporal.Instant.fromEpochMilliseconds(wall);
let hmacCalls = 0;
const originalHash = crypto.hash;
crypto.hash = ((...args: Parameters<typeof crypto.hash>) => {
  hmacCalls += 0.5;
  return originalHash(...args);
}) as typeof crypto.hash;
syncBuiltinESMExports();

class ObservedDB extends DB {
  queries = 0;
  override async get<T>(sql: string, ...args: unknown[]): Promise<T | undefined> {
    this.queries++;
    return super.get<T>(sql, ...args);
  }
}
const config = {
  dbHost: "127.0.0.1", dbPort: String(port), dbUser: "postgres", dbPassword: "",
  dbName: "image_signature_generation_test", region: region!, logLevel: "error",
};
const db = new ObservedDB(config, 2);
await db.ping();
const context: HandlerContext = { db, config, ipBans: new IPBanList() };
const app = new Hono<Env>().onError(apiErrorHandler);
app.get("/api/images/:imageId", getImageHandler(context));
app.get("/api/me", sessionMiddleware(context, true), regionMiddleware(context), getMeHandler(context));

type Command = { id: number; op: "request"; path: string; token?: string }
  | { id: number; op: "unscoped" }
  | { id: number; op: "close" };

// The parent sends one command at a time to each worker, so measured crypto and
// query counts belong to exactly one real handler invocation.
process.on("message", (command: Command) => {
  void (async () => {
    const beforeHmac = hmacCalls;
    const beforeQueries = db.queries;
    if (command.op === "close") {
      await db.end();
      process.send?.({ id: command.id, closed: true });
      process.disconnect?.();
      return;
    }
    if (command.op === "unscoped") {
      imageSignature(Buffer.from("ab".repeat(32), "hex"), `profile-${region}`, Math.floor(wall / 1000) + 86400);
      process.send?.({ id: command.id, hmacCalls: hmacCalls - beforeHmac, queries: 0 });
      return;
    }
    const response = await app.request(command.path, {
      headers: command.token ? { Authorization: `Bearer ${command.token}` } : undefined,
    });
    const body = Buffer.from(await response.arrayBuffer());
    process.send?.({
      id: command.id, status: response.status,
      hmacCalls: hmacCalls - beforeHmac, queries: db.queries - beforeQueries,
      contentType: response.headers.get("content-type"),
      body: response.headers.get("content-type")?.startsWith("application/json") ? body.toString("utf8") : body.toString("hex"),
    });
  })().catch((error: unknown) => {
    process.send?.({ id: command.id, error: error instanceof Error ? error.message : String(error) });
  });
});
process.send({ ready: true, pid: process.pid, region });
