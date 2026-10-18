import { expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { command } from '../../scripts/backup/process.mjs';

const imageId = `sha256:${'c'.repeat(64)}`;
const authSecret = 'd'.repeat(64);
const database = 'postgresql://jader_runtime:synthetic@db:5432/jader_market';

// Exercise the real CLI, publication, replication and subprocess boundaries.
// Docker alone is replaced; no real database or deployment is contacted.
async function fixture(test) {
  const directory = await mkdtemp(join(tmpdir(), 'jader-backup-cli-'));
  try {
    const bin = join(directory, 'bin'), archives = join(directory, 'archives');
    await mkdir(bin); await mkdir(archives, { mode: 0o700 });
    const state = { imageId, failDump: false, services: ['app', 'worker', 'monitor'].map(service => ({
      Image: imageId, Config: { Labels: { 'com.docker.compose.project': 'synthetic', 'com.docker.compose.service': service },
        Env: [`AUTH_SECRET=${authSecret}`, `DATABASE_URL=${database}`] },
    })) };
    const stateFile = join(directory, 'state.json');
    const calls = join(directory, 'calls.jsonl');
    await writeFile(join(bin, 'docker'), `#!${process.execPath}
import { readFileSync, appendFileSync } from 'node:fs';
const state = JSON.parse(readFileSync(process.env.BACKUP_TEST_STATE));
const args = process.argv.slice(2);
appendFileSync(process.env.BACKUP_TEST_CALLS, JSON.stringify(args)+'\\n');
if (args[0] === 'compose') console.log(args.at(-1) === 'db' ? 'a'.repeat(64) : 'b'.repeat(64));
else if (args[0] === 'image') console.log(JSON.stringify([{Id:state.imageId}]));
else if (args[0] === 'inspect') console.log(JSON.stringify(args[1] === 'a'.repeat(64) ? [{Config:{Labels:{'com.docker.compose.project':'synthetic','com.docker.compose.service':'db'}}}] : state.services));
else if (args[0] === 'exec') { process.stdout.write('PGDMP synthetic dump'); process.exitCode = state.failDump ? 1 : 0; }
else process.exitCode = 1;
`, { mode: 0o700 });
    // Keep the fake executable portable when TMPDIR is outside this package.
    await writeFile(join(bin, 'package.json'), '{"type":"module"}');
    const envFile = join(directory, 'production.env'), key = join(directory, 'key'), replicate = join(directory, 'replicate');
    await writeFile(envFile, `AUTH_SECRET=${authSecret}\nJADER_IMAGE=jader-market:synthetic\nJADER_RUNTIME_DATABASE_URL=${database}\n`, { mode: 0o600 });
    await writeFile(key, randomBytes(32).toString('hex'), { mode: 0o600 });
    await writeFile(replicate, `#!${process.execPath}\nimport { copyFileSync } from 'node:fs';\ncopyFileSync(process.argv[2], ${JSON.stringify(join(directory, 'replicated'))});\n`, { mode: 0o700 });
    const run = async () => {
      await writeFile(stateFile, JSON.stringify(state));
      return command(process.execPath, ['scripts/backup.mjs', 'backup', '--env-file', envFile, '--project', 'synthetic',
        '--key', key, '--directory', archives, '--replicate', replicate], {
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, BACKUP_TEST_STATE: stateFile, BACKUP_TEST_CALLS: calls },
      });
    };
    await test({ state, run, archives, calls, directory, envFile });
  } finally { await rm(directory, { recursive: true, force: true }); }
}

it('publishes and replicates a backup bound to the deployed release', () => fixture(async ({ run, archives, directory }) => {
  await run();
  const marker = JSON.parse(await readFile(join(archives, 'last-success.json'), 'utf8'));
  expect(await readFile(join(archives, marker.archive))).toEqual(await readFile(join(directory, 'replicated')));
  expect(await readdir(archives)).toEqual(expect.arrayContaining([marker.archive, 'last-success.json']));
}));

for (const fault of ['key', 'image', 'worker', 'project', 'missing-app', 'database']) {
  it(`rejects source ${fault} mismatch before dumping or advancing freshness`, () => fixture(async ({ state, run, archives, calls, envFile }) => {
    if (fault === 'key') state.services[0].Config.Env[0] = `AUTH_SECRET=${'e'.repeat(64)}`;
    if (fault === 'image') state.imageId = `sha256:${'e'.repeat(64)}`;
    if (fault === 'worker') state.services[1].Image = `sha256:${'e'.repeat(64)}`;
    if (fault === 'project') state.services[0].Config.Labels['com.docker.compose.project'] = 'other';
    if (fault === 'missing-app') state.services.shift();
    if (fault === 'database') {
      const other = database.replace('@db:', '@external:');
      await writeFile(envFile, (await readFile(envFile, 'utf8')).replace(database, other));
      for (const service of state.services) service.Config.Env[1] = `DATABASE_URL=${other}`;
    }
    await expect(run()).rejects.toThrow();
    expect(await readdir(archives)).toEqual([]);
    expect((await readFile(calls, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line)[0])).not.toContain('exec');
  }));
}

it('joins a failed dump and encryption before cleaning up and allowing a retry', () => fixture(async ({ state, run, archives }) => {
  state.failDump = true;
  await expect(run()).rejects.toThrow();
  expect(await readdir(archives)).toEqual([]);
  state.failDump = false;
  await run();
  expect((await readdir(archives)).some(name => name.endsWith('.partial') || name === '.backup-lock')).toBe(false);
}));
