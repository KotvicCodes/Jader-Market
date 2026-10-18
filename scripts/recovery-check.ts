import { getDatabase } from '../src/db/client';
import { checkRecovery } from '../src/db/recovery';

const connection = getDatabase();
try {
  if (!connection) throw new Error('configuration');
  await checkRecovery(connection.db);
  console.info('Restored accounting and authentication keys verified; external payments unchecked.');
} catch {
  console.error('Restore verification failed; keep the environment isolated and follow the recovery runbook.');
  process.exitCode = 1;
} finally { await connection?.client.end(); }
