import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { Hono } from "hono";
import pg from "pg";
import { apiErrorHandler } from "../src/api_error.ts";
import { DB } from "../src/db.ts";
import { getFeedHandler } from "../src/feed_api.ts";
import { loadViewerContext } from "../src/post.ts";
import { getPostHandler } from "../src/post_api.ts";
import type { Env, HandlerContext } from "../src/server.ts";

// Explicit opt-in, localhost and an empty disposable database only.
const port = process.env.FEED_UNPOSTED_TEST_PORT;
test("unposted feeds with PostgreSQL", { skip: !port }, async (t) => {
  const config = {
    dbHost: "127.0.0.1", dbPort: port!, dbUser: "postgres", dbPassword: "",
    dbName: "isureal_feed_unposted_test", region: "asia", logLevel: "error",
  };
  const admin = new pg.Client({ host: config.dbHost, port: Number(port), user: config.dbUser, database: config.dbName });
  await admin.connect();
  t.after(() => admin.end());
  assert.equal((await admin.query("SELECT count(*) FROM pg_tables WHERE schemaname='public'")).rows[0].count, "0", "requires a fresh disposable database");
  await admin.query(await readFile(new URL("../../sql/001-schema.sql", import.meta.url), "utf8"));
  await admin.query(`
    INSERT INTO users(id,username,secret_key_hash,display_name,region)
    SELECT name,name,repeat('ab',32),name,'asia'
    FROM unnest(ARRAY['viewer','friend','fof','outsider','blocked']) name;
    INSERT INTO posting_windows(id,region,local_date,starts_at,on_time_deadline,ended_at) VALUES
      ('current','asia','2026-10-31','2026-10-31','2026-11-01',NULL),
      ('past','asia','2026-10-30','2026-10-30','2026-10-31','2026-10-31'),
      ('same-date-other-region','europe','2026-10-31','2026-10-31','2026-11-01','2026-11-01'),
      ('other-region','europe','2026-11-01','2026-11-01','2026-11-02',NULL);
    INSERT INTO posts(id,author_id,posting_window_id,image_id,visibility,location_kind,posted_at)
    SELECT name||'-post',name,'current',name||'-image',
      CASE WHEN name='fof' THEN 'friends_of_friends' ELSE 'public' END,'none','2026-10-31'
    FROM unnest(ARRAY['friend','fof','outsider','blocked']) name;
    INSERT INTO posts(id,author_id,posting_window_id,image_id,visibility,location_kind,posted_at)
    VALUES('own-past','viewer','past','own-image','public','none','2026-10-30');
    INSERT INTO friendships(id,user_low_id,user_high_id) VALUES
      ('friendship','friend','viewer'),('mutual','fof','friend'),('blocked-friendship','blocked','viewer');
    INSERT INTO block_relations(id,blocker_id,blocked_id) VALUES('block','viewer','blocked');
    INSERT INTO follows(id,follower_id,followee_id) VALUES('follow','viewer','friend');
  `);
  const db = new DB(config, 1);
  t.after(() => db.end());
  async function request(path: string, afterPosted?: () => Promise<unknown>) {
    const queries: string[] = [];
    const wrapped = {
      async get<T>(sql: string, ...args: unknown[]) {
        queries.push(sql);
        const result = await db.get<T>(sql, ...args);
        if (sql.includes("SELECT EXISTS")) await afterPosted?.();
        return result;
      },
      async select<T>(sql: string, ...args: unknown[]) {
        queries.push(sql);
        const result = await db.select<T>(sql, ...args);
        // friendsは投稿済み判定と候補取得を1 statementにまとめる。
        if (sql.includes("WITH active_windows AS MATERIALIZED")) await afterPosted?.();
        return result;
      },
    } as DB;
    const app = new Hono<Env>().onError(apiErrorHandler);
    app.use("*", async (c, next) => {
      c.set("session", { userID: "viewer", region: "asia", token: "", tokenHash: "", createdAt: Temporal.Instant.from("2026-10-31T00:00:00Z") });
      await next();
    });
    const context = { db: wrapped } as HandlerContext;
    app.get("/feeds/:feed", getFeedHandler(context));
    app.get("/posts/:postId", getPostHandler(context));
    const response = await app.request(path);
    return { status: response.status, body: await response.json(), queries };
  }
  async function createViewerPost(window = "current", deleted = false) {
    await admin.query(`INSERT INTO posts(id,author_id,posting_window_id,image_id,visibility,location_kind,posted_at,deleted_at)
      VALUES('own-new','viewer',$1,'own-new-image','public','none','2026-10-31',$2)`, [window, deleted ? "2026-10-31" : null]);
  }
  async function restore() {
    await admin.query("DELETE FROM posts WHERE id='own-new'");
    await admin.query("UPDATE users SET status='active',region='asia' WHERE id='viewer'");
    await admin.query("UPDATE posting_windows SET ended_at=NULL WHERE id='current'");
  }
  const feeds = ["friends", "friends-of-friends", "public", "following"];
  for (const feed of feeds) {
    await t.test(`${feed}: unposted response avoids relationship and candidate loading`, async () => {
      const result = await request(`/feeds/${feed}`);
      assert.equal(result.status, 200);
      assert.deepEqual(result.body, { items: [], hasMore: false });
      assert.equal(result.queries.length, feed === "friends" ? 1 : 2);
      if (feed === "friends") {
        assert.ok(result.queries[0].includes("WITH active_windows AS MATERIALIZED"));
      } else {
        assert.ok(result.queries[0].includes("FROM users"));
        assert.ok(result.queries[1].includes("SELECT EXISTS"));
      }
    });
  }
  for (const [label, change] of [
    ["deleted current post", () => createViewerPost("current", true)],
    ["no active window", () => admin.query("UPDATE posting_windows SET ended_at='2026-11-01' WHERE id='current'")],
    ["region changed to a different local date", async () => { await createViewerPost(); await admin.query("UPDATE users SET region='europe' WHERE id='viewer'"); }],
  ] as const) {
    await t.test(label, async () => {
      try {
        await change();
        const result = await request("/feeds/friends");
        assert.equal(result.status, 200);
        assert.deepEqual(result.body, { items: [], hasMore: false });
        assert.equal(result.queries.length, 1);
      } finally { await restore(); }
    });
  }
  await t.test("post committed after the empty decision is visible on the next request", async () => {
    try {
      const before = await request("/feeds/friends", () => createViewerPost());
      assert.deepEqual(before.body, { items: [], hasMore: false });
      assert.equal(before.queries.length, 1);
      const after = await request("/feeds/friends");
      assert.equal(after.status, 200);
      assert.deepEqual(after.body.items.map((item: { id: string }) => item.id), ["friend-post"]);
    } finally { await restore(); }
  });
  await t.test("same local date in a different region still unlocks the feed", async () => {
    try {
      await createViewerPost("same-date-other-region");
      const result = await request("/feeds/friends");
      assert.equal(result.status, 200);
      assert.deepEqual(result.body.items.map((item: { id: string }) => item.id), ["friend-post"]);
    } finally { await restore(); }
  });
  await t.test("posted feeds retain visibility, block, follow and recommendation results", async () => {
    try {
      await createViewerPost();
      const expected: Record<string, string[]> = {
        friends: ["friend-post"], "friends-of-friends": ["fof-post"],
        public: ["outsider-post", "friend-post"], following: ["friend-post"],
      };
      for (const feed of feeds) {
        const result = await request(`/feeds/${feed}`);
        assert.equal(result.status, 200);
        assert.deepEqual(result.body.items.map((item: { id: string }) => item.id), expected[feed]);
        assert.equal(result.body.hasMore, false);
        if (feed === "friends-of-friends") assert.equal(result.body.items[0].score, 3);
      }
    } finally { await restore(); }
  });
  await t.test("default viewer context and own old post remain available when unposted", async () => {
    const viewer = await loadViewerContext(db, "viewer");
    assert.equal(viewer?.hasPostedToday, false);
    assert.ok(viewer?.friends.has("friend"));
    assert.ok(viewer?.friendsOfFriends.has("fof"));
    assert.ok(viewer?.blocked.has("blocked"));
    const result = await request("/posts/own-past");
    assert.equal(result.status, 200);
    assert.equal(result.body.id, "own-past");
  });
  await t.test("public feed filters before limiting and pages without relationship loading", async () => {
    try {
      await createViewerPost();
      await admin.query(`
        INSERT INTO users(id,username,secret_key_hash,display_name,region)
        SELECT 'page-user-'||n,'page-user-'||n,repeat('ab',32),'page','asia' FROM generate_series(1,120) n;
        INSERT INTO posts(id,author_id,posting_window_id,image_id,visibility,location_kind,posted_at)
        SELECT 'page-post-'||lpad(n::text,3,'0'),'page-user-'||n,'current','page-image-'||n,
          CASE WHEN n>110 THEN 'friends' ELSE 'public' END,'none','2026-10-31'
        FROM generate_series(1,120) n;
        INSERT INTO block_relations(id,blocker_id,blocked_id) VALUES
          ('page-out','viewer','page-user-110'),('page-in','page-user-109','viewer');
        UPDATE users SET status='deleted' WHERE id='page-user-108';
        UPDATE posts SET deleted_at=now() WHERE id='page-post-107';
      `);
      const reference = await admin.query(`SELECT p.id FROM posts p
        JOIN users u ON u.id=p.author_id AND u.status='active'
        JOIN posting_windows w ON w.id=p.posting_window_id AND w.ended_at IS NULL
        WHERE p.author_id<>'viewer' AND p.deleted_at IS NULL AND p.visibility='public'
        AND NOT EXISTS(SELECT 1 FROM block_relations b
          WHERE (b.blocker_id='viewer' AND b.blocked_id=p.author_id)
             OR (b.blocked_id='viewer' AND b.blocker_id=p.author_id))
        ORDER BY p.posted_at DESC,p.id DESC`);
      const collected: string[] = [];
      let path = '/feeds/public';
      for (;;) {
        const result = await request(path);
        assert.equal(result.status, 200);
        assert.equal(result.queries.length, 3, 'user, posting check, bounded candidates only');
        assert.ok(result.queries[2].includes('LIMIT 51'));
        assert.ok(result.body.items.length <= 50);
        collected.push(...result.body.items.map((item: { id: string }) => item.id));
        if (!result.body.hasMore) break;
        const last = result.body.items.at(-1);
        path = `/feeds/public?beforeId=${last.id}&beforePostedAt=${encodeURIComponent(last.postedAt)}`;
      }
      assert.deepEqual(collected, reference.rows.map(row => row.id));
      // 関係の変更は次の要求へ即時反映する。
      await admin.query("INSERT INTO block_relations(id,blocker_id,blocked_id) VALUES('page-new','page-user-106','viewer')");
      const after = await request('/feeds/public');
      assert.ok(!after.body.items.some((item: { id: string }) => item.id === 'page-post-106'));
      for (const count of [0, 48, 49]) {
        await admin.query(`UPDATE posts SET deleted_at=CASE
          WHEN substring(author_id from 11)::int <= $1 THEN NULL ELSE now() END
          WHERE id LIKE 'page-post-%'`, [count]);
        const boundary = await request('/feeds/public');
        assert.equal(boundary.body.items.length, Math.min(count + 2, 50));
        assert.equal(boundary.body.hasMore, count + 2 > 50);
      }
    } finally {
      await admin.query("DELETE FROM block_relations WHERE id LIKE 'page-%'");
      await admin.query("DELETE FROM posts WHERE id LIKE 'page-%'");
      await admin.query("DELETE FROM users WHERE id LIKE 'page-%'");
      await restore();
    }
  });
  for (const path of ["/feeds/unknown", "/feeds/friends?beforeId=x", "/feeds/friends-of-friends?beforeScore=3", "/feeds/public?beforePostedAt=invalid&beforeId=x"]) {
    await t.test(`invalid request still fails before querying: ${path}`, async () => {
      const result = await request(path);
      assert.equal(result.status, 400);
      assert.equal(result.queries.length, 0);
    });
  }
  await t.test("inactive viewer retains the empty response", async () => {
    try {
      await admin.query("UPDATE users SET status='deleted' WHERE id='viewer'");
      const result = await request("/feeds/friends");
      assert.equal(result.status, 200);
      assert.deepEqual(result.body, { items: [], hasMore: false });
      assert.equal(result.queries.length, 1);
    } finally { await restore(); }
  });
});
