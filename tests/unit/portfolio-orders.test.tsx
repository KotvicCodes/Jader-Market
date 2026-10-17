// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PortfolioOrders } from "../../src/components/portfolio-orders";
import type { portfolioSnapshot } from "../../src/db/portfolio";
const { refresh } = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));
const ownerId = "11111111-1111-4111-8111-111111111111";
const marketId = "22222222-2222-4222-8222-222222222222";
const orderId = "33333333-3333-4333-8333-333333333333";
const storageKey = `jader:pending-trade:${ownerId}:${marketId}`;
type Orders = Awaited<ReturnType<typeof portfolioSnapshot>>["openOrders"];
let container: HTMLDivElement, root: Root;
let orders: Orders;
let fetchMock: ReturnType<typeof vi.fn>;
async function render() { await act(async () => root.render(<PortfolioOrders ownerId={ownerId} csrf="synthetic-csrf" orders={orders} />)); }
function button(text: string) {
  const node = Array.from(container.querySelectorAll("button")).find(b => b.textContent === text);
  if (!node) throw new Error(`Missing button: ${text}`);
  return node;
}
async function click(text: string) { await act(async () => button(text).click()); }
const response = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  sessionStorage.clear(); refresh.mockReset();
  fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  orders = [{ id: orderId, marketId, slug: "first-market", question: "Will the fictional first event occur?", marketStatus: "paused", outcome: "YES", side: "sell", quantity: "3", remaining: "1", price: "2500", status: "open", reason: null, timeInForce: "GTC", expiresAt: null, createdAt: "2035-01-01T00:00:00Z", sequence: "1" }];
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

describe("portfolio order management", () => {
  it("groups markets and reviews the correct order before cancelling the remainder", async () => {
    orders.push({ ...orders[0], id: "44444444-4444-4444-8444-444444444444", marketId: "55555555-5555-4555-8555-555555555555", slug: "second-market", question: "Will the fictional second event occur?", remaining: "2" });
    await render();
    expect(container.querySelector('a[href="/markets/first-market"]')).not.toBeNull();
    expect(container.querySelector('a[href="/markets/second-market"]')).not.toBeNull();
    await click("Cancel remaining 2 shares");
    expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockImplementationOnce(async (url, options) => {
      const body = JSON.parse(options.body);
      expect(url).toBe("/api/trading/cancel");
      expect(body).toMatchObject({ marketId: orders[1].marketId, orderId: orders[1].id });
      expect(options.headers["X-CSRF-Token"]).toBe("synthetic-csrf");
      return response({ order: { ...orders[1], status: "cancelled" } });
    });
    await click("Confirm cancellation");
    expect(container.textContent).toContain("unfilled 2 shares are no longer reserved");
    expect(refresh).toHaveBeenCalledOnce();
  });
  it("preserves a lost cancellation response across remount and handles a fill that won the race", async () => {
    await render(); await click("Cancel remaining 1 shares");
    fetchMock.mockRejectedValueOnce(new TypeError("Disconnected"));
    await click("Confirm cancellation");
    const original = fetchMock.mock.calls[0][1].body;
    await act(async () => root.unmount()); root = createRoot(container); await render();
    expect(button("Cancel remaining 1 shares").disabled).toBe(true);
    fetchMock.mockResolvedValueOnce(response({ order: { ...orders[0], status: "filled", remaining: "0" } }));
    await click("Retry same request");
    expect(fetchMock.mock.calls[1][1].body).toBe(original);
    expect(container.textContent).toContain("completed before cancellation");
    expect(sessionStorage.getItem(storageKey)).toBeNull();
  });
  it("recovers an existing market-page mint without overwriting it with a cancellation", async () => {
    const pending = { action: "mint", body: { marketId, operationKey: "66666666-6666-4666-8666-666666666666", quantity: "2" } };
    sessionStorage.setItem(storageKey, JSON.stringify(pending));
    await render();
    expect(button("Cancel remaining 1 shares").disabled).toBe(true);
    expect(container.textContent).toContain("Mint 2 complete sets");
    fetchMock.mockResolvedValueOnce(response({ ...pending.body, action: "mint" }));
    await click("Retry same request");
    expect(fetchMock.mock.calls[0][0]).toBe("/api/trading/mint");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual(pending.body);
    expect(sessionStorage.getItem(storageKey)).toBeNull();
  });
  it("does not erase a newer request when an earlier cancellation response arrives late", async () => {
    let resolve!: (value: Response) => void;
    fetchMock.mockReturnValueOnce(new Promise<Response>(done => { resolve = done; }));
    await render();
    await click("Cancel remaining 1 shares");
    await click("Confirm cancellation");
    const newer = { action: "mint", body: { marketId, operationKey: "77777777-7777-4777-8777-777777777777", quantity: "2" } };
    sessionStorage.setItem(storageKey, JSON.stringify(newer));
    await act(async () => { resolve(response({ order: { ...orders[0], status: "cancelled" } })); });
    expect(sessionStorage.getItem(storageKey)).toBe(JSON.stringify(newer));
    expect(button("Cancel remaining 1 shares").disabled).toBe(true);
    expect(container.textContent).toContain("Mint 2 complete sets");
    fetchMock.mockResolvedValueOnce(response({ ...newer.body, action: "mint" }));
    await click("Retry same request");
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual(newer.body);
    expect(sessionStorage.getItem(storageKey)).toBeNull();
  });
});
