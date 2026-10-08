import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const original = "SYNTHETIC_SENTINEL=unchanged\n";

async function failedSetup(directory: string, inputs: string[]) {
  return new Promise<{ code: number | null; error: string }>((done, fail) => {
    const child = spawn(process.execPath, ["--import", "tsx", resolve("scripts/admin.ts")], {
      cwd: directory,
      env: { ...process.env, AUTH_SECRET: "", DATABASE_URL: "postgresql://synthetic:synthetic@127.0.0.1:1/synthetic", NODE_OPTIONS: `--import=${resolve("tests/fixtures/admin-terminal.mjs")}`, FORCE_COLOR: "0" },
      stdio: "pipe",
    });
    let output = ""; let error = ""; let step = 0;
    const prompts = ["Administrator handle [admin]: ", "Password (12 to 128 characters, hidden): ", "Repeat password (hidden): "];
    const timeout = setTimeout(() => { child.kill(); fail(new Error("Administrator prompt test timed out.")); }, 8000);
    child.stdout.on("data", chunk => {
      output += chunk.toString();
      if (step < inputs.length && output.includes(prompts[step])) {
        child.stdin.write(inputs[step]);
        step++;
        if (step === inputs.length) child.stdin.end();
      }
    });
    child.stderr.on("data", chunk => { error += chunk.toString(); });
    child.on("error", error => { clearTimeout(timeout); fail(error); });
    child.on("exit", code => { clearTimeout(timeout); done({ code, error }); });
  });
}

describe("administrator setup cancellation and validation", () => {
  it.each([
    [["admin\n", "synthetic-password-one\n", "synthetic-password-two\n"], "The passwords did not match."],
    [["admin\n", "short\n", "short\n"], "Use a password between 12 and 128 characters."],
    [["admin\n", "\u0003"], "Administrator setup cancelled."],
  ])("keeps .env unchanged on a failed prompt flow", async (inputs, message) => {
    mkdirSync(resolve(".cache"), { recursive: true });
    const directory = mkdtempSync(resolve(".cache/admin-setup-"));
    try {
      writeFileSync(join(directory, ".env"), original);
      const result = await failedSetup(directory, inputs);
      expect(result.code).toBe(1);
      expect(result.error).toContain(message);
      expect(readFileSync(join(directory, ".env"), "utf8")).toBe(original);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }, 10000);
});
