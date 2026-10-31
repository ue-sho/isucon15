// Local synthetic microbenchmark. No DB, HTTP, credentials or deployment.
// Run: node --expose-gc test/image-signature-cache.bench.ts
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { imageSignature, withImageSignatureCacheGeneration } from "../src/image_signature.ts";
import { referenceImageSignature } from "./image-signature-cache-reference.ts";

const scenarios = ["repeated", "unique", "large-unique"] as const;
type Scenario = typeof scenarios[number];
const count = 3000;
const repetitions = 3;
const key = Buffer.alloc(32, 29);
const exp = 4102444800; // Fixed synthetic expiry: identical input in every child.

function input(scenario: Scenario, i: number): [Buffer, string, number | string] {
  const n = scenario === "repeated" ? i % 8 : i;
  const id = "synthetic-image-" + n + (scenario === "large-unique" ? "画".repeat(2900) : "");
  return [key, id, exp];
}

const [, , childFlag, variant, scenarioArg] = process.argv;
if (childFlag === "--child") {
  assert.ok(variant === "original" || variant === "cached");
  assert.ok(scenarios.includes(scenarioArg as Scenario));
  assert.ok(global.gc, "Run with --expose-gc");
  const scenario = scenarioArg as Scenario;
  const sign = variant === "original" ? referenceImageSignature
    : (...args: Parameters<typeof imageSignature>) => withImageSignatureCacheGeneration("1", () => imageSignature(...args));
  // Warm V8/OpenSSL, without warming measured cache entries.
  for (let i = 0; i < 100; i++) sign(key, "warmup-" + i, exp - 1);
  global.gc();
  const before = process.memoryUsage();
  const cpuBefore = process.cpuUsage();
  let peakHeap = before.heapUsed;
  let peakRss = before.rss;
  let checksum = 0;
  const started = performance.now();
  for (let i = 0; i < count; i++) {
    checksum = (checksum + sign(...input(scenario, i))[0]) >>> 0;
    if (i % 250 === 0) {
      const memory = process.memoryUsage();
      peakHeap = Math.max(peakHeap, memory.heapUsed);
      peakRss = Math.max(peakRss, memory.rss);
    }
  }
  const elapsedMs = performance.now() - started;
  const cpu = process.cpuUsage(cpuBefore);
  const after = process.memoryUsage();
  peakHeap = Math.max(peakHeap, after.heapUsed);
  peakRss = Math.max(peakRss, after.rss);
  global.gc();
  const retained = process.memoryUsage();
  console.log(JSON.stringify({
    variant, scenario, count, elapsedMs, cpuMs: (cpu.user + cpu.system) / 1000,
    retainedHeapBytes: retained.heapUsed - before.heapUsed,
    retainedRssBytes: retained.rss - before.rss,
    peakHeapBytes: peakHeap, peakRssBytes: peakRss,
    retainedArrayBufferBytes: retained.arrayBuffers - before.arrayBuffers,
    checksum,
  }));
} else {
  console.log(JSON.stringify({ node: process.version, platform: process.platform, arch: process.arch, count, repetitions,
    note: "Each case runs in a fresh process; alternating order; GC before/after; sampled peaks are not hard limits." }));
  for (let trial = 0; trial < repetitions; trial++) {
    for (const scenario of scenarios) {
      const order = trial % 2 ? ["cached", "original"] : ["original", "cached"];
      let checksum: number | undefined;
      for (const implementation of order) {
        const result = spawnSync(process.execPath,
          ["--expose-gc", fileURLToPath(import.meta.url), "--child", implementation, scenario],
          { encoding: "utf8", timeout: 60000 });
        assert.equal(result.status, 0, result.stderr || String(result.error));
        const row = JSON.parse(result.stdout);
        if (checksum !== undefined) assert.equal(row.checksum, checksum);
        checksum = row.checksum;
        console.log(JSON.stringify({ trial: trial + 1, ...row }));
      }
    }
  }
}
