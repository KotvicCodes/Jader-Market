import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const magic = Buffer.from('JADERB01');
export async function privatePath(path, directory = false) {
  const stat = await lstat(path);
  if ((directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1) ||
      (stat.mode & 0o077) || stat.uid !== process.getuid()) throw new Error('private_path_required');
  return stat;
}
export async function readKey(path) {
  await privatePath(path);
  const file = await open(path, 'r');
  try {
    const text = (await file.readFile('utf8')).trim();
    if (!/^[a-f0-9]{64}$/.test(text)) throw new Error('invalid_key');
    return Buffer.from(text, 'hex');
  } finally { await file.close(); }
}
// No plaintext dump on the backup path. Header, metadata and dump are bound by GCM.
export async function seal(stream, path, key, metadata) {
  const iv = randomBytes(12), header = Buffer.concat([magic, iv]);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(header);
  const json = Buffer.from(JSON.stringify(metadata)), length = Buffer.alloc(4);
  if (json.length > 65536) throw new Error('metadata_too_large');
  length.writeUInt32BE(json.length);
  const file = await open(path, 'wx', 0o600);
  try {
    await file.write(header);
    async function* payload() { yield length; yield json; yield* stream; }
    await pipeline(Readable.from(payload()), cipher, createWriteStream(path, { fd: file.fd, autoClose: false, start: header.length }));
    await file.write(cipher.getAuthTag(), 0, 16, (await file.stat()).size);
    await file.sync();
  } finally { await file.close(); }
}
// Authenticate ALL bytes before returning anything that can be passed to SQL.
export async function unseal(path, staging, key) {
  const stat = await privatePath(path);
  if (stat.size < 41) throw new Error('invalid_archive');
  const file = await open(path, 'r'), header = Buffer.alloc(20), tag = Buffer.alloc(16);
  try { await file.read(header, 0, 20, 0); await file.read(tag, 0, 16, stat.size - 16); }
  finally { await file.close(); }
  if (!header.subarray(0, 8).equals(magic)) throw new Error('invalid_archive');
  const decipher = createDecipheriv('aes-256-gcm', key, header.subarray(8));
  decipher.setAAD(header); decipher.setAuthTag(tag);
  await pipeline(createReadStream(path, { start: 20, end: stat.size - 17 }), decipher,
    createWriteStream(staging, { flags: 'wx', mode: 0o600 }));
  const plain = await open(staging, 'r');
  try {
    const size = (await plain.stat()).size, length = Buffer.alloc(4);
    await plain.read(length, 0, 4, 0);
    const count = length.readUInt32BE();
    if (!count || count > 65536 || size < count + 9) throw new Error('invalid_metadata');
    const json = Buffer.alloc(count); await plain.read(json, 0, count, 4);
    const metadata = JSON.parse(json.toString());
    if (metadata.format !== 1 || !/^[a-f0-9]{64}$/.test(metadata.authSecret) ||
        !/^sha256:[a-f0-9]{64}$/.test(metadata.imageId ?? '') || typeof metadata.image !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_./:@-]{0,255}$/.test(metadata.image) ||
        !Number.isFinite(Date.parse(metadata.startedAt))) throw new Error('invalid_metadata');
    return { metadata, offset: count + 4 };
  } finally { await plain.close(); }
}
