// Frozen comparison path from main 993e1b0; test-only, never mounted in production.
import { randomUUID } from "node:crypto";
import type { Handler } from "hono";
import { APIError } from "../../src/api_error.ts";
import { bind } from "../../src/bind.ts";
import { must, type Row } from "../../src/db.ts";
import { signedImageURL } from "../../src/image_signature.ts";
import { decodeJPEG } from "../../src/jpeg.ts";
import { postColumns, postFromRow, validLocation, type PostLocation } from "../../src/post.ts";
import { jsonResponse } from "../../src/response.ts";
import type { Env, HandlerContext } from "../../src/server.ts";
import { getSession } from "../../src/session.ts";
import { now } from "../../src/time.ts";
import { setImageKey, userColumns, userFromRow, validUserText } from "../../src/user.ts";
import { newPostResponse } from "../../src/post_api.ts";

const createPostRequest = {
  image: { form: "image", type: "file" },
  caption: { form: "caption" },
  visibility: { form: "visibility" },
  locationKind: { form: "location_kind" },
  latitude: { form: "latitude", type: "float" },
  longitude: { form: "longitude", type: "float" },
  locality: { form: "locality", type: "stringPointer" },
} as const;

export function legacyCreatePostHandler(h: HandlerContext): Handler<Env> {
  return async (c) => {
    const input = await bind(c, createPostRequest);
    if (input.image === null || !validUserText(input.caption, 0, 1000)) {
      throw new APIError(400, "invalid_post");
    }
    switch (input.visibility) {
      case "friends":
      case "friends_of_friends":
      case "public":
        break;
      default:
        throw new APIError(400, "invalid_post");
    }
    const location: PostLocation = {
      kind: input.locationKind,
      latitude: input.latitude,
      longitude: input.longitude,
      locality: input.locality,
    };
    if (!validLocation(location)) {
      throw new APIError(400, "invalid_post");
    }
    const imageData = Buffer.from(await input.image.arrayBuffer());
    const img = decodeJPEG(imageData);
    if (!img) {
      throw new APIError(400, "invalid_post");
    }
    if (img.width > 4096 || img.height > 4096) {
      throw new APIError(400, "invalid_post");
    }

    const userID = getSession(c)!.userID;
    await using tx = await h.db.begin();
    const userRow = must(await tx.get<Row>(`SELECT ${userColumns.join(", ")} FROM users WHERE id = $1 AND status = 'active' FOR NO KEY UPDATE`, userID));
    const user = userFromRow(userRow);
    setImageKey(user);
    type WindowRow = { id: string; local_date: string; starts_at: Temporal.Instant };
    // 投稿同士は共有し、期間終了の UPDATE は COMMIT まで待たせる。
    let window = await tx.get<WindowRow>(
      `SELECT id, local_date, starts_at FROM posting_windows WHERE region = $1 AND ended_at IS NULL FOR SHARE`,
      user.region,
    );
    if (!window) {
      window = await tx.get<WindowRow>(
        `SELECT id, local_date, starts_at FROM posting_windows WHERE region = $1 AND ended_at IS NULL FOR SHARE`,
        user.region,
      );
    }
    if (!window) {
      throw new APIError(409, "post_slot_unavailable");
    }
    const counts = must(
      await tx.get<{ active: number; deleted: number }>(
        `
   SELECT count(*) FILTER (WHERE deleted_at IS NULL) AS active,
          count(*) FILTER (WHERE deleted_at IS NOT NULL) AS deleted
   FROM posts p JOIN posting_windows w ON w.id = p.posting_window_id
   WHERE p.author_id = $1 AND w.local_date = $2
  `,
        userID,
        window.local_date,
      ),
    );
    const postedAt = now();
    if (counts.active !== 0 || counts.deleted >= 2 || Temporal.Instant.compare(postedAt, window.starts_at) < 0) {
      throw new APIError(409, "post_slot_unavailable");
    }
    const imageID = randomUUID();
    await tx.exec(
      `INSERT INTO image_objects (id, owner_user_id, data, media_type, created_at) VALUES ($1, $2, $3, 'image/jpeg', $4)`,
      imageID,
      userID,
      imageData,
      postedAt,
    );
    const postID = randomUUID();
    const postRow = must(await tx.get<Row>(
      `
   WITH p AS (INSERT INTO posts (id, author_id, posting_window_id, image_id, caption, visibility,
                      location_kind, latitude, longitude, locality, posted_at)
   VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *)
   SELECT ${postColumns} FROM p JOIN posting_windows w ON w.id = p.posting_window_id
  `,
      postID,
      userID,
      window.id,
      imageID,
      input.caption,
      input.visibility,
      location.kind,
      location.latitude,
      location.longitude,
      location.locality,
      postedAt,
    ));
    const post = postFromRow(postRow);
    await tx.commit();
    return jsonResponse(c, 201, newPostResponse(post, user));
  };
}
