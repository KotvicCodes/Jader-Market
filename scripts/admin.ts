import "dotenv/config";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { parse } from "dotenv";
import { createInterface } from "node:readline/promises";
import { getDatabase } from "../src/db/client";
import { bootstrapAdministrator, recoverAdministrator } from "../src/db/members";
import { encryptSecret, MemberError, normalizeHandle, validatePassword } from "../src/domain/identity";
import { assertDatabaseReady } from "../src/db/readiness";

async function configureAdministrator(handle: string, password: string, recover: boolean) {
  const connection = getDatabase()!;
  // Keep the filesystem decision serialized with other operator commands. This
  // session lock remains held during rollback and is released on process death.
  const operator = await connection.client.reserve();
  let previous: string | undefined;
  let written: string | undefined;
  let previousMode = 0o600;
  const temporary = `.env.admin-${process.pid}-${randomBytes(8).toString("hex")}`;
  try {
    await operator`SELECT pg_advisory_lock(72491946)`;
    await assertDatabaseReady(connection.db);
    if (!recover && (await operator`SELECT id FROM users WHERE role = 'admin' LIMIT 1`).length) throw new MemberError("admin_exists", 409);
    previous = existsSync(".env") ? readFileSync(".env", "utf8") : undefined;
    if (previous !== undefined) previousMode = statSync(".env").mode & 0o777;
    const savedSecret = previous === undefined ? undefined : parse(previous).AUTH_SECRET;
    // An explicitly empty environment value must never replace a saved key.
    if (!process.env.AUTH_SECRET && savedSecret) throw new MemberError("configuration");
    if (!process.env.AUTH_SECRET) {
      if (recover) throw new MemberError("configuration");
      // Refuse replacement keys for an already initialized encrypted identity.
      if ((await operator`SELECT id FROM users WHERE mfa_secret IS NOT NULL LIMIT 1`).length ||
        (await operator`SELECT token_hash FROM sessions WHERE pending_mfa IS NOT NULL LIMIT 1`).length) throw new MemberError("configuration");
      const secret = randomBytes(32).toString("hex");
      const source = previous ?? "";
      // dotenv uses the last assignment, including exported/whitespace variants.
      // Append so a later empty duplicate cannot mask the generated key on reload.
      const next = `${source.trimEnd()}\nAUTH_SECRET=${secret}\n`;
      writeFileSync(temporary, next, { mode: 0o600, flag: "wx" });
      renameSync(temporary, ".env");
      written = next;
      process.env.AUTH_SECRET = secret;
    }
    encryptSecret("configuration check");
    if (recover) await recoverAdministrator(handle, password);
    else await bootstrapAdministrator(handle, password);
  } catch (error) {
    // Preserve unrelated operator edits rather than overwriting them on failure.
    if (written !== undefined && existsSync(".env") && readFileSync(".env", "utf8") === written) {
      if (previous === undefined) rmSync(".env");
      else {
        writeFileSync(temporary, previous, { mode: previousMode, flag: "wx" });
        renameSync(temporary, ".env");
        chmodSync(".env", previousMode);
      }
    }
    throw error;
  } finally {
    rmSync(temporary, { force: true });
    try { await operator`SELECT pg_advisory_unlock(72491946)`; }
    finally { operator.release(); }
  }
}

async function hiddenPassword(prompt: string) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new MemberError("terminal_required");
  process.stdout.write(prompt);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  return new Promise<string>((resolve, reject) => {
    let value = "";
    function finish(error?: Error) {
      process.stdin.off("data", receive);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write("\n");
      if (error) reject(error); else resolve(value);
    }
    function receive(chunk: Buffer) {
      for (const char of chunk.toString("utf8")) {
        if (char === "\u0003") { finish(new MemberError("cancelled")); return; }
        if (char === "\r" || char === "\n") { finish(); return; }
        if (char === "\u007f" || char === "\b") value = Array.from(value).slice(0, -1).join("");
        else if (char >= " ") value += char;
      }
      if (value.length > 128) finish(new MemberError("invalid_password"));
    }
    process.stdin.on("data", receive);
  });
}

try {
  if (!process.stdin.isTTY || !getDatabase()) throw new MemberError("configuration");
  const recover = process.argv.includes("--recover");
  const input = createInterface({ input: process.stdin, output: process.stdout });
  const handle = (await input.question("Administrator handle [admin]: ")).trim() || "admin";
  input.close();
  const password = await hiddenPassword("Password (12 to 128 characters, hidden): ");
  const confirmation = await hiddenPassword("Repeat password (hidden): ");
  if (password !== confirmation) throw new MemberError("password_mismatch");
  normalizeHandle(handle);
  validatePassword(password);
  await configureAdministrator(handle, password, recover);
  console.info(recover ? "Administrator recovered. Existing sessions were revoked." : "Administrator created with zero credits.");
  console.info("Sign in on the Account page, then set up your authenticator before using Admin.");
} catch (error) {
  const messages: Record<string, string> = {
    admin_exists: "An administrator already exists. Use admin:recover only for local owner recovery.",
    invalid_handle: "Use a 3 to 32 character handle starting with a letter, followed by letters, numbers, underscores, or hyphens.",
    invalid_password: "Use a password between 12 and 128 characters.",
    password_mismatch: "The passwords did not match.",
    cancelled: "Administrator setup cancelled.",
  };
  console.error(error instanceof MemberError && messages[error.code] ? messages[error.code] : "Administrator setup unavailable. Use an interactive terminal and check database configuration and migrations.");
  process.exitCode = 1;
} finally {
  await getDatabase()?.client.end();
}
