import assert from "node:assert/strict";
import { test } from "node:test";
import { Hono } from "hono";
import { apiErrorHandler } from "../src/api_error.ts";
import { sha256Hex } from "../src/session.ts";
import { loginHandler } from "../src/user_api.ts";
import type { Env, HandlerContext } from "../src/server.ts";

for (const scenario of ["invalid-name", "invalid-credentials", "changed-after-precheck", "valid"] as const) {
  test(`login precheck: ${scenario}`, async () => {
    let reads = 0;
    let transactions = 0;
    let writes = 0;
    let committed = false;
    let disposed = false;
    const db = {
      get: async (sql: string, ...args: unknown[]) => {
        reads++;
        assert.doesNotMatch(sql, /FOR .*UPDATE/);
        assert.deepEqual(args, ["viewer", sha256Hex("secret")]);
        return scenario === "valid" || scenario === "changed-after-precheck" ? { id: "user" } : undefined;
      },
      begin: async () => {
        transactions++;
        return {
          get: async (sql: string, ...args: unknown[]) => {
            if (sql.includes("WITH invalidated")) {
              writes++;
              assert.equal(args[1], "user");
              return { user_id: "user", token_hash: args[2], created_at: Temporal.Now.instant() };
            }
            assert.match(sql, /secret_key_hash = \$2 AND status = 'active' FOR NO KEY UPDATE/);
            assert.deepEqual(args, ["viewer", sha256Hex("secret")]);
            return scenario === "changed-after-precheck" ? undefined : {
              id: "user", username: "viewer", display_name: "latest name", region: "asia", account_type: "normal",
            };
          },
          commit: async () => { committed = true; },
          [Symbol.asyncDispose]: async () => { disposed = true; },
        };
      },
    };
    const app = new Hono<Env>();
    app.onError(apiErrorHandler);
    app.post("/login", loginHandler({ db } as unknown as HandlerContext));
    const body = JSON.stringify({ username: scenario === "invalid-name" ? "!" : "viewer", secretKey: "secret" });
    const response = await app.request("/login", { method: "POST", body,
      headers: { "Content-Type": "application/json", "Content-Length": String(Buffer.byteLength(body)) } });
    assert.equal(response.status, scenario === "valid" ? 200 : 401);
    assert.equal(reads, scenario === "invalid-name" ? 0 : 1);
    assert.equal(transactions, scenario === "valid" || scenario === "changed-after-precheck" ? 1 : 0);
    assert.equal(writes, scenario === "valid" ? 1 : 0);
    assert.equal(committed, scenario === "valid");
    assert.equal(disposed, transactions > 0);
    if (scenario === "valid") {
      const result = await response.json();
      assert.equal(result.user.displayName, "latest name");
      assert.equal(typeof result.token, "string");
    } else assert.deepEqual(await response.json(), { error: "invalid_credentials" });
  });
}
