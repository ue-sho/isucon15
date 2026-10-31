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
