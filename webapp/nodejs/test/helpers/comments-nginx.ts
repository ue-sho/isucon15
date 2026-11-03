import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const docker = promisify(execFile);
const root = resolve(import.meta.dirname, "../../../..");

// コメント専用。実site/snippet/upstreamの接続先だけ隔離環境に置換する。
export async function commentsNginx(host: "europe1" | "america1", localPort: number, regionalPort: number,
  options: { legacy?: boolean; backupPort?: number } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "isu15-comments-nginx-"));
  const name = "isu15-comments-nginx-" + randomUUID();
  let started = false;
  const close = async () => {
    if (started) await docker("docker", ["stop", "--time", "1", name]);
    await rm(directory, { recursive: true, force: true });
  };
  try {
    const desktop = (await docker("docker", ["info", "--format", "{{.OperatingSystem}}"])).stdout.includes("Docker Desktop");
    const backendHost = desktop ? "host.docker.internal" : "127.0.0.1";
    let port = 80;
    if (!desktop) {
      const probe = createServer();
      await new Promise<void>((resolve, reject) => { probe.once("error", reject); probe.listen(0, "127.0.0.1", resolve); });
      const address = probe.address();
      assert.ok(address && typeof address !== "string"); port = address.port;
      await new Promise<void>((resolve) => probe.close(() => resolve()));
    }
    const configs = `${root}/${host}/etc/nginx`;
    let site = await readFile(`${configs}/sites-available/isureal.conf`, "utf8");
    if (options.legacy) {
      // 比較版は追加したlocationだけを除去。他のregional APIはそのまま。
      const location = /  location ~ \^\/api\/posts\/\[\^\/\]\+\/comments\$ \{\n    include [^\n]+;\n    limit_except POST \{ proxy_pass http:\/\/isureal_local_api; \}\n  \}\n/;
      assert.ok(location.test(site), "expected exactly the comment location");
      site = site.replace(location, "");
      assert.ok(!location.test(site));
    }
    site = site.replaceAll("/etc/nginx/snippets/", `/repo/${host}/etc/nginx/snippets/`)
      .replace("listen 80 default_server", `listen ${port} default_server`);
    const destination = `192.168.1.10:${host === "europe1" ? 8081 : 8082}`;
    let regional = await readFile(`${configs}/conf.d/isureal-regional-api.conf`, "utf8");
    assert.ok(regional.includes(destination));
    regional = regional.replace(destination, `${backendHost}:${regionalPort} max_fails=0`);
    if (options.backupPort) regional = regional.replace("  keepalive 16;", `  server ${backendHost}:${options.backupPort} backup;\n  keepalive 16;`);
    const local = (await readFile(`${configs}/conf.d/isureal-local-api.conf`, "utf8"))
      .replace("127.0.0.1:8080", `${backendHost}:${localPort}`);
    await writeFile(join(directory, "nginx.conf"), `
worker_processes 1;
pid /test/nginx.pid;
error_log /test/error.log;
events { worker_connections 128; }
http {
  access_log off;
  # 試験でのみ強い再送条件を継承。production snippetのoffが優先することを検証。
  proxy_next_upstream error timeout http_503 non_idempotent;
  client_body_temp_path /test/body;
  proxy_temp_path /test/proxy;
  fastcgi_temp_path /test/fastcgi;
  uwsgi_temp_path /test/uwsgi;
  scgi_temp_path /test/scgi;
  ${regional}
  ${local}
  ${site}
}`);
    const common = ["run", "--rm", "--user", `${process.getuid!()}:${process.getgid!()}`, "--entrypoint", "nginx",
      "-v", `${directory}:/test`, "-v", `${root}:/repo:ro`];
    await docker("docker", [...common, "nginx:1.24", "-e", "stderr", "-t", "-c", "/test/nginx.conf"]);
    await docker("docker", [...common, "-d", "--name", name, ...(desktop ? ["-p", "127.0.0.1::80"] : ["--network", "host"]),
      "nginx:1.24", "-c", "/test/nginx.conf", "-g", "daemon off;"]);
    started = true;
    if (desktop) port = Number((await docker("docker", ["port", name, "80/tcp"])).stdout.trim().split(":").at(-1));
    const url = `http://127.0.0.1:${port}`;
    for (let attempt = 0; ; attempt++) {
      try { await (await fetch(url + "/api/__comments_probe", { signal: AbortSignal.timeout(1000) })).arrayBuffer(); break; }
      catch (error) { if (attempt === 50) throw error; await new Promise((resolve) => setTimeout(resolve, 20)); }
    }
    return { url, close };
  } catch (error) { await close(); throw error; }
}
