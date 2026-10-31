import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, hash } from "node:crypto";
import { unix } from "./time.ts";
import type { User } from "./user.ts";

export const imageURLLifetime = 24 * 60 * 60;
const imageSignatureIterations = 1000;

const signatureCacheMaxEntries = 2048;
const signatureCacheMaxBytes = 2 * 1024 * 1024;
const signatureCacheMaxKeyLength = 4096;
const signatureCacheLifetimeMs = 60 * 1000;
// Budget UTF-16 strings plus a per-entry allowance; V8/Map overhead and RSS
// are not exactly measurable here and are also bounded by the entry limit.
const signatureCacheEntryOverhead = 256;
type SignatureCacheEntry = { signature: string; expiresAt: number; bytes: number };
const signatureCache = new Map<string, SignatureCacheEntry>();
let signatureCacheBytes = 0;
const requestGeneration = new AsyncLocalStorage<bigint | undefined>();
let latestGeneration: bigint | undefined;

// The generation comes from the shared DB in the request's existing query.
// Missing/old generations may calculate signatures, but never reuse or fill the cache.
export function withImageSignatureCacheGeneration<T>(generation: unknown, callback: () => T): T {
  const current = typeof generation === "string" && /^[1-9][0-9]*$/.test(generation)
    ? BigInt(generation) : undefined;
  if (current !== undefined && (latestGeneration === undefined || current > latestGeneration)) {
    signatureCache.clear();
    signatureCacheBytes = 0;
    latestGeneration = current;
  }
  return requestGeneration.run(current, callback);
}

function removeCachedSignature(cacheKey: string, entry: SignatureCacheEntry): void {
  signatureCache.delete(cacheKey);
  signatureCacheBytes -= entry.bytes;
}

export function imageSigningKey(secretKeyHash: string): Buffer {
  if (!/^[0-9A-Fa-f]{64}$/.test(secretKeyHash)) {
    throw new Error("invalid image signing key");
  }
  return Buffer.from(secretKeyHash, "hex");
}

export function imageSignature(key: Buffer, imageID: string, exp: number | string): Buffer {
  const expText = String(exp);
  const expSeconds = Number(expText);
  const nowSeconds = Math.floor(Date.now() / 1000);
  // Unusual/expired inputs still use the original calculation. This is only
  // cache admission, never URL validation or expiry normalization.
  const generation = requestGeneration.getStore();
  const cacheable = generation !== undefined && generation === latestGeneration
    && Number.isSafeInteger(expSeconds) && String(expSeconds) === expText && expSeconds > nowSeconds
    && key.length * 2 + imageID.length + expText.length <= signatureCacheMaxKeyLength;
  // JSON preserves field boundaries and exact strings, including ':' and
  // unpaired surrogates. Equal key bytes in different Buffers share an entry.
  const cacheKey = cacheable ? JSON.stringify([key.toString("hex"), imageID, expText]) : undefined;
  const now = performance.now();
  if (cacheKey !== undefined) {
    const cached = signatureCache.get(cacheKey);
    if (cached !== undefined) {
      removeCachedSignature(cacheKey, cached);
      if (now < cached.expiresAt) {
        signatureCache.set(cacheKey, cached);
        signatureCacheBytes += cached.bytes;
        return Buffer.from(cached.signature, "hex");
      }
    }
  }

  const value = repeatedHmacSha256(key, Buffer.from(`${expText}:${imageID}`));
  if (cacheKey !== undefined) {
    // Immutable storage also isolates the cache from mutations through a
    // returned Buffer's backing ArrayBuffer (including pooled allocations).
    const signature = value.toString("hex");
    const bytes = 2 * (cacheKey.length + signature.length) + signatureCacheEntryOverhead;
    if (bytes > signatureCacheMaxBytes) return value;
    while (signatureCache.size >= signatureCacheMaxEntries || signatureCacheBytes + bytes > signatureCacheMaxBytes) {
      const oldest = signatureCache.entries().next().value;
      if (oldest === undefined) break;
      removeCachedSignature(oldest[0], oldest[1]);
    }
    signatureCache.set(cacheKey, { signature, expiresAt: now + signatureCacheLifetimeMs, bytes });
    signatureCacheBytes += bytes;
  }
  return value;
}

// HMAC-SHA256 = SHA256(opad || SHA256(ipad || message)). The key pads are
// identical in all 1000 iterations. Keep them in request-local buffers and use
// the one-shot hash API to avoid creating 1000 streaming HMAC objects.
function repeatedHmacSha256(key: Buffer, message: Buffer): Buffer {
  if (key.length > 64) key = createHash("sha256").update(key).digest();
  const inner = Buffer.alloc(96, 0x36);
  const outer = Buffer.alloc(96, 0x5c);
  for (let i = 0; i < key.length; i++) {
    inner[i] ^= key[i];
    outer[i] ^= key[i];
  }
  hash("sha256", Buffer.concat([inner.subarray(0, 64), message]), "buffer").copy(outer, 64);
  let value = hash("sha256", outer, "buffer");
  for (let i = 1; i < imageSignatureIterations; i++) {
    value.copy(inner, 64);
    hash("sha256", inner, "buffer").copy(outer, 64);
    value = hash("sha256", outer, "buffer");
  }
  return value;
}

export function signedImageURL(user: User, imageID: string): string {
  const exp = unix(Temporal.Now.instant()) + imageURLLifetime;
  const sig = imageSignature(user.imageKey, imageID, exp).toString("base64url");
  return `/api/images/${pathEscape(imageID)}?exp=${exp}&sig=${sig}`;
}

function pathEscape(value: string): string {
  return Array.from(Buffer.from(value), (byte) => {
    const char = String.fromCharCode(byte);
    return /[A-Za-z0-9\-_.~$&+=:@]/.test(char) ? char : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }).join("");
}
