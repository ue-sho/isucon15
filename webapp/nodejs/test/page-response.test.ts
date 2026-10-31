import assert from "node:assert/strict";
import crypto from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import { test } from "node:test";
import { Hono } from "hono";
import { apiErrorHandler } from "../src/api_error.ts";
import { getCommentsHandler } from "../src/comment_api.ts";
import type { Row } from "../src/db.ts";
import { getFeedHandler } from "../src/feed_api.ts";
import { getMemoriesHandler, getMemoriesByDateHandler } from "../src/memory_api.ts";
import { getRealMojisHandler } from "../src/realmoji_api.ts";
import { getRelationshipsHandler } from "../src/relationship_list_api.ts";
import type { Env, HandlerContext } from "../src/server.ts";

const stamp = Temporal.Instant.from("2026-10-31T02:00:00Z");
const secret = "ab".repeat(32);
function user(id: string, prefix = ""): Row {
  return Object.fromEntries(Object.entries({ id, username: id, secret_key_hash: secret, display_name: id, bio: "bio", profile_image_id: `profile-${id}`, region: "asia", account_type: "normal", status: "active" }).map(([k, v]) => [prefix + k, v]));
}
function post(id: string, author = "author"): Row {
  return { id, author_id: author, posting_window_id: "window", image_id: `image-${id}`, caption: id, visibility: "public", location_kind: "none", latitude: null, longitude: null, locality: null, posted_at: stamp, on_time_deadline: stamp, window_ended_at: null, ...user(author, "author.") };
}

type Kind = "memories" | "date" | "comments" | "realmojis" | "relationships" | "feed" | "ranked";
function setup(kind: Kind, count: number, filtered = false) {
  const records = Array.from({ length: count }, (_, i) => {
    const id = String(999 - i).padStart(3, "0");
    if (kind === "comments") return { id, post_id: "post", author_id: "author", body: id, created_at: stamp, deleted_at: null, ...user("author", "author.") };
    if (kind === "realmojis") return { id, post_id: "post", reactor_id: "author", image_id: `image-${id}`, reaction_type: "like", created_at: stamp, replaced_at: null, deleted_at: null, ...user("author", "reactor.") };
    if (kind === "relationships") return { id, updated_at: stamp, ...user("author", "user.") };
    return post(id);
  });
  if (kind === "comments") records.reverse();
  const queries: { sql: string; args: unknown[] }[] = [];
  const db = {
    get: async (sql: string) => {
      if (sql.includes("AS has_posted")) return { has_posted: true, blocked: false, friend: false, friend_of_friend: false };
      if (sql.includes("FROM users")) return user("viewer");
      if (sql.includes("SELECT EXISTS")) return { exists: true };
      throw new Error(`unexpected get: ${sql}`);
    },
    select: async (sql: string, ...args: unknown[]) => {
      queries.push({ sql, args });
      if (kind === "ranked" && sql.includes("AS recommendation_score")) {
        // 推薦の絞込み・順位・cursorはSQL側で適用済み。実SQLはPG比較試験で検証する。
        return records.filter((row) => !args[3] || row.id < String(args[3]))
          .slice(0, 51).map((row) => ({ ...row, recommendation_score: 3 }));
      }
      // 投稿候補SQL内のNOT EXISTSもblock_relationsを参照する。
      // 関係だけを取得するSQLと区別し、投稿候補を空配列に置き換えない。
      if (sql.includes("FROM block_relations") && !sql.includes("FROM posts p")) return [];
      if (sql.includes("FROM friendships") && !sql.includes("FROM (")) {
        if (kind !== "ranked") return [];
        return [{ user_low_id: "friend", user_high_id: args[0] === "viewer" ? "viewer" : "author" }];
      }
      if (kind === "ranked" && sql.includes("UNION")) return [];
      // 閲覧権限の対象投稿。本人の公開中投稿なのでコメントも閲覧可能。
      if (sql.includes("p.id = $1")) return [post("post", "viewer")];
      if ((kind === "memories" || kind === "date") && (sql.includes("FROM realmojis") || sql.includes("FROM comments"))) {
        assert.ok(args.length > 0 && args.length <= 50);
        return [];
      }
      let cursor: unknown;
      if (kind === "memories" || kind === "date") cursor = args[4];
      else cursor = args[2];
      let selected = records.filter((row) => !cursor || (kind === "comments" ? row.id > String(cursor) : row.id < String(cursor)));
      if ((kind === "feed" || kind === "ranked") && filtered) {
        // 可視性で落ちる候補はhasMoreに数えない。
        selected = [...selected.slice(0, 25), { ...post("hidden"), visibility: "friends" }, ...selected.slice(25)];
      }
      return selected.slice(0, kind === "feed" || kind === "ranked" ? undefined : 51);
    },
  };
  const context = { db } as unknown as HandlerContext;
  const app = new Hono<Env>();
  app.onError(apiErrorHandler);
  app.use("*", async (c, next) => {
    c.set("session", { userID: "viewer", region: "asia", token: "", tokenHash: "", createdAt: stamp });
    await next();
  });
  app.get("/memories", getMemoriesHandler(context));
  app.get("/date/:date", getMemoriesByDateHandler(context));
  app.get("/comments/:postId", getCommentsHandler(context));
  app.get("/realmojis/:postId", getRealMojisHandler(context));
  app.get("/relationships/:kind", getRelationshipsHandler(context));
  app.get("/feeds/:feed", getFeedHandler(context));
  const path = { memories: "/memories?month=2026-10", date: "/date/2026-10-31", comments: "/comments/post", realmojis: "/realmojis/post", relationships: "/relationships/friends", feed: "/feeds/public", ranked: "/feeds/friends-of-friends" }[kind];
  return { app, path, records, queries };
}

for (const kind of ["memories", "date", "comments", "realmojis", "relationships", "feed", "ranked"] as const) {
  for (const count of [0, 49, 50, 51]) {
    test(`${kind}: ${count}件の本文・順序・hasMoreと署名回数`, async (t) => {
      // この試験は51件目の生成省略を検証する。署名LRUの命中は別試験で確認する。
      // TemporalのURL期限は変えず、LRUへの格納判定だけを対象外にする。
      const future = Date.now() + 48 * 60 * 60 * 1000;
      t.mock.method(Date, "now", () => future);
      const { app, path, records } = setup(kind, count, kind === "feed" || kind === "ranked");
      const realCreateHmac = crypto.createHmac;
      const realHash = crypto.hash;
      let calls = 0;
      crypto.hash = ((...args: Parameters<typeof crypto.hash>) => {
        calls += 0.5;
        return realHash(...args);
      }) as typeof crypto.hash;
      syncBuiltinESMExports();
      try {
        const response = await app.request(path);
        assert.equal(response.status, 200);
        const body = await response.json();
        const returned = Math.min(count, 50);
        assert.equal(body.hasMore, count > 50);
        assert.deepEqual(body.items.map((item: any) => item.id ?? item.relationId), records.slice(0, 50).map((row) => row.id));
        const signaturesPerItem = ["comments", "relationships"].includes(kind) ? 1 : 2;
        assert.equal(calls, returned * signaturesPerItem * 1000);
        if (returned) {
          const item = body.items[0];
          const profile = item.author?.profileImageUrl ?? item.reactor?.profileImageUrl ?? item.user?.profileImageUrl;
          const url = new URL(profile, "http://test");
          let value = Buffer.from(`${url.searchParams.get("exp")}:profile-author`);
          for (let i = 0; i < 1000; i++) value = realCreateHmac("sha256", Buffer.from(secret, "hex")).update(value).digest();
          assert.equal(url.searchParams.get("sig"), value.toString("base64url"));
          if (kind === "comments") assert.equal(item.body, records[0].body);
          if (kind === "ranked") assert.equal(item.score, 3);
          if (kind === "memories" || kind === "date") {
            assert.deepEqual(item.comments, []);
            assert.deepEqual(item.realmojis, []);
          }
        }
      } finally {
        crypto.hash = realHash;
        syncBuiltinESMExports();
      }
    });
  }

  test(`${kind}: 同時刻のidカーソルで次ページの1件を返す`, async () => {
    const { app, path, records, queries } = setup(kind, 51);
    const field = kind === "comments" ? "afterCreatedAt" : kind === "relationships" ? "beforeUpdatedAt" : kind === "realmojis" ? "beforeCreatedAt" : "beforePostedAt";
    const idField = kind === "comments" ? "afterId" : "beforeId";
    const response = await app.request(`${path}${path.includes("?") ? "&" : "?"}${field}=${stamp.toString()}&${idField}=${records[49].id}${kind === "ranked" ? "&beforeScore=3" : ""}`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.hasMore, false);
    assert.deepEqual(body.items.map((item: any) => item.id ?? item.relationId), [records[50].id]);
    if (kind !== "ranked") assert.ok(queries.some(({ args }) => args.some((arg) => arg instanceof Temporal.Instant && arg.equals(stamp)) && args.includes(records[49].id)));
  });
}
