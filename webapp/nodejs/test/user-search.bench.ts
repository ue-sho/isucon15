import assert from "node:assert/strict";
import { searchUsersHandler } from "../src/user_read_api.ts";
import type { DB } from "../src/db.ts";
import { legacySearch, searchApp, searchDatabase, searchFixture, searchWire, sqlFile } from "./helpers/user-search.ts";

const port = process.env.SEARCH_TEST_PG_PORT;
assert.ok(port, "SEARCH_TEST_PG_PORT must point to the dedicated disposable local DB");
const f = await searchDatabase(port);
try {
  if (process.argv[2] === "seed") {
    assert.equal((await f.admin.query("SELECT count(*) FROM pg_tables WHERE schemaname='public'")).rows[0].count, "0");
    await f.admin.query(await sqlFile("001-schema.sql"));
    await searchFixture(f.admin, f.db, 5022);
    await f.admin.query("CREATE TABLE search_benchmark_marker(id boolean PRIMARY KEY CHECK(id)); INSERT INTO search_benchmark_marker VALUES(true)");
    console.log(JSON.stringify({ version: (await f.admin.query("SELECT version()")).rows[0].version, users: (await f.admin.query("SELECT count(*) FROM users")).rows[0].count, node: process.version }));
  } else if (process.argv[2] === "verify") {
    assert.equal((await f.admin.query("SELECT id FROM search_benchmark_marker")).rows[0]?.id, true);
    const legacy = await legacySearch();
    try {
      const old = searchApp(legacy.handler, f.db, legacy.errorHandler);
      const current = searchApp(searchUsersHandler, f.db);
      let pages = 0;
      for (const q of ["common", "n51", "café", "never-match"]) {
        let cursor: { username: string; id: string } | undefined;
        do {
          const params = new URLSearchParams({ q });
          if (cursor) { params.set("beforeUsername", cursor.username); params.set("beforeId", cursor.id); }
          const expected = await (await old.request("/api/users?" + params)).json();
          const actual = await (await current.request("/api/users?" + params)).json();
          assert.deepEqual(actual, expected); pages++;
          if (!actual.hasMore) break;
          cursor = actual.items.at(-1);
        } while (true);
      }
      console.log(JSON.stringify({ verifiedPages: pages, users: 5037, baseline: "993e1b0" }));
    } finally { await legacy.close(); }
  } else {
    assert.equal((await f.admin.query("SELECT id FROM search_benchmark_marker")).rows[0]?.id, true);
    const mode = process.argv[2]; assert.ok(mode === "old" || mode === "new");
    const wire = await searchWire(Number(port), Number(process.env.SEARCH_BENCH_RTT_MS ?? 0));
    const link = await searchDatabase(wire.port);
    const legacy = await legacySearch();
    try {
      let rows = 0, queries = 0;
      const tracked = { select: async <T>(sql: string, ...args: unknown[]) => {
        const result = await link.db.select<T>(sql, ...args); rows += result.length; queries++; return result;
      } } as DB;
      const app = searchApp(mode === "old" ? legacy.handler : searchUsersHandler, tracked, mode === "old" ? legacy.errorHandler : undefined);
      const q = process.env.SEARCH_BENCH_QUERY ?? "common";
      const url = "/api/users?" + new URLSearchParams({ q });
      // Warm the same prepared statements and connection used in the measured run.
      await (await app.request(url)).arrayBuffer();
      const samples: { ms: number; cpuMs: number; bytes: number; rows: number; queries: number; returned: number; hasMore: boolean }[] = [];
      for (let i = 0; i < 8; i++) {
        rows = 0; queries = 0; const beforeBytes = wire.bytes;
        const cpu = process.cpuUsage(), start = performance.now();
        const response = await app.request(url); assert.equal(response.status, 200);
        const body = await response.json(); const ms = performance.now() - start;
        const used = process.cpuUsage(cpu);
        samples.push({ ms, cpuMs: (used.user + used.system) / 1000, bytes: wire.bytes - beforeBytes, rows, queries, returned: body.items.length, hasMore: body.hasMore });
      }
      const median = (key: "ms" | "cpuMs" | "bytes" | "rows" | "queries") => {
        const sorted = samples.map((s) => s[key]).sort((a,b) => a-b);
        return (sorted[3]! + sorted[4]!) / 2;
      };
      // Capture the real executed SQL and server execution time separately from
      // handler wall time, which also includes transfers and Node processing.
      let sql = "", args: unknown[] = [];
      const capture = { select: async <T>(text: string, ...values: unknown[]) => {
        if (text.includes("FROM users")) { sql = text; args = values; }
        return link.db.select<T>(text, ...values);
      } } as DB;
      await (await searchApp(mode === "old" ? legacy.handler : searchUsersHandler, capture, mode === "old" ? legacy.errorHandler : undefined).request(url)).arrayBuffer();
      const explain = (await f.admin.query("EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) " + sql, args)).rows[0]["QUERY PLAN"][0];
      console.log(JSON.stringify({ mode, q, rttMs: Number(process.env.SEARCH_BENCH_RTT_MS ?? 0), samples: samples.length,
        median: { ms: median("ms"), cpuMs: median("cpuMs"), bytes: median("bytes"), rows: median("rows"), queries: median("queries") },
        returned: samples[0]!.returned, hasMore: samples[0]!.hasMore,
        serverExecutionMs: explain["Execution Time"], planRows: explain.Plan["Actual Rows"], plan: explain.Plan["Node Type"] }));
    } finally { await legacy.close(); await link.close(); await wire.close(); }
  }
} finally { await f.close(); }
