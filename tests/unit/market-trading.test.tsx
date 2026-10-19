// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MarketTrading } from "../../src/components/market-trading";
import type { tradingSnapshot } from "../../src/db/trading";

const { refresh } = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));
const marketId = "11111111-1111-4111-8111-111111111111";
const ownerId = "22222222-2222-4222-8222-222222222222";
const key = `jader:pending-trade:${ownerId}:${marketId}`;
const close = "2035-12-31T12:00:00.000Z";
type Snapshot = Awaited<ReturnType<typeof tradingSnapshot>>;
let root: Root;
let container: HTMLDivElement;
let snapshot: Snapshot;
let fetchMock: ReturnType<typeof vi.fn>;

async function render(override: Partial<Snapshot> = {}, synthetic = false, deadline = close) {
  await act(async () => { root.render(<MarketTrading marketId={marketId} ownerId={ownerId} csrf="test-csrf" closesAt={deadline} synthetic={synthetic} snapshot={{ ...snapshot, ...override }} />); });
}
function button(text: string) {
  const found = Array.from(container.querySelectorAll("button")).find(node => node.textContent === text);
  if (!found) throw new Error(`Button missing: ${text}`);
  return found;
}
async function click(text: string) { await act(async () => { button(text).click(); }); }
async function field(name: string, value: string) {
  const node = container.querySelector<HTMLInputElement | HTMLSelectElement>(`[name="${name}"]`)!;
  await act(async () => {
    node.value = value;
    node.dispatchEvent(new Event(node instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
  });
}
async function prepareBuy() {
  await field("price", "0.2501");
  await field("quantity", "3");
  await click("Review order");
}
function response(data: unknown, status = 200) { return new Response(JSON.stringify(data), { status }); }

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  sessionStorage.clear();
  refresh.mockReset();
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  snapshot = { status: "open", availableCredits: "1000000", reservedCredits: "0", holdings: [], openOrders: [], orders: [], fills: [], nextCursor: null, nextFillCursor: null };
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("participant trading controls", () => {
  it("requires review, shows the exact reservation and refreshes after a confirmed partial fill", async () => {
    await render();
    await prepareBuy();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Reserve up to 0.7503 credits");
    fetchMock.mockImplementation(async (_url, options) => {
      const body = JSON.parse(options.body);
      expect(options.headers["X-CSRF-Token"]).toBe("test-csrf");
      expect(JSON.parse(sessionStorage.getItem(key)!).body).toEqual(body);
      expect(body).toMatchObject({ price: "2501", quantity: "3", side: "buy", outcome: "YES", timeInForce: "GTC" });
      return response({ order: { id: body.operationKey, quantity: "3", remaining: "1", status: "open" } });
    });
    await click("Confirm order");
    expect(container.textContent).toContain("2 of 3 shares filled; 1 remain open and reserved");
    expect(sessionStorage.getItem(key)).toBeNull();
    expect(refresh).toHaveBeenCalledOnce();
  });
  it("recovers a lost response after remount and retries the exact payload once on double-click", async () => {
    await render();
    await prepareBuy();
    fetchMock.mockRejectedValueOnce(new TypeError("Network failure"));
    await click("Confirm order");
    const original = fetchMock.mock.calls[0][1].body;
    expect(button("Review order").matches(":disabled")).toBe(true);
    await act(async () => root.unmount());
    root = createRoot(container);
    await render();
    expect(container.textContent).toContain("Confirm an earlier request");
    expect(button("Review order").matches(":disabled")).toBe(true);
    let finish!: (value: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise<Response>(resolve => { finish = resolve; }));
    await act(async () => { button("Retry same request").click(); button("Retry same request").click(); });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][1].body).toBe(original);
    const body = JSON.parse(original);
    await act(async () => { finish(response({ order: { id: body.operationKey, quantity: "3", remaining: "0", status: "filled" } })); });
    expect(container.textContent).toContain("Order filled: 3 of 3 shares");
    expect(sessionStorage.getItem(key)).toBeNull();
  });
  it.each(["success", "rejection"] as const)("preserves a newer trade after navigation when an old %s arrives late", async lateResult => {
    await render();
    await prepareBuy();
    let finishOriginal!: (value: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise<Response>(resolve => { finishOriginal = resolve; }));
    await click("Confirm order");
    const original = JSON.parse(fetchMock.mock.calls[0][1].body);

    // Client navigation replaces the component while its first fetch is pending.
    await act(async () => root.unmount());
    root = createRoot(container);
    await render();
    fetchMock.mockResolvedValueOnce(response({ order: { id: original.operationKey, quantity: "3", remaining: "0", status: "filled" } }));
    await click("Retry same request");
    expect(fetchMock.mock.calls[1][1].body).toBe(fetchMock.mock.calls[0][1].body);
    expect(sessionStorage.getItem(key)).toBeNull();

    await prepareBuy();
    let rejectNew!: (error: Error) => void;
    fetchMock.mockImplementationOnce(() => new Promise<Response>((_resolve, reject) => { rejectNew = reject; }));
    await click("Confirm order");
    const newerPayload = fetchMock.mock.calls[2][1].body;
    const newer = JSON.parse(newerPayload);
    expect(newer.operationKey).not.toBe(original.operationKey);
    const savedNewer = sessionStorage.getItem(key);
    expect(JSON.parse(savedNewer!).body).toEqual(newer);

    // Either terminal response for the old operation must leave the new one intact.
    await act(async () => {
      finishOriginal(lateResult === "success"
        ? response({ order: { id: original.operationKey, quantity: "3", remaining: "0", status: "filled" } })
        : response({ error: "insufficient_credits" }, 409));
    });
    const pendingAfterLateResponse = sessionStorage.getItem(key);
    await act(async () => { rejectNew(new TypeError("Response lost after commit")); });
    expect(pendingAfterLateResponse).toBe(savedNewer);
    expect(sessionStorage.getItem(key)).toBe(savedNewer);
    expect(button("Review order").matches(":disabled")).toBe(true);
    expect(button("Retry same request").disabled).toBe(false);

    fetchMock.mockResolvedValueOnce(response({ order: { id: newer.operationKey, quantity: "3", remaining: "0", status: "filled" } }));
    await click("Retry same request");
    expect(fetchMock.mock.calls[3][1].body).toBe(newerPayload);
    expect(sessionStorage.getItem(key)).toBeNull();
    expect(button("Review order").matches(":disabled")).toBe(false);
  });
  it("retains an unconfirmed operation when the request times out", async () => {
    vi.useFakeTimers();
    try {
      await render();
      await prepareBuy();
      fetchMock.mockImplementationOnce((_url, options) => new Promise((_resolve, reject) => {
        options.signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
      }));
      await click("Confirm order");
      expect(container.textContent).toContain("Submitting request");
      await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
      expect(container.textContent).toContain("result is unconfirmed");
      expect(sessionStorage.getItem(key)).not.toBeNull();
      expect(button("Review order").matches(":disabled")).toBe(true);
      expect(button("Retry same request").disabled).toBe(false);
    } finally { vi.useRealTimers(); }
  });
  it("keeps the reference on auth/server/malformed responses and clears only a definite rejection", async () => {
    await render();
    await prepareBuy();
    fetchMock.mockResolvedValueOnce(response({ error: "unauthenticated" }, 401));
    await click("Confirm order");
    const saved = sessionStorage.getItem(key);
    expect(saved).not.toBeNull();
    fetchMock.mockResolvedValueOnce(response({ error: "unavailable" }, 503));
    await click("Retry same request");
    expect(sessionStorage.getItem(key)).toBe(saved);
    fetchMock.mockResolvedValueOnce(response({ unexpected: true }));
    await click("Retry same request");
    expect(sessionStorage.getItem(key)).toBe(saved);
    fetchMock.mockResolvedValueOnce(response({ error: "insufficient_credits" }, 409));
    await click("Retry same request");
    expect(sessionStorage.getItem(key)).toBeNull();
    expect(container.textContent).toContain("not have enough available credits");
  });
  it("does not submit if request storage fails, and isolates another owner's pending request", async () => {
    sessionStorage.setItem(`jader:pending-trade:another-owner:${marketId}`, "unreadable");
    await render();
    await prepareBuy();
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("Storage blocked"); });
    await click("Confirm order");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Browser session storage must be available");
    setItem.mockRestore();
  });
  it("preserves the exact pending request when an acknowledgement changes its quantity", async () => {
    await render();
    await prepareBuy();
    fetchMock.mockImplementationOnce(async (_url, options) => {
      const body = JSON.parse(options.body);
      return response({ order: { id: body.operationKey, quantity: "4", remaining: "0", status: "filled" } });
    });
    await click("Confirm order");
    const original = fetchMock.mock.calls[0][1].body;
    expect(JSON.parse(sessionStorage.getItem(key)!).body).toEqual(JSON.parse(original));
    expect(container.textContent).toContain("result is unconfirmed");
    expect(refresh).not.toHaveBeenCalled();
    fetchMock.mockImplementationOnce(async (_url, options) => {
      expect(options.body).toBe(original);
      const body = JSON.parse(options.body);
      return response({ order: { id: body.operationKey, quantity: "3", remaining: "0", status: "filled" } });
    });
    await click("Retry same request");
    expect(sessionStorage.getItem(key)).toBeNull();
    expect(container.textContent).toContain("Order filled: 3 of 3 shares");
  });
  it("blocks a corrupt saved request instead of silently allowing a new trade", async () => {
    sessionStorage.setItem(key, "broken-json");
    await render();
    expect(button("Review order").matches(":disabled")).toBe(true);
    expect(container.textContent).toContain("New actions are blocked to avoid repeating a trade");
  });
  it("mints and burns complete sets through the authenticated APIs", async () => {
    snapshot.holdings = [{ outcome: "YES", available: "5", reserved: "0" }, { outcome: "NO", available: "5", reserved: "0" }];
    await render();
    for (const action of ["mint", "burn"]) {
      await field("action", action);
      await field("quantity", "2");
      await click(`Review ${action}`);
      expect(container.textContent).toContain("2.00 credits");
      fetchMock.mockImplementationOnce(async (url, options) => {
        expect(url).toBe(`/api/trading/${action}`);
        const body = JSON.parse(options.body);
        return response({ operationKey: body.operationKey, action, quantity: body.quantity });
      });
      await click(`Confirm ${action}`);
      expect(container.textContent).toContain(`${action === "mint" ? "Minted" : "Burned"} 2 complete sets`);
    }
  });
  it("reviews and cancels remaining shares even while paused", async () => {
    const order: Snapshot["openOrders"][number] = { id: "33333333-3333-4333-8333-333333333333", outcome: "YES", side: "sell", quantity: "3", remaining: "1", price: "2500", timeInForce: "GTC", expiresAt: null, status: "open", reason: null, sequence: "1" };
    await render({ status: "paused", openOrders: [order] });
    expect(container.querySelector('[aria-label="Trading ticket"]')).toBeNull();
    await click("Cancel remaining 1 shares");
    expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockImplementationOnce(async (url, options) => {
      expect(url).toBe("/api/trading/cancel");
      expect(JSON.parse(options.body).orderId).toBe(order.id);
      return response({ order: { ...order, status: "cancelled" } });
    });
    await click("Confirm cancellation");
    expect(container.textContent).toContain("unfilled 1 shares are no longer reserved");
  });
  it("handles insufficient shares, closed/deadline states and synthetic legacy redemption", async () => {
    await render();
    await field("side", "sell");
    await prepareBuy();
    expect(container.textContent).toContain("not have enough available shares");
    expect(fetchMock).not.toHaveBeenCalled();
    await render({ status: "closed" });
    expect(container.querySelector('[aria-label="Trading ticket"]')).toBeNull();
    await render({ status: "open" }, false, "2000-01-01T00:00:00Z");
    expect(container.textContent).toContain("This market is closed");
    // A fresh component clears the elapsed-deadline state for a different fixture.
    await act(async () => root.unmount());
    root = createRoot(container);
    snapshot.holdings = [{ outcome: "YES", available: "2", reserved: "0" }, { outcome: "NO", available: "1", reserved: "0" }];
    await render({}, true);
    expect(container.textContent).toContain("Browsing example only");
    expect(container.querySelector<HTMLOptionElement>('option[value="place"]')?.disabled).toBe(true);
    expect(container.querySelector<HTMLOptionElement>('option[value="mint"]')?.disabled).toBe(true);
    expect(button("Review burn").matches(":disabled")).toBe(false);
  });
});
