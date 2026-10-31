import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { appFor, baseline, fixture, legacyFeed, localDatabase, tracked } from "./helpers/friends-feed.ts";

const port = process.env.FRIENDS_FEED_TEST_PORT;
assert.ok(port, "set FRIENDS_FEED_TEST_PORT to the disposable local DB created by friends-feed.test.ts");
const self = fileURLToPath(import.meta.url);
const output = process.env.FRIENDS_FEED_BENCH_OUTPUT;
assert.ok(output, "set FRIENDS_FEED_BENCH_OUTPUT to a local results directory");
const summarize = (values: number[]) => {
  const sorted = [...values].sort((a,b) => a-b);
  return { median: sorted[Math.floor(sorted.length/2)], p95: sorted[Math.ceil(sorted.length*.95)-1], min: sorted[0], max: sorted.at(-1)! };
};

if (process.argv[2] === "--worker") {
  const mode = process.argv[3];
  const fixed = Temporal.Instant.from(process.argv[4]);
  Temporal.Now.instant = () => fixed;
  const legacy = mode === "before" ? await legacyFeed() : undefined;
  const handler = legacy?.handler ?? (await import("../src/feed_api.ts")).getFeedHandler;
  // Poolサイズ1、逐次要求。DB TCP socketの実際の受信bytes（PostgreSQLプロトコルを含む）。
  const streams = new Set<{ bytesRead: number }>();
  const query = pg.Client.prototype.query;
  pg.Client.prototype.query = function(this: any, ...args: any[]) {
    streams.add(this.connection.stream);
    return (query as Function).apply(this, args);
  } as typeof query;
  const local = await localDatabase(port, false);
  try {
    await local.db.ping();
    const app = appFor(handler, local.db);
    async function request() {
      const response = await app.request("/feeds/friends");
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.items.length, 50);
      assert.equal(body.hasMore, true);
    }
    globalThis.gc!();
    const coldCPU = process.cpuUsage(), coldStart = performance.now();
    await request();
    const coldMs = performance.now() - coldStart, coldUsage = process.cpuUsage(coldCPU);
    for (let n=0;n<10;n++) await request();
    globalThis.gc!();
    const heapStart = process.memoryUsage().heapUsed;
    let heapMax = heapStart, rssMax = process.memoryUsage().rss;
    const elapsed: number[] = [], cpu: number[] = [];
    for (let n=0;n<30;n++) {
      const start = performance.now(), usage = process.cpuUsage();
      await request();
      const used = process.cpuUsage(usage);
      elapsed.push(performance.now()-start);
      cpu.push((used.user+used.system)/1000);
      const memory = process.memoryUsage();
      heapMax = Math.max(heapMax,memory.heapUsed); rssMax = Math.max(rssMax,memory.rss);
    }
    const calls = tracked(local.db);
    const diagnosticApp = appFor(handler, calls.db);
    const bytesRead = () => [...streams].reduce((sum,s) => sum+s.bytesRead,0);
    const bytesBefore = bytesRead();
    await (await diagnosticApp.request("/feeds/friends")).arrayBuffer();
    const receivedBytes = bytesRead()-bytesBefore;
    // 別途各SQLをEXPLAIN。実際のDBクラスと同じprepared statementで反復し、auto plan選択後も採る。
    const plans: unknown[] = [];
    const executions = Array(12).fill(0), plannings = Array(12).fill(0);
    for (const [index,call] of calls.queries.entries()) {
      const args = call.args.map(a => a instanceof Temporal.Instant ? a.toString() : a);
      for (let n=0;n<6;n++) await local.admin.query({ name: `diagnostic_${index}`, text: call.sql, values: args });
      const literals = args.map((arg) => arg === null ? "NULL" : "'"+String(arg).replaceAll("'","''")+"'");
      let plan;
      for (let sample=0;sample<12;sample++) {
        plan = (await local.admin.query(`EXPLAIN (ANALYZE, BUFFERS, TIMING OFF, FORMAT JSON) EXECUTE diagnostic_${index}(${literals.join(",")})`)).rows[0]["QUERY PLAN"][0];
        executions[sample] += plan["Execution Time"]; plannings[sample] += plan["Planning Time"];
      }
      plans.push({ sql: call.sql, rows: call.rows, plan });
    }
    const result = {
      mode, iterations: 30, warmups: 10, elapsedMs: summarize(elapsed), nodeCpuMs: summarize(cpu),
      elapsedSamples: elapsed, cpuSamples: cpu, coldMs, coldCpuMs: (coldUsage.user+coldUsage.system)/1000,
      heapStartMiB: heapStart/2**20, heapSampledMaxMiB: heapMax/2**20, rssSampledMaxMiB: rssMax/2**20,
      sqlCalls: calls.queries.length, returnedRows: calls.queries.reduce((sum,q)=>sum+q.rows,0), receivedBytes,
      dbExecutionMs: summarize(executions), dbPlanningMs: summarize(plannings),
      dbTotalMs: summarize(executions.map((v,i)=>v+plannings[i])),
      preparedPlans: (await local.admin.query("SELECT name,generic_plans,custom_plans FROM pg_prepared_statements ORDER BY name")).rows, plans,
    };
    console.log(JSON.stringify(result));
  } finally { await local.close(); await legacy?.close(); pg.Client.prototype.query = query; }
} else {
  await mkdir(output, { recursive: true });
  const local = await localDatabase(port, false);
  try {
    const version = (await local.admin.query("SELECT version() AS version")).rows[0].version;
    const fixed = Temporal.Now.instant().toString();
    const results: unknown[] = [];
    for (const shape of [
      { name: "small", friends: 60, unrelated: 20, history: 0, friendHistoryDays: 0 },
      { name: "large", friends: 110, unrelated: 30000, history: 100000, friendHistoryDays: 30 },
      { name: "history-heavy", friends: 110, unrelated: 30000, history: 100000, friendHistoryDays: 365 },
    ]) {
      await fixture(local.admin, shape.friends, shape.unrelated, shape.history, shape.friendHistoryDays);
      for (const [run,mode] of ["before","after","after","before"].entries()) {
        const result = await new Promise<any>((resolveResult,reject) => {
          const child = spawn(process.execPath,["--expose-gc",self,"--worker",mode,fixed],{env:process.env,stdio:["ignore","pipe","pipe"]});
          let stdout="",stderr="";
          child.stdout.on("data",chunk=>stdout+=chunk); child.stderr.on("data",chunk=>stderr+=chunk);
          child.on("error",reject);
          child.on("close",code=>code===0 ? resolveResult(JSON.parse(stdout)) : reject(new Error(stderr+stdout)));
        });
        results.push({shape,run,...result});
        await writeFile(resolve(output,`${shape.name}-${run}-${mode}.json`),JSON.stringify(result,null,2)+"\n");
        const {plans,elapsedSamples,cpuSamples,...summary}=result;
        console.log(JSON.stringify({shape:shape.name,run,...summary}));
      }
    }
    await writeFile(resolve(output,"comparison.json"),JSON.stringify({baseline,node:process.version,version,fixed,order:"ABBA, independent Node processes",results},null,2)+"\n");
  } finally { await local.close(); }
}
