import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import test from "node:test";
import { Hono } from "hono";
import pg from "pg";
import { apiErrorHandler } from "../src/api_error.ts";
import type { Config } from "../src/config.ts";
import type { DB, Queryer, Row } from "../src/db.ts";
import { IPBanList } from "../src/ip_ban.ts";
import { getMemoriesHandler, getMemoriesByDateHandler } from "../src/memory_api.ts";
import { regionMiddleware } from "../src/region.ts";
import type { Env } from "../src/server.ts";
import { sessionMiddleware } from "../src/session.ts";
import { parsePostgresTimestamp } from "../src/time.ts";
import * as baseline from "./fixtures/memory-before-roundtrips.ts";
import { groups, seed, postID, interactionID } from "./fixtures/memory-data.ts";
import { singleSnapshot } from "./fixtures/memory-single-snapshot.ts";

type Mode = "baseline" | "combined" | "snapshot";
type Sample = { sql: string; args: unknown[]; rows: number; bytes: number; waitMs: number; queryMs: number };
type Trace = { queries: Sample[]; active: number; maxActive: number };
const trace = new AsyncLocalStorage<Trace>();
const isData = (sql: string) => /FROM (posts p|realmojis r|comments c)/.test(sql);
const median = (xs: number[]) => {
  const a = [...xs].sort((a,b) => a-b);
  return (a[Math.floor((a.length-1)/2)]! + a[Math.floor(a.length/2)]!) / 2;
};
const sum = (xs: number[]) => xs.reduce((a,b) => a+b,0);
const statementName = (sql: string) => createHash("sha256").update(sql).digest("hex").slice(0,48);
function literal(value: unknown): string {
  if (value === null) return "NULL";
  if (Array.isArray(value)) return `ARRAY[${value.map(literal).join(",")}]::varchar[]`;
  if (value instanceof Temporal.Instant) return `${literal(value.toString())}::timestamptz`;
  assert.equal(typeof value,"string");
  return `'${(value as string).replaceAll("'","''")}'`;
}

// Same OID parsers/prepared protocol as DB; only add per-connection wire and
// acquire-wait measurements. Never read application env or shared credentials.
class MeasuredDB implements Queryer {
  pool: pg.Pool;
  constructor(port: number, schema: string) {
    const types = new pg.TypeOverrides();
    types.setTypeParser(pg.types.builtins.INT8, Number);
    types.setTypeParser(pg.types.builtins.NUMERIC, Number);
    types.setTypeParser(pg.types.builtins.DATE, x => x);
    types.setTypeParser(pg.types.builtins.TIMESTAMPTZ, parsePostgresTimestamp);
    this.pool = new pg.Pool({ host: "127.0.0.1", port, user: "postgres", database: "memories_test",
      max: 2, types, options: `-c search_path=${schema}`, application_name: schema });
  }
  async query(sql: string, args: unknown[]) {
    const context = trace.getStore();
    const start = performance.now();
    const client = await this.pool.connect();
    const acquired = performance.now();
    if (context) context.maxActive = Math.max(context.maxActive, ++context.active);
    // pg's socket is used only by this exclusively acquired client.
    const socket = (client as any).connection.stream as { bytesRead: number };
    const before = socket.bytesRead;
    try {
      const result = await client.query({ name: statementName(sql), text: sql,
        values: args.map(a => a instanceof Temporal.Instant ? a.toString() : a) });
      context?.queries.push({ sql, args, rows: result.rows.length, bytes: socket.bytesRead-before,
        waitMs: acquired-start, queryMs: performance.now()-acquired });
      return result;
    } finally {
      if (context) context.active--;
      client.release();
    }
  }
  async get<T = Row>(sql: string, ...args: unknown[]): Promise<T | undefined> { return (await this.query(sql,args)).rows[0]; }
  async select<T = Row>(sql: string, ...args: unknown[]): Promise<T[]> { return (await this.query(sql,args)).rows; }
  async exec(sql: string, ...args: unknown[]): Promise<number> { return (await this.query(sql,args)).rowCount ?? 0; }
  async explainPrepared(sql: string, args: unknown[]) {
    const client = await this.pool.connect();
    try {
      // Inspect the same prepared statement on the same connection rather than
      // substituting an ad-hoc EXPLAIN's custom plan for the measured plan.
      await client.query({ name: statementName(sql), text: sql,
        values: args.map(a=>a instanceof Temporal.Instant?a.toString():a) });
      const statement = (await client.query("SELECT name,generic_plans,custom_plans FROM pg_prepared_statements WHERE name=$1",[statementName(sql)])).rows[0];
      const plan = (await client.query(`EXPLAIN (ANALYZE, BUFFERS, TIMING OFF, FORMAT JSON)
        EXECUTE "${statement.name}" (${args.map(literal).join(",")})`)).rows[0]["QUERY PLAN"][0];
      return { executionMs:plan["Execution Time"],hits:plan.Plan["Shared Hit Blocks"],reads:plan.Plan["Shared Read Blocks"],
        tempRead:plan.Plan["Temp Read Blocks"],tempWrite:plan.Plan["Temp Written Blocks"],
        genericPlans:Number(statement.generic_plans),customPlans:Number(statement.custom_plans) };
    } finally { client.release(); }
  }
}

const port = process.env.MEMORIES_PG_PORT;
test("Memories roundtrips: real PostgreSQL HTTP equivalence, pool2, bytes and updates", { skip: !port, timeout: 900_000 }, async t => {
  const schema = `memory_roundtrips_${process.pid}`;
  const admin = new pg.Client({ host: "127.0.0.1", port: Number(port), user: "postgres", database: "memories_test" });
  const db = new MeasuredDB(Number(port), schema);
  const modes: Mode[] = ["baseline", "combined", "snapshot"];
  const config = { region: "asia", logLevel: "error" } as Config;
  const report: Row = { node: process.version, pool: 2, base: process.env.MEMORIES_BASE_SHA ?? "993e1b0",
    api: "in-process Hono with DB authentication, identical signature implementation and generation reset/warmup per variant",
    wire: "received PostgreSQL protocol bytes on exclusively acquired client sockets (no TCP/IP headers)", scenarios: {} };
  await admin.connect();
  let created = false;
  try {
    assert.equal((await admin.query("SELECT current_database() AS db")).rows[0].db, "memories_test");
    report.postgres = (await admin.query("SELECT version() AS version")).rows[0].version;
    report.settings = (await admin.query(`SELECT current_setting('work_mem') AS work_mem, current_setting('shared_buffers') AS shared_buffers,
      current_setting('plan_cache_mode') AS plan_cache_mode, current_setting('jit') AS jit`)).rows[0];
    await admin.query(`CREATE SCHEMA ${schema}`); created = true;
    await admin.query(`SET search_path TO ${schema}`);
    await admin.query(await readFile(new URL("../../sql/001-schema.sql", import.meta.url), "utf8"));
    await seed(db);
    const now = Temporal.Instant.from("2026-10-31T00:00:00Z");
    t.mock.method(Temporal.Now, "instant", () => now);
    t.mock.method(Date, "now", () => Number(now.epochMilliseconds));
    const request = async (mode: Mode, group = "boundary", url = "/api/memories?month=2026-10", selectedDB: Queryer = db) => {
      const context: Trace = { queries: [], active: 0, maxActive: 0 };
      return trace.run(context, async () => {
        const app = new Hono<Env>();
        const h = { db: (mode === "snapshot" ? singleSnapshot(selectedDB) : selectedDB) as DB, config, ipBans: new IPBanList() };
        const handlers = mode === "baseline" ? baseline : { getMemoriesHandler, getMemoriesByDateHandler };
        app.onError(apiErrorHandler);
        app.use("*", sessionMiddleware(h,true), regionMiddleware(h));
        app.get("/api/memories", handlers.getMemoriesHandler(h));
        app.get("/api/memories/:date", handlers.getMemoriesByDateHandler(h));
        const start = performance.now();
        const response = await app.request(url, { headers: { Authorization: `Bearer memory-${group}` } });
        const text = await response.text();
        return { status: response.status, contentType: response.headers.get("content-type"), text, ms: performance.now()-start, ...context };
      });
    };
    const equal = (a: Awaited<ReturnType<typeof request>>, b: Awaited<ReturnType<typeof request>>) => {
      assert.equal(b.status,a.status); assert.equal(b.contentType,a.contentType); assert.equal(b.text,a.text);
      assert.equal(b.maxActive,1,"one request must never occupy both pool2 connections");
    };
    for (const group of groups) {
      const expected = await request("baseline",group.name);
      assert.equal(expected.status,200);
      const body = JSON.parse(expected.text);
      assert.equal(body.items.length,50); assert.equal(body.hasMore,group.counts.length>50);
      for (const [i,item] of body.items.entries()) {
        assert.equal(item.id,postID(group.name,i));
        const ids = Array.from({length:group.counts[i]!},(_,j)=>j+1);
        assert.deepEqual(item.comments.map((x:Row)=>x.id),ids.slice(0,50).map(j=>interactionID("comments",group.name,i,j)));
        assert.deepEqual(item.realmojis.map((x:Row)=>x.id),ids.reverse().slice(0,50).map(j=>interactionID("realmojis",group.name,i,j)));
      }
      const results = new Map<Mode,Awaited<ReturnType<typeof request>>>();
      for (const mode of modes) {
        const result = await request(mode,group.name); equal(expected,result); results.set(mode,result);
        const data = result.queries.filter(q=>isData(q.sql));
        assert.equal(data.length,mode==="baseline"?3:mode==="combined"?2:1);
        assert.equal(sum(data.map(q=>q.rows)),body.items.length+Number(body.hasMore)+sum(body.items.map((x:Row)=>x.realmojis.length+x.comments.length)));
      }
      const stats: Row = {};
      // SQL-only comparison separates signing cost from SQL/wire work. Rotate
      // variants, warm twice, then take eight samples with the same pool2.
      for (const mode of modes) stats[mode] = { sqlMs: [], plans: [], api: {} };
      for (let round=0;round<10;round++) {
        for (const mode of round%2 ? [...modes].reverse() : modes) {
          const start=performance.now();
          for (const q of results.get(mode)!.queries.filter(q=>isData(q.sql))) await db.select(q.sql,...q.args);
          if(round>=2) stats[mode].sqlMs.push(performance.now()-start);
        }
      }
      for (const mode of modes) {
        const data=results.get(mode)!.queries.filter(q=>isData(q.sql));
        stats[mode].queries=data.length; stats[mode].rows=sum(data.map(q=>q.rows));
        stats[mode].bytes=sum(data.map(q=>q.bytes)); stats[mode].sqlMedianMs=median(stats[mode].sqlMs);
        for(const q of data) {
          stats[mode].plans.push(await db.explainPrepared(q.sql,q.args));
        }
      }
      if(process.env.MEMORIES_PG_BENCHMARK) {
        for(const concurrency of [1,4]) {
          for(const mode of modes) stats[mode].api[concurrency]=[];
          for(let round=0;round<4;round++) for(const mode of round%2?[...modes].reverse():modes) {
            await db.exec("UPDATE image_signature_cache_state SET generation=generation+1 WHERE singleton");
            await request(mode,group.name);
            const start=performance.now();
            const batch=await Promise.all(Array.from({length:concurrency},()=>request(mode,group.name)));
            const duration=performance.now()-start;
            batch.forEach(r=>equal(expected,r));
            stats[mode].api[concurrency].push({durationMs:duration,throughput:concurrency*1000/duration,
              latencyMs:batch.map(r=>r.ms),poolWaitMs:batch.map(r=>sum(r.queries.map(q=>q.waitMs))),
              maxActive:Math.max(...batch.map(r=>r.maxActive))});
          }
        }
      }
      report.scenarios[group.name]=stats;
      t.diagnostic(JSON.stringify({scenario:group.name,...Object.fromEntries(modes.map(m=>[m,{queries:stats[m].queries,bytes:stats[m].bytes,sqlMs:stats[m].sqlMedianMs,api:stats[m].api}]))}));
    }
    const urls=["/api/memories/2026-10-10","/api/memories?month=2026-09","/api/memories/2026-10-11",
      "/api/memories?month=2026-10&beforePostedAt=2026-10-10T11%3A59%3A10Z&beforeId=boundary-p-050",
      "/api/memories/2026-10-10?beforePostedAt=2026-10-10T11%3A59%3A10Z&beforeId=boundary-p-050",
      "/api/memories?month=2026-10&beforeId=x","/api/memories?month=2026-10&beforePostedAt=2026-10-10T00:00:00Z",
      "/api/memories?month=2026-13","/api/memories?month=oops","/api/memories/2026-02-30","/api/memories?month=2026-10&beforePostedAt=invalid&beforeId=x"];
    for(const url of urls) {
      const old=await request("baseline","boundary",url);
      const invalid=url.includes("beforeId=x") || url.endsWith("beforePostedAt=2026-10-10T00:00:00Z")
        || url.includes("month=2026-13") || url.includes("month=oops") || url.includes("2026-02-30");
      assert.equal(old.status,invalid?400:200,url);
      for(const mode of modes.slice(1)) {
        const result=await request(mode,"boundary",url); equal(old,result);
        if(result.status===200 && JSON.parse(result.text).items.length===0) assert.equal(result.queries.filter(q=>isData(q.sql)).length,1);
        if(result.status===400) assert.equal(result.queries.filter(q=>isData(q.sql)).length,0);
        if(url.includes("beforeId=boundary")) assert.deepEqual(JSON.parse(result.text).items.map((x:Row)=>x.id),["boundary-p-051"]);
      }
    }
    // Hold a SELECT after its snapshot has been taken, commit a writer, then
    // release it. Compare the intentional snapshot change, not just serial reads.
    for (const mode of modes) {
      const old = await request("baseline", "sparse");
      const lock = 713950;
      await admin.query("SELECT pg_advisory_lock($1)", [lock]);
      let gated = false;
      const gate: Queryer = {
        get: (sql,...args) => db.get(sql,...args),
        exec: (sql,...args) => db.exec(sql,...args),
        select<T>(sql: string,...args: unknown[]): Promise<T[]> {
          if (!gated && sql.includes("FROM realmojis r")) {
            gated = true;
            sql = `WITH memory_barrier AS MATERIALIZED (SELECT pg_advisory_xact_lock(${lock}))
              SELECT q.* FROM (${sql}) q CROSS JOIN memory_barrier`;
          }
          return db.select<T>(sql,...args);
        },
      };
      const pending = request(mode,"sparse","/api/memories?month=2026-10",gate);
      try {
        let blocked = false;
        for (let attempt=0;attempt<200;attempt++) {
          blocked = (await admin.query(`SELECT EXISTS(SELECT 1 FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid
            WHERE NOT l.granted AND l.locktype='advisory' AND a.application_name=$1) AS blocked`,[schema])).rows[0].blocked;
          if (blocked) break;
          await new Promise(resolve=>setTimeout(resolve,10));
        }
        assert.ok(blocked,"fixture SELECT must hold a live snapshot before writer commits");
        await admin.query("BEGIN");
        await admin.query("UPDATE comments SET deleted_at=now() WHERE id='c-sparse-p-001-00001'");
        await admin.query("UPDATE realmojis SET deleted_at=now() WHERE id='r-sparse-p-001-00010'");
        await admin.query("COMMIT");
      } finally {
        await admin.query("SELECT pg_advisory_unlock($1)",[lock]);
      }
      const during = await pending;
      if (mode === "baseline") {
        const item = JSON.parse(during.text).items[0];
        assert.equal(item.realmojis.length,10); assert.equal(item.comments.length,9);
      } else equal(old,during);
      const after = await request(mode,"sparse");
      assert.equal(JSON.parse(after.text).items[0].realmojis.length,9);
      assert.equal(JSON.parse(after.text).items[0].comments.length,9);
      equal(await request("baseline","sparse"),after);
      await admin.query("UPDATE comments SET deleted_at=NULL WHERE id='c-sparse-p-001-00001'");
      await admin.query("UPDATE realmojis SET deleted_at=NULL WHERE id='r-sparse-p-001-00010'");
    }
    // Equal posted_at values straddle page 50; numeric coordinates and private
    // versus certified-public bios use the same existing response functions.
    await db.exec("UPDATE posts SET posted_at='2026-10-10T12:00:00.123456Z', location_kind='exact',latitude=35.123456,longitude=139.654321 WHERE author_id='boundary'");
    await db.exec("UPDATE users SET account_type='certified_public',bio='公開bio' WHERE id='u-1'");
    for(const count of [0,49,50,51]) {
      await db.exec("UPDATE posts SET deleted_at=CASE WHEN id > $1 THEN now() END WHERE author_id='boundary'",postID("boundary",count-1));
      const old=await request("baseline"); const b=JSON.parse(old.text);
      assert.equal(b.items.length,Math.min(count,50)); assert.equal(b.hasMore,count===51);
      for(const mode of modes.slice(1)) equal(old,await request(mode));
      if(count===51) {
        const url=`/api/memories?month=2026-10&beforePostedAt=${encodeURIComponent(b.items[49].postedAt)}&beforeId=${b.items[49].id}`;
        const next=await request("baseline","boundary",url);
        assert.deepEqual(JSON.parse(next.text).items.map((x:Row)=>x.id),["boundary-p-001"]);
        for(const mode of modes.slice(1)) equal(next,await request(mode,"boundary",url));
      }
    }
    // Committed changes are visible on the next request without a cache TTL.
    for(const sql of [
      "UPDATE comments SET body='updated 🐈' WHERE id='c-boundary-p-051-00001'",
      "UPDATE comments SET deleted_at=now() WHERE id='c-boundary-p-051-00002'",
      "UPDATE realmojis SET replaced_at=now() WHERE id='r-boundary-p-051-00003'",
      `INSERT INTO realmojis(id,post_id,reactor_id,image_id,reaction_type,created_at)
        SELECT id || '-replacement',post_id,reactor_id,'replacement-image',reaction_type,created_at + interval '1 microsecond'
        FROM realmojis WHERE id='r-boundary-p-051-00003'`,
      "UPDATE realmojis SET deleted_at=now() WHERE id='r-boundary-p-051-00002'",
      "UPDATE users SET display_name='updated user',bio='new bio',profile_image_id='updated-profile' WHERE id='u-1'",
      "UPDATE users SET secret_key_hash=repeat('e',64) WHERE id='u-2'",
      "UPDATE users SET status='deleted' WHERE id='u-1'",
      "UPDATE posts SET caption='updated caption',visibility='public' WHERE id='boundary-p-051'",
      "UPDATE posts SET deleted_at=now() WHERE id='boundary-p-051'",
    ]) {
      await db.exec(sql); const old=await request("baseline");
      for(const mode of modes.slice(1)) equal(old,await request(mode));
    }
    report.correctness="full HTTP status/content-type/JSON equality; limits, ties, page cursor, exclusions, updates";
    if(process.env.MEMORIES_REPORT_PATH) await writeFile(process.env.MEMORIES_REPORT_PATH,JSON.stringify(report,null,2)+"\n");
  } finally {
    await db.pool.end();
    if(created) await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
});
