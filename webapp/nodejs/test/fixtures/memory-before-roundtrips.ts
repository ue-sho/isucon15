// Baseline: origin/main 993e1b0; SQL/response oracle for Memories only.
import type { Handler } from "hono";
import { APIError } from "../../src/api_error.ts";
import { bind } from "../../src/bind.ts";
import { newCommentResponse, type CommentResponse } from "../../src/comment_api.ts";
import { selectCommentsWithAuthor } from "../../src/comment.ts";
import type { Queryer } from "../../src/db.ts";
import { selectPostsWithAuthor } from "../../src/post.ts";
import { newPostResponse, type PostResponse } from "../../src/post_api.ts";
import { selectCurrentRealMojis } from "../../src/realmoji.ts";
import { newRealMojiResponse, type RealMojiResponse } from "../../src/realmoji_api.ts";
import { jsonResponse } from "../../src/response.ts";
import type { Env, HandlerContext } from "../../src/server.ts";
import { getSession } from "../../src/session.ts";
import { validDate } from "../../src/time.ts";

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
  const items: MemoryPostResponse[] = posts.slice(0, 50).map((post) => ({
    ...newPostResponse(post.post, post.author),
    realmojis: [],
    comments: [],
  }));
  await loadMemoryInteractions(db, items);
  return { items, hasMore };
}

async function loadMemoryInteractions(db: Queryer, items: MemoryPostResponse[]): Promise<void> {
  if (items.length === 0) {
    return;
  }
  const postIDs = items.map((item) => item.id);
  const itemByPostID = new Map(items.map((item) => [item.id, item]));
  const reactions = await selectCurrentRealMojis(
    memoryPostQueryer(db, postIDs, "DESC"),
    `AND r.post_id = ANY($1::varchar[])`,
  );
  for (const reaction of reactions) {
    const item = itemByPostID.get(reaction.realMoji.postID)!;
    if (item.realmojis.length < 50) {
      item.realmojis.push(newRealMojiResponse(reaction.realMoji, reaction.reactor));
    }
  }

  const comments = await selectCommentsWithAuthor(
    memoryPostQueryer(db, postIDs, "ASC"),
    `AND c.post_id = ANY($1::varchar[])`,
  );
  for (const comment of comments) {
    const item = itemByPostID.get(comment.comment.postID)!;
    if (item.comments.length < 50) {
      item.comments.push(newCommentResponse(comment.comment, comment.author));
    }
  }
}

// Reuse the shared selectors' filters and row mapping. Rank only eligible rows
// after active/deleted/replaced filtering, with one SQL per interaction type.
function memoryPostQueryer(db: Queryer, postIDs: string[], direction: "ASC" | "DESC"): Queryer {
  return {
    get<T>(sql: string, ...args: unknown[]): Promise<T | undefined> {
      return db.get<T>(sql, ...args);
    },
    exec(sql: string, ...args: unknown[]): Promise<number> {
      return db.exec(sql, ...args);
    },
    select<T>(sql: string): Promise<T[]> {
      return db.select<T>(`
        SELECT ranked.* FROM (
          SELECT interaction.*, row_number() OVER (
            PARTITION BY interaction.post_id
            ORDER BY interaction.created_at ${direction}, interaction.id ${direction}
          ) AS memory_rank
          FROM (${sql}) AS interaction
        ) AS ranked
        WHERE ranked.memory_rank <= 50
        ORDER BY ranked.post_id, ranked.created_at ${direction}, ranked.id ${direction}
      `, postIDs);
    },
  };
}
