import { createHash, timingSafeEqual } from "node:crypto";
import type { Context, Handler } from "hono";
import { APIError } from "./api_error.ts";
import { bind, parseQuery, rawQuery } from "./bind.ts";
import { imageSignature, imageSigningKey, withImageSignatureCacheGeneration } from "./image_signature.ts";
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

type ImageOwner = { secret_key_hash: string; owner_user_id: string; created_at: Temporal.Instant; image_version: string; image_cache_generation: string; image_file_generation: string; media_type: string; signature_cache_generation: string };

export function getImageHandler(h: HandlerContext): Handler<Env> {
  // 認可結果ではなく探索用ヒント。命中しても下のSQLで現在の状態を照合する。
  const hints = new Map<string, ImageOwner>();
  async function handle(c: Context<Env>, useHint = true): Promise<Response> {
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

    const hintKey = JSON.stringify([input.imageId, input.exp, input.sig]);
    const hint = useHint && h.imageFiles ? hints.get(hintKey) : undefined;
    const owner = hint ?? await h.db.get<ImageOwner>(
      `
   SELECT u.secret_key_hash, i.owner_user_id, i.created_at,
     (SELECT generation::text FROM image_signature_cache_state WHERE singleton) AS signature_cache_generation
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
    const expected = withImageSignatureCacheGeneration(owner.signature_cache_generation,
      () => imageSignature(key, input.imageId, input.exp));
    if (!timingSafeEqual(sig, expected)) {
      c.set("abuse", "invalid_signature");
      throw new APIError(403, "image_forbidden");
    }

    const file = h.imageFiles?.reference(owner.image_file_generation, input.imageId, owner.owner_user_id, owner.created_at, owner.image_version, owner.media_type);
    const cached = file !== undefined && await h.imageFiles!.has(file);

    // 命中時も所有者・削除・差し替えをDBで再確認し、画像本体だけを取得しない。
    // 削除状態はこのSQLで改めて確認し、署名検証前には画像本体を取得しない。
    // 未命中時はbyteaのhex表現（元画像の2倍）を避け、base64で転送する。
    const object = await h.db.get<{ data_base64: string | null; media_type: string }>(
      `
   SELECT ${cached ? "NULL::text" : "encode(i.data, 'base64')"} AS data_base64, i.media_type
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
   ${hint ? `AND encode(sha256(convert_to(u.secret_key_hash, 'UTF8')), 'hex') = $6
     AND (SELECT generation::text FROM image_signature_cache_state WHERE singleton) = $7` : ""}
  `,
      input.imageId,
      owner.created_at,
      owner.owner_user_id,
      ...(h.imageFiles ? [owner.image_cache_generation, owner.image_version] : []),
      ...(hint ? [createHash("sha256").update(owner.secret_key_hash).digest("hex"), owner.signature_cache_generation] : []),
    );
    if (!object) {
      // 更新・初期化・鍵変更時はヒントを捨て、現在のDBから通常経路で再取得。
      if (hint) {
        hints.delete(hintKey);
        return handle(c, false);
      }
      throw new APIError(403, "image_forbidden");
    }
    if (exp <= unix(Temporal.Now.instant())) {
      throw new APIError(403, "image_forbidden");
    }
    // cachedなら必ずfileがあり、下のredirect経路で返す。本体の復元は未命中時だけ。
    const data = cached ? null : Buffer.from(object.data_base64!, "base64");
    if (file && (cached || await h.imageFiles!.put(file, data!))) {
      if (exp <= unix(Temporal.Now.instant())) throw new APIError(403, "image_forbidden");
      c.header("Content-Type", object.media_type);
      c.header("X-Accel-Redirect", file.uri);
      if (hintKey.length <= 4096) {
        hints.delete(hintKey);
        if (hints.size >= 2048) hints.delete(hints.keys().next().value!);
        hints.set(hintKey, owner);
      }
      return c.body(null, 200);
    }
    return blobResponse(c, 200, object.media_type, data!);
  }
  return (c) => handle(c);
}
