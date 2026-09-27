import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  ASSETS, BinaryError, extractFaultkit, platformKey, releaseUrl, resolveFaultkit, verifySha256,
} from '../src/binary.js';
import { makeTarGz } from './helpers.js';

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'faultkit-binary-'));
function serve(body, status = 200) {
  const calls = [];
  return { calls, fetchImpl: async (url) => { calls.push(url); return new Response(body, { status }); } };
}

test('every supported runner maps to a pinned release asset', () => {
  const cases = [['linux', 'x64', 'linux-amd64'], ['linux', 'arm64', 'linux-arm64'], ['darwin', 'x64', 'darwin-amd64'], ['darwin', 'arm64', 'darwin-arm64']];
  for (const [platform, arch, key] of cases) {
    assert.equal(platformKey(platform, arch), key);
    assert.equal(ASSETS[key].file, `faultkit_0.1.3_${key.replace('-', '_')}.tar.gz`);
    assert.match(ASSETS[key].sha256, /^[0-9a-f]{64}$/);
  }
});

test('other platforms are refused clearly', () => {
  for (const [platform, arch] of [['win32', 'x64'], ['linux', 'ia32'], ['freebsd', 'x64']]) {
    assert.throws(() => platformKey(platform, arch), /unsupported platform/);
  }
});

test('the release URL is fixed to the pinned version, never latest', () => {
  const url = releaseUrl(ASSETS['linux-amd64']);
  assert.equal(url, 'https://github.com/faultkit/faultkit/releases/download/v0.1.3/faultkit_0.1.3_linux_amd64.tar.gz');
  assert.ok(!url.includes('latest'));
});

test('the sha256 must match exactly', () => {
  const buf = Buffer.from('archive');
  verifySha256(buf, sha256(buf));
  assert.throws(() => verifySha256(Buffer.from('tampered'), sha256(buf)), /sha256 mismatch/);
});

test('only the root faultkit regular file is extracted', () => {
  const archive = makeTarGz([{ name: 'LICENSE', content: 'apache' }, { name: 'faultkit', content: 'BINARY' }]);
  assert.equal(extractFaultkit(archive).toString(), 'BINARY');
  const refused = [
    ['nested path', [{ name: 'bin/faultkit', content: 'x' }]],
    ['traversal', [{ name: '../faultkit', content: 'x' }]],
    ['symlink', [{ name: 'faultkit', type: '2' }]],
    ['missing', [{ name: 'README.md', content: 'x' }]],
  ];
  for (const [name, entries] of refused) assert.throws(() => extractFaultkit(makeTarGz(entries)), BinaryError, name);
  assert.throws(() => extractFaultkit(Buffer.from('not gzip')), /not gzip/);
});

test('a downloaded archive is verified, unpacked, and made executable', async () => {
  const archive = makeTarGz([{ name: 'faultkit', content: '#!/bin/sh\necho faultkit\n' }]);
  const assets = { 'linux-amd64': { file: 'faultkit_0.1.3_linux_amd64.tar.gz', sha256: sha256(archive) } };
  const { fetchImpl, calls } = serve(archive);
  const binary = await resolveFaultkit({ toolDir: tmp(), fetchImpl, platform: 'linux', arch: 'x64', assets });
  assert.deepEqual(calls, [releaseUrl(assets['linux-amd64'])]);
  assert.equal(fs.readFileSync(binary, 'utf8'), '#!/bin/sh\necho faultkit\n');
  assert.equal(fs.statSync(binary).mode & 0o777, 0o755);
});

test('a tampered archive is rejected before anything is written', async () => {
  const toolDir = tmp();
  const { fetchImpl } = serve(makeTarGz([{ name: 'faultkit', content: 'evil' }]));
  await assert.rejects(resolveFaultkit({ toolDir, fetchImpl, platform: 'linux', arch: 'x64' }), /sha256 mismatch/);
  assert.deepEqual(fs.readdirSync(toolDir), []);
});

test('a failed download is an error', async () => {
  const { fetchImpl } = serve('not found', 404);
  await assert.rejects(resolveFaultkit({ toolDir: tmp(), fetchImpl, platform: 'darwin', arch: 'arm64' }), /HTTP 404/);
});

test('faultkit-path skips the download and must be an executable file', async () => {
  const dir = tmp();
  const exe = path.join(dir, 'faultkit');
  fs.writeFileSync(exe, '#!/bin/sh\n', { mode: 0o755 });
  const { fetchImpl, calls } = serve('unused');
  assert.equal(await resolveFaultkit({ faultkitPath: exe, toolDir: dir, fetchImpl }), exe);
  assert.deepEqual(calls, []);
  const plain = path.join(dir, 'plain');
  fs.writeFileSync(plain, 'x', { mode: 0o644 });
  await assert.rejects(resolveFaultkit({ faultkitPath: plain, toolDir: dir, fetchImpl }), /not an executable file/);
  await assert.rejects(resolveFaultkit({ faultkitPath: dir, toolDir: dir, fetchImpl }), /not an executable file/);
});
