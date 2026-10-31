import assert from "node:assert/strict";
import { test } from "node:test";
import { Hono } from "hono";
import { apiErrorHandler } from "../src/api_error.ts";
import { appPortFromEnv, configFromEnv } from "../src/config.ts";
import { regionMiddleware } from "../src/region.ts";
import { sessionMiddleware } from "../src/session.ts";
import type { Env, HandlerContext } from "../src/server.ts";

test("ポート省略時は8080、不正なポートは起動前に拒否する", (t) => {
  const original = process.env.ISUREAL_PORT;
  t.after(() => {
    if (original === undefined) delete process.env.ISUREAL_PORT;
    else process.env.ISUREAL_PORT = original;
  });
  delete process.env.ISUREAL_PORT;
  assert.equal(appPortFromEnv(), 8080);
  for (const port of ["8081", "8082", "65535"]) {
    process.env.ISUREAL_PORT = port;
    assert.equal(appPortFromEnv(), Number(port));
  }
  for (const port of ["0", "-1", "65536", "1.5", "NaN", "1e3", " 8081"]) {
    process.env.ISUREAL_PORT = port;
    assert.throws(appPortFromEnv, /invalid application port/);
  }
});

for (const servingRegion of ["europe", "america"]) {
  for (const userRegion of ["asia", "europe", "america"]) {
    test(`${servingRegion}用アプリはDBの地域=${userRegion}で判定する`, async () => {
      let lookups = 0;
      const h = {
        config: { ...configFromEnv(), region: servingRegion },
        db: { get: async () => {
          lookups++;
          return { user_id: "user", token_hash: "hash", created_at: Temporal.Now.instant(), region: userRegion };
        } },
      } as unknown as HandlerContext;
      const app = new Hono<Env>();
      app.onError(apiErrorHandler);
      app.get("/api/feeds/friends", sessionMiddleware(h, true), regionMiddleware(h), (c) => c.json({ ok: true }));
      // 転送ヘッダーでリージョン判定を上書きできないことも確認する。
      const response = await app.request("/api/feeds/friends", { headers: { Authorization: "Bearer session", "X-Country-Code": "JP", "X-Region": servingRegion } });
      assert.equal(lookups, 1);
      assert.equal(response.status, servingRegion === userRegion ? 200 : 403);
      assert.deepEqual(await response.json(), servingRegion === userRegion ? { ok: true } : { error: "region_mismatch" });
    });
  }
}
