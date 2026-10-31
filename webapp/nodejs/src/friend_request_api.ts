import { randomUUID } from "node:crypto";
import type { Handler } from "hono";
import { APIError } from "./api_error.ts";
import { bind } from "./bind.ts";
import { must } from "./db.ts";
import { beginRelationshipTx, friendRequestFromRow, getFriendRequest, insertFriendship, isBlocked, isFriend } from "./relationship.ts";
import { jsonResponse } from "./response.ts";
import type { Env, HandlerContext } from "./server.ts";
import { getSession } from "./session.ts";

const createFriendRequestRequest = {
  recipientId: { json: "recipientId" },
} as const;

type FriendRequestResponse = {
  relationId: string;
  status: string;
  updatedAt: Temporal.Instant;
};

export function createFriendRequestHandler(h: HandlerContext): Handler<Env> {
  return async (c) => {
    const input = await bind(c, createFriendRequestRequest);
    const actor = getSession(c)!.userID;
    await using tx = await beginRelationshipTx(h.db, actor, input.recipientId);
    const blocked = await isBlocked(tx, actor, input.recipientId);
    if (blocked) {
      throw new APIError(409, "relationship_conflict");
    }
    if (await isFriend(tx, actor, input.recipientId)) {
      throw new APIError(409, "relationship_conflict");
    }
    const existing = await tx.get(
      `
   SELECT id, requester_id, recipient_id, status, created_at, updated_at FROM friend_requests WHERE status='pending' AND
    ((requester_id=$1 AND recipient_id=$2) OR (requester_id=$2 AND recipient_id=$1))
  `,
      actor,
      input.recipientId,
    );
    let result: { id: string; status: string; updated_at: Temporal.Instant };
    if (existing) {
      const request = friendRequestFromRow(existing);
      if (request.requesterID === actor) {
        throw new APIError(409, "relationship_conflict");
      }
      result = must(await tx.get(`UPDATE friend_requests SET status='accepted', updated_at=clock_timestamp() WHERE id=$1 RETURNING id, status, updated_at`, request.id));
      await insertFriendship(tx, request);
    } else {
      result = must(await tx.get(
        `INSERT INTO friend_requests (id, requester_id, recipient_id, status, created_at, updated_at) VALUES ($1,$2,$3,'pending',clock_timestamp(),clock_timestamp()) RETURNING id, status, updated_at`,
        randomUUID(),
        actor,
        input.recipientId,
      ));
    }
    await tx.commit();
    const response: FriendRequestResponse = { relationId: result.id, status: result.status, updatedAt: result.updated_at };
    return jsonResponse(c, 201, response);
  };
}

const transitionFriendRequestRequest = {
  requestId: { param: "requestId" },
  action: { param: "action" },
} as const;

export function transitionFriendRequestHandler(h: HandlerContext): Handler<Env> {
  return async (c) => {
    const input = await bind(c, transitionFriendRequestRequest);
    let status: string;
    switch (input.action) {
      case "accept":
        status = "accepted";
        break;
      case "reject":
        status = "rejected";
        break;
      case "cancel":
        status = "cancelled";
        break;
      default:
        throw new APIError(403, "relationship_action_forbidden");
    }
    const actor = getSession(c)!.userID;
    let request = await getFriendRequest(h.db, input.requestId);
    if (!request) {
      throw new APIError(404, "relationship_not_found");
    }
    if ((status === "cancelled" && actor !== request.requesterID) || (status !== "cancelled" && actor !== request.recipientID)) {
      throw new APIError(403, "relationship_action_forbidden");
    }
    await using tx = await beginRelationshipTx(h.db, request.requesterID, request.recipientID);
    request = must(await getFriendRequest(tx, input.requestId));
    if (request.status !== "pending") {
      throw new APIError(403, "relationship_action_forbidden");
    }
    if (status === "accepted") {
      const blocked = await isBlocked(tx, request.requesterID, request.recipientID);
      if (blocked) {
        throw new APIError(409, "relationship_conflict");
      }
      await insertFriendship(tx, request);
    }
    const result = must(await tx.get<{ id: string; status: string; updated_at: Temporal.Instant }>(
      `UPDATE friend_requests SET status=$2, updated_at=clock_timestamp() WHERE id=$1 RETURNING id, status, updated_at`, request.id, status,
    ));
    await tx.commit();
    const response: FriendRequestResponse = { relationId: result.id, status: result.status, updatedAt: result.updated_at };
    return jsonResponse(c, 200, response);
  };
}
