import { randomUUID } from "node:crypto";
import type { Handler } from "hono";
import { APIError } from "./api_error.ts";
import { bind } from "./bind.ts";
import type { Row } from "./db.ts";
import { lockNotificationMembership } from "./notification_membership.ts";
import { signedImageURL } from "./image_signature.ts";
import { jsonResponse, noContent } from "./response.ts";
import type { Env, HandlerContext } from "./server.ts";
import { createLoginSessionForLockedUserTx, getSession, invalidateLoginSession, sha256Hex } from "./session.ts";
import { getUser, setImageKey, userColumns, usernamePattern, userFromRow, validRegion, validUserText, type User } from "./user.ts";

const registerRequest = {
  username: { json: "username" },
  displayName: { json: "displayName" },
  region: { json: "region" },
} as const;

const loginRequest = {
  username: { json: "username" },
  secretKey: { json: "secretKey" },
} as const;

type SessionUserResponse = {
  id: string;
  username: string;
  displayName: string;
  bio: string;
  region: string;
  accountType: string;
  status: string;
};

type GetMeResponse = SessionUserResponse & {
  profileImageUrl: string | null;
};

const updateMeRequest = {
  displayName: { json: "displayName", type: "stringPointer" },
  bio: { json: "bio", type: "stringPointer" },
  region: { json: "region", type: "stringPointer" },
} as const;

function newSessionUserResponse(user: User): SessionUserResponse {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    bio: user.bio,
    region: user.region,
    accountType: user.accountType,
    status: user.status,
  };
}

export function newGetMeResponse(user: User): GetMeResponse {
  const response: GetMeResponse = { ...newSessionUserResponse(user), profileImageUrl: null };
  if (user.profileImageID) {
    response.profileImageUrl = signedImageURL(user, user.profileImageID);
  }
  return response;
}

export function registerHandler(h: HandlerContext): Handler<Env> {
  return async (c) => {
    const input = await bind(c, registerRequest);
    c.set("username", input.username);
    if (!usernamePattern.test(input.username) || !validUserText(input.displayName, 1, 100) || !validRegion(input.region)) {
      throw new APIError(400, "invalid_registration");
    }
    const secretKey = randomUUID();
    const userID = randomUUID();
    await using tx = await h.db.begin();
    await lockNotificationMembership(tx);
    // 別SQLにして、ロック待機後の新しいスナップショットで重複を確認する。
    await tx.exec(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, input.username);
    const row = await tx.get<Row>(
      `INSERT INTO users (id, username, secret_key_hash, display_name, region)
       SELECT $1::varchar(36), $2::varchar(64), $3::text, $4::text, $5::text
       WHERE NOT EXISTS (SELECT 1 FROM users WHERE username = $2::varchar(64))
       RETURNING ${userColumns.join(", ")}`,
      userID,
      input.username,
      sha256Hex(secretKey),
      input.displayName,
      input.region,
    );
    if (!row) {
      throw new APIError(409, "username_taken");
    }
    const user = userFromRow(row);
    setImageKey(user);
    await tx.commit();
    return jsonResponse(c, 201, { secretKey, user: newSessionUserResponse(user) });
  };
}

export function loginHandler(h: HandlerContext): Handler<Env> {
  return async (c) => {
    const input = await bind(c, loginRequest);
    c.set("username", input.username);
    if (!usernamePattern.test(input.username)) {
      throw new APIError(401, "invalid_credentials");
    }
    const secretKeyHash = sha256Hex(input.secretKey);
    // Reject bad credentials without holding a pool connection across BEGIN/ROLLBACK.
    // This is only a precheck: successful candidates are checked again under the user lock.
    const candidate = await h.db.get<{ id: string }>(
      `SELECT id FROM users WHERE username = $1 AND secret_key_hash = $2 AND status = 'active'`,
      input.username,
      secretKeyHash,
    );
    if (!candidate) {
      throw new APIError(401, "invalid_credentials");
    }
    await using tx = await h.db.begin();
    const row = await tx.get(
      // 認証失敗の行はロックしない。成功時のロックはセッション置換と退会の排他に必要。
      `SELECT id, username, secret_key_hash, display_name, bio, profile_image_id, region, account_type, status FROM users
       WHERE username = $1 AND secret_key_hash = $2 AND status = 'active' FOR NO KEY UPDATE`,
      input.username,
      secretKeyHash,
    );
    if (!row) {
      throw new APIError(401, "invalid_credentials");
    }
    const user = userFromRow(row);
    const session = await createLoginSessionForLockedUserTx(tx, user.id);
    await tx.commit();
    return jsonResponse(c, 200, { token: session.token, user: newSessionUserResponse(user) });
  };
}

export function logoutHandler(h: HandlerContext): Handler<Env> {
  return async (c) => {
    const session = getSession(c);
    if (!session) {
      throw new APIError(401, "invalid_session");
    }
    await invalidateLoginSession(h.db, session.userID, session.tokenHash);
    return noContent(c);
  };
}

export function getMeHandler(h: HandlerContext): Handler<Env> {
  return async (c) => {
    const session = getSession(c);
    if (!session) {
      throw new APIError(401, "invalid_session");
    }
    const user = session.user ?? await getUser(h.db, session.userID);
    if (!user) {
      throw new APIError(404, "account_not_found");
    }
    return jsonResponse(c, 200, newGetMeResponse(user));
  };
}

export function updateMeHandler(h: HandlerContext): Handler<Env> {
  return async (c) => {
    const session = getSession(c);
    if (!session) {
      throw new APIError(401, "invalid_session");
    }
    const input = await bind(c, updateMeRequest);
    if (
      (input.displayName === null && input.bio === null && input.region === null) ||
      (input.displayName !== null && !validUserText(input.displayName, 1, 100)) ||
      (input.bio !== null && !validUserText(input.bio, 0, 500)) ||
      (input.region !== null && !validRegion(input.region))
    ) {
      throw new APIError(400, "invalid_profile");
    }
    await using tx = await h.db.begin();
    if (input.region !== null) await lockNotificationMembership(tx);
    const row = await tx.get(
      `UPDATE users SET display_name = COALESCE($2, display_name), bio = COALESCE($3, bio),
                        region = COALESCE($4, region), updated_at = clock_timestamp()
       WHERE id = $1 AND status = 'active' RETURNING ${userColumns.join(", ")}`,
      session.userID, input.displayName, input.bio, input.region,
    );
    if (!row) {
      throw new APIError(404, "account_not_found");
    }
    const user = userFromRow(row);
    setImageKey(user);
    await tx.commit();
    return jsonResponse(c, 200, newGetMeResponse(user));
  };
}
