import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

/** A temp workspace with .faultkit/invariants/manifest.json and the given scenario files. */
export function makeWorkspace(manifest, files = { 'outage.yaml': 'name: outage\n' }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'faultkit-action-'));
  const dir = path.join(root, '.faultkit', 'invariants');
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), content);
  const manifestPath = path.join(dir, 'manifest.json');
  fs.writeFileSync(manifestPath, typeof manifest === 'string' ? manifest : JSON.stringify(manifest, null, 2));
  return { root, dir, manifestPath };
}

/** A generated manifest entry that runs outage.yaml. */
export const entry = (id, extra = {}) => ({
  id,
  invariant: `The ${id} invariant holds.`,
  config: 'outage.yaml',
  gate: ['node', '--test', `test/${id}.test.mjs`],
  ...extra,
});

function tarHeader(name, size, type) {
  const h = Buffer.alloc(512);
  h.write(name, 0, 100, 'utf8');
  h.write('0000755\0', 100);
  h.write('0000000\0', 108);
  h.write('0000000\0', 116);
  h.write(`${size.toString(8).padStart(11, '0')}\0`, 124);
  h.write('00000000000\0', 136);
  h.write(type, 156);
  h.write('ustar\0', 257);
  h.write('00', 263);
  return h;
}

/** An in-memory .tar.gz: [{ name, content = '', type = '0' }]. */
export function makeTarGz(entries) {
  const parts = [];
  for (const { name, content = '', type = '0' } of entries) {
    const data = Buffer.from(content);
    parts.push(tarHeader(name, data.length, type), data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  parts.push(Buffer.alloc(1024));
  return zlib.gzipSync(Buffer.concat(parts));
}
