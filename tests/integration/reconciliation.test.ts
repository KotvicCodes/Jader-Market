import "dotenv/config";
import { randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql, type SQL } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { createDatabase, getDatabase } from "../../src/db/client";
import { reconcileDatabase } from "../../src/db/reconciliation";
import { adjustCredits } from "../../src/db/members";
import { mutateMarket } from "../../src/db/market-admin";
import { mutateTrading } from "../../src/db/trading";
import { mutateWithdrawal } from "../../src/db/withdrawals";
import { settleMarkets } from "../../src/db/settlement";
import { ledgerAccounts, markets, sessions, users } from "../../src/db/schema";
import { digest, encryptSecret, randomToken } from "../../src/domain/identity";
import type { ExternalRegister } from "../../src/domain/reconciliation";
import type { TradingAction } from "../../src/domain/trading";
import type { WithdrawalAction } from "../../src/domain/withdrawals";

const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith("_test")) throw new Error("A dedicated test database is required.");
const control = createDatabase(url);
const name = `jader_reconcile_${randomUUID().replaceAll("-", "").slice(0,16)}_test`;
const isolated = new URL(url); isolated.pathname = `/${name}`;
process.env.DATABASE_URL = isolated.toString();
process.env.AUTH_SECRET = randomBytes(32).toString("hex");
const connection = createDatabase(isolated.toString());
const admin = randomToken(), alice = randomToken(), bob = randomToken();
const ids = new Map<string,string>();
let created = false, marketId: string, depositId: string, paidId: string, processingId: string, legacyDebitId: string;
let buyId: string, sellId: string;
const register = (): ExternalRegister => ({ version: 1, complete: true, reviewedAt: new Date().toISOString(), payments: [
  { direction: "incoming", reference: "synthetic-bank-receipt-1", amount: "1000000", journalId: depositId },
  { direction: "outgoing", reference: "synthetic-bank-payment-1", amount: "10000", withdrawalId: paidId },
  { direction: "outgoing", reference: "synthetic-legacy-payment", amount: "10000", journalId: legacyDebitId },
] });
const trade = (token: string, action: TradingAction, id: string, fields = {}) => mutateTrading(token,action,{ marketId: id, operationKey: randomUUID(), quantity: "5", price: "2500", side: "sell", outcome: "YES", timeInForce: "GTC", ...fields });
const withdrawal = (token: string, action: WithdrawalAction, row: Record<string,unknown>, fields = {}) => mutateWithdrawal(token,action,{
  id: row.id, previousOperationId: row.lastOperationId, operationKey: randomUUID(), confirmed: true, ...fields,
});
async function market() {
  const [m] = await connection.db.insert(markets).values({ slug: randomUUID(), question: "Will the fictional reconciliation rehearsal pass?", description: "Synthetic accounting verification.", category: "community", resolutionRules: "Resolve YES if the synthetic record confirms success, otherwise NO.", resolutionSource: "Synthetic test record", status: "open", publishedAt: new Date(), closesAt: new Date("2035-12-31T12:00:00Z") }).returning();
  return m.id;
}
async function assertClean() {
  const report = await reconcileDatabase(connection.db,register());
  expect(report.checks.filter(c => c.discrepancies!=="0")).toEqual([]);
  expect(report.status).toBe("pass");
  return report;
}
// Only this disposable database is privileged. Inject faults behind the guards,
// then restore their original values; production reconciliation never does this.
async function corrupt(change: SQL, repair: SQL, expected: string[]) {
  const apply = (query: SQL) => connection.db.transaction(async tx => {
    await tx.execute(sql`SET LOCAL session_replication_role = replica`);
    await tx.execute(query);
  });
  try {
    await apply(change);
    const report = await reconcileDatabase(connection.db,register());
    expect(report.status).toBe("fail");
    const failed = report.checks.filter(c => c.discrepancies!=="0").map(c => c.name);
    for (const name of expected) expect(failed).toContain(name);
  } finally { await apply(repair); }
  await assertClean();
}
async function command(args: string[] = []) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve,reject) => {
    const child = spawn(process.execPath,["scripts/run.mjs","node","--import","./scripts/register-typescript.mjs","scripts/reconcile.ts",...args],{ env: process.env });
    let stdout = "", stderr = "";
    child.stdout.on("data",data => { stdout+=data; }); child.stderr.on("data",data => { stderr+=data; });
    child.on("error",reject); child.on("close",code => resolve({ code,stdout,stderr }));
  });
}

beforeAll(async () => {
  await control.client.unsafe(`CREATE DATABASE "${name}"`); created = true;
  await migrate(connection.db,{ migrationsFolder: "drizzle" });
  await connection.db.insert(ledgerAccounts).values({ kind: "issuance" });
  for (const [handle,token] of [["reconcile_admin",admin],["alice",alice],["bob",bob]]) {
    const [u] = await connection.db.insert(users).values({ handle,passwordHash: "private-synthetic-hash",role: token===admin ? "admin" : "participant",mfaSecret: token===admin ? encryptSecret("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ") : null }).returning();
    ids.set(token,u.id);
    await connection.db.insert(ledgerAccounts).values([{ kind: "wallet",ownerId: u.id },{ kind: "reserved",ownerId: u.id }]);
    await connection.db.insert(sessions).values({ userId: u.id,tokenHash: digest(token),csrfHash: digest(randomToken()),expiresAt: new Date(Date.now()+3600000) });
  }
  depositId = await adjustCredits(admin,{ recipientId: ids.get(alice),amount: "100",kind: "credit",reason: "offline_credit",operationKey: randomUUID(),confirmed: true });
  await adjustCredits(admin,{ recipientId: ids.get(bob),amount: "100",kind: "credit",reason: "demo_grant",operationKey: randomUUID(),confirmed: true });
  legacyDebitId = await adjustCredits(admin,{ recipientId: ids.get(alice),amount: "1",kind: "debit",reason: "correction",operationKey: randomUUID(),confirmed: true });
  // Simulate the preserved pre-0006 offline-debit row shape. Current application
  // APIs correctly reject creation of new direct offline debits.
  await connection.db.transaction(async tx => {
    await tx.execute(sql`SET LOCAL session_replication_role = replica`);
    await tx.execute(sql`UPDATE journals SET reason='offline_debit' WHERE id=${legacyDebitId}::uuid`);
  });
  marketId = await market();
  await trade(alice,"mint",marketId,{ quantity: "10" });
  await trade(alice,"burn",marketId,{ quantity: "1" });
  const ask = await trade(alice,"place",marketId,{ quantity: "5" }); sellId = (ask.order as { id: string }).id;
  await trade(bob,"place",marketId,{ side: "buy",price: "3000",quantity: "2",timeInForce: "IOC" });
  const bid = await trade(bob,"place",marketId,{ side: "buy",outcome: "NO",quantity: "3" }); buyId = (bid.order as { id: string }).id;
  const request = () => mutateWithdrawal(alice,"request",{ amount: "1",operationKey: randomUUID(),confirmed: true });
  let row = await request(); row = await withdrawal(admin,"start",row); row = await withdrawal(admin,"pay",row,{ reference: "synthetic-bank-payment-1" }); paidId = row.id as string;
  row = await request(); row = await withdrawal(admin,"start",row); processingId = row.id as string;
  await request();
  row = await request(); await withdrawal(alice,"cancel",row,{ note: "Synthetic cancellation before payment processing." });
  row = await request(); row = await withdrawal(admin,"start",row); await withdrawal(admin,"release",row,{ verifiedNotSent: true,note: "Synthetic verified-unpaid release after processing." });
});
afterAll(async () => {
  await connection.client.end(); await getDatabase()?.client.end();
  if (created) await control.client.unsafe(`DROP DATABASE "${name}" WITH (FORCE)`);
  await control.client.end();
});

describe("operator reconciliation",() => {
  it("reconciles trading, partial fills, all withdrawal states and independently verified external receipts",async () => {
    const report = await assertClean();
    expect(report.summary.processing_withdrawals).toBe("1");
    expect(report.summary.requested_withdrawals).toBe("1");
    expect(report.externalEvidence?.sha256).toMatch(/^[0-9a-f]{64}$/);
    const output = JSON.stringify(report);
    for (const secret of [admin,alice,bob,"private-synthetic-hash","synthetic-bank-payment-1","synthetic-bank-receipt-1","request_hash","mfa_secret"]) expect(output).not.toContain(secret);
    expect(await reconcileDatabase(connection.db)).toMatchObject({ status: "incomplete",internalStatus: "pass",externalStatus: "not_checked" });
  });

  it("reports missing, unmatched, wrong-amount, wrong-direction and wrong-reference external payments",async () => {
    const inputs = [
      { ...register(),payments: [] },
      { ...register(),payments: [...register().payments,{ direction: "outgoing" as const,amount: "10000",reference: "sent-but-unconfirmed",withdrawalId: processingId }] },
      { ...register(),payments: register().payments.map((p,i) => i===0 ? { ...p,amount: "999999" } : p) },
      { ...register(),payments: register().payments.map((p,i) => i===0 ? { ...p,direction: "outgoing" as const } : p) },
      { ...register(),payments: register().payments.map((p,i) => i===1 ? { ...p,reference: "different-confirmation" } : p) },
    ];
    for (const input of inputs) {
      const report = await reconcileDatabase(connection.db,input);
      expect(report).toMatchObject({ status: "fail",internalStatus: "pass",externalStatus: "fail" });
      expect(report.checks.at(-1)?.samples.length).toBeGreaterThan(0);
    }
  });

  it("detects ledger, journal, holding and collateral corruption",async () => {
    await corrupt(sql`UPDATE ledger_accounts SET balance=balance+1 WHERE kind='wallet' AND owner_id=${ids.get(alice)}::uuid`,sql`UPDATE ledger_accounts SET balance=balance-1 WHERE kind='wallet' AND owner_id=${ids.get(alice)}::uuid`,["ledger_projections"]);
    await corrupt(sql`UPDATE journals SET amount=amount+1 WHERE id=${depositId}::uuid`,sql`UPDATE journals SET amount=amount-1 WHERE id=${depositId}::uuid`,["journal_balance","journal_transfers"]);
    await corrupt(sql`UPDATE holdings SET available=available+1 WHERE market_id=${marketId}::uuid AND owner_id=${ids.get(alice)}::uuid AND outcome='YES'`,sql`UPDATE holdings SET available=available-1 WHERE market_id=${marketId}::uuid AND owner_id=${ids.get(alice)}::uuid AND outcome='YES'`,["holding_projections","collateral"]);
    await corrupt(sql`UPDATE ledger_accounts SET balance=balance+1 WHERE market_id=${marketId}::uuid AND kind='escrow'`,sql`UPDATE ledger_accounts SET balance=balance-1 WHERE market_id=${marketId}::uuid AND kind='escrow'`,["collateral"]);
  });

  it("detects buy, sell and withdrawal reservation mismatches and altered order history",async () => {
    await corrupt(sql`UPDATE orders SET remaining=remaining-1 WHERE id=${buyId}::uuid`,sql`UPDATE orders SET remaining=remaining+1 WHERE id=${buyId}::uuid`,["buy_reservations","order_fills"]);
    await corrupt(sql`UPDATE orders SET remaining=remaining-1 WHERE id=${sellId}::uuid`,sql`UPDATE orders SET remaining=remaining+1 WHERE id=${sellId}::uuid`,["sell_reservations","order_fills"]);
    await corrupt(sql`UPDATE withdrawals SET amount=amount+1 WHERE id=${processingId}::uuid`,sql`UPDATE withdrawals SET amount=amount-1 WHERE id=${processingId}::uuid`,["withdrawal_reservations","withdrawal_journals"]);
    await corrupt(sql`UPDATE withdrawal_operations SET from_status='requested' WHERE withdrawal_id=${paidId}::uuid AND action='pay'`,sql`UPDATE withdrawal_operations SET from_status='processing' WHERE withdrawal_id=${paidId}::uuid AND action='pay'`,["withdrawal_history"]);
    await corrupt(sql`UPDATE fills SET price=price+1 WHERE market_id=${marketId}::uuid`,sql`UPDATE fills SET price=price-1 WHERE market_id=${marketId}::uuid`,["fill_accounting"]);
  });

  it("detects missing reservation accounts even when other owner accounts exist",async () => {
    // There are no entries referencing the admin's empty reserved account.
    const [empty] = await connection.db.execute(sql`SELECT id::text FROM ledger_accounts WHERE kind='reserved' AND owner_id=${ids.get(admin)}::uuid`);
    await corrupt(sql`DELETE FROM ledger_accounts WHERE id=${empty.id}::uuid`,sql`INSERT INTO ledger_accounts(id,kind,owner_id,balance) VALUES (${empty.id}::uuid,'reserved',${ids.get(admin)}::uuid,0)`,["required_accounts"]);
    const [account] = await connection.db.execute(sql`SELECT to_jsonb(a)::text AS record FROM ledger_accounts a WHERE kind='reserved' AND owner_id=${ids.get(bob)}::uuid`);
    await corrupt(sql`DELETE FROM ledger_accounts WHERE kind='reserved' AND owner_id=${ids.get(bob)}::uuid`,
      sql`INSERT INTO ledger_accounts SELECT * FROM jsonb_populate_record(NULL::ledger_accounts,${account.record as string}::jsonb)`,["buy_reservations","accounting_links"]);
    const [holding] = await connection.db.execute(sql`SELECT to_jsonb(h)::text AS record FROM holdings h WHERE market_id=${marketId}::uuid AND owner_id=${ids.get(alice)}::uuid AND outcome='YES'`);
    await corrupt(sql`DELETE FROM holdings WHERE market_id=${marketId}::uuid AND owner_id=${ids.get(alice)}::uuid AND outcome='YES'`,
      sql`INSERT INTO holdings SELECT * FROM jsonb_populate_record(NULL::holdings,${holding.record as string}::jsonb)`,["sell_reservations","accounting_links"]);
  });

  it("reconciles YES, NO and invalid payouts, zero-value receipts, and interrupted settlement",async () => {
    for (const result of ["YES","NO","invalid"] as const) {
      const id = await market();
      await trade(alice,"mint",id,{ quantity: "2" });
      await mutateMarket(admin,"close",{ id,revision: 0,operationKey: randomUUID(),confirmed: true });
      await mutateMarket(admin,"resolve",{ id,revision: 1,operationKey: randomUUID(),confirmed: true,result,evidence: "Synthetic record confirms this fictional settlement result." });
      await assertClean(); await settleMarkets(); await assertClean();
    }
    for (let i=0;i<2;i++) await adjustCredits(admin,{ recipientId: ids.get(alice),amount: "1000000",kind: "credit",reason: "demo_grant",operationKey: randomUUID(),confirmed: true });
    const id = await market();
    await trade(alice,"mint",id,{ quantity: "1000000" }); await trade(alice,"mint",id,{ quantity: "1" });
    await mutateMarket(admin,"close",{ id,revision: 0,operationKey: randomUUID(),confirmed: true });
    await mutateMarket(admin,"resolve",{ id,revision: 1,operationKey: randomUUID(),confirmed: true,result: "YES",evidence: "Synthetic partial settlement interrupted after the first bounded batch." });
    await settleMarkets(); expect((await assertClean()).summary.settling_markets).toBe("1");
    await settleMarkets(); expect((await assertClean()).summary.settling_markets).toBe("0");
    const [receipt] = await connection.db.execute(sql`SELECT id::text FROM market_payouts WHERE amount>0 LIMIT 1`);
    await corrupt(sql`UPDATE market_payouts SET amount=amount+1 WHERE id=${receipt.id}::uuid`,sql`UPDATE market_payouts SET amount=amount-1 WHERE id=${receipt.id}::uuid`,["payout_receipts"]);
    const [zero] = await connection.db.execute(sql`SELECT to_jsonb(p)::text AS record,id::text FROM market_payouts p WHERE amount=0 LIMIT 1`);
    await corrupt(sql`DELETE FROM market_payouts WHERE id=${zero.id}::uuid`,
      sql`INSERT INTO market_payouts OVERRIDING SYSTEM VALUE SELECT * FROM jsonb_populate_record(NULL::market_payouts,${zero.record as string}::jsonb)`,["payout_coverage"]);
    await corrupt(sql`UPDATE markets SET status='closed' WHERE id=${id}::uuid`,sql`UPDATE markets SET status='resolved' WHERE id=${id}::uuid`,["settlement_lifecycle"]);
  });

  it("reads coherent snapshots while financial writes commit",async () => {
    const id = await market();
    const writes = Array.from({ length: 4 },() => trade(bob,"mint",id,{ quantity: "1" }));
    const reports = await Promise.all(Array.from({ length: 4 },() => reconcileDatabase(connection.db,register())));
    await Promise.all(writes);
    for (const report of reports) expect(report.checks.filter(c => c.discrepancies!=="0")).toEqual([]);
  });

  it("runs with SELECT-only database access and bounds samples without hiding discrepancy counts",async () => {
    const role = `reconcile_${randomUUID().replaceAll("-","")}`;
    await connection.client.unsafe(`CREATE ROLE "${role}"`);
    try {
      await connection.client.unsafe(`GRANT USAGE ON SCHEMA public,drizzle TO "${role}"`);
      await connection.client.unsafe(`GRANT SELECT ON ALL TABLES IN SCHEMA public,drizzle TO "${role}"`);
      const reader = createDatabase(isolated.toString());
      try {
        await expect(reader.db.transaction(async tx => {
          await tx.execute(sql.raw(`SET LOCAL ROLE "${role}"`));
          await tx.execute(sql`UPDATE ledger_accounts SET balance=balance`);
        })).rejects.toMatchObject({ cause: { code: "42501" } });
        // Use a fresh session whose startup role is the restricted role.
        const readUrl = new URL(isolated); readUrl.searchParams.set("options",`-c role=${role}`);
        const restricted = createDatabase(readUrl.toString());
        try { expect((await reconcileDatabase(restricted.db,register())).status).toBe("pass"); }
        finally { await restricted.client.end(); }
      } finally { await reader.client.end(); }
    } finally {
      await connection.client.unsafe(`DROP OWNED BY "${role}"`); await connection.client.unsafe(`DROP ROLE "${role}"`);
    }
    const [before] = await connection.db.execute(sql`SELECT count(*)::text AS count FROM users`);
    const added: string[] = [];
    try {
      for (let i=0;i<30;i++) {
        const [u] = await connection.db.insert(users).values({ handle: `missing_${randomUUID().replaceAll("-","").slice(0,15)}`,passwordHash: "unused" }).returning(); added.push(u.id);
      }
      const report = await reconcileDatabase(connection.db,register());
      expect(report.checks.find(c => c.name==='required_accounts')).toMatchObject({ discrepancies: "60",truncated: true });
      expect(report.checks.find(c => c.name==='required_accounts')?.samples).toHaveLength(25);
    } finally {
      for (const id of added) await connection.db.execute(sql`DELETE FROM users WHERE id=${id}::uuid`);
    }
    expect((await connection.db.execute(sql`SELECT count(*)::text AS count FROM users`))[0].count).toBe(before.count);
  });

  it("returns useful CLI exit codes and fails without exposing private errors",async () => {
    const directory = mkdtempSync(join(tmpdir(),"jader-reconcile-"));
    try {
      const path = join(directory,"receipts.json"); writeFileSync(path,JSON.stringify(register()),{ mode: 0o600 });
      const passed = await command(["--external-register",path]);
      expect(passed.code).toBe(0); expect(JSON.parse(passed.stdout).status).toBe("pass"); expect(passed.stderr).toBe("");
      const incomplete = await command(); expect(incomplete.code).toBe(2); expect(JSON.parse(incomplete.stdout).externalStatus).toBe("not_checked");
      writeFileSync(path,JSON.stringify({ ...register(),payments: [] }));
      const failed = await command(["--external-register",path]); expect(failed.code).toBe(1); expect(JSON.parse(failed.stdout).status).toBe("fail");
      writeFileSync(path,'private-invalid-register');
      const invalid = await command(["--external-register",path]); expect(invalid.code).toBe(3); expect(invalid.stdout).toBe(""); expect(invalid.stderr).not.toContain('private-invalid-register');
      expect(invalid.stderr).not.toContain(path);
      expect((await command(["--unknown"])).code).toBe(3);
    } finally { rmSync(directory,{ recursive: true,force: true }); }
  });

  it("refuses clearance when required database guards are disabled or evidence is dated in the future",async () => {
    await expect(reconcileDatabase(connection.db,{ ...register(),reviewedAt: "2099-01-01T00:00:00Z" })).rejects.toThrow("invalid_external_register");
    await connection.db.execute(sql`ALTER TABLE ledger_accounts DISABLE TRIGGER trading_account_projection`);
    try {
      await expect(reconcileDatabase(connection.db,register())).rejects.toThrow("database_not_ready");
      const unavailable = await command();
      expect(unavailable.code).toBe(3); expect(unavailable.stdout).toBe("");
      expect(unavailable.stderr.trim()).toMatch(/^Reconciliation unavailable:[^\n]*$/);
      expect(unavailable.stderr).not.toContain(isolated.toString());
    }
    finally { await connection.db.execute(sql`ALTER TABLE ledger_accounts ENABLE TRIGGER trading_account_projection`); }
    await assertClean();
  });
});
