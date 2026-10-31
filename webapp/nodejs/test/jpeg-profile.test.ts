import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { test } from "node:test";
import jpeg from "jpeg-js";
import { decodeJPEG } from "../src/jpeg.ts";
import { validateProfileJPEG } from "../src/jpeg_profile.ts";
import { minimalJPEG } from "./helpers/minimal-jpeg.ts";
import decodeProfile from "../src/vendor/jpeg-js/decoder.cjs";

test("vendored JPEG parser remains identical to the pinned upstream outside the output shortcut", async () => {
  const require = createRequire(import.meta.url);
  const upstream = await readFile(require.resolve("jpeg-js/lib/decoder.js"), "utf8");
  assert.equal(createHash("sha256").update(upstream).digest("hex"), "a3f175fd6f62d142aad94d3bd90f3a30be4e076baf9b6a6fa31c8e84d9d4aa9f");
  const vendor = await readFile(new URL("../src/vendor/jpeg-js/decoder.cjs", import.meta.url), "utf8");
  const start = vendor.indexOf("  // ISUReal:");
  const end = vendor.indexOf("  var channels =", start);
  assert.ok(start >= 0 && end > start);
  assert.equal(vendor.slice(vendor.indexOf("\n") + 1, start) + vendor.slice(end), upstream);
});

test("grayscale, RGB, CMYK, progressive, unsupported color and 512/513 boundaries match full decoding", () => {
  for (const [width, height] of [[1, 1], [512, 1], [513, 1], [1, 513], [513, 17], [0, 513], [513, 0]]) {
    for (const components of [1, 2, 3, 4, 5]) {
      for (const progressive of [false, true]) {
        for (const adobe of [false, true]) {
          const input = minimalJPEG(width, height, components, progressive, adobe);
          const expected = decodeJPEG(input);
          if (width > 0 && height > 0 && [1, 3].includes(components)) assert.deepEqual(expected, { width, height });
          if (width > 0 && height > 0 && components === 4 && adobe) assert.deepEqual(expected, { width, height });
          assert.deepEqual(validateProfileJPEG(input), expected, JSON.stringify({ width, height, components, progressive, adobe }));
        }
      }
    }
  }
});

test("truncation, invalid entropy, malformed component ids and sampling do not become valid metadata", () => {
  const seed = minimalJPEG(513, 17);
  const inputs = [Buffer.alloc(0), Buffer.from("not JPEG"), Buffer.from([0xff, 0xd8]), seed];
  for (let end = 0; end < seed.length; end += 3) inputs.push(seed.subarray(0, end));
  const sos = seed.indexOf(Buffer.from([0xff, 0xda]));
  const sof = seed.indexOf(Buffer.from([0xff, 0xc0]));
  for (let i = 0; i < 100; i++) {
    const corrupted = Buffer.from(seed);
    corrupted[sos + 14 + i % (seed.length - sos - 14)] ^= (i * 31 + 1) & 255;
    inputs.push(corrupted);
  }
  for (const sampling of [0, 0x10, 0x01, 0x12, 0x21, 0x22, 0x41]) {
    const corrupted = Buffer.from(seed);
    corrupted[sof + 11] = sampling;
    inputs.push(corrupted);
  }
  const encoded = jpeg.encode({ width: 513, height: 33, data: Buffer.alloc(513 * 33 * 4, 127) }, 70).data;
  inputs.push(encoded, encoded.subarray(0, encoded.length - 20));
  // Unusual but valid marker layouts must safely fall back to the original path.
  inputs.push(Buffer.concat([seed.subarray(0, 2), ...Array.from({ length: 65 }, () => Buffer.from([0xff, 0xfe, 0, 3, 120])), seed.subarray(2)]));
  for (const input of inputs) assert.deepEqual(validateProfileJPEG(input), decodeJPEG(input));
});

test("the output shortcut retains the original memory-budget rejection boundary", () => {
  const input = minimalJPEG(513, 17);
  const outcomes: boolean[] = [];
  for (const maxMemoryUsageInMB of [0.01, 0.15, 0.2, 0.25, 1]) {
    const options = { useTArray: true, formatAsRGBA: false, tolerantDecoding: false, maxMemoryUsageInMB } as const;
    let expected = false;
    try { jpeg.decode(input, options); expected = true; } catch {}
    let actual = false;
    try { decodeProfile(input, { ...options, validateOversizedProfile: true }); actual = true; } catch {}
    assert.equal(actual, expected, String(maxMemoryUsageInMB));
    outcomes.push(expected);
  }
  assert.ok(outcomes.includes(true) && outcomes.includes(false));
});
