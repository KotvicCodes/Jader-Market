"use client";

import Link from "next/link";
import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";

export const pollInterval = 10_000;
export const snapshotTimeout = 8_000;
export const staleAfter = 30_000;
type Phase = "current" | "checking" | "offline" | "hidden" | "error" | "session";
type RefreshControl = { fresh: boolean; refresh: () => void };
export const SnapshotRefreshContext = createContext<RefreshControl | null>(null);
export const useSnapshotRefresh = () => useContext(SnapshotRefreshContext);
export class SnapshotSessionError extends Error {}

export async function fetchSnapshot<T>(url: string, signal: AbortSignal, read: (value: unknown) => T): Promise<T> {
  const response = await fetch(url, { signal, credentials: "same-origin", cache: "no-store", headers: { Accept: "application/json" } });
  if (response.status === 401 || response.status === 403) throw new SnapshotSessionError();
  if (!response.ok) throw new Error("Snapshot unavailable");
  return read(await response.json());
}

export function useLiveSnapshot<T>(initial: T, loadedAt: string, load: (signal: AbortSignal) => Promise<T>) {
  const [state, setState] = useState({ data: initial, checkedAt: loadedAt, phase: "current" as Phase, fetching: false });
  const refreshRef = useRef<() => void>(() => {});
  const refresh = useCallback(() => refreshRef.current(), []);

  useEffect(() => {
    let disposed = false, failures = 0, rerun = false, sessionEnded = false;
    let active: AbortController | null = null;
    let next: ReturnType<typeof setTimeout> | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let stale: ReturnType<typeof setTimeout> | undefined;
    let lastStart = 0;
    const available = () => navigator.onLine && document.visibilityState !== "hidden";
    function mark(phase: Phase, fetching = false) { if (!disposed) setState(s => ({ ...s, phase, fetching })); }
    function cancel() { const pending = active; active = null; pending?.abort(); clearTimeout(timeout); clearTimeout(next); }
    function age() {
      clearTimeout(stale);
      stale = setTimeout(() => { if (!disposed) setState(s => s.phase === "current" ? { ...s, phase: "checking" } : s); }, staleAfter);
    }
    function schedule(delay: number) { clearTimeout(next); if (!disposed && available() && !sessionEnded) next = setTimeout(() => void run(false), delay); }
    async function run(required: boolean) {
      if (disposed || sessionEnded) return;
      if (!available()) { rerun = false; cancel(); mark(navigator.onLine ? "hidden" : "offline"); return; }
      if (active) { if (required) { rerun = true; mark("checking", true); } return; }
      clearTimeout(next);
      const controller = new AbortController();
      active = controller;
      lastStart = Date.now();
      if (required) mark("checking", true);
      else setState(s => ({ ...s, fetching: true }));
      try {
        const timedOut = new Promise<never>((_, reject) => {
          timeout = setTimeout(() => { controller.abort(); reject(new Error("Snapshot timed out")); }, snapshotTimeout);
        });
        const data = await Promise.race([load(controller.signal), timedOut]);
        if (disposed || active !== controller) return;
        failures = 0;
        if (!rerun) { setState({ data, checkedAt: new Date().toISOString(), phase: "current", fetching: false }); age(); }
      } catch (error) {
        if (disposed || active !== controller) return;
        failures++;
        if (error instanceof SnapshotSessionError) { sessionEnded = true; rerun = false; mark("session"); }
        else mark(navigator.onLine ? "error" : "offline");
      } finally {
        if (active === controller) {
          clearTimeout(timeout); active = null;
          if (rerun && !disposed) { rerun = false; void run(true); }
          else schedule(Math.min(60_000, pollInterval * 2 ** Math.min(failures, 3)));
        }
      }
    }
    function resume() {
      if (disposed || sessionEnded) return;
      if (!available()) { rerun = false; cancel(); mark(navigator.onLine ? "hidden" : "offline"); }
      else {
        // A read started before focus/reconnect cannot verify the resumed page.
        // Supersede it and coalesce resume events within the start interval.
        rerun = false;
        cancel();
        mark("checking");
        next = setTimeout(() => void run(true), Math.max(0, 1_000 - (Date.now() - lastStart)));
      }
    }
    function pageShow(event: PageTransitionEvent) {
      if (event.persisted && !sessionEnded && !disposed) { rerun = false; cancel(); void run(true); }
    }
    refreshRef.current = () => { if (!sessionEnded) void run(true); };
    // Verify the server-rendered snapshot immediately, including session ownership.
    void run(true);
    window.addEventListener("online", resume);
    window.addEventListener("offline", resume);
    window.addEventListener("focus", resume);
    window.addEventListener("pageshow", pageShow);
    document.addEventListener("visibilitychange", resume);
    return () => {
      disposed = true; cancel(); clearTimeout(stale); refreshRef.current = () => {};
      window.removeEventListener("online", resume); window.removeEventListener("offline", resume);
      window.removeEventListener("focus", resume); window.removeEventListener("pageshow", pageShow);
      document.removeEventListener("visibilitychange", resume);
    };
  }, [load]);
  return { ...state, fresh: state.phase === "current", refresh };
}

export function SnapshotStatus({ live, label }: { live: { checkedAt: string; phase: Phase; fetching: boolean; refresh: () => void }; label: string }) {
  const text: Record<Phase, string> = {
    current: "Automatic updates are on. Orders and quotes can change before confirmation.",
    checking: "Checking current state. Trading submissions wait for a fresh snapshot.",
    offline: "You are offline. Displayed data may be out of date. Reconnect to check current state; saved requests will not be submitted automatically.",
    hidden: "Automatic updates are paused while this tab is hidden. Current state will be checked when you return.",
    error: "Updates could not be confirmed. Displayed data may be out of date. Retrying with a bounded delay; trading submissions are paused.",
    session: "Your session ended or your account changed. Private data is hidden. Sign in, then reload this page to recover any saved request in this tab.",
  };
  return <section className="notice" aria-label="Live update status"><p role="status">{text[live.phase]}</p><p className="muted">Last successful snapshot: {live.checkedAt.slice(0, 19).replace("T", " ")} UTC. Active tabs check every 10 seconds.</p>
    <noscript><p>Enable JavaScript for automatic updates. Otherwise reload to see later activity.</p></noscript>
    {live.phase === "session" ? <><Link className="button" href="/account">Sign in or check account</Link> <button type="button" className="secondary-button" onClick={() => window.location.reload()}>Reload page</button></> : <button type="button" className="secondary-button" disabled={live.fetching} onClick={live.refresh}>{live.fetching ? "Refreshing…" : `Refresh ${label}`}</button>}
  </section>;
}
