import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  expire: vi.fn<() => Promise<number>>(),
  settle: vi.fn<() => Promise<number>>(),
  end: vi.fn<() => Promise<void>>(),
  delay: vi.fn<() => Promise<void>>(),
  record: vi.fn<(path: string, success: boolean) => Promise<void>>(),
}));
vi.mock("../../src/db/client", () => ({ getDatabase: () => ({ client: { end: mocks.end } }) }));
vi.mock("../../src/db/trading", () => ({ expireTradingOrders: mocks.expire }));
vi.mock("../../src/db/settlement", () => ({ settleMarkets: mocks.settle }));
vi.mock("../../src/domain/worker-status", () => ({ recordWorkerStatus: mocks.record }));
vi.mock("node:timers/promises", () => ({ setTimeout: mocks.delay }));

const originalArguments = [...process.argv];
const originalExitCode = process.exitCode;
const stop = new Map<string, () => void>();

beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  vi.stubEnv("WORKER_STATUS_FILE", "/synthetic/worker-status.json");
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
  mocks.settle.mockResolvedValue(0);
  mocks.end.mockResolvedValue();
  mocks.delay.mockResolvedValue();
  mocks.record.mockResolvedValue();
});
afterEach(() => {
  process.argv = originalArguments;
  process.exitCode = originalExitCode;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
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
  it("retries settlement failure on a later pass without exposing raw errors", async () => {
    mocks.expire.mockResolvedValue(0);
    mocks.settle.mockRejectedValueOnce(new Error("synthetic-private-error"));
    mocks.settle.mockImplementationOnce(async () => { stop.get("SIGINT")!(); return 1; });
    await import("../../scripts/worker");
    expect(mocks.settle).toHaveBeenCalledTimes(2);
    expect(mocks.end).toHaveBeenCalledTimes(1);
    expect(process.exitCode).toBeUndefined();
    expect(console.error).toHaveBeenCalledExactlyOnceWith("Trading maintenance pass failed; retrying.");
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
  it("continues maintenance when status writes fail without recording successful work as failed", async () => {
    mocks.expire.mockResolvedValueOnce(0);
    mocks.expire.mockRejectedValueOnce(new Error("synthetic-private-database-detail"));
    mocks.expire.mockImplementationOnce(async () => { stop.get("SIGTERM")!(); return 1; });
    mocks.record.mockRejectedValue(new Error("synthetic-private-volume-detail"));
    await import("../../scripts/worker");
    expect(mocks.expire).toHaveBeenCalledTimes(3);
    expect(mocks.settle).toHaveBeenCalledTimes(2);
    expect(mocks.record.mock.calls).toEqual([
      ["/synthetic/worker-status.json", true], ["/synthetic/worker-status.json", false],
      ["/synthetic/worker-status.json", true],
    ]);
    expect(console.error).toHaveBeenCalledTimes(4);
    expect(console.error).toHaveBeenCalledWith("Worker status could not be recorded.");
    expect(console.error).toHaveBeenCalledWith("Trading maintenance pass failed; retrying.");
    expect(console.info).toHaveBeenCalledExactlyOnceWith("Trading maintenance completed.");
    expect(process.exitCode).toBeUndefined();
    expect(mocks.end).toHaveBeenCalledTimes(1);
  });
  it("preserves failed --once behavior when recording that failure also fails", async () => {
    process.argv.push("--once");
    mocks.expire.mockRejectedValue(new Error("synthetic-private-database-detail"));
    mocks.record.mockRejectedValue(new Error("synthetic-private-volume-detail"));
    await import("../../scripts/worker");
    expect(mocks.record).toHaveBeenCalledExactlyOnceWith("/synthetic/worker-status.json", false);
    expect(mocks.settle).not.toHaveBeenCalled();
    expect(mocks.delay).not.toHaveBeenCalled();
    expect(vi.mocked(console.error).mock.calls).toEqual([
      ["Worker status could not be recorded."], ["Worker unavailable: trading maintenance failed."],
    ]);
    expect(console.info).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    expect(mocks.end).toHaveBeenCalledTimes(1);
  });
  it("reports status failure separately after a successful --once maintenance pass", async () => {
    process.argv.push("--once");
    mocks.expire.mockResolvedValue(0);
    mocks.record.mockRejectedValue(new Error("synthetic-private-volume-detail"));
    await import("../../scripts/worker");
    expect(mocks.record).toHaveBeenCalledExactlyOnceWith("/synthetic/worker-status.json", true);
    expect(mocks.settle).toHaveBeenCalledTimes(1);
    expect(mocks.delay).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledExactlyOnceWith("Worker status could not be recorded.");
    expect(console.info).toHaveBeenCalledExactlyOnceWith("Trading maintenance completed.");
    expect(process.exitCode).toBeUndefined();
    expect(mocks.end).toHaveBeenCalledTimes(1);
  });
});
