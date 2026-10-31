import { ImageAuthorizationCache } from "./image_authorization_cache.ts";

if (process.argv.length !== 3 || process.argv[2] !== "--all-writers-stopped") {
  throw new Error("stop all API writers first, then pass --all-writers-stopped");
}
const url = process.env.ISUREAL_IMAGE_AUTH_REDIS_URL;
if (!url) throw new Error("ISUREAL_IMAGE_AUTH_REDIS_URL is required");
await ImageAuthorizationCache.provision(url);
process.stdout.write("image authorization coordination state provisioned\n");
