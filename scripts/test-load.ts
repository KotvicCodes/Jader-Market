import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile, readFile, rm } from 'node:fs/promises';
import { cpus, totalmem } from 'node:os';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { eq } from 'drizzle-orm';
import { startAcceptance } from './acceptance-environment';
import { lockWaitBounds } from './acceptance-metrics';
import { getDatabase } from '../src/db/client';
import { adjustCredits } from '../src/db/members';
import { mutateTrading } from '../src/db/trading';
import { mutateMarket } from '../src/db/market-admin';
import { reconcileDatabase } from '../src/db/reconciliation';
import { operationsSnapshot } from '../src/db/operations';
import { ledgerAccounts, markets, sessions, users } from '../src/db/schema';
import { digest, encryptSecret, randomToken } from '../src/domain/identity';
import version from '../package.json' with {type:'json'};

const profile={participants:20,concurrency:10,historicalTrades:1000,roundsPerVirtualUser:60,thinkTimeMs:1000,p95ReadMs:1000,p95WriteMs:2000,maxLockWaitMs:500,maxWorkerLagMs:5000};
const percentile=(values:number[],p:number)=>[...values].sort((a,b)=>a-b)[Math.max(0,Math.ceil(values.length*p)-1)]??0;
let env:Awaited<ReturnType<typeof startAcceptance>>|undefined,stage='isolated startup',sampling:ReturnType<typeof setInterval>|undefined;
const reads:number[]=[],writes:number[]=[],lockSamples:number[]=[],workerSamples:number[]=[],settlementSamples:number[]=[],expirySamples:number[]=[],sampleTimes:number[]=[],monotonicSampleTimes:number[]=[];
let unexpectedErrors=0,samplingErrors=0,measuredWrites=0;
try{
  await rm('.cache/load-acceptance.json',{force:true});
  env=await startAcceptance();
  process.env.DATABASE_URL=env.runtimeUrl;process.env.AUTH_SECRET=env.authSecret;
  const db=env.connection.db,client=env.connection.client;
  const token=randomToken();
  const [admin]=await db.update(users).set({mfaSecret:encryptSecret('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ')}).where(eq(users.handle,'preview_admin')).returning();
  await db.insert(sessions).values({userId:admin.id,tokenHash:digest(token),csrfHash:digest(randomToken()),expiresAt:new Date(Date.now()+3600000)});
  const actors:{id:string;token:string;csrf:string}[]=[];
  const [template]=await db.select().from(users).where(eq(users.id,admin.id));
  for(let i=0;i<profile.participants;i++){
    const [u]=await db.insert(users).values({handle:`load_participant_${i}`,passwordHash:template.passwordHash}).returning();
    await db.insert(ledgerAccounts).values([{kind:'wallet',ownerId:u.id},{kind:'reserved',ownerId:u.id}]);
    const session=randomToken(),csrf=randomToken();actors.push({id:u.id,token:session,csrf});
    await db.insert(sessions).values({userId:u.id,tokenHash:digest(session),csrfHash:digest(csrf),expiresAt:new Date(Date.now()+3600000)});
    await adjustCredits(token,{recipientId:u.id,amount:'10000',kind:'credit',reason:'demo_grant',operationKey:randomUUID(),confirmed:true});
  }
  const makeMarket=async(label:string)=>(await db.insert(markets).values({slug:randomUUID(),question:`Will the fictional ${label} load rehearsal succeed?`,description:'Synthetic capacity acceptance only.',category:'community',resolutionRules:'YES for verified synthetic success; NO for failure; invalid when evidence is unavailable.',resolutionSource:'Synthetic acceptance record',status:'open',publishedAt:new Date(),closesAt:new Date('2099-12-31')}).returning())[0];
  const history=await makeMarket('historical'),active=await makeMarket('active'),settling=await makeMarket('worker');
  stage='1000 guarded historical fills';console.info('Building 1,000 genuine matched historical trades with normal financial guards.');
  for(const actor of actors.slice(0,10))await mutateTrading(actor.token,'mint',{marketId:history.id,operationKey:randomUUID(),quantity:'100'});
  for(let i=0;i<profile.historicalTrades;i++){
    const seller=actors[i%10],buyer=actors[10+i%10];
    const body={marketId:history.id,quantity:'1',price:'2500',outcome:'YES',timeInForce:'GTC'};
    await mutateTrading(seller.token,'place',{...body,side:'sell',operationKey:randomUUID()});
    await mutateTrading(buyer.token,'place',{...body,side:'buy',timeInForce:'IOC',operationKey:randomUUID()});
    if((i+1)%200===0)console.info(`Historical trade fixture: ${i+1}/1000.`);
  }
  const [fillCount]=await client`SELECT count(*)::int AS count FROM fills`;
  assert.equal(fillCount.count,1000);
  for(const actor of actors.slice(0,10)){
    await mutateTrading(actor.token,'mint',{marketId:active.id,operationKey:randomUUID(),quantity:'100'});
    await mutateTrading(actor.token,'place',{marketId:active.id,operationKey:randomUUID(),quantity:'100',price:'2500',outcome:'YES',side:'sell',timeInForce:'GTC'});
  }
  // Seed an outstanding settlement with >20 holdings so the worker has real work under load.
  for(const actor of actors)await mutateTrading(actor.token,'mint',{marketId:settling.id,operationKey:randomUUID(),quantity:'1'});
  await mutateMarket(token,'close',{id:settling.id,revision:0,operationKey:randomUUID(),confirmed:true});
  stage='concurrent authenticated HTTP reads/writes and maintenance';
  const runtime=getDatabase();assert.ok(runtime);
  let samplingBusy=false;const waiters:Promise<void>[]=[];
  async function sample(){
    if(samplingBusy)return;samplingBusy=true;
    try{
      // Advisory lock request ages are sampled server-side; this is not total write latency.
      const [locks]=await client<{waitMs:number;sampledAt:number}[]>`SELECT (extract(epoch FROM clock_timestamp())*1000)::float8 AS "sampledAt", coalesce(max(extract(epoch FROM (clock_timestamp()-l.waitstart))*1000),0)::float8 AS "waitMs"
        FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid
        WHERE l.locktype='advisory' AND NOT l.granted AND l.objid=72491948`;
      lockSamples.push(locks.waitMs);sampleTimes.push(locks.sampledAt);monotonicSampleTimes.push(performance.now());
      const status=await operationsSnapshot(runtime!.db,env!.runtimeEnvironment.WORKER_STATUS_FILE);
      if(status.workerAgeSeconds===null||status.consecutiveFailures!==0)throw new Error('worker_unavailable');
      workerSamples.push(status.workerAgeSeconds*1000);settlementSamples.push(status.settlementLagSeconds*1000);expirySamples.push(status.expiryLagSeconds*1000);
    }catch{samplingErrors++;}finally{samplingBusy=false;}
  }
  env.startWorker();
  for(let i=0;i<50;i++){
    try{const heartbeat=JSON.parse(await readFile(env.runtimeEnvironment.WORKER_STATUS_FILE,'utf8'));if(heartbeat.lastSuccess)break;}catch{}
    await delay(100);
  }
  await mutateMarket(token,'resolve',{id:settling.id,revision:1,operationKey:randomUUID(),confirmed:true,result:'invalid',evidence:'Verified fictional load acceptance evidence; this rehearsal is invalid for equal refunds.'});
  const expiring=await mutateTrading(actors[0].token,'place',{marketId:active.id,operationKey:randomUUID(),quantity:'1',price:'7500',outcome:'NO',side:'sell',timeInForce:'GTD',expiresAt:new Date(Math.floor((Date.now()+20000)/1000)*1000).toISOString().replace('.000Z','Z')});
  await sample();sampling=setInterval(()=>{const promise=sample();waiters.push(promise);},50);
  const request=async(actor:typeof actors[number],path:string,body?:Record<string,unknown>)=>{
    const started=performance.now();
    try{
      const response=await fetch(`${env!.origin}${path}`,{method:body?'POST':'GET',signal:AbortSignal.timeout(10000),headers:{Cookie:`jader_session=${actor.token}; jader_csrf=${actor.csrf}`,
        ...(body?{'Content-Type':'application/json',Origin:env!.origin,'X-CSRF-Token':actor.csrf,'X-Account-ID':actor.id}:{})},body:body?JSON.stringify(body):undefined});
      await response.arrayBuffer();if(!response.ok)throw new Error('unexpected_http_status');
      if(body)measuredWrites++;
    }catch{unexpectedErrors++;}
    finally{(body?writes:reads).push(performance.now()-started);}
  };
  const started=performance.now();
  // Ten concurrent virtual users rotate over all twenty participants. Each performs
  // 120 reads and 12 guarded writes, with normal rate limits and one-second think time.
  await Promise.all(Array.from({length:profile.concurrency},async(_,vu)=>{
    for(let i=0;i<profile.roundsPerVirtualUser;i++){
      const actor=actors[vu+(i%2)*profile.concurrency];
      await request(actor,`/api/markets/${active.id}/snapshot`);
      await request(actor,'/api/account/portfolio');
      if(i%10===0)await request(actor,'/api/trading/mint',{marketId:active.id,operationKey:randomUUID(),quantity:'1'});
      if(i%10===5)await request(actor,'/api/trading/place',{marketId:active.id,operationKey:randomUUID(),quantity:'1',price:'2500',outcome:'YES',side:'buy',timeInForce:'IOC'});
      await delay(profile.thinkTimeMs);
    }
  }));
  clearInterval(sampling);sampling=undefined;await Promise.all(waiters);await sample();
  const elapsedMs=performance.now()-started;
  stage='post-load accounting and payout replay';
  const report=await reconcileDatabase(db,{version:1,complete:true,reviewedAt:new Date().toISOString(),payments:[]});
  const [payouts]=await client`SELECT count(*)::int AS count FROM market_payouts WHERE resolution_id IN (SELECT id FROM market_resolutions WHERE market_id=${settling.id})`;
  const [state]=await client`SELECT status FROM markets WHERE id=${settling.id}`;
  const [expired]=await client`SELECT status FROM orders WHERE id=${(expiring.order as {id:string}).id}`;
  const {maxObservedLockWaitMs,maxSamplingGapMs,clockDriftMs,lockWaitUpperBoundMs}=lockWaitBounds(lockSamples,sampleTimes,monotonicSampleTimes);
  const before=await client`SELECT count(*)::int AS count FROM market_payouts`;
  await env.restartWorker();
  const after=await client`SELECT count(*)::int AS count FROM market_payouts`;
  const workerRestartNoDuplicates=before[0].count===after[0].count;
  const [finalFills]=await client`SELECT count(*)::int AS count FROM fills`;
  const activeHoldings=await client<{outcome:string;quantity:string}[]>`SELECT outcome,sum(available+reserved)::text AS quantity FROM holdings WHERE market_id=${active.id} GROUP BY outcome ORDER BY outcome`;
  const [activeMints]=await client`SELECT count(*)::int AS count FROM trading_operations WHERE market_id=${active.id} AND action='mint'`;
  const financialWritesApplied=activeMints.count===70&&activeHoldings.length===2&&activeHoldings.every(row=>row.quantity==='1060');
  const results={generatedAt:new Date().toISOString(),applicationVersion:version.version,profile,environment:{platform:process.platform,architecture:process.arch,node:process.version,logicalCpus:cpus().length,memoryBytes:totalmem()},
    durationMs:Math.round(elapsedMs),readRequests:reads.length,writeRequests:writes.length,unexpectedErrors,samplingErrors,
    p95ReadMs:Math.round(percentile(reads,.95)),p95WriteMs:Math.round(percentile(writes,.95)),maxObservedLockWaitMs:Math.round(maxObservedLockWaitMs),maxSamplingGapMs:Math.round(maxSamplingGapMs),clockDriftMs:Math.round(clockDriftMs),lockWaitUpperBoundMs:Math.round(lockWaitUpperBoundMs),
    maxObservedWorkerLagMs:Math.round(Math.max(0,...workerSamples)),maxObservedSettlementLagMs:Math.round(Math.max(0,...settlementSamples)),maxObservedExpiryLagMs:Math.round(Math.max(0,...expirySamples)),lockSamples:lockSamples.length,
    payoutReceipts:payouts.count,finalFills:finalFills.count,activeMintOperations:activeMints.count,activeHoldings,financialWritesApplied,workerRestartNoDuplicates,reconciliation:report.status,
    passed:clockDriftMs<1000&&unexpectedErrors===0&&samplingErrors===0&&reads.length===1200&&measuredWrites===120&&lockSamples.length>0&&workerSamples.length>0&&
      percentile(reads,.95)<profile.p95ReadMs&&percentile(writes,.95)<profile.p95WriteMs&&lockWaitUpperBoundMs<profile.maxLockWaitMs&&
      Math.max(...workerSamples,...settlementSamples,...expirySamples)<profile.maxWorkerLagMs&&expired.status==='expired'&&state.status==='void'&&payouts.count===40&&finalFills.count===1060&&financialWritesApplied&&workerRestartNoDuplicates&&report.status==='pass'};
  await writeFile('.cache/load-acceptance.json',JSON.stringify(results,null,2)+'\n',{mode:0o600});
  console.info(JSON.stringify(results,null,2));assert.equal(results.passed,true,'Pilot load thresholds must all pass');
}catch{console.error(`Pilot load acceptance failed at ${stage}.`);process.exitCode=1;}
finally{if(sampling)clearInterval(sampling);await getDatabase()?.client.end();await env?.cleanup();}
