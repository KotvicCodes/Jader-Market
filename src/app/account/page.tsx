import Link from "next/link";
import { currentMember } from "../../auth/web";
import { MemberForm, MfaSetup } from "../../components/member-form";

export const dynamic = "force-dynamic";

export default async function AccountPage() {
  let member;
  try { member = await currentMember(); } catch { return <div className="empty"><h1>Account service unavailable</h1><p>The operator needs to check database readiness and migrations.</p></div>; }
  if (!member) return <>
    <p className="eyebrow">Closed community</p><h1>Sign in</h1><p className="muted">Use the handle and password your administrator provided. No email or payment information is needed.</p>
    <section className="panel account-signin"><MemberForm endpoint="/api/auth/sign-in" submitLabel="Sign in" destination="/account" successText="Signed in."><label>Handle<input name="handle" autoComplete="username" autoCapitalize="none" spellCheck={false} required minLength={3} maxLength={32} /></label><label>Password<input name="password" type="password" autoComplete="current-password" required maxLength={128} /></label><label>Authenticator code, if enabled<input name="code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} /></label></MemberForm></section>
    <p className="muted demo-hint">Need an account or a password reset? Contact your community administrator. The first administrator is created locally with <code>npm run admin:create</code>.</p>
  </>;
  return <>
    <div className="page-heading"><div><p className="eyebrow">Your account</p><h1>{member.user.handle}</h1><p className="muted">{member.user.role === "admin" ? "Administrator" : "Participant"} · Private local account</p></div><Link className="button" href="/portfolio">View balance</Link></div>
    {member.user.role === "admin" && !member.user.mfaEnabled && <div className="notice">Enable your authenticator below before creating accounts or issuing credits.</div>}
    <div className="detail-grid"><div className="stack">
      {member.user.role === "admin" && !member.user.mfaEnabled && <MfaSetup csrf={member.csrf} />}
      {member.user.role === "admin" && member.user.mfaEnabled && <section className="panel"><h2>Administrator access</h2><p>Your authenticator is enabled. Confirm your credentials when administrator access needs to be refreshed.</p><MemberForm endpoint="/api/account/reauthenticate" csrf={member.csrf} submitLabel="Confirm administrator access" successText="Administrator access refreshed for 10 minutes."><label>Current password<input name="password" type="password" autoComplete="current-password" required maxLength={128} /></label><label>Fresh authenticator code<input name="code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} required /></label></MemberForm><Link className="demo-link" href="/admin">Open administration →</Link></section>}
      <section className="panel"><h2>Change password</h2><p className="muted">Changing your password signs out all your sessions. Sign in again with the new password.</p><MemberForm endpoint="/api/account/password" csrf={member.csrf} submitLabel="Change password and sign out" destination="/account" successText="Password changed. Sign in again."><label>Current password<input name="currentPassword" type="password" autoComplete="current-password" required maxLength={128} /></label><label>New password<input name="password" type="password" autoComplete="new-password" required minLength={12} maxLength={128} /></label>{member.user.mfaEnabled && <label>Fresh authenticator code<input name="code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} required /></label>}</MemberForm></section>
    </div><aside className="panel demo-ticket"><h2>Sessions</h2><p className="muted">Sessions expire after 24 hours. Sign out on shared devices.</p><MemberForm endpoint="/api/auth/sign-out" csrf={member.csrf} submitLabel="Sign out" destination="/account" successText="Signed out." /><MemberForm endpoint="/api/account/sign-out-all" csrf={member.csrf} submitLabel="Sign out all sessions" destination="/account" successText="All sessions signed out." /></aside></div>
  </>;
}
