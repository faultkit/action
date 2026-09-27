import assert from 'node:assert/strict';
import { test } from 'node:test';
import { COMMENT_LIMIT, MARKER, consoleTable, escapeCell, reportMarkdown } from '../src/markdown.js';
import { INVALID_EVIDENCE, NOT_GENERATED, PROVEN, SILENT_FAILURE, errorSummary, summarize } from '../src/results.js';

const row = (id, state, reason = 'No deterministic injectable boundary was identified.') => ({
  id,
  invariant: `${id} holds`,
  faultStatus: state === NOT_GENERATED ? 'not_generated' : 'generated',
  reason: state === NOT_GENERATED ? reason : null,
  fired: state === NOT_GENERATED ? null : state === INVALID_EVIDENCE ? 0 : 1,
  exit: state === NOT_GENERATED ? null : state === SILENT_FAILURE ? 1 : 0,
  state,
});

test('the console table follows prove-all and shows uncovered invariants', () => {
  const lines = consoleTable([
    row('paid-invoice-never-escalated', PROVEN),
    row('refund-never-exceeds-limit', SILENT_FAILURE),
    row('human-approval-is-recorded', NOT_GENERATED),
  ]).split('\n');
  assert.deepEqual(lines.slice(0, 2), ['=== prove-all ===', '']);
  assert.match(lines[2], /^invariant\s+fault\s+fired\s+exit\s+proof state$/);
  const col = lines[2].indexOf('proof state');
  assert.equal(lines[3].slice(col), 'invariant proven under fault');
  assert.match(lines[4], /^refund-never-exceeds-limit\s+generated\s+1\s+1\s+silent failure confirmed$/);
  assert.match(lines[5], /^human-approval-is-recorded\s+not-generated\s+-\s+-\s+fault not generated$/);
  assert.equal(lines[5].indexOf('fault not generated'), col);
});

test('long ids widen the first column instead of breaking alignment', () => {
  const lines = consoleTable([row('a'.repeat(60), PROVEN), row('b', SILENT_FAILURE)]).split('\n');
  const col = lines[2].indexOf('proof state');
  assert.equal(lines[3].indexOf('invariant proven under fault'), col);
  assert.equal(lines[4].indexOf('silent failure confirmed'), col);
});

test('a passing report shows coverage, threshold, and the table', () => {
  const rows = [...Array.from({ length: 8 }, (_, i) => row(`inv-${i}`, PROVEN)), row('x', NOT_GENERATED), row('y', NOT_GENERATED)];
  const md = reportMarkdown(summarize(rows, 80), rows, { runUrl: 'https://github.com/acme/shop/actions/runs/42' });
  assert.ok(md.startsWith(MARKER));
  for (const want of [
    '## Faultkit resilience check', '✅ **Passed**', '**Proof coverage:** 8 / 10 invariants proven — **80%**',
    '**Required threshold:** 80%', '| `inv-0` | generated | 1 | 0 | ✅ Proven under fault |',
    '| `x` | not generated | — | — | ⚪ No fault scenario yet |', '- ⚪ Fault not generated: 2', '- **Score: 80%**',
    '[View workflow run](https://github.com/acme/shop/actions/runs/42)',
  ]) assert.ok(md.includes(want), want);
});

test('a failing report says why', () => {
  const rows = [row('a', PROVEN), row('refund-never-exceeds-limit', SILENT_FAILURE), row('c', INVALID_EVIDENCE)];
  const md = reportMarkdown(summarize(rows, 0), rows);
  for (const want of [
    '❌ **Failed**', '1 invariant did not hold under an injected fault.',
    '1 invariant produced no evidence: the fault was never injected.',
    '| `refund-never-exceeds-limit` | generated | 1 | 1 | ❌ Silent failure confirmed |',
  ]) assert.ok(md.includes(want), want);
});

test('an error report explains what could not run', () => {
  const md = reportMarkdown(errorSummary('manifest.json: unsupported "version" 7', 100), []);
  assert.ok(md.includes('⚠️ **Error**'));
  assert.ok(md.includes('Faultkit could not run: manifest.json: unsupported "version" 7'));
});

test('repository text is escaped', () => {
  assert.equal(escapeCell('a | b <script>alert(1)</script> *x*\nnext'),
    'a \\| b &lt;script&gt;alert(1)&lt;/script&gt; \\*x\\* next');
  const rows = [row('evil', NOT_GENERATED, '<img src=x onerror=alert(1)> | `rm -rf`')];
  const md = reportMarkdown(summarize(rows, 0), rows);
  assert.ok(!md.includes('<img'));
});

test('a mention in repository text never pings anyone', () => {
  assert.equal(escapeCell('ask @octocat'), 'ask @&#8203;octocat');
});

test('many invariants collapse the table but keep failures visible', () => {
  const rows = [...Array.from({ length: 399 }, (_, i) => row(`proven-${i}`, PROVEN)), row('refund-never-exceeds-limit', SILENT_FAILURE)];
  const md = reportMarkdown(summarize(rows, 0), rows);
  assert.ok(md.length <= COMMENT_LIMIT);
  const details = md.indexOf('<details>');
  assert.ok(details > 0);
  assert.ok(md.indexOf('refund-never-exceeds-limit') < details, 'the failure is above the collapsed table');
});

test('a report too long for a comment is trimmed, failures first', () => {
  const rows = [
    ...Array.from({ length: 3000 }, (_, i) => row(`gap-${i}`, NOT_GENERATED, 'x'.repeat(200))),
    row('refund-never-exceeds-limit', SILENT_FAILURE),
  ];
  const md = reportMarkdown(summarize(rows, 0), rows);
  assert.ok(md.length <= COMMENT_LIMIT, `${md.length}`);
  assert.ok(md.includes('refund-never-exceeds-limit'));
  assert.ok(md.includes('- ❌ Failed: 1'));
  assert.ok(md.includes('more; the full list is in the workflow run.'));
});

test('the size limit counts bytes, not characters', () => {
  const rows = Array.from({ length: 10 }, (_, i) => row(`gap-${i}`, NOT_GENERATED, 'é'.repeat(50)));
  const full = reportMarkdown(summarize(rows, 0), rows, { limit: Infinity });
  const md = reportMarkdown(summarize(rows, 0), rows, { limit: full.length });
  assert.ok(Buffer.byteLength(md, 'utf8') <= full.length);
});

test('a trimmed short report keeps its failures', () => {
  const rows = [...Array.from({ length: 9 }, (_, i) => row(`proven-${i}`, PROVEN)), row('refund-never-exceeds-limit', SILENT_FAILURE)];
  const md = reportMarkdown(summarize(rows, 0), rows, { limit: 900 });
  assert.ok(Buffer.byteLength(md, 'utf8') <= 900);
  assert.ok(md.includes('refund-never-exceeds-limit'));
});

test('a long error message is cut to fit', () => {
  const md = reportMarkdown(errorSummary('x'.repeat(5000), 100), [], { limit: 3000 });
  assert.ok(Buffer.byteLength(md, 'utf8') <= 3000);
  assert.ok(md.includes('⚠️ **Error**'));
});
