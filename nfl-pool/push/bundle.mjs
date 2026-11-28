// Builds the Neon Function artifact: dist/index.mjs (one ESM file, pg and web-push bundled) and dist/poolalerts.zip
// (that file stored at the zip root, deterministic: fixed timestamp, no compression), then prints both SHA-256 digests.
// The same commit always produces the same zip, so the deployed artifact can be matched to a reviewed commit.
import {build} from 'esbuild';
import {createHash} from 'node:crypto';
import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';

const here = new URL('./', import.meta.url);
const dist = new URL('./dist/', here);
mkdirSync(dist, {recursive: true});

await build({
  entryPoints: [new URL('./index.mjs', here).pathname],
  outfile: new URL('./index.mjs', dist).pathname,
  bundle: true, platform: 'node', target: 'node22', format: 'esm', legalComments: 'none', logLevel: 'warning',
  // pg's optional native binding is never used.
  external: ['pg-native'],
  banner: {js: "import{createRequire as ___cr}from'module';import{fileURLToPath as ___f}from'url';import{dirname as ___d}from'path';const require=___cr(import.meta.url);const __filename=___f(import.meta.url);const __dirname=___d(__filename);"}
});

const CRC_TABLE = Array.from({length: 256}, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = buf => { let c = 0xffffffff; for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };

function zipOne(name, data) {
  const fileName = Buffer.from(name), crc = crc32(data), time = 0, date = (2026 - 1980) << 9 | 1 << 5 | 1;
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0, 6); local.writeUInt16LE(0, 8);
  local.writeUInt16LE(time, 10); local.writeUInt16LE(date, 12); local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(fileName.length, 26); local.writeUInt16LE(0, 28);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0, 8);
  central.writeUInt16LE(0, 10); central.writeUInt16LE(time, 12); central.writeUInt16LE(date, 14); central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(fileName.length, 28);
  central.writeUInt16LE(0, 30); central.writeUInt16LE(0, 32); central.writeUInt16LE(0, 34); central.writeUInt16LE(0, 36);
  central.writeUInt32LE(0o100644 << 16 >>> 0, 38); central.writeUInt32LE(0, 42);
  const localSize = local.length + fileName.length + data.length, centralSize = central.length + fileName.length;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(0, 4); end.writeUInt16LE(0, 6); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10);
  end.writeUInt32LE(centralSize, 12); end.writeUInt32LE(localSize, 16); end.writeUInt16LE(0, 20);
  return Buffer.concat([local, fileName, data, central, fileName, end]);
}

const bundle = readFileSync(new URL('./index.mjs', dist));
const zip = zipOne('index.mjs', bundle);
writeFileSync(new URL('./poolalerts.zip', dist), zip);
const sha = b => createHash('sha256').update(b).digest('hex');
console.log(`dist/index.mjs      ${bundle.length} bytes  sha256 ${sha(bundle)}`);
console.log(`dist/poolalerts.zip ${zip.length} bytes  sha256 ${sha(zip)}`);
