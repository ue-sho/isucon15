import type { Handler } from "hono";
import { APIError } from "./api_error.ts";
import { bind } from "./bind.ts";
import { getFollowingFeed, getFriendsOfFriendsFeed } from "./discovery_feed.ts";
import { getFriendsFeed } from "./friends_feed.ts";
import { canView, loadViewerContext, selectPostsWithAuthor, type PostWithAuthor } from "./post.ts";
import { newPostResponse, type PostResponse } from "./post_api.ts";
import { jsonResponse } from "./response.ts";
import type { Env, HandlerContext } from "./server.ts";
import { getSession } from "./session.ts";

const getFeedRequest = {
  feed: { param: "feed" },
  beforeScore: { query: "beforeScore", type: "int" },
  beforePostedAt: { query: "beforePostedAt", type: "time" },
  beforeId: { query: "beforeId" },
} as const;

type FeedItemResponse = PostResponse & {
  score?: number;
};

type GetFeedResponse = {
  items: FeedItemResponse[];
  hasMore: boolean;
};

export function getFeedHandler(h: HandlerContext): Handler<Env> {
  return async (c) => {
    const input = await bind(c, getFeedRequest);
    switch (input.feed) {
      case "friends":
      case "friends-of-friends":
      case "public":
      case "following":
        break;
      default:
        throw new APIError(400, "invalid_post");
    }
    if ((input.beforePostedAt === null) !== (input.beforeId === "")) {
      throw new APIError(400, "invalid_pagination");
    }
    const ranked = input.feed === "friends-of-friends";
    if (ranked && (input.beforeScore === null) !== (input.beforeId === "")) {
      throw new APIError(400, "invalid_pagination");
    }
    const session = getSession(c)!;
    if (input.feed === "friends") {
      return jsonResponse(c, 200, await getFriendsFeed(h.db, session.userID, input.beforePostedAt, input.beforeId));
    }
    if (input.feed === "following") {
      return jsonResponse(c, 200, await getFollowingFeed(h.db, session.userID, input.beforePostedAt, input.beforeId));
    }
    if (input.feed === "friends-of-friends") {
      return jsonResponse(c, 200, await getFriendsOfFriendsFeed(h.db, session.userID, input.beforeScore, input.beforePostedAt, input.beforeId));
    }
    const viewer = await loadViewerContext(h.db, session.userID, session.user, { requirePostedToday: true, publicFeed: true });
    if (!viewer) {
      const response: GetFeedResponse = { items: [], hasMore: false };
      return jsonResponse(c, 200, response);
    }
    const posts = await selectPostsWithAuthor(
      h.db,
      `
   AND p.author_id <> $1 AND w.ended_at IS NULL
   AND ($2::timestamptz IS NULL OR (p.posted_at, p.id) < ($2, $3))
   AND p.visibility = 'public'
   AND NOT EXISTS (
     SELECT 1 FROM block_relations b
     WHERE (b.blocker_id = $1 AND b.blocked_id = p.author_id)
        OR (b.blocked_id = $1 AND b.blocker_id = p.author_id)
   )
   ORDER BY p.posted_at DESC, p.id DESC
   LIMIT 51
  `,
      viewer.user.id,
      input.beforePostedAt,
      input.beforeId,
    );
    const candidates: PostWithAuthor[] = [];
    for (const post of posts) {
      if (canView(viewer, post.post)) {
        candidates.push(post);
      }
    }
    const items: FeedItemResponse[] = [];
    let hasMore = false;
    for (const post of candidates) {
      if (items.length === 50) {
        hasMore = true;
        break;
      }
      const item: FeedItemResponse = newPostResponse(post.post, post.author);
      items.push(item);
    }
    const response: GetFeedResponse = { items, hasMore };
    return jsonResponse(c, 200, response);
  };
}
