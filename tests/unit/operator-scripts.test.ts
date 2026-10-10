import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const scripts = JSON.parse(readFileSync("package.json", "utf8")).scripts as Record<string, string>;
const options = `${process.env.NODE_OPTIONS ?? ""} --import=${new URL("../fixtures/block-native-transpiler.mjs", import.meta.url).href}`;
const environment: NodeJS.ProcessEnv = { ...process.env, NODE_OPTIONS: options, DATABASE_URL: "", AUTH_SECRET: "", NODE_ENV: "production" };

describe("portable operator commands", () => {
  it.each([
    ["admin:create", "Administrator setup unavailable"],
    ["admin:recover", "Administrator setup unavailable"],
    ["db:migrate", "Migration unavailable"],
    ["db:seed", "Synthetic seed unavailable"],
    ["worker", "Worker unavailable"],
  ])("loads %s without a native transpiler and retains its safe setup guard", (name, message) => {
    const [, ...args] = scripts[name].split(" ");
    const result = spawnSync(process.execPath, args, { env: environment, encoding: "utf8", timeout: 10_000 });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr.trim()).toMatch(new RegExp(`^${message}[^\\n]*$`));
    expect(result.stdout).toBe("");
  });

  it("rejects the previous tsx entrypoint under the same unavailable-native-compiler condition", () => {
    const result = spawnSync(process.execPath, ["scripts/run.mjs", "tsx", "scripts/admin.ts"], { env: environment, encoding: "utf8", timeout: 10_000 });
    expect(result.error).toBeUndefined();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Native transpiler blocked by portability test.");
    expect(result.stderr).not.toContain("Administrator setup unavailable");
  });
});
