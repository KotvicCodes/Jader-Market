import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  expire: vi.fn<() => Promise<number>>(),
  end: vi.fn<() => Promise<void>>(),
  delay: vi.fn<() => Promise<void>>(),
}));
vi.mock("../../src/db/client", () => ({ getDatabase: () => ({ client: { end: mocks.end } }) }));
vi.mock("../../src/db/trading", () => ({ expireTradingOrders: mocks.expire }));
vi.mock("node:timers/promises", () => ({ setTimeout: mocks.delay }));

const originalArguments = [...process.argv];
const originalExitCode = process.exitCode;
const stop = new Map<string, () => void>();

beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  process.argv = [...originalArguments];
  process.exitCode = undefined;
  stop.clear();
  const on = process.on.bind(process);
  vi.spyOn(process, "on").mockImplementation((event, listener) => {
    if (event === "SIGINT" || event === "SIGTERM") {
      stop.set(event, listener);
      return process;
    }
    return on(event, listener);
  });
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  mocks.end.mockResolvedValue();
  mocks.delay.mockResolvedValue();
});
afterEach(() => {
  process.argv = originalArguments;
  process.exitCode = originalExitCode;
  vi.restoreAllMocks();
});

describe("trading maintenance worker", () => {
  it("retries a failed pass and responds to shutdown after a later successful pass", async () => {
    mocks.expire.mockRejectedValueOnce(new Error("synthetic-private-database-detail"));
    mocks.expire.mockImplementationOnce(async () => { stop.get("SIGTERM")!(); return 1; });
    await import("../../scripts/worker");
    expect(mocks.expire).toHaveBeenCalledTimes(2);
    expect(mocks.delay).toHaveBeenCalledWith(1000);
    expect(process.exitCode).toBeUndefined();
    expect(console.error).toHaveBeenCalledExactlyOnceWith("Trading maintenance pass failed; retrying.");
    expect(console.info).toHaveBeenCalledExactlyOnceWith("Trading maintenance completed.");
    expect(mocks.end).toHaveBeenCalledTimes(1);
  });
  it("exits unsuccessfully after a failed --once pass without retries or raw errors", async () => {
    process.argv.push("--once");
    mocks.expire.mockRejectedValue(new Error("synthetic-private-database-detail"));
    await import("../../scripts/worker");
    expect(mocks.expire).toHaveBeenCalledTimes(1);
    expect(mocks.delay).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    expect(console.error).toHaveBeenCalledExactlyOnceWith("Worker unavailable: trading maintenance failed.");
    expect(console.info).not.toHaveBeenCalled();
    expect(mocks.end).toHaveBeenCalledTimes(1);
  });
  it("completes one successful --once pass without waiting", async () => {
    process.argv.push("--once");
    mocks.expire.mockResolvedValue(1);
    await import("../../scripts/worker");
    expect(mocks.expire).toHaveBeenCalledTimes(1);
    expect(mocks.delay).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
    expect(console.error).not.toHaveBeenCalled();
    expect(console.info).toHaveBeenCalledExactlyOnceWith("Trading maintenance completed.");
    expect(mocks.end).toHaveBeenCalledTimes(1);
  });
});
