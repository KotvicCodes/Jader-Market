// Uses only fresh synthetic Docker resources. Never reads .env or the development DB.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import { command } from './backup/process.mjs';
import { seal, unseal } from './backup/archive.mjs';

const directory=await mkdtemp(join(tmpdir(),'jader-recovery-proof-'));
const project=`jader-recovery-proof-${randomBytes(6).toString('hex')}`;
const image=`jader-market:recovery-${randomBytes(6).toString('hex')}`;
const base=process.env.DEPLOYMENT_TEST_IMAGE ?? 'jader-market:deployment-test';
const environment=Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('COMPOSE_') && !key.startsWith('JADER_') && !['AUTH_SECRET','DATABASE_URL'].includes(key)));
const run=(cmd,args,options={})=>command(cmd,args,{env:environment,...options});
let stage='image preparation', restored;
const previousRestores=(await run('docker',['ps','-aq','--filter','label=jader.recovery=isolated'],{capture:true})).trim();
const envFile=join(directory,'production.env'), keyFile=join(directory,'backup.key');
const synthetic={JADER_HOST:'localhost',JADER_IMAGE:image,JADER_TLS_DIRECTORY:directory,AUTH_SECRET:randomBytes(32).toString('hex'),
  JADER_BOOTSTRAP_PASSWORD:randomBytes(32).toString('hex'),JADER_OWNER_PASSWORD:randomBytes(32).toString('hex'),JADER_RUNTIME_PASSWORD:randomBytes(32).toString('hex')};
synthetic.JADER_OWNER_DATABASE_URL=`postgresql://jader_owner:${synthetic.JADER_OWNER_PASSWORD}@db:5432/jader_market`;
synthetic.JADER_RUNTIME_DATABASE_URL=`postgresql://jader_runtime:${synthetic.JADER_RUNTIME_PASSWORD}@db:5432/jader_market`;
const compose=['compose','--project-name',project,'--env-file',envFile,'-f',resolve('deploy/compose.yaml')];
const dc=(args)=>command('docker',[...compose,...args],{env:{...environment,...synthetic},capture:true});
const cli=(args)=>run(process.execPath,['scripts/backup.mjs',...args]);
try {
  // Reuse the built production artifact, adding only this PR's operator scripts.
  const dockerfile=join(directory,'Dockerfile');
  await writeFile(dockerfile,`FROM ${base}\nCOPY --chown=node:node scripts /app/scripts\nCOPY --chown=node:node src /app/src\nCOPY --chown=node:node package.json /app/package.json\n`);
  await run('docker',['build','-f',dockerfile,'-t',image,'.']);
  const [originalRelease]=JSON.parse(await run('docker',['image','inspect',image],{capture:true}));
  await writeFile(envFile,Object.entries(synthetic).map(([k,v])=>`${k}=${v}\n`).join(''),{mode:0o600});
  const key=randomBytes(32); await writeFile(keyFile,key.toString('hex'),{mode:0o600});
  stage='isolated source database'; await dc(['up','-d','--wait','db']);
  // Stopped release containers also bind backups taken during a fenced upgrade.
  await dc(['create','--no-build','app','worker','monitor']);
  const id=(await dc(['ps','-q','db'])).trim();
  const owner=join(directory,'source-owner.env');
  await writeFile(owner,`DATABASE_URL=postgresql://jader_owner:${synthetic.JADER_OWNER_PASSWORD}@127.0.0.1:5432/jader_market\nAUTH_SECRET=${synthetic.AUTH_SECRET}\nRECOVERY_SYNTHETIC_PROOF=yes\n`,{mode:0o600});
  const app=(container,file,args)=>run('docker',['run','--rm','--user',String(process.getuid()),'--network',`container:${container}`,'--env-file',file,
    '--mount',`type=bind,src=${directory},dst=/proof`,originalRelease.Id,'node','--import','./scripts/register-typescript.mjs',...args]);
  await app(id,owner,['scripts/migrate.ts']);
  stage='synthetic reserved funds and interrupted payouts'; await app(id,owner,['scripts/recovery-fixture.ts','setup']);
  stage='encrypted backup and replication';
  // Nine old snapshots exercise the 30-day cutoff and minimum-seven safeguard.
  for (let i=0;i<9;i++) await writeFile(join(directory,`backup-${Date.now()-40*86400000+i}-${randomBytes(8).toString('hex')}.jmb`),'synthetic expired archive',{mode:0o600});
  const replication=join(directory,'replicate');
  // Contract test: a durable independent copy, without the backup key.
  await writeFile(replication,'#!/bin/sh\nset -eu\ncp "$1" "'+directory+'/replicated.jmb"\nsync\n',{mode:0o700});
  const backupArgs=['backup','--env-file',envFile,'--project',project,'--key',keyFile,'--directory',directory,'--replicate',replication];
  stage='source release and authentication identity';
  const originalEnv=await readFile(envFile,'utf8');
  await writeFile(envFile,originalEnv.replace(synthetic.AUTH_SECRET,randomBytes(32).toString('hex')));
  await assert.rejects(cli(backupArgs),'A mismatched source authentication key must not publish a backup');
  await writeFile(envFile,originalEnv);
  await run('docker',['tag',base,image]);
  await assert.rejects(cli(backupArgs),'A retagged release must not describe a different running artifact');
  await run('docker',['tag',originalRelease.Id,image]);
  stage='encrypted backup and replication';
  await cli(backupArgs); await cli(['status','--directory',directory]);
  const retained=(await readdir(directory)).filter(name=>/^backup-.*\.jmb$/.test(name));
  assert.equal(retained.length,7,'Retention preserves the newest seven snapshots');
  const marker=JSON.parse(await readFile(join(directory,'last-success.json'),'utf8'));
  const archive=join(directory,marker.archive);
  assert.deepEqual(await readFile(archive),await readFile(join(directory,'replicated.jmb')));
  stage='failed copy does not advance freshness';
  await assert.rejects(cli([...backupArgs.slice(0,-1),'/bin/false']));
  assert.deepEqual(JSON.parse(await readFile(join(directory,'last-success.json'),'utf8')),marker);
  stage='wrong key and authenticated corruption rejection';
  const wrong=join(directory,'wrong.key'); await writeFile(wrong,randomBytes(32).toString('hex'),{mode:0o600});
  await assert.rejects(cli(['restore','--archive',archive,'--key',wrong,'--output',join(directory,'wrong')]));
  const damaged=join(directory,'damaged.jmb'), bytes=await readFile(archive); bytes[bytes.length-1]^=1;
  await writeFile(damaged,bytes,{mode:0o600});
  await assert.rejects(cli(['restore','--archive',damaged,'--key',keyFile,'--output',join(directory,'damaged')]));
  stage='transactional SQL failure and cleanup';
  const [release]=JSON.parse(await run('docker',['image','inspect',image],{capture:true}));
  const broken=join(directory,'broken.jmb');
  await seal(Readable.from(['not a postgres dump']),broken,key,{format:1,authSecret:synthetic.AUTH_SECRET,image,imageId:release.Id,startedAt:new Date().toISOString()});
  await assert.rejects(cli(['restore','--archive',broken,'--key',keyFile,'--output',join(directory,'broken')]));
  stage='matching authentication key verification';
  const plaintext=join(directory,'test.payload'); const decoded=await unseal(archive,plaintext,key);
  const mismatch=join(directory,'mismatch.jmb');
  await seal(createReadStream(plaintext,{start:decoded.offset}),mismatch,key,{...decoded.metadata,authSecret:randomBytes(32).toString('hex')});
  await rm(plaintext);
  await assert.rejects(cli(['restore','--archive',mismatch,'--key',keyFile,'--output',join(directory,'mismatch')]));
  assert.equal((await run('docker',['ps','-aq','--filter','label=jader.recovery=isolated'],{capture:true})).trim(),previousRestores,'Failed restores must not leave running or stopped databases');
  stage='successful isolated restore after the release tag moves'; const output=join(directory,'restored');
  await run('docker',['tag',base,image]);
  await cli(['restore','--archive',archive,'--key',keyFile,'--output',output]);
  const manifest=JSON.parse(await readFile(join(output,'restore.json'),'utf8')); restored=manifest.container;
  const [container]=JSON.parse(await run('docker',['inspect',restored],{capture:true}));
  assert.equal(container.HostConfig.NetworkMode,'none'); assert.equal(Object.keys(container.HostConfig.PortBindings ?? {}).length,0);
  assert.ok(container.Config.Cmd.includes('log_min_messages=panic'),'Restored private rows must not leak through database error details');
  const privateSentinel='synthetic-private-restored-value';
  await assert.rejects(run('docker',['exec','-i',restored,'psql','-U','jader_owner','-d','jader_market','-v','ON_ERROR_STOP=1'], {
    input: Readable.from([`CREATE TEMP TABLE private_log_probe(value text PRIMARY KEY); INSERT INTO private_log_probe VALUES ('${privateSentinel}'), ('${privateSentinel}');`]),
  }));
  const logs=spawnSync('docker',['logs',restored],{env:environment,encoding:'utf8',timeout:30000});
  assert.equal(logs.status,0);
  assert.ok(!(logs.stdout+logs.stderr).includes(privateSentinel),'Database error details must stay out of container logs');
  assert.equal(manifest.sessionsRevoked,true);
  stage='restored accounting, MFA, revoked sessions, reservations and payout replay';
  const runtime=join(output,'runtime.env');
  await writeFile(runtime,(await readFile(runtime,'utf8'))+'RECOVERY_SYNTHETIC_PROOF=yes\n',{mode:0o600});
  await app(restored,runtime,['scripts/recovery-fixture.ts','verify']);
  stage='refusal to overwrite and freshness failure';
  await assert.rejects(cli(['restore','--archive',archive,'--key',keyFile,'--output',output]));
  await writeFile(join(directory,'last-success.json'),JSON.stringify({...marker,completedAt:new Date(Date.now()-27*3600000).toISOString()}),{mode:0o600});
  await assert.rejects(cli(['status','--directory',directory]));
  assert.ok(!(await readdir(output)).includes('authenticated.payload'));
  console.info('Isolated backup/restore drill passed: exact history, keys/MFA, session revocation, reservations, collateral and resumable payouts.');
} catch {
  console.error(`Backup/restore drill failed at ${stage}; private output suppressed.`); process.exitCode=1;
} finally {
  if (restored) await run('docker',['rm','-fv',restored]);
  await dc(['down','--volumes','--remove-orphans']);
  await run('docker',['image','rm',image]);
  await rm(directory,{recursive:true,force:true});
}
