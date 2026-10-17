// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MarketLive } from "../../src/components/market-live";
import { PortfolioLive } from "../../src/components/portfolio-live";
import { SnapshotStatus, useLiveSnapshot, snapshotTimeout } from "../../src/components/live-snapshot";
import type { MarketSnapshot } from "../../src/db/market-snapshot";
import type { PortfolioSnapshot } from "../../src/components/snapshot-data";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
const marketId = "11111111-1111-4111-8111-111111111111";
const ownerId = "22222222-2222-4222-8222-222222222222";
const orderId = "33333333-3333-4333-8333-333333333333";
const storageKey = `jader:pending-trade:${ownerId}:${marketId}`;
const details = { id: marketId, question: "Will the fictional refresh rehearsal pass?", description: "Synthetic only", category: "community", closesAt: "2035-12-31T12:00:00.000Z", synthetic: "no", resolutionRules: "Check fictional record", resolutionSource: "Synthetic record" };
const at = "2026-10-17T14:00:00.000Z";
const response = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
let market: MarketSnapshot, portfolio: PortfolioSnapshot;
let root: Root, container: HTMLDivElement;
let fetchMock: ReturnType<typeof vi.fn>;
let online: boolean, visible: string;
async function mount(node: React.ReactNode) { await act(async () => root.render(node)); }
async function advance(ms: number) { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); }
async function event(name: string, target: Window | Document = window) { await act(async () => target.dispatchEvent(new Event(name))); }
function button(text: string) { const node = [...container.querySelectorAll("button")].find(b => b.textContent === text); if (!node) throw new Error(`Missing button ${text}`); return node; }
async function click(text: string) { await act(async () => button(text).click()); }
async function field(name: string, value: string) {
  const node = container.querySelector<HTMLInputElement | HTMLSelectElement>(`[name="${name}"]`)!;
  await act(async () => { node.value = value; node.dispatchEvent(new Event(node instanceof HTMLSelectElement ? "change" : "input", { bubbles: true })); });
}
const mountMarket = () => mount(<MarketLive market={details} initial={market} ownerId={ownerId} loadedAt={at} />);
const mountPortfolio = () => mount(<PortfolioLive initial={portfolio} query={{ ordersBefore: "20", fillsBefore: "10" }} />);
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date(at));
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  online = true; visible = "visible";
  vi.spyOn(navigator, "onLine", "get").mockImplementation(() => online);
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visible as DocumentVisibilityState);
  sessionStorage.clear();
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  market = { loadedAt: at, trading: { status: "open", executable: true, book: [], trades: [], nextCursor: null }, resolution: null,
    account: { ownerId, csrf: "synthetic-csrf", portfolio: { status: "open", availableCredits: "1000000", reservedCredits: "0", holdings: [], openOrders: [], orders: [], fills: [], nextCursor: null, nextFillCursor: null } } };
  portfolio = { loadedAt: at, csrf: "synthetic-csrf", member: { id: ownerId, handle: "synthetic_participant" }, availableCredits: "1000000", orderReservedCredits: "0", withdrawalReservedCredits: "0", reservedCredits: "0", holdings: { items: [], nextCursor: null }, openOrders: [], orders: { items: [], nextCursor: null }, fills: { items: [], nextCursor: null }, activity: { items: [], nextCursor: null }, payouts: { items: [], nextCursor: null } };
  fetchMock = vi.fn().mockImplementation(async url => response(String(url).includes("/api/account/") ? portfolio : market));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("authoritative automatic snapshots", () => {
  it("polls book, holdings, fills and status while preserving an unfinished ticket", async () => {
    await mountMarket();
    await field("price", "0.25"); await field("quantity", "3");
    market = structuredClone(market);
    market.trading.book = [{ outcome: "YES", side: "sell", price: "2500", quantity: "4" }];
    market.account!.portfolio.holdings = [{ outcome: "YES", available: "2", reserved: "0" }];
    market.account!.portfolio.fills = [{ sequence: "1", orderId, outcome: "YES", side: "buy", price: "2500", quantity: "2", createdAt: at }];
    await advance(10_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][1]).toMatchObject({ cache: "no-store", credentials: "same-origin" });
    expect(container.textContent).toContain("Latest 1 fills");
    expect(container.querySelector<HTMLInputElement>('[name="quantity"]')!.value).toBe("3");
    expect(container.querySelector<HTMLInputElement>('[name="price"]')!.value).toBe("0.25");
    expect(container.querySelectorAll("table")[0].textContent).toContain("Ask0.254");
    market = structuredClone(market); market.trading.status = "paused"; market.account!.portfolio.status = "paused";
    await advance(10_000);
    expect(container.textContent).toContain("administrator has paused");
    expect(container.querySelector('[aria-label="Trading ticket"]')).toBeNull();
  });

  it("invalidates a review when balances or eligibility change and handles the local deadline", async () => {
    await mountMarket(); await field("price", "0.25"); await field("quantity", "3"); await click("Review order");
    const link = container.querySelector<HTMLAnchorElement>('a[href="/portfolio"]')!;
    link.focus(); await advance(10_000);
    expect(document.activeElement).toBe(link);
    market = structuredClone(market); market.account!.portfolio.availableCredits = "900000";
    await advance(10_000);
    expect(container.textContent).toContain("Review the current details again");
    expect([...container.querySelectorAll("button")].some(b => b.textContent === "Confirm order")).toBe(false);
    market = structuredClone(market); market.account!.portfolio.availableCredits = "1000000";
    await advance(10_000);
    expect([...container.querySelectorAll("button")].some(b => b.textContent === "Confirm order")).toBe(false);
    await click("Review order");
    market = structuredClone(market); market.trading.book = [{ side: "sell", outcome: "YES", price: "2500", quantity: "1" }];
    await advance(10_000);
    expect([...container.querySelectorAll("button")].some(b => b.textContent === "Confirm order")).toBe(false);
    await act(async () => root.render(<MarketLive key="deadline" market={{ ...details, closesAt: new Date(Date.now() + 1000).toISOString() }} initial={market} ownerId={ownerId} loadedAt={at} />));
    await field("price", "0.25"); await field("quantity", "3"); await click("Review order");
    await advance(1000);
    expect(container.textContent).toContain("This market is closed");
    expect([...container.querySelectorAll("button")].some(b => b.textContent === "Confirm order")).toBe(false);
  });

  it("keeps an uncertain request offline and reconnects with GETs until an explicit exact retry", async () => {
    await mountMarket(); await field("action", "mint"); await field("quantity", "2"); await click("Review mint");
    fetchMock.mockRejectedValueOnce(new TypeError("Disconnected")); await click("Confirm mint");
    const original = fetchMock.mock.calls[1][1].body;
    online = false; await event("offline"); await advance(120_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain("You are offline");
    expect(button("Retry same request").disabled).toBe(true);
    expect(sessionStorage.getItem(storageKey)).not.toBeNull();
    online = true; await event("online"); await advance(0);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[2][1].method).toBeUndefined();
    expect(button("Retry same request").disabled).toBe(false);
    fetchMock.mockImplementationOnce(async (_url, options) => response({ ...JSON.parse(options.body), action: "mint" }));
    await click("Retry same request");
    expect(fetchMock.mock.calls[3][1].body).toBe(original);
    expect(sessionStorage.getItem(storageKey)).toBeNull();
  });

  it("pauses hidden tabs, discards late responses and checks on visibility and focus", async () => {
    await mountMarket();
    const late = deferred<Response>(); fetchMock.mockReturnValueOnce(late.promise);
    await advance(10_000);
    const signal = fetchMock.mock.calls[1][1].signal as AbortSignal;
    visible = "hidden"; await event("visibilitychange", document);
    expect(signal.aborted).toBe(true);
    await advance(120_000); expect(fetchMock).toHaveBeenCalledTimes(2);
    const changed = structuredClone(market); changed.account!.portfolio.availableCredits = "10000";
    await act(async () => late.resolve(response(changed)));
    expect(container.textContent).not.toContain("Available credits1.00");
    visible = "visible"; await event("visibilitychange", document); await advance(0);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    await advance(1000); await event("focus"); await advance(0);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("backs off failures to a 60-second cap, keeps old data and bounds hung requests", async () => {
    const load = vi.fn().mockRejectedValue(new Error("Unavailable"));
    function Harness() { const live = useLiveSnapshot("old", at, load); return <><span>{live.data}</span><SnapshotStatus live={live} label="test" /></>; }
    await mount(<Harness />);
    expect(container.textContent).toContain("Displayed data may be out of date");
    for (const delay of [20_000, 40_000, 60_000, 60_000]) { const calls = load.mock.calls.length; await advance(delay - 1); expect(load).toHaveBeenCalledTimes(calls); await advance(1); expect(load).toHaveBeenCalledTimes(calls + 1); }
    load.mockImplementationOnce(() => new Promise(() => {}));
    await click("Refresh test");
    expect(button("Refreshing…").disabled).toBe(true);
    await advance(snapshotTimeout);
    expect(container.textContent).toContain("Updates could not be confirmed");
    expect(container.textContent).toContain("old");
  });

  it("requires a new check on focus even when an older poll is still in flight", async () => {
    await mountMarket(); await field("price", "0.25"); await field("quantity", "3"); await click("Review order");
    const oldPoll = deferred<Response>(); fetchMock.mockReturnValueOnce(oldPoll.promise);
    await advance(10_000);
    const oldSignal = fetchMock.mock.calls[1][1].signal as AbortSignal;
    const freshPoll = deferred<Response>(); fetchMock.mockReturnValueOnce(freshPoll.promise);
    await event("focus");
    expect(button("Confirm order").disabled).toBe(true);
    expect(oldSignal.aborted).toBe(true);
    await act(async () => oldPoll.resolve(response(market)));
    await advance(999);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await advance(1);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(button("Confirm order").disabled).toBe(true);
    const changed = structuredClone(market); changed.account!.portfolio.availableCredits = "900000";
    await act(async () => freshPoll.resolve(response(changed)));
    expect(container.textContent).toContain("Review the current details again");
    expect([...container.querySelectorAll("button")].some(b => b.textContent === "Confirm order")).toBe(false);
    expect(container.textContent).toContain("Available credits90.00");
  });

  it("hides private data on session loss or account change without deleting a saved operation", async () => {
    sessionStorage.setItem(storageKey, JSON.stringify({ action: "mint", body: { marketId, operationKey: orderId, quantity: "2" } }));
    await mountMarket();
    market = structuredClone(market); market.account!.ownerId = "44444444-4444-4444-8444-444444444444"; market.account!.portfolio.availableCredits = "999999999";
    await advance(10_000);
    expect(container.textContent).toContain("Private data is hidden");
    expect(container.querySelector('[aria-label="Trading ticket"]')).toBeNull();
    expect(container.textContent).not.toContain("99999.9999");
    expect(sessionStorage.getItem(storageKey)).not.toBeNull();
    const calls = fetchMock.mock.calls.length; await advance(120_000); expect(fetchMock).toHaveBeenCalledTimes(calls);
    online = false; await event("offline"); visible = "hidden"; await event("visibilitychange", document);
    expect(container.textContent).toContain("Private data is hidden");
    online = true; visible = "visible"; await event("online"); await event("focus"); await advance(1000);
    expect(fetchMock).toHaveBeenCalledTimes(calls);
    expect(container.textContent).toContain("Private data is hidden");
    await act(async () => root.unmount()); root = createRoot(container);
    fetchMock.mockResolvedValueOnce(response({ error: "unauthenticated" }, 401));
    await mountPortfolio();
    expect(container.textContent).toContain("Private data is hidden");
    expect(container.textContent).not.toContain("synthetic_participant");
    expect(sessionStorage.getItem(storageKey)).not.toBeNull();
  });

  it("rejects malformed successful snapshots and never treats them as fresh", async () => {
    await mountMarket(); fetchMock.mockResolvedValueOnce(response({ unexpected: true }));
    await advance(10_000);
    expect(container.textContent).toContain("Updates could not be confirmed");
    expect(container.querySelector("fieldset")!.disabled).toBe(true);
    expect(container.textContent).toContain("Available credits100.00");
    fetchMock.mockResolvedValueOnce(response({ ...market, account: { ...market.account, portfolio: { ...market.account!.portfolio, availableCredits: "broken" } } }));
    await click("Refresh market");
    expect(container.textContent).toContain("Updates could not be confirmed");
  });

  it("queues a fresh read after a mutation instead of accepting a poll started before it", async () => {
    await mountMarket();
    const oldPoll = deferred<Response>(); fetchMock.mockReturnValueOnce(oldPoll.promise); await advance(10_000);
    await field("action", "mint"); await field("quantity", "2"); await click("Review mint");
    fetchMock.mockImplementationOnce(async (_url, options) => response({ ...JSON.parse(options.body), action: "mint" }));
    await click("Confirm mint");
    expect(container.textContent).toContain("Checking current state");
    market = structuredClone(market); market.account!.portfolio.availableCredits = "980000";
    await act(async () => oldPoll.resolve(response({ ...market, account: { ...market.account!, portfolio: { ...market.account!.portfolio, availableCredits: "1000000" } } })));
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(container.textContent).toContain("Available credits98.00");
    expect(container.textContent).toContain("Automatic updates are on");
  });

  it("preserves portfolio cursors while holdings and payout receipts update", async () => {
    await mountPortfolio();
    portfolio = structuredClone(portfolio); portfolio.availableCredits = "1010000";
    portfolio.payouts.items = [{ id: orderId, sequence: "1", quantity: "1", amount: "10000", createdAt: at, outcome: "YES", result: "YES", slug: "fictional", question: details.question }];
    await advance(10_000);
    expect(fetchMock.mock.calls[1][0]).toBe("/api/account/portfolio?ordersBefore=20&fillsBefore=10");
    expect(container.textContent).toContain("101.00");
    expect(container.querySelector("#payouts")!.textContent).toContain(orderId);
    expect(container.querySelector('a[href="/portfolio?fillsBefore=10#orders"]')).not.toBeNull();
  });

  it("recovers a cancellation after all open orders disappear and after remount", async () => {
    const pending = { action: "cancel", body: { marketId, operationKey: orderId, orderId } };
    sessionStorage.setItem(storageKey, JSON.stringify(pending));
    await mountPortfolio();
    expect(container.textContent).toContain("Saved request");
    expect(button("Retry same request").disabled).toBe(false);
    await advance(10_000);
    expect(sessionStorage.getItem(storageKey)).toBe(JSON.stringify(pending));
    await act(async () => root.unmount()); root = createRoot(container); await mountPortfolio();
    fetchMock.mockResolvedValueOnce(response({ order: { id: orderId, status: "filled", quantity: "1", remaining: "0" } }));
    await click("Retry same request");
    const posted = fetchMock.mock.calls.find(call => call[1].method === "POST")!;
    expect(posted[0]).toBe("/api/trading/cancel"); expect(JSON.parse(posted[1].body)).toEqual(pending.body);
    expect(sessionStorage.getItem(storageKey)).toBeNull();
  });

  it("aborts reads and removes polling/listeners when the page unmounts", async () => {
    const load = vi.fn().mockImplementation(() => new Promise(() => {}));
    function Harness() { const live = useLiveSnapshot("old", at, load); return <SnapshotStatus live={live} label="test" />; }
    await mount(<Harness />);
    const signal = load.mock.calls[0][0] as AbortSignal;
    await mount(null);
    expect(signal.aborted).toBe(true);
    await event("focus"); await event("online"); await advance(120_000);
    expect(load).toHaveBeenCalledOnce();
  });

  it("rechecks a restored history page even when an older read was in flight", async () => {
    await mountMarket();
    const late = deferred<Response>(); fetchMock.mockReturnValueOnce(late.promise); await advance(10_000);
    const oldSignal = fetchMock.mock.calls[1][1].signal as AbortSignal;
    await act(async () => window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })));
    expect(oldSignal.aborted).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const obsolete = structuredClone(market); obsolete.account!.portfolio.availableCredits = "1";
    await act(async () => late.resolve(response(obsolete)));
    expect(container.textContent).toContain("Available credits100.00");
  });
});
