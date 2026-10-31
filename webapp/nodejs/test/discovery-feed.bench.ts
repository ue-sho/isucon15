import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { DB } from "../src/db.ts";
import { getFeedHandler } from "../src/feed_api.ts";
import { getUser } from "../src/user.ts";
import { delayedTCP } from "./helpers/delayed-tcp.ts";
import { appFor, fixture, legacyFeed, localDatabase, stamp, tracked } from "./helpers/friends-feed.ts";

const baseline = "c0556a4fba0ea42063cbd53f07ace0f6f8690064";
const port = process.env.DISCOVERY_FEED_TEST_PORT;
const output = process.env.DISCOVERY_FEED_BENCH_OUTPUT;
assert.ok(port && /^\d+$/.test(port), "set DISCOVERY_FEED_TEST_PORT to an initialized disposable local DB");
assert.ok(output, "set DISCOVERY_FEED_BENCH_OUTPUT to a local results directory");
const self = fileURLToPath(import.meta.url);
const summary = (values: number[]) => {
  const xs = [...values].sort((a, b) => a - b);
  return { median: xs[Math.floor(xs.length / 2)], min: xs[0], max: xs.at(-1)! };
};

if (process.argv[2] === "--worker") {
  const [, , , mode, feed, delay] = process.argv;
  Temporal.Now.instant = () => stamp;
  const link = Number(delay) ? await delayedTCP(Number(port), Number(delay)) : undefined;
  const db = new DB({ dbHost: "127.0.0.1", dbPort: String(link?.port ?? port), dbUser: "postgres", dbPassword: "", dbName: "isureal_friends_feed_test", region: "asia", logLevel: "error" }, 1);
  const legacy = mode === "before" ? await legacyFeed(baseline) : undefined;
  const streams = new Set<{ bytesRead: number }>();
  const originalQuery = pg.Client.prototype.query;
  pg.Client.prototype.query = function (this: any, ...args: any[]) {
    streams.add(this.connection.stream);
    return (originalQuery as Function).apply(this, args);
  } as typeof originalQuery;
  try {
    await db.ping();
    const calls = tracked(db);
    const user = await getUser(db, "viewer");
    const app = appFor(legacy?.handler ?? getFeedHandler, calls.db, "viewer", legacy?.errorHandler, user);
    async function request() {
      const response = await app.request(`/feeds/${feed}`);
      assert.equal(response.status, 200);
      const body = await response.json();
      return body.items.length;
    }
    for (let n = 0; n < 2; n++) await request();
    const elapsed = [], cpu = [], received = [], returnedRows = [], sqlCalls = [];
    const bytes = () => [...streams].reduce((sum, socket) => sum + socket.bytesRead, 0);
    const samples = Number(delay) ? 4 : 10;
    let items = 0;
    for (let n = 0; n < samples; n++) {
      calls.queries.length = 0;
      const before = bytes(), used = process.cpuUsage(), start = performance.now();
      items = await request();
      elapsed.push(performance.now() - start);
      const consumed = process.cpuUsage(used);
      cpu.push((consumed.user + consumed.system) / 1000);
      received.push(bytes() - before);
      returnedRows.push(calls.queries.reduce((sum, query) => sum + query.rows, 0));
      sqlCalls.push(calls.queries.length);
    }
    const local = await localDatabase(port, false);
    let executionMs = 0, planningMs = 0;
    const plans = [];
    try {
      for (const q of calls.queries) {
        const args = q.args.map(a => a instanceof Temporal.Instant ? a.toString() : a);
        const plan = (await local.admin.query(`EXPLAIN (ANALYZE, BUFFERS, TIMING OFF, FORMAT JSON) ${q.sql}`, args)).rows[0]["QUERY PLAN"][0];
        executionMs += plan["Execution Time"]; planningMs += plan["Planning Time"];
        plans.push(plan);
      }
    } finally { await local.close(); }
    console.log(JSON.stringify({ mode, feed, syntheticRttMs: Number(delay), items, samples, elapsedMs: summary(elapsed), nodeCpuMs: summary(cpu), receivedBytes: summary(received), returnedRows: summary(returnedRows), sqlCalls: summary(sqlCalls), dbExplainExecutionMs: executionMs, dbExplainPlanningMs: planningMs, plans }));
  } finally {
    await db.end(); await link?.close(); await legacy?.close();
    pg.Client.prototype.query = originalQuery;
  }
} else {
  await mkdir(output, { recursive: true });
  const local = await localDatabase(port, false);
  try {
    const results = [];
    for (const shape of [
      { name: "small", friends: 12, unrelated: 30, history: 0 },
      { name: "large", friends: 110, unrelated: 5000, history: 100000 },
    ]) {
      await fixture(local.admin, shape.friends, shape.unrelated, shape.history, shape.name === "large" ? 30 : 0);
      await local.admin.query(`INSERT INTO follows(id,follower_id,followee_id)
        SELECT 'following-'||n,'viewer','outsider-'||lpad(n::text,6,'0') FROM generate_series(1,LEAST($1::int,60)) n`, [shape.unrelated]);
      for (const rtt of [0, 100]) for (const feed of ["following", "friends-of-friends"]) {
        for (const [run, mode] of ["before", "after", "after", "before"].entries()) {
          const result = await new Promise<any>((resolveResult, reject) => {
            const child = spawn(process.execPath, [self, "--worker", mode, feed, String(rtt)], { env: process.env, stdio: ["ignore", "pipe", "pipe"] });
            let stdout = "", stderr = "";
            child.stdout.on("data", chunk => stdout += chunk); child.stderr.on("data", chunk => stderr += chunk);
            child.on("error", reject);
            child.on("close", code => code === 0 ? resolveResult(JSON.parse(stdout)) : reject(new Error(stderr + stdout)));
          });
          results.push({ shape: shape.name, run, ...result });
          const { plans, ...compact } = result;
          console.log(JSON.stringify({ shape: shape.name, run, ...compact }));
          await writeFile(resolve(output, `${shape.name}-${rtt}-${feed}-${run}-${mode}.json`), JSON.stringify(result, null, 2) + "\n");
        }
      }
    }
    await writeFile(resolve(output, "comparison.json"), JSON.stringify({ baseline, node: process.version, database: (await local.admin.query("SHOW server_version")).rows[0].server_version, order: "ABBA; independent Node processes; single DB pool connection; synthetic RTT; no WAN bandwidth shaping; no competition benchmark", results }, null, 2) + "\n");
  } finally { await local.close(); }
}
