import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import { Hono } from "hono";
import jpeg from "jpeg-js";
import { apiErrorHandler } from "../src/api_error.ts";
import { JPEGDecoder } from "../src/jpeg_decoder.ts";
import { decodeJPEG } from "../src/jpeg.ts";
import { putProfileImageHandler } from "../src/profile_image_api.ts";
import type { Env, HandlerContext } from "../src/server.ts";

function setup(t: TestContext, decoder = new JPEGDecoder(), missingUser = false) {
  t.after(() => decoder.close());
  const events: string[] = [];
  let inserted: Uint8Array | undefined;
  let abuse: string | undefined;
  const tx = {
    async get() { events.push("user lock"); return missingUser ? undefined : { profile_image_id: "previous" }; },
    async exec(sql: string, ...args: unknown[]) {
      if (sql.startsWith("INSERT INTO image_objects")) { events.push("insert"); inserted = args[2] as Uint8Array; }
      else if (sql.startsWith("UPDATE users")) events.push("profile update");
      else if (sql.startsWith("DELETE FROM image_objects")) events.push("delete previous");
      else assert.fail("unexpected write");
      return 1;
    },
    async commit() { events.push("commit"); },
    async [Symbol.asyncDispose]() { events.push("dispose"); },
  };
  const context = { db: { async begin() { events.push("begin"); return tx; } } } as unknown as HandlerContext;
  const app = new Hono<Env>().onError(apiErrorHandler);
  app.use(async (c, next) => {
    c.set("session", { userID: "alice", region: "asia", token: "test", tokenHash: "test", createdAt: Temporal.Now.instant() });
    await next();
    abuse = c.get("abuse");
  });
  app.put("/image", putProfileImageHandler(context, decoder));
  app.get("/probe", (c) => c.text("ok"));
  return {
    app, events,
    put: (data: Uint8Array, type = "image/jpeg") => app.request("/image", {
      method: "PUT", headers: { "Content-Type": type }, body: Uint8Array.from(data),
    }),
    get inserted() { return inserted; },
    get abuse() { return abuse; },
  };
}

function image(width: number, height: number) {
  return jpeg.encode({ width, height, data: Buffer.alloc(width * height * 4, 127) }, 70).data;
}

test("profile JPEG response and abuse classification match the original complete decoder", async (t) => {
  const large = image(513, 513);
  const valid = image(2, 3);
  const corpus = [valid, image(512, 512), large, image(513, 1), image(1, 513),
    Buffer.alloc(0), Buffer.from("PNG is not JPEG"), Buffer.from([0xff, 0xd8]),
    large.subarray(0, large.length - 100), valid.subarray(0, 90)];
  for (const [index, data] of corpus.entries()) {
    await t.test(`input ${index}`, async (st) => {
      const f = setup(st);
      const decoded = decodeJPEG(data);
      const valid = decoded !== null && decoded.width <= 512 && decoded.height <= 512;
      const response = await f.put(data);
      assert.equal(response.status, valid ? 204 : 400);
      assert.equal(f.abuse, decoded === null ? "invalid_image" : undefined);
      if (valid) {
        assert.deepEqual(f.inserted, data);
        assert.deepEqual(f.events, ["begin", "user lock", "insert", "profile update", "delete previous", "commit", "dispose"]);
      } else {
        assert.deepEqual(await response.json(), { error: "invalid_profile_image" });
        assert.deepEqual(f.events, []);
      }
    });
  }
});

test("unsupported media type and missing account keep their responses", async (t) => {
  const f = setup(t);
  assert.equal((await f.put(Buffer.from("anything"), "image/png")).status, 415);
  assert.deepEqual(f.events, []);
  const deleted = setup(t, new JPEGDecoder(), true);
  const response = await deleted.put(image(1, 1));
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: "account_not_found" });
  assert.deepEqual(deleted.events, ["begin", "user lock", "dispose"]);
});

test("ordinary API responds during JPEG CPU work, before image validation completes", async (t) => {
  const f = setup(t, new JPEGDecoder(new URL("./fixtures/jpeg-decoder-worker.ts", import.meta.url)));
  let complete = false;
  const upload = Promise.resolve(f.put(Uint8Array.from([0xff, 0xd8, 0]))).then((response) => { complete = true; return response; });
  await setImmediate();
  assert.equal(await (await f.app.request("/probe")).text(), "ok");
  assert.equal(complete, false);
  assert.deepEqual(f.events, [], "no DB transaction while waiting for validation");
  assert.equal((await upload).status, 204);
});
