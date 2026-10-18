"use client";

import Link from "next/link";
import { useMemo, useRef, useState, useSyncExternalStore, useTransition } from "react";
import { useRouter } from "next/navigation";
import { requestSummary, tradingRejections, tradingResult, type TradingRequest } from "../domain/trading-ticket";
import { pendingTradingStore } from "./pending-trading";

export function useTradingRequest(ownerId: string, marketId: string, csrf: string) {
  const router = useRouter();
  const store = useMemo(() => pendingTradingStore(ownerId, marketId), [ownerId, marketId]);
  const saved = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getServerSnapshot);
  const [review, setReview] = useState<TradingRequest | null>(null);
  const [busy, setBusy] = useState(false);
  const sending = useRef(false);
  const [refreshing, startRefresh] = useTransition();
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);

  function refresh() { startRefresh(() => router.refresh()); }
  async function send(request: TradingRequest) {
    if (sending.current) return;
    sending.current = true;
    setBusy(true);
    setMessage(null);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let persisted = false;
    try {
      // Persist before sending. A blocked storage write must not submit a trade.
      const earlier = store.getSnapshot();
      if (earlier.error || (earlier.request && JSON.stringify(earlier.request) !== JSON.stringify(request))) {
        setReview(null);
        setMessage({ text: "An earlier request needs confirmation. Keep its saved reference and recover that request before starting another action in this market.", error: true });
        return;
      }
      store.save(request);
      persisted = true;
      setReview(null);
      const controller = new AbortController();
      timer = setTimeout(() => controller.abort(), 20_000);
      const response = await fetch(`/api/trading/${request.action}`, {
        method: "POST", credentials: "same-origin", cache: "no-store", signal: controller.signal,
        headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf }, body: JSON.stringify(request.body),
      });
      const data: Record<string, unknown> = await response.json();
      if (!response.ok) {
        const code = typeof data.error === "string" ? data.error : "unavailable";
        if (response.status >= 400 && response.status < 500 && Object.hasOwn(tradingRejections, code)) {
          store.clear(request);
          setMessage({ text: tradingRejections[code], error: true });
          refresh();
          return;
        }
        const explanation = code === "unauthenticated" ? "Your session ended. Sign in, return here and retry this same request."
          : code === "invalid_csrf" ? "Refresh this page to renew your session details, then retry this same request."
          : code === "rate_limited" ? "Too many requests. Wait a minute, then retry this same request."
          : code === "operation_conflict" ? "This reference conflicts with a saved operation. Ask the operator to reconcile it before continuing."
          : "The server could not confirm the result. Retry this same request to recover its saved result.";
        setMessage({ text: explanation, error: true });
        return;
      }
      const text = tradingResult(request, data);
      store.clear(request);
      setMessage({ text, error: false });
      refresh();
    } catch {
      setMessage({ text: persisted ? "The result is unconfirmed. Keep its reference and retry the same request. New actions stay blocked until it is confirmed." : "The request was not sent. Browser session storage must be available to save its recovery reference. Enable it, then confirm again.", error: true });
    } finally {
      clearTimeout(timer);
      sending.current = false;
      setBusy(false);
    }
  }

  const locked = !saved.ready || saved.error || Boolean(saved.request) || busy || refreshing || Boolean(review);
  return { saved, review, setReview, busy, refreshing, message, setMessage, locked, send, refresh };
}

export type TradingController = ReturnType<typeof useTradingRequest>;

export function TradingRequestFeedback({ controller }: { controller: TradingController }) {
  const { saved, review, setReview, busy, refreshing, message, send } = controller;
  return <>
    {saved.error && <p role="alert" className="error">The browser could not read the saved request. New actions are blocked to avoid repeating a trade. Keep this browser&apos;s data and ask the operator to reconcile any unconfirmed request; do not clear storage to retry.</p>}
      {review && <section className="notice trading-review" aria-label="Review trading request" tabIndex={-1} ref={node => node?.focus()}>
        <h3>Review before confirming</h3>{requestSummary(review).map(line => <p key={line}>{line}</p>)}
        <div className="trading-actions"><button type="button" disabled={busy} onClick={() => void send(review)}>Confirm {review.action === "place" ? "order" : review.action === "cancel" ? "cancellation" : review.action}</button><button type="button" className="secondary-button" disabled={busy} onClick={() => setReview(null)}>Back to editing</button></div>
      </section>}
      {saved.request && <section className="notice" aria-label="Unconfirmed trading request"><h3>{busy ? "Submitting request…" : "Confirm an earlier request"}</h3>
        {requestSummary(saved.request).map(line => <p key={line}>{line}</p>)}<p>Request reference: <code className="request-reference">{saved.request.body.operationKey}</code></p>
        <p>Retrying uses the exact same details and reference. A completed operation will return its saved result without spending again.</p>
        <button type="button" disabled={busy || refreshing} onClick={() => void send(saved.request!)}>{busy ? "Waiting for confirmation…" : "Retry same request"}</button><p className="demo-hint"><Link href="/account">Sign in or check your account →</Link></p>
      </section>}
      {message && <p role={message.error ? "alert" : "status"} className={message.error ? "error" : "success"}>{message.text}</p>}
      <noscript><p className="notice">Enable JavaScript to review and submit trading requests.</p></noscript>
  </>;
}
