import assert from "node:assert/strict";
import crypto from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import { test } from "node:test";
import type { Queryer } from "../src/db.ts";
import { getFeedHandler } from "../src/feed_api.ts";
import { getFriendsFeed } from "../src/friends_feed.ts";
import { appFor, fixture, legacyFeed, localDatabase, stamp, tracked } from "./helpers/friends-feed.ts";

const port = process.env.FRIENDS_FEED_TEST_PORT;
test("friends feed: PostgreSQLで変更前のJSON・権限・ページングと比較", { skip: !port }, async (t) => {
  const local = await localDatabase(port!, process.env.FRIENDS_FEED_TEST_REUSE !== "1");
  t.after(() => local.close());
  const legacy = await legacyFeed();
  t.after(() => legacy.close());
  t.mock.method(Temporal.Now, "instant", () => stamp);
  const oldDB = tracked(local.db), newDB = tracked(local.db);
  const oldApp = appFor(legacy.handler, oldDB.db, "viewer", legacy.errorHandler), newApp = appFor(getFeedHandler, newDB.db);
  async function compare(path = "/feeds/friends") {
    oldDB.queries.length = 0; newDB.queries.length = 0;
    const before = await oldApp.request(path), after = await newApp.request(path);
    assert.equal(after.status, before.status);
    assert.equal(after.headers.get("content-type"), before.headers.get("content-type"));
    const beforeText = await before.text(), afterText = await after.text();
    assert.equal(afterText, beforeText, path);
    return JSON.parse(afterText);
  }
  async function empty() {
    assert.deepEqual(await compare(), { items: [], hasMore: false });
    assert.equal(newDB.queries.length, 1);
    assert.equal(newDB.queries[0].rows, 0);
  }
  for (const count of [0, 49, 50, 51, 120]) {
    await t.test(`${count}件と複数ページ・同時刻ID順・microsecond精度`, async () => {
      await fixture(local.admin, count);
      const ids: string[] = [];
      let path = "/feeds/friends";
      while (true) {
        const body = await compare(path);
        assert.equal(body.items.length, Math.min(50, count - ids.length));
        assert.equal(body.hasMore, count - ids.length > 50);
        assert.equal(newDB.queries.length, 1);
        assert.equal(newDB.queries[0].rows, Math.min(51, count - ids.length));
        ids.push(...body.items.map((p: any) => p.id));
        if (!body.hasMore) break;
        const last = body.items.at(-1);
        path = "/feeds/friends?" + new URLSearchParams({ beforePostedAt: last.postedAt, beforeId: last.id });
      }
      assert.equal(ids.length, new Set(ids).size);
      const ordered = await local.admin.query("SELECT id FROM posts WHERE id LIKE 'p-%' ORDER BY posted_at DESC,id DESC");
      assert.deepEqual(ids, ordered.rows.map((r) => r.id));
      if (count) {
        const body = await compare();
        assert.equal(body.items[0].postedAt, "2026-10-31T02:00:00.123456Z");
        assert.equal(body.items[0].id, "p-000002");
      }
    });
  }

  for (const [label, sql, expected] of [
    ["未投稿", "DELETE FROM posts WHERE id='own'", 0],
    ["削除済みの本人投稿", "UPDATE posts SET deleted_at='2026-10-31' WHERE id='own'", 0],
    ["現在枠なし", "UPDATE posting_windows SET ended_at='2026-11-01' WHERE id='asia'", 0],
    ["本人の前日投稿のみ", "UPDATE posts SET posting_window_id='past' WHERE id='own'", 0],
    ["別地域の終了済み同日投稿でも閲覧可", "UPDATE posts SET posting_window_id='same-date-ended' WHERE id='own'", 9],
    ["別地域の未終了同日投稿でも閲覧可", "UPDATE posts SET posting_window_id='america' WHERE id='own'", 9],
    ["別地域で日付が違う本人投稿", "UPDATE posts SET posting_window_id='europe' WHERE id='own'", 0],
    ["地域移動して現在枠の日付が変わる", "UPDATE users SET region='europe' WHERE id='viewer'", 0],
    ["地域移動しても同日なら閲覧可", "UPDATE users SET region='america' WHERE id='viewer'", 9],
    ["地域移動後の同日投稿があれば閲覧可", "UPDATE users SET region='europe' WHERE id='viewer'; UPDATE posts SET posting_window_id='europe' WHERE id='own'", 9],
    ["作者の期間終了", "UPDATE posting_windows SET ended_at='2026-11-02' WHERE id='europe'", 6],
    ["友達解除", "DELETE FROM friendships WHERE id='friend-1'", 8],
    ["閲覧者からblock", "INSERT INTO block_relations(id,blocker_id,blocked_id) VALUES('new','viewer','z-friend-000001')", 8],
    ["作者からblock", "INSERT INTO block_relations(id,blocker_id,blocked_id) VALUES('new','z-friend-000001','viewer')", 8],
    ["public公開へ変更", "UPDATE posts SET visibility='public' WHERE id LIKE 'p-%'", 9],
    ["friends公開へ変更", "UPDATE posts SET visibility='friends' WHERE id LIKE 'p-%'", 9],
    ["friends_of_friends公開へ変更", "UPDATE posts SET visibility='friends_of_friends' WHERE id LIKE 'p-%'", 9],
    ["未知の公開範囲は除外", "UPDATE posts SET visibility='unknown' WHERE id='p-000001'", 8],
    ["投稿削除", "UPDATE posts SET deleted_at='2026-10-31' WHERE id='p-000001'", 8],
    ["作者退会", "UPDATE users SET status='deleted' WHERE id='z-friend-000001'", 8],
    ["閲覧者退会", "UPDATE users SET status='deleted' WHERE id='viewer'", 0],
    ["全友達解除", "DELETE FROM friendships WHERE user_low_id='viewer' OR user_high_id='viewer'", 0],
  ] as const) {
    await t.test(`${label}: 更新完了後の次リクエストに反映`, async () => {
      await fixture(local.admin, 9);
      assert.equal((await compare()).items.length, 9);
      await local.admin.query(sql);
      const result = await compare();
      assert.equal(result.items.length, expected);
      assert.equal(result.hasMore, false);
      if (expected === 0) await empty();
    });
  }
  await t.test("新しい無関係な投稿5000件を除外して50件を返す", async () => {
    await fixture(local.admin, 110, 5000);
    const body = await compare();
    assert.equal(body.items.length, 50);
    assert.equal(body.hasMore, true);
    assert.ok(oldDB.queries.some((q) => q.rows > 5000));
    assert.equal(newDB.queries.length, 1);
    assert.equal(newDB.queries[0].rows, 51);
    assert.ok(body.items.some((p: any) => p.postingWindowId === "europe"), "作者の地域・local_dateを閲覧者に限定しない");
  });
  await t.test("cursorの端数・タイムゾーンを従来どおりPostgreSQLへ渡す", async () => {
    for (const timestamp of ["2026-10-31T02:00:00.123455Z", "2026-10-31T11:00:00.123455+09:00", "2026-10-31T02:00:00.123455999Z"]) {
      const body = await compare("/feeds/friends?" + new URLSearchParams({ beforePostedAt: timestamp, beforeId: "p-000004" }));
      assert.equal(body.items.length, 50);
      assert.ok(newDB.queries[0].args[1] instanceof Temporal.Instant);
    }
  });
  await t.test("51件目は変換・署名しない", async (t) => {
    const q = newDB.queries[0];
    const rows = await local.db.select(q.sql, ...q.args);
    assert.equal(rows.length, 51);
    rows[50] = new Proxy({}, { get() { throw new Error("51件目の変換は禁止"); } });
    const db = { select: async () => rows } as unknown as Queryer;
    const hash = crypto.hash;
    let calls = 0;
    t.mock.method(Date, "now", () => stamp.epochMilliseconds + 48 * 60 * 60 * 1000);
    crypto.hash = ((...args: Parameters<typeof crypto.hash>) => { calls += 0.5; return hash(...args); }) as typeof crypto.hash;
    syncBuiltinESMExports();
    try {
      const result = await getFriendsFeed(db, "viewer", null, "");
      assert.equal(result.items.length, 50);
      assert.equal(result.hasMore, true);
      assert.equal(calls, 50 * 2 * 1000);
    } finally { crypto.hash = hash; syncBuiltinESMExports(); }
  });
  for (const path of ["/feeds/unknown", "/feeds/friends?beforeId=x", "/feeds/friends?beforePostedAt=2026-10-31T00:00:00Z", "/feeds/friends?beforePostedAt=invalid&beforeId=x", "/feeds/friends?beforeScore=invalid", "/feeds/friends-of-friends?beforeScore=3"]) {
    await t.test(`入力エラーをDB呼出し前に維持: ${path}`, async () => {
      await compare(path);
      assert.equal((await newApp.request(path)).status, 400);
      assert.equal(oldDB.queries.length, 0);
      assert.equal(newDB.queries.length, 0);
    });
  }
  await t.test("非ランキングのbeforeScoreは従来どおり無視", async () => {
    const body = await compare("/feeds/friends?beforeScore=123");
    assert.equal(body.items.length, 50);
  });
  await t.test("cursorありのprepared statement反復でも同じページ", async () => {
    const page = await compare();
    const last = page.items.at(-1);
    const path = "/feeds/friends?" + new URLSearchParams({ beforePostedAt: last.postedAt, beforeId: last.id });
    for (let n = 0; n < 8; n++) assert.equal((await compare(path)).items.length, 50);
  });
  await t.test("未投稿では実行計画上も候補・友達の走査を実行しない", async () => {
    await fixture(local.admin, 9, 100);
    await local.admin.query("DELETE FROM posts WHERE id='own'");
    await empty();
    const q = newDB.queries[0];
    const plan = (await local.admin.query("EXPLAIN (ANALYZE, FORMAT JSON) " + q.sql, q.args)).rows[0]["QUERY PLAN"][0].Plan;
    const nodes: any[] = [];
    function visit(node: any) { nodes.push(node); for (const child of node.Plans ?? []) visit(child); }
    visit(plan);
    assert.ok(nodes.some((node) => node.Alias === "p"));
    for (const node of nodes.filter((node) => ["p", "u", "f"].includes(node.Alias))) assert.equal(node["Actual Loops"], 0);
  });
  await t.test("空応答の確定後に本人投稿がcommitされたら次リクエストに反映", async () => {
    await fixture(local.admin, 9);
    await local.admin.query("DELETE FROM posts WHERE id='own'");
    const wrapped = { async select<T>(sql: string, ...args: unknown[]) {
      const rows = await local.db.select<T>(sql, ...args);
      await local.admin.query("INSERT INTO posts(id,author_id,posting_window_id,image_id,visibility,location_kind,posted_at) VALUES('own','viewer','asia','own-image','friends','none','2026-10-31')");
      return rows;
    } } as typeof local.db;
    const response = await appFor(getFeedHandler, wrapped).request("/feeds/friends");
    assert.deepEqual(await response.json(), { items: [], hasMore: false });
    assert.equal((await compare()).items.length, 9);
  });
  await t.test("認証後に閲覧者が存在しない場合も空", async () => {
    const old = await appFor(legacy.handler, local.db, "missing").request("/feeds/friends");
    const current = await appFor(getFeedHandler, local.db, "missing").request("/feeds/friends");
    assert.equal(await current.text(), await old.text());
    assert.equal(current.status, 200);
  });
  for (const feed of ["public", "following", "friends-of-friends"]) {
    await t.test(`${feed}のJSON・順序・cursor・未投稿時に回帰なし`, async () => {
      await fixture(local.admin, 110, 80);
      const body = await compare(`/feeds/${feed}`);
      assert.ok(body.items.length > 0);
      const last = body.items.at(-1);
      const params = new URLSearchParams({ beforePostedAt: last.postedAt, beforeId: last.id });
      if (feed === "friends-of-friends") params.set("beforeScore", String(last.score));
      await compare(`/feeds/${feed}?${params}`);
      await local.admin.query("DELETE FROM posts WHERE id='own'");
      assert.deepEqual(await compare(`/feeds/${feed}`), { items: [], hasMore: false });
    });
  }
});
