import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

it("keeps exported deployment settings out of the disposable rehearsal and its cleanup", () => {
  const directory = mkdtempSync(join(tmpdir(), "jader-isolation-"));
  const report = join(directory, "report.jsonl");
  try {
    // Stop at the first Docker operation: no daemon or real deployment is used.
    writeFileSync(join(directory, "openssl"), "#!/usr/bin/env node\n", { mode: 0o700 });
    writeFileSync(join(directory, "docker"), `#!/usr/bin/env node
import fs from 'node:fs';
const args = process.argv.slice(2);
const file = args[args.indexOf('--env-file') + 1];
const settings = Object.fromEntries(fs.readFileSync(file, 'utf8').trim().split('\\n').map(line => {
  const separator = line.indexOf('='); return [line.slice(0, separator), line.slice(separator + 1)];
}));
const isolated = Object.entries(settings).every(([key, value]) => process.env[key] === value)
  && settings.JADER_HOST === 'localhost' && settings.JADER_IMAGE === 'jader-market:deployment-test'
  && new URL(settings.JADER_OWNER_DATABASE_URL).hostname === 'db'
  && new URL(settings.JADER_RUNTIME_DATABASE_URL).hostname === 'db'
  && settings.AUTH_SECRET !== 'production-key'
  && !Object.keys(process.env).some(key => key.startsWith('COMPOSE_'));
fs.appendFileSync(process.env.JADER_ISOLATION_REPORT, JSON.stringify({ isolated, cleanup: args.includes('down') }) + '\\n');
process.exit(args.includes('down') ? 0 : 1);
`, { mode: 0o700 });
    const result = spawnSync(process.execPath, ["scripts/test-deployment.mjs"], {
      env: { ...process.env, PATH: `${directory}:${process.env.PATH}`, JADER_ISOLATION_REPORT: report,
        JADER_HOST: "production.invalid", JADER_IMAGE: "production-image", AUTH_SECRET: "production-key",
        JADER_OWNER_DATABASE_URL: "postgresql://owner:private@production.invalid/production",
        JADER_RUNTIME_DATABASE_URL: "postgresql://runtime:private@production.invalid/production",
        COMPOSE_PROFILES: "production", DEPLOYMENT_TEST_IMAGE: "jader-market:deployment-test" },
      encoding: "utf8", timeout: 10_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(readFileSync(report, "utf8").trim().split("\n").map(line => JSON.parse(line))).toEqual([
      { isolated: true, cleanup: false }, { isolated: true, cleanup: true },
    ]);
    expect(result.stderr).not.toContain("production-key");
    expect(result.stderr).not.toContain("private");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
