// Disposable synthetic deployment only. Never reads .env or production settings.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import https from "node:https";
import http from "node:http";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";

const directory = mkdtempSync(join(tmpdir(), "jader-deployment-"));
const project = `jader-proof-${randomBytes(5).toString("hex")}`;
const environmentFile = join(directory, "test.env");
const overrideFile = join(directory, "compose.yaml");
const password = randomBytes(24).toString("hex");
const port = 32000 + Math.floor(Math.random() * 20000);
let stage = "certificate setup";
const image = process.env.DEPLOYMENT_TEST_IMAGE ?? "jader-market:deployment-test";
const syntheticEnvironment = {
  JADER_HOST: "localhost", JADER_IMAGE: image,
  JADER_BOOTSTRAP_PASSWORD: password,
  JADER_OWNER_PASSWORD: randomBytes(24).toString("hex"),
  JADER_RUNTIME_PASSWORD: randomBytes(24).toString("hex"),
  AUTH_SECRET: randomBytes(32).toString("hex"), JADER_TLS_DIRECTORY: directory,
};
syntheticEnvironment.JADER_OWNER_DATABASE_URL = `postgresql://jader_owner:${syntheticEnvironment.JADER_OWNER_PASSWORD}@db:5432/jader_market`;
syntheticEnvironment.JADER_RUNTIME_DATABASE_URL = `postgresql://jader_runtime:${syntheticEnvironment.JADER_RUNTIME_PASSWORD}@db:5432/jader_market`;
// Compose gives the shell precedence over --env-file. Pin every deployment
// setting for all subprocesses, including cleanup, and discard Compose defaults.
const commandEnvironment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("COMPOSE_")));
Object.assign(commandEnvironment, syntheticEnvironment);
const baseArgs = ["compose", "--project-name", project, "--env-file", environmentFile,
  "-f", resolve("deploy/compose.yaml"), "-f", overrideFile];
function run(command, args, input) {
  const result = spawnSync(command, args, { input, env: commandEnvironment, encoding: "utf8", timeout: 300_000 });
  // Never print command output: it can include container environment and secrets.
  assert.equal(result.error, undefined, "Deployment command could not complete");
  assert.equal(result.status, 0, "Deployment command failed");
  return result.stdout;
}
function compose(args, input) { return run("docker", [...baseArgs, ...args], input); }
function request(path, body, headers = {}, tls = true) {
  return new Promise((resolveResponse, reject) => {
    const request = (tls ? https : http).request({ host: "127.0.0.1", port: tls ? port : port + 1,
      path, method: body ? "POST" : "GET", servername: "localhost",
      ...(tls ? { ca: readFileSync(join(directory, "fullchain.pem")) } : {}), timeout: 8000,
      headers: { Host: "localhost", ...(body ? { "Content-Type": "application/json", Origin: "https://localhost" } : {}), ...headers } }, response => {
      let text = "";
      response.on("data", data => { text += data; });
      response.on("end", () => resolveResponse({ status: response.statusCode, headers: response.headers, text }));
    });
    request.on("error", reject);
    request.on("timeout", () => request.destroy(new Error("timeout")));
    request.end(body ? JSON.stringify(body) : undefined);
  });
}
try {
  run("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost",
    "-keyout", join(directory, "privkey.pem"), "-out", join(directory, "fullchain.pem")]);
  writeFileSync(environmentFile, Object.entries(syntheticEnvironment).map(([key, value]) => `${key}=${value}\n`).join(""), { mode: 0o600 });
  writeFileSync(overrideFile, `services:\n  proxy:\n    ports: !override ["127.0.0.1:${port}:443", "127.0.0.1:${port + 1}:80"]\n`, { mode: 0o600 });
  console.info("Checking isolated deployment initialization and migrations.");
  stage = "database initialization";
  compose(["up", "-d", "--wait", "db"]);
  stage = "owner migrations and runtime grants";
  compose(["run", "--rm", "-T", "migrate"]);
  stage = "synthetic participant setup";
  const setup = `import { getDatabase } from './src/db/client.ts'; import { hashPassword } from './src/domain/identity.ts'; import { users } from './src/db/schema.ts'; const c=getDatabase(); try { await c.db.insert(users).values({handle:'deployment_probe',passwordHash:await hashPassword('${password}')}); } finally { await c.client.end(); }`;
  compose(["run", "--rm", "-T", "migrate", "node", "--import", "./scripts/register-typescript.mjs", "--input-type=module", "-e", setup]);
  stage = "service startup";
  compose(["up", "-d", "--wait", "--wait-timeout", "90", "app", "worker", "monitor", "proxy"]);
  stage = "HTTPS version, readiness and redirects";
  const health = await request("/api/health");
  assert.equal(health.status, 200);
  assert.equal(JSON.parse(health.text).version, JSON.parse(readFileSync("package.json", "utf8")).version);
  assert.equal((await request("/api/ready")).status, 200);
  assert.equal((await request("/api/health", null, { Host: "unexpected.invalid" })).status, 421);
  assert.match(health.headers["strict-transport-security"], /max-age=31536000/);
  const redirect = await request("/account", null, {}, false);
  assert.equal(redirect.status, 308); assert.equal(redirect.headers.location, "https://localhost/account");
  console.info("Checking HTTPS cookies, origin rejection and proxy header overwrite.");
  stage = "HTTPS cookies and trusted proxy overwrite";
  for (const address of ["192.0.2.1", "192.0.2.2"]) {
    const login = await request("/api/auth/sign-in", { handle: "deployment_probe", password }, { "X-Real-IP": address, "X-Forwarded-For": address });
    assert.equal(login.status, 200);
    assert.ok(login.headers["set-cookie"].every(cookie => /; Secure/i.test(cookie) && /SameSite=strict/i.test(cookie)));
    assert.ok(login.headers["set-cookie"].some(cookie => /jader_session=.*HttpOnly/i.test(cookie)));
    assert.match(login.headers["cache-control"], /no-store/);
  }
  const buckets = compose(["exec", "-T", "db", "psql", "-U", "jader_bootstrap", "-d", "jader_market", "-Atc", "SELECT count(*) FROM rate_limits"]);
  assert.equal(buckets.trim(), "2", "Spoofed IP headers must share the real connection's two rate-limit buckets");
  assert.equal((await request("/api/auth/sign-in", { handle: "deployment_probe", password }, { Origin: "https://example.invalid" })).status, 403);
  for (const service of ["app", "db", "worker", "monitor"]) {
    const id = compose(["ps", "-q", service]).trim();
    const [container] = JSON.parse(run("docker", ["inspect", id]));
    assert.equal(Object.keys(container.HostConfig.PortBindings ?? {}).length, 0, "Private service must not publish a port");
    assert.equal(container.HostConfig.RestartPolicy.Name, "unless-stopped");
  }
  const [network] = JSON.parse(run("docker", ["network", "inspect", `${project}_backend`]));
  assert.equal(network.Internal, true);
  console.info("Checking HTTPS recovery after the app changes its container address.");
  stage = "app replacement behind a running proxy";
  const [oldApp] = JSON.parse(run("docker", ["inspect", compose(["ps", "-q", "app"]).trim()]));
  const oldAddress = oldApp.NetworkSettings.Networks[`${project}_backend`].IPAddress;
  compose(["stop", "app"]);
  compose(["rm", "-f", "app"]);
  // Occupy the released address so this exercises DNS changes deterministically.
  const holder = run("docker", ["run", "-d", "--rm", "--network", `${project}_backend`,
    "--entrypoint", "node", image, "-e", "setInterval(()=>{},1000)"]).trim();
  try {
    compose(["up", "-d", "--no-deps", "--wait", "--wait-timeout", "60", "app"]);
    const [newApp] = JSON.parse(run("docker", ["inspect", compose(["ps", "-q", "app"]).trim()]));
    assert.notEqual(newApp.NetworkSettings.Networks[`${project}_backend`].IPAddress, oldAddress);
    assert.equal((await request("/api/ready")).status, 200);
  } finally { run("docker", ["rm", "-f", holder]); }
  console.info("Checking automatic worker restart after process exit.");
  stage = "automatic worker restart";
  const workerId = compose(["ps", "-q", "worker"]).trim();
  // Kill the supervised process inside the namespace. Docker's own `kill`
  // command counts as a manual stop and deliberately suppresses restarts.
  const crash = spawnSync("docker", [...baseArgs, "exec", "-T", "worker", "node", "-e",
    "const child=Number(require('node:fs').readFileSync('/proc/1/task/1/children','utf8').trim().split(' ')[0]); if(!child)process.exit(1); process.kill(child,'SIGKILL');"],
    { env: commandEnvironment, encoding: "utf8", timeout: 10_000 });
  assert.equal(crash.error, undefined);
  let restarted = false;
  for (let attempt = 0; attempt < 20; attempt++) {
    await delay(1000);
    const [worker] = JSON.parse(run("docker", ["inspect", workerId]));
    if (worker.State.Running && worker.RestartCount >= 1) {
      const heartbeat = JSON.parse(compose(["exec", "-T", "worker", "node", "-e",
        "console.log(require('node:fs').readFileSync(process.env.WORKER_STATUS_FILE,'utf8'))"]));
      if (heartbeat.checkedAt >= Date.parse(worker.State.StartedAt)) { restarted = true; break; }
    }
  }
  assert.ok(restarted, "Worker must restart after an unexpected process exit");
  console.info("Checking worker loss alert and successful restart recovery.");
  stage = "worker-stop alert and restart";
  compose(["stop", "worker"]);
  const [stoppedWorker] = JSON.parse(run("docker", ["inspect", workerId]));
  assert.equal(stoppedWorker.State.ExitCode, 0, "SIGTERM must reach the worker and allow a clean exit");
  assert.match(run("docker", ["logs", workerId]), /Trading maintenance completed\./);
  await delay(32_000);
  const failedCheck = spawnSync("docker", [...baseArgs, "exec", "-T", "monitor", "npm", "run", "ops:check"], { env: commandEnvironment, encoding: "utf8", timeout: 30_000 });
  assert.equal(failedCheck.status, 1); assert.match(failedCheck.stdout, /worker_stale/);
  compose(["start", "worker"]);
  await delay(3000);
  compose(["exec", "-T", "monitor", "npm", "run", "ops:check"]);
  console.info("Isolated production deployment checks passed.");
} catch {
  console.error(`Isolated deployment checks failed at ${stage}; output with secrets was suppressed.`);
  process.exitCode = 1;
} finally {
  const cleanup = spawnSync("docker", [...baseArgs, "down", "--volumes", "--remove-orphans"], { env: commandEnvironment, stdio: "ignore", timeout: 60_000 });
  if (cleanup.status !== 0) { console.error(`Synthetic deployment cleanup failed: project ${project}.`); process.exitCode = 1; }
  rmSync(directory, { recursive: true, force: true });
}
