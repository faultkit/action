// Reads the invariant manifest the faultkit skill keeps in the repository and
// turns it into an InvariantPlan. Future sources (a coding agent, an LLM
// provider, faultkit Cloud) would produce the same plan shape; see
// docs/architecture.md. v1 implements only this one.

import fs from 'node:fs';
import path from 'node:path';

export class ManifestError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ManifestError';
  }
}

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MODES = new Set(['auto', 'proxy', 'ebpf']);
const FAULT_STATUSES = new Set(['generated', 'not_generated']);

const isText = (v) => typeof v === 'string' && v.trim() !== '';
const isArgv = (v) => Array.isArray(v) && v.length > 0 && v.every((a) => typeof a === 'string' && a !== '');
const has = (o, k) => Object.hasOwn(o, k);

function inside(dir, target) {
  const rel = path.relative(dir, target);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

/** Resolve a manifest `config`. It must stay inside the manifest's directory, symlinks included. */
export function resolveConfig(manifestDir, config, where) {
  if (!isText(config) || path.isAbsolute(config)) {
    throw new ManifestError(`${where}: "config" must be a path relative to ${manifestDir}`);
  }
  const resolved = path.resolve(manifestDir, config);
  if (!inside(manifestDir, resolved)) throw new ManifestError(`${where}: "config" points outside ${manifestDir}`);
  let real;
  try {
    real = fs.realpathSync(resolved);
  } catch {
    throw new ManifestError(`${where}: scenario file ${config} does not exist`);
  }
  if (!inside(fs.realpathSync(manifestDir), real)) {
    throw new ManifestError(`${where}: "config" resolves outside ${manifestDir}`);
  }
  return resolved;
}

function options(e, where) {
  const mode = has(e, 'mode') ? e.mode : 'auto';
  if (!MODES.has(mode)) throw new ManifestError(`${where}: "mode" must be one of auto, proxy, ebpf`);
  const baseUrl = has(e, 'base_url') ? e.base_url : false;
  if (typeof baseUrl !== 'boolean') throw new ManifestError(`${where}: "base_url" must be true or false`);
  const provider = has(e, 'provider') ? e.provider : '';
  if (typeof provider !== 'string') throw new ManifestError(`${where}: "provider" must be a string`);
  const shape = has(e, 'shape') ? e.shape : null;
  if (shape !== null && typeof shape !== 'string') throw new ManifestError(`${where}: "shape" must be a string`);
  return { mode, baseUrl, provider, shape };
}

function normalize(e, i, version, manifestPath, seen) {
  const where = `${manifestPath}: invariants[${i}]`;
  if (e === null || typeof e !== 'object' || Array.isArray(e)) throw new ManifestError(`${where}: must be an object`);
  if (typeof e.id !== 'string' || !SLUG.test(e.id)) throw new ManifestError(`${where}: "id" must be a kebab-case slug`);
  if (seen.has(e.id)) throw new ManifestError(`${where}: duplicate id ${e.id}`);
  seen.add(e.id);
  if (!isText(e.invariant)) throw new ManifestError(`${where}: "invariant" must state the invariant`);
  if (version === 1 && has(e, 'fault_status')) throw new ManifestError(`${where}: "fault_status" needs "version": 2`);
  const faultStatus = version === 1 ? 'generated' : e.fault_status;
  if (!FAULT_STATUSES.has(faultStatus)) {
    throw new ManifestError(`${where}: "fault_status" must be "generated" or "not_generated"`);
  }
  const base = { id: e.id, invariant: e.invariant.trim(), faultStatus, ...options(e, where) };

  if (faultStatus === 'not_generated') {
    if (has(e, 'config') || has(e, 'scenario')) {
      throw new ManifestError(`${where}: a not_generated invariant has no "config" or "scenario"`);
    }
    if (!isText(e.fault_reason)) throw new ManifestError(`${where}: "fault_reason" must say why no fault was generated`);
    if (has(e, 'gate') && !isArgv(e.gate)) throw new ManifestError(`${where}: "gate" must be a non-empty list of strings`);
    return { ...base, faultReason: e.fault_reason.trim(), config: null, scenario: null, gate: has(e, 'gate') ? [...e.gate] : null };
  }

  if (has(e, 'config') === has(e, 'scenario')) {
    throw new ManifestError(`${where}: set exactly one of "config" (a scenario file) or "scenario" (a builtin)`);
  }
  if (has(e, 'scenario') && !isText(e.scenario)) throw new ManifestError(`${where}: "scenario" must name a builtin`);
  if (!isArgv(e.gate)) throw new ManifestError(`${where}: "gate" must be the test command as a non-empty list of strings`);
  return {
    ...base,
    faultReason: null,
    config: has(e, 'config') ? resolveConfig(path.dirname(manifestPath), e.config, where) : null,
    scenario: has(e, 'scenario') ? e.scenario : null,
    gate: [...e.gate],
  };
}

/** Parse and validate manifest text. Anything malformed throws, so the run fails closed. */
export function parseManifest(text, manifestPath) {
  let data;
  try {
    data = JSON.parse(text);
  } catch (err) {
    throw new ManifestError(`${manifestPath}: not valid JSON (${err.message})`);
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new ManifestError(`${manifestPath}: expected a JSON object`);
  }
  if (data.version !== 1 && data.version !== 2) {
    throw new ManifestError(`${manifestPath}: unsupported "version" ${JSON.stringify(data.version)}; expected 1 or 2`);
  }
  if (!Array.isArray(data.invariants) || data.invariants.length === 0) {
    throw new ManifestError(`${manifestPath}: "invariants" must be a non-empty list`);
  }
  const seen = new Set();
  return {
    source: 'manifest',
    manifestPath,
    version: data.version,
    invariants: data.invariants.map((e, i) => normalize(e, i, data.version, manifestPath, seen)),
  };
}

/** The v1 scenario source: the manifest in the repository. */
export class ManifestScenarioSource {
  constructor({ manifestPath }) {
    this.manifestPath = manifestPath;
  }

  async discover() {
    let text;
    try {
      text = await fs.promises.readFile(this.manifestPath, 'utf8');
    } catch (err) {
      throw new ManifestError(`cannot read ${this.manifestPath}: ${err.code ?? err.message}`);
    }
    return parseManifest(text, this.manifestPath);
  }
}
