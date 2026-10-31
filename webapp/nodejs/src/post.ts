import { must, type Queryer, type Row } from "./db.ts";
import { getUser, setImageKey, userColumnsAs, userFromRow, validUserText, type User } from "./user.ts";

export type PostLocation = {
  kind: string;
  latitude: number | null;
  longitude: number | null;
  locality: string | null;
};

export function validLocation(location: PostLocation): boolean {
  switch (location.kind) {
    case "none":
      return location.latitude === null && location.longitude === null && location.locality === null;
    case "exact":
      return (
        location.latitude !== null &&
        location.longitude !== null &&
        location.locality === null &&
        location.latitude >= -90 &&
        location.latitude <= 90 &&
        location.longitude >= -180 &&
        location.longitude <= 180
      );
    case "approximate":
      return location.latitude === null && location.longitude === null && location.locality !== null && validUserText(location.locality, 1, 100);
    default:
      return false;
  }
}

export type Post = {
  id: string;
  authorID: string;
  postingWindowID: string;
  imageID: string;
  caption: string;
  visibility: string;
  location: PostLocation;
  postedAt: Temporal.Instant;
  onTimeDeadline: Temporal.Instant;
  windowEndedAt: Temporal.Instant | null;
};

export const postColumns = `p.id, p.author_id, p.posting_window_id, p.image_id, p.caption, p.visibility,
  p.location_kind, p.latitude, p.longitude, p.locality, p.posted_at,
  w.on_time_deadline, w.ended_at AS window_ended_at`;

export function postFromRow(row: Row): Post {
  return {
    id: row.id,
    authorID: row.author_id,
    postingWindowID: row.posting_window_id,
    imageID: row.image_id,
    caption: row.caption,
    visibility: row.visibility,
    location: { kind: row.location_kind, latitude: row.latitude, longitude: row.longitude, locality: row.locality },
    postedAt: row.posted_at,
    onTimeDeadline: row.on_time_deadline,
    windowEndedAt: row.window_ended_at,
  };
}

export async function getPost(db: Queryer, postID: string): Promise<Post | undefined> {
  const row = await db.get(
    `
  SELECT ${postColumns}
  FROM posts p JOIN posting_windows w ON w.id = p.posting_window_id
  WHERE p.id = $1 AND p.deleted_at IS NULL
 `,
    postID,
  );
  return row === undefined ? undefined : postFromRow(row);
}

export type PostWithAuthor = {
  post: Post;
  author: User;
};

export async function selectPostsWithAuthor(db: Queryer, conditions: string, ...args: unknown[]): Promise<PostWithAuthor[]> {
  const rows = await db.select(
    `
  SELECT ${postColumns}, ${userColumnsAs("u", "author")}
  FROM posts p
  JOIN posting_windows w ON w.id = p.posting_window_id
  JOIN users u ON u.id = p.author_id AND u.status = 'active'
  WHERE p.deleted_at IS NULL ${conditions}`,
    ...args,
  );
  return rows.map((row) => {
    const author = userFromRow(row, "author");
    setImageKey(author);
    return { post: postFromRow(row), author };
  });
}

export async function getPostWithAuthor(db: Queryer, postID: string): Promise<PostWithAuthor | undefined> {
  const posts = await selectPostsWithAuthor(db, `AND p.id = $1`, postID);
  return posts[0];
}

export type ViewerContext = {
  user: User;
  hasPostedToday: boolean;
  friends: Set<string>;
  friendsOfFriends: Set<string>;
  mutualFriends: Map<string, number>;
  blocked: Set<string>;
};

export async function loadViewerContext(db: Queryer, viewerID: string, authenticatedUser?: User, options: { requirePostedToday?: boolean; publicFeed?: boolean } = {}): Promise<ViewerContext | undefined> {
  const user = authenticatedUser?.id === viewerID ? authenticatedUser : await getUser(db, viewerID);
  if (!user) {
    return undefined;
  }
  const viewer: ViewerContext = { user, hasPostedToday: false, friends: new Set(), friendsOfFriends: new Set(), mutualFriends: new Map(), blocked: new Set() };
  const posted = must(await db.get<{ exists: boolean }>(
    `
  SELECT EXISTS(
    SELECT 1 FROM posts p
    JOIN posting_windows posted ON posted.id = p.posting_window_id
    JOIN posting_windows current ON current.region = $2 AND current.ended_at IS NULL
                                AND current.local_date = posted.local_date
    WHERE p.author_id = $1 AND p.deleted_at IS NULL
  )
 `,
    viewer.user.id,
    viewer.user.region,
  ));
  viewer.hasPostedToday = posted.exists;
  // フィードは本人の投稿を含まないため、未投稿なら関係情報も不要。
  if (options.requirePostedToday && !viewer.hasPostedToday) {
    return undefined;
  }
  // public feedは候補SQLで双方向blockを判定し、友達関係を使用しない。
  if (options.publicFeed) return viewer;
  viewer.blocked = await getBlockedUserIDs(db, viewer.user.id);
  const friends = await getFriendIDs(db, viewer.user.id);
  if (friends.length === 0) {
    return viewer;
  }
  for (const id of friends) {
    viewer.friends.add(id);
  }
  const lowPlaceholders = friends.map((_, i) => `$${i + 1}`).join(", ");
  const highPlaceholders = friends.map((_, i) => `$${friends.length + i + 1}`).join(", ");
  const friendships = await db.select<{ user_low_id: string; user_high_id: string }>(
    `SELECT user_low_id, user_high_id FROM friendships WHERE user_low_id IN (${lowPlaceholders}) OR user_high_id IN (${highPlaceholders})`,
    ...friends,
    ...friends,
  );
  for (const friendship of friendships) {
    if (viewer.friends.has(friendship.user_low_id)) {
      viewer.friendsOfFriends.add(friendship.user_high_id);
      if (friendship.user_high_id !== viewer.user.id) {
        viewer.mutualFriends.set(friendship.user_high_id, (viewer.mutualFriends.get(friendship.user_high_id) ?? 0) + 1);
      }
    }
    if (viewer.friends.has(friendship.user_high_id)) {
      viewer.friendsOfFriends.add(friendship.user_low_id);
      if (friendship.user_low_id !== viewer.user.id) {
        viewer.mutualFriends.set(friendship.user_low_id, (viewer.mutualFriends.get(friendship.user_low_id) ?? 0) + 1);
      }
    }
  }
  return viewer;
}

export function canView(viewer: ViewerContext, post: Post): boolean {
  if (post.authorID === viewer.user.id) {
    return true;
  }
  if (post.windowEndedAt || !viewer.hasPostedToday || viewer.blocked.has(post.authorID)) {
    return false;
  }
  switch (post.visibility) {
    case "public":
      return true;
    case "friends":
      return viewer.friends.has(post.authorID);
    case "friends_of_friends":
      return viewer.friends.has(post.authorID) || viewer.friendsOfFriends.has(post.authorID);
    default:
      return false;
  }
}

export async function canViewPost(db: Queryer, viewerID: string, postID: string): Promise<boolean> {
  const post = await getPostWithAuthor(db, postID);
  if (!post) {
    return false;
  }
  return (await getPostPermissions(db, viewerID, post.post)).view;
}

export async function getFriendIDs(db: Queryer, userID: string): Promise<string[]> {
  const friendships = await db.select<{ user_low_id: string; user_high_id: string }>(
    `SELECT user_low_id, user_high_id FROM friendships WHERE user_low_id = $1 OR user_high_id = $1`,
    userID,
  );
  const ids: string[] = [];
  for (const friendship of friendships) {
    if (friendship.user_low_id === userID) {
      ids.push(friendship.user_high_id);
    } else {
      ids.push(friendship.user_low_id);
    }
  }
  return ids;
}

export async function getBlockedUserIDs(db: Queryer, userID: string): Promise<Set<string>> {
  const rows = await db.select<{ id: string }>(
    `
  SELECT CASE WHEN blocker_id = $1 THEN blocked_id ELSE blocker_id END AS id
  FROM block_relations WHERE blocker_id = $1 OR blocked_id = $1
 `,
    userID,
  );
  return new Set(rows.map((row) => row.id));
}

// 単一投稿では全友人グラフを転送せず、対象作者との関係だけを照会する。
// 書込Txから呼ぶ場合も認証時の情報を再利用せず、ロック後のDB状態を見る。
export async function getPostPermissions(db: Queryer, viewerID: string, post: Post): Promise<{ view: boolean; comment: boolean }> {
  const row = await db.get<{ has_posted: boolean; blocked: boolean; friend: boolean; friend_of_friend: boolean }>(`
    SELECT EXISTS (
      SELECT 1 FROM posts p JOIN posting_windows posted ON posted.id = p.posting_window_id
      JOIN posting_windows current ON current.region = u.region AND current.ended_at IS NULL
                                  AND current.local_date = posted.local_date
      WHERE p.author_id = u.id AND p.deleted_at IS NULL
    ) AS has_posted,
    EXISTS (
      SELECT 1 FROM block_relations
      WHERE (blocker_id = $1 AND blocked_id = $2) OR (blocker_id = $2 AND blocked_id = $1)
    ) AS blocked,
    EXISTS (
      SELECT 1 FROM friendships
      WHERE user_low_id = LEAST($1::text, $2::text) AND user_high_id = GREATEST($1::text, $2::text)
    ) AS friend,
    ($3::boolean AND EXISTS (
      SELECT 1 FROM friendships first
      JOIN friendships second ON
        (second.user_low_id = $2 AND second.user_high_id = CASE WHEN first.user_low_id = $1 THEN first.user_high_id ELSE first.user_low_id END)
        OR (second.user_high_id = $2 AND second.user_low_id = CASE WHEN first.user_low_id = $1 THEN first.user_high_id ELSE first.user_low_id END)
      WHERE first.user_low_id = $1 OR first.user_high_id = $1
    )) AS friend_of_friend
    FROM users u WHERE u.id = $1 AND u.status = 'active'
  `, viewerID, post.authorID, post.visibility === "friends_of_friends" && viewerID !== post.authorID);
  if (!row) return { view: false, comment: false };
  const own = viewerID === post.authorID;
  const visible = own || (!post.windowEndedAt && row.has_posted && !row.blocked && (
    post.visibility === "public" ||
    (post.visibility === "friends" && row.friend) ||
    (post.visibility === "friends_of_friends" && (row.friend || row.friend_of_friend))
  ));
  return {
    view: visible,
    comment: visible && !post.windowEndedAt && (own ? row.has_posted : post.visibility === "public" || row.friend),
  };
}
