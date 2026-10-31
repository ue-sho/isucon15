import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createServer } from "node:net";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import jpeg from "jpeg-js";
import pg from "pg";
import { sha256Hex } from "../src/session.ts";

const pgPort = process.env.MEMORIES_PLACEMENT_PG_PORT;

async function freePort(): Promise<number> {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

// 明示したloopback上の空DBだけを使用する。本番env.shやデータは読み込まない。
test("別workerのMemories: 認証・地域・ページング・即時反映・世代変更・再起動", { skip: !pgPort, timeout: 60_000 }, async (t) => {
  const dbName = "isureal_memories_placement_test";
  const db = new pg.Client({ host: "127.0.0.1", port: Number(pgPort), user: "postgres", password: "", database: dbName });
  await db.connect();
  t.after(() => db.end());
  assert.equal((await db.query("SELECT count(*) FROM pg_tables WHERE schemaname='public'")).rows[0].count, "0", "requires a new disposable DB");
  await db.query(await readFile(new URL("../../sql/001-schema.sql", import.meta.url), "utf8"));
  for (const [id, region] of [["owner", "asia"], ["other", "asia"], ["europe", "europe"]]) {
    await db.query("INSERT INTO users(id,username,secret_key_hash,display_name,region) VALUES($1::text,$1::text,$2::text,$1::text,$3::text)", [id, "ab".repeat(32), region]);
    await db.query("INSERT INTO login_sessions(id,user_id,token_hash) VALUES($1,$1,$2)", [id, sha256Hex(id!)]);
  }
  await db.query(`INSERT INTO posting_windows(id,region,local_date,starts_at,on_time_deadline,ended_at)
    VALUES('history','asia','2026-10-10','2026-10-10T00:00:00Z','2026-10-10T00:02:00Z','2026-10-11T00:00:00Z')`);
  const image = jpeg.encode({ data: Buffer.from([255, 0, 0, 255]), width: 1, height: 1 }, 80).data;
  await db.query("INSERT INTO image_objects(id,owner_user_id,data,media_type,created_at) VALUES('image','owner',$1,'image/jpeg','2026-10-10T12:00:00Z')", [image]);
  await db.query(`INSERT INTO posts(id,author_id,posting_window_id,image_id,caption,visibility,location_kind,posted_at)
    SELECT 'post-' || lpad(n::text,2,'0'),'owner','history','image','fixture','friends','none',
      '2026-10-10T12:00:00Z'::timestamptz - n * interval '1 second' FROM generate_series(1,51) n`);
  await db.query("INSERT INTO comments(id,post_id,author_id,body,created_at) VALUES('comment','post-01','other','before',clock_timestamp())");
  await db.query("INSERT INTO ip_bans(ip,banned_until) VALUES('203.0.113.99',clock_timestamp()+interval '1 hour')");

  const children: ChildProcess[] = [];
  async function stop(child: ChildProcess) {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, "exit");
    child.kill("SIGTERM");
    await exited;
  }
  t.after(async () => { await Promise.all(children.map(stop)); });
  const headers = { Authorization: "Bearer owner", "X-Client-IP": "203.0.113.1", "X-Country-Code": "JP" };
  async function start(port: number): Promise<ChildProcess> {
    const child = spawn(process.execPath, ["src/main.ts"], {
      cwd: new URL("../", import.meta.url),
      env: {
        PATH: process.env.PATH, ISUREAL_REGION: "asia", ISUREAL_PORT: String(port), ISUREAL_WORKERS: "1", ISUREAL_DB_POOL_SIZE: "2",
        ISUREAL_DB_HOST: "127.0.0.1", ISUREAL_DB_PORT: pgPort!, ISUREAL_DB_USER: "postgres", ISUREAL_DB_PASSWORD: "", ISUREAL_DB_NAME: dbName,
        ISUREAL_LOG_LEVEL: "error", PPROTEIN_ENABLED: "0",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.push(child);
    let output = "";
    for (const stream of [child.stdout!, child.stderr!]) stream.on("data", (data) => { output = (output + String(data)).slice(-2000); });
    for (let i = 0; i < 100; i++) {
      assert.equal(child.exitCode, null, output);
      try {
        const response = await fetch(`http://127.0.0.1:${port}/api/memories?month=2026-10`, { headers: { "X-Client-IP": "203.0.113.1" }, signal: AbortSignal.timeout(500) });
        await response.text();
        if (response.status === 401) return child;
      } catch { /* 起動待ち */ }
      await delay(30);
    }
    assert.fail("worker failed to start: " + output);
  }
  const asia1Port = await freePort();
  const asia2Port = await freePort();
  await start(asia1Port);
  let worker = await start(asia2Port);
  const asia1 = `http://127.0.0.1:${asia1Port}`;
  const asia2 = `http://127.0.0.1:${asia2Port}`;
  async function memories(path = "/api/memories?month=2026-10", token = "owner") {
    const response = await fetch(asia2 + path, { headers: { ...headers, Authorization: `Bearer ${token}` } });
    assert.equal(response.status, 200, await response.clone().text());
    return response.json();
  }
  for (const [path, token, expected] of [
    ["/api/memories?month=2026-10", "invalid", 401],
    ["/api/memories/2026-10-10", "europe", 403],
    ["/api/memories?month=2026-13", "owner", 400],
    ["/api/memories/invalid", "owner", 400],
    ["/api/memories?month=2026-10&beforeId=x", "owner", 400],
  ] as const) {
    const response = await fetch(asia2 + path, { headers: { ...headers, Authorization: `Bearer ${token}` } });
    assert.equal(response.status, expected, await response.text());
  }
  const banned = await fetch(asia2 + "/api/memories?month=2026-10", { headers: { ...headers, "X-Client-IP": "203.0.113.99" } });
  assert.equal(banned.status, 403);
  assert.deepEqual(await banned.json(), { error: "ip_banned" });
  const wrongMethod = await fetch(asia2 + "/api/memories", { method: "POST", headers });
  assert.equal(wrongMethod.status, 405);
  await wrongMethod.text();
  const first = await memories();
  assert.equal(first.items.length, 50);
  assert.equal(first.hasMore, true);
  assert.equal(first.items[0].id, "post-01");
  assert.equal(first.items[0].comments[0].body, "before");
  const last = first.items.at(-1);
  const second = await memories("/api/memories?" + new URLSearchParams({ month: "2026-10", beforePostedAt: last.postedAt, beforeId: last.id }));
  assert.deepEqual(second.items.map((item: { id: string }) => item.id), ["post-51"]);
  assert.equal(second.hasMore, false);
  const day = await memories("/api/memories/2026-10-10");
  assert.deepEqual(day.items.map((item: { id: string }) => item.id), first.items.map((item: { id: string }) => item.id));
  assert.deepEqual((await memories("/api/memories?month=2026-10", "other")).items, []);

  async function checkImage(url: string) {
    const response = await fetch(asia1 + url, { headers });
    assert.equal(response.status, 200, await response.clone().text());
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), image);
  }
  await checkImage(first.items[0].imageUrl);
  // 別接続で確定した更新は、温まったMemories workerにも直ちに反映される。
  await db.query("UPDATE comments SET body='after' WHERE id='comment'");
  await db.query("UPDATE posts SET deleted_at=clock_timestamp() WHERE id='post-02'");
  const updated = await memories();
  assert.equal(updated.items[0].comments[0].body, "after");
  assert.ok(updated.items.every((item: { id: string }) => item.id !== "post-02"));

  // reset.sqlと同じ共有世代の進行を模擬する（初期データ再投入そのものの試験ではない）。
  await db.query("UPDATE image_signature_cache_state SET generation=generation+1");
  await db.query("UPDATE users SET secret_key_hash=$1 WHERE id='owner'", ["cd".repeat(32)]);
  const reset = await memories();
  await checkImage(reset.items[0].imageUrl);
  const old = await fetch(asia1 + first.items[0].imageUrl, { headers });
  assert.equal(old.status, 403);
  await old.text();
  await stop(worker);
  worker = await start(asia2Port);
  const restarted = await memories();
  assert.deepEqual(restarted.items.map((item: { id: string }) => item.id), reset.items.map((item: { id: string }) => item.id));
  await checkImage(restarted.items[0].imageUrl);
});
