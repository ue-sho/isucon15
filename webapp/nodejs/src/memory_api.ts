import type { Handler } from "hono";
import { APIError } from "./api_error.ts";
import { bind } from "./bind.ts";
import { newCommentResponse, type CommentResponse } from "./comment_api.ts";
import type { Queryer } from "./db.ts";
import { selectPostsWithAuthor } from "./post.ts";
import { newPostResponse, type PostResponse } from "./post_api.ts";
import { selectMemoryInteractions } from "./memory_interactions.ts";
import { newRealMojiResponse, type RealMojiResponse } from "./realmoji_api.ts";
import { jsonResponse } from "./response.ts";
import type { Env, HandlerContext } from "./server.ts";
import { getSession } from "./session.ts";
import { validDate } from "./time.ts";

const getMemoriesRequest = {
  month: { query: "month" },
  beforePostedAt: { query: "beforePostedAt", type: "time" },
  beforeId: { query: "beforeId" },
} as const;

type MemoryPostResponse = PostResponse & {
  realmojis: RealMojiResponse[];
  comments: CommentResponse[];
};

type GetMemoriesResponse = {
  items: MemoryPostResponse[];
  hasMore: boolean;
};

const getMemoriesByDateRequest = {
  date: { param: "date" },
  beforePostedAt: { query: "beforePostedAt", type: "time" },
  beforeId: { query: "beforeId" },
} as const;

export function getMemoriesHandler(h: HandlerContext): Handler<Env> {
  return async (c) => {
    const input = await bind(c, getMemoriesRequest);
    const match = /^(\d{4})-(\d{2})$/.exec(input.month);
    if (match === null || !validDate(Number(match[1]), Number(match[2]), 1)) {
      throw new APIError(400, "invalid_memory_period");
    }
    const start = Temporal.PlainDate.from({ year: Number(match[1]), month: Number(match[2]), day: 1 });
    const response = await listMemories(
      h.db,
      getSession(c)!.userID,
      start.toString(),
      start.add({ months: 1 }).toString(),
      input.beforePostedAt,
      input.beforeId,
    );
    return jsonResponse(c, 200, response);
  };
}

export function getMemoriesByDateHandler(h: HandlerContext): Handler<Env> {
  return async (c) => {
    const input = await bind(c, getMemoriesByDateRequest);
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(input.date);
    if (match === null || !validDate(Number(match[1]), Number(match[2]), Number(match[3]))) {
      throw new APIError(400, "invalid_memory_period");
    }
    const start = Temporal.PlainDate.from({ year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) });
    const response = await listMemories(
      h.db,
      getSession(c)!.userID,
      start.toString(),
      start.add({ days: 1 }).toString(),
      input.beforePostedAt,
      input.beforeId,
    );
    return jsonResponse(c, 200, response);
  };
}

async function listMemories(
  db: Queryer,
  userID: string,
  start: string,
  end: string,
  beforeAt: Temporal.Instant | null,
  beforeID: string,
): Promise<GetMemoriesResponse> {
  if ((beforeAt === null) !== (beforeID === "")) {
    throw new APIError(400, "invalid_pagination");
  }
  const posts = await selectPostsWithAuthor(
    db,
    `
  AND p.author_id = $1 AND w.local_date >= $2 AND w.local_date < $3
  AND ($4::timestamptz IS NULL OR (p.posted_at, p.id) < ($4, $5))
  ORDER BY p.posted_at DESC, p.id DESC LIMIT 51
 `,
    userID,
    start,
    end,
    beforeAt,
    beforeID,
  );
  const hasMore = posts.length > 50;
  const page = posts.slice(0, 50);
  // Finish both reads before response construction/signing; hold at most one connection.
  const interactions = await selectMemoryInteractions(db, page.map(({ post }) => post.id));
  const items: MemoryPostResponse[] = page.map((post) => ({
    ...newPostResponse(post.post, post.author),
    realmojis: [],
    comments: [],
  }));
  loadMemoryInteractions(interactions, items);
  return { items, hasMore };
}

function loadMemoryInteractions(
  { reactions, comments }: Awaited<ReturnType<typeof selectMemoryInteractions>>,
  items: MemoryPostResponse[],
): void {
  const itemByPostID = new Map(items.map((item) => [item.id, item]));
  for (const reaction of reactions) {
    const item = itemByPostID.get(reaction.realMoji.postID)!;
    if (item.realmojis.length < 50) {
      item.realmojis.push(newRealMojiResponse(reaction.realMoji, reaction.reactor));
    }
  }
  for (const comment of comments) {
    const item = itemByPostID.get(comment.comment.postID)!;
    if (item.comments.length < 50) {
      item.comments.push(newCommentResponse(comment.comment, comment.author));
    }
  }
}
