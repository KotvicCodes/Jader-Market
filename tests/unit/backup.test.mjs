import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, writeFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { privatePath, readKey, seal, unseal } from '../../scripts/backup/archive.mjs';

async function fixture(test) {
  const dir = await mkdtemp(join(tmpdir(), 'jader-archive-'));
  try { await test(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}
const metadata = { format: 1, authSecret: 'a'.repeat(64), image: 'jader-market:test', imageId: 'sha256:' + 'b'.repeat(64), startedAt: new Date().toISOString() };
describe('authenticated private backups', () => {
  it('streams encrypted metadata and a binary dump, authenticating before use', () => fixture(async dir => {
    const key = randomBytes(32), path = join(dir, 'archive'), plain = randomBytes(1024 * 1024);
    await seal(Readable.from([plain]), path, key, metadata);
    const encrypted = await readFile(path);
    expect(encrypted.includes(Buffer.from(metadata.authSecret))).toBe(false);
    expect(encrypted.includes(plain)).toBe(false);
    const output = join(dir, 'plain');
    const result = await unseal(path, output, key);
    expect(result.metadata).toEqual(metadata);
    expect((await readFile(output)).subarray(result.offset).equals(plain)).toBe(true);
    await privatePath(path); await privatePath(output);
  }));
  for (const fault of ['key','ciphertext','header','tag','truncated']) it(`rejects ${fault} failure`, () => fixture(async dir => {
    const key = randomBytes(32), path = join(dir, 'archive');
    await seal(Readable.from([Buffer.from('PGDMP synthetic')]), path, key, metadata);
    const contents = await readFile(path);
    if (fault === 'ciphertext') contents[24] ^= 1;
    if (fault === 'header') contents[9] ^= 1;
    if (fault === 'tag') contents[contents.length-1] ^= 1;
    await writeFile(path, fault === 'truncated' ? contents.subarray(0, contents.length-3) : contents);
    await expect(unseal(path, join(dir, 'plain'), fault === 'key' ? randomBytes(32) : key)).rejects.toThrow();
  }));
  it('rejects unsafe permissions, malformed keys and overwrites', () => fixture(async dir => {
    const path = join(dir, 'key');
    await writeFile(path, 'a'.repeat(64), { mode: 0o600 });
    expect(await readKey(path)).toEqual(Buffer.from('a'.repeat(64), 'hex'));
    await chmod(path, 0o644); await expect(readKey(path)).rejects.toThrow();
    await chmod(path, 0o600); await writeFile(path, 'invalid'); await expect(readKey(path)).rejects.toThrow();
    await expect(seal(Readable.from(['x']), path, randomBytes(32), metadata)).rejects.toThrow();
    expect(await readFile(path, 'utf8')).toBe('invalid');
  }));
  it('fails if the dump producer stops partway', () => fixture(async dir => {
    async function* interrupted() { yield Buffer.from('PGDMP'); throw new Error('interrupted'); }
    await expect(seal(Readable.from(interrupted()), join(dir, 'archive'), randomBytes(32), metadata)).rejects.toThrow();
  }));
});
