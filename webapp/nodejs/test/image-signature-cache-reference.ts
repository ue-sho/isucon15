import { createHmac } from "node:crypto";

// Unchanged algorithm from base 9f4f46e; synthetic inputs only.
const originalCreateHmac = createHmac;
export function referenceImageSignature(key: Buffer, imageID: string, exp: number | string): Buffer {
  let value = Buffer.from(String(exp) + ":" + imageID);
  for (let i = 0; i < 1000; i++) {
    value = originalCreateHmac("sha256", key).update(value).digest();
  }
  return value;
}
