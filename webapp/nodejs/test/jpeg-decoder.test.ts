import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { setImmediate } from "node:timers/promises";
import { test } from "node:test";
import { promisify } from "node:util";
import jpeg from "jpeg-js";
import { JPEGDecoder } from "../src/jpeg_decoder.ts";
import { decodeJPEG } from "../src/jpeg.ts";

const fixture = new URL("./fixtures/jpeg-decoder-worker.ts", import.meta.url);
const bytes = (command = 0) => Uint8Array.from([0xff, 0xd8, command]).buffer;

test("worker uses the same complete JPEG decoder and returns exact source bytes", async (t) => {
  const decoder = new JPEGDecoder();
  t.after(() => decoder.close());
  const valid = jpeg.encode({ width: 8, height: 8, data: Buffer.alloc(8 * 8 * 4, 123) }, 80).data;
  const corpus = [Buffer.alloc(0), Buffer.from("not jpeg"), Buffer.from([0xff, 0xd8]), valid,
    valid.subarray(0, 80), valid.subarray(0, valid.length - 20)];
  for (let i = 0; i < 24; i++) {
    const corrupted = Buffer.from(valid);
    corrupted[(i * 29 + 7) % corrupted.length] ^= 0xff;
    corpus.push(corrupted);
  }
  for (const original of corpus) {
    const input = Uint8Array.from(original).buffer;
    const result = await decoder.decode(async () => input);
    assert.deepEqual(result.image, decodeJPEG(original));
    assert.deepEqual(result.data, original);
  }
});

test("only the granted job reads its body; cancelled queued jobs are never read", async (t) => {
  const decoder = new JPEGDecoder();
  t.after(() => decoder.close());
  const reading = Promise.withResolvers<ArrayBuffer>();
  const acquired = Promise.withResolvers<void>();
  const first = decoder.decode(() => { acquired.resolve(); return reading.promise; });
  await acquired.promise;
  let reads = 0;
  const controller = new AbortController();
  const second = decoder.decode(async () => { reads++; return new ArrayBuffer(0); }, controller.signal);
  const cancelled = assert.rejects(second, { name: "AbortError" });
  const third = decoder.decode(async () => { reads++; return new ArrayBuffer(0); });
  await setImmediate();
  assert.equal(reads, 0);
  controller.abort();
  await cancelled;
  reading.resolve(new ArrayBuffer(0));
  await Promise.all([first, third]);
  assert.equal(reads, 1);
});

test("read failure releases the slot; aborted jobs and closed decoders do not read", async (t) => {
  const decoder = new JPEGDecoder();
  t.after(() => decoder.close());
  await assert.rejects(decoder.decode(async () => { throw new Error("read failed"); }), /read failed/);
  assert.equal((await decoder.decode(async () => new ArrayBuffer(0))).image, null);
  const controller = new AbortController();
  controller.abort();
  const unexpectedRead = async () => { assert.fail("body must not be read"); };
  await assert.rejects(decoder.decode(unexpectedRead, controller.signal), { name: "AbortError" });
  await decoder.close();
  await assert.rejects(decoder.decode(unexpectedRead), /closed/);
});

test("CPU work runs off the event loop; decoder worker failures recover on the next job", async (t) => {
  const decoder = new JPEGDecoder(fixture);
  t.after(() => decoder.close());
  const pending = decoder.decode(async () => bytes());
  assert.equal(await Promise.race([pending.then(() => "decoded"), setImmediate().then(() => "event loop")]), "event loop");
  assert.deepEqual((await pending).image, { width: 1, height: 1 });
  await assert.rejects(decoder.decode(async () => bytes(1)), /exited/);
  assert.deepEqual((await decoder.decode(async () => bytes())).image, { width: 1, height: 1 });
  await assert.rejects(decoder.decode(async () => bytes(2)), /synthetic decoder failure/);
  assert.deepEqual((await decoder.decode(async () => bytes())).image, { width: 1, height: 1 });
});

test("close rejects active and queued jobs without reading queued bodies", async () => {
  const decoder = new JPEGDecoder(fixture);
  const first = decoder.decode(async () => bytes());
  const firstFailed = assert.rejects(first, /closed/);
  let read = false;
  const second = decoder.decode(async () => { read = true; return bytes(); });
  const secondFailed = assert.rejects(second, /closed/);
  await setImmediate();
  await decoder.close();
  await Promise.all([firstFailed, secondFailed]);
  assert.equal(read, false);
});

test("aborting an active decode keeps the next job usable", async (t) => {
  const decoder = new JPEGDecoder(fixture);
  t.after(() => decoder.close());
  const controller = new AbortController();
  const active = decoder.decode(async () => bytes(), controller.signal);
  const aborted = assert.rejects(active, { name: "AbortError" });
  await setImmediate();
  controller.abort();
  await aborted;
  assert.deepEqual((await decoder.decode(async () => bytes())).image, { width: 1, height: 1 });
});

test("an idle decoder does not keep the application alive", async () => {
  const moduleURL = new URL("../src/jpeg_decoder.ts", import.meta.url).href;
  const script = `import { JPEGDecoder } from ${JSON.stringify(moduleURL)};
    const decoder = new JPEGDecoder(new URL(${JSON.stringify(fixture.href)}));
    await decoder.decode(async () => Uint8Array.from([255,216,0]).buffer);
    console.log('finished');`;
  const { stdout } = await promisify(execFile)(process.execPath, ["--input-type=module", "-e", script], { timeout: 5000 });
  assert.equal(stdout.trim(), "finished");
});
