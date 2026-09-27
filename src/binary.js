// Obtains the one faultkit release this action version pins, and trusts it
// only when its sha256 matches the value embedded below. Those values come
// from the release's checksums.txt after `cosign verify-blob` against the
// release signer; see README, "Updating the pinned faultkit".

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

export const FAULTKIT_VERSION = 'v0.1.3';
export const RELEASES_URL = 'https://github.com/faultkit/faultkit/releases/download';
export const ASSETS = Object.freeze({
  'linux-amd64': { file: 'faultkit_0.1.3_linux_amd64.tar.gz', sha256: 'ad5bb35124446df22668a3a6c786da4861e401e3e7b90d48cfb690334f234331' },
  'linux-arm64': { file: 'faultkit_0.1.3_linux_arm64.tar.gz', sha256: 'ddc81856c3671b38bd273ad5226b4fbfcbeb9a4bc4d4614c5b883db2301e1016' },
  'darwin-amd64': { file: 'faultkit_0.1.3_darwin_amd64.tar.gz', sha256: 'a88be35adbc57fabd7532de8e98bfc2a250b5c7767ed6b45aadb6985bd737d6c' },
  'darwin-arm64': { file: 'faultkit_0.1.3_darwin_arm64.tar.gz', sha256: 'b1843a150aa13ba2427b75d2873373b14152b925faef746668ff298c6f93a4a6' },
});

export class BinaryError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BinaryError';
  }
}

/** The runner as a release key. Windows and other CPUs are unsupported. */
export function platformKey(platform = process.platform, arch = process.arch) {
  const os = { linux: 'linux', darwin: 'darwin' }[platform];
  const cpu = { x64: 'amd64', arm64: 'arm64' }[arch];
  if (!os || !cpu) {
    throw new BinaryError(`unsupported platform ${platform}/${arch}: faultkit releases cover Linux and macOS on amd64 and arm64`);
  }
  return `${os}-${cpu}`;
}

export function releaseUrl(asset) {
  return `${RELEASES_URL}/${FAULTKIT_VERSION}/${asset.file}`;
}

export function verifySha256(archive, expected) {
  const actual = crypto.createHash('sha256').update(archive).digest('hex');
  if (actual !== expected) {
    throw new BinaryError(`sha256 mismatch for the faultkit archive: expected ${expected}, got ${actual}`);
  }
}

function field(header, start, length) {
  const bytes = header.subarray(start, start + length);
  const end = bytes.indexOf(0);
  return bytes.subarray(0, end === -1 ? length : end).toString('utf8');
}

/** The regular file named `faultkit` at the root of a .tar.gz, and nothing else. */
export function extractFaultkit(archive) {
  let tar;
  try {
    tar = zlib.gunzipSync(archive);
  } catch (err) {
    throw new BinaryError(`the faultkit archive is not gzip (${err.message})`);
  }
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) break;
    // The ustar prefix field only exists in POSIX ustar headers ("ustar\0").
    const posix = header.subarray(257, 263).toString('latin1') === 'ustar\0';
    const prefix = posix ? field(header, 345, 155) : '';
    const name = prefix ? `${prefix}/${field(header, 0, 100)}` : field(header, 0, 100);
    const size = Number.parseInt(field(header, 124, 12).trim() || '0', 8);
    if (!Number.isSafeInteger(size) || size < 0) throw new BinaryError('the faultkit archive has a corrupt header');
    const type = String.fromCharCode(header[156]);
    const start = offset + 512;
    if (name === 'faultkit' && (type === '0' || type === '\0')) {
      if (start + size > tar.length) throw new BinaryError('the faultkit archive is truncated');
      return Buffer.from(tar.subarray(start, start + size));
    }
    offset = start + Math.ceil(size / 512) * 512;
  }
  throw new BinaryError('the faultkit archive has no faultkit binary at its root');
}

async function download(url, fetchImpl) {
  let res;
  try {
    res = await fetchImpl(url, { redirect: 'follow' });
  } catch (err) {
    throw new BinaryError(`could not download ${url} (${err.message})`);
  }
  if (!res.ok) throw new BinaryError(`could not download ${url}: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/**
 * The faultkit binary to run: `faultkitPath` as given (no download, no
 * fallback), or the pinned release, verified and unpacked into `toolDir`.
 */
export async function resolveFaultkit({ faultkitPath, toolDir, fetchImpl = fetch, platform, arch, assets = ASSETS, log = () => {} }) {
  if (faultkitPath) {
    let stat;
    try {
      stat = fs.statSync(faultkitPath);
      fs.accessSync(faultkitPath, fs.constants.X_OK);
    } catch {
      throw new BinaryError(`faultkit-path ${faultkitPath} is not an executable file`);
    }
    if (!stat.isFile()) throw new BinaryError(`faultkit-path ${faultkitPath} is not an executable file`);
    log(`faultkit: using ${faultkitPath} (faultkit-path)`);
    return faultkitPath;
  }
  const key = platformKey(platform, arch);
  const asset = assets[key];
  const url = releaseUrl(asset);
  log(`faultkit: downloading ${FAULTKIT_VERSION} for ${key}`);
  const archive = await download(url, fetchImpl);
  verifySha256(archive, asset.sha256);
  const binary = extractFaultkit(archive);
  const dir = path.join(toolDir, `faultkit-${FAULTKIT_VERSION}-${key}`);
  await fs.promises.mkdir(dir, { recursive: true });
  const target = path.join(dir, 'faultkit');
  await fs.promises.writeFile(target, binary, { mode: 0o755 });
  await fs.promises.chmod(target, 0o755);
  log(`faultkit: ${FAULTKIT_VERSION} verified (sha256 ${asset.sha256})`);
  return target;
}
