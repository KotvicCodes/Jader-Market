// Disposable synthetic infrastructure only. No ambient database/deployment target is accepted.
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { createServer as createProxy, request as upstreamRequest, type Server } from 'node:http';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { createDatabase } from '../src/db/client';
import { grantRuntimeRole } from '../src/db/runtime-role';
import { ledgerAccounts, users } from '../src/db/schema';
import { hashPassword } from '../src/domain/identity';
import { readWorkerStatus } from '../src/domain/worker-status';

export const syntheticPassword = 'fictional-acceptance-password-2026';
const executing = new Set<ChildProcess>();
const processGroups = new WeakSet<ChildProcess>();
const closedProcesses = new WeakSet<ChildProcess>();
function managed(child: ChildProcess) {
  if (process.platform !== 'win32') processGroups.add(child);
  child.once('close', () => closedProcesses.add(child));
  return child;
}
export async function execute(command: string, args: string[], env = process.env, onOutput?: (text:string)=>void, timeoutMs = 60000) {
  const child = managed(spawn(command, args, { env, detached:process.platform !== 'win32', stdio: ['ignore','pipe','ignore'] }));
  executing.add(child);
  let output = '';
  child.stdout!.on('data', chunk => { onOutput?.(chunk.toString());if (output.length < 1024*1024) output += chunk; });
  let timedOut = false;
  const timeout = setTimeout(() => { timedOut = true; void stop(child); }, timeoutMs);
  try {
    const [code] = await once(child,'close');
    if (timedOut) throw new Error('acceptance_subprocess_timeout');
    if (code !== 0) throw new Error('acceptance_subprocess_failed');
    return output;
  } finally {
    clearTimeout(timeout);
    try { await stop(child); } finally { executing.delete(child); }
  }
}
async function stop(child?: ChildProcess) {
  if (!child) return;
  const group = child.pid && processGroups.has(child);
  if (!group && closedProcesses.has(child)) return;
  const signal = (value:NodeJS.Signals) => {
    try {
      if (group) process.kill(-child.pid!,value);
      else child.kill(value);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
  };
  // An exited group leader can still have descendants holding its pipes open.
  const closed = closedProcesses.has(child) ? Promise.resolve() : once(child,'close');
  signal('SIGTERM');
  const force = setTimeout(() => signal('SIGKILL'), 10000);
  try { await closed; } finally {
    clearTimeout(force);
    // Descendants with independent stdio may outlive the leader's close event.
    if (group) signal('SIGKILL');
  }
}
async function unusedPort() {
  const server = createServer(); server.listen(0,'127.0.0.1'); await once(server,'listening');
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('port');
  const port = address.port; await new Promise<void>((resolve,reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}
export async function startAcceptance() {
  const directory = await mkdtemp(join(tmpdir(),'jader-acceptance-'));
  const container = `jader-acceptance-${randomBytes(8).toString('hex')}`;
  const dbPassword = randomBytes(24).toString('hex'), runtimePassword = randomBytes(24).toString('hex');
  const authSecret = randomBytes(32).toString('hex');
  const environment = {...Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !key.startsWith('COMPOSE_') && !key.startsWith('JADER_') && !key.startsWith('ACCEPTANCE_') && !['DATABASE_URL','TEST_DATABASE_URL','AUTH_SECRET','APP_ORIGIN','AUTH_TRUSTED_IP_HEADER','WORKER_STATUS_FILE'].includes(key))),NODE_ENV:'production' as const};
  let proxy:Server|undefined;
  let created = false, app: ChildProcess | undefined, worker: ChildProcess | undefined;
  let interrupted=false;
  const ensureActive=()=>{if(interrupted)throw new Error('acceptance_interrupted');};
  let connection: ReturnType<typeof createDatabase> | undefined;
  let cleaning:Promise<void>|undefined;
  const cleanup = () => cleaning ??= (async () => {
    process.removeListener('SIGINT',onInterrupt); process.removeListener('SIGTERM',onTerminate);
    const failures:unknown[]=[];
    const attempt = async (work:()=>Promise<unknown>) => { try { await work(); } catch(error) { failures.push(error); } };
    await Promise.all([...executing].map(child=>attempt(()=>stop(child))));
    await Promise.all([attempt(()=>stop(worker)),attempt(()=>stop(app))]);
    await attempt(async()=>{if(proxy){proxy.closeAllConnections();await new Promise<void>(resolve=>proxy!.close(()=>resolve()));}});
    await attempt(async()=>{await connection?.client.end({timeout:5});});
    // A signal can interrupt Docker after create succeeds but before it returns.
    if(!created){
      try {
        const [info]=JSON.parse(await execute('docker',['inspect',container],environment));
        created=info.Config.Labels?.['jader.synthetic']==='acceptance';
      } catch { /* A create that never reached Docker has no container to remove. */ }
    }
    await attempt(async()=>{if(created)await execute('docker',['rm','-fv',container],environment);});
    await attempt(()=>rm(directory,{recursive:true,force:true}));
    if(failures.length)throw new Error('acceptance_cleanup_failed');
  })();
  const interrupt = (code:number) => {
    interrupted=true;
    void cleanup().then(()=>process.exit(code),()=>process.exit(1));
  };
  const onInterrupt=()=>interrupt(130),onTerminate=()=>interrupt(143);
  process.once('SIGINT',onInterrupt); process.once('SIGTERM',onTerminate);
  try {
    await execute('docker',['create','--name',container,'--label','jader.synthetic=acceptance',
      '-e','POSTGRES_USER=jader','-e',`POSTGRES_PASSWORD=${dbPassword}`,'-e','POSTGRES_DB=jader_acceptance_test',
      '-p','127.0.0.1::5432','postgres:17.6-alpine'],environment);
    created = true; ensureActive(); await execute('docker',['start',container],environment);
    const binding = (await execute('docker',['port',container,'5432/tcp'],environment)).trim();
    if (!/^127\.0\.0\.1:\d+$/.test(binding)) throw new Error('private_port_required');
    const ownerUrl = `postgresql://jader:${dbPassword}@${binding}/jader_acceptance_test`;
    connection = createDatabase(ownerUrl);
    let ready = false;
    for (let i=0;i<60;i++) {
      try { await connection.client`SELECT 1`; ready = true; break; } catch { await delay(250); }
    }
    if (!ready) throw new Error('database_unavailable');
    await migrate(connection.db,{migrationsFolder:'drizzle'});
    await connection.client.unsafe(`CREATE ROLE jader_runtime LOGIN PASSWORD '${runtimePassword}'`);
    await grantRuntimeRole(connection.db,'jader_runtime');
    await connection.db.insert(ledgerAccounts).values({kind:'issuance'});
    const passwordHash = await hashPassword(syntheticPassword);
    for (const project of ['desktop','mobile','keyboard','preview']) {
      const [admin] = await connection.db.insert(users).values({handle:`${project}_admin`,role:'admin',passwordHash}).returning();
      await connection.db.insert(ledgerAccounts).values([{kind:'wallet',ownerId:admin.id},{kind:'reserved',ownerId:admin.id}]);
    }
    const runtimeUrl = `postgresql://jader_runtime:${runtimePassword}@${binding}/jader_acceptance_test`;
    const port = await unusedPort(), origin = `http://localhost:${port}`;
    ensureActive();
    let appPort=0;
    proxy=createProxy((request,response)=>{
      const upstream=upstreamRequest({hostname:'127.0.0.1',port:appPort,path:request.url,method:request.method,headers:{...request.headers,host:`localhost:${port}`,'x-acceptance-client-ip':request.socket.remoteAddress??'127.0.0.1'}},result=>{
        response.writeHead(result.statusCode??502,result.headers);result.pipe(response);
      });
      upstream.on('error',()=>{if(!response.headersSent)response.writeHead(503);response.end();});
      response.on('close',()=>{if(!response.writableFinished)upstream.destroy();});request.pipe(upstream);
    });
    proxy.listen(port,'127.0.0.1');await once(proxy,'listening');appPort=await unusedPort();
    ensureActive();
    const runtimeEnvironment = { ...environment, DATABASE_URL:runtimeUrl, AUTH_SECRET:authSecret,APP_ORIGIN:origin,AUTH_TRUSTED_IP_HEADER:'x-acceptance-client-ip',
      WORKER_STATUS_FILE:join(directory,'worker-status.json'),NEXT_TELEMETRY_DISABLED:'1',TMPDIR:directory };
    app = managed(spawn(process.execPath,['node_modules/next/dist/bin/next','start','--hostname','127.0.0.1','--port',String(appPort)],{env:runtimeEnvironment,detached:process.platform !== 'win32',stdio:'ignore'}));
    app.on('error',()=>{});
    for (let i=0;i<100;i++) {
      if (app.exitCode !== null) throw new Error('application_stopped');
      try { const r=await fetch(`${origin}/api/ready`,{signal:AbortSignal.timeout(1000)}); if (r.ok) break; } catch {}
      if (i===99) throw new Error('application_unavailable');
      await delay(200);
    }
    const startWorker = () => {
      ensureActive();
      if (worker && worker.exitCode === null && worker.signalCode === null) throw new Error('worker_already_started');
      worker=managed(spawn(process.execPath,['--import','./scripts/register-typescript.mjs','scripts/worker.ts'],{env:runtimeEnvironment,detached:process.platform !== 'win32',stdio:'ignore'}));
      worker.on('error',()=>{});
    };
    const restartWorker = async () => {
      await stop(worker);
      // Removing the stopped worker's status prevents an old heartbeat from passing.
      await rm(runtimeEnvironment.WORKER_STATUS_FILE,{force:true});
      startWorker();
      for(let i=0;i<50;i++){
        if(worker!.exitCode!==null||worker!.signalCode!==null)throw new Error('restarted_worker_stopped');
        const heartbeat=await readWorkerStatus(runtimeEnvironment.WORKER_STATUS_FILE);
        if(heartbeat?.lastSuccess&&heartbeat.consecutiveFailures===0)return;
        await delay(100);
      }
      throw new Error('restarted_worker_unavailable');
    };
    ensureActive();
    return {directory,container,connection,origin,port,ownerUrl,runtimeUrl,authSecret,runtimeEnvironment,environment,
      startWorker,restartWorker,stopWorker:()=>stop(worker),cleanup};
  } catch (error) { await cleanup(); throw error; }
}
export type AcceptanceEnvironment = Awaited<ReturnType<typeof startAcceptance>>;
