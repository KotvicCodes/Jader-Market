import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { digest, MemberError } from "../domain/identity";
import { parseWithdrawal, withdrawalTransition, type WithdrawalAction, type WithdrawalStatus } from "../domain/withdrawals";
import { memberDatabase, readSession, requireAdministrator, requireMember } from "./members";
import { recordCreditChange } from "./events";
import { journals, ledgerAccounts, ledgerEntries, users, withdrawalOperations, withdrawals } from "./schema";

export async function mutateWithdrawal(token: string, action: WithdrawalAction, input: Record<string, unknown>) {
  const parsed = parseWithdrawal(action, input);
  return memberDatabase().db.transaction(async tx => {
    // Shares the financial lock with trading, adjustments and account controls.
    const member = await readSession(token, tx, true);
    requireMember(member);
    const administrator = member.user.role === "admin";
    if (action !== "request" && (administrator || action !== "cancel")) requireAdministrator(member);
    const requestHash = digest(JSON.stringify([member.user.id, parsed], (_, value) => typeof value === "bigint" ? value.toString() : value));
    const [prior] = await tx.select().from(withdrawalOperations).where(eq(withdrawalOperations.id, parsed.operationKey));
    if (prior) {
      if (prior.actorId !== member.user.id || prior.requestHash !== requestHash) throw new MemberError("operation_conflict", 409);
      return prior.response;
    }
    let withdrawal: typeof withdrawals.$inferSelect;
    let fromStatus: WithdrawalStatus | null = null;
    if (action === "request") {
      const [{ total }] = await tx.select({ total: sql<number>`count(*)::integer` }).from(withdrawals).where(and(eq(withdrawals.ownerId, member.user.id), inArray(withdrawals.status, ["requested", "processing"])));
      if (total >= 20) throw new MemberError("withdrawal_limit", 409);
      await tx.insert(ledgerAccounts).values({ kind: "withdrawal_reserved", ownerId: member.user.id }).onConflictDoNothing();
      [withdrawal] = await tx.insert(withdrawals).values({ id: parsed.id, ownerId: member.user.id, amount: parsed.amount!, status: "requested", lastOperationId: parsed.operationKey }).returning();
    } else {
      [withdrawal] = await tx.select().from(withdrawals).where(eq(withdrawals.id, parsed.id)).for("update");
      if (!withdrawal || (!administrator && withdrawal.ownerId !== member.user.id)) throw new MemberError("withdrawal_missing", 404);
      if (withdrawal.lastOperationId !== parsed.previousOperationId) throw new MemberError("withdrawal_stale", 409);
      fromStatus = withdrawal.status;
      const status = withdrawalTransition(withdrawal.status, action, administrator, withdrawal.ownerId === member.user.id, parsed.verifiedNotSent);
      if (action === "pay" && (await tx.select({ id: withdrawalOperations.id }).from(withdrawalOperations).where(and(eq(withdrawalOperations.action, "pay"), eq(withdrawalOperations.reference, parsed.reference))).limit(1)).length) throw new MemberError("withdrawal_reference_used", 409);
      [withdrawal] = await tx.update(withdrawals).set({ status, lastOperationId: parsed.operationKey }).where(eq(withdrawals.id, withdrawal.id)).returning();
    }
    const response = { id: withdrawal.id, status: withdrawal.status, amount: withdrawal.amount.toString(), lastOperationId: parsed.operationKey };
    await tx.insert(withdrawalOperations).values({ id: parsed.operationKey, withdrawalId: withdrawal.id, actorId: member.user.id, action, fromStatus, toStatus: withdrawal.status, requestHash, reference: parsed.reference, note: parsed.note, response });
    if (action !== "start") {
      const accounts = await tx.select().from(ledgerAccounts).where(sql`${ledgerAccounts.kind} = 'issuance' OR (${ledgerAccounts.ownerId} = ${withdrawal.ownerId} AND ${ledgerAccounts.kind} IN ('wallet', 'withdrawal_reserved'))`).for("update");
      const wallet = accounts.find(account => account.kind === "wallet");
      const reserved = accounts.find(account => account.kind === "withdrawal_reserved");
      const issuance = accounts.find(account => account.kind === "issuance");
      if (!wallet || !reserved || !issuance) throw new MemberError("configuration", 503);
      const src = action === "request" ? wallet : reserved;
      const dst = action === "pay" ? issuance : action === "request" ? reserved : wallet;
      if (src.balance < withdrawal.amount) throw new MemberError("insufficient_credits", 409);
      const [journal] = await tx.insert(journals).values({ operationKey: parsed.operationKey, withdrawalOperationId: parsed.operationKey, requestHash, actorId: member.user.id, recipientId: withdrawal.ownerId, kind: action === "request" ? "reserve" : action === "pay" ? "debit" : "release", reason: "withdrawal", amount: withdrawal.amount }).returning({ id: journals.id });
      await tx.insert(ledgerEntries).values([{ journalId: journal.id, accountId: src.id, delta: -withdrawal.amount }, { journalId: journal.id, accountId: dst.id, delta: withdrawal.amount }]);
      await recordCreditChange(tx, journal.id, withdrawal.ownerId);
    }
    return response;
  });
}

export async function withdrawalSnapshot(token: string, page = 1, administrator = false, active = false) {
  return memberDatabase().db.transaction(async tx => {
    const member = await readSession(token, tx);
    requireMember(member);
    if (administrator) requireAdministrator(member);
    const rows = await tx.select({ id: withdrawals.id, amount: withdrawals.amount, status: withdrawals.status, lastOperationId: withdrawals.lastOperationId, createdAt: withdrawals.createdAt, handle: users.handle })
      .from(withdrawals).innerJoin(users, eq(users.id, withdrawals.ownerId))
      .where(and(administrator ? undefined : eq(withdrawals.ownerId, member.user.id), active ? inArray(withdrawals.status, ["requested", "processing"]) : undefined))
      .orderBy(desc(withdrawals.createdAt), desc(withdrawals.id)).limit(21).offset((page - 1) * 20);
    const items = rows.slice(0, 20);
    const history = items.length ? await tx.select({ withdrawalId: withdrawalOperations.withdrawalId, action: withdrawalOperations.action, reference: withdrawalOperations.reference, note: withdrawalOperations.note, createdAt: withdrawalOperations.createdAt })
      .from(withdrawalOperations).where(inArray(withdrawalOperations.withdrawalId, items.map(item => item.id))).orderBy(desc(withdrawalOperations.sequence)) : [];
    return { items: items.map(item => ({ ...item, history: history.filter(event => event.withdrawalId === item.id) })), hasNext: rows.length > 20 };
  }, { isolationLevel: "repeatable read", accessMode: "read only" });
}
