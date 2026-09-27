// Runs one invariant under faultkit the way run_faultkit.py does, and turns
// the outcome into a proof-table row. Commands are argv arrays; no shell.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { EXIT_FAULT_NOT_FIRED, EXIT_OK, EXIT_TARGET_FAILED, NOT_GENERATED, proofState } from './results.js';

export const REPORT_SCHEMA = 'faultkit.dev/report/v1';

// Workflow command files belong to this step, not to the code under test.
const STEP_FILES = new Set(['GITHUB_OUTPUT', 'GITHUB_STEP_SUMMARY', 'GITHUB_STATE', 'GITHUB_ENV', 'GITHUB_PATH']);

/** faultkit's arguments for one invariant, in run_faultkit.py's order. */
export function faultkitArgs(inv, reportPath) {
  const args = ['run'];
  if (inv.config) args.push('--config', inv.config);
  else args.push('--scenario', inv.scenario);
  args.push('--report', reportPath, '--mode', inv.mode);
  if (inv.baseUrl) args.push('--base-url');
  if (inv.provider) args.push('--provider', inv.provider);
  return [...args, '--', ...inv.gate];
}

/**
 * The environment faultkit and the gate see: the runner's, minus the action's
 * inputs (the github-token among them), the runner's ACTIONS_* tokens, and
 * this step's workflow files. The gate is repository code, and on a pull
 * request it is the PR author's code.
 */
export function childEnv(env) {
  const out = {};
  for (const [key, value] of Object.entries(env)) {
    if (key.startsWith('INPUT_') || key.startsWith('ACTIONS_') || STEP_FILES.has(key)) continue;
    out[key] = value;
  }
  return out;
}

/** Faults fired, from a report/v1 document. Throws when the text is not one. */
export function firedFrom(text) {
  const report = JSON.parse(text);
  if (report === null || typeof report !== 'object' || report.schema !== REPORT_SCHEMA) {
    throw new Error(`not a ${REPORT_SCHEMA} document`);
  }
  const events = report.events ?? [];
  if (!Array.isArray(events)) throw new Error('"events" is not a list');
  return events.filter((e) => e !== null && typeof e === 'object' && e.fired === true).length;
}

function exec(binary, args, options) {
  return new Promise((resolve) => {
    const child = spawn(binary, args, { ...options, shell: false, stdio: 'inherit' });
    child.once('error', (error) => resolve({ code: null, signal: null, error }));
    child.once('close', (code, signal) => resolve({ code, signal, error: null }));
  });
}

/** Run one invariant and return its proof-table row. */
export async function runInvariant({ binary, inv, reportsDir, cwd, env }) {
  const row = { id: inv.id, invariant: inv.invariant, faultStatus: inv.faultStatus, reason: inv.faultReason, fired: null, exit: null };
  if (inv.faultStatus !== 'generated') return { ...row, state: NOT_GENERATED };

  const report = path.join(reportsDir, `${inv.id}.report.json`);
  await fs.promises.mkdir(reportsDir, { recursive: true });
  // A report left by an earlier run must never stand in for this one.
  await fs.promises.rm(report, { force: true });

  const run = await exec(binary, faultkitArgs(inv, report), { cwd, env: childEnv(env) });
  if (run.error) return { ...row, state: `error: could not start faultkit (${run.error.code ?? run.error.message})` };
  if (run.code === null) return { ...row, state: `error: faultkit was stopped by ${run.signal}` };
  if (![EXIT_OK, EXIT_TARGET_FAILED, EXIT_FAULT_NOT_FIRED].includes(run.code)) {
    return { ...row, exit: run.code, state: proofState(run.code, 0) };
  }
  let fired;
  try {
    fired = firedFrom(await fs.promises.readFile(report, 'utf8'));
  } catch {
    return { ...row, exit: run.code, state: 'error: report missing or malformed' };
  }
  return { ...row, fired, exit: run.code, state: proofState(run.code, fired) };
}
