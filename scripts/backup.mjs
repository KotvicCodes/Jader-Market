#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { link, mkdir, readFile, readdir, rename, rm, writeFile, open } from 'node:fs/promises';
import { join, resolve, isAbsolute } from 'node:path';
import { Readable } from 'node:stream';
import { parse } from 'dotenv';
import { privatePath, readKey, seal, unseal } from './backup/archive.mjs';
import { command, dump } from './backup/process.mjs';

const day = 86400000;
const archiveName = /^backup-\d{13}-[a-f0-9]{16}\.jmb$/;
// An explicit env file is authoritative; ambient Compose/configuration cannot redirect operations.
const hostEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  !key.startsWith('COMPOSE_') && !key.startsWith('JADER_') && !['AUTH_SECRET','DATABASE_URL','PGHOST','PGPASSWORD','PGSERVICE'].includes(key)));
function docker(args, options = {}) { return command('docker', args, { env: hostEnv, ...options }); }
async function syncDirectory(path) { const file = await open(path, 'r'); try { await file.sync(); } finally { await file.close(); } }
function envText(values) { return Object.entries(values).map(([key, value]) => `${key}=${value}\n`).join(''); }
function options(args, allowed) {
  const result = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]?.replace(/^--/, '');
    if (args[i] !== `--${key}` || !allowed.includes(key) || result[key] || !args[i+1] || args[i+1].startsWith('--')) throw new Error('arguments');
    result[key] = args[i+1];
  }
  for (const key of allowed) if (!result[key]) throw new Error('arguments');
  return result;
}
async function backup(o) {
  await privatePath(o.directory, true); await privatePath(o['env-file']);
  if (!isAbsolute(o.replicate)) throw new Error('absolute_replication_program_required');
  const key = await readKey(o.key);
  const config = parse(await readFile(o['env-file']));
  if (!/^[a-f0-9]{64}$/.test(config.AUTH_SECRET ?? '') || !/^[a-zA-Z0-9][a-zA-Z0-9_./:@-]{0,255}$/.test(config.JADER_IMAGE ?? '')) throw new Error('configuration');
  if (!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(o.project)) throw new Error('project');
  const compose = ['compose', '--project-name', o.project, '--env-file', resolve(o['env-file']), '-f', resolve('deploy/compose.yaml')];
  const env = { ...hostEnv, ...config };
  const id = (await command('docker', [...compose, 'ps', '-q', 'db'], { env, capture: true })).trim();
  if (!/^[a-f0-9]{12,64}$/.test(id)) throw new Error('database_not_running');
  const [container] = JSON.parse(await docker(['inspect', id], { capture: true }));
  if (container.Config.Labels['com.docker.compose.project'] !== o.project || container.Config.Labels['com.docker.compose.service'] !== 'db') throw new Error('database_identity');
  const [image] = JSON.parse(await docker(['image', 'inspect', config.JADER_IMAGE], { capture: true }));
  if (!/^sha256:[a-f0-9]{64}$/.test(image.Id)) throw new Error('release_image_required');
  // A valid env file can still be stale. Bind its key and image to the deployed
  // release, including stopped containers retained during a fenced upgrade.
  const releases = (await command('docker', [...compose, 'ps', '--all', '-q', 'app', 'worker', 'monitor'], { env, capture: true })).trim().split(/\s+/);
  if (!releases.every(id => /^[a-f0-9]{12,64}$/.test(id))) throw new Error('source_release_required');
  const services = JSON.parse(await docker(['inspect', ...releases], { capture: true }));
  const sourceUrl = new URL(config.JADER_RUNTIME_DATABASE_URL);
  if (!['postgres:', 'postgresql:'].includes(sourceUrl.protocol) || sourceUrl.hostname !== 'db' ||
      (sourceUrl.port && sourceUrl.port !== '5432') || sourceUrl.pathname !== '/jader_market' ||
      sourceUrl.username !== 'jader_runtime' || sourceUrl.search || sourceUrl.hash) throw new Error('source_database_mismatch');
  if (!services.some(c => c.Config.Labels['com.docker.compose.service'] === 'app') || services.some(c =>
    c.Config.Labels['com.docker.compose.project'] !== o.project ||
    !['app', 'worker', 'monitor'].includes(c.Config.Labels['com.docker.compose.service']) || c.Image !== image.Id ||
    !c.Config.Env.includes(`AUTH_SECRET=${config.AUTH_SECRET}`) ||
    !c.Config.Env.includes(`DATABASE_URL=${config.JADER_RUNTIME_DATABASE_URL}`))) throw new Error('source_release_mismatch');
  await mkdir(join(o.directory, '.backup-lock'), { mode: 0o700 });
  const name = `backup-${Date.now()}-${randomBytes(8).toString('hex')}.jmb`, target = join(o.directory, name), partial = `${target}.partial`;
  let source;
  try {
    source = dump(['exec', id, 'pg_dump', '-U', 'jader_owner', '-d', 'jader_market', '-Fc', '--no-owner', '--no-acl', '--lock-wait-timeout=30s'], hostEnv);
    const sealing = seal(source.stream, partial, key, { format: 1, startedAt: new Date().toISOString(), image: config.JADER_IMAGE, imageId: image.Id, authSecret: config.AUTH_SECRET, postgres: '17.6', database: 'jader_market' });
    try { await Promise.all([sealing, source.done]); }
    catch (error) {
      source.cancel(); source.stream.destroy();
      // Finish both operations before deleting the partial or releasing the lock.
      await Promise.allSettled([sealing, source.done]);
      throw error;
    }
    // link fails rather than replacing any existing backup.
    await link(partial, target); await rm(partial); await syncDirectory(o.directory);
    await command(o.replicate, [resolve(target)], { env: hostEnv });
    const marker = join(o.directory, '.success.partial');
    await writeFile(marker, JSON.stringify({ completedAt: new Date().toISOString(), archive: name }), { mode: 0o600, flag: 'wx' });
    await rename(marker, join(o.directory, 'last-success.json')); await syncDirectory(o.directory);
    // Retain at least 7 snapshots and everything from the last 30 days. Never prune on copy failure.
    const names = (await readdir(o.directory)).filter(n => archiveName.test(n)).sort().reverse();
    for (const old of names.slice(7)) if (Date.now() - Number(old.split('-')[1]) > 30 * day) {
      await privatePath(join(o.directory, old)); await rm(join(o.directory, old));
    }
    console.info('Protected backup and replication completed.');
  } finally {
    source?.cancel();
    await rm(partial, { force: true });
    await rm(join(o.directory, '.success.partial'), { force: true });
    await rm(join(o.directory, '.backup-lock'), { recursive: true });
  }
}
async function status(o) {
  await privatePath(o.directory, true);
  const marker = join(o.directory, 'last-success.json'); await privatePath(marker);
  const info = JSON.parse(await readFile(marker, 'utf8')), age = Date.now() - Date.parse(info.completedAt);
  if (!archiveName.test(info.archive) || !Number.isFinite(age) || age < 0 || age > 26 * 3600000) throw new Error('stale');
  await privatePath(join(o.directory, info.archive));
  console.info('Protected replicated backup is current.');
}
async function restore(o) {
  const key = await readKey(o.key), parent = resolve(o.output, '..');
  await privatePath(parent, true);
  // Fresh directory is the only accepted target. There is no live database URL option.
  await mkdir(o.output, { mode: 0o700 });
  const staging = join(o.output, 'authenticated.payload');
  const name = `jader-recovery-${randomBytes(12).toString('hex')}`;
  let created = false, success = false;
  try {
    const { metadata, offset } = await unseal(o.archive, staging, key);
    // A mutable tag may have moved since the backup. The preserved immutable
    // artifact is authoritative; never substitute the tag's current contents.
    const [release] = JSON.parse(await docker(['image', 'inspect', metadata.imageId], { capture: true }));
    if (release.Id !== metadata.imageId) throw new Error('release_image_mismatch');
    const password = randomBytes(32).toString('hex');
    const environment = join(o.output, 'recovery.env');
    await writeFile(environment, envText({ POSTGRES_USER: 'jader_bootstrap', POSTGRES_DB: 'jader_market', POSTGRES_PASSWORD: password,
      JADER_OWNER_PASSWORD: randomBytes(32).toString('hex'), JADER_RUNTIME_PASSWORD: randomBytes(32).toString('hex'), AUTH_SECRET: metadata.authSecret }), { mode: 0o600, flag: 'wx' });
    await docker(['create', '--name', name, '--network', 'none', '--label', 'jader.recovery=isolated', '--env-file', environment,
      '--mount', `type=bind,src=${resolve('deploy/init-db.sh')},dst=/docker-entrypoint-initdb.d/10-roles.sh,readonly`,
      'postgres:17.6-alpine', 'postgres', '-c', 'log_statement=none', '-c', 'log_min_error_statement=panic', '-c', 'log_min_messages=panic']);
    created = true; await docker(['start', name]);
    let ready = false;
    for (let i=0; i<60; i++) {
      try { await docker(['exec', name, 'pg_isready', '-h', '127.0.0.1', '-U', 'jader_bootstrap', '-d', 'jader_market']); ready = true; break; }
      catch { await new Promise(r => setTimeout(r, 1000)); }
    }
    if (!ready) throw new Error('database_unavailable');
    await docker(['exec', '-i', name, 'pg_restore', '-U', 'jader_bootstrap', '-d', 'jader_market', '--role=jader_owner', '--no-owner', '--no-acl', '--exit-on-error', '--single-transaction'], { input: createReadStream(staging, { start: offset }) });
    // Recreate reviewed grants from the SAME release as the dump; no migrations or workers run here.
    const config = parse(await readFile(environment));
    const appEnv = { AUTH_SECRET: metadata.authSecret, DATABASE_URL: `postgresql://jader_owner:${config.JADER_OWNER_PASSWORD}@127.0.0.1:5432/jader_market` };
    const ownerFile = join(o.output, 'owner.env'), runtimeFile = join(o.output, 'runtime.env');
    await writeFile(ownerFile, envText(appEnv), { mode: 0o600, flag: 'wx' });
    await writeFile(runtimeFile, envText({ ...appEnv, DATABASE_URL: `postgresql://jader_runtime:${config.JADER_RUNTIME_PASSWORD}@127.0.0.1:5432/jader_market` }), { mode: 0o600, flag: 'wx' });
    const app = (file, script) => docker(['run', '--rm', '--network', `container:${name}`, '--env-file', file,
      '--security-opt', 'no-new-privileges:true', '--cap-drop', 'ALL', metadata.imageId,
      'node', '--import', './scripts/register-typescript.mjs', script]);
    await app(ownerFile, 'scripts/runtime-grants.ts');
    await app(runtimeFile, 'scripts/recovery-check.ts');
    // A pre-incident snapshot can resurrect revoked sessions. Always invalidate them.
    await docker(['exec', '-i', name, 'psql', '-U', 'jader_owner', '-d', 'jader_market', '-v', 'ON_ERROR_STOP=1'], { input: Readable.from(['BEGIN; DELETE FROM sessions; COMMIT;']) });
    await writeFile(join(o.output, 'restore.json'), JSON.stringify({ container: name, image: metadata.image, imageId: metadata.imageId, backupStartedAt: metadata.startedAt, sessionsRevoked: true, internalChecks: 'pass', externalPayments: 'not_checked' }), { mode: 0o600, flag: 'wx' });
    success = true;
    console.info('Isolated restore verified; sessions revoked. External payment reconciliation and cutover approval remain required.');
  } finally {
    await rm(staging, { force: true });
    if (!success) {
      if (created) await docker(['rm', '-fv', name]);
      await rm(o.output, { recursive: true, force: true });
    }
  }
}
try {
  const [action, ...args] = process.argv.slice(2);
  if (action === '--help') console.info('Usage: backup.mjs backup --env-file FILE --project PROJECT --key FILE --directory DIR --replicate ABSOLUTE_PROGRAM\n       backup.mjs restore --archive FILE --key FILE --output NEW_PRIVATE_DIRECTORY\n       backup.mjs status --directory DIR\nSee docs/BACKUP_RECOVERY.md.');
  else if (action === 'backup') await backup(options(args, ['env-file','project','key','directory','replicate']));
  else if (action === 'restore') await restore(options(args, ['archive','key','output']));
  else if (action === 'status') await status(options(args, ['directory']));
  else throw new Error('arguments');
} catch {
  console.error('Backup/recovery failed. Check private configuration, key custody, storage, Docker and the recovery runbook; no clearance issued.');
  process.exitCode = 1;
}
