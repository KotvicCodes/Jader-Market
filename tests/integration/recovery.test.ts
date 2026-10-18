import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { createDatabase } from '../../src/db/client';
import { checkRecovery } from '../../src/db/recovery';
import { ledgerAccounts, sessions, users } from '../../src/db/schema';
import { digest, encryptSecret } from '../../src/domain/identity';

const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith('_test')) throw new Error('A dedicated test database is required.');
const control = createDatabase(url);
const name = `jader_recovery_${randomUUID().replaceAll('-', '').slice(0, 16)}_test`;
const isolated = new URL(url); isolated.pathname = `/${name}`;
const connection = createDatabase(isolated.toString());
const key = randomBytes(32).toString('hex');
const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
process.env.AUTH_SECRET = key;
let created = false;

beforeAll(async () => {
  await control.client.unsafe(`CREATE DATABASE "${name}"`); created = true;
  await migrate(connection.db, { migrationsFolder: 'drizzle' });
  await connection.db.insert(ledgerAccounts).values({ kind: 'issuance' });
  // Cross both 100-row authentication page boundaries with real ciphertext.
  const members = await connection.db.insert(users).values(Array.from({ length: 101 }, (_, i) => ({
    handle: `recovery_${i}`, passwordHash: 'synthetic-unused-hash', mfaSecret: encryptSecret(secret),
  }))).returning();
  await connection.db.insert(ledgerAccounts).values(members.flatMap(member => [
    { kind: 'wallet' as const, ownerId: member.id }, { kind: 'reserved' as const, ownerId: member.id },
  ]));
  await connection.db.insert(sessions).values(members.map(member => ({
    userId: member.id, tokenHash: digest(member.id), csrfHash: digest(`csrf:${member.id}`),
    expiresAt: new Date(Date.now() + 3600000), pendingMfa: encryptSecret(secret),
  })));
});
afterAll(async () => {
  await connection.client.end();
  if (created) await control.client.unsafe(`DROP DATABASE "${name}" WITH (FORCE)`);
  await control.client.end();
});

it('checks every MFA page without deleting sessions or claiming external payment clearance', async () => {
  expect(await checkRecovery(connection.db)).toEqual({ internalStatus: 'pass', authenticationKeys: 'pass', externalPayments: 'not_checked' });
  const [row] = await connection.db.execute(sql`SELECT count(*)::int AS count FROM sessions`);
  expect(row.count).toBe(101);
});

it('rejects an authentication key that cannot decrypt the restored state', async () => {
  process.env.AUTH_SECRET = randomBytes(32).toString('hex');
  try { await expect(checkRecovery(connection.db)).rejects.toThrow(); }
  finally { process.env.AUTH_SECRET = key; }
});

it('rejects an undecryptable enrolled key beyond the first page', async () => {
  const [last] = await connection.db.execute(sql`SELECT id::text, mfa_secret FROM users ORDER BY id::text DESC LIMIT 1`);
  await connection.db.execute(sql`UPDATE users SET mfa_secret='damaged' WHERE id=${last.id as string}::uuid`);
  try { await expect(checkRecovery(connection.db)).rejects.toThrow(); }
  finally { await connection.db.execute(sql`UPDATE users SET mfa_secret=${last.mfa_secret as string} WHERE id=${last.id as string}::uuid`); }
});

it('rejects an authenticated but invalid pending MFA secret beyond the first page', async () => {
  const [last] = await connection.db.execute(sql`SELECT token_hash, pending_mfa FROM sessions ORDER BY token_hash DESC LIMIT 1`);
  await connection.db.execute(sql`UPDATE sessions SET pending_mfa=${encryptSecret('invalid-mfa-secret')} WHERE token_hash=${last.token_hash as string}`);
  try { await expect(checkRecovery(connection.db)).rejects.toThrow('recovery_key_failed'); }
  finally { await connection.db.execute(sql`UPDATE sessions SET pending_mfa=${last.pending_mfa as string} WHERE token_hash=${last.token_hash as string}`); }
});

it('refuses recovery when the restored financial state fails reconciliation', async () => {
  const [unbacked] = await connection.db.insert(users).values({ handle: 'unbacked_recovery', passwordHash: 'synthetic-unused-hash' }).returning();
  try { await expect(checkRecovery(connection.db)).rejects.toThrow('recovery_accounting_failed'); }
  finally { await connection.db.execute(sql`DELETE FROM users WHERE id=${unbacked.id}::uuid`); }
  expect((await checkRecovery(connection.db)).internalStatus).toBe('pass');
});
