import Link from "next/link";
import type { currentMember } from "../auth/web";
import { MemberForm } from "./member-form";

export function AdminAccess({ member, code }: { member: Awaited<ReturnType<typeof currentMember>>; code?: string }) {
  if (member && code === "reauth_required") return <><h1>Confirm administrator access</h1><section className="panel account-signin"><p className="muted">Confirm your password and a fresh authenticator code to continue managing markets.</p><MemberForm endpoint="/api/account/reauthenticate" csrf={member.csrf} submitLabel="Confirm access" successText="Administrator access refreshed."><label>Password<input name="password" type="password" autoComplete="current-password" required maxLength={128} /></label><label>Fresh authenticator code<input name="code" inputMode="numeric" pattern="[0-9]{6}" autoComplete="one-time-code" maxLength={6} required /></label></MemberForm></section></>;
  return <div className="empty"><h1>{code === "mfa_required" ? "Set up your authenticator" : code && !["unauthenticated", "forbidden"].includes(code) ? "Administration temporarily unavailable" : "Administrator access required"}</h1><p>Market administration requires an administrator account and recent authentication.</p><Link className="button" href="/account">Open account</Link></div>;
}
