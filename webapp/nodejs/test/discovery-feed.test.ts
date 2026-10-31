import assert from "node:assert/strict";
import { test } from "node:test";
import { getFeedHandler } from "../src/feed_api.ts";
import { Hono } from "hono";
import { apiErrorHandler } from "../src/api_error.ts";
import { sessionMiddleware, sha256Hex } from "../src/session.ts";
import { regionMiddleware } from "../src/region.ts";
import type { Env, HandlerContext } from "../src/server.ts";
import { appFor, fixture, legacyFeed, localDatabase, stamp, tracked } from "./helpers/friends-feed.ts";

export const discoveryBaseline = "c0556a4fba0ea42063cbd53f07ace0f6f8690064";
const port = process.env.DISCOVERY_FEED_TEST_PORT;

test("discovery feeds: PostgreSQLで変更前の権限・推薦点・全ページを比較", { skip: !port }, async (t) => {
  const local = await localDatabase(port!);
  t.after(() => local.close());
  const legacy = await legacyFeed(discoveryBaseline);
  t.after(() => legacy.close());
  t.mock.method(Temporal.Now, "instant", () => stamp);
  const oldDB = tracked(local.db), newDB = tracked(local.db);
  const oldApp = appFor(legacy.handler, oldDB.db, "viewer", legacy.errorHandler);
  const newApp = appFor(getFeedHandler, newDB.db);
  async function compare(path: string) {
    oldDB.queries.length = 0; newDB.queries.length = 0;
    const before = await oldApp.request(path), after = await newApp.request(path);
    assert.equal(after.status, before.status, path);
    assert.equal(after.headers.get("content-type"), before.headers.get("content-type"));
    const beforeText = await before.text(), afterText = await after.text();
    assert.equal(afterText, beforeText, path);
    if (after.status === 200) {
      assert.equal(newDB.queries.length, 1);
      assert.ok(newDB.queries[0].rows <= 51, "Nodeへは最大51行だけを返す");
    }
    return JSON.parse(afterText);
  }
  async function allPages(feed: string, expected?: number) {
    const items: any[] = [];
    let path = `/feeds/${feed}`;
    for (let page = 0; page < 50; page++) {
      const body = await compare(path);
      assert.ok(body.items.length <= 50);
      items.push(...body.items);
      if (!body.hasMore) break;
      assert.equal(body.items.length, 50);
      const last = body.items.at(-1);
      path = `/feeds/${feed}?` + new URLSearchParams({
        beforePostedAt: last.postedAt, beforeId: last.id,
        ...(feed === "friends-of-friends" ? { beforeScore: String(last.score) } : {}),
      });
      assert.ok(page < 49, "ページングが終了する");
    }
    assert.equal(new Set(items.map((item) => item.id)).size, items.length, "ページ間に重複なし");
    if (expected !== undefined) assert.equal(items.length, expected);
    return items;
  }

  for (const feed of ["following", "friends-of-friends"]) {
    for (const count of [0, 49, 50, 51, 120]) {
      await t.test(`${feed}: ${count}件と全ページ・同点・同時刻`, async () => {
        await fixture(local.admin, 3, feed === "following" ? count : Math.max(0, count - 1));
        if (feed === "following") {
          await local.admin.query("DELETE FROM follows");
          await local.admin.query(`INSERT INTO follows(id,follower_id,followee_id)
            SELECT 'follow-'||n,'viewer','outsider-'||lpad(n::text,6,'0') FROM generate_series(1,$1::int) n`, [count]);
        } else if (count === 0) {
          await local.admin.query("DELETE FROM friendships WHERE id='mutual'");
        }
        await allPages(feed, count);
      });
    }
  }

  async function richFixture() {
    await fixture(local.admin, 12, 160);
    await local.admin.query(`
      INSERT INTO friendships(id,user_low_id,user_high_id)
      SELECT 'second-'||n,LEAST('a-friend-000002',id),GREATEST('a-friend-000002',id)
      FROM (SELECT n,'outsider-'||lpad(n::text,6,'0') AS id FROM generate_series(1,160) n WHERE n%2=0 AND n%12+1<>2) x;
      INSERT INTO friendships(id,user_low_id,user_high_id)
      SELECT 'third-'||n,LEAST('z-friend-000003',id),GREATEST('z-friend-000003',id)
      FROM (SELECT n,'outsider-'||lpad(n::text,6,'0') AS id FROM generate_series(1,160) n WHERE n%3=0 AND n%12+1<>3) x;
      INSERT INTO friendships(id,user_low_id,user_high_id)
      SELECT 'cross-'||n,'outsider-000001','outsider-'||lpad(n::text,6,'0') FROM generate_series(2,45) n;
      INSERT INTO friendships(id,user_low_id,user_high_id) VALUES
        ('triangle','a-friend-000002','z-friend-000001');
      INSERT INTO follows(id,follower_id,followee_id)
      SELECT 'follow-'||n,'viewer','outsider-'||lpad(n::text,6,'0') FROM generate_series(1,160) n;
      UPDATE posts SET visibility=(ARRAY['public','friends','friends_of_friends','invalid'])[right(author_id,3)::int%4+1]
        WHERE author_id LIKE 'outsider-%';
      UPDATE posts SET posted_at='2026-10-31 03:00:00.123456+00' WHERE author_id LIKE 'outsider-%';
      INSERT INTO comments(id,post_id,author_id,body,created_at) VALUES
        ('engage-one','outside-1','z-friend-000001','one','2026-10-31'),
        ('engage-repeat','outside-1','z-friend-000001','two','2026-10-31'),
        ('engage-two','outside-1','a-friend-000002','three','2026-10-31'),
        ('engage-stranger','outside-1','nonfriend','ignored','2026-10-31');
      INSERT INTO realmojis(id,post_id,reactor_id,image_id,reaction_type,created_at) VALUES
        ('engage-same','outside-1','z-friend-000001','reaction','like','2026-10-31'),
        ('engage-replaced','outside-1','z-friend-000003','reaction2','like','2026-10-31');
      UPDATE realmojis SET replaced_at='2026-10-31' WHERE id='engage-replaced';
      UPDATE posts SET visibility='friends_of_friends' WHERE id='outside-1';
    `);
  }

  await t.test("共通友達・つながり30点上限・友人の反応のUNION重複除外", async () => {
    await richFixture();
    const items = await allPages("friends-of-friends");
    const first = items.find((item) => item.id === "outside-1");
    assert.ok(first);
    // 共通友達1人 + 異なる友人2人の反応 + 上限30。
    assert.equal(first.score, 3 + 20 + 30);
    await allPages("following");
  });

  await t.test("ランキングcursorはnanosecond・異なるタイムゾーン・負の値を維持", async () => {
    const body = await compare("/feeds/friends-of-friends");
    const last = body.items.at(-1);
    for (const time of [
      last.postedAt,
      Temporal.Instant.from(last.postedAt).add({ nanoseconds: 1 }).toString(),
      Temporal.Instant.from(last.postedAt).subtract({ nanoseconds: 1 }).toString(),
      "2026-10-31T12:00:00.123456001+09:00", "1969-12-31T23:59:59.999999999Z",
    ]) {
      for (const score of [last.score, last.score + 1, last.score - 1, -1]) {
        await compare("/feeds/friends-of-friends?" + new URLSearchParams({ beforeScore: String(score), beforePostedAt: time, beforeId: last.id }));
      }
    }
  });

  for (const [label, sql] of [
    ["本人が未投稿", "DELETE FROM posts WHERE id='own'"],
    ["本人の投稿が削除済み", "UPDATE posts SET deleted_at='2026-10-31' WHERE id='own'"],
    ["本人の現在枠なし", "UPDATE posting_windows SET ended_at='2026-11-01' WHERE id='asia'"],
    ["本人が退会", "UPDATE users SET status='deleted' WHERE id='viewer'"],
    ["地域移動で日付が変わる", "UPDATE users SET region='europe' WHERE id='viewer'"],
    ["地域移動でも同日なら閲覧可能", "UPDATE users SET region='america' WHERE id='viewer'"],
    ["別地域の終了済み同日投稿", "UPDATE posts SET posting_window_id='same-date-ended' WHERE id='own'"],
    ["候補作者の期間終了", "UPDATE posts SET posting_window_id='europe' WHERE id='outside-1'; UPDATE posting_windows SET ended_at='2026-11-02' WHERE id='europe'"],
    ["候補投稿削除", "UPDATE posts SET deleted_at='2026-10-31' WHERE id='outside-1'"],
    ["候補作者退会", "UPDATE users SET status='deleted' WHERE id='outsider-000001'"],
    ["友人の反応者退会", "UPDATE users SET status='deleted' WHERE id='z-friend-000001'"],
    ["双方向block", "INSERT INTO block_relations(id,blocker_id,blocked_id) VALUES ('new-out','viewer','outsider-000001'),('new-in','outsider-000004','viewer')"],
    ["友達解除", "DELETE FROM friendships WHERE id='friend-1'"],
    ["直接の友達になり推薦候補から外れる", "INSERT INTO friendships(id,user_low_id,user_high_id) VALUES ('new-friend','outsider-000001','viewer')"],
    ["全友達解除", "DELETE FROM friendships WHERE user_low_id='viewer' OR user_high_id='viewer'"],
    ["フォロー解除", "DELETE FROM follows WHERE followee_id='outsider-000001'"],
    ["反応削除・置換の解除", "UPDATE comments SET deleted_at='2026-10-31' WHERE id LIKE 'engage-%'; UPDATE realmojis SET deleted_at='2026-10-31' WHERE id='engage-same'; UPDATE realmojis SET replaced_at=NULL WHERE id='engage-replaced'"],
  ] as const) {
    await t.test(`${label}: 次リクエストの判定と順位に反映`, async () => {
      await richFixture();
      await local.admin.query(sql);
      await allPages("following");
      await allPages("friends-of-friends");
    });
  }

  await t.test("無関係な5000投稿があっても候補は最大51行", async () => {
    await fixture(local.admin, 12, 5000);
    await compare("/feeds/friends-of-friends");
    assert.ok(oldDB.queries.some((q) => q.rows > 5000));
    assert.equal(newDB.queries[0].rows, 51);
    await local.admin.query("DELETE FROM follows");
    await compare("/feeds/following");
    assert.ok(oldDB.queries.some((q) => q.rows > 5000));
    assert.equal(newDB.queries[0].rows, 0);
  });

  await t.test("未投稿の実行計画では友人グラフ・フォローを走査しない", async () => {
    await fixture(local.admin, 12, 5000);
    await local.admin.query("DELETE FROM posts WHERE id='own'");
    for (const feed of ["following", "friends-of-friends"]) {
      assert.deepEqual(await compare(`/feeds/${feed}`), { items: [], hasMore: false });
      const q = newDB.queries[0];
      const result = await local.db.select(`EXPLAIN (ANALYZE, BUFFERS, TIMING OFF, FORMAT JSON) ${q.sql}`, ...q.args);
      const visit = (node: any) => {
        if (["friendships", "follows"].includes(node["Relation Name"])) assert.equal(node["Actual Loops"], 0);
        for (const child of node.Plans ?? []) visit(child);
      };
      visit(result[0]["QUERY PLAN"][0].Plan);
    }
  });

  await t.test("generic planでも推薦点とページ境界を維持", async () => {
    await richFixture();
    await local.db.exec("SET plan_cache_mode = force_generic_plan");
    try {
      await allPages("following");
      await allPages("friends-of-friends");
    } finally { await local.db.exec("SET plan_cache_mode = auto"); }
  });

  await t.test("実際のsession・region middlewareを通し、失効と地域変更を反映", async () => {
    await richFixture();
    await local.admin.query("INSERT INTO login_sessions(id,user_id,token_hash) VALUES ('feed-session','viewer',$1)", [sha256Hex("feed-test-token")]);
    function authenticatedApp(region: string) {
      const app = new Hono<Env>().onError(apiErrorHandler);
      const context = { db: local.db, config: { region } } as HandlerContext;
      app.get("/feeds/:feed", sessionMiddleware(context, true), regionMiddleware(context), getFeedHandler(context));
      return app;
    }
    const asia = authenticatedApp("asia"), europe = authenticatedApp("europe");
    const headers = { Authorization: "Bearer feed-test-token" };
    for (const feed of ["following", "friends-of-friends"]) {
      assert.equal((await asia.request(`/feeds/${feed}`)).status, 401);
      const result = await asia.request(`/feeds/${feed}`, { headers });
      assert.equal(result.status, 200);
      assert.ok((await result.json()).items.length > 0);
      assert.equal((await europe.request(`/feeds/${feed}`, { headers })).status, 403);
    }
    await local.admin.query("UPDATE users SET region='europe' WHERE id='viewer'");
    assert.equal((await asia.request("/feeds/following", { headers })).status, 403);
    assert.deepEqual(await (await europe.request("/feeds/friends-of-friends", { headers })).json(), { items: [], hasMore: false });
    await local.admin.query("UPDATE posts SET posting_window_id='europe' WHERE id='own'");
    assert.ok((await (await europe.request("/feeds/friends-of-friends", { headers })).json()).items.length > 0);
    await local.admin.query("UPDATE login_sessions SET active=false WHERE id='feed-session'");
    assert.equal((await europe.request("/feeds/friends-of-friends", { headers })).status, 401);
  });

  for (const path of [
    "/feeds/following?beforeId=x", "/feeds/friends-of-friends?beforeScore=3",
    "/feeds/friends-of-friends?beforeScore=oops", "/feeds/friends-of-friends?beforeId=x&beforePostedAt=invalid&beforeScore=0",
  ]) {
    await t.test(`入力拒否を維持: ${path}`, async () => {
      const body = await compare(path);
      assert.ok(body.error);
      assert.equal(oldDB.queries.length, 0);
      assert.equal(newDB.queries.length, 0);
    });
  }
});
