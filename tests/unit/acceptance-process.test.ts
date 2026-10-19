import { expect, it } from 'vitest';
import { setTimeout as delay } from 'node:timers/promises';
import { execFileSync } from 'node:child_process';
import { execute } from '../../scripts/acceptance-environment';

it('waits for subprocess stdout to finish before returning', async () => {
  const output=await execute(process.execPath,['-e',"process.stdout.write('x'.repeat(256*1024));"]);
  expect(output.length).toBe(256*1024);
});

it.skipIf(process.platform === 'win32')('removes background descendants when a command finishes normally', async () => {
  let descendant: number | undefined;
  try {
    const output = await execute(process.execPath, ['-e', `
      const { spawn } = require('node:child_process');
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
      console.log(child.pid);
      child.unref();
    `]);
    descendant = Number(output.trim());
    const active = () => {
      try { return !execFileSync('ps', ['-o', 'stat=', '-p', String(descendant)], { encoding: 'utf8' }).trim().startsWith('Z'); }
      catch { return false; }
    };
    await expect.poll(active, { timeout: 1000 }).toBe(false);
  } finally {
    if (descendant) { try { process.kill(descendant, 'SIGKILL'); } catch { /* Already stopped. */ } }
  }
});

it('fails a stalled acceptance subprocess within its configured deadline', async () => {
  await expect(execute(process.execPath,['-e','setInterval(()=>{},1000)'],process.env,undefined,100)).rejects.toThrow('acceptance_subprocess_timeout');
});

it('rejects failed subprocesses without exposing their private output', async () => {
  await expect(execute(process.execPath,['-e',"console.log('synthetic-private-value');process.exitCode=1;"])).rejects.toThrow(/^acceptance_subprocess_failed$/);
});

it.skipIf(process.platform === 'win32')('times out descendants holding stdout after the group leader exits', async () => {
  let descendant: number | undefined;
  const command = execute(process.execPath, ['-e', `
    const { spawn } = require('node:child_process');
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: ['ignore', 1, 'ignore'] });
    console.log(child.pid);
    child.unref();
  `], process.env, output => { descendant = Number(output.trim()); }, 500);
  const deadline = new AbortController();
  try {
    await expect(Promise.race([
      command,
      delay(2500, undefined, { signal: deadline.signal }).then(() => { throw new Error('descendant_outlived_deadline'); }),
    ])).rejects.toThrow(/^acceptance_subprocess_timeout$/);
  } finally {
    deadline.abort();
    if (descendant) { try { process.kill(descendant, 'SIGKILL'); } catch { /* Already stopped. */ } }
    await command.catch(() => {});
  }
});
