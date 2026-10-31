import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const docker = promisify(execFile);
const root = resolve(import.meta.dirname, "../../../..");

// Docker Desktopのhost networkingを必要とせず、本物のsite/snippet/upstreamを使う。
// 接続先とlistenだけを手元に置換し、本番や実サービスのenvを参照しない。
export async function regionalNginx(host: "europe1" | "america1", localPort: number, regionalPort: number) {
  const directory = await mkdtemp(join(tmpdir(), "isu15-relationship-nginx-"));
  const name = "isu15-relationship-nginx-" + randomUUID();
  let started = false;
  const close = async () => {
    if (started) await docker("docker", ["stop", "--time", "1", name]);
    await rm(directory, { recursive: true, force: true });
  };
  try {
    const desktop = (await docker("docker", ["info", "--format", "{{.OperatingSystem}}"])).stdout.includes("Docker Desktop");
    const backendHost = desktop ? "host.docker.internal" : "127.0.0.1";
    let port = 0;
    if (!desktop) {
      const probe = createServer();
      await new Promise<void>((resolve, reject) => { probe.once("error", reject); probe.listen(0, "127.0.0.1", resolve); });
      const address = probe.address();
      assert.ok(address && typeof address !== "string");
      port = address.port;
      await new Promise<void>((resolve) => probe.close(() => resolve()));
    }
    const configs = `${root}/${host}/etc/nginx`;
    const site = (await readFile(`${configs}/sites-available/isureal.conf`, "utf8"))
      .replaceAll("/etc/nginx/snippets/", `/repo/${host}/etc/nginx/snippets/`)
      .replace("listen 80 default_server", `listen ${desktop ? 80 : port} default_server`);
    const regional = await readFile(`${configs}/conf.d/isureal-regional-api.conf`, "utf8");
    const destination = `192.168.1.10:${host === "europe1" ? 8081 : 8082}`;
    assert.ok(regional.includes(destination));
    const local = await readFile(`${configs}/conf.d/isureal-local-api.conf`, "utf8");
    await writeFile(join(directory, "nginx.conf"), `
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
  ${regional.replace(destination, `${backendHost}:${regionalPort}`)}
  ${local.replace("127.0.0.1:8080", `${backendHost}:${localPort}`)}
  ${site}
}`);
    const common = ["run", "--rm", "--user", `${process.getuid!()}:${process.getgid!()}`, "--entrypoint", "nginx",
      "-v", `${directory}:/test`, "-v", `${root}:/repo:ro`];
    await docker("docker", [...common, "nginx:1.24", "-e", "stderr", "-t", "-c", "/test/nginx.conf"]);
    const network = desktop ? ["-p", "127.0.0.1::80"] : ["--network", "host"];
    await docker("docker", [...common, "-d", "--name", name, ...network, "nginx:1.24", "-c", "/test/nginx.conf", "-g", "daemon off;"]);
    started = true;
    if (desktop) {
      const published = await docker("docker", ["port", name, "80/tcp"]);
      port = Number(published.stdout.trim().split(":").at(-1));
    }
    assert.ok(port > 0);
    const url = `http://127.0.0.1:${port}`;
    for (let attempt = 0; ; attempt++) {
      try { await (await fetch(url + "/api/friend-requests", { signal: AbortSignal.timeout(1000) })).arrayBuffer(); break; }
      catch (err) {
        if (attempt === 50) throw err;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
    return { url, close };
  } catch (err) { await close(); throw err; }
}
