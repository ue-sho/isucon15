import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Hono, type Handler } from "hono";
import pg from "pg";
import { apiErrorHandler } from "../../src/api_error.ts";
import { DB } from "../../src/db.ts";
import type { Env, HandlerContext } from "../../src/server.ts";
import type { User } from "../../src/user.ts";

export const baseline = "60b1f560d2427edf401aa12c3a2f2b83df081ef4";
export const stamp = Temporal.Instant.from("2026-10-31T04:00:00Z");
const project = fileURLToPath(new URL("../..", import.meta.url));

// Gitに記録された変更前の全srcを読み出す。現在の実装から期待値を作らない。
export async function legacyFeed(reference = baseline) {
  const directory = await mkdtemp(join(tmpdir(), "isucon19-friends-reference-"));
  try {
    const archive = execFileSync("git", ["archive", reference, "webapp/nodejs/src"], { cwd: join(project, "../..") });
    execFileSync("tar", ["-x", "-C", directory], { input: archive });
    await symlink(join(project, "node_modules"), join(directory, "webapp/nodejs/node_modules"));
    const module = await import(pathToFileURL(join(directory, "webapp/nodejs/src/feed_api.ts")).href);
    const errors = await import(pathToFileURL(join(directory, "webapp/nodejs/src/api_error.ts")).href);
    return { handler: module.getFeedHandler as (h: HandlerContext) => Handler<Env>, errorHandler: errors.apiErrorHandler as typeof apiErrorHandler, close: () => rm(directory, { recursive: true }) };
  } catch (error) {
    await rm(directory, { recursive: true });
    throw error;
  }
}

export async function localDatabase(port: string, initialize = true) {
  assert.match(port, /^\d+$/);
  const config = { dbHost: "127.0.0.1", dbPort: port, dbUser: "postgres", dbPassword: "", dbName: "isureal_friends_feed_test", region: "asia", logLevel: "error" };
  const admin = new pg.Client({ host: config.dbHost, port: Number(port), user: config.dbUser, database: config.dbName });
  await admin.connect();
  try {
    if (initialize) {
      assert.equal((await admin.query("SELECT count(*) FROM pg_tables WHERE schemaname='public'")).rows[0].count, "0", "use a fresh disposable local database");
      await admin.query(await readFile(new URL("../../../sql/001-schema.sql", import.meta.url), "utf8"));
      await admin.query("CREATE TABLE friends_feed_test_marker (id boolean PRIMARY KEY CHECK (id))");
      await admin.query("INSERT INTO friends_feed_test_marker VALUES (true)");
    } else {
      assert.equal((await admin.query("SELECT id FROM friends_feed_test_marker")).rows[0]?.id, true);
    }
    const db = new DB(config, 1);
    return { admin, db, close: async () => { await db.end(); await admin.end(); } };
  } catch (error) { await admin.end(); throw error; }
}

export async function fixture(admin: pg.Client, friends = 110, unrelated = 0, history = 0, friendHistoryDays = 0) {
  await admin.query("TRUNCATE users, posting_windows CASCADE");
  await admin.query(`
    INSERT INTO users(id,username,secret_key_hash,display_name,region,profile_image_id,bio)
    SELECT id,id,md5(id)||md5(id),'名前 '||id,'asia','profile-'||id,repeat('b',80)
    FROM (
      SELECT 'viewer' AS id UNION ALL
      SELECT (CASE WHEN n%2=0 THEN 'a' ELSE 'z' END)||'-friend-'||lpad(n::text,6,'0') FROM generate_series(1,$1::int) n UNION ALL
      SELECT 'outsider-'||lpad(n::text,6,'0') FROM generate_series(1,$2::int) n UNION ALL
      SELECT unnest(ARRAY['fof','blocked-out','blocked-in','inactive','nonfriend'])
    ) users;
    `, [friends, unrelated]);
  await admin.query(`
    INSERT INTO posting_windows(id,region,local_date,starts_at,on_time_deadline,ended_at) VALUES
      ('asia','asia','2026-10-31','2026-10-31','2026-10-31 02:00:00.123450+00',NULL),
      ('europe','europe','2026-11-01','2026-10-31','2026-11-01',NULL),
      ('america','america','2026-10-31','2026-10-31','2026-11-01',NULL),
      ('past','asia','2026-10-30','2026-10-30','2026-10-31','2026-10-31'),
      ('same-date-ended','europe','2026-10-31','2026-10-31','2026-11-01','2026-11-01');
    INSERT INTO posts(id,author_id,posting_window_id,image_id,caption,visibility,location_kind,posted_at)
    VALUES('own','viewer','asia','own-image','自分','friends','none','2026-10-31');
  `);
  await admin.query(`
    INSERT INTO friendships(id,user_low_id,user_high_id)
    SELECT 'friend-'||n,LEAST('viewer',id),GREATEST('viewer',id)
    FROM (SELECT n,(CASE WHEN n%2=0 THEN 'a' ELSE 'z' END)||'-friend-'||lpad(n::text,6,'0') id FROM generate_series(1,$1::int) n) f;
    `, [friends]);
  await admin.query(`
    INSERT INTO posts(id,author_id,posting_window_id,image_id,caption,visibility,location_kind,latitude,longitude,locality,posted_at)
    SELECT 'p-'||lpad(n::text,6,'0'),id,CASE WHEN n%3=0 THEN 'europe' ELSE 'asia' END,'image-'||id,repeat('投稿',100),
      (ARRAY['friends','friends_of_friends','public'])[n%3+1],(ARRAY['none','exact','approximate'])[n%3+1],
      CASE WHEN n%3=1 THEN 35.123456 END,CASE WHEN n%3=1 THEN 139.987654 END,CASE WHEN n%3=2 THEN '東京' END,
      '2026-10-31 02:00:00.123456+00'::timestamptz - (n/3)*interval '1 microsecond'
    FROM (SELECT n,(CASE WHEN n%2=0 THEN 'a' ELSE 'z' END)||'-friend-'||lpad(n::text,6,'0') id FROM generate_series(1,$1::int) n) f;
    `, [friends]);
  await admin.query(`
    INSERT INTO posts(id,author_id,posting_window_id,image_id,caption,visibility,location_kind,posted_at)
    SELECT 'outside-'||n,'outsider-'||lpad(n::text,6,'0'),'asia','outside-image-'||n,repeat('候補',100),'public','none','2026-10-31 03:00:00+00'
    FROM generate_series(1,$1::int) n;
    `, [unrelated]);
  await admin.query(`
    INSERT INTO posts(id,author_id,posting_window_id,image_id,visibility,location_kind,posted_at)
    SELECT id||'-post',id,'asia',id||'-image','friends_of_friends','none','2026-10-31 03:00:00+00'
    FROM unnest(ARRAY['fof','blocked-out','blocked-in','inactive','nonfriend']) id;
    INSERT INTO friendships(id,user_low_id,user_high_id) VALUES
      ('block-out','blocked-out','viewer'),('block-in','blocked-in','viewer'),('inactive','inactive','viewer');
    INSERT INTO block_relations(id,blocker_id,blocked_id) VALUES
      ('out','viewer','blocked-out'),('in','blocked-in','viewer');
    UPDATE users SET status='deleted' WHERE id='inactive';
  `);
  if (friends > 0) {
    await admin.query(`
      INSERT INTO friendships(id,user_low_id,user_high_id) VALUES ('mutual','fof','z-friend-000001');
      INSERT INTO follows(id,follower_id,followee_id) VALUES ('follow','viewer','z-friend-000001');
      INSERT INTO comments(id,post_id,author_id,body,created_at) VALUES ('comment','fof-post','z-friend-000001','hello','2026-10-31');
      INSERT INTO realmojis(id,post_id,reactor_id,image_id,reaction_type,created_at) VALUES ('reaction','fof-post','z-friend-000001','reaction-image','like','2026-10-31');
    `);
    await admin.query(`
      INSERT INTO friendships(id,user_low_id,user_high_id)
      SELECT 'graph-'||n,LEAST(f,o),GREATEST(f,o)
      FROM (SELECT n,(CASE WHEN (n%$1::int+1)%2=0 THEN 'a' ELSE 'z' END)||'-friend-'||lpad((n%$1::int+1)::text,6,'0') f,
        'outsider-'||lpad(n::text,6,'0') o FROM generate_series(1,LEAST($2::int,5000)) n) edges;
    `, [friends, unrelated]);
  }
  const historyDays = Math.max(Math.ceil(history / Math.max(unrelated, 1)), friendHistoryDays);
  if (historyDays > 0) {
    await admin.query(`
      INSERT INTO posting_windows(id,region,local_date,starts_at,on_time_deadline,ended_at)
      SELECT 'hist-'||n,'asia','2026-10-30'::date-n,'2026-10-30'::date-n,'2026-10-30'::date-n+1,'2026-10-30'::date-n+1
      FROM generate_series(1,$1::int) n
    `, [historyDays]);
  }
  if (history > 0) {
    assert.ok(unrelated > 0);
    await admin.query(`
      INSERT INTO posts(id,author_id,posting_window_id,image_id,visibility,location_kind,posted_at)
      SELECT 'history-'||n,'outsider-'||lpad(((n-1)%$2::int+1)::text,6,'0'),'hist-'||((n-1)/$2::int+1),'old-image-'||n,'public','none','2026-10-30'::date-((n-1)/$2::int+1)
      FROM generate_series(1,$1::int) n
    `, [history, unrelated]);
  }
  if (friendHistoryDays > 0) {
    await admin.query(`
      INSERT INTO posts(id,author_id,posting_window_id,image_id,visibility,location_kind,posted_at)
      SELECT 'fh-'||n||'-'||day,(CASE WHEN n%2=0 THEN 'a' ELSE 'z' END)||'-friend-'||lpad(n::text,6,'0'),
        'hist-'||day,'fh-image-'||n||'-'||day,'public','none','2026-10-30'::date-day
      FROM generate_series(1,$1::int) n CROSS JOIN generate_series(1,$2::int) day
    `, [friends, friendHistoryDays]);
  }
  await admin.query("ANALYZE");
}

export function appFor(handler: (h: HandlerContext) => Handler<Env>, db: DB, userID = "viewer", errorHandler = apiErrorHandler, user?: User) {
  const app = new Hono<Env>().onError(errorHandler);
  app.use("*", async (c, next) => {
    // Userを渡さない比較試験では古いsession.regionからDBの現在地域を読むことも検証する。
    c.set("session", { userID, region: "asia", token: "", tokenHash: "", createdAt: stamp, ...(user ? { user } : {}) });
    await next();
  });
  app.get("/feeds/:feed", handler({ db } as HandlerContext));
  return app;
}

export type QueryRecord = { sql: string; args: unknown[]; rows: number };
export function tracked(db: DB) {
  const queries: QueryRecord[] = [];
  const wrapped = {
    async get<T>(sql: string, ...args: unknown[]) {
      const row = await db.get<T>(sql, ...args);
      queries.push({ sql, args, rows: row === undefined ? 0 : 1 });
      return row;
    },
    async select<T>(sql: string, ...args: unknown[]) {
      const rows = await db.select<T>(sql, ...args);
      queries.push({ sql, args, rows: rows.length });
      return rows;
    },
  } as DB;
  return { db: wrapped, queries };
}
