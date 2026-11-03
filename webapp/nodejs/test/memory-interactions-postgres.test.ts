import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import test from "node:test";
import { Hono } from "hono";
import pg from "pg";
import { apiErrorHandler } from "../src/api_error.ts";
import { selectCommentsWithAuthor } from "../src/comment.ts";
import type { Config } from "../src/config.ts";
import { DB, type Queryer, type Row } from "../src/db.ts";
import { IPBanList } from "../src/ip_ban.ts";
import { getMemoriesByDateHandler, getMemoriesHandler } from "./fixtures/memory-before-roundtrips.ts";
import { selectCurrentRealMojis } from "../src/realmoji.ts";
import { regionMiddleware } from "../src/region.ts";
import type { Env } from "../src/server.ts";
import { sessionMiddleware } from "../src/session.ts";
import { groups, postID, interactionID, seed } from "./fixtures/memory-data.ts";

type Kind = "realmojis" | "comments";
type Statement = { sql: string; args: unknown[] };
type Measurement = Statement & { kind: Kind; rows: number; ms: number };
type Memory = { id: string; postedAt: string; realmojis: { id: string }[]; comments: { id: string }[] };
type Body = { items: Memory[]; hasMore: boolean };

// Reconstruct the pre-change SQL through the unchanged shared helpers. The
// frozen pre-roundtrip handler still performs per-post truncation in legacy mode.
// Current handler equivalence is covered by memory-roundtrips-postgres.test.ts.
async function legacyStatement(kind: Kind, ids: string[]): Promise<Statement> {
  let statement: Statement | undefined;
  const capture: Queryer = {
    async get() { throw new Error("unexpected get"); },
    async exec() { throw new Error("unexpected exec"); },
    async select<T>(sql: string, ...args: unknown[]): Promise<T[]> {
      statement = { sql, args };
      return [];
    },
  };
  const placeholders = ids.map((_, i) => `$${i + 1}`).join(", ");
  if (kind === "realmojis") {
    await selectCurrentRealMojis(capture, `AND r.post_id IN (${placeholders}) ORDER BY r.created_at DESC, r.id DESC`, ...ids);
  } else {
    await selectCommentsWithAuthor(capture, `AND c.post_id IN (${placeholders}) ORDER BY c.created_at, c.id`, ...ids);
  }
  return statement!;
}

class MeasuredDB extends DB {
  legacy = false;
  measurements: Measurement[] = [];
  override async select<T = Row>(sql: string, ...args: unknown[]): Promise<T[]> {
    const kind = sql.includes("FROM realmojis r") ? "realmojis" : sql.includes("FROM comments c") ? "comments" : null;
    if (kind === null) return super.select<T>(sql, ...args);
    if (this.legacy) {
      const ids = (Array.isArray(args[0]) ? args[0] : args) as string[];
      ({ sql, args } = await legacyStatement(kind, ids));
    }
    const start = performance.now();
    const rows = await super.select<T>(sql, ...args);
    this.measurements.push({ kind, sql, args, rows: rows.length, ms: performance.now() - start });
    return rows;
  }
}


function planSummary(explain: Row): Row {
  const scans: Row[] = [], sorts: Row[] = [];
  const visit = (node: Row) => {
    if (node["Relation Name"]) scans.push({
      type: node["Node Type"], relation: node["Relation Name"], index: node["Index Name"],
      rows: node["Actual Rows"], loops: node["Actual Loops"], removed: node["Rows Removed by Filter"] ?? 0,
      hits: node["Shared Hit Blocks"], reads: node["Shared Read Blocks"],
    });
    if (node["Node Type"].includes("Sort")) sorts.push({
      type: node["Node Type"], key: node["Sort Key"], method: node["Sort Method"],
      spaceKB: node["Sort Space Used"], spaceType: node["Sort Space Type"],
      inputRows: node.Plans?.[0]?.["Actual Rows"], loops: node["Actual Loops"],
    });
    for (const child of node.Plans ?? []) visit(child);
  };
  visit(explain.Plan);
  return {
    executionMs: explain["Execution Time"], planningMs: explain["Planning Time"],
    hits: explain.Plan["Shared Hit Blocks"], reads: explain.Plan["Shared Read Blocks"],
    tempRead: explain.Plan["Temp Read Blocks"], tempWritten: explain.Plan["Temp Written Blocks"], scans, sorts,
  };
}

const median = (values: number[]) => {
  const sorted = [...values].sort((a,b) => a-b);
  return (sorted[Math.floor((sorted.length-1)/2)]! + sorted[Math.floor(sorted.length/2)]!) / 2;
};
function sqlLiteral(value: unknown): string {
  if (Array.isArray(value)) return `ARRAY[${value.map(sqlLiteral).join(",")}]::varchar[]`;
  assert.equal(typeof value, "string");
  return `'${(value as string).replaceAll("'", "''")}'`;
}
const port = process.env.MEMORIES_PG_PORT;
test("Memories interactions: real PostgreSQL equivalence, row counts and plans", { skip: !port, timeout: 600_000 }, async (t) => {
  // Only an explicitly selected loopback test database is allowed. No app env,
  // shared credentials, production DB, or existing schema is used.
  const config: Config = {
    dbHost: "127.0.0.1", dbPort: port!, dbUser: "postgres", dbPassword: "", dbName: "memories_test", region: "asia", logLevel: "error",
  };
  const db = new MeasuredDB(config, 1);
  const schema = `memories_test_${process.pid}`;
  let createdSchema = false;
  const report: Row = {
    node: process.version, base: process.env.MEMORIES_BASE_SHA ?? "14a59290088ecb809cbb93356414a9b366deeb92", productionDistribution: "unverified",
    sqlSamples: 8, sqlWarmups: 2, explainSamples: 6, explainWarmups: 1, explainTiming: false,
    apiSamples: process.env.MEMORIES_PG_BENCHMARK ? 4 : 1,
    apiTiming: "in-process Hono request through authentication, region check, handler and response body; no HTTP network",
    apiCache: process.env.MEMORIES_PG_BENCHMARK
      ? "advance fixture signature generation, warm the same variant once before each timed sample; reset and warm-up excluded"
      : "single response comparison, not a controlled API timing benchmark",
    scenarios: {},
  };
  try {
    await db.ping();
    report.postgres = (await db.get("SELECT version() AS version"))!.version;
    report.settings = await db.get(`SELECT current_setting('work_mem') AS work_mem,
      current_setting('shared_buffers') AS shared_buffers, current_setting('jit') AS jit,
      current_setting('plan_cache_mode') AS plan_cache_mode,
      current_setting('max_parallel_workers_per_gather') AS max_parallel_workers_per_gather`);
    assert.equal((await db.get("SELECT current_database() AS db"))!.db, "memories_test");
    await db.exec(`CREATE SCHEMA ${schema}`);
    createdSchema = true;
    await db.exec(`SET search_path TO ${schema}`);
    const setup = new pg.Client({ host: config.dbHost, port: Number(port), user: config.dbUser, database: config.dbName });
    await setup.connect();
    try {
      await setup.query(`SET search_path TO ${schema}`);
      await setup.query(await readFile(new URL("../../sql/001-schema.sql", import.meta.url), "utf8"));
    } finally {
      await setup.end();
    }
    await seed(db);
    // Full signed URLs must match, including expiry and signature.
    const instant = Temporal.Instant.from("2026-10-31T00:00:00Z");
    t.mock.method(Temporal.Now, "instant", () => instant);
    const app = new Hono<Env>();
    const h = { db, config, ipBans: new IPBanList() };
    app.onError(apiErrorHandler);
    app.use("*", sessionMiddleware(h, true), regionMiddleware(h));
    app.get("/api/memories", getMemoriesHandler(h));
    app.get("/api/memories/:date", getMemoriesByDateHandler(h));
    const request = async (group: string, url: string, legacy: boolean) => {
      db.legacy = legacy;
      db.measurements = [];
      const start = performance.now();
      const response = await app.request(url, { headers: { Authorization: `Bearer memory-${group}` } });
      const text = await response.text();
      const ms = performance.now() - start;
      return { status: response.status, contentType: response.headers.get("Content-Type"), text, ms, queries: [...db.measurements] };
    };
    for (const group of groups) {
      const url = "/api/memories?month=2026-10";
      const old = await request(group.name, url, true);
      const current = await request(group.name, url, false);
      assert.equal(old.status, 200);
      assert.equal(current.status, old.status);
      assert.equal(current.contentType, old.contentType);
      assert.equal(current.text, old.text, `${group.name}: complete JSON response including signatures`);
      const body: Body = JSON.parse(current.text);
      assert.equal(body.items.length, 50);
      assert.equal(body.hasMore, group.counts.length > 50);
      for (const [i, item] of body.items.entries()) {
        assert.equal(item.id, postID(group.name, i));
        const count = group.counts[i]!;
        const asc = Array.from({length: count}, (_,j) => j+1);
        assert.deepEqual(item.comments.map(x => x.id), asc.slice(0,50).map(j => interactionID("comments", group.name, i, j)));
        assert.deepEqual(item.realmojis.map(x => x.id), asc.reverse().slice(0,50).map(j => interactionID("realmojis", group.name, i, j)));
      }
      assert.equal(current.queries.length, 2);
      assert.equal(old.queries.length, 2);
      const stats: Row = { returned: {}, oldRows: {}, newRows: {}, oldClientSQLMs: {}, newClientSQLMs: {}, oldPlans: {}, newPlans: {} };
      for (const kind of ["realmojis", "comments"] as const) {
        const before = old.queries.find(q => q.kind === kind)!;
        const after = current.queries.find(q => q.kind === kind)!;
        const returned = body.items.reduce((n,item) => n+item[kind].length, 0);
        assert.equal(before.rows, group.counts.slice(0,50).reduce((a,b) => a+b,0));
        assert.equal(after.rows, returned, `${group.name}/${kind}: no excess DB rows`);
        stats.returned[kind] = returned;
        stats.oldRows[kind] = before.rows;
        stats.newRows[kind] = after.rows;
        // Measure prepared SQL with transfer + pg parsing separately from API
        // conversion/signing. Alternate execution order after warm-up.
        const beforeTimes: number[] = [], afterTimes: number[] = [];
        db.legacy = false;
        for (let round = 0; round < 10; round++) {
          for (const [statement, times] of (round % 2 === 0
            ? [[before,beforeTimes],[after,afterTimes]] : [[after,afterTimes],[before,beforeTimes]]) as [Statement,number[]][]) {
            const start = performance.now();
            await db.select(statement.sql, ...statement.args);
            if (round >= 2) times.push(performance.now()-start);
          }
        }
        stats.oldClientSQLMs[kind] = median(beforeTimes);
        stats.newClientSQLMs[kind] = median(afterTimes);
        const explainTargets = [];
        for (const [statement, key] of [[before,"oldPlans"],[after,"newPlans"]] as const) {
          const prepared = await db.get(`SELECT name,generic_plans,custom_plans FROM pg_prepared_statements WHERE statement=$1`, statement.sql);
          assert.match(prepared!.name, /^isureal_[0-9]+$/);
          explainTargets.push({ key, prepared: prepared!, plans: [] as Row[],
            sql: `EXPLAIN (ANALYZE, BUFFERS, TIMING OFF, FORMAT JSON) EXECUTE ${prepared!.name} (${statement.args.map(sqlLiteral).join(",")})` });
        }
        // Explain the actual timed prepared statements, including automatic
        // generic/custom selection. Alternate order and avoid per-node clock
        // overhead, which can skew comparisons of different plan shapes.
        for (let round = 0; round < 7; round++) {
          for (const target of round % 2 === 0 ? explainTargets : [...explainTargets].reverse()) {
            const row = await db.get(target.sql);
            if (round > 0) target.plans.push(row!["QUERY PLAN"][0]);
          }
        }
        for (const { key, prepared, plans } of explainTargets) {
          const executionSamplesMs = plans.map(p => p["Execution Time"] as number);
          plans.sort((a,b) => a["Execution Time"]-b["Execution Time"]);
          stats[key][kind] = { ...planSummary(plans[3]!), executionMs: median(executionSamplesMs), executionSamplesMs,
            genericPlans: prepared.generic_plans, customPlans: prepared.custom_plans };
        }
      }
      stats.oldAPIMs = [old.ms];
      stats.newAPIMs = [current.ms];
      if (process.env.MEMORIES_PG_BENCHMARK) {
        // Isolate the old/new signature LRU state: different SQL row orders
        // must not give one variant warm entries left by the other variant.
        stats.oldAPIMs = [];
        stats.newAPIMs = [];
        for (let round = 0; round < 4; round++) {
          for (const legacy of round % 2 === 0 ? [true,false] : [false,true]) {
            await db.exec("UPDATE image_signature_cache_state SET generation=generation+1 WHERE singleton");
            await request(group.name, url, legacy);
            const result = await request(group.name, url, legacy);
            assert.equal(result.text, old.text);
            stats[legacy ? "oldAPIMs" : "newAPIMs"].push(result.ms);
          }
        }
      }
      report.scenarios[group.name] = stats;
      stats.oldAPIMedianMs = median(stats.oldAPIMs);
      stats.newAPIMedianMs = median(stats.newAPIMs);
      t.diagnostic(JSON.stringify({ scenario: group.name, returned: stats.returned, oldRows: stats.oldRows, newRows: stats.newRows,
        oldClientSQLMs: stats.oldClientSQLMs, newClientSQLMs: stats.newClientSQLMs,
        oldAPIMedianMs: stats.oldAPIMedianMs, newAPIMedianMs: stats.newAPIMedianMs }));
    }
    for (const url of [
      "/api/memories/2026-10-10",
      "/api/memories?month=2026-10&beforePostedAt=2026-10-10T11%3A59%3A10Z&beforeId=boundary-p-050",
      "/api/memories/2026-10-10?beforePostedAt=2026-10-10T11%3A59%3A10Z&beforeId=boundary-p-050",
      "/api/memories?month=2026-09", "/api/memories/2026-10-11",
      "/api/memories?month=2026-10&beforeId=boundary-p-050", "/api/memories/2026-02-30",
    ]) {
      const old = await request("boundary", url, true);
      const current = await request("boundary", url, false);
      assert.equal(old.status, url.endsWith("beforeId=boundary-p-050") && !url.includes("beforePostedAt") || url.includes("2026-02-30") ? 400 : 200);
      assert.equal(current.status, old.status);
      assert.equal(current.text, old.text, url);
      if (url.includes("beforeId") && url.includes("beforePostedAt")) {
        const body: Body = JSON.parse(current.text);
        assert.deepEqual(body.items.map(x => x.id), ["boundary-p-051"]);
        assert.equal(body.hasMore, false);
      }
      if (url.includes("2026-09") || url.includes("2026-10-11")) {
        assert.deepEqual(JSON.parse(current.text), {items: [], hasMore: false});
        assert.equal(current.queries.length, 0);
      }
    }
    if (process.env.MEMORIES_REPORT_PATH) await writeFile(process.env.MEMORIES_REPORT_PATH, JSON.stringify(report,null,2) + "\n");
  } finally {
    try {
      if (createdSchema) await db.exec(`DROP SCHEMA ${schema} CASCADE`);
    } finally {
      await db.end();
    }
  }
});
