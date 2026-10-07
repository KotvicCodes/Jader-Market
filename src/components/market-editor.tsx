"use client";

import { useRouter } from "next/navigation";
import { MemberForm } from "./member-form";

export type EditableMarket = { id: string; revision: number; question: string; description: string; category: string; resolutionRules: string; resolutionSource: string; closesAt: string };

export function MarketEditor({ csrf, operationKey, market }: { csrf: string; operationKey: string; market?: EditableMarket }) {
  const router = useRouter();
  return <MemberForm endpoint={`/api/admin/markets/${market ? "edit" : "create"}`} csrf={csrf} operationKey={operationKey} newOperationLabel={false} resetOnSuccess={false} submitLabel={market ? "Save draft" : "Create draft"} successText="Draft saved. Review the terms before publishing." transformValues={values => {
    const value = String(values.closesAt);
    return { ...values, closesAt: `${value.length === 16 ? `${value}:00` : value}Z` };
  }} onSuccess={data => { if (!market && typeof data.id === "string") router.replace(`/admin/markets/${data.id}`); }}>
    {market && <><input type="hidden" name="id" value={market.id} /><input type="hidden" name="revision" value={market.revision} /></>}
    <label>YES/NO question<input name="question" defaultValue={market?.question} placeholder="Will at least half of the freshman class advance to their second year in 2027?" minLength={10} maxLength={240} required /></label>
    <label>Description<textarea name="description" defaultValue={market?.description} rows={3} minLength={10} maxLength={600} required /></label>
    <div className="market-fields"><label>Category<select name="category" defaultValue={market?.category ?? "community"}><option value="community">Community</option><option value="technology">Technology</option><option value="science">Science</option></select></label><label>Closing time (UTC)<input name="closesAt" type="datetime-local" step="1" defaultValue={market?.closesAt.slice(0, 19)} required /><span>Use UTC, regardless of your device timezone.</span></label></div>
    <label>Resolution rules<textarea name="resolutionRules" defaultValue={market?.resolutionRules} placeholder="Define precisely when YES wins, when NO wins, and what happens if evidence is unavailable." rows={5} minLength={20} maxLength={1200} required /></label>
    <label>Resolution source<textarea name="resolutionSource" defaultValue={market?.resolutionSource} placeholder="Name the evidence the administrator will use." rows={2} minLength={5} maxLength={400} required /></label>
  </MemberForm>;
}
