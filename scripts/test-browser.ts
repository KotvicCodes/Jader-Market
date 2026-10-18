import assert from 'node:assert/strict';
import { startAcceptance, execute } from './acceptance-environment';
import { reconcileDatabase } from '../src/db/reconciliation';

let environment: Awaited<ReturnType<typeof startAcceptance>> | undefined;
try {
  environment=await startAcceptance(); environment.startWorker();
  if (process.argv.includes('--preview')) {
    // Only the synthetic login is disclosed. No database credentials or keys.
    console.info(`Synthetic browser rehearsal: ${environment.origin}/account; handle preview_admin; password fictional-acceptance-password-2026`);
    await new Promise<void>(resolve=>{process.once('SIGTERM',resolve);process.once('SIGINT',resolve);});
  } else {
    await execute(process.execPath,['node_modules/@playwright/test/cli.js','test',...process.argv.slice(2)],{...environment.environment,ACCEPTANCE_ORIGIN:environment.origin},text=>process.stdout.write(text));
    const before=await environment.connection.client`SELECT count(*)::int AS count FROM market_payouts`;
    await environment.restartWorker();
    const after=await environment.connection.client`SELECT count(*)::int AS count FROM market_payouts`;
    assert.deepEqual(after,before,'Worker restart must not pay completed holdings twice');
    const report=await reconcileDatabase(environment.connection.db,{version:1,complete:true,reviewedAt:new Date().toISOString(),payments:[]});
    assert.equal(report.status,'pass');
    console.info('Selected browser workflows, worker restart and complete synthetic reconciliation passed.');
  }
} catch { console.error('Browser acceptance failed.');process.exitCode=1; }
finally {await environment?.cleanup();}
