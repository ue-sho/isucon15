// Isolated test worker. Only a generated database in the parent test's loopback
// container is accepted; this is not an application endpoint or runtime script.
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { DB } from "../../src/db.ts";
import { getNotificationsHandler } from "../../src/notification_api.ts";
import type { Env, HandlerContext } from "../../src/server.ts";

const [port, database] = process.argv.slice(2);
if (!/^\d+$/.test(port) || !/^notification_\d+$/.test(database) || !process.send) throw new Error("test parent required");
const config = { region: "asia", dbHost: "127.0.0.1", dbPort: port, dbUser: "postgres", dbPassword: "", dbName: database, logLevel: "error" };
const db = new DB(config, 2);
const app = new Hono<Env>();
app.use("*", async (c, next) => {
  c.set("session", { userID: "alice", region: "asia", token: "", tokenHash: "", createdAt: Temporal.Now.instant() });
  await next();
});
app.get("/notifications", getNotificationsHandler({ db, config } as unknown as HandlerContext));
const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, info => process.send!({ port: info.port }));
process.once("SIGTERM", () => {
  if ("closeAllConnections" in server) server.closeAllConnections();
  server.close();
  void db.end().then(() => process.exit(0));
});
