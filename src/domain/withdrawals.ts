import { MemberError, parseCredits } from "./identity";
import { marketUuid } from "./market-admin";

export const withdrawalActions = ["request", "start", "pay", "cancel", "release"] as const;
export type WithdrawalAction = typeof withdrawalActions[number];
export type WithdrawalStatus = "requested" | "processing" | "paid" | "cancelled";

function privateText(value: unknown, minimum: number, maximum: number) {
  if (typeof value !== "string") throw new MemberError("invalid_withdrawal_details");
  const text = value.trim();
  if (text.length < minimum || text.length > maximum || /[\u0000-\u001f\u007f]/.test(text)) throw new MemberError("invalid_withdrawal_details");
  return text;
}

export function parseWithdrawal(action: WithdrawalAction, input: Record<string, unknown>) {
  if (input.confirmed !== true) throw new MemberError("invalid_request");
  const operationKey = marketUuid(input.operationKey);
  return {
    action, operationKey,
    id: action === "request" ? operationKey : marketUuid(input.id),
    previousOperationId: action === "request" ? null : marketUuid(input.previousOperationId),
    amount: action === "request" ? parseCredits(input.amount) : null,
    reference: action === "pay" ? privateText(input.reference, 3, 120) : "",
    note: action === "release" || action === "cancel" ? privateText(input.note, 20, 400) : "",
    verifiedNotSent: action === "release" && input.verifiedNotSent === true,
  };
}

export function withdrawalTransition(status: WithdrawalStatus, action: WithdrawalAction, administrator: boolean, owner: boolean, verifiedNotSent: boolean): WithdrawalStatus {
  if (action === "cancel") {
    if (!administrator && !owner) throw new MemberError("forbidden", 403);
    if (status === "requested") return "cancelled";
    throw new MemberError("withdrawal_transition", 409);
  }
  if (!administrator) throw new MemberError("forbidden", 403);
  if (action === "start" && status === "requested") return "processing";
  if (action === "pay" && status === "processing") return "paid";
  if (action === "release" && status === "processing" && verifiedNotSent) return "cancelled";
  throw new MemberError("withdrawal_transition", 409);
}
