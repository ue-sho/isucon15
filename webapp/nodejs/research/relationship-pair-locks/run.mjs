// Always creates a fresh local PG16 container. No external database URL is accepted.
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

const name = `isu15-pair-lock-lab-${randomUUID()}`;
const token = randomUUID();
const docker = (...args) => execFileSync("docker", args, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
let created = false;
let child;
const cleanup = () => {
  if (created) { docker("rm", "-f", name); created = false; }
};
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => {
  child?.kill(signal);
  cleanup();
  process.exit(1);
});
try {
  docker("run", "--rm", "-d", "--name", name, "--label", "isucon.research=relationship-pair-locks",
    "--tmpfs", "/var/lib/postgresql/data:rw", "-e", "POSTGRES_HOST_AUTH_METHOD=trust",
    "-e", "POSTGRES_DB=pair_lock_lab", "-p", "127.0.0.1::5432", "postgres:16",
    "-c", "statement_timeout=6000", "-c", "deadlock_timeout=200");
  created = true;
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    // The image's temporary initialization server accepts Unix sockets only.
    try { docker("exec", name, "pg_isready", "-h", "127.0.0.1", "-U", "postgres", "-d", "pair_lock_lab"); ready = true; break; }
    catch { await delay(100); } // Startup readiness only, not concurrency evidence.
  }
  if (!ready) throw new Error("disposable PostgreSQL did not start");
  docker("exec", name, "psql", "-h", "127.0.0.1", "-U", "postgres", "-d", "pair_lock_lab", "-v", "ON_ERROR_STOP=1", "-c",
    `CREATE TABLE pair_lock_lab_marker(token text); INSERT INTO pair_lock_lab_marker VALUES ('${token}')`);
  const binding = docker("port", name, "5432/tcp");
  if (!/^127\.0\.0\.1:\d+$/.test(binding)) throw new Error("expected loopback-only port");
  console.log(`image=${docker("inspect", "--format", "{{.Image}}", name)} node=${process.version}`);
  child = spawn(process.execPath, ["--test", "--test-concurrency=1", new URL("lab.test.ts", import.meta.url).pathname], {
    stdio: "inherit", env: { ...process.env, PAIR_LAB_PORT: binding.split(":")[1], PAIR_LAB_TOKEN: token },
  });
  process.exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 1));
  });
} finally { cleanup(); }
