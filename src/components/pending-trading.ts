import type { TradingRequest } from "../domain/trading-ticket";
import { maxQuantity } from "../domain/trading-values";

const serverState = { ready: false, request: null, error: false } as const;
type State = { ready: boolean; request: TradingRequest | null; error: boolean };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function restore(raw: string, marketId: string): TradingRequest {
  const value = JSON.parse(raw) as TradingRequest;
  if (!value || !["mint", "burn", "place", "cancel"].includes(value.action) || !value.body || value.body.marketId !== marketId || !uuid.test(value.body.operationKey)) throw new Error("Invalid stored request");
  // Reject corrupt records rather than forgetting an operation that may have committed.
  if (value.action === "cancel") {
    if (!uuid.test(value.body.orderId)) throw new Error("Invalid stored order");
  } else {
    if (typeof value.body.quantity !== "string" || !/^[1-9][0-9]{0,6}$/.test(value.body.quantity) || BigInt(value.body.quantity) > maxQuantity) throw new Error("Invalid stored quantity");
    if (value.action === "place") {
      if (typeof value.body.price !== "string" || !/^[1-9][0-9]{0,3}$/.test(value.body.price) || !["YES", "NO"].includes(value.body.outcome) || !["buy", "sell"].includes(value.body.side) || !["GTC", "GTD", "IOC"].includes(value.body.timeInForce)) throw new Error("Invalid stored order");
      if (value.body.timeInForce === "GTD") {
        const expiry = value.body.expiresAt;
        if (typeof expiry !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(expiry) || new Date(expiry).toISOString().replace(".000Z", "Z") !== expiry) throw new Error("Invalid stored expiry");
      } else if (value.body.expiresAt !== undefined) throw new Error("Invalid stored expiry");
    }
  }
  return value;
}

// useSyncExternalStore keeps server rendering stable and restores a pending
// request before enabling new actions, including after a reload or sign-in.
export function pendingTradingStore(ownerId: string, marketId: string) {
  const key = `jader:pending-trade:${ownerId}:${marketId}`;
  const listeners = new Set<() => void>();
  let previous: string | null | undefined;
  let cached: State = serverState;
  function getSnapshot(): State {
    try {
      const raw = window.sessionStorage.getItem(key);
      if (raw !== previous || !cached.ready || cached.error) {
        cached = { ready: true, request: raw ? restore(raw, marketId) : null, error: false };
        previous = raw;
      }
    } catch {
      if (!cached.error) cached = { ready: true, request: null, error: true };
    }
    return cached;
  }
  function notify() { for (const listener of listeners) listener(); window.dispatchEvent(new Event("jader:pending-trade")); }
  return {
    getSnapshot,
    getServerSnapshot: () => serverState,
    subscribe(listener: () => void) {
      listeners.add(listener);
      window.addEventListener("storage", listener);
      window.addEventListener("jader:pending-trade", listener);
      return () => { listeners.delete(listener); window.removeEventListener("storage", listener); window.removeEventListener("jader:pending-trade", listener); };
    },
    clear(request: TradingRequest) {
      // A late replay response must never erase a newer pending request.
      const raw = window.sessionStorage.getItem(key);
      if (raw !== null && raw !== JSON.stringify(request)) { notify(); return false; }
      window.sessionStorage.removeItem(key);
      notify();
      return true;
    },
    save(request: TradingRequest) {
      window.sessionStorage.setItem(key, JSON.stringify(request));
      notify();
    },
  };
}

// A portfolio refresh can remove the last open order in a market while its
// cancellation response is still uncertain. Discover saved requests independently.
export function pendingTradingMarkets(ownerId: string) {
  const prefix = `jader:pending-trade:${ownerId}:`;
  return {
    getSnapshot() {
      try {
        const markets: string[] = [];
        for (let i = 0; i < window.sessionStorage.length; i++) {
          const key = window.sessionStorage.key(i);
          if (key?.startsWith(prefix) && uuid.test(key.slice(prefix.length))) markets.push(key.slice(prefix.length));
        }
        return JSON.stringify(markets.sort());
      } catch { return "unavailable"; }
    },
    getServerSnapshot: () => "[]",
    subscribe(listener: () => void) {
      window.addEventListener("storage", listener); window.addEventListener("jader:pending-trade", listener);
      return () => { window.removeEventListener("storage", listener); window.removeEventListener("jader:pending-trade", listener); };
    },
  };
}
