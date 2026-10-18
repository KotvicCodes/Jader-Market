import { expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { seal } from '../../scripts/backup/archive.mjs';

// Only Docker is substituted. Exercise archive authentication and the real CLI's
// signal handling and cleanup without contacting a database or deployment.
for (const [phase, cleanupFails] of [['create', false], ['readiness', false], ['create', true]]) {
  it(`cancels recovery during ${phase} and ${cleanupFails ? 'preserves private recovery identity when cleanup fails' : 'removes a container already accepted by Docker'}`, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'jader-recovery-cli-'));
    let caller, closed;
    try {
      const bin = join(directory, 'bin'), state = join(directory, 'container'), ready = join(directory, 'ready');
      await mkdir(bin);
      await writeFile(join(bin, 'package.json'), '{"type":"module"}');
      const imageId = `sha256:${'c'.repeat(64)}`;
      await writeFile(join(bin, 'docker'), `#!${process.execPath}
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
const args = process.argv.slice(2), state = process.env.RECOVERY_TEST_STATE;
if (args[0] === 'image') console.log(JSON.stringify([{Id: ${JSON.stringify(imageId)}}]));
else if (args[0] === 'create') {
  writeFileSync(state, args[args.indexOf('--name') + 1]);
  if (process.env.RECOVERY_TEST_PHASE === 'create') stall();
} else if (args[0] === 'start') {}
else if (args[0] === 'exec' && args.includes('pg_isready')) {
  if (!existsSync(process.env.RECOVERY_TEST_READY)) stall();
  else process.exitCode = 1;
} else if (args[0] === 'ps') {
  if (!args.includes('label=jader.recovery=isolated') || !args.includes('name=^/' + readFileSync(state, 'utf8') + '$')) process.exit(1);
  if (existsSync(state)) console.log('a'.repeat(64));
} else if (args[0] === 'rm') {
  if (args.at(-1) !== 'a'.repeat(64)) process.exit(1);
  if (process.env.RECOVERY_TEST_CLEANUP_FAILS === 'true') process.exit(1);
  if (existsSync(state)) unlinkSync(state);
} else process.exitCode = 1;
function stall() {
  process.on('SIGTERM', () => process.exit(0));
  writeFileSync(process.env.RECOVERY_TEST_READY, readFileSync(state));
  setTimeout(() => process.exit(1), 3000);
}
`, { mode: 0o700 });
      const key = randomBytes(32), keyFile = join(directory, 'key'), archive = join(directory, 'archive');
      await writeFile(keyFile, key.toString('hex'), { mode: 0o600 });
      await seal(Readable.from(['PGDMP synthetic']), archive, key, {
        format: 1, authSecret: 'd'.repeat(64), image: 'jader-market:synthetic', imageId, startedAt: new Date().toISOString(),
      });
      const output = join(directory, 'restored');
      caller = spawn(process.execPath, ['scripts/backup.mjs', 'restore', '--archive', archive, '--key', keyFile, '--output', output], {
        stdio: 'ignore', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, RECOVERY_TEST_STATE: state,
          RECOVERY_TEST_READY: ready, RECOVERY_TEST_PHASE: phase, RECOVERY_TEST_CLEANUP_FAILS: String(cleanupFails) },
      });
      closed = once(caller, 'close');
      await expect.poll(async () => {
        try { return (await readFile(ready, 'utf8')).startsWith('jader-recovery-'); }
        catch { return false; }
      }).toBe(true);
      caller.kill('SIGTERM');
      // Readiness errors normally retry for a minute; cancellation must not retry.
      await expect.poll(() => caller.exitCode, { timeout: 2000 }).toBe(1);
      await closed;
      if (cleanupFails) {
        const pending = JSON.parse(await readFile(join(output, 'pending-restore.json'), 'utf8'));
        expect(pending.container).toBe(await readFile(state, 'utf8'));
        expect(await readFile(join(output, 'recovery.env'), 'utf8')).toContain('POSTGRES_PASSWORD=');
        await expect(readFile(join(output, 'authenticated.payload'))).rejects.toThrow();
      } else {
        await expect(readFile(state)).rejects.toThrow();
        await expect(readFile(join(output, 'recovery.env'))).rejects.toThrow();
      }
    } finally {
      caller?.kill('SIGKILL');
      await closed;
      await rm(directory, { recursive: true, force: true });
    }
  });
}
