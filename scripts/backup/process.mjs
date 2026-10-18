import { spawn } from 'node:child_process';
import { pipeline } from 'node:stream/promises';

function start(program, args, { env, input = true, timeoutMs = 1_800_000, killGraceMs = 10_000 }) {
  const group = process.platform !== 'win32';
  const child = spawn(program, args, { env, detached: group, stdio: [input ? 'pipe' : 'ignore', 'pipe', 'ignore'] });
  let closed = false, unavailable = false, timedOut = false, interrupted = false, stopping;
  const finished = new Promise(resolve => {
    child.on('error', () => { unavailable = true; });
    child.once('close', code => { closed = true; resolve(code); });
  });
  const signal = value => {
    if (!child.pid) return;
    try {
      if (group) process.kill(-child.pid, value);
      else if (!closed) child.kill(value);
    } catch (error) { if (error.code !== 'ESRCH') throw new Error('command_cleanup_failed'); }
  };
  const stop = () => stopping ??= (async () => {
    // The leader can exit while descendants still hold stdout open.
    signal('SIGTERM');
    const force = setTimeout(() => signal('SIGKILL'), killGraceMs);
    try { await finished; } finally {
      clearTimeout(force);
      // Independent-stdio descendants must not escape a successful command either.
      if (group) signal('SIGKILL');
    }
  })();
  const interrupt = () => { interrupted = true; void stop(); };
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  const timeout = setTimeout(() => { timedOut = true; void stop(); }, timeoutMs);
  const done = finished.then(code => {
    if (unavailable) throw new Error('command_unavailable');
    if (interrupted) throw new Error('command_interrupted');
    if (timedOut) throw new Error('command_timeout');
    if (code !== 0) throw new Error('command_failed');
  }).finally(async () => {
    clearTimeout(timeout);
    try { await stop(); } finally {
      process.removeListener('SIGINT', interrupt);
      process.removeListener('SIGTERM', interrupt);
    }
  });
  // Streaming callers can encounter an input/encryption error before awaiting done.
  done.catch(() => {});
  return { child, done, stop };
}

// Never forward subprocess output: Docker/Postgres errors may contain secrets.
export async function command(program, args, { env = process.env, input, capture = false, ...limits } = {}) {
  const { child, done, stop } = start(program, args, { env, ...limits });
  let output = '';
  child.stdout.on('data', chunk => { if (capture && output.length < 1024 * 1024) output += chunk.toString(); });
  const writing = input ? pipeline(input, child.stdin) : (child.stdin.end(), Promise.resolve());
  try { await Promise.all([done, writing]); return output; }
  finally {
    await stop();
    await done.catch(() => {});
  }
}
export function dump(args, env, limits = {}) {
  const { child, done, stop } = start('docker', args, { env, input: false, ...limits });
  return { stream: child.stdout, done, cancel: stop };
}
