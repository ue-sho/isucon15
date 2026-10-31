// Synthetic full-decoder comparison; no service settings, DB or real user images.
import assert from "node:assert/strict";
import jpeg from "jpeg-js";
import { decodeJPEG } from "../src/jpeg.ts";
import { validateProfileJPEG } from "../src/jpeg_profile.ts";

assert.ok(global.gc, "run with --expose-gc");
let state = 12345;
const pixels = Buffer.alloc(1024 * 1024 * 4);
for (let i = 0; i < pixels.length; i++) {
  state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
  pixels[i] = i % 4 === 3 ? 255 : state >>> 24;
}
const scenarios = [
  { name: "accepted-512", width: 512, height: 512, data: Buffer.alloc(512 * 512 * 4, 127) },
  { name: "oversized-flat", width: 2048, height: 2048, data: Buffer.alloc(2048 * 2048 * 4, 127) },
  { name: "oversized-noise", width: 1024, height: 1024, data: pixels },
];
for (const { name, ...image } of scenarios) {
  const input = jpeg.encode(image, 70).data;
  for (const decode of [decodeJPEG, validateProfileJPEG]) for (let i = 0; i < 2; i++) decode(input);
  for (let trial = 0; trial < 6; trial++) {
    for (const variant of trial % 2 ? ["optimized", "original"] : ["original", "optimized"]) {
      global.gc();
      const before = process.cpuUsage();
      const start = performance.now();
      const result = (variant === "original" ? decodeJPEG : validateProfileJPEG)(input);
      const elapsedMs = performance.now() - start;
      const cpu = process.cpuUsage(before);
      assert.deepEqual(result, { width: image.width, height: image.height });
      console.log(JSON.stringify({ name, variant, trial, bytes: input.length, elapsedMs, cpuMs: (cpu.user + cpu.system) / 1000 }));
    }
  }
}
