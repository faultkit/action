// Runs the action: reads the inputs, runs the pipeline, and reports through
// the log, the job summary, the step outputs, the optional PR comment, and
// the exit code. It is the only module that reads the process environment.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveFaultkit } from './binary.js';
import { GitHubApiError, pullRequestNumber, upsertComment } from './github.js';
import { ManifestScenarioSource, inside } from './manifest.js';
import { COMMENT_LIMIT, MARKER, SUMMARY_LIMIT, consoleTable, outcomesTable, reportMarkdown } from './markdown.js';
import { coverage, errorSummary, parseThreshold, summarize } from './results.js';
import { runInvariant } from './runner.js';
import { ValuesError, checkOutcomes, loadValues, resolveValuesPath } from './values.js';

export function readInputs(env) {
  const input = (name) => (env[`INPUT_${name.toUpperCase()}`] ?? '').trim();
  return {
    manifest: input('manifest') || '.faultkit/invariants/manifest.json',
    threshold: input('threshold'),
    token: input('github-token'),
    faultkitPath: input('faultkit-path'),
    values: input('values'),
    requireValues: input('require-values'),
    failOnUncovered: input('fail-on-uncovered'),
    workingDirectory: input('working-directory'),
  };
}

/**
 * The project root: `working-directory` resolved against the repository root,
 * which must contain it, symlinks included. The gates run there, and the
 * other inputs' relative paths start there.
 */
export function resolveWorkingDirectory(repo, input) {
  const root = path.resolve(repo);
  const dir = path.resolve(root, input || '.');
  if (dir === root) return root;
  const real = fs.existsSync(dir) ? fs.realpathSync(dir) : null;
  if (!inside(root, dir) || (real && !inside(fs.realpathSync(root), real))) {
    throw new RangeError(`working-directory ${input} must stay inside the repository`);
  }
  if (!real || !fs.statSync(real).isDirectory()) throw new RangeError(`working-directory ${input} is not a directory`);
  return dir;
}

/** A boolean input, as GitHub spells it: true or false, in any case. Empty is false. */
export function parseBoolean(name, raw) {
  if (raw === '') return false;
  if (!/^(true|false)$/i.test(raw)) throw new RangeError(`${name} must be true or false, got "${raw}"`);
  return raw.toLowerCase() === 'true';
}

// Workflow command escaping, as in @actions/core.
const escapeCommand = (s) => String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
const warning = (log, message) => log(`::warning::${escapeCommand(message)}`);
const error = (log, message) => log(`::error::${escapeCommand(message)}`);

function verdictLine(s) {
  const coverage = s.total ? `${s.proven}/${s.total} proven (${s.score}%)` : 'nothing ran';
  return `faultkit: ${s.result}: ${coverage}${s.threshold === null ? '' : `, threshold ${s.threshold}%`}`;
}

function readEvent(file) {
  try {
    return file ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
  } catch {
    return null;
  }
}

async function postComment(env, inputs, body, fetchImpl, log) {
  if (!inputs.token) return log('faultkit: no github-token, so no PR comment');
  const prNumber = pullRequestNumber(readEvent(env.GITHUB_EVENT_PATH));
  if (!prNumber) return log('faultkit: not a pull request, so no PR comment');
  try {
    const how = await upsertComment({
      token: inputs.token, repository: env.GITHUB_REPOSITORY, prNumber, body, marker: MARKER,
      apiUrl: env.GITHUB_API_URL || 'https://api.github.com', fetchImpl,
    });
    log(`faultkit: ${how} the PR comment`);
  } catch (err) {
    // Only our own API errors are safe to print: a fetch error can quote the Authorization header.
    const reason = err instanceof GitHubApiError ? err.message : 'the GitHub API request failed';
    warning(log, `could not post the faultkit PR comment (${reason}); the verdict is unchanged. A fork PR's token is read-only; the job summary has the full report.`);
  }
}

export async function main(env = process.env, { fetchImpl = fetch, log = console.log } = {}) {
  const inputs = readInputs(env);
  const repo = path.resolve(env.GITHUB_WORKSPACE || process.cwd());
  let workspace = repo;
  let reportsDir = path.join(repo, '.faultkit', 'reports');
  let threshold = null;
  const rows = [];
  let summary;
  let cov = null;
  try {
    workspace = resolveWorkingDirectory(repo, inputs.workingDirectory);
    reportsDir = path.join(workspace, '.faultkit', 'reports');
    threshold = parseThreshold(inputs.threshold);
    const requireValues = parseBoolean('require-values', inputs.requireValues);
    const failOnUncovered = parseBoolean('fail-on-uncovered', inputs.failOnUncovered);
    const plan = await new ManifestScenarioSource({ manifestPath: path.resolve(workspace, inputs.manifest) }).discover();
    // Values and outcome links are checked before anything runs.
    const valuesFile = resolveValuesPath({ workspace, input: inputs.values, manifestValues: plan.values });
    const valuesName = path.relative(workspace, valuesFile.file);
    if (!valuesFile.exists && requireValues) throw new ValuesError(`values file ${valuesName} not found, and require-values is set`);
    const values = valuesFile.exists ? loadValues(valuesFile.file, valuesName) : null;
    checkOutcomes(plan.invariants, values, valuesName);
    const binary = plan.invariants.some((inv) => inv.faultStatus === 'generated')
      ? await resolveFaultkit({
        faultkitPath: inputs.faultkitPath ? path.resolve(workspace, inputs.faultkitPath) : '',
        toolDir: env.RUNNER_TEMP || os.tmpdir(),
        fetchImpl,
        log,
      })
      : null;
    for (const inv of plan.invariants) {
      if (inv.faultStatus === 'generated') log(`\n=== invariant: ${inv.id} ===\n${inv.invariant}`);
      rows.push(await runInvariant({ binary, inv, reportsDir, cwd: workspace, env }));
    }
    cov = values ? coverage(values, rows) : null;
    summary = summarize(rows, threshold, { uncovered: cov?.uncovered ?? 0, failOnUncovered });
  } catch (err) {
    summary = errorSummary(err.message, threshold);
  }

  if (rows.length) log(`\n${consoleTable(rows)}\n`);
  if (cov) log(`${outcomesTable(cov)}\n`);
  const verdict = verdictLine(summary);
  if (summary.result === 'passed') log(verdict);
  else error(log, summary.message ? `${verdict}: ${summary.message}` : verdict);

  const runUrl = env.GITHUB_SERVER_URL && env.GITHUB_REPOSITORY && env.GITHUB_RUN_ID
    ? `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`
    : null;
  if (env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(env.GITHUB_STEP_SUMMARY, `${reportMarkdown(summary, rows, { runUrl, limit: SUMMARY_LIMIT, coverage: cov })}\n`);
  }
  if (env.GITHUB_OUTPUT) {
    const outputs = {
      result: summary.result, score: summary.score, threshold: summary.threshold ?? '', total: summary.total,
      proven: summary.proven, failed: summary.failed, invalid: summary.invalid,
      'not-generated': summary.notGenerated, 'reports-directory': path.relative(repo, reportsDir),
      outcomes: cov?.declared ?? 0, covered: cov?.covered ?? 0, uncovered: cov?.uncovered ?? 0,
    };
    fs.appendFileSync(env.GITHUB_OUTPUT, Object.entries(outputs).map(([k, v]) => `${k}=${v}\n`).join(''));
  }
  await postComment(env, inputs, reportMarkdown(summary, rows, { runUrl, limit: COMMENT_LIMIT, coverage: cov }), fetchImpl, log);
  return summary.result === 'passed' ? 0 : 1;
}
