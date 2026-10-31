import { timingSafeEqual } from "node:crypto";
import type { Handler } from "hono";
import { APIError } from "./api_error.ts";
import { bind, parseQuery, rawQuery } from "./bind.ts";
import { imageSignature, imageSigningKey } from "./image_signature.ts";
import { blobResponse } from "./response.ts";
import { imageFileGenerationSQL } from "./image_files.ts";
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

    const owner = await h.db.get<{ secret_key_hash: string; owner_user_id: string; created_at: Temporal.Instant; image_version: string; image_cache_generation: string; image_file_generation: string; media_type: string }>(
      `
   SELECT u.secret_key_hash, i.owner_user_id, i.created_at
   ${h.imageFiles ? ` , i.xmin::text AS image_version, b.image_cache_generation, i.media_type, ${imageFileGenerationSQL} AS image_file_generation` : ""}
   FROM image_objects i JOIN users u ON u.id = i.owner_user_id
   ${h.imageFiles ? "CROSS JOIN initial_data_boundary b" : ""}
   WHERE i.id = $1 AND u.status = 'active'
  `,
      input.imageId,
    );
    if (!owner) {
      throw new APIError(403, "image_forbidden");
    }
    const key = imageSigningKey(owner.secret_key_hash);
    if (!timingSafeEqual(sig, imageSignature(key, input.imageId, input.exp))) {
      c.set("abuse", "invalid_signature");
      throw new APIError(403, "image_forbidden");
    }

    const file = h.imageFiles?.reference(owner.image_file_generation, input.imageId, owner.owner_user_id, owner.created_at, owner.image_version, owner.media_type);
    const cached = file !== undefined && await h.imageFiles!.has(file);

    // 命中時も所有者・削除・差し替えをDBで再確認し、byteaだけを取得しない。
    // 削除状態はこのSQLで改めて確認し、署名検証前には画像本体を取得しない。
    const object = await h.db.get<{ data: Uint8Array<ArrayBuffer>; media_type: string }>(
      `
   SELECT ${cached ? "NULL::bytea AS data" : "i.data"}, i.media_type
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
   ${h.imageFiles ? "AND (SELECT image_cache_generation FROM initial_data_boundary) = $4 AND i.xmin::text = $5" : ""}
  `,
      input.imageId,
      owner.created_at,
      owner.owner_user_id,
      ...(h.imageFiles ? [owner.image_cache_generation, owner.image_version] : []),
    );
    if (!object) {
      throw new APIError(403, "image_forbidden");
    }
    if (exp <= unix(Temporal.Now.instant())) {
      throw new APIError(403, "image_forbidden");
    }
    if (file && (cached || await h.imageFiles!.put(file, object.data))) {
      if (exp <= unix(Temporal.Now.instant())) throw new APIError(403, "image_forbidden");
      c.header("Content-Type", object.media_type);
      c.header("X-Accel-Redirect", file.uri);
      return c.body(null, 200);
    }
    return blobResponse(c, 200, object.media_type, object.data);
  };
}
