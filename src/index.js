// Entry point: reads the inputs, runs the pipeline, and reports through the
// log, the job summary, the step outputs, the optional PR comment, and the
// exit code. It is the only module that reads the process environment.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveFaultkit } from './binary.js';
import { pullRequestNumber, upsertComment } from './github.js';
import { ManifestScenarioSource } from './manifest.js';
import { COMMENT_LIMIT, MARKER, SUMMARY_LIMIT, consoleTable, reportMarkdown } from './markdown.js';
import { errorSummary, parseThreshold, summarize } from './results.js';
import { runInvariant } from './runner.js';

export function readInputs(env) {
  const input = (name) => (env[`INPUT_${name.toUpperCase()}`] ?? '').trim();
  return {
    manifest: input('manifest') || '.faultkit/invariants/manifest.json',
    threshold: input('threshold'),
    token: input('github-token'),
    faultkitPath: input('faultkit-path'),
  };
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
    warning(log, `could not post the faultkit PR comment (${err.message}); the verdict is unchanged. A fork PR's token is read-only; the job summary has the full report.`);
  }
}

export async function main(env = process.env, { fetchImpl = fetch, log = console.log } = {}) {
  const inputs = readInputs(env);
  const workspace = env.GITHUB_WORKSPACE || process.cwd();
  const reportsDir = path.join(workspace, '.faultkit', 'reports');
  let threshold = null;
  const rows = [];
  let summary;
  try {
    threshold = parseThreshold(inputs.threshold);
    const plan = await new ManifestScenarioSource({ manifestPath: path.resolve(workspace, inputs.manifest) }).discover();
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
    summary = summarize(rows, threshold);
  } catch (err) {
    summary = errorSummary(err.message, threshold);
  }

  if (rows.length) log(`\n${consoleTable(rows)}\n`);
  const verdict = verdictLine(summary);
  if (summary.result === 'passed') log(verdict);
  else error(log, summary.message ? `${verdict}: ${summary.message}` : verdict);

  const runUrl = env.GITHUB_SERVER_URL && env.GITHUB_REPOSITORY && env.GITHUB_RUN_ID
    ? `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`
    : null;
  if (env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(env.GITHUB_STEP_SUMMARY, `${reportMarkdown(summary, rows, { runUrl, limit: SUMMARY_LIMIT })}\n`);
  }
  if (env.GITHUB_OUTPUT) {
    const outputs = {
      result: summary.result, score: summary.score, threshold: summary.threshold ?? '', total: summary.total,
      proven: summary.proven, failed: summary.failed, invalid: summary.invalid,
      'not-generated': summary.notGenerated, 'reports-directory': path.relative(workspace, reportsDir),
    };
    fs.appendFileSync(env.GITHUB_OUTPUT, Object.entries(outputs).map(([k, v]) => `${k}=${v}\n`).join(''));
  }
  await postComment(env, inputs, reportMarkdown(summary, rows, { runUrl, limit: COMMENT_LIMIT }), fetchImpl, log);
  return summary.result === 'passed' ? 0 : 1;
}

// Node resolves symlinks in import.meta.url but not in argv, so compare real paths:
// a runner whose work directory is a symlink must still run the check.
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
