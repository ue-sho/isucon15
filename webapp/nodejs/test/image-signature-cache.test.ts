import assert from "node:assert/strict";
import crypto from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import { test, type TestContext } from "node:test";
import { Hono } from "hono";
import { apiErrorHandler } from "../src/api_error.ts";
import { getImageHandler } from "../src/image_api.ts";
import { imageSignature, imageSigningKey, signedImageURL, withImageSignatureCacheGeneration } from "../src/image_signature.ts";
import type { Env, HandlerContext } from "../src/server.ts";
import type { User } from "../src/user.ts";
import { referenceImageSignature } from "./image-signature-cache-reference.ts";

const wallStart = 1800000000000;
const exp = wallStart / 1000 + 86400;
const key = Buffer.alloc(32, 19);
let moduleID = 0;
const realHash = crypto.hash;

async function freshSignature() {
  const module: typeof import("../src/image_signature.ts") =
    await import("../src/image_signature.ts?cache-test=" + moduleID++);
  return (...args: Parameters<typeof module.imageSignature>) =>
    module.withImageSignatureCacheGeneration("1", () => module.imageSignature(...args));
}

function clock(t: TestContext) {
  const time = { wall: wallStart, monotonic: 0 };
  t.mock.method(Date, "now", () => time.wall);
  t.mock.method(performance, "now", () => time.monotonic);
  t.mock.method(Temporal.Now, "instant", () => Temporal.Instant.fromEpochMilliseconds(time.wall));
  return time;
}

function countHmac(t: TestContext, cheap = false) {
  let calls = 0;
  // Avoid retaining millions of mock call records during cache eviction tests.
  crypto.hash = ((...args: Parameters<typeof crypto.hash>) => {
    calls += 0.5; // Two SHA256 operations per HMAC iteration.
    return cheap ? Buffer.alloc(32) : realHash(...args);
  }) as typeof crypto.hash;
  syncBuiltinESMExports();
  t.after(() => {
    crypto.hash = realHash;
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  return () => calls;
}

test("fixed and 128 deterministic generated inputs match the original bytes on misses and hits", async (t) => {
  clock(t);
  const sign = await freshSignature();
  const fixed: Array<[Buffer, string, number | string]> = [
    [key, "00000000-0000-4000-8000-000000000001", exp],
    [Buffer.alloc(0), "", exp],
    [Buffer.from([0, 255, 128]), "画像:/?:\u0000😀", exp],
    [Buffer.alloc(128, 255), "\ud800", exp],
    ...[63, 64, 65].map((size): [Buffer, string, number] => [Buffer.alloc(size, 0xa5), "pad-boundary", exp]),
    [key, "id", 0], [key, "id", -0], [key, "id", NaN], [key, "id", Infinity],
    [key, "id", "NaN"], [key, "id", ""], [key, "id", "not:an:expiry"],
  ];
  let state = 0x12345678;
  const next = () => (state = (Math.imul(state, 1664525) + 1013904223) >>> 0);
  for (let i = 0; i < 128; i++) {
    const bytes = Buffer.from(Array.from({ length: next() % 97 }, () => next() & 255));
    fixed.push([bytes, "generated:" + next() + ":画像:" + i, i % 2 ? String(exp + i) : exp + i]);
  }
  for (const input of fixed) {
    const expected = referenceImageSignature(...input);
    assert.deepEqual(sign(...input), expected);
    assert.deepEqual(sign(...input), expected);
  }
});

test("same key content and exact exp text hit; different keys and exp representations do not collide", async (t) => {
  clock(t);
  const sign = await freshSignature();
  const calls = countHmac(t);
  const first = sign(key, "same-image", exp);
  assert.equal(calls(), 1000);
  assert.deepEqual(sign(Buffer.from(key), "same-image", String(exp)), first);
  assert.equal(calls(), 1000);
  for (const value of ["0" + exp, "+" + exp, exp + ".0", String(exp) + " ", "1.8000864e9", String(exp + 1)]) {
    assert.deepEqual(sign(key, "same-image", value), referenceImageSignature(key, "same-image", value));
  }
  assert.equal(calls(), 7000);
  const changed = Buffer.from(key);
  changed[0] ^= 255;
  assert.deepEqual(sign(changed, "same-image", exp), referenceImageSignature(changed, "same-image", exp));
  assert.equal(calls(), 8000);
  assert.deepEqual(sign(key, "same-image", exp), first);
  assert.equal(calls(), 8000);
});

test("input Buffer mutation, returned Buffer and backing ArrayBuffer cannot poison stored signatures", async (t) => {
  clock(t);
  const sign = await freshSignature();
  const mutableKey = Buffer.alloc(32, 19);
  const expected = referenceImageSignature(key, "mutations", exp);
  const miss = sign(mutableKey, "mutations", exp);
  miss.fill(0);
  const hit = sign(mutableKey, "mutations", exp);
  assert.deepEqual(hit, expected);
  new Uint8Array(hit.buffer).fill(255);
  assert.deepEqual(sign(mutableKey, "mutations", exp), expected);
  mutableKey.fill(7);
  assert.deepEqual(sign(mutableKey, "mutations", exp), referenceImageSignature(mutableKey, "mutations", exp));
  assert.deepEqual(sign(Buffer.from(key), "mutations", exp), expected);
});

test("URL expiry is exclusive, and TTL hits never extend the 60-second lifetime", async (t) => {
  const time = clock(t);
  const sign = await freshSignature();
  const calls = countHmac(t);
  const nearExpiry = wallStart / 1000 + 1;
  const expected = sign(key, "expires", nearExpiry);
  time.wall += 999;
  assert.deepEqual(sign(key, "expires", nearExpiry), expected);
  assert.equal(calls(), 1000);
  time.wall++;
  assert.deepEqual(sign(key, "expires", nearExpiry), expected);
  assert.equal(calls(), 2000);
  sign(key, "expires", nearExpiry);
  assert.equal(calls(), 3000);
  sign(key, "ttl", exp);
  time.monotonic = 59999;
  sign(key, "ttl", exp);
  assert.equal(calls(), 4000);
  // Wall-clock rollback must not extend the monotonic TTL.
  time.wall -= 100000;
  time.monotonic = 60000;
  sign(key, "ttl", exp);
  assert.equal(calls(), 5000);
});

test("entry cap evicts LRU, including with random distinct expiry values", async (t) => {
  clock(t);
  const sign = await freshSignature();
  const calls = countHmac(t, true);
  // Cheap crypto is used ONLY to inspect cache policy; equivalence uses real HMAC.
  for (let i = 0; i < 2048; i++) sign(key, "lru", exp + i * 7919);
  assert.equal(calls(), 2048000);
  sign(key, "lru", exp); // refresh oldest
  sign(key, "lru", exp + 2048 * 7919);
  assert.equal(calls(), 2049000);
  sign(key, "lru", exp);
  assert.equal(calls(), 2049000);
  sign(key, "lru", exp + 7919); // now evicted
  assert.equal(calls(), 2050000);
});

test("byte budget evicts before entry cap; oversized keys, ids and expiry strings bypass storage", async (t) => {
  clock(t);
  const sign = await freshSignature();
  const calls = countHmac(t, true);
  const id = (i: number) => String(i).padStart(4, "0") + "画".repeat(2996);
  const bytes = 2 * (JSON.stringify([key.toString("hex"), id(0), String(exp)]).length + 64) + 256;
  const capacity = Math.floor(2 * 1024 * 1024 / bytes);
  assert.ok(capacity < 2048);
  for (let i = 0; i <= capacity; i++) sign(key, id(i), exp);
  const before = calls();
  sign(key, id(capacity), exp);
  assert.equal(calls(), before);
  sign(key, id(0), exp);
  assert.equal(calls(), before + 1000);
  for (const input of [
    [key, "x".repeat(5000), exp],
    [Buffer.alloc(3000), "id", exp],
    [key, "id", "9".repeat(5000)],
  ] as Array<[Buffer, string, number | string]>) {
    const prior = calls();
    sign(...input);
    sign(...input);
    assert.equal(calls(), prior + 2000);
  }
});

test("canonical key fields preserve separators and Unicode; oversize inputs still match original", async (t) => {
  clock(t);
  const sign = await freshSignature();
  for (const input of [
    [key, 'a:b",["c', exp], [key, "\ud800", exp], [key, "\ufffd", exp],
    [key, "x".repeat(5000), exp], [Buffer.alloc(3000, 2), "id", exp],
    [key, "id", "9".repeat(5000)],
  ] as Array<[Buffer, string, number | string]>) {
    assert.deepEqual(sign(...input), referenceImageSignature(...input));
  }
});

test("warm and fresh worker/module, simulated data reset and key rotation produce the same bytes", async (t) => {
  clock(t);
  const warm = await freshSignature();
  const fresh = await freshSignature();
  const initial = referenceImageSignature(key, "reset-image", exp);
  assert.deepEqual(warm(key, "reset-image", exp), initial);
  assert.deepEqual(fresh(Buffer.from(key), "reset-image", exp), initial);
  const changedKey = Buffer.alloc(32, 37);
  assert.deepEqual(warm(changedKey, "reset-image", exp), referenceImageSignature(changedKey, "reset-image", exp));
  assert.deepEqual(warm(Buffer.from(key), "reset-image", exp), initial);
});

test("signedImageURL keeps exact seconds and escaping across a second boundary", (t) => {
  const time = clock(t);
  const user = { imageKey: key } as User;
  const imageID = "test /画像";
  // Build the expected path explicitly: '/' is escaped, not a URL separator.
  const path = "/api/images/test%20%2F%E7%94%BB%E5%83%8F";
  const first = signedImageURL(user, imageID);
  assert.equal(first, path + "?exp=" + exp + "&sig=" + referenceImageSignature(key, imageID, exp).toString("base64url"));
  time.wall += 999;
  assert.equal(signedImageURL(user, imageID), first);
  time.wall++;
  assert.equal(signedImageURL(user, imageID), path + "?exp=" + (exp + 1) + "&sig=" + referenceImageSignature(key, imageID, exp + 1).toString("base64url"));
  assert.equal(imageSigningKey("13".repeat(32)).toString("hex"), "13".repeat(32));
  assert.throws(() => imageSigningKey("bad"));
});

test("actual image handler still checks signature, expiry, owner and validity on warm cache hits", async (t) => {
  const time = clock(t);
  let active = true;
  let valid = true;
  let ownerKey = Buffer.from(key);
  let ownerReads = 0;
  let validityReads = 0;
  let expireDuringRead = false;
  const h = {
    db: {
      async get(sql: string) {
        if (sql.includes("SELECT u.secret_key_hash")) {
          ownerReads++;
          return active ? { secret_key_hash: ownerKey.toString("hex"), signature_cache_generation: "1" } : undefined;
        }
        validityReads++;
        if (expireDuringRead) time.wall = exp * 1000;
        return active && valid ? { data_base64: Buffer.from([1, 2, 3]).toString("base64"), media_type: "image/jpeg" } : undefined;
      },
    },
  } as unknown as HandlerContext;
  const app = new Hono<Env>();
  app.onError(apiErrorHandler);
  app.get("/api/images/:imageId", getImageHandler(h));
  const signature = withImageSignatureCacheGeneration("1", () => imageSignature(key, "handler-image", exp)).toString("base64url");
  const url = "/api/images/handler-image?exp=" + exp + "&sig=" + signature;
  assert.equal((await app.request(url)).status, 200);
  assert.equal((await app.request(url)).status, 200);
  assert.equal(ownerReads, 2);
  assert.equal(validityReads, 2);
  const tampered = Buffer.from(signature, "base64url");
  tampered[0] ^= 1;
  assert.equal((await app.request(url.replace(signature, tampered.toString("base64url")))).status, 403);
  assert.equal(validityReads, 2);
  for (const bad of [url + "&exp=" + exp, url.replace("exp=" + exp, "exp=0" + exp), url.replace(signature, "bad")]) {
    const before: number = ownerReads;
    assert.equal((await app.request(bad)).status, 403);
    assert.equal(ownerReads, before);
  }
  active = false; // withdrawal
  assert.equal((await app.request(url)).status, 403);
  active = true;
  valid = false; // deletion / RealMoji replacement as reported by the real DB query
  assert.equal((await app.request(url)).status, 403);
  time.wall += 5001;
  assert.equal((await app.request(url)).status, 403);
  valid = true;
  ownerKey = Buffer.alloc(32, 3); // another owner / rotated key
  assert.equal((await app.request(url)).status, 403);
  ownerKey = Buffer.from(key); // simulated reset
  assert.equal((await app.request(url)).status, 200);
  expireDuringRead = true;
  assert.equal((await app.request(url)).status, 403);
  assert.equal((await app.request(url)).status, 403);
});

test("generation changes discard cached signatures; missing or stale generations bypass reuse", async (t) => {
  clock(t);
  const m: typeof import("../src/image_signature.ts") = await import("../src/image_signature.ts?generation=" + moduleID++);
  const calls = countHmac(t);
  const sign = () => m.imageSignature(key, "generation", exp);
  const run = (generation: unknown) => m.withImageSignatureCacheGeneration(generation, sign);
  const expected = run("9007199254740992");
  assert.deepEqual(run("9007199254740992"), expected);
  assert.equal(calls(), 1000);
  assert.deepEqual(run("9007199254740993"), expected);
  assert.equal(calls(), 2000, "bigint generations must not collapse through Number");
  for (const generation of ["9007199254740992", undefined, null, 2, "bad", "0"]) {
    assert.deepEqual(run(generation), expected);
    assert.deepEqual(run(generation), expected);
  }
  assert.equal(calls(), 14000);
  assert.deepEqual(run("9007199254740993"), expected);
  assert.equal(calls(), 14000, "old/missing scope must not replace the current cache");
  sign(); sign();
  assert.equal(calls(), 16000, "scope must not leak to a later unscoped caller");
});

test("a delayed old request cannot reintroduce entries after another request observes reset", async (t) => {
  clock(t);
  const m: typeof import("../src/image_signature.ts") = await import("../src/image_signature.ts?generation=" + moduleID++);
  const calls = countHmac(t);
  let release!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  const sign = () => m.imageSignature(key, "overlap", exp);
  const oldRequest = m.withImageSignatureCacheGeneration("1", async () => {
    sign();
    await wait;
    sign(); sign();
  });
  assert.equal(calls(), 1000);
  await m.withImageSignatureCacheGeneration("2", async () => {
    sign();
    await Promise.resolve();
    sign();
  });
  assert.equal(calls(), 2000);
  release();
  await oldRequest;
  assert.equal(calls(), 4000, "old async continuation must neither read nor fill the new cache");
  m.withImageSignatureCacheGeneration("2", sign);
  assert.equal(calls(), 4000);
  await assert.rejects(m.withImageSignatureCacheGeneration("3", async () => { throw new Error("request failed"); }));
  sign(); sign();
  assert.equal(calls(), 6000, "failed request must not leak its generation scope");
});
