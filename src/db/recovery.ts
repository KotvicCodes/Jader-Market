import { sql } from 'drizzle-orm';
import { decryptSecret } from '../domain/identity';
import { reconcileDatabase } from './reconciliation';
import type { Database } from './transaction-lock';

/** Read-only validation on a stopped, isolated restore, before session revocation. */
export async function checkRecovery(db: Database) {
  const report = await reconcileDatabase(db);
  if (report.internalStatus !== 'pass') throw new Error('recovery_accounting_failed');
  await db.transaction(async tx => {
    await tx.execute(sql`SET LOCAL statement_timeout = '30s'`);
    // Bounded pages avoid collecting private authentication records in memory.
    let after = '';
    for (;;) {
      const rows = await tx.execute<{ id: string; secret: string }>(sql`
        SELECT id::text, mfa_secret AS secret FROM users
        WHERE mfa_secret IS NOT NULL AND id::text > ${after} ORDER BY id::text LIMIT 100`);
      for (const row of rows) {
        if (!/^[A-Z2-7]{32}$/.test(decryptSecret(row.secret))) throw new Error('recovery_key_failed');
        after = row.id;
      }
      if (rows.length < 100) break;
    }
    after = '';
    for (;;) {
      const rows = await tx.execute<{ id: string; secret: string }>(sql`
        SELECT token_hash AS id, pending_mfa AS secret FROM sessions
        WHERE pending_mfa IS NOT NULL AND token_hash > ${after} ORDER BY token_hash LIMIT 100`);
      for (const row of rows) {
        if (!/^[A-Z2-7]{32}$/.test(decryptSecret(row.secret))) throw new Error('recovery_key_failed');
        after = row.id;
      }
      if (rows.length < 100) break;
    }
  }, { isolationLevel: 'repeatable read', accessMode: 'read only' });
  return { internalStatus: 'pass', authenticationKeys: 'pass', externalPayments: 'not_checked' } as const;
}
