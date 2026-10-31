// Synthetic CPU comparison, no DB/HTTP and no cache hits.
import assert from "node:assert/strict";
import { imageSignature } from "../src/image_signature.ts";
import { referenceImageSignature } from "./image-signature-cache-reference.ts";

const key = Buffer.alloc(32, 29);
const exp = 4102444800;
const count = 200;
for (let i = 0; i < 32; i++) {
  const id = `synthetic-${i}`;
  assert.deepEqual(imageSignature(key, id, exp), referenceImageSignature(key, id, exp));
}
for (let trial = 0; trial < 6; trial++) {
  for (const variant of trial % 2 ? ["optimized", "original"] : ["original", "optimized"]) {
    const sign = variant === "original" ? referenceImageSignature : imageSignature;
    const before = process.cpuUsage();
    const start = performance.now();
    let checksum = 0;
    for (let i = 0; i < count; i++) checksum += sign(key, `synthetic-${i}`, exp)[0];
    const elapsedMs = performance.now() - start;
    const cpu = process.cpuUsage(before);
    console.log(JSON.stringify({ variant, trial, count, elapsedMs, cpuMs: (cpu.user + cpu.system) / 1000, checksum }));
  }
}
