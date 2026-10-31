import type { Handler } from "hono";
import { APIError } from "./api_error.ts";
import { bind } from "./bind.ts";
import { isBlocked, isFriend } from "./relationship.ts";
import type { RelationshipUserResponse } from "./relationship_list_api.ts";
import { jsonResponse } from "./response.ts";
import type { Env, HandlerContext } from "./server.ts";
import { getSession } from "./session.ts";
import { getUser, setImageKey, userColumns, userFromRow, validUserText, type User } from "./user.ts";
import { newGetMeResponse } from "./user_api.ts";
import { normalizeSearchText } from "./user_search.ts";

const searchUsersRequest = {
  q: { query: "q" },
  beforeUsername: { query: "beforeUsername" },
  beforeId: { query: "beforeId" },
} as const;

type SearchUsersResponse = {
  items: RelationshipUserResponse[];
  hasMore: boolean;
};

export function searchUsersHandler(h: HandlerContext): Handler<Env> {
  return async (c) => {
    const input = await bind(c, searchUsersRequest);
    if (!validUserText(input.q, 1, 100)) {
      throw new APIError(400, "invalid_relationship");
    }
    if ((input.beforeUsername === "") !== (input.beforeId === "")) {
      throw new APIError(400, "invalid_pagination");
    }
    const viewer = getSession(c)!.userID;
    const query = normalizeSearchText(input.q);
    // PostgreSQL text cannot contain NUL. The original JS substring search
    // therefore never matched it, but sending it as a text parameter would fail.
    if (query.includes("\0")) {
      return jsonResponse(c, 200, { items: [], hasMore: false });
    }
    const rows = await h.db.select(
      `SELECT ${userColumns.map((column) => `u.${column}`).join(", ")}
       FROM users u
       WHERE u.status='active' AND u.id<>$1
         AND ($2='' OR (u.username,u.id)>($2,$3))
         AND (strpos(u.search_username COLLATE "C", $4) > 0
           OR strpos(u.search_display_name COLLATE "C", $4) > 0)
         AND NOT EXISTS (
           SELECT 1 FROM block_relations b
           WHERE (b.blocker_id=$1 AND b.blocked_id=u.id)
              OR (b.blocker_id=u.id AND b.blocked_id=$1)
         )
       ORDER BY u.username, u.id LIMIT 51`,
      viewer,
      input.beforeUsername,
      input.beforeId,
      query,
    );
    const items: RelationshipUserResponse[] = [];
    // The 51st row only establishes hasMore; never derive its key or sign it.
    for (const row of rows.slice(0, 50)) {
      const user = userFromRow(row);
      setImageKey(user);
      if (user.accountType !== "certified_public") {
        user.bio = "";
      }
      items.push(newRelationshipUserResponse(user));
    }
    const hasMore = rows.length > 50;
    const response: SearchUsersResponse = { items, hasMore };
    return jsonResponse(c, 200, response);
  };
}

const getUserRequest = {
  userId: { param: "userId" },
} as const;

export function getUserHandler(h: HandlerContext): Handler<Env> {
  return async (c) => {
    const input = await bind(c, getUserRequest);
    const viewer = getSession(c)!.userID;
    const user = await getUser(h.db, input.userId);
    if (!user) {
      throw new APIError(404, "relationship_not_found");
    }
    const blocked = await isBlocked(h.db, viewer, user.id);
    if (blocked) {
      throw new APIError(404, "relationship_not_found");
    }
    if (user.accountType !== "certified_public" && !(await isFriend(h.db, viewer, user.id))) {
      user.bio = "";
    }
    return jsonResponse(c, 200, newRelationshipUserResponse(user));
  };
}

export function newRelationshipUserResponse(user: User): RelationshipUserResponse {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    profileImageUrl: newGetMeResponse(user).profileImageUrl,
    bio: user.bio,
    accountType: user.accountType,
  };
}
