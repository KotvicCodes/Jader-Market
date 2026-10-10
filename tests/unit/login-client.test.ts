import { describe, expect, it } from "vitest";
import { signInClient } from "../../src/auth/login-client";
const config = { header: "x-real-ip", environment: "production" };
const request = (address?: string, headers = {}) => new Request("https://example.invalid/api/auth/sign-in", { headers: { ...(address ? { "x-real-ip": address } : {}), ...headers } });

describe("trusted sign-in identity", () => {
  it("requires an explicitly configured production proxy instead of trusting arbitrary headers", () => {
    expect(() => signInClient(request("192.0.2.1"), { environment: "production" })).toThrow();
    expect(signInClient(request(), { environment: "development" })).toBe("local-development");
    expect(() => signInClient(request(undefined, { "x-forwarded-for": "192.0.2.1" }), config)).toThrow();
    expect(() => signInClient(request("192.0.2.1"), { ...config, header: "invalid header" })).toThrow();
  });
  it("uses only the selected proxy header and normalizes address aliases", () => {
    expect(signInClient(request("192.0.2.1", { "x-forwarded-for": "198.51.100.1" }), config)).toBe("192.0.2.1");
    expect(signInClient(request("2001:0DB8:0:0:0:0:0:1"), config)).toBe("2001:db8::1");
    expect(signInClient(request("::ffff:192.0.2.1"), config)).toBe("192.0.2.1");
    expect(signInClient(request("::FFFF:c000:201"), config)).toBe("192.0.2.1");
  });
  it.each([undefined, "", "unknown", "192.0.2.1, 198.51.100.1", "192.0.2.1:80", "[2001:db8::1]", "fe80::1%eth0", "999.1.1.1", "x".repeat(100)])("rejects malformed or absent proxy addresses: %s", address => {
    expect(() => signInClient(request(address), config)).toThrow();
  });
});
