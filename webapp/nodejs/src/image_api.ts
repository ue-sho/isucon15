import { timingSafeEqual } from "node:crypto";
import type { Handler } from "hono";
import { APIError } from "./api_error.ts";
import { bind, parseQuery, rawQuery } from "./bind.ts";
import { imageSignature, imageSigningKey, withImageSignatureCacheGeneration } from "./image_signature.ts";
import { blobResponse } from "./response.ts";
import { unix } from "./time.ts";
import type { Env, HandlerContext } from "./server.ts";

const getImageRequest = {
  imageId: { param: "imageId" },
  exp: { query: "exp" },
  sig: { query: "sig" },
} as const;

function parseImageExp(value: string): number | null {
  const exp = Number(value);
  return /^-?\d+$/.test(value) && String(exp) === value ? exp : null;
}

export function getImageHandler(h: HandlerContext): Handler<Env> {
  return async (c) => {
    c.header("Cache-Control", "no-store");
    let input;
    try {
      input = await bind(c, getImageRequest);
    } catch {
      throw new APIError(403, "image_forbidden");
    }
    const query = parseQuery(rawQuery(c));
    if (query.error !== null || query.values.get("exp")?.length !== 1 || query.values.get("sig")?.length !== 1) {
      throw new APIError(403, "image_forbidden");
    }
    const exp = parseImageExp(input.exp);
    if (exp === null || exp <= unix(Temporal.Now.instant())) {
      throw new APIError(403, "image_forbidden");
    }
    const sig = Buffer.from(input.sig, "base64url");
    if (sig.length !== 32 || sig.toString("base64url") !== input.sig) {
      throw new APIError(403, "image_forbidden");
    }

    const owner = await h.db.get<{ secret_key_hash: string; owner_user_id: string; created_at: Temporal.Instant; signature_cache_generation: string }>(
      `
   SELECT u.secret_key_hash, i.owner_user_id, i.created_at,
     (SELECT generation::text FROM image_signature_cache_state WHERE singleton) AS signature_cache_generation
   FROM image_objects i JOIN users u ON u.id = i.owner_user_id
   WHERE i.id = $1 AND u.status = 'active'
  `,
      input.imageId,
    );
    if (!owner) {
      throw new APIError(403, "image_forbidden");
    }
    const key = imageSigningKey(owner.secret_key_hash);
    const expected = withImageSignatureCacheGeneration(owner.signature_cache_generation,
      () => imageSignature(key, input.imageId, input.exp));
    if (!timingSafeEqual(sig, expected)) {
      c.set("abuse", "invalid_signature");
      throw new APIError(403, "image_forbidden");
    }

    // 所有者検索で得た日時でpartitionを絞り、ユーザーもPKで検索する。
    // 削除状態はこのSQLで改めて確認し、署名検証前には画像本体を取得しない。
    const object = await h.db.get<{ data: Uint8Array<ArrayBuffer>; media_type: string }>(
      `
   SELECT i.data, i.media_type
   FROM image_objects i JOIN users u ON u.id = i.owner_user_id AND u.status = 'active'
   WHERE i.id = $1 AND i.created_at = $2 AND u.id = $3 AND (
     u.profile_image_id = i.id
     OR EXISTS (
       SELECT 1 FROM posts p
       WHERE p.image_id = i.id AND p.author_id = u.id AND p.deleted_at IS NULL
     )
     OR EXISTS (
       SELECT 1 FROM realmojis r
       JOIN posts p ON p.id = r.post_id AND p.deleted_at IS NULL
       JOIN users author ON author.id = p.author_id AND author.status = 'active'
       WHERE r.image_id = i.id AND r.reactor_id = u.id AND r.replaced_at IS NULL AND r.deleted_at IS NULL
     )
   )
  `,
      input.imageId,
      owner.created_at,
      owner.owner_user_id,
    );
    if (!object) {
      throw new APIError(403, "image_forbidden");
    }
    if (exp <= unix(Temporal.Now.instant())) {
      throw new APIError(403, "image_forbidden");
    }
    return blobResponse(c, 200, object.media_type, object.data);
  };
}
