"use client";

export default function ErrorPage({ reset }: { reset: () => void }) {
  return <div className="empty"><h2>This page is temporarily unavailable</h2><p>Try again. No changes have been confirmed by this page.</p><button onClick={reset}>Try again</button></div>;
}
