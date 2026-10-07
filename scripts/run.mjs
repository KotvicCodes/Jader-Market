import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const temporaryDirectory = join(root, ".cache", "tmp");
mkdirSync(temporaryDirectory, { recursive: true });
const [command, ...args] = process.argv.slice(2);
const child = spawn(command === "node" ? process.execPath : command, args, {
  cwd: root,
  stdio: "inherit",
  env: { ...process.env, TMPDIR: temporaryDirectory, NEXT_TELEMETRY_DISABLED: "1" },
});
child.on("error", () => { console.error("The requested development command could not start."); process.exitCode = 1; });
child.on("exit", (code) => { process.exitCode = code ?? 1; });
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
