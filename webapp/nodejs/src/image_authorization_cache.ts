import { createHash, randomUUID } from "node:crypto";
import { createClient } from "redis";
import type { MiddlewareHandler } from "hono";
import { APIError } from "./api_error.ts";
import { logWarn } from "./response.ts";
import type { Env, HandlerContext } from "./server.ts";
import { getSession } from "./session.ts";

// The control hash is durable coordination state, NOT an evictable cache.
// Provision it once while all writers are stopped. Never recreate it on connect.
export const imageAuthorizationControlKey = "isureal:image-auth:v1:control";
const entryPrefix = "isureal:image-auth:v1:url:";
const schemaCheck = `if redis.call('HGET', KEYS[1], 'schema') ~= '1' then return redis.error_reply('image cache not provisioned') end\n`;

const lookupScript = schemaCheck + `
local raw = redis.call('GET', KEYS[2])
if raw then
  local entry = cjson.decode(raw)
  if tonumber(redis.call('HGET', KEYS[1], 'gate:*') or '0') == 0
    and tonumber(redis.call('HGET', KEYS[1], 'gate:' .. entry.owner) or '0') == 0
    and (redis.call('HGET', KEYS[1], 'epoch:*') or '0') == entry.globalEpoch
    and (redis.call('HGET', KEYS[1], 'epoch:' .. entry.owner) or '0') == entry.userEpoch then
    return raw
  end
end
return ''
`;

const snapshotScript = schemaCheck + `
if tonumber(redis.call('HGET', KEYS[1], 'gate:*') or '0') ~= 0
  or tonumber(redis.call('HGET', KEYS[1], 'gate:' .. ARGV[1]) or '0') ~= 0 then return {} end
return {redis.call('HGET', KEYS[1], 'epoch:*') or '0', redis.call('HGET', KEYS[1], 'epoch:' .. ARGV[1]) or '0'}
`;

const publishScript = schemaCheck + `
local entry = cjson.decode(ARGV[1])
if tonumber(redis.call('HGET', KEYS[1], 'gate:*') or '0') ~= 0
  or tonumber(redis.call('HGET', KEYS[1], 'gate:' .. entry.owner) or '0') ~= 0
  or (redis.call('HGET', KEYS[1], 'epoch:*') or '0') ~= entry.globalEpoch
  or (redis.call('HGET', KEYS[1], 'epoch:' .. entry.owner) or '0') ~= entry.userEpoch then return 0 end
redis.call('SET', KEYS[2], ARGV[1], 'PXAT', ARGV[2])
return 1
`;

const beginScript = schemaCheck + `
local total = tonumber(redis.call('HGET', KEYS[1], 'total') or '0')
local gate = tonumber(redis.call('HGET', KEYS[1], 'gate:' .. ARGV[2]) or '0')
redis.call('HSET', KEYS[1], 'revision', ARGV[1], 'total', total + 1,
  'gate:' .. ARGV[2], gate + 1, 'epoch:' .. ARGV[2], ARGV[1], 'writer:' .. ARGV[1], ARGV[2])
return 1
`;

const finishScript = schemaCheck + `
local scope = redis.call('HGET', KEYS[1], 'writer:' .. ARGV[1])
if not scope then return redis.error_reply('image cache writer missing') end
local total = tonumber(redis.call('HGET', KEYS[1], 'total'))
local gate = tonumber(redis.call('HGET', KEYS[1], 'gate:' .. scope))
if total < 1 or gate < 1 then return redis.error_reply('image cache writer corrupt') end
redis.call('HSET', KEYS[1], 'revision', ARGV[2], 'total', total - 1,
  'gate:' .. scope, gate - 1, 'epoch:' .. scope, ARGV[2])
redis.call('HDEL', KEYS[1], 'writer:' .. ARGV[1])
return 1
`;

export type AuthorizedImage = { uri: string; mediaType: string };
export type ImageAuthorizationLookup = { key: string; image?: AuthorizedImage };
export type ImageAuthorizationTicket = { key: string; owner: string; globalEpoch: string; userEpoch: string };

export class ImageAuthorizationCache {
  readonly #client: ReturnType<typeof createClient>;
  #lastWarning = -Infinity;

  constructor(url: string) {
    this.#client = createClient({
      url,
      disableOfflineQueue: true,
      commandsQueueMaxLength: 1024,
      commandOptions: { timeout: 1000 },
      socket: { connectTimeout: 1000, reconnectStrategy: retries => Math.min(100 * (retries + 1), 1000) },
    });
    // Do not log the connection URL, credentials, signatures, or raw replies.
    this.#client.on("error", () => this.#warn());
  }

  async connect(): Promise<void> {
    try {
      await this.#connectAndCheckConfiguration();
      const control = await this.#client.hmGet(imageAuthorizationControlKey, ["schema", "revision", "total"]);
      if (control[0] !== "1" || !control[1] || !/^\d+$/.test(control[2] ?? "")) {
        throw new Error("image cache not provisioned");
      }
    } catch {
      this.close();
      throw new Error("image authorization Redis unavailable or not safely provisioned");
    }
  }

  static async provision(url: string): Promise<void> {
    const cache = new ImageAuthorizationCache(url);
    try {
      await cache.#connectAndCheckConfiguration();
      await cache.#client.eval(`
        if redis.call('DBSIZE') ~= 0 then return redis.error_reply('requires empty dedicated Redis') end
        redis.call('HSET', KEYS[1], 'schema', '1', 'revision', ARGV[1], 'total', '0')
        return 1
      `, { keys: [imageAuthorizationControlKey], arguments: [randomUUID()] });
    } catch {
      throw new Error("image authorization Redis provisioning requires a safely configured empty dedicated database");
    } finally { cache.close(); }
  }

  async #connectAndCheckConfiguration(): Promise<void> {
    // Bound initial startup even though established connections reconnect.
    const timeout = setTimeout(() => this.close(), 1500);
    try { await this.#client.connect(); } finally { clearTimeout(timeout); }
    const config = await this.#client.configGet([
      "appendonly", "appendfsync", "no-appendfsync-on-rewrite", "maxmemory-policy", "save", "aof-load-truncated",
    ]);
    if (config.appendonly !== "yes" || config.appendfsync !== "always"
      || config["no-appendfsync-on-rewrite"] !== "no" || config["maxmemory-policy"] !== "noeviction"
      || config.save !== "" || config["aof-load-truncated"] !== "no") {
      throw new Error("unsafe Redis persistence configuration");
    }
  }

  close(): void {
    if (this.#client.isOpen) this.#client.destroy();
  }

  async lookup(imageID: string, exp: string, signature: string): Promise<ImageAuthorizationLookup | undefined> {
    if (imageID.length + exp.length + signature.length > 4096) return undefined;
    const key = entryPrefix + createHash("sha256").update(JSON.stringify([imageID, exp, signature])).digest("hex");
    try {
      const result = await this.#client.eval(lookupScript, { keys: [imageAuthorizationControlKey, key], arguments: [] }) as string;
      const entry = result ? JSON.parse(result) : undefined;
      const image = entry && (entry.mediaType === "image/jpeg" || entry.mediaType === "image/png")
        && typeof entry.uri === "string" ? { uri: entry.uri, mediaType: entry.mediaType } : undefined;
      return { key, image };
    } catch {
      this.#warn();
      return undefined;
    }
  }

  async snapshot(lookup: ImageAuthorizationLookup, ownerID: string): Promise<ImageAuthorizationTicket | undefined> {
    const owner = userScope(ownerID);
    try {
      const epochs = await this.#client.eval(snapshotScript, { keys: [imageAuthorizationControlKey], arguments: [owner] }) as string[];
      return epochs.length === 2 ? { key: lookup.key, owner, globalEpoch: epochs[0], userEpoch: epochs[1] } : undefined;
    } catch { this.#warn(); return undefined; }
  }

  async publish(ticket: ImageAuthorizationTicket, image: AuthorizedImage, exp: number): Promise<void> {
    const until = Math.min(exp * 1000, Date.now() + 60_000);
    if (!Number.isSafeInteger(until) || until <= Date.now()) return;
    try {
      await this.#client.eval(publishScript, {
        keys: [imageAuthorizationControlKey, ticket.key],
        arguments: [JSON.stringify({ ...image, owner: ticket.owner, globalEpoch: ticket.globalEpoch, userEpoch: ticket.userEpoch }), String(until)],
      });
    } catch { this.#warn(); }
  }

  async beginMutation(ownerID?: string): Promise<string> {
    const token = randomUUID();
    try {
      await this.#client.eval(beginScript, {
        keys: [imageAuthorizationControlKey], arguments: [token, ownerID === undefined ? "*" : userScope(ownerID)],
      });
      return token;
    } catch {
      this.#warn();
      // No DB mutation may start without an acknowledged durable gate.
      throw new APIError(503, "image_cache_unavailable");
    }
  }

  async finishMutation(token: string): Promise<void> {
    try {
      await this.#client.eval(finishScript, { keys: [imageAuthorizationControlKey], arguments: [token, randomUUID()] });
    } catch {
      this.#warn();
      throw new APIError(503, "image_cache_unavailable");
    }
  }

  #warn(): void {
    const now = performance.now();
    if (now - this.#lastWarning < 10_000) return;
    this.#lastWarning = now;
    logWarn("image authorization cache unavailable; reads use database and guarded writes require Redis");
  }
}

function userScope(id: string): string {
  return "user:" + createHash("sha256").update(id).digest("hex");
}

// This wraps the whole handler, including transaction COMMIT/ROLLBACK and its
// async disposal. A process crash or uncertain 5xx outcome leaves a durable gate.
// Gates never expire: an old transaction must never outlive its invalidation.
export function imageCacheMutationMiddleware(h: HandlerContext, scope: "user" | "global"): MiddlewareHandler<Env> {
  return async (c, next) => {
    if (!h.imageAuthorizationCache) return next();
    const owner = scope === "user" ? getSession(c)?.userID : undefined;
    if (scope === "user" && !owner) throw new APIError(401, "invalid_session");
    const token = await h.imageAuthorizationCache.beginMutation(owner);
    await next();
    if (c.res.status >= 500) return;
    await h.imageAuthorizationCache.finishMutation(token);
  };
}
