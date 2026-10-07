"use client";

import { useState, type FormEvent, type ReactNode } from "react";
import { useRouter } from "next/navigation";

const errors: Record<string, string> = {
  invalid_credentials: "Sign-in details could not be verified. Check your password and, if enabled, a fresh authenticator code.",
  invalid_handle: "Use 3 to 32 characters, starting with a letter. Letters, numbers, underscores, and hyphens are allowed.",
  invalid_password: "Use a password between 12 and 128 characters.",
  handle_unavailable: "That handle is unavailable. Choose another.",
  invalid_amount: "Enter a positive credit amount, up to 1,000,000, with at most four decimal places.",
  insufficient_credits: "This account does not have enough available credits for that debit.",
  account_unavailable: "This account is unavailable. Refresh the account list.",
  operation_conflict: "This adjustment reference was already used. Check balance history before starting a new adjustment.",
  reauth_required: "Confirm your password and authenticator code again before using administrator controls.",
  mfa_required: "Set up your authenticator on the Account page first.",
  invalid_mfa: "The authenticator code could not be verified. Use a fresh six-digit code.",
  rate_limited: "Too many attempts. Wait before trying again.",
  unauthenticated: "Your session ended. Sign in again.",
  forbidden: "Administrator access is required.",
  invalid_csrf: "Refresh the page and try again.",
  invalid_origin: "The operator needs to match APP_ORIGIN to this site's address.",
  configuration: "The account service needs operator setup. Check database migrations and administrator initialization.",
};

export function MemberForm({ endpoint, csrf = "", children, submitLabel, successText = "Saved.", destination, operationKey, refresh = true, onSuccess }: {
  endpoint: string; csrf?: string; children?: ReactNode; submitLabel: string; successText?: string; destination?: string; operationKey?: string; refresh?: boolean; onSuccess?: (data: Record<string, unknown>) => void;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<{ text: string; error: boolean }>();
  const [key, setKey] = useState(operationKey);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const form = event.currentTarget;
    const values: Record<string, unknown> = Object.fromEntries(new FormData(form));
    if ("confirmed" in values) values.confirmed = values.confirmed === "on";
    if (key) values.operationKey = key;
    setPending(true);
    setMessage(undefined);
    try {
      const response = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf }, credentials: "same-origin", cache: "no-store", body: JSON.stringify(values) });
      const data: Record<string, unknown> = await response.json();
      if (!response.ok) {
        setMessage({ text: typeof data.error === "string" && errors[data.error] ? errors[data.error] : "The request could not be completed. Check the current balance and try again.", error: true });
        return;
      }
      form.reset();
      if (key) setKey(crypto.randomUUID());
      setMessage({ text: successText, error: false });
      onSuccess?.(data);
      if (destination) router.replace(destination);
      if (refresh) router.refresh();
    } catch {
      setMessage({ text: "The service is unavailable. Check your balance before retrying the same adjustment.", error: true });
    } finally { setPending(false); }
  }

  return <form className="member-form" onSubmit={submit}>
    <fieldset disabled={pending}>{children}<button type="submit">{pending ? "Saving…" : submitLabel}</button>{operationKey && <button type="reset" className="secondary-button" onClick={() => setKey(crypto.randomUUID())}>Start a new adjustment</button>}</fieldset>
    {message && <p role={message.error ? "alert" : "status"} className={message.error ? "error" : "success"}>{message.text}</p>}
  </form>;
}

export function MfaSetup({ csrf }: { csrf: string }) {
  const [secret, setSecret] = useState<string>();
  const [copied, setCopied] = useState(false);
  return <section className="panel"><h2>Set up your authenticator</h2><p className="muted">Administrator controls require a six-digit code from an authenticator app. Keep access to that app private.</p>
    {!secret ? <MemberForm endpoint="/api/account/mfa-start" csrf={csrf} submitLabel="Create setup key" successText="Setup key created." refresh={false} onSuccess={data => { if (typeof data.secret === "string") setSecret(data.secret); }}><label>Current password<input name="password" type="password" autoComplete="current-password" required maxLength={128} /></label></MemberForm> : <>
      <p>Add an account manually in your authenticator: name <strong>Jader-Market</strong>, time-based code, six digits, 30 seconds.</p><label>Private setup key<code className="mfa-key">{secret}</code></label>
      <button type="button" className="secondary-button" onClick={async () => { try { await navigator.clipboard.writeText(secret); setCopied(true); } catch { setCopied(false); } }}>{copied ? "Copied" : "Copy setup key"}</button>
      <MemberForm endpoint="/api/account/mfa-confirm" csrf={csrf} submitLabel="Enable authenticator" successText="Authenticator enabled. Administrator controls are ready."><label>Authenticator code<input name="code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" minLength={6} maxLength={6} required /></label></MemberForm>
    </>}
  </section>;
}
