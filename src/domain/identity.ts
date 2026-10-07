import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, scrypt, timingSafeEqual } from "node:crypto";

export class MemberError extends Error {
  constructor(public code: string, public status = 400) { super(code); }
}

export function normalizeHandle(value: unknown) {
  if (typeof value !== "string") throw new MemberError("invalid_handle");
  const handle = value.trim().toLowerCase();
  if (!/^[a-z][a-z0-9_-]{2,31}$/.test(handle)) throw new MemberError("invalid_handle");
  return handle;
}

export function validatePassword(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length < 12 || value.length > 128 || Buffer.byteLength(value) > 512) throw new MemberError("invalid_password");
}

export function digest(value: string) { return createHash("sha256").update(value).digest("hex"); }
export function randomToken() { return randomBytes(32).toString("base64url"); }

function derive(password: string, salt: Buffer) {
  return new Promise<Buffer>((resolve, reject) => scrypt(password, salt, 32, { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 }, (error, key) => error ? reject(error) : resolve(key)));
}

export async function hashPassword(password: string) {
  validatePassword(password);
  const salt = randomBytes(16);
  return `scrypt$32768$8$3$${salt.toString("hex")}$${(await derive(password, salt)).toString("hex")}`;
}

export async function verifyPassword(password: unknown, hash?: string | null) {
  if (typeof password !== "string" || password.length > 128 || Buffer.byteLength(password) > 512) return false;
  const parts = hash?.split("$");
  const valid = parts?.length === 6 && parts.slice(0, 4).join("$") === "scrypt$32768$8$3" && /^[a-f0-9]{32}$/.test(parts[4]) && /^[a-f0-9]{64}$/.test(parts[5]);
  const salt = valid ? Buffer.from(parts[4], "hex") : Buffer.alloc(16);
  const expected = valid ? Buffer.from(parts[5], "hex") : Buffer.alloc(32);
  const actual = await derive(password, salt);
  return timingSafeEqual(actual, expected) && Boolean(valid);
}

function encryptionKey() {
  const secret = process.env.AUTH_SECRET;
  if (!secret || !/^[a-f0-9]{64}$/.test(secret)) throw new MemberError("configuration", 503);
  return Buffer.from(secret, "hex");
}

export function rateKey(scope: string, value: string) { return `${scope}:${createHmac("sha256", encryptionKey()).update(value).digest("hex")}`; }

export function encryptSecret(value: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), encrypted].map(part => part.toString("base64url")).join(".");
}

export function decryptSecret(value: string) {
  const [iv, tag, encrypted] = value.split(".").map(part => Buffer.from(part, "base64url"));
  const cipher = createDecipheriv("aes-256-gcm", encryptionKey(), iv);
  cipher.setAuthTag(tag);
  return Buffer.concat([cipher.update(encrypted), cipher.final()]).toString("utf8");
}

const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
export function newMfaSecret() {
  let bits = "";
  for (const byte of randomBytes(20)) bits += byte.toString(2).padStart(8, "0");
  return bits.match(/.{5}/g)!.map(chunk => alphabet[parseInt(chunk, 2)]).join("");
}

export function totp(secret: string, step: number, digits = 6) {
  let bits = "";
  for (const char of secret) {
    const value = alphabet.indexOf(char);
    if (value < 0) throw new MemberError("invalid_mfa");
    bits += value.toString(2).padStart(5, "0");
  }
  const key = Buffer.from(bits.match(/.{8}/g)!.map(chunk => parseInt(chunk, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const hash = createHmac("sha1", key).update(counter).digest();
  const offset = hash[hash.length - 1] & 15;
  return ((hash.readUInt32BE(offset) & 0x7fffffff) % 10 ** digits).toString().padStart(digits, "0");
}

export function verifyMfa(secret: string, code: unknown, lastStep = -1, now = Date.now()) {
  if (typeof code !== "string" || !/^\d{6}$/.test(code)) return undefined;
  const step = Math.floor(now / 30000);
  for (const candidate of [step, step - 1, step + 1]) {
    if (candidate > lastStep && timingSafeEqual(Buffer.from(totp(secret, candidate)), Buffer.from(code))) return candidate;
  }
  return undefined;
}

export function parseCredits(value: unknown) {
  if (typeof value !== "string" || !/^(?:0|[1-9]\d{0,6})(?:\.\d{1,4})?$/.test(value)) throw new MemberError("invalid_amount");
  const [whole, fraction = ""] = value.split(".");
  const amount = BigInt(whole) * 10_000n + BigInt(fraction.padEnd(4, "0"));
  if (amount < 1n || amount > 10_000_000_000n) throw new MemberError("invalid_amount");
  return amount;
}

export function formatCredits(value: bigint) {
  const negative = value < 0n;
  const units = negative ? -value : value;
  const whole = (units / 10_000n).toLocaleString("en-US");
  const decimals = (units % 10_000n).toString().padStart(4, "0").replace(/0+$/, "").padEnd(2, "0");
  return `${negative ? "-" : ""}${whole}.${decimals}`;
}
