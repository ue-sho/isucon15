// Isolated PostgreSQL comparison; no production settings or requests.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Hono, type Handler } from "hono";
import pg from "pg";
import { APIError, apiErrorHandler } from "../src/api_error.ts";
import { bind } from "../src/bind.ts";
import { DB } from "../src/db.ts";
import { jsonResponse } from "../src/response.ts";
import type { Env, HandlerContext } from "../src/server.ts";
import { createLoginSessionForLockedUserTx, sha256Hex } from "../src/session.ts";
import { loginHandler } from "../src/user_api.ts";
import { userFromRow, usernamePattern } from "../src/user.ts";
import { delayedTCP } from "./helpers/delayed-tcp.ts";

const port = Number(process.env.LOGIN_BENCH_PG_PORT);
assert.ok(port > 0, "LOGIN_BENCH_PG_PORT must refer to an isolated local test cluster");
const connection = { host: "127.0.0.1", port, user: "postgres" };
const database = `login_bench_${Date.now()}`;
const admin = new pg.Client({ ...connection, database: "postgres" });
await admin.connect();
try { await admin.query(`CREATE DATABASE ${database}`); } finally { await admin.end(); }
const control = new pg.Client({ ...connection, database });
await control.connect();
await control.query(await readFile(new URL("../../sql/001-schema.sql", import.meta.url), "utf8"));
await control.query(`INSERT INTO users(id,username,secret_key_hash,display_name,region)
  VALUES ('bench','bench',$1,'Bench','asia')`, [sha256Hex("synthetic-secret")]);

// Baseline handler from 589f52d, including transaction and response construction.
function baseline(h: HandlerContext): Handler<Env> {
  return async c => {
    const input = await bind(c, { username: { json: "username" }, secretKey: { json: "secretKey" } } as const);
    c.set("username", input.username);
    if (!usernamePattern.test(input.username)) throw new APIError(401, "invalid_credentials");
    await using tx = await h.db.begin();
    const row = await tx.get(`SELECT id, username, secret_key_hash, display_name, bio, profile_image_id, region, account_type, status FROM users
       WHERE username = $1 AND secret_key_hash = $2 AND status = 'active' FOR NO KEY UPDATE`, input.username, sha256Hex(input.secretKey));
    if (!row) throw new APIError(401, "invalid_credentials");
    const user = userFromRow(row);
    const session = await createLoginSessionForLockedUserTx(tx, user.id);
    await tx.commit();
    return jsonResponse(c, 200, { token: session.token, user: {
      id: user.id, username: user.username, displayName: user.displayName, bio: user.bio,
      region: user.region, accountType: user.accountType, status: user.status,
    } });
  };
}

try {
  for (const rttMs of [0, 5]) {
    const proxy = rttMs === 0 ? { port, close: async () => {} } : await delayedTCP(port, rttMs);
    const db = new DB({ region: "asia", logLevel: "error", dbHost: "127.0.0.1", dbPort: String(proxy.port), dbUser: "postgres", dbPassword: "", dbName: database }, 2);
    try {
      await db.ping();
      const h = { db } as HandlerContext;
      const apps = { before: new Hono<Env>(), after: new Hono<Env>() };
      apps.before.onError(apiErrorHandler); apps.after.onError(apiErrorHandler);
      apps.before.post("/login", baseline(h)); apps.after.post("/login", loginHandler(h));
      for (let trial = 0; trial < 3; trial++) {
        for (const variant of trial % 2 ? ["after", "before"] as const : ["before", "after"] as const) {
          for (const scenario of ["success", "failure", "mixed"] as const) {
            const count = scenario === "mixed" ? 90 : 20;
            const durations: number[] = [];
            const started = performance.now();
            for (let i = 0; i < count; i++) {
              const success = scenario === "success" || (scenario === "mixed" && i % 3 === 0);
              const body = JSON.stringify({ username: "bench", secretKey: success ? "synthetic-secret" : "invalid" });
              const before = performance.now();
              const response = await apps[variant].request("/login", { method: "POST", body,
                headers: { "Content-Type": "application/json", "Content-Length": String(Buffer.byteLength(body)) } });
              assert.equal(response.status, success ? 200 : 401);
              await response.arrayBuffer();
              durations.push(performance.now() - before);
            }
            const elapsedMs = performance.now() - started;
            durations.sort((a, b) => a - b);
            console.log(JSON.stringify({ rttMs, trial, variant, scenario, count, elapsedMs,
              meanMs: elapsedMs / count, p95Ms: durations[Math.ceil(count * .95) - 1] }));
          }
        }
      }
    } finally { await db.end(); await proxy.close(); }
  }
} finally { await control.end(); }
