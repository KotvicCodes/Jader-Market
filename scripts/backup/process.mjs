import { spawn } from 'node:child_process';
import { pipeline } from 'node:stream/promises';

// Never forward subprocess output: Docker/Postgres errors may contain secrets.
export function command(command, args, { env = process.env, input, capture = false } = {}) {
  const child = spawn(command, args, { env, stdio: ['pipe', 'pipe', 'ignore'], timeout: 1_800_000 });
  let output = '';
  child.stdout.on('data', chunk => { if (capture && output.length < 1024 * 1024) output += chunk.toString(); });
  const done = new Promise((resolve, reject) => {
    child.on('error', () => reject(new Error('command_unavailable')));
    child.on('close', code => code === 0 ? resolve(output) : reject(new Error('command_failed')));
  });
  const writing = input ? pipeline(input, child.stdin) : (child.stdin.end(), Promise.resolve());
  return Promise.all([done, writing]).then(([result]) => result);
}
export function dump(args, env) {
  const child = spawn('docker', args, { env, stdio: ['ignore', 'pipe', 'ignore'], timeout: 1_800_000 });
  const done = new Promise((resolve, reject) => {
    child.on('error', () => reject(new Error('dump_unavailable')));
    child.on('close', code => code === 0 ? resolve() : reject(new Error('dump_failed')));
  });
  // Attach immediately; caller also awaits the original rejected promise.
  done.catch(() => {});
  return { stream: child.stdout, done, cancel: () => child.kill('SIGTERM') };
}
