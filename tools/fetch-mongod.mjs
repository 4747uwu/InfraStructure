// Fetches a portable mongod.exe into .runtime/mongodb/bin without a system install.
//
// The official Windows zip is ~750 MB, almost all of it debug symbols. Rather than
// download the lot, this reads the zip's central directory over HTTP range requests
// and pulls out only mongod.exe (~70 MB compressed).
//
//   node tools/fetch-mongod.mjs            # default version
//   node tools/fetch-mongod.mjs 8.0.13     # specific version

import { createWriteStream, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createInflateRaw } from 'node:zlib';

const version = process.argv[2] || '8.0.15';
const url = `https://fastdl.mongodb.org/windows/mongodb-windows-x86_64-${version}.zip`;
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, '.runtime', 'mongodb', 'bin');
const outFile = join(outDir, 'mongod.exe');

if (existsSync(outFile)) {
  console.log(`mongod already present: ${outFile}`);
  process.exit(0);
}

async function range(start, end) {
  const res = await fetch(url, { headers: { Range: `bytes=${start}-${end}` } });
  if (res.status !== 206) throw new Error(`Range request failed: HTTP ${res.status}`);
  return res;
}

async function rangeBuffer(start, end) {
  return Buffer.from(await (await range(start, end)).arrayBuffer());
}

const head = await fetch(url, { method: 'HEAD' });
if (!head.ok) throw new Error(`Cannot reach ${url}: HTTP ${head.status}`);
const total = Number(head.headers.get('content-length'));

// End-of-central-directory record sits in the last 64 KB.
const tailStart = Math.max(0, total - 65_557);
const tail = await rangeBuffer(tailStart, total - 1);
const eocd = tail.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
if (eocd < 0) throw new Error('Not a zip archive (no end-of-central-directory record)');
const cdSize = tail.readUInt32LE(eocd + 12);
const cdOffset = tail.readUInt32LE(eocd + 16);
if (cdOffset === 0xffffffff) throw new Error('Zip64 archive is not supported by this fetcher');

const cd = await rangeBuffer(cdOffset, cdOffset + cdSize - 1);
let entry = null;
for (let p = 0; p + 46 <= cd.length && cd.readUInt32LE(p) === 0x02014b50; ) {
  const nameLen = cd.readUInt16LE(p + 28);
  const extraLen = cd.readUInt16LE(p + 30);
  const commentLen = cd.readUInt16LE(p + 32);
  const name = cd.toString('utf8', p + 46, p + 46 + nameLen);
  if (name.endsWith('/bin/mongod.exe')) {
    entry = {
      name,
      method: cd.readUInt16LE(p + 10),
      compressedSize: cd.readUInt32LE(p + 20),
      size: cd.readUInt32LE(p + 24),
      localOffset: cd.readUInt32LE(p + 42),
    };
    break;
  }
  p += 46 + nameLen + extraLen + commentLen;
}
if (!entry) throw new Error('mongod.exe not found inside the archive');

// The local header repeats the name/extra lengths, which may differ from the central copy.
const local = await rangeBuffer(entry.localOffset, entry.localOffset + 29);
const dataStart = entry.localOffset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28);

mkdirSync(outDir, { recursive: true });
console.log(`Fetching ${entry.name} (${(entry.compressedSize / 1048576).toFixed(0)} MB of ${(total / 1048576).toFixed(0)} MB archive) ...`);

const body = Readable.fromWeb((await range(dataStart, dataStart + entry.compressedSize - 1)).body);
const part = `${outFile}.part`;
if (entry.method === 8) await pipeline(body, createInflateRaw(), createWriteStream(part));
else if (entry.method === 0) await pipeline(body, createWriteStream(part));
else throw new Error(`Unsupported zip compression method ${entry.method}`);

const { renameSync, statSync } = await import('node:fs');
if (statSync(part).size !== entry.size) throw new Error('Extracted size mismatch - download was incomplete');
renameSync(part, outFile);
console.log(`Done: ${outFile}`);
