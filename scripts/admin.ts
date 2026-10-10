import "dotenv/config";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { getDatabase } from "../src/db/client";
import { bootstrapAdministrator, recoverAdministrator } from "../src/db/members";
import { encryptSecret, MemberError, normalizeHandle, validatePassword } from "../src/domain/identity";

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
  await getDatabase()!.client`select 1`;
  // Generate the local encryption key once. It is never printed or stored in git.
  if (!process.env.AUTH_SECRET) {
    if (recover) throw new MemberError("configuration");
    const secret = randomBytes(32).toString("hex");
    const previous = existsSync(".env") ? readFileSync(".env", "utf8") : "";
    const next = /^AUTH_SECRET=.*$/m.test(previous) ? previous.replace(/^AUTH_SECRET=.*$/m, `AUTH_SECRET=${secret}`) : `${previous.trimEnd()}\nAUTH_SECRET=${secret}\n`;
    writeFileSync(".env", next, { mode: 0o600 });
    chmodSync(".env", 0o600);
    process.env.AUTH_SECRET = secret;
  }
  encryptSecret("configuration check");
  if (recover) await recoverAdministrator(handle, password);
  else await bootstrapAdministrator(handle, password);
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
