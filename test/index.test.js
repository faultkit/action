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
    'not-generated': '0', 'reports-directory': '.faultkit/reports',
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
  assert.equal(await main(env, { fetchImpl, log: quiet }), 0);
  assert.equal(outputs(files.GITHUB_OUTPUT).result, 'passed');
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
  const run = spawnSync(process.execPath, [path.join(link, 'src', 'index.js')], { env: { PATH: process.env.PATH, GITHUB_WORKSPACE: workspace }, encoding: 'utf8' });
  assert.equal(run.status, 1, 'a missing manifest is an error, never a silent exit 0');
});
