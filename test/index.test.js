import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { main } from '../src/index.js';
import { MARKER } from '../src/markdown.js';
import { entry, makeWorkspace } from './helpers.js';

const FAKE = fileURLToPath(new URL('./fixtures/fake-faultkit.js', import.meta.url));
fs.chmodSync(FAKE, 0o755);
const quiet = () => {};

function githubEnv(ws, extra = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'faultkit-gh-'));
  const files = { GITHUB_OUTPUT: path.join(tmp, 'output'), GITHUB_STEP_SUMMARY: path.join(tmp, 'summary.md'), FAKE_FAULTKIT_LOG: path.join(tmp, 'argv.log') };
  for (const f of Object.values(files)) fs.writeFileSync(f, '');
  const env = {
    PATH: process.env.PATH, GITHUB_WORKSPACE: ws.root, RUNNER_TEMP: tmp, 'INPUT_FAULTKIT-PATH': FAKE,
    GITHUB_REPOSITORY: 'acme/shop', GITHUB_SERVER_URL: 'https://github.com', GITHUB_RUN_ID: '42', ...files, ...extra,
  };
  return { env, files };
}
const outputs = (file) => Object.fromEntries(fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => l.split(/=(.*)/s).slice(0, 2)));
const prEvent = (ws) => {
  const p = path.join(ws.root, 'event.json');
  fs.writeFileSync(p, JSON.stringify({ pull_request: { number: 7 } }));
  return p;
};

test('three proven invariants at threshold 100 pass, with the manifest argv', async () => {
  const ws = makeWorkspace({ version: 1, invariants: [entry('a'), entry('b'), entry('c')] });
  const { env, files } = githubEnv(ws, { INPUT_THRESHOLD: '100' });
  assert.equal(await main(env, { log: quiet }), 0);
  assert.deepEqual(outputs(files.GITHUB_OUTPUT), {
    result: 'passed', score: '100', threshold: '100', total: '3', proven: '3', failed: '0', invalid: '0',
    'not-generated': '0', 'reports-directory': '.faultkit/reports', outcomes: '0', covered: '0', uncovered: '0',
  });
  const summary = fs.readFileSync(files.GITHUB_STEP_SUMMARY, 'utf8');
  assert.ok(summary.includes('✅ **Passed**'));
  assert.ok(summary.includes('[View workflow run](https://github.com/acme/shop/actions/runs/42)'));
  const argv = fs.readFileSync(files.FAKE_FAULTKIT_LOG, 'utf8').trim().split('\n').map((l) => JSON.parse(l).args);
  assert.deepEqual(argv[0], [
    'run', '--config', path.join(ws.dir, 'outage.yaml'), '--report', path.join(ws.root, '.faultkit', 'reports', 'a.report.json'),
    '--mode', 'auto', '--', 'node', '--test', 'test/a.test.mjs',
  ]);
});

test('a coverage gap fails at 100 and passes at 60', async () => {
  const manifest = {
    version: 2,
    invariants: [
      entry('a', { fault_status: 'generated' }), entry('b', { fault_status: 'generated' }),
      { id: 'c', invariant: 'c holds', fault_status: 'not_generated', fault_reason: 'No boundary.' },
    ],
  };
  for (const [threshold, code, result] of [['100', 1, 'failed'], ['60', 0, 'passed']]) {
    const ws = makeWorkspace(manifest);
    const { env, files } = githubEnv(ws, { INPUT_THRESHOLD: threshold });
    assert.equal(await main(env, { log: quiet }), code, threshold);
    const out = outputs(files.GITHUB_OUTPUT);
    assert.deepEqual([out.result, out.score, out['not-generated']], [result, '66.67', '1'], threshold);
  }
});

test('a silent failure fails even at threshold 0', async () => {
  const ws = makeWorkspace({ version: 1, invariants: [entry('a'), entry('b'), entry('c', { config: 'broken.yaml' })] },
    { 'outage.yaml': 'x', 'broken.yaml': 'x' });
  const { env, files } = githubEnv(ws, { INPUT_THRESHOLD: '0', FAKE_FAULTKIT_PLAN: JSON.stringify({ 'broken.yaml': { exit: 1, fired: 1 } }) });
  assert.equal(await main(env, { log: quiet }), 1);
  assert.equal(outputs(files.GITHUB_OUTPUT).result, 'failed');
  assert.ok(fs.readFileSync(files.GITHUB_STEP_SUMMARY, 'utf8').includes('❌ Silent failure confirmed'));
});

test('a fault that never fires always fails', async () => {
  const ws = makeWorkspace({ version: 1, invariants: [entry('a')] });
  const { env, files } = githubEnv(ws, { INPUT_THRESHOLD: '0', FAKE_FAULTKIT_PLAN: JSON.stringify({ 'outage.yaml': { exit: 3, fired: 0 } }) });
  assert.equal(await main(env, { log: quiet }), 1);
  const out = outputs(files.GITHUB_OUTPUT);
  assert.deepEqual([out.result, out.invalid], ['failed', '1']);
});

test('a malformed manifest is an error, still reported', async () => {
  const ws = makeWorkspace({ version: 7, invariants: [] });
  const { env, files } = githubEnv(ws);
  assert.equal(await main(env, { log: quiet }), 1);
  assert.equal(outputs(files.GITHUB_OUTPUT).result, 'error');
  assert.ok(fs.readFileSync(files.GITHUB_STEP_SUMMARY, 'utf8').includes('⚠️ **Error**'));
});

test('an invalid threshold is an error', async () => {
  const ws = makeWorkspace({ version: 1, invariants: [entry('a')] });
  const { env, files } = githubEnv(ws, { INPUT_THRESHOLD: '120' });
  assert.equal(await main(env, { log: quiet }), 1);
  const out = outputs(files.GITHUB_OUTPUT);
  assert.deepEqual([out.result, out.threshold], ['error', '']);
});

test('on a pull request the comment is created once, then updated', async () => {
  const ws = makeWorkspace({ version: 1, invariants: [entry('a')] });
  const comments = [];
  const fetchImpl = async (url, opts = {}) => {
    const method = opts.method ?? 'GET';
    if (method === 'GET') return Response.json(comments);
    const { body } = JSON.parse(opts.body);
    if (method === 'POST') { comments.push({ id: 1, body, user: { type: 'Bot' } }); return Response.json(comments[0], { status: 201 }); }
    comments[0].body = body;
    return Response.json(comments[0]);
  };
  for (let i = 0; i < 2; i += 1) {
    const { env } = githubEnv(ws, { 'INPUT_GITHUB-TOKEN': 'ghs_test', GITHUB_EVENT_PATH: prEvent(ws) });
    assert.equal(await main(env, { fetchImpl, log: quiet }), 0);
  }
  assert.equal(comments.length, 1);
  assert.ok(comments[0].body.startsWith(MARKER));
});

test('a comment that cannot be posted leaves the verdict alone', async () => {
  const ws = makeWorkspace({ version: 1, invariants: [entry('a')] });
  const fetchImpl = async () => new Response('forbidden', { status: 403 });
  const { env, files } = githubEnv(ws, { 'INPUT_GITHUB-TOKEN': 'ghs_test', GITHUB_EVENT_PATH: prEvent(ws) });
  const lines = [];
  assert.equal(await main(env, { fetchImpl, log: (l) => lines.push(String(l)) }), 0);
  assert.equal(outputs(files.GITHUB_OUTPUT).result, 'passed');
  assert.ok(lines.some((l) => l.startsWith('::warning::')));
});

test('a failed comment never logs the token', async () => {
  const ws = makeWorkspace({ version: 1, invariants: [entry('a')] });
  const lines = [];
  const fetchImpl = async () => { throw new TypeError('Headers.append: "Bearer ghs_test" is an invalid header value.'); };
  const { env } = githubEnv(ws, { 'INPUT_GITHUB-TOKEN': 'ghs_test', GITHUB_EVENT_PATH: prEvent(ws) });
  assert.equal(await main(env, { fetchImpl, log: (l) => lines.push(String(l)) }), 0);
  assert.ok(lines.some((l) => l.startsWith('::warning::')), 'the failure is a warning');
  assert.ok(!lines.join('\n').includes('ghs_test'), 'the token never reaches the log');
});

test('without a token nothing is sent to GitHub', async () => {
  const ws = makeWorkspace({ version: 1, invariants: [entry('a')] });
  let called = false;
  const { env } = githubEnv(ws, { GITHUB_EVENT_PATH: prEvent(ws) });
  assert.equal(await main(env, { log: quiet, fetchImpl: async () => { called = true; return Response.json([]); } }), 0);
  assert.equal(called, false);
});

test('started through a symlinked path, the action still runs', () => {
  const link = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'faultkit-link-')), 'action');
  fs.symlinkSync(fileURLToPath(new URL('..', import.meta.url)), link);
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'faultkit-empty-'));
  for (const nodeOptions of ['', '--preserve-symlinks-main']) {
    const env = { PATH: process.env.PATH, GITHUB_WORKSPACE: workspace, ...(nodeOptions ? { NODE_OPTIONS: nodeOptions } : {}) };
    const run = spawnSync(process.execPath, [path.join(link, 'src', 'main.js')], { env, encoding: 'utf8' });
    assert.equal(run.status, 1, `a missing manifest is an error, never a silent exit 0 (NODE_OPTIONS=${nodeOptions})`);
  }
});

const VALUES = '## Business value\nUrgent problems reach a human fast.\n\n## Unacceptable outcomes\n- UO-1: An outage pages no one.\n- UO-2: A ticket is closed unread.\n';
function withValues(manifest, text = VALUES) {
  const ws = makeWorkspace(manifest);
  fs.writeFileSync(path.join(ws.root, '.faultkit', 'values.md'), text);
  return ws;
}
const v3 = (...invariants) => ({ version: 3, invariants: invariants.map((e) => ({ fault_status: 'generated', ...e })) });
const ran = (files) => fs.readFileSync(files.FAKE_FAULTKIT_LOG, 'utf8').trim() !== '';

test('a values file adds outcome coverage to the outputs, the log, and the summary', async () => {
  const ws = withValues(v3(entry('a', { outcome: 'UO-1' }), entry('b', { outcome: 'UO-1' }), entry('c')));
  const { env, files } = githubEnv(ws);
  const lines = [];
  assert.equal(await main(env, { log: (l) => lines.push(l) }), 0);
  const out = outputs(files.GITHUB_OUTPUT);
  assert.deepEqual([out.outcomes, out.covered, out.uncovered], ['2', '1', '1']);
  assert.ok(lines.join('\n').includes('declared 2, covered 1, uncovered 1, unlinked invariants 1'));
  const summary = fs.readFileSync(files.GITHUB_STEP_SUMMARY, 'utf8');
  assert.ok(summary.includes('| UO-1 | An outage pages no one. | ✅ `a`<br>✅ `b` | ✅ Proven under fault |'));
  assert.ok(summary.includes('| UO-2 | A ticket is closed unread. | — | ⚪ No invariant yet |'));
});

test('fail-on-uncovered fails a run whose declared outcome has no invariant', async () => {
  const ws = withValues(v3(entry('a', { outcome: 'UO-1' })));
  const { env, files } = githubEnv(ws, { 'INPUT_FAIL-ON-UNCOVERED': 'true' });
  assert.equal(await main(env, { log: quiet }), 1);
  assert.equal(outputs(files.GITHUB_OUTPUT).result, 'failed');
});

test('require-values stops before any run when the file is missing', async () => {
  const ws = makeWorkspace({ version: 1, invariants: [entry('a')] });
  const { env, files } = githubEnv(ws, { 'INPUT_REQUIRE-VALUES': 'true' });
  assert.equal(await main(env, { log: quiet }), 1);
  assert.equal(outputs(files.GITHUB_OUTPUT).result, 'error');
  assert.ok(fs.readFileSync(files.GITHUB_STEP_SUMMARY, 'utf8').includes('values file .faultkit/values.md not found, and require-values is set'));
  assert.equal(ran(files), false);
});

test('a missing values file skips coverage silently', async () => {
  const ws = makeWorkspace({ version: 1, invariants: [entry('a')] });
  const { env, files } = githubEnv(ws);
  assert.equal(await main(env, { log: quiet }), 0);
  assert.ok(!fs.readFileSync(files.GITHUB_STEP_SUMMARY, 'utf8').includes('Outcome coverage'));
});

test('outcome links are checked before anything runs', async () => {
  for (const [name, ws, message] of [
    ['dangling', makeWorkspace(v3(entry('a', { outcome: 'UO-1' }))), 'dangling outcome reference'],
    ['undeclared', withValues(v3(entry('a', { outcome: 'UO-7' }))), 'a: outcome UO-7 is not declared in .faultkit/values.md'],
    ['bad values file', withValues(v3(entry('a')), '## Business value\nv\n'), '.faultkit/values.md:1: missing'],
    ['values outside the repository', makeWorkspace({ ...v3(entry('a')), values: '../values.md' }), 'must stay inside the repository'],
  ]) {
    const { env, files } = githubEnv(ws);
    assert.equal(await main(env, { log: quiet }), 1, name);
    assert.equal(outputs(files.GITHUB_OUTPUT).result, 'error', name);
    assert.ok(fs.readFileSync(files.GITHUB_STEP_SUMMARY, 'utf8').includes(message), name);
    assert.equal(ran(files), false, name);
  }
});

test('the values input overrides the manifest and the default', async () => {
  const ws = withValues(v3(entry('a', { outcome: 'UO-9' })));
  fs.writeFileSync(path.join(ws.root, 'other.md'), '## Business value\nv\n## Unacceptable outcomes\n- UO-9: other\n');
  const { env, files } = githubEnv(ws, { INPUT_VALUES: 'other.md' });
  assert.equal(await main(env, { log: quiet }), 0);
  assert.equal(outputs(files.GITHUB_OUTPUT).covered, '1');
});

test('a boolean input that is not true or false is an error', async () => {
  const ws = makeWorkspace({ version: 1, invariants: [entry('a')] });
  const { env, files } = githubEnv(ws, { 'INPUT_FAIL-ON-UNCOVERED': 'yes' });
  assert.equal(await main(env, { log: quiet }), 1);
  assert.ok(fs.readFileSync(files.GITHUB_STEP_SUMMARY, 'utf8').includes('fail-on-uncovered must be true or false'));
});

test('a project in a subdirectory runs its gates there and finds its values file there', async () => {
  const ws = withValues(v3(entry('a', { outcome: 'UO-1' })));
  const repo = path.dirname(ws.root);
  const { env, files } = githubEnv(ws, { GITHUB_WORKSPACE: repo, 'INPUT_WORKING-DIRECTORY': path.basename(ws.root) });
  assert.equal(await main(env, { log: quiet }), 0);
  const out = outputs(files.GITHUB_OUTPUT);
  assert.equal(out.covered, '1');
  assert.equal(out['reports-directory'], path.join(path.basename(ws.root), '.faultkit', 'reports'));
  const run = JSON.parse(fs.readFileSync(files.FAKE_FAULTKIT_LOG, 'utf8').trim().split('\n')[0]);
  assert.equal(fs.realpathSync(run.cwd), fs.realpathSync(ws.root));
});

test('a working-directory outside the repository, or not a directory, is an error', async () => {
  for (const [dir, message] of [['../elsewhere', 'must stay inside the repository'], ['missing', 'is not a directory']]) {
    const ws = makeWorkspace({ version: 1, invariants: [entry('a')] });
    const { env, files } = githubEnv(ws, { 'INPUT_WORKING-DIRECTORY': dir });
    assert.equal(await main(env, { log: quiet }), 1, dir);
    assert.ok(fs.readFileSync(files.GITHUB_STEP_SUMMARY, 'utf8').includes(message), dir);
    assert.equal(ran(files), false, dir);
  }
});

test('a workspace path with a trailing slash is the repository root', async () => {
  const ws = makeWorkspace({ version: 1, invariants: [entry('a')] });
  const { env, files } = githubEnv(ws, { GITHUB_WORKSPACE: `${ws.root}${path.sep}` });
  assert.equal(await main(env, { log: quiet }), 0);
  assert.equal(outputs(files.GITHUB_OUTPUT)['reports-directory'], path.join('.faultkit', 'reports'));
});
