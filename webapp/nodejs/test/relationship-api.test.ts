import assert from "node:assert/strict";
import { test } from "node:test";
import { Hono } from "hono";
import { apiErrorHandler } from "../src/api_error.ts";
import type { Row } from "../src/db.ts";
import { createFriendRequestHandler, transitionFriendRequestHandler } from "../src/friend_request_api.ts";
import { getUserHandler } from "../src/user_read_api.ts";
import type { Env, HandlerContext } from "../src/server.ts";

type Step = { sql: RegExp; row?: Row; args?: unknown[] };
const stamp = "2026-10-31T02:00:00Z";
const request = { id: "request", requester_id: "b", recipient_id: "a", status: "pending", created_at: stamp, updated_at: stamp };
const locked = (): Step[] => [
  { sql: /users.*FOR NO KEY UPDATE/, args: ["a"], row: { id: "a" } },
  { sql: /users.*FOR NO KEY UPDATE/, args: ["b"], row: { id: "b" } },
];
const block = (exists = false): Step => ({ sql: /EXISTS.*block_relations/, row: { exists } });
const friend = (exists = false): Step => ({ sql: /EXISTS.*friendships.*user_low_id=\$1 AND user_high_id=\$2/, args: ["a", "b"], row: { exists } });

function setup(steps: Step[]) {
  let committed = false;
  let disposed = false;
  const unexpected: string[] = [];
  const get = async (sql: string, ...args: unknown[]) => {
    const step = steps.shift();
    if (!step || !step.sql.test(sql)) {
      unexpected.push(sql);
      throw new Error("unexpected query");
    }
    if (step.args) assert.deepEqual(args, step.args);
    return step.row;
  };
  const tx = {
    get,
    exec: async (sql: string, ...args: unknown[]) => { await get(sql, ...args); return 1; },
    commit: async () => { committed = true; },
    [Symbol.asyncDispose]: async () => { disposed = true; },
  };
  const context = { db: { get, begin: async () => tx } } as unknown as HandlerContext;
  const app = new Hono<Env>();
  app.onError(apiErrorHandler);
  app.use("*", async (c, next) => {
    c.set("session", { userID: "a", region: "asia", token: "", tokenHash: "", createdAt: stamp as unknown as Temporal.Instant });
    await next();
  });
  app.post("/api/friend-requests", createFriendRequestHandler(context));
  app.post("/api/friend-requests/:requestId/:action", transitionFriendRequestHandler(context));
  app.get("/api/users/:userId", getUserHandler(context));
  return { app, verify(expectCommit: boolean, expectDispose = true) {
    assert.deepEqual(unexpected, []);
    assert.equal(steps.length, 0);
    assert.equal(committed, expectCommit);
    assert.equal(disposed, expectDispose);
  } };
}

function create(app: Hono<Env>) {
  const body = JSON.stringify({ recipientId: "b" });
  return app.request("/api/friend-requests", { method: "POST", headers: { "Content-Type": "application/json", "Content-Length": String(Buffer.byteLength(body)) }, body });
}

test("new friend request returns inserted database values without rereading", async () => {
  const { app, verify } = setup([...locked(), block(), friend(),
    { sql: /SELECT id, requester_id.*status='pending'/ },
    { sql: /INSERT INTO friend_requests.*RETURNING id, status, updated_at/, row: { id: "new", status: "pending", updated_at: stamp } },
  ]);
  const response = await create(app);
  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), { relationId: "new", status: "pending", updatedAt: stamp });
  verify(true);
});

test("opposite pending request is accepted and creates a friendship", async () => {
  const { app, verify } = setup([...locked(), block(), friend(),
    { sql: /SELECT id, requester_id.*status='pending'/, row: request },
    { sql: /UPDATE friend_requests.*RETURNING/, args: ["request"], row: { id: "request", status: "accepted", updated_at: stamp } },
    { sql: /INSERT INTO friendships/ },
  ]);
  const response = await create(app);
  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), { relationId: "request", status: "accepted", updatedAt: stamp });
  verify(true);
});

for (const reason of ["blocked", "friends", "duplicate"] as const) {
  test(`friend request conflict: ${reason}`, async () => {
    const steps = [...locked(), block(reason === "blocked")];
    if (reason !== "blocked") steps.push(friend(reason === "friends"));
    if (reason === "duplicate") steps.push({ sql: /SELECT id, requester_id.*status='pending'/, row: { ...request, requester_id: "a", recipient_id: "b" } });
    const { app, verify } = setup(steps);
    const response = await create(app);
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), { error: "relationship_conflict" });
    verify(false);
  });
}

for (const [action, status] of [["accept", "accepted"], ["reject", "rejected"], ["cancel", "cancelled"]]) {
  test(`${action} preserves authorization and returns updated database values`, async () => {
    const row = action === "cancel" ? { ...request, requester_id: "a", recipient_id: "b" } : request;
    const steps: Step[] = [{ sql: /FROM friend_requests WHERE id=\$1/, row }, ...locked(), { sql: /FROM friend_requests WHERE id=\$1/, row }];
    if (action === "accept") steps.push(block(), { sql: /INSERT INTO friendships/ });
    steps.push({ sql: /UPDATE friend_requests.*RETURNING/, args: ["request", status], row: { id: "request", status, updated_at: stamp } });
    const { app, verify } = setup(steps);
    const response = await app.request(`/api/friend-requests/request/${action}`, { method: "POST" });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { relationId: "request", status, updatedAt: stamp });
    verify(true);
  });
}

test("request status is rechecked after locking both users", async () => {
  const { app, verify } = setup([{ sql: /FROM friend_requests/, row: request }, ...locked(),
    { sql: /FROM friend_requests/, row: { ...request, status: "cancelled" } },
  ]);
  const response = await app.request("/api/friend-requests/request/accept", { method: "POST" });
  assert.equal(response.status, 403);
  verify(false);
});

test("requester cannot accept their own outgoing request", async () => {
  const { app, verify } = setup([{ sql: /FROM friend_requests/, row: { ...request, requester_id: "a", recipient_id: "b" } }]);
  const response = await app.request("/api/friend-requests/request/accept", { method: "POST" });
  assert.equal(response.status, 403);
  verify(false, false);
});

for (const [accountType, isFriend, bio] of [["regular", false, ""], ["regular", true, "private bio"], ["certified_public", false, "private bio"]] as const) {
  test(`user bio disclosure: ${accountType}, friend=${isFriend}`, async () => {
    const steps: Step[] = [{ sql: /FROM users WHERE id = \$1/, row: {
      id: "b", username: "target", display_name: "Target", secret_key_hash: "a".repeat(64),
      bio: "private bio", profile_image_id: null, region: "asia", account_type: accountType, status: "active",
    } }, block()];
    if (accountType !== "certified_public") steps.push(friend(isFriend));
    const { app, verify } = setup(steps);
    const response = await app.request("/api/users/b");
    assert.equal(response.status, 200);
    assert.equal((await response.json()).bio, bio);
    verify(false, false);
  });
}
