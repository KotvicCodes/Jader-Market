import { randomUUID } from "node:crypto";
import { formatCredits } from "../domain/identity";
import type { withdrawalSnapshot } from "../db/withdrawals";
import { MemberForm } from "./member-form";

type Item = Awaited<ReturnType<typeof withdrawalSnapshot>>["items"][number];
const labels = { request: "Credits reserved", start: "Payment processing", pay: "Payment confirmed", cancel: "Request cancelled", release: "Verified unpaid; credits released" };

export function WithdrawalList({ items, csrf, administrator = false }: { items: Item[]; csrf: string; administrator?: boolean }) {
  if (!items.length) return <p className="muted">No withdrawals on this page.</p>;
  return <div className="stack">{items.map(item => {
    const fields = <><input type="hidden" name="id" value={item.id} /><input type="hidden" name="previousOperationId" value={item.lastOperationId} /></>;
    return <article className="panel" key={item.id}>
      <h2>{formatCredits(item.amount)} credits · {item.status}</h2>
      {administrator && <p>Account: <strong>{item.handle}</strong></p>}
      <p className="muted">Requested {item.createdAt.toISOString().slice(0, 19).replace("T", " ")} UTC</p>
      <p>Withdrawal reference: <code>{item.id}</code></p>
      {item.status === "requested" && <>
        {administrator && <MemberForm key={`${item.lastOperationId}:start`} endpoint="/api/withdrawals/start" csrf={csrf} operationKey={randomUUID()} newOperationLabel={false} submitLabel="Start payment processing" successText="Credits remain reserved. Verify the saved processing state before sending payment.">
          {fields}<label className="checkbox-label"><input type="checkbox" name="confirmed" required />I will verify that this request is processing before sending any payment.</label>
        </MemberForm>}
        <details><summary>Cancel before payment starts</summary><MemberForm key={`${item.lastOperationId}:cancel`} endpoint="/api/withdrawals/cancel" csrf={csrf} operationKey={randomUUID()} newOperationLabel={false} submitLabel="Cancel request and release credits" successText="Request cancelled. Reserved credits returned to the available balance.">
          {fields}<label>Reason<textarea name="note" minLength={20} maxLength={400} required rows={2} /></label><label className="checkbox-label"><input type="checkbox" name="confirmed" required />Cancel this request before payment processing starts.</label>
        </MemberForm></details>
      </>}
      {item.status === "processing" && <>
        <p className="notice">Credits stay reserved while payment is processing or uncertain. There is no automatic timeout or participant cancellation.</p>
        {administrator && <>
          <MemberForm key={`${item.lastOperationId}:pay`} endpoint="/api/withdrawals/pay" csrf={csrf} operationKey={randomUUID()} newOperationLabel={false} submitLabel="Confirm completed payment" successText="Payment recorded. The reserved credits have been removed exactly once.">
            {fields}<label>Unique payment reference<input name="reference" minLength={3} maxLength={120} required autoComplete="off" /><span>Use an opaque transfer reference. Do not enter bank details.</span></label><label className="checkbox-label"><input type="checkbox" name="confirmed" required />I independently verified that this payment completed for the correct account and amount.</label>
          </MemberForm>
          <details><summary>Release only after verifying no payment was sent</summary><MemberForm key={`${item.lastOperationId}:release`} endpoint="/api/withdrawals/release" csrf={csrf} operationKey={randomUUID()} newOperationLabel={false} submitLabel="Confirm unpaid and release credits" successText="Verified unpaid. Request cancelled and credits released.">
            {fields}<label>Verification note<textarea name="note" minLength={20} maxLength={400} required rows={3} /><span>Explain how you confirmed no payment was sent. Keep bank details out of this note.</span></label><label className="checkbox-label"><input type="checkbox" name="verifiedNotSent" required />I verified that no payment was sent and no transfer remains pending.</label><label className="checkbox-label"><input type="checkbox" name="confirmed" required />Release the reserved credits and permanently cancel this request.</label>
          </MemberForm></details>
        </>}
      </>}
      <details><summary>Private withdrawal history</summary><ul>{item.history.map(event => <li key={event.action}>{labels[event.action]} · {event.createdAt.toISOString().slice(0, 19).replace("T", " ")} UTC{event.reference && <p>Payment reference: <code>{event.reference}</code></p>}{event.note && <p className="market-text">{event.note}</p>}</li>)}</ul></details>
    </article>;
  })}</div>;
}
