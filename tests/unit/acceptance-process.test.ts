import { expect, it } from 'vitest';
import { execute } from '../../scripts/acceptance-environment';

it('waits for subprocess stdout to finish before returning', async () => {
  const output=await execute(process.execPath,['-e',"process.stdout.write('x'.repeat(256*1024));"]);
  expect(output.length).toBe(256*1024);
});

it('fails a stalled acceptance subprocess within its configured deadline', async () => {
  await expect(execute(process.execPath,['-e','setInterval(()=>{},1000)'],process.env,undefined,100)).rejects.toThrow('acceptance_subprocess_timeout');
});

it('rejects failed subprocesses without exposing their private output', async () => {
  await expect(execute(process.execPath,['-e',"console.log('synthetic-private-value');process.exitCode=1;"])).rejects.toThrow(/^acceptance_subprocess_failed$/);
});
