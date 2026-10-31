// Synthetic JPEG CPU work and event-loop responsiveness; no DB or HTTP traffic.
import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import jpeg from "jpeg-js";
import { JPEGDecoder } from "../src/jpeg_decoder.ts";
import { decodeJPEG } from "../src/jpeg.ts";

const original = jpeg.encode({ width: 2048, height: 2048, data: Buffer.alloc(2048 * 2048 * 4, 127) }, 70).data;
const decoder = new JPEGDecoder();
try {
  await decoder.decode(async () => Uint8Array.from(original).buffer);
  for (let trial = 0; trial < 6; trial++) {
    for (const variant of trial % 2 ? ["worker", "original"] : ["original", "worker"]) {
      const data = Uint8Array.from(original).buffer;
      await setImmediate();
      const start = performance.now();
      const probe = setImmediate().then(() => performance.now() - start);
      const result = variant === "worker"
        ? await decoder.decode(async () => data)
        : { data: Buffer.from(data), image: decodeJPEG(new Uint8Array(data)) };
      const totalMs = performance.now() - start;
      const probeMs = await probe;
      assert.deepEqual(result.image, { width: 2048, height: 2048 });
      assert.deepEqual(result.data, original);
      console.log(JSON.stringify({ variant, trial, totalMs, probeMs, bytes: original.length }));
    }
  }
} finally {
  await decoder.close();
}
