// Synthetic isolated restore rehearsal only; never an operator data repair tool.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { getDatabase } from '../src/db/client';
import { checkRecovery } from '../src/db/recovery';
import { reconcileDatabase } from '../src/db/reconciliation';
import { adjustCredits, readSession, signIn } from '../src/db/members';
import { mutateMarket } from '../src/db/market-admin';
import { mutateTrading } from '../src/db/trading';
import { mutateWithdrawal } from '../src/db/withdrawals';
import { settleMarkets } from '../src/db/settlement';
import { ledgerAccounts, markets, sessions, users } from '../src/db/schema';
import { digest, encryptSecret, hashPassword, randomToken, totp } from '../src/domain/identity';
import type { ExternalRegister } from '../src/domain/reconciliation';

const c = getDatabase();
if (!c || process.env.RECOVERY_SYNTHETIC_PROOF !== 'yes') throw new Error('isolated_proof_required');
const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
const proof = '/proof/fixture.json';
async function fingerprints() {
  const result: Record<string, string> = {};
  for (const table of ['users','ledger_accounts','journals','ledger_entries','holdings','orders','fills','market_resolutions','market_payouts','share_movements','withdrawals','withdrawal_operations','trading_operations']) {
    const [row] = await c!.db.execute(sql`SELECT md5(coalesce(string_agg(to_jsonb(t)::text, ',' ORDER BY to_jsonb(t)::text),'')) AS hash FROM ${sql.identifier(table)} t`);
    result[table] = row.hash as string;
  }
  return result;
}
try {
  if (process.argv[2] === 'setup') {
    const admin = randomToken(), alice = randomToken(), bob = randomToken();
    const ids = new Map<string, string>();
    await c.db.insert(ledgerAccounts).values({ kind: 'issuance' });
    for (const [handle, token] of [['recovery_admin',admin],['alice',alice],['bob',bob]]) {
      const [u] = await c.db.insert(users).values({ handle, role: token === admin ? 'admin' : 'participant',
        passwordHash: token === admin ? await hashPassword('synthetic-recovery-password') : 'synthetic-unused-hash', mfaSecret: token === admin ? encryptSecret(secret) : null }).returning();
      ids.set(token,u.id);
      await c.db.insert(ledgerAccounts).values([{ kind: 'wallet',ownerId: u.id },{ kind: 'reserved',ownerId: u.id }]);
      await c.db.insert(sessions).values({ userId:u.id,tokenHash:digest(token),csrfHash:digest(randomToken()),expiresAt:new Date(Date.now()+3600000),pendingMfa:token === alice ? encryptSecret(secret) : null });
    }
    const credit = await adjustCredits(admin,{ recipientId: ids.get(alice),amount:'100',kind:'credit',reason:'offline_credit',operationKey:randomUUID(),confirmed:true });
    await adjustCredits(admin,{ recipientId:ids.get(bob),amount:'100',kind:'credit',reason:'demo_grant',operationKey:randomUUID(),confirmed:true });
    const makeMarket = async () => (await c.db.insert(markets).values({ slug:randomUUID(),question:'Will this synthetic recovery rehearsal succeed?',description:'Synthetic proof only.',category:'community',resolutionRules:'YES on a verified test success, NO otherwise.',resolutionSource:'Synthetic fixture record',status:'open',publishedAt:new Date(),closesAt:new Date('2099-12-31') }).returning())[0].id;
    const active = await makeMarket(), settling = await makeMarket();
    const trade = (token: string, action: 'mint'|'place', id: string, extra = {}) => mutateTrading(token,action,{marketId:id,operationKey:randomUUID(),quantity:'5',price:'2500',side:'sell',outcome:'YES',timeInForce:'GTC',...extra});
    await trade(alice,'mint',active);
    await trade(alice,'place',active);
    await trade(bob,'place',active,{side:'buy',quantity:'2',timeInForce:'IOC'});
    await trade(bob,'place',active,{side:'buy',outcome:'NO',quantity:'2'});
    const request = () => mutateWithdrawal(alice,'request',{amount:'1',operationKey:randomUUID(),confirmed:true});
    const advance = (action:'start'|'pay', row:Record<string,unknown>, extra={}) => mutateWithdrawal(admin,action,{id:row.id,previousOperationId:row.lastOperationId,operationKey:randomUUID(),confirmed:true,...extra});
    await request(); await advance('start',await request());
    let paid = await advance('start',await request()); paid = await advance('pay',paid,{reference:'synthetic-paid-receipt'});
    // 22 holdings: first worker pass commits 20, leaving resumable progress in the snapshot.
    for (let i=0;i<11;i++) {
      const token=randomToken();
      const [u]=await c.db.insert(users).values({handle:`recovery_holder_${i}`,passwordHash:'synthetic-unused-hash'}).returning();
      await c.db.insert(ledgerAccounts).values([{kind:'wallet',ownerId:u.id},{kind:'reserved',ownerId:u.id}]);
      await c.db.insert(sessions).values({userId:u.id,tokenHash:digest(token),csrfHash:digest(randomToken()),expiresAt:new Date(Date.now()+3600000)});
      await adjustCredits(admin,{recipientId:u.id,amount:'1',kind:'credit',reason:'demo_grant',operationKey:randomUUID(),confirmed:true});
      await trade(token,'mint',settling,{quantity:'1'});
    }
    await mutateMarket(admin,'close',{id:settling,revision:0,operationKey:randomUUID(),confirmed:true});
    await mutateMarket(admin,'resolve',{id:settling,revision:1,operationKey:randomUUID(),confirmed:true,result:'invalid',evidence:'Synthetic verified event record for a recovery rehearsal.'});
    assert.equal(await settleMarkets(),20);
    const register: ExternalRegister={version:1,complete:true,reviewedAt:new Date().toISOString(),payments:[
      {direction:'incoming',reference:'synthetic-credit-receipt',amount:'1000000',journalId:credit},
      {direction:'outgoing',reference:'synthetic-paid-receipt',amount:'10000',withdrawalId:paid.id as string},
    ]};
    const report=await reconcileDatabase(c.db,register); assert.equal(report.status,'pass');
    assert.equal(report.summary.open_orders,'2'); assert.equal(report.summary.processing_withdrawals,'1');
    assert.equal(report.summary.requested_withdrawals,'1'); assert.equal(report.summary.payout_receipts,'20');
    assert.ok(await readSession(admin));
    await checkRecovery(c.db);
    writeFileSync(proof,JSON.stringify({admin,alice,bob,register,fingerprints:await fingerprints(),summary:report.summary,settling}),{mode:0o600});
  } else if (process.argv[2] === 'verify') {
    const saved=JSON.parse(readFileSync(proof,'utf8'));
    assert.deepEqual(await fingerprints(),saved.fingerprints,'Restored financial history must match the snapshot exactly');
    const report=await reconcileDatabase(c.db,saved.register); assert.equal(report.status,'pass');
    assert.deepEqual(report.summary,saved.summary);
    for (const token of [saved.admin,saved.alice,saved.bob]) assert.equal(await readSession(token),undefined,'Old sessions must stay revoked');
    const [count]=await c.db.execute(sql`SELECT count(*)::int AS total FROM sessions`); assert.equal(count.total,0);
    await checkRecovery(c.db);
    const code=totp(secret,Math.floor(Date.now()/30000));
    const login=await signIn('recovery_admin','synthetic-recovery-password',code);
    assert.equal((await readSession(login.token))?.user.mfaEnabled,true);
    await assert.rejects(signIn('recovery_admin','synthetic-recovery-password',code));
    assert.equal((await Promise.all([settleMarkets(),settleMarkets()])).reduce((a,b)=>a+b,0),2);
    assert.equal(await settleMarkets(),0); assert.equal(await settleMarkets(),0);
    const final=await reconcileDatabase(c.db,saved.register); assert.equal(final.status,'pass');
    assert.equal(final.summary.payout_receipts,'22'); assert.equal(final.summary.settling_markets,'0');
    assert.equal(final.summary.open_orders,'2');
    const [escrow]=await c.db.execute(sql`SELECT balance::text FROM ledger_accounts WHERE market_id=${saved.settling}::uuid AND kind='escrow'`);
    assert.equal(escrow.balance,'0');
  } else throw new Error('arguments');
  console.info('Synthetic recovery fixture passed.');
} catch { console.error('Synthetic recovery fixture failed.'); process.exitCode=1; }
finally { await c.client.end(); }
