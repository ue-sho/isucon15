import type { Queryer } from "./db.ts";
import { postColumns, postFromRow } from "./post.ts";
import { newPostResponse, type PostResponse } from "./post_api.ts";
import { setImageKey, userColumnsAs, userFromRow } from "./user.ts";

// 閲覧条件をすべて適用した後で51件に制限する。直接の友達なので二段階の探索は不要。
export async function getFriendsFeed(db: Queryer, viewerID: string, beforePostedAt: Temporal.Instant | null, beforeID: string): Promise<{ items: PostResponse[]; hasMore: boolean }> {
  // 初回とcursorありの2形状。generic planでNULLとのORにより件数を過小推定させない。
  const cursor = beforePostedAt === null ? "" : "AND (p.posted_at, p.id) < ($2::timestamptz, $3)";
  const args = beforePostedAt === null ? [viewerID] : [viewerID, beforePostedAt, beforeID];
  const rows = await db.select(`
    WITH active_windows AS MATERIALIZED (
      SELECT id, on_time_deadline, ended_at FROM posting_windows WHERE ended_at IS NULL
    )
    SELECT ${postColumns}, ${userColumnsAs("u", "author")}
    FROM posts p
    JOIN active_windows w ON w.id = p.posting_window_id
    JOIN users u ON u.id = p.author_id AND u.status = 'active'
    WHERE p.deleted_at IS NULL AND p.author_id <> $1
      AND p.visibility IN ('public', 'friends', 'friends_of_friends')
      AND p.author_id = ANY(ARRAY(
        SELECT CASE WHEN f.user_low_id = $1 THEN f.user_high_id ELSE f.user_low_id END
        FROM friendships f WHERE f.user_low_id = $1 OR f.user_high_id = $1
      ))
      AND NOT EXISTS (
        SELECT 1 FROM block_relations b
        WHERE (b.blocker_id = $1 AND b.blocked_id = p.author_id)
           OR (b.blocker_id = p.author_id AND b.blocked_id = $1)
      )
      AND EXISTS (
        SELECT 1 FROM users viewer
        WHERE viewer.id = $1 AND viewer.status = 'active'
          AND EXISTS (
            SELECT 1 FROM posts own
            JOIN posting_windows posted ON posted.id = own.posting_window_id
            JOIN posting_windows current ON current.region = viewer.region AND current.ended_at IS NULL
                                        AND current.local_date = posted.local_date
            WHERE own.author_id = viewer.id AND own.deleted_at IS NULL
          )
      )
      ${cursor}
    ORDER BY p.posted_at DESC, p.id DESC
    LIMIT 51
  `, ...args);
  // 51件目はhasMore専用。作者・投稿の変換、画像署名、応答生成は50件まで。
  const items = rows.slice(0, 50).map((row) => {
    const author = userFromRow(row, "author");
    setImageKey(author);
    return newPostResponse(postFromRow(row), author);
  });
  return { items, hasMore: rows.length > 50 };
}
