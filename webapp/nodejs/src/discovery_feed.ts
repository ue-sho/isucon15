import type { Queryer, Row } from "./db.ts";
import { postColumns, postFromRow } from "./post.ts";
import { newPostResponse, type PostResponse } from "./post_api.ts";
import { setImageKey, userColumnsAs, userFromRow } from "./user.ts";

type DiscoveryFeedResponse = { items: (PostResponse & { score?: number })[]; hasMore: boolean };

// 認可・地域・投稿済み判定はリクエストをまたいで保持せず、同じSQLの状態で読む。
const viewerPosted = `EXISTS (
  SELECT 1 FROM users viewer
  WHERE viewer.id = $1 AND viewer.status = 'active'
    AND EXISTS (
      SELECT 1 FROM posts own
      JOIN posting_windows posted ON posted.id = own.posting_window_id
      JOIN posting_windows current ON current.region = viewer.region AND current.ended_at IS NULL
                                  AND current.local_date = posted.local_date
      WHERE own.author_id = viewer.id AND own.deleted_at IS NULL
    )
)`;

const directFriends = `direct_friends AS MATERIALIZED (
  SELECT DISTINCT CASE WHEN f.user_low_id = $1 THEN f.user_high_id ELSE f.user_low_id END AS id
  FROM friendships f WHERE f.user_low_id = $1 OR f.user_high_id = $1
)`;

const unblocked = `NOT EXISTS (
  SELECT 1 FROM block_relations b
  WHERE (b.blocker_id = $1 AND b.blocked_id = p.author_id)
     OR (b.blocked_id = $1 AND b.blocker_id = p.author_id)
)`;

function response(rows: Row[], ranked: boolean): DiscoveryFeedResponse {
  const items = rows.slice(0, 50).map((row) => {
    const author = userFromRow(row, "author");
    setImageKey(author);
    const item: PostResponse & { score?: number } = newPostResponse(postFromRow(row), author);
    if (ranked) item.score = Number(row.recommendation_score);
    return item;
  });
  return { items, hasMore: rows.length > 50 };
}

export async function getFollowingFeed(db: Queryer, viewerID: string, beforePostedAt: Temporal.Instant | null, beforeID: string): Promise<DiscoveryFeedResponse> {
  const cursor = beforePostedAt === null ? "" : "AND (p.posted_at, p.id) < ($2::timestamptz, $3)";
  const args = beforePostedAt === null ? [viewerID] : [viewerID, beforePostedAt, beforeID];
  const rows = await db.select(`
    WITH active_windows AS MATERIALIZED (
      SELECT id, on_time_deadline, ended_at FROM posting_windows WHERE ended_at IS NULL
    ), ${directFriends}
    SELECT ${postColumns}, ${userColumnsAs("u", "author")}
    FROM posts p
    JOIN active_windows w ON w.id = p.posting_window_id
    JOIN users u ON u.id = p.author_id AND u.status = 'active'
    WHERE p.deleted_at IS NULL AND p.author_id <> $1
      AND ${viewerPosted}
      AND p.author_id = ANY(ARRAY(SELECT followee_id FROM follows WHERE follower_id = $1))
      AND ${unblocked}
      AND (
        p.visibility = 'public'
        OR (p.visibility IN ('friends', 'friends_of_friends')
            AND p.author_id = ANY(ARRAY(SELECT id FROM direct_friends)))
        OR (p.visibility = 'friends_of_friends' AND EXISTS (
          SELECT 1 FROM friendships f
          WHERE (f.user_low_id = p.author_id AND f.user_high_id = ANY(ARRAY(SELECT id FROM direct_friends)))
             OR (f.user_high_id = p.author_id AND f.user_low_id = ANY(ARRAY(SELECT id FROM direct_friends)))
        ))
      )
      ${cursor}
    ORDER BY p.posted_at DESC, p.id DESC
    LIMIT 51
  `, ...args);
  return response(rows, false);
}

export async function getFriendsOfFriendsFeed(db: Queryer, viewerID: string, beforeScore: number | null, beforePostedAt: Temporal.Instant | null, beforeID: string): Promise<DiscoveryFeedResponse> {
  // 従来のランキングcursorはTemporalで比較する。DBのmicrosecondへの丸めを避け、
  // epoch nanosecondsをnumericで比較する。投稿IDはUUIDなのでC順序がJSの比較と一致する。
  const cursor = beforeScore === null ? "" : `WHERE recommendation_score < $2
      OR (recommendation_score = $2 AND
          (extract(epoch FROM posted_at) * 1000000000, id COLLATE "C") < ($3::numeric, $4 COLLATE "C"))`;
  const args = beforeScore === null ? [viewerID] : [viewerID, beforeScore, beforePostedAt!.epochNanoseconds.toString(), beforeID];
  const rows = await db.select(`
    WITH active_windows AS MATERIALIZED (
      SELECT id, on_time_deadline, ended_at FROM posting_windows WHERE ended_at IS NULL
    ), current_posts AS MATERIALIZED (
      -- 先に現在枠だけへ絞る。友達グラフの行数推定が外れても作者ごとの
      -- 全履歴をNested Loopで繰り返し取得しない。
      SELECT p.id, p.author_id, p.posted_at
      FROM posts p JOIN active_windows w ON w.id = p.posting_window_id
      WHERE p.deleted_at IS NULL AND p.author_id <> $1
        AND p.visibility IN ('public', 'friends_of_friends') AND ${viewerPosted}
    ), ${directFriends},
    mutual_friends AS MATERIALIZED (
      SELECT neighbor.id, count(*) AS mutual_count
      FROM (
        SELECT f.user_high_id AS id FROM friendships f
        JOIN direct_friends direct ON direct.id = f.user_low_id
        UNION ALL
        SELECT f.user_low_id AS id FROM friendships f
        JOIN direct_friends direct ON direct.id = f.user_high_id
      ) neighbor
      WHERE neighbor.id <> $1
      GROUP BY neighbor.id
    ), candidates AS MATERIALIZED (
      SELECT p.id, p.author_id, p.posted_at, mutual.mutual_count
      FROM current_posts p
      JOIN users u ON u.id = p.author_id AND u.status = 'active'
      JOIN mutual_friends mutual ON mutual.id = p.author_id
      WHERE ${viewerPosted}
        AND NOT (p.author_id = ANY(ARRAY(SELECT id FROM direct_friends)))
        AND ${unblocked}
    ), candidate_authors AS MATERIALIZED (
      SELECT DISTINCT author_id FROM candidates
    ), connections AS (
      SELECT edge.author_id, sum(mutual.mutual_count) AS connection_count
      FROM (
        SELECT f.user_low_id AS author_id, f.user_high_id AS neighbor
        FROM friendships f JOIN candidate_authors candidate ON candidate.author_id = f.user_low_id
        UNION ALL
        SELECT f.user_high_id AS author_id, f.user_low_id AS neighbor
        FROM friendships f JOIN candidate_authors candidate ON candidate.author_id = f.user_high_id
      ) edge
      JOIN mutual_friends mutual ON mutual.id = edge.neighbor
      GROUP BY edge.author_id
    ), engagements AS (
      SELECT actor.post_id, count(*) AS engagement_count
      FROM (
        SELECT r.post_id, r.reactor_id AS user_id
        FROM candidates p JOIN realmojis r ON r.post_id = p.id
        JOIN users reactor ON reactor.id = r.reactor_id AND reactor.status = 'active'
        WHERE r.replaced_at IS NULL AND r.deleted_at IS NULL
          AND r.reactor_id = ANY(ARRAY(SELECT id FROM direct_friends))
        UNION
        SELECT c.post_id, c.author_id AS user_id
        FROM candidates p JOIN comments c ON c.post_id = p.id
        JOIN users commenter ON commenter.id = c.author_id AND commenter.status = 'active'
        WHERE c.deleted_at IS NULL
          AND c.author_id = ANY(ARRAY(SELECT id FROM direct_friends))
      ) actor
      GROUP BY actor.post_id
    ), scored AS (
      SELECT p.*, 10 * coalesce(engagements.engagement_count, 0) + 3 * p.mutual_count
                   + least(coalesce(connections.connection_count, 0), 30) AS recommendation_score
      FROM candidates p
      LEFT JOIN connections ON connections.author_id = p.author_id
      LEFT JOIN engagements ON engagements.post_id = p.id
    ), ranked_page AS MATERIALIZED (
      SELECT id, recommendation_score FROM scored
      ${cursor}
      ORDER BY recommendation_score DESC, posted_at DESC, id DESC
      LIMIT 51
    )
    SELECT ${postColumns}, ${userColumnsAs("u", "author")}, page.recommendation_score
    FROM ranked_page page JOIN posts p ON p.id = page.id
    JOIN active_windows w ON w.id = p.posting_window_id
    JOIN users u ON u.id = p.author_id
    ORDER BY page.recommendation_score DESC, p.posted_at DESC, p.id DESC
  `, ...args);
  return response(rows, true);
}
