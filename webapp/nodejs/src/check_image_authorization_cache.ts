import { configFromEnv } from "./config.ts";
import { ImageAuthorizationCache } from "./image_authorization_cache.ts";

const url = configFromEnv().imageAuthorizationRedisURL;
if (!url) throw new Error("ISUREAL_IMAGE_AUTH_REDIS_URL is required");
const cache = new ImageAuthorizationCache(url);
try { await cache.connect(); }
finally { cache.close(); }
process.stdout.write("image authorization Redis connection ready\n");
