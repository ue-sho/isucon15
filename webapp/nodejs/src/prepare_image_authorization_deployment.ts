import { configFromEnv } from "./config.ts";
import { DB } from "./db.ts";
import { ImageAuthorizationCache } from "./image_authorization_cache.ts";

if (process.argv.length !== 3 || process.argv[2] !== "--all-writers-stopped") {
  throw new Error("stop all API writers first, then pass --all-writers-stopped");
}
const config = configFromEnv();
if (!config.imageAuthorizationRedisURL) throw new Error("ISUREAL_IMAGE_AUTH_REDIS_URL is required");
const db = new DB(config, 1);
try {
  await db.exec("SET statement_timeout='5s'");
  const connections = await db.get<{ count: number }>(`SELECT count(*)::integer AS count FROM pg_stat_activity
    WHERE datname=current_database() AND usename=current_user AND pid<>pg_backend_pid()
      AND backend_type='client backend'`);
  if (!connections || connections.count !== 0) throw new Error("API database connections have not drained");
  await ImageAuthorizationCache.prepareDeployment(config.imageAuthorizationRedisURL);
  process.stdout.write("image authorization deployment state ready\n");
} catch {
  throw new Error("image authorization deployment preparation failed; keep API writers stopped");
} finally { await db.end(); }
