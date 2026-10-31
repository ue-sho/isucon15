import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { apiErrorHandler } from "../../src/api_error.ts";
import type { DB } from "../../src/db.ts";
import { getImageHandler } from "../../src/image_api.ts";
import type { ImageFiles } from "../../src/image_files.ts";
import type { ImageAuthorizationCache } from "../../src/image_authorization_cache.ts";
import type { Env, HandlerContext } from "../../src/server.ts";

export async function imageNginx(db: DB, imageFiles: ImageFiles, imageAuthorizationCache?: ImageAuthorizationCache) {
  const app = new Hono<Env>().onError(apiErrorHandler);
  app.get("/api/images/:imageId", getImageHandler({ db, imageFiles, imageAuthorizationCache, config: { imageAuthorizationCacheReads: true } } as HandlerContext));
  const backend = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
  if (!backend.listening) await new Promise<void>((resolve) => backend.once("listening", resolve));
  const address = backend.address();
  assert.ok(address && typeof address !== "string");
  const root = await mkdtemp(join(tmpdir(), "isu15-image-nginx-"));
  const socketPath = join(root, "nginx.sock");
  const site = await readFile(resolve(import.meta.dirname, "../../../../asia1/etc/nginx/sites-available/isureal.conf"), "utf8");
  const location = site.match(/  location \^~ \/_isureal_images\/ \{[\s\S]*?\n  \}/)?.[0];
  assert.ok(location);
  await writeFile(join(root, "nginx.conf"), `
worker_processes 1;
pid /test/nginx.pid;
error_log /test/error.log;
events { worker_connections 128; }
http {
  access_log off;
  client_body_temp_path /test/body;
  proxy_temp_path /test/proxy;
  fastcgi_temp_path /test/fastcgi;
  uwsgi_temp_path /test/uwsgi;
  scgi_temp_path /test/scgi;
  server {
    listen unix:/test/nginx.sock;
    ${location.replace("/var/cache/isureal/images/", "/cache/")}
    location /api/ { proxy_pass http://127.0.0.1:${address.port}; }
  }
}`);
  const name = "isu15-image-nginx-" + randomUUID().slice(0, 8);
  const common = ["run", "--rm", "--user", `${process.getuid!()}:${process.getgid!()}`, "--entrypoint", "nginx", "--network", "host", "-v", `${root}:/test`, "-v", `${imageFiles.directory}:/cache:ro`];
  const close = async () => {
    try { execFileSync("docker", ["stop", name], { stdio: "pipe" }); } catch {}
    await new Promise<void>((resolve) => backend.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  };
  try {
    execFileSync("docker", [...common, "nginx:1.24", "-e", "stderr", "-t", "-c", "/test/nginx.conf"], { stdio: "pipe" });
    execFileSync("docker", [...common, "-d", "--name", name, "nginx:1.24", "-c", "/test/nginx.conf", "-g", "daemon off;"], { stdio: "pipe" });
    const deadline = Date.now() + 8000;
    for (;;) {
      try { await access(socketPath); break; }
      catch { assert.ok(Date.now() < deadline, "nginx did not start"); await new Promise((r) => setTimeout(r, 20)); }
    }
  } catch (err) { await close(); throw err; }
  return { close, request(path: string, headers: Record<string, string> = {}) {
    return new Promise<{ status: number; headers: IncomingHttpHeaders; body: Buffer }>((resolve, reject) => {
      const request = httpRequest({ socketPath, path, headers }, (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("error", reject);
        response.on("end", () => resolve({ status: response.statusCode!, headers: response.headers, body: Buffer.concat(chunks) }));
      });
      request.on("error", reject);
      request.setTimeout(5000, () => request.destroy(new Error("image nginx request timeout")));
      request.end();
    });
  } };
}
