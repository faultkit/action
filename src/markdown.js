// Renders proof rows for the log, the job summary, and the PR comment.

import { kind } from './results.js';

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
const SEVERITY = { error: 0, failed: 1, invalid: 2, not_generated: 3, proven: 4 };
const worstFirst = (a, b) => SEVERITY[kind(a.state)] - SEVERITY[kind(b.state)];
const MESSAGE_LIMIT = 2000;

/** Repository-controlled text made safe for a Markdown table cell. */
export function escapeCell(text) {
  return String(text)
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/&/g, '&amp;')
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

function reasons(s) {
  const out = [];
  if (s.message) out.push(`Faultkit could not run: ${escapeCell(String(s.message).slice(0, MESSAGE_LIMIT))}`);
  if (s.errors) out.push(`Faultkit could not produce evidence for ${plural(s.errors, 'invariant')}.`);
  if (s.failed) out.push(`${plural(s.failed, 'invariant')} did not hold under an injected fault.`);
  if (s.invalid) out.push(`${plural(s.invalid, 'invariant')} produced no evidence: the fault was never injected.`);
  if (s.belowThreshold) out.push(`Proof coverage of ${s.score}% is below the required ${s.threshold}%.`);
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

function footer(s, runUrl) {
  return [
    '### Summary',
    '',
    `- ✅ Proven: ${s.proven}`,
    `- ❌ Failed: ${s.failed}`,
    `- ⚠️ Invalid evidence: ${s.invalid}`,
    ...(s.errors ? [`- 🛑 Errors: ${s.errors}`] : []),
    `- ⚪ Fault not generated: ${s.notGenerated}`,
    `- **Score: ${s.score}%**`,
    ...(s.threshold !== null ? [`- **Threshold: ${s.threshold}%**`] : []),
    '',
    ...(runUrl ? [`[View workflow run](${runUrl})`, ''] : []),
    '<sub>Faultkit tests whether business invariants still hold when dependencies fail.</sub>',
  ];
}

/**
 * The report for the job summary and the PR comment. Rows that need attention
 * stay outside the collapsed full table, worst first; when the body has to
 * fit `limit`, the collapsed sections go first, then the attention list is
 * shortened from the end, and the counts always remain.
 */
export function reportMarkdown(summary, rows, { runUrl = null, limit = COMMENT_LIMIT } = {}) {
  const collapsed = rows.length > FULL_TABLE_ROWS;
  const visible = collapsed
    ? rows.filter((r) => kind(r.state) !== 'proven').sort(worstFirst)
    : rows;
  const extras = [];
  if (collapsed) extras.push(`<details><summary>All ${rows.length} invariants</summary>`, '', ...table(rows), '', '</details>', '');
  const missing = rows.filter((r) => r.faultStatus === 'not_generated');
  if (missing.length) {
    extras.push('<details><summary>Invariants without a fault scenario</summary>', '',
      ...missing.map((r) => `- \`${r.id}\`: ${escapeCell(r.reason)}`), '', '</details>', '');
  }
  const render = (shown, withExtras) => {
    const parts = header(summary);
    if (shown.length) parts.push(...(collapsed ? ['### Needs attention', ''] : []), ...table(shown), '');
    if (shown.length < visible.length) {
      parts.push(`…and ${visible.length - shown.length} more; the full list is in the workflow run.`, '');
    }
    if (withExtras) parts.push(...extras);
    return [...parts, ...footer(summary, runUrl)].join('\n');
  };

  // GitHub caps the step summary in bytes; bytes >= characters keeps the comment check safe too.
  const fits = (t) => Buffer.byteLength(t, 'utf8') <= limit;
  let text = render(visible, true);
  if (fits(text)) return text;
  // Trimming drops rows from the end, so the worst rows go first.
  let shown = [...visible].sort(worstFirst);
  text = render(shown, false);
  while (!fits(text) && shown.length > 0) {
    shown = shown.slice(0, Math.floor(shown.length / 2));
    text = render(shown, false);
  }
  return text;
}
