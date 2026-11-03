import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { after, before, test } from "node:test";
import pg from "pg";
import { DB, type Tx } from "../../src/db.ts";
import { beginRelationshipTx } from "../../src/relationship.ts";
import { canComment } from "../../src/comment.ts";
import { canViewPost } from "../../src/post.ts";
import { beginCandidate, GRAPH, PAIR, hash, pairKey, pairLocks, sortedKeys, type Pair } from "./prototype.ts";

const port = process.env.PAIR_LAB_PORT ?? "";
assert.match(port, /^\d+$/);
assert.match(process.env.PAIR_LAB_TOKEN ?? "", /^[a-f0-9-]{36}$/);
const config = { dbHost: "127.0.0.1", dbPort: port, dbUser: "postgres", dbPassword: "", dbName: "pair_lock_lab", region: "asia", logLevel: "error" };
const observer = new DB(config, 1);
const clients = [new DB(config, 1), new DB(config, 1), new DB(config, 1)];
const pids: number[] = [];
const live = new Set<Tx>();
const inflight = new Set<Promise<Tx>>();
type Mode = "current" | "candidate";
async function track(promise: Promise<Tx>): Promise<Tx> {
  inflight.add(promise);
  try { const tx = await promise; live.add(tx); return tx; }
  finally { inflight.delete(promise); }
}
function watch<T>(promise: Promise<T>) {
  const state = { done: false, result: Promise.resolve({}) as Promise<{ value?: T; error?: unknown }> };
  state.result = promise.then(value => { state.done = true; return { value }; }, error => { state.done = true; return { error }; });
  return state;
}
async function value<T>(state: ReturnType<typeof watch<T>>): Promise<T> {
  const result = await state.result;
  if (result.error) throw result.error;
  return result.value!;
}
async function begin(mode: Mode, client: number, pair: Pair, graph: "shared" | "exclusive" = "shared") {
  return track(mode === "current" ? beginRelationshipTx(clients[client]!, ...pair)
    : beginCandidate(clients[client]!, [pair], { graph }));
}
async function cleanup() {
  await Promise.all([...live].map(tx => tx.rollback()));
  await Promise.allSettled([...inflight]);
  await Promise.all([...live].map(tx => tx.rollback()));
  live.clear();
}
async function reset() {
  await cleanup();
  await observer.exec("TRUNCATE users, posting_windows CASCADE");
  await observer.exec(`INSERT INTO users(id, username, secret_key_hash, display_name, region, account_type)
    SELECT x,x,md5(x)||md5(x),x,'asia','certified_public' FROM unnest(ARRAY['A','B','C','D']) x`);
  await observer.exec(`INSERT INTO posting_windows(id,region,local_date,starts_at,on_time_deadline)
    VALUES('w','asia','2026-01-01','2026-01-01','2026-01-02')`);
  await observer.exec(`INSERT INTO posts(id,author_id,posting_window_id,image_id,visibility,location_kind,posted_at)
    SELECT 'p'||id,id,'w','image'||id,'public','none','2026-01-01' FROM users`);
}
async function expectWait(waiter: number, blocker: number, state: { done: boolean }) {
  const started = performance.now();
  while (performance.now() - started < 4000) {
    const row = await observer.get<{ blocked: boolean; wait_event_type: string }>(
      "SELECT $2::int = ANY(pg_blocking_pids(pid)) AS blocked, wait_event_type FROM pg_stat_activity WHERE pid=$1", pids[waiter], pids[blocker]);
    if (row?.blocked && row.wait_event_type === "Lock") return;
    assert.equal(state.done, false, "contender finished before an actual Lock wait was observed");
    await delay(5); // Poll the lock manager; elapsed time is not the assertion.
  }
  assert.fail("expected blocker/waiter edge was not observed");
}
async function assertNoLocks() {
  const row = await observer.get<{ n: number }>(`SELECT count(*) AS n FROM pg_locks
    WHERE pid=ANY($1::int[]) AND locktype='advisory'`, pids);
  assert.equal(row?.n, 0);
}
async function friendship(tx: Tx | DB, a = "A", b = "B") {
  await tx.exec("INSERT INTO friendships(id,user_low_id,user_high_id) VALUES($1,LEAST($2::text,$3::text),GREATEST($2::text,$3::text))", randomUUID(), a, b);
}
async function request(tx: Tx | DB, a = "A", b = "B") {
  await tx.exec("INSERT INTO friend_requests(id,requester_id,recipient_id,status,created_at,updated_at) VALUES($1,$2,$3,'pending',clock_timestamp(),clock_timestamp())", randomUUID(), a, b);
}
async function isBlocked(tx: Tx, a = "A", b = "B") {
  return (await tx.get<{ yes: boolean }>("SELECT EXISTS(SELECT 1 FROM block_relations WHERE (blocker_id=$1 AND blocked_id=$2) OR (blocker_id=$2 AND blocked_id=$1)) AS yes", a, b))!.yes;
}
async function block(tx: Tx) {
  await tx.exec("INSERT INTO block_relations(id,blocker_id,blocked_id) VALUES($1,'A','B')", randomUUID());
  await tx.exec("DELETE FROM friendships WHERE user_low_id='A' AND user_high_id='B'");
  await tx.exec("DELETE FROM follows WHERE (follower_id='A' AND followee_id='B') OR (follower_id='B' AND followee_id='A')");
  await tx.exec("UPDATE friend_requests SET status='cancelled' WHERE status='pending' AND ((requester_id='A' AND recipient_id='B') OR (requester_id='B' AND recipient_id='A'))");
}
type Action = "accept" | "request" | "follow" | "comment" | "realmoji";
async function action(tx: Tx, kind: Action) {
  if (kind === "comment" || kind === "realmoji") {
    const allowed = await (kind === "comment" ? canComment(tx, "B", "pA") : canViewPost(tx, "B", "pA"));
    if (!allowed) return false;
    if (kind === "comment") await tx.exec("INSERT INTO comments(id,post_id,author_id,body,created_at) VALUES($1,'pA','B','synthetic',clock_timestamp())", randomUUID());
    else {
      await tx.exec("UPDATE realmojis SET replaced_at=clock_timestamp() WHERE post_id='pA' AND reactor_id='B' AND replaced_at IS NULL AND deleted_at IS NULL");
      await tx.exec("INSERT INTO realmojis(id,post_id,reactor_id,image_id,reaction_type,created_at) VALUES($1,'pA','B','synthetic','like',clock_timestamp())", randomUUID());
    }
  } else {
    if (await isBlocked(tx)) return false;
    if (kind === "accept") {
      const row = await tx.get("SELECT id FROM friend_requests WHERE requester_id='A' AND recipient_id='B' AND status='pending'");
      if (!row) return false;
      await friendship(tx);
      await tx.exec("UPDATE friend_requests SET status='accepted' WHERE id=$1", row.id);
    } else if (kind === "request") await request(tx);
    else await tx.exec("INSERT INTO follows(id,follower_id,followee_id) VALUES($1,'B','A')", randomUUID());
  }
  return true;
}

before(async () => {
  assert.equal((await observer.get("SELECT token FROM pair_lock_lab_marker"))?.token, process.env.PAIR_LAB_TOKEN);
  assert.equal((await observer.get("SELECT count(*) AS n FROM pg_tables WHERE schemaname='public'"))?.n, 1);
  const bootstrap = new pg.Client({ host: "127.0.0.1", port: Number(port), user: "postgres", database: "pair_lock_lab" });
  await bootstrap.connect();
  try { await bootstrap.query(await readFile(new URL("../../../sql/001-schema.sql", import.meta.url), "utf8")); }
  finally { await bootstrap.end(); }
  assert.match((await observer.get("SHOW server_version"))!.server_version, /^16\./);
  console.log(`PostgreSQL=${(await observer.get("SHOW server_version"))!.server_version}; isolation=${(await observer.get("SHOW transaction_isolation"))!.transaction_isolation}`);
  for (const db of clients) pids.push((await db.get("SELECT pg_backend_pid() AS pid"))!.pid);
});
after(async () => { await cleanup(); await Promise.all([...clients, observer].map(db => db.end())); });

test("current/candidate lock and state matrix (synthetic data, no HTTP score claim)", async t => {
  for (const mode of ["current", "candidate"] as const) {
    for (const reverse of [false, true]) {
      await t.test(`${mode}: A-B / A-C ${reverse ? "AC first" : "AB first"}`, async () => {
        await reset();
        const first: Pair = ["A", reverse ? "C" : "B"];
        const second: Pair = ["A", reverse ? "B" : "C"];
        const one = await begin(mode, 0, first);
        const twoPending = watch(begin(mode, 1, second));
        if (mode === "current") {
          await expectWait(1, 0, twoPending);
          await friendship(one, ...first); await one.commit();
        }
        const two = await value(twoPending);
        await friendship(two, ...second); await two.commit();
        if (mode === "candidate") { await friendship(one, ...first); await one.commit(); }
        assert.equal((await observer.get("SELECT count(*) AS n FROM friendships"))!.n, 2);
      });
      await t.test(`${mode}: A-B / B-A ${reverse ? "BA first" : "AB first"}`, async () => {
        await reset();
        const first: Pair = reverse ? ["B", "A"] : ["A", "B"];
        const one = await begin(mode, 0, first);
        await request(one, ...first);
        const twoPending = watch(begin(mode, 1, [first[1], first[0]]));
        await expectWait(1, 0, twoPending);
        await one.commit();
        const two = await value(twoPending);
        const pending = await two.get("SELECT id FROM friend_requests WHERE status='pending'");
        assert.ok(pending);
        await two.exec("UPDATE friend_requests SET status='accepted' WHERE id=$1", pending.id);
        await friendship(two); await two.commit();
        assert.equal((await observer.get("SELECT count(*) AS n FROM friendships"))!.n, 1);
        assert.equal((await observer.get("SELECT count(*) AS n FROM friend_requests WHERE status='pending'"))!.n, 0);
      });
    }
    for (const kind of ["accept", "request", "follow", "comment", "realmoji"] as const) {
      for (const blockFirst of [true, false]) {
        await t.test(`${mode}: block vs ${kind}, ${blockFirst ? "block" : kind} first`, async () => {
          await reset();
          if (kind === "accept") await request(observer);
          const startAction = (i: number) => begin(mode, i, ["B", "A"], kind === "realmoji" ? "exclusive" : "shared");
          const one = await (blockFirst ? begin(mode, 0, ["A", "B"]) : startAction(0));
          if (blockFirst) await block(one); else assert.equal(await action(one, kind), true);
          const pending = watch(blockFirst ? startAction(1) : begin(mode, 1, ["A", "B"]));
          await expectWait(1, 0, pending); await one.commit();
          const two = await value(pending);
          if (blockFirst) assert.equal(await action(two, kind), false); else await block(two);
          await two.commit();
          for (const table of ["friendships", "follows"]) assert.equal((await observer.get(`SELECT count(*) AS n FROM ${table}`))!.n, 0);
          assert.equal((await observer.get("SELECT count(*) AS n FROM friend_requests WHERE status='pending'"))!.n, 0);
          if (kind === "comment" || kind === "realmoji") {
            const table = kind === "comment" ? "comments" : "realmojis";
            // block does not delete earlier interactions; subsequent reads deny access.
            assert.equal((await observer.get(`SELECT count(*) AS n FROM ${table}`))!.n, blockFirst ? 0 : 1);
            assert.equal(await canViewPost(observer, "B", "pA"), false);
          }
        });
      }
    }
    for (const mutation of ["retire", "profile", "delete-post", "delete-own-post", "visibility"] as const) {
      for (const mutationFirst of [true, false]) {
        await t.test(`${mode}: ${mutation} vs ${mutation === "retire" ? "relation" : "interaction"}, ${mutationFirst ? "mutation" : "operation"} first`, async () => {
          await reset();
          const mutate = async (i: number) => {
            const tx = await track(clients[i]!.begin());
            if (mutation === "retire" || mutation === "profile") await tx.exec("SELECT pg_advisory_xact_lock_shared(20261031,1)");
            const id = mutation === "delete-own-post" ? "B" : "A";
            await tx.get("SELECT id FROM users WHERE id=$1 FOR NO KEY UPDATE", id);
            if (mutation === "retire") await tx.exec("UPDATE users SET status='deleted' WHERE id='A'");
            else if (mutation === "profile") await tx.exec("UPDATE users SET region='europe',display_name='changed' WHERE id='A'");
            else if (mutation === "visibility") await tx.exec("UPDATE posts SET visibility='friends' WHERE id='pA'");
            else await tx.exec("UPDATE posts SET deleted_at=clock_timestamp() WHERE author_id=$1", id);
            return tx;
          };
          const operate = (i: number) => begin(mode, i, ["A", "B"]);
          const one = await (mutationFirst ? mutate(0) : operate(0));
          if (!mutationFirst) {
            if (mutation === "retire") await friendship(one); else assert.equal(await action(one, "comment"), true);
          }
          const pending = watch(mutationFirst ? operate(1) : mutate(1));
          await expectWait(1, 0, pending); await one.commit();
          if (mutationFirst && mutation === "retire") {
            assert.ok((await pending.result).error, "active user must be rechecked after wait");
            assert.equal((await observer.get("SELECT count(*) AS n FROM friendships"))!.n, 0);
          } else {
            const two = await value(pending);
            if (mutationFirst) assert.equal(await action(two, "comment"), mutation === "profile");
            await two.commit();
          }
          // Existing retirement is soft deletion; pre-existing relationships remain stored.
          if (!mutationFirst && mutation === "retire") assert.equal((await observer.get("SELECT count(*) AS n FROM friendships"))!.n, 1);
        });
      }
    }
  }
});

test("terminal transitions, removal, unblock and replacement", async t => {
  for (const mode of ["current", "candidate"] as const) {
    for (const kind of ["reject", "cancel", "unfriend", "unfollow", "unblock", "replace"] as const) {
      for (const changeFirst of [true, false]) {
        await t.test(`${mode}: ${kind}, change first=${changeFirst}`, async () => {
          await reset();
          if (kind === "reject" || kind === "cancel") await request(observer);
          if (kind === "unfriend") {
            await friendship(observer);
            await observer.exec("UPDATE posts SET visibility='friends' WHERE id='pA'");
          }
          if (kind === "unfollow") await observer.exec("INSERT INTO follows(id,follower_id,followee_id) VALUES('follow','B','A')");
          if (kind === "unblock") await observer.exec("INSERT INTO block_relations(id,blocker_id,blocked_id) VALUES('block','A','B')");
          const change = async (tx: Tx) => {
            if (kind === "reject" || kind === "cancel") {
              return await tx.exec("UPDATE friend_requests SET status=$1 WHERE requester_id='A' AND recipient_id='B' AND status='pending'", kind === "reject" ? "rejected" : "cancelled") > 0;
            }
            if (kind === "unfriend") return await tx.exec("DELETE FROM friendships WHERE user_low_id='A' AND user_high_id='B'") > 0;
            if (kind === "unfollow") return await tx.exec("DELETE FROM follows WHERE follower_id='B' AND followee_id='A'") > 0;
            if (kind === "unblock") return await tx.exec("DELETE FROM block_relations WHERE blocker_id='A' AND blocked_id='B'") > 0;
            return action(tx, "realmoji");
          };
          const other = async (tx: Tx) => {
            if (kind === "reject" || kind === "cancel") return action(tx, "accept");
            if (kind === "unfriend") return action(tx, "comment");
            if (kind === "unfollow") { await block(tx); return true; }
            if (kind === "unblock") return action(tx, "follow");
            return action(tx, "realmoji");
          };
          const one = await begin(mode, 0, ["A", "B"], kind === "replace" ? "exclusive" : "shared");
          const first = await (changeFirst ? change(one) : other(one));
          const pending = watch(begin(mode, 1, ["B", "A"], kind === "replace" ? "exclusive" : "shared"));
          await expectWait(1, 0, pending); await one.commit();
          const two = await value(pending);
          const second = await (changeFirst ? other(two) : change(two)); await two.commit();
          if (kind === "reject" || kind === "cancel") {
            assert.equal(first, true); assert.equal(second, false);
            assert.equal((await observer.get("SELECT status FROM friend_requests"))!.status, changeFirst ? (kind === "reject" ? "rejected" : "cancelled") : "accepted");
            assert.equal((await observer.get("SELECT count(*) AS n FROM friendships"))!.n, changeFirst ? 0 : 1);
          } else if (kind === "unfriend") {
            assert.equal(first, true); assert.equal(second, !changeFirst);
            assert.equal((await observer.get("SELECT count(*) AS n FROM comments"))!.n, changeFirst ? 0 : 1);
          } else if (kind === "unfollow") {
            assert.equal(first, true); assert.equal(second, changeFirst);
            assert.equal((await observer.get("SELECT count(*) AS n FROM follows"))!.n, 0);
          } else if (kind === "unblock") {
            assert.equal(first, changeFirst); assert.equal(second, true);
            assert.equal((await observer.get("SELECT count(*) AS n FROM follows"))!.n, changeFirst ? 1 : 0);
          } else {
            assert.equal(first, true); assert.equal(second, true);
            assert.equal((await observer.get("SELECT count(*) AS n FROM realmojis WHERE replaced_at IS NULL AND deleted_at IS NULL"))!.n, 1);
            assert.equal((await observer.get("SELECT count(*) AS n FROM realmojis WHERE replaced_at IS NOT NULL"))!.n, 1);
          }
        });
      }
    }
  }
});

test("FoF third-party edges: pair-only negative control and graph guard", async t => {
  for (const mode of ["current", "pair-only", "candidate"] as const) {
    for (const edge of [["A", "C"], ["B", "C"]] as const) {
      for (const removeFirst of [true, false]) {
        await t.test(`${mode}: FoF A-B vs remove ${edge.join("-")}, ${removeFirst ? "remove" : "view"} first`, async () => {
          await reset();
          await observer.exec("UPDATE posts SET visibility='friends_of_friends' WHERE id='pA'");
          await friendship(observer, "A", "C"); await friendship(observer, "B", "C");
          assert.equal(await canViewPost(observer, "B", "pA"), true);
          assert.equal(await canComment(observer, "B", "pA"), false, "FoF-only does not grant comment permission");
          const view = (i: number) => mode === "current" ? begin(mode, i, ["A", "B"])
            : track(beginCandidate(clients[i]!, [["A", "B"]], { graph: mode === "pair-only" ? "none" : "exclusive" }));
          const remove = (i: number) => begin(mode === "current" ? mode : "candidate", i, edge);
          const one = await (removeFirst ? remove(0) : view(0));
          if (removeFirst) await one.exec("DELETE FROM friendships WHERE user_low_id=$1 AND user_high_id=$2", ...edge);
          else assert.equal(await canViewPost(one, "B", "pA"), true);
          const pending = watch(removeFirst ? view(1) : remove(1));
          if (mode !== "pair-only") { await expectWait(1, 0, pending); await one.commit(); }
          const two = await value(pending);
          if (removeFirst) assert.equal(await canViewPost(two, "B", "pA"), mode === "pair-only");
          else await two.exec("DELETE FROM friendships WHERE user_low_id=$1 AND user_high_id=$2", ...edge);
          await two.commit();
          if (mode === "pair-only") {
            if (!removeFirst) assert.equal(await canViewPost(one, "B", "pA"), false, "permission changes inside held pair-only transaction");
            await one.commit();
          }
          assert.equal(await canViewPost(observer, "B", "pA"), false);
        });
      }
    }
  }
});

test("SHARE vs KEY SHARE negative control", async () => {
  await reset();
  const one = await track(beginCandidate(clients[0]!, [["A", "B"]], { rowMode: "KEY SHARE" }));
  const two = await track(clients[1]!.begin());
  await two.exec("UPDATE users SET status='deleted' WHERE id='A'");
  await two.commit(); // Completes while one still holds KEY SHARE.
  await friendship(one); await one.commit();
  assert.equal((await observer.get("SELECT status FROM users WHERE id='A'"))!.status, "deleted");
  assert.equal((await observer.get("SELECT count(*) AS n FROM friendships"))!.n, 1);
});

test("multiple pairs, hash collisions and all-or-nothing rollback", async t => {
  for (const reverse of [false, true]) {
    await t.test(`multiple pairs reversed input ${reverse}`, async () => {
      await reset();
      const pairs: Pair[] = [["A", "B"], ["A", "C"], ["B", "C"]];
      const one = await track(beginCandidate(clients[0]!, reverse ? [...pairs].reverse() : pairs));
      const pending = watch(track(beginCandidate(clients[1]!, reverse ? pairs : [...pairs].reverse())));
      await expectWait(1, 0, pending);
      for (const pair of pairs) await friendship(one, ...pair);
      await one.commit();
      const two = await value(pending);
      assert.equal((await two.get("SELECT count(*) AS n FROM friendships"))!.n, 3);
      for (const pair of pairs) await two.exec("DELETE FROM friendships WHERE user_low_id=$1 AND user_high_id=$2", ...pair);
      await two.commit();
      assert.equal((await observer.get("SELECT count(*) AS n FROM friendships"))!.n, 0);
    });
  }
  await t.test("forced hash collision only over-serializes distinct pairs", async () => {
    await reset();
    const digest = () => 7;
    const one = await track(beginCandidate(clients[0]!, [["A", "B"]], { digest }));
    const pending = watch(track(beginCandidate(clients[1]!, [["C", "D"]], { digest })));
    await expectWait(1, 0, pending); await friendship(one); await one.commit();
    const two = await value(pending); await friendship(two, "C", "D"); await two.commit();
    assert.equal((await observer.get("SELECT count(*) AS n FROM friendships"))!.n, 2);
  });
  await t.test("commit/SQL error/rollback/missing user release transaction locks", async () => {
    await reset();
    const one = await begin("candidate", 0, ["A", "B"]);
    await friendship(one);
    await assert.rejects(one.exec("INSERT INTO friendships(id,user_low_id,user_high_id) VALUES($1,'A','B')", randomUUID()), { code: "23505" });
    await one.rollback();
    assert.equal((await observer.get("SELECT count(*) AS n FROM friendships"))!.n, 0);
    await assertNoLocks();
    await assert.rejects(begin("candidate", 0, ["A", "missing"]), /inactive_user/);
    const next = await begin("candidate", 1, ["B", "A"]); await friendship(next); await next.commit();
    await assertNoLocks();
    // Missing-user rollback must also release A's row lock.
    const update = await track(clients[2]!.begin()); await update.exec("UPDATE users SET bio='ok' WHERE id='A'"); await update.commit();
  });
  await t.test("savepoint rollback releases locks obtained after the savepoint", async () => {
    await reset();
    const one = await track(clients[0]!.begin()); await one.exec("SAVEPOINT trial");
    await pairLocks(one, [["A", "B"]]); await one.exec("ROLLBACK TO SAVEPOINT trial");
    const two = await begin("candidate", 1, ["A", "B"]); await two.commit(); await one.rollback(); await assertNoLocks();
  });
});

test("deadlock negative control and ordered mixed-operation schedule", async t => {
  await t.test("inverted pair order produces observed deadlock 40P01", async () => {
    await reset();
    const one = await track(clients[0]!.begin()), two = await track(clients[1]!.begin());
    const keys = sortedKeys([pairKey(["A", "B"]), pairKey(["B", "C"])]);
    assert.equal(keys.length, 2);
    await one.exec("SELECT pg_advisory_xact_lock($1::int,$2::int)", PAIR, keys[0]);
    await two.exec("SELECT pg_advisory_xact_lock($1::int,$2::int)", PAIR, keys[1]);
    const p1 = watch(one.exec("SELECT pg_advisory_xact_lock($1::int,$2::int)", PAIR, keys[1]));
    await expectWait(0, 1, p1);
    const p2 = watch(two.exec("SELECT pg_advisory_xact_lock($1::int,$2::int)", PAIR, keys[0]));
    const first = await Promise.race([p1.result, p2.result]);
    // An abort releases its locks; the other query can complete immediately too.
    await Promise.all([one.rollback(), two.rollback()]);
    const results = [first, await p1.result, await p2.result];
    assert.ok(results.some(r => (r.error as { code?: string } | undefined)?.code === "40P01"));
    await assertNoLocks();
  });
  for (const reverse of [false, true]) {
    await t.test(`ordered multi-pair write / FoF / block, reversed=${reverse}`, async () => {
      await reset();
      const pairs: Pair[] = [["A", "B"], ["A", "C"]];
      const one = await track(beginCandidate(clients[0]!, reverse ? [...pairs].reverse() : pairs));
      const p2 = watch(begin("candidate", 1, ["A", "B"], "exclusive"));
      await expectWait(1, 0, p2);
      const p3 = watch(begin("candidate", 2, ["A", "B"]));
      // p3 may queue behind the exclusive graph waiter or the pair holder.
      for (const pair of pairs) await friendship(one, ...pair);
      await one.commit();
      const two = await value(p2); assert.equal(await action(two, "realmoji"), true); await two.commit();
      const three = await value(p3); await block(three); await three.commit();
      assert.equal((await observer.get("SELECT count(*) AS n FROM friendships WHERE user_low_id='A' AND user_high_id='B'"))!.n, 0);
      assert.equal((await observer.get("SELECT count(*) AS n FROM friendships WHERE user_low_id='A' AND user_high_id='C'"))!.n, 1);
      await assertNoLocks();
    });
  }
});

test("advisory namespaces, direction and canonical key ordering", () => {
  assert.equal(pairKey(["B", "A"]), pairKey(["A", "B"]));
  assert.notEqual(pairKey(["a:b", "c"]), pairKey(["a", "b:c"]));
  assert.notEqual(GRAPH, PAIR); assert.notEqual(GRAPH, 20261031); assert.notEqual(PAIR, 20261031);
  assert.deepEqual(sortedKeys(["A", "B", "A"]), [hash("A"), hash("B")].sort((a, b) => a - b));
});
