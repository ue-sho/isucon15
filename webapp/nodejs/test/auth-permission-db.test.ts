import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { Hono } from "hono";
import jpeg from "jpeg-js";
import JSZip from "jszip";
import pg from "pg";
import { apiErrorHandler } from "../src/api_error.ts";
import { canComment } from "../src/comment.ts";
import { createCommentHandler, getCommentsHandler } from "../src/comment_api.ts";
import { DB, type Tx } from "../src/db.ts";
import { exportPostsHandler } from "../src/export_api.ts";
import { getFeedHandler } from "../src/feed_api.ts";
import { canView, getPostPermissions, loadViewerContext, type Post } from "../src/post.ts";
import { createPostHandler, getPostHandler, updatePostHandler } from "../src/post_api.ts";
import { replaceRealMojiHandler, getRealMojisHandler } from "../src/realmoji_api.ts";
import type { Env, HandlerContext } from "../src/server.ts";
import { createLoginSession, sessionMiddleware } from "../src/session.ts";
import { getMeHandler, loginHandler, logoutHandler, registerHandler, updateMeHandler } from "../src/user_api.ts";

const port = process.env.AUTH_PERMISSION_TEST_PG_PORT;
test("認証・権限・RETURNING / 新規ローカルPostgreSQL", { skip: !port, timeout: 60000 }, async (t) => {
  // 実サービスのenvは読まない。新規作成したテストDBのみ使用する。
  const connection = { host: "127.0.0.1", port: Number(port), user: "postgres" };
  const database = `auth_permission_${Date.now()}`;
  const admin = new pg.Client({ ...connection, database: "postgres" });
  await admin.connect();
  try { await admin.query(`CREATE DATABASE ${database}`); } finally { await admin.end(); }
  const control = new pg.Client({ ...connection, database });
  await control.connect();
  t.after(() => control.end());
  await control.query(await readFile(new URL("../../sql/001-schema.sql", import.meta.url), "utf8"));
  const config = { region: "asia", dbHost: "127.0.0.1", dbPort: port!, dbUser: "postgres", dbPassword: "", dbName: database, logLevel: "error" };
  const realDB = new DB(config, 4);
  t.after(() => realDB.end());
  const sqls: string[] = [];
  function observed<T extends object>(target: T): T {
    return new Proxy(target, { get(target, key) {
      const value = Reflect.get(target, key, target);
      if (typeof value !== "function") return value;
      return async (...args: unknown[]) => {
        if (["get", "select", "exec"].includes(String(key))) sqls.push(String(args[0]));
        const result = await value.apply(target, args);
        return key === "begin" ? observed(result as Tx) : result;
      };
    } });
  }
  const db = observed(realDB);
  const h = { db, config } as HandlerContext;
  const app = new Hono<Env>();
  app.onError(apiErrorHandler);
  app.post("/register", registerHandler(h));
  app.post("/login", loginHandler(h));
  app.use("*", sessionMiddleware(h, true));
  app.get("/me", getMeHandler(h));
  app.get("/export", exportPostsHandler(h));
  app.patch("/me", updateMeHandler(h));
  app.post("/logout", logoutHandler(h));
  app.post("/posts", createPostHandler(h));
  app.get("/posts/:postId", getPostHandler(h));
  app.patch("/posts/:postId", updatePostHandler(h));
  app.post("/posts/:postId/comments", createCommentHandler(h));
  app.get("/posts/:postId/comments", getCommentsHandler(h));
  app.post("/posts/:postId/realmojis", replaceRealMojiHandler(h));
  app.get("/posts/:postId/realmojis", getRealMojisHandler(h));
  app.get("/feeds/:feed", getFeedHandler(h));
  const request = (path: string, token: string, method = "GET", data?: unknown) => app.request(path, {
    method, headers: { Authorization: `Bearer ${token}`, ...(data ? { "Content-Type": "application/json", "Content-Length": String(Buffer.byteLength(JSON.stringify(data))) } : {}) },
    body: data ? JSON.stringify(data) : undefined,
  });
  const image = jpeg.encode({ data: Buffer.from([40, 80, 120, 255]), width: 1, height: 1 }, 80).data;
  async function upload(path: string, token: string, reaction = false) {
    const form = new FormData();
    form.set("image", new Blob([new Uint8Array(image)], { type: "image/jpeg" }), "photo.jpg");
    if (reaction) form.set("reactionType", "like");
    else { form.set("caption", "caption"); form.set("visibility", "public"); form.set("location_kind", "none"); }
    return app.request(path, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Transfer-Encoding": "chunked" }, body: form });
  }
  const tokens = new Map<string, string>();
  const secrets = new Map<string, string>();
  async function login(name: string) {
    const response = await request("/login", "", "POST", { username: name, secretKey: secrets.get(name) });
    assert.equal(response.status, 200, await response.clone().text());
    const body = await response.json();
    tokens.set(name, body.token);
    return body;
  }

  await t.test("登録RETURNING、ログインの重複ロック排除、認証情報再利用とsession置換/失効", async () => {
    for (const name of ["viewer", "author", "bridge"]) {
      sqls.length = 0;
      const response = await request("/register", "", "POST", { username: name, displayName: name, region: "asia" });
      assert.equal(response.status, 201, await response.clone().text());
      assert.equal(sqls.length, 1);
      const body = await response.json();
      secrets.set(name, body.secretKey);
      sqls.length = 0;
      await login(name);
      assert.equal(sqls.length, 2);
      assert.equal(sqls.filter((sql) => sql.includes("FOR NO KEY UPDATE")).length, 1);
    }
    const registrations = await Promise.all(Array.from({ length: 8 }, () =>
      request("/register", "", "POST", { username: "concurrent", displayName: "Concurrent", region: "asia" })));
    assert.equal(registrations.filter((response) => response.status === 201).length, 1);
    assert.equal(registrations.filter((response) => response.status === 409).length, 7);
    for (const response of registrations.filter((response) => response.status === 409)) {
      assert.equal((await response.json()).error, "username_taken");
    }
    assert.equal((await control.query("SELECT count(*)::int AS count FROM users WHERE username='concurrent'")).rows[0].count, 1);
    sqls.length = 0;
    assert.equal((await request("/me", tokens.get("viewer")!)).status, 200);
    assert.equal(sqls.length, 1);
    const old = tokens.get("viewer")!;
    await login("viewer");
    assert.equal((await request("/me", old)).status, 401);
    const token = tokens.get("viewer")!;
    const invalid = await request("/login", "", "POST", { username: "viewer", secretKey: "invalid" });
    assert.equal(invalid.status, 401);
    assert.equal((await request("/me", token)).status, 200);
    assert.equal((await request("/logout", token, "POST")).status, 204);
    assert.equal((await request("/me", token)).status, 401);
    const simultaneous = await Promise.all([0, 1].map(() => request("/login", "", "POST", { username: "viewer", secretKey: secrets.get("viewer") })));
    const concurrentTokens = await Promise.all(simultaneous.map(async (response) => {
      assert.equal(response.status, 200);
      return (await response.json()).token as string;
    }));
    assert.deepEqual((await Promise.all(concurrentTokens.map(async (token) => (await request("/me", token)).status))).sort(), [200, 401]);
    await login("viewer");
    // 汎用のsession作成経路にはactive行のロックが残っている。
    const id = (await control.query("SELECT id FROM users WHERE username='bridge'")).rows[0].id;
    sqls.length = 0;
    const session = await createLoginSession(db, id);
    assert.equal(sqls.filter((sql) => sql.includes("FOR NO KEY UPDATE")).length, 1);
    assert.equal((await request("/me", session.token)).status, 200);
  });

  const ids = new Map<string, string>();
  for (const name of ["viewer", "author", "bridge"]) ids.set(name, (await control.query("SELECT id FROM users WHERE username=$1", [name])).rows[0].id);
  await control.query(`INSERT INTO posting_windows(id,region,local_date,starts_at,on_time_deadline) VALUES
    ('asia','asia','2026-10-31',clock_timestamp()-interval '1 hour',clock_timestamp()+interval '1 hour'),
    ('europe','europe','2026-10-31',clock_timestamp()-interval '1 hour',clock_timestamp()+interval '1 hour'),
    ('america','america','2026-10-31',clock_timestamp()-interval '1 hour',clock_timestamp()+interval '1 hour')`);
  let targetID: string;
  await t.test("投稿INSERT、プロフィール/投稿の複数フィールドUPDATEをRETURNINGで返す", async () => {
    for (const name of ["viewer", "author"]) {
      sqls.length = 0;
      const response = await upload("/posts", tokens.get(name)!);
      assert.equal(response.status, 201, await response.clone().text());
      assert.equal(sqls.length, 6);
      const body = await response.json();
      assert.equal(body.caption, "caption");
      assert.equal(body.onTime, true);
      if (name === "author") targetID = body.id;
    }
    sqls.length = 0;
    const exported = await request("/export", tokens.get("viewer")!);
    assert.equal(exported.status, 200);
    assert.equal(sqls.length, 2);
    const zip = await JSZip.loadAsync(await exported.arrayBuffer());
    const exportedPosts = JSON.parse(await zip.file("posts.json")!.async("string"));
    assert.equal(exportedPosts.length, 1);
    assert.equal(exportedPosts[0].author.id, ids.get("viewer"));
    assert.deepEqual(await zip.file(exportedPosts[0].imagePath)!.async("nodebuffer"), Buffer.from(image));
    sqls.length = 0;
    let response = await request("/me", tokens.get("viewer")!, "PATCH", { displayName: "updated", bio: "", region: "europe" });
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal(sqls.length, 2);
    assert.equal((await response.json()).region, "europe");
    assert.equal((await (await request("/me", tokens.get("viewer")!)).json()).displayName, "updated");
    response = await request("/me", tokens.get("viewer")!, "PATCH", { region: "asia" });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).displayName, "updated");
    sqls.length = 0;
    response = await request(`/posts/${targetID}`, tokens.get("author")!, "PATCH", { caption: "", visibility: "friends_of_friends" });
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal(sqls.length, 6);
    const body = await response.json();
    assert.equal(body.caption, "");
    assert.equal(body.visibility, "friends_of_friends");
    assert.equal((await request(`/posts/${targetID}`, tokens.get("viewer")!, "PATCH", { caption: "invalid" })).status, 403);
  });

  await t.test("単一投稿の権限照会を従来の全グラフ判定と比較する", async () => {
    const viewerID = ids.get("viewer")!;
    const authorID = ids.get("author")!;
    const bridgeID = ids.get("bridge")!;
    const friend = async (a: string, b: string) => control.query("INSERT INTO friendships(id,user_low_id,user_high_id) VALUES(gen_random_uuid()::text,LEAST($1::text,$2::text),GREATEST($1::text,$2::text))", [a, b]);
    let cases = 0;
    for (const region of ["asia", "europe", "america"]) {
      await control.query("UPDATE users SET region=$1 WHERE id=$2", [region, viewerID]);
      for (const relationship of ["none", "friend", "fof", "both", "blocked", "reverse-blocked"]) {
        await control.query("DELETE FROM friendships");
        await control.query("DELETE FROM block_relations");
        if (relationship === "friend" || relationship === "both") await friend(viewerID, authorID);
        if (relationship === "fof" || relationship === "both") { await friend(viewerID, bridgeID); await friend(bridgeID, authorID); }
        if (relationship.includes("blocked")) await control.query("INSERT INTO block_relations(id,blocker_id,blocked_id) VALUES('block',$1,$2)", relationship === "blocked" ? [viewerID, authorID] : [authorID, viewerID]);
        for (const posted of [false, true]) {
          await control.query("UPDATE posts SET deleted_at=CASE WHEN $1 THEN NULL ELSE clock_timestamp() END WHERE author_id=$2", [posted, viewerID]);
          const reference = (await loadViewerContext(realDB, viewerID))!;
          for (const visibility of ["public", "friends", "friends_of_friends"]) {
            for (const ended of [false, true]) {
              for (const own of [false, true]) {
                const post: Post = { id: targetID!, authorID: own ? viewerID : authorID, postingWindowID: "asia", imageID: "image", caption: "", visibility,
                  location: { kind: "none", latitude: null, longitude: null, locality: null }, postedAt: Temporal.Now.instant(), onTimeDeadline: Temporal.Now.instant(), windowEndedAt: ended ? Temporal.Now.instant() : null };
                const view = canView(reference, post);
                const comment = view && !ended && (own ? reference.hasPostedToday : visibility === "public" || reference.friends.has(authorID));
                sqls.length = 0;
                assert.deepEqual(await getPostPermissions(db, viewerID, post), { view, comment }, `${region}/${relationship}/${posted}/${visibility}/${ended}/${own}`);
                assert.equal(sqls.length, 1);
                cases++;
              }
            }
          }
        }
      }
    }
    t.diagnostic(`${cases} permission cases match the previous implementation`);
    await control.query("UPDATE users SET region='asia' WHERE id=$1", [viewerID]);
    await control.query("UPDATE posts SET deleted_at=NULL WHERE author_id=$1", [viewerID]);
    await control.query("DELETE FROM block_relations");
    await control.query("DELETE FROM friendships");
  });

  await t.test("閲覧とコメント権限を区別し、関係/公開範囲変更を次のリクエストへ反映する", async () => {
    const a = ids.get("viewer")!, b = ids.get("author")!, bridge = ids.get("bridge")!;
    for (const [x, y] of [[a, bridge], [bridge, b]]) await control.query("INSERT INTO friendships(id,user_low_id,user_high_id) VALUES(gen_random_uuid()::text,LEAST($1::text,$2::text),GREATEST($1::text,$2::text))", [x, y]);
    sqls.length = 0;
    assert.equal((await request(`/posts/${targetID}`, tokens.get("viewer")!)).status, 200);
    assert.equal(sqls.length, 3);
    assert.equal(await canComment(realDB, a, targetID!), false);
    assert.equal((await request(`/posts/${targetID}/comments`, tokens.get("viewer")!, "POST", { body: "forbidden" })).status, 403);
    sqls.length = 0;
    let response = await upload(`/posts/${targetID}/realmojis`, tokens.get("viewer")!, true);
    assert.equal(response.status, 201, await response.clone().text());
    assert.equal(sqls.length, 10);
    assert.equal((await response.json()).reactor.id, a);
    await request(`/posts/${targetID}`, tokens.get("author")!, "PATCH", { visibility: "public" });
    sqls.length = 0;
    response = await request(`/posts/${targetID}/comments`, tokens.get("viewer")!, "POST", { body: "allowed" });
    assert.equal(response.status, 201, await response.clone().text());
    assert.equal(sqls.length, 8);
    assert.equal((await response.json()).body, "allowed");
    for (const kind of ["comments", "realmojis"]) {
      sqls.length = 0;
      response = await request(`/posts/${targetID}/${kind}`, tokens.get("viewer")!);
      assert.equal(response.status, 200, await response.clone().text());
      assert.equal(sqls.length, 4);
      assert.equal((await response.json()).items.length, 1);
    }
    // Authで取得したユーザーをフィードへ渡すのでユーザー再SELECTはない。
    sqls.length = 0;
    assert.equal((await request("/feeds/public", tokens.get("viewer")!)).status, 200);
    assert.equal(sqls.filter((sql) => /SELECT id, username, secret_key_hash/.test(sql)).length, 0);
    await request(`/posts/${targetID}`, tokens.get("author")!, "PATCH", { visibility: "friends" });
    assert.equal((await request(`/posts/${targetID}`, tokens.get("viewer")!)).status, 404);
    await control.query("INSERT INTO friendships(id,user_low_id,user_high_id) VALUES('direct',LEAST($1::text,$2::text),GREATEST($1::text,$2::text))", [a, b]);
    assert.equal((await request(`/posts/${targetID}`, tokens.get("viewer")!)).status, 200);
    await control.query("DELETE FROM friendships WHERE id='direct'");
    assert.equal((await request(`/posts/${targetID}`, tokens.get("viewer")!)).status, 404);
    await request(`/posts/${targetID}`, tokens.get("author")!, "PATCH", { visibility: "public" });
    await control.query("INSERT INTO block_relations(id,blocker_id,blocked_id) VALUES('block',$1,$2)", [b, a]);
    assert.equal((await request(`/posts/${targetID}`, tokens.get("viewer")!)).status, 404);
    await control.query("DELETE FROM block_relations");
    await control.query("UPDATE posting_windows SET ended_at=clock_timestamp() WHERE id='asia'");
    assert.equal((await request(`/posts/${targetID}`, tokens.get("author")!)).status, 200);
    assert.equal((await request(`/posts/${targetID}`, tokens.get("viewer")!)).status, 404);
    assert.equal((await request(`/posts/${targetID}/comments`, tokens.get("author")!, "POST", { body: "ended" })).status, 403);
    await control.query("UPDATE users SET status='deleted' WHERE id=$1", [b]);
    assert.equal((await request("/me", tokens.get("author")!)).status, 401);
    assert.equal((await request(`/posts/${targetID}`, tokens.get("viewer")!)).status, 404);
  });
});
