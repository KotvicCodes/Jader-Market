import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { runAdministrator } from "../fixtures/admin-process";

const original = "SYNTHETIC_SENTINEL=unchanged\n";

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
      const result = await runAdministrator(directory, inputs);
      expect(result.code).toBe(1);
      expect(result.error).toContain(message);
      expect(readFileSync(join(directory, ".env"), "utf8")).toBe(original);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }, 10000);
});
