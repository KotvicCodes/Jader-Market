import { afterEach, describe, expect, it, vi } from "vitest";
import { appOrigin } from "../../src/auth/configuration";

afterEach(() => { vi.unstubAllEnvs(); });

describe("application origin configuration", () => {
  it("requires an explicit origin in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("APP_ORIGIN", undefined);
    expect(appOrigin).toThrow(expect.objectContaining({ code: "configuration", status: 503 }));
  });
  it("keeps the localhost default during development", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("APP_ORIGIN", undefined);
    expect(appOrigin()).toBe("http://localhost:3000");
  });
  it.each(["https://example.invalid", "http://127.0.0.1:3000"])("accepts an explicitly configured production origin: %s", origin => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("APP_ORIGIN", origin);
    expect(appOrigin()).toBe(origin);
  });
});
