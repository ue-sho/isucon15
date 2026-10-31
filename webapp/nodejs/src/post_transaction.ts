import { randomUUID } from "node:crypto";
import { APIError } from "./api_error.ts";
import { must, type Queryer, type Row } from "./db.ts";
import { postFromRow, type Post, type PostLocation } from "./post.ts";
import { setImageKey, userFromRow, type User } from "./user.ts";

export const postTransactionSignature = "public.isureal_create_post_v1(text,text,text,bytea,text,text,text,numeric,numeric,text)";
type PostTransactionResult = { error: "no_rows" | "post_slot_unavailable" } | { post: Row; user: Row };

// トランザクションを外からBEGINしない。入力を送信した後にDB内でロックを取得し、
// 関数呼出し1回のimplicit transactionで確定してから結果を受け取る。
export async function createPostTransaction(db: Queryer, userID: string, image: Buffer, caption: string, visibility: string, location: PostLocation): Promise<{ post: Post; user: User }> {
  const { result } = must(await db.get<{ result: PostTransactionResult }>(`
    SELECT public.isureal_create_post_v1(
      $1::text, $2::text, $3::text, $4::bytea, $5::text,
      $6::text, $7::text, $8::numeric, $9::numeric, $10::text
    ) AS result
  `, userID, randomUUID(), randomUUID(), image, caption, visibility, location.kind, location.latitude, location.longitude, location.locality));
  if ("error" in result) {
    if (result.error === "no_rows") must(undefined);
    throw new APIError(409, result.error);
  }
  const row = result.post;
  row.posted_at = Temporal.Instant.from(row.posted_at);
  row.on_time_deadline = Temporal.Instant.from(row.on_time_deadline);
  row.window_ended_at = row.window_ended_at === null ? null : Temporal.Instant.from(row.window_ended_at);
  const user = userFromRow(result.user);
  setImageKey(user);
  return { post: postFromRow(row), user };
}
