import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import pg from "pg";

const port = process.env.QUERY_INDEX_TEST_PG_PORT;
test("検索索引の適用前後・結果一致・再接続・撤去 / 専用PG16", { skip: !port, timeout: 60000 }, async (t) => {
  const connection = { host: "127.0.0.1", port: Number(port), user: "postgres" };
  const database = `query_indexes_${Date.now()}`;
  const admin = new pg.Client({ ...connection, database: "postgres" });
  await admin.connect();
  try { await admin.query(`CREATE DATABASE ${database}`); } finally { await admin.end(); }
  const client = new pg.Client({ ...connection, database });
  await client.connect();
  t.after(() => client.end());
  const schema = await readFile(new URL("../../sql/001-schema.sql", import.meta.url), "utf8");
  // 既存DBと同じく候補索引がまだ存在しない状態から、up.sqlを適用する。
  await client.query(schema.replace(/^CREATE INDEX (login_sessions_active_token_idx|posts_active_author_window_idx).*;\n/gm, ""));
  await client.query(`INSERT INTO users(id,username,secret_key_hash,display_name,region)
    SELECT md5(g::text),'user-'||g,repeat('ab',32),'user-'||g,'asia' FROM generate_series(1,1000) g`);
  await client.query(`INSERT INTO posting_windows(id,region,local_date,starts_at,on_time_deadline,ended_at)
    SELECT 'window-'||g,'asia','2026-01-01'::date+g,clock_timestamp(),clock_timestamp(),clock_timestamp() FROM generate_series(0,124) g`);
  await client.query(`INSERT INTO posts(id,author_id,posting_window_id,image_id,visibility,location_kind,posted_at,deleted_at)
    SELECT md5('post-'||g),md5((g%1000+1)::text),'window-'||((g/1000)%125),md5('image-'||g),'public','none',
      '2026-01-01'::timestamptz+g*interval '1 second',CASE WHEN g%10=0 THEN clock_timestamp() END FROM generate_series(1,200000) g`);
  await client.query(`INSERT INTO login_sessions(id,user_id,token_hash,active)
    SELECT md5('session-'||g),md5((g%1000+1)::text),md5('token-'||g),g<=1000 FROM generate_series(1,20000) g`);
  await client.query("ANALYZE users; ANALYZE posting_windows; ANALYZE posts; ANALYZE login_sessions");
  const queries = {
    session: { sql: "SELECT user_id FROM login_sessions WHERE token_hash=md5($1) AND active=true", args: ["token-1"] },
    post: { sql: "SELECT id FROM posts WHERE author_id=md5($1) AND posting_window_id=$2 AND deleted_at IS NULL ORDER BY id", args: ["2", "window-0"] },
  };
  const before = new Map<string, unknown[]>();
  const plans: Record<string, any> = {};
  for (const [name, { args }] of Object.entries(queries)) {
    const query = queries[name as keyof typeof queries];
    const rows = (await client.query(query.sql, args)).rows;
    assert.ok(rows.length > 0);
    before.set(name, rows);
    plans[name] = { before: (await client.query(`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ${query.sql}`, args)).rows[0]["QUERY PLAN"][0] };
  }
  async function migration(direction: "up" | "down") {
    const source = await readFile(new URL(`../../sql/migrations/20261031-auth-post-lookup.${direction}.sql`, import.meta.url), "utf8");
    for (const sql of source.replace(/^\\.*$/gm, "").split(";")) if (sql.trim()) await client.query(sql);
  }
  await migration("up");
  for (const [name, { sql, args }] of Object.entries(queries)) {
    assert.deepEqual((await client.query(sql, args)).rows, before.get(name));
    const plan = (await client.query(`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ${sql}`, args)).rows[0]["QUERY PLAN"][0];
    plans[name].after = plan;
    assert.match(JSON.stringify(plan), new RegExp(name === "session" ? "login_sessions_active_token_idx" : "posts_active_author_window_idx"));
  }
  const lookup = await client.query("SELECT indexrelid::regclass::text AS name,indisvalid,indisready FROM pg_index WHERE indexrelid IN ('login_sessions_active_token_idx'::regclass,'posts_active_author_window_idx'::regclass)");
  assert.equal(lookup.rows.length, 2);
  assert.ok(lookup.rows.every((row) => row.indisvalid && row.indisready));
  const reconnect = new pg.Client({ ...connection, database });
  await reconnect.connect();
  try { assert.deepEqual((await reconnect.query(queries.post.sql, queries.post.args)).rows, before.get("post")); } finally { await reconnect.end(); }
  await client.query(await readFile(new URL("../../sql/003-initial-snapshot.sql", import.meta.url), "utf8"));
  await client.query(await readFile(new URL("../../sql/reset.sql", import.meta.url), "utf8"));
  assert.equal((await client.query("SELECT count(*)::int AS n FROM pg_index WHERE indexrelid IN ('login_sessions_active_token_idx'::regclass,'posts_active_author_window_idx'::regclass) AND indisvalid AND indisready")).rows[0].n, 2);
  assert.deepEqual((await client.query(queries.post.sql, queries.post.args)).rows, before.get("post"));
  assert.equal((await client.query(queries.session.sql, queries.session.args)).rows.length, 0);
  await client.query("INSERT INTO login_sessions(id,user_id,token_hash) VALUES(md5('session-1'),md5('2'),md5('token-1'))");
  await migration("down");
  assert.equal((await client.query("SELECT to_regclass('posts_active_author_window_idx') AS name")).rows[0].name, null);
  for (const [name, { sql, args }] of Object.entries(queries)) assert.deepEqual((await client.query(sql, args)).rows, before.get(name));
  // 合成データのローカル時間であり、本番効果の根拠とは区別する。
  t.diagnostic(JSON.stringify(Object.fromEntries(Object.entries(plans).map(([name, p]) => [name, { beforeMs: p.before["Execution Time"], afterMs: p.after["Execution Time"] }]))));
});
