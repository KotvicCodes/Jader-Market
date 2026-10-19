import { expect, it } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { command, dump } from '../../scripts/backup/process.mjs';

it('keeps operation cancellation across subprocess boundaries', async () => {
  const controller = new AbortController();
  const active = command(process.execPath, ['-e', `
    process.on('SIGTERM', () => {});
    setTimeout(() => process.exit(0), 1500);
  `], { signal: controller.signal, killGraceMs: 100 });
  const abort = setTimeout(() => controller.abort(), 150);
  try { await expect(active).rejects.toThrow('command_interrupted'); }
  finally { clearTimeout(abort); }
  // A later command must not start just because the original child is gone.
  await expect(command(process.execPath, ['-e', 'process.exit(0)'], { signal: controller.signal })).rejects.toThrow('command_interrupted');
});

it('rejects a timed-out command even if it handles SIGTERM and exits successfully', async () => {
  await expect(command(process.execPath, ['-e', `
    process.on('SIGTERM', () => process.exit(0));
    setTimeout(() => process.exit(0), 1500);
  `], { timeoutMs: 150, killGraceMs: 100 })).rejects.toThrow('command_timeout');
});

it('force-stops a command that ignores SIGTERM within the termination grace', async () => {
  const started = performance.now();
  await expect(command(process.execPath, ['-e', `
    process.on('SIGTERM', () => {});
    setTimeout(() => process.exit(0), 1500);
  `], { timeoutMs: 150, killGraceMs: 100 })).rejects.toThrow('command_timeout');
  expect(performance.now() - started).toBeLessThan(1200);
});

it.skipIf(process.platform === 'win32')('bounds descendants holding stdout after the command leader exits', async () => {
  const started = performance.now();
  await expect(command(process.execPath, ['-e', `
    const { spawn } = require('node:child_process');
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 1500)'], { stdio: ['ignore', 1, 'ignore'] });
    child.unref();
  `], { timeoutMs: 150, killGraceMs: 100 })).rejects.toThrow('command_timeout');
  expect(performance.now() - started).toBeLessThan(1200);
});

it.skipIf(process.platform === 'win32')('removes background descendants after successful commands', async () => {
  let pid;
  try {
    const result = await command(process.execPath, ['-e', `
      const { spawn } = require('node:child_process');
      const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 1500)'], { stdio: 'ignore' });
      console.log(child.pid);
      child.unref();
    `], { capture: true });
    pid = Number(result.trim());
    await expect.poll(() => {
      try { return execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).trim(); }
      catch { return ''; }
    }).toMatch(/^(?:Z.*)?$/);
  } finally {
    if (pid) { try { process.kill(pid, 'SIGKILL'); } catch { /* Already stopped. */ } }
  }
});

it.skipIf(process.platform === 'win32')('enforces the same deadline on streaming dumps', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'jader-dump-process-'));
  let source;
  try {
    // Substitute only the executable; exercise the actual dump stream/lifecycle.
    await symlink(process.execPath, join(directory, 'docker'));
    source = dump(['-e', `
      process.on('SIGTERM', () => {});
      process.stdout.write('PGDMP synthetic');
      setTimeout(() => process.exit(0), 1500);
    `], { ...process.env, PATH: directory }, { timeoutMs: 150, killGraceMs: 100 });
    source.stream.resume();
    await expect(source.done).rejects.toThrow('command_timeout');
  } finally {
    await source?.cancel();
    await rm(directory, { recursive: true, force: true });
  }
});

it.skipIf(process.platform === 'win32')('joins its owned process group when the caller is interrupted', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'jader-backup-interrupt-'));
  const pidFile = join(directory, 'pid');
  const helper = new URL('../../scripts/backup/process.mjs', import.meta.url).href;
  const program = `
    import { command } from ${JSON.stringify(helper)};
    try {
      await command(process.execPath, ['-e', ${JSON.stringify("require('node:fs').writeFileSync(process.argv[1], String(process.pid));setTimeout(() => {}, 1500)")}, ${JSON.stringify(pidFile)}]);
    } catch { process.exitCode = 1; }
  `;
  const caller = spawn(process.execPath, ['--input-type=module', '-e', program], { stdio: 'ignore' });
  const closed = once(caller, 'close');
  let pid;
  try {
    await expect.poll(async () => {
      try { pid = Number(await readFile(pidFile, 'utf8')); return pid > 0; }
      catch { return false; }
    }).toBe(true);
    caller.kill('SIGTERM');
    expect(await closed).toEqual([1, null]);
    expect(() => process.kill(pid, 0)).toThrow();
  } finally {
    caller.kill('SIGKILL');
    if (pid) { try { process.kill(pid, 'SIGKILL'); } catch { /* Already stopped. */ } }
    await closed;
    await rm(directory, { recursive: true, force: true });
  }
});
