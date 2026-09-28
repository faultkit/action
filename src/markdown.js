// Renders proof rows for the log, the job summary, and the PR comment.

import { NO_INVARIANT, SEVERITY, kind } from './results.js';

export const MARKER = '<!-- faultkit-resilience-report -->';
export const COMMENT_LIMIT = 60000; // GitHub rejects comment bodies over 65,536 characters.
export const SUMMARY_LIMIT = 1000000; // A step summary is capped at 1 MiB.
const FULL_TABLE_ROWS = 25;

const LABEL = {
  proven: '✅ Proven under fault',
  failed: '❌ Silent failure confirmed',
  invalid: '⚠️ Invalid evidence: nothing was injected',
  not_generated: '⚪ No fault scenario yet',
};
const MARK = { proven: '✅', failed: '❌', invalid: '⚠️', not_generated: '⚪', error: '🛑' };
const worstFirst = (a, b) => SEVERITY[kind(a.state)] - SEVERITY[kind(b.state)];
const MESSAGE_LIMIT = 2000;
const OUTCOME_TEXT_LIMIT = 120;

/** Repository-controlled text made safe for a Markdown table cell. */
export function escapeCell(text) {
  return String(text)
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/&/g, '&amp;')
    .replace(/@/g, '@&#8203;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/([\\`*_[\]|~])/g, '\\$1');
}

/** The prove-all table for the log, with a fault column and no colour. */
export function consoleTable(rows) {
  const width = Math.max('invariant'.length, ...rows.map((r) => r.id.length));
  const line = (id, fault, fired, exit, state) =>
    `${id.padEnd(width)}  ${fault.padEnd(13)}  ${fired.padStart(5)}  ${exit.padStart(4)}  ${state}`;
  const out = ['=== prove-all ===', '', line('invariant', 'fault', 'fired', 'exit', 'proof state')];
  for (const r of rows) {
    out.push(line(
      r.id,
      r.faultStatus === 'generated' ? 'generated' : 'not-generated',
      r.fired === null ? '-' : String(r.fired),
      r.exit === null ? '-' : String(r.exit),
      r.state,
    ));
  }
  return out.join('\n');
}

/** The === outcomes === table for the log, in run_faultkit.py's layout: worst state second, one invariant per line. */
export function outcomesTable(cov) {
  const rows = cov.outcomes.map((o) => [o.id, o.worst ?? NO_INVARIANT, o.invariants.length ? o.invariants.map((i) => i.id) : ['-']]);
  const wId = Math.max('outcome'.length, ...rows.map((r) => r[0].length));
  const wState = Math.max('worst state'.length, ...rows.map((r) => r[1].length));
  const out = [cov.inferred ? '=== outcomes (inferred) ===' : '=== outcomes ===', `${'outcome'.padEnd(wId)}  ${'worst state'.padEnd(wState)}  invariants`];
  for (const [id, state, ids] of rows) {
    out.push(`${id.padEnd(wId)}  ${state.padEnd(wState)}  ${ids[0]}`);
    for (const more of ids.slice(1)) out.push(`${' '.repeat(wId + wState + 4)}${more}`);
  }
  out.push(`declared ${cov.declared}, covered ${cov.covered}, uncovered ${cov.uncovered}, unlinked invariants ${cov.unlinked}`);
  return out.join('\n');
}

const dash = (v) => (v === null || v === undefined ? '—' : String(v));
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function table(rows) {
  return [
    '| Invariant | Fault | Fired | Exit | Proof state |',
    '|---|---|---:|---:|---|',
    ...rows.map((r) => {
      const fault = r.faultStatus === 'generated' ? 'generated' : 'not generated';
      const state = LABEL[kind(r.state)] ?? `🛑 ${escapeCell(r.state)}`;
      return `| \`${r.id}\` | ${fault} | ${dash(r.fired)} | ${dash(r.exit)} | ${state} |`;
    }),
  ];
}

const stateLabel = (state) => LABEL[kind(state)] ?? `🛑 ${escapeCell(state)}`;
const truncate = (text, n) => (text.length > n ? `${text.slice(0, n - 1)}…` : text);
const needsAttention = (o) => o.worst === null || kind(o.worst) !== 'proven';

function coverageTable(outcomes) {
  return [
    '| Outcome | What must never happen | Invariants | Worst state |',
    '|---|---|---|---|',
    ...outcomes.map((o) => {
      const invariants = o.invariants.map((i) => `${MARK[kind(i.state)]} \`${i.id}\``).join('<br>') || '—';
      const worst = o.worst === null ? '⚪ No invariant yet' : stateLabel(o.worst);
      return `| ${o.id} | ${escapeCell(truncate(o.text, OUTCOME_TEXT_LIMIT))} | ${invariants} | ${worst} |`;
    }),
  ];
}

function reasons(s) {
  const out = [];
  if (s.message) out.push(`Faultkit could not run: ${escapeCell(String(s.message).slice(0, MESSAGE_LIMIT))}`);
  if (s.errors) out.push(`Faultkit could not produce evidence for ${plural(s.errors, 'invariant')}.`);
  if (s.failed) out.push(`${plural(s.failed, 'invariant')} did not hold under an injected fault.`);
  if (s.invalid) out.push(`${plural(s.invalid, 'invariant')} produced no evidence: the fault was never injected.`);
  if (s.belowThreshold) out.push(`Proof coverage of ${s.score}% (${s.proven} of ${s.total}) is below the required ${s.threshold}%.`);
  if (s.uncoveredFails) out.push(`${plural(s.uncovered, 'declared outcome')} ${s.uncovered === 1 ? 'has' : 'have'} no invariant, and fail-on-uncovered is set.`);
  return out;
}

function header(s) {
  const out = [MARKER, '## Faultkit resilience check', ''];
  if (s.result === 'passed') out.push('✅ **Passed**', '');
  else {
    out.push(s.result === 'failed' ? '❌ **Failed**' : '⚠️ **Error**', '');
    for (const sentence of reasons(s)) out.push(sentence, '');
  }
  if (s.total > 0) out.push(`**Proof coverage:** ${s.proven} / ${s.total} invariants proven — **${s.score}%**  `);
  if (s.threshold !== null) out.push(`**Required threshold:** ${s.threshold}%`);
  out.push('');
  return out;
}

// The header already carries the counts, the score, and the threshold.
function footer(runUrl) {
  return [
    ...(runUrl ? [`[View workflow run](${runUrl})`, ''] : []),
    '<sub>Faultkit tests whether business invariants still hold when dependencies fail.</sub>',
  ];
}

/**
 * The report for the job summary and the PR comment. With a values file, the
 * outcome coverage comes first. Rows that need attention stay outside the
 * collapsed full tables, worst first; when the body has to fit `limit`, the
 * collapsed sections go first, then the attention lists are shortened from
 * the end, and the counts always remain.
 */
export function reportMarkdown(summary, rows, { runUrl = null, limit = COMMENT_LIMIT, coverage = null } = {}) {
  const collapsed = rows.length > FULL_TABLE_ROWS;
  const visible = collapsed
    ? rows.filter((r) => kind(r.state) !== 'proven').sort(worstFirst)
    : rows;
  const outcomesCollapsed = coverage !== null && coverage.outcomes.length > FULL_TABLE_ROWS;
  const visibleOutcomes = coverage === null ? []
    : outcomesCollapsed ? coverage.outcomes.filter(needsAttention) : coverage.outcomes;
  const extras = [];
  if (outcomesCollapsed) {
    extras.push(`<details><summary>All ${coverage.outcomes.length} declared outcomes</summary>`, '', ...coverageTable(coverage.outcomes), '', '</details>', '');
  }
  if (collapsed) extras.push(`<details><summary>All ${rows.length} invariants</summary>`, '', ...table(rows), '', '</details>', '');
  const missing = rows.filter((r) => r.faultStatus === 'not_generated');
  if (missing.length) {
    extras.push('<details><summary>Invariants without a fault scenario</summary>', '',
      ...missing.map((r) => `- \`${r.id}\`: ${escapeCell(r.reason)}`), '', '</details>', '');
  }
  const render = (shown, shownOutcomes, withExtras) => {
    const parts = header(summary);
    if (coverage !== null) {
      parts.push(`### Outcome coverage${coverage.inferred ? ' (inferred)' : ''}`, '');
      if (shownOutcomes.length) parts.push(...coverageTable(shownOutcomes), '');
      if (shownOutcomes.length < visibleOutcomes.length) {
        parts.push(`…and ${visibleOutcomes.length - shownOutcomes.length} more; the full list is in the workflow run.`, '');
      }
      parts.push(`${coverage.declared} declared · ${coverage.covered} covered · ${coverage.uncovered} uncovered · ${plural(coverage.unlinked, 'unlinked invariant')}`, '');
    }
    const heading = collapsed ? '### Needs attention' : coverage !== null ? '### Invariants' : null;
    if (shown.length) parts.push(...(heading ? [heading, ''] : []), ...table(shown), '');
    if (shown.length < visible.length) {
      parts.push(`…and ${visible.length - shown.length} more; the full list is in the workflow run.`, '');
    }
    // Without a values file, a row that needs attention says what it protects.
    const broken = coverage === null ? shown.filter((r) => ['failed', 'invalid', 'error'].includes(kind(r.state))) : [];
    if (broken.length) parts.push(...broken.map((r) => `- ${MARK[kind(r.state)]} \`${r.id}\`: ${escapeCell(r.invariant)}`), '');
    if (withExtras) parts.push(...extras);
    return [...parts, ...footer(runUrl)].join('\n');
  };

  // GitHub caps the step summary in bytes; bytes >= characters keeps the comment check safe too.
  const fits = (t) => Buffer.byteLength(t, 'utf8') <= limit;
  let text = render(visible, visibleOutcomes, true);
  if (fits(text)) return text;
  // Trimming drops rows from the end, so the worst rows go first.
  let shown = [...visible].sort(worstFirst);
  let shownOutcomes = visibleOutcomes.filter(needsAttention);
  text = render(shown, shownOutcomes, false);
  while (!fits(text) && (shown.length > 0 || shownOutcomes.length > 0)) {
    shown = shown.slice(0, Math.floor(shown.length / 2));
    shownOutcomes = shownOutcomes.slice(0, Math.floor(shownOutcomes.length / 2));
    text = render(shown, shownOutcomes, false);
  }
  return text;
}
