import { commentFromRow, type CommentWithAuthor } from "./comment.ts";
import type { Queryer } from "./db.ts";
import { realMojiFromRow, type RealMojiWithReactor } from "./realmoji.ts";
import { setImageKey, userColumnsAs, userFromRow } from "./user.ts";

// Keep native PostgreSQL types (especially timestamptz) across the UNION.
// The rank is computed after eligibility filtering, independently per post.
const interactionSQL = `
  SELECT * FROM (
    SELECT 'realmoji'::text AS memory_kind, r.id, r.post_id,
           r.reactor_id AS actor_id, r.image_id, r.reaction_type,
           NULL::text AS body, r.created_at, r.deleted_at,
           ${userColumnsAs("u", "actor")},
           row_number() OVER (PARTITION BY r.post_id ORDER BY r.created_at DESC, r.id DESC) AS memory_rank
    FROM realmojis r JOIN users u ON u.id = r.reactor_id AND u.status = 'active'
    WHERE r.replaced_at IS NULL AND r.deleted_at IS NULL AND r.post_id = ANY($1::varchar[])
  ) r WHERE memory_rank <= 50
  UNION ALL
  SELECT * FROM (
    SELECT 'comment'::text AS memory_kind, c.id, c.post_id,
           c.author_id AS actor_id, NULL::varchar AS image_id, NULL::varchar AS reaction_type,
           c.body, c.created_at, c.deleted_at,
           ${userColumnsAs("u", "actor")},
           row_number() OVER (PARTITION BY c.post_id ORDER BY c.created_at ASC, c.id ASC) AS memory_rank
    FROM comments c JOIN users u ON u.id = c.author_id AND u.status = 'active'
    WHERE c.deleted_at IS NULL AND c.post_id = ANY($1::varchar[])
  ) c WHERE memory_rank <= 50
`;

export async function selectMemoryInteractions(db: Queryer, postIDs: string[]): Promise<{
  reactions: RealMojiWithReactor[];
  comments: CommentWithAuthor[];
}> {
  const reactions: RealMojiWithReactor[] = [];
  const comments: CommentWithAuthor[] = [];
  if (postIDs.length === 0) return { reactions, comments };
  const rows = await db.select(interactionSQL, postIDs);
  // UNION ALL does not promise an output order. Sort the bounded result by
  // post/rank so every post/kind retains its timestamp + ID order, without a second
  // wide-row sort in PostgreSQL (which can spill even after the per-post cap).
  rows.sort((a, b) => a.post_id < b.post_id ? -1 : a.post_id > b.post_id ? 1 : a.memory_rank - b.memory_rank);
  for (const row of rows) {
    const actor = userFromRow(row, "actor");
    setImageKey(actor);
    if (row.memory_kind === "realmoji") {
      row.reactor_id = row.actor_id;
      row.replaced_at = null;
      reactions.push({ realMoji: realMojiFromRow(row), reactor: actor });
    } else {
      row.author_id = row.actor_id;
      comments.push({ comment: commentFromRow(row), author: actor });
    }
  }
  return { reactions, comments };
}
