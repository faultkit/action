import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { INVALID_EVIDENCE, NOT_GENERATED, PROVEN, SILENT_FAILURE } from '../src/results.js';
import { childEnv, faultkitArgs, runInvariant } from '../src/runner.js';

const FAKE = fileURLToPath(new URL('./fixtures/fake-faultkit.js', import.meta.url));
fs.chmodSync(FAKE, 0o755);

const inv = (extra = {}) => ({
  id: 'refund-never-exceeds-limit', invariant: 'Refunds never exceed the limit.', faultStatus: 'generated',
  faultReason: null, config: '/ws/.faultkit/invariants/refund.yaml', scenario: null,
  mode: 'auto', baseUrl: false, provider: '', shape: null, gate: ['pytest', '-q', 'tests/test_refund.py'], ...extra,
});

test('faultkit arguments match run_faultkit.py', () => {
  assert.deepEqual(faultkitArgs(inv(), 'r.json'), [
    'run', '--config', '/ws/.faultkit/invariants/refund.yaml', '--report', 'r.json', '--mode', 'auto',
    '--', 'pytest', '-q', 'tests/test_refund.py',
  ]);
  const builtin = inv({ config: null, scenario: 'llm-api-degraded', mode: 'proxy', baseUrl: true, provider: 'openai' });
  assert.deepEqual(faultkitArgs(builtin, 'r.json'), [
    'run', '--scenario', 'llm-api-degraded', '--report', 'r.json', '--mode', 'proxy', '--base-url', '--provider', 'openai',
    '--', 'pytest', '-q', 'tests/test_refund.py',
  ]);
});

test('the gate never sees the action inputs, runner tokens, or step files', () => {
  const env = childEnv({
    PATH: '/usr/bin', HOME: '/home/runner', 'INPUT_GITHUB-TOKEN': 'ghs_secret', INPUT_THRESHOLD: '100',
    ACTIONS_RUNTIME_TOKEN: 'x', ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'y', GITHUB_OUTPUT: '/o', GITHUB_STEP_SUMMARY: '/s',
    GITHUB_ENV: '/e', GITHUB_PATH: '/p', GITHUB_STATE: '/st', GITHUB_REPOSITORY: 'o/r',
  });
  assert.deepEqual(Object.keys(env).sort(), ['GITHUB_REPOSITORY', 'HOME', 'PATH']);
});

function setup(plan) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'faultkit-runner-'));
  const log = path.join(dir, 'argv.log');
  const env = { ...process.env, FAKE_FAULTKIT_PLAN: JSON.stringify(plan), FAKE_FAULTKIT_LOG: log, 'INPUT_GITHUB-TOKEN': 'ghs_secret' };
  return { dir, log, env, reportsDir: path.join(dir, '.faultkit', 'reports') };
}
const run = (s, i, binary = FAKE) => runInvariant({ binary, inv: i, reportsDir: s.reportsDir, cwd: s.dir, env: s.env });

test('proof states come from the exit code and the report', async () => {
  const cases = [
    [{ exit: 0, fired: 1 }, PROVEN, 1, 0],
    [{ exit: 1, fired: 2 }, SILENT_FAILURE, 2, 1],
    [{ exit: 0, fired: 0 }, INVALID_EVIDENCE, 0, 0],
    [{ exit: 3, fired: 0 }, INVALID_EVIDENCE, 0, 3],
    [{ exit: 2, report: false }, 'error: faultkit exited 2', null, 2],
    [{ exit: 4, report: false }, 'error: faultkit exited 4', null, 4],
    [{ exit: 0, fired: 1, report: false }, 'error: report missing or malformed', null, 0],
    [{ exit: 0, fired: 1, schema: 'something/else' }, 'error: report missing or malformed', null, 0],
  ];
  for (const [outcome, state, fired, exit] of cases) {
    const row = await run(setup({ 'refund.yaml': outcome }), inv());
    assert.deepEqual([row.state, row.fired, row.exit], [state, fired, exit], JSON.stringify(outcome));
  }
});

test('the run uses the manifest argv exactly and never passes the token down', async () => {
  const s = setup({ 'refund.yaml': { exit: 0, fired: 1 } });
  await run(s, inv({ baseUrl: true }));
  const [{ args, env }] = fs.readFileSync(s.log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const report = path.join(s.reportsDir, 'refund-never-exceeds-limit.report.json');
  assert.deepEqual(args, faultkitArgs(inv({ baseUrl: true }), report));
  assert.ok(!env.some((k) => k.startsWith('INPUT_')), 'no INPUT_ variable reaches faultkit');
});

test('a stale report never stands in for a missing one', async () => {
  const s = setup({ 'refund.yaml': { exit: 0, fired: 1, report: false } });
  fs.mkdirSync(s.reportsDir, { recursive: true });
  fs.writeFileSync(path.join(s.reportsDir, 'refund-never-exceeds-limit.report.json'),
    JSON.stringify({ schema: 'faultkit.dev/report/v1', events: [{ fired: true }] }));
  assert.equal((await run(s, inv())).state, 'error: report missing or malformed');
});

test('a not_generated invariant is recorded without running anything', async () => {
  const s = setup({});
  const row = await run(s, inv({ faultStatus: 'not_generated', faultReason: 'No boundary.', config: null, gate: null }));
  assert.deepEqual([row.state, row.fired, row.exit, row.reason], [NOT_GENERATED, null, null, 'No boundary.']);
  assert.equal(fs.existsSync(s.log), false);
});

test('a binary that cannot start is an error, not a pass', async () => {
  const s = setup({});
  const row = await run(s, inv(), path.join(s.dir, 'missing-faultkit'));
  assert.match(row.state, /^error: could not start faultkit/);
});
