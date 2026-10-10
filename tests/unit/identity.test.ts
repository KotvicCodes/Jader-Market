import { describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret, formatCredits, hashPassword, normalizeHandle, parseCredits, totp, verifyMfa, verifyPassword } from "../../src/domain/identity";

describe("identities and credit units", () => {
  it("normalizes handles and rejects identifiers outside the allowed alphabet", () => {
    expect(normalizeHandle("  Demo_USER ")).toBe("demo_user");
    expect(() => normalizeHandle("person@example.com")).toThrow();
  });
  it("salts password hashes and rejects incorrect or absent credentials", async () => {
    const password = "synthetic-password-for-tests";
    const hash = await hashPassword(password);
    expect(await hashPassword(password)).not.toBe(hash);
    expect(await verifyPassword(password, hash)).toBe(true);
    expect(await verifyPassword("wrong-password", hash)).toBe(false);
    expect(await verifyPassword(password, null)).toBe(false);
  });
  it("matches RFC 6238 authenticator vectors and rejects replay", () => {
    const secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
    expect(totp(secret, 1, 8)).toBe("94287082");
    expect(totp(secret, Math.floor(1111111109 / 30), 8)).toBe("07081804");
    expect(verifyMfa(secret, "287082", -1, 59000)).toBe(1);
    expect(verifyMfa(secret, "287082", 1, 59000)).toBeUndefined();
    expect(verifyMfa(secret, "000000", -1, 59000)).toBeUndefined();
  });
  it("encrypts authenticator secrets and detects tampering", () => {
    process.env.AUTH_SECRET = "a".repeat(64);
    const encrypted = encryptSecret("SYNTHETICSECRET");
    expect(encrypted).not.toContain("SYNTHETICSECRET");
    expect(decryptSecret(encrypted)).toBe("SYNTHETICSECRET");
    const parts = encrypted.split(".");
    parts[1] = Buffer.alloc(16).toString("base64url");
    expect(() => decryptSecret(parts.join("."))).toThrow();
  });
  it("converts exact decimal credits without floating-point drift", () => {
    expect(parseCredits("0.0001")).toBe(1n);
    expect(parseCredits("12.3456")).toBe(123456n);
    expect(formatCredits(123456n)).toBe("12.3456");
    expect(formatCredits(10000000n)).toBe("1,000.00");
  });
  it.each(["-1", "0", "1e3", "1.00001", "1000001", 10])("rejects invalid credit amount %s", value => {
    expect(() => parseCredits(value)).toThrow();
  });
});
