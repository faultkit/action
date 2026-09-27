import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { ManifestError, ManifestScenarioSource } from '../src/manifest.js';
import { entry, makeWorkspace } from './helpers.js';

const discover = (manifestPath) => new ManifestScenarioSource({ manifestPath }).discover();
const notGenerated = {
  id: 'human-approval-is-recorded',
  invariant: 'Every regulated action has a recorded human approval.',
  shape: 'S8',
  fault_status: 'not_generated',
  fault_reason: 'No deterministic injectable boundary was identified.',
};

test('a version 1 manifest is read as all generated', async () => {
  const ws = makeWorkspace({ version: 1, invariants: [entry('paid-invoice-never-escalated', { base_url: true, provider: 'openai' })] });
  const plan = await discover(ws.manifestPath);
  assert.equal(plan.version, 1);
  assert.deepEqual(plan.invariants[0], {
    id: 'paid-invoice-never-escalated',
    invariant: 'The paid-invoice-never-escalated invariant holds.',
    faultStatus: 'generated',
    mode: 'auto',
    baseUrl: true,
    provider: 'openai',
    shape: null,
    faultReason: null,
    config: path.join(ws.dir, 'outage.yaml'),
    scenario: null,
    gate: ['node', '--test', 'test/paid-invoice-never-escalated.test.mjs'],
  });
});

test('version 2 keeps generated and not_generated invariants', async () => {
  const ws = makeWorkspace({
    version: 2,
    invariants: [
      entry('refund-never-exceeds-limit', { fault_status: 'generated', mode: 'proxy' }),
      { id: 'uses-builtin', invariant: 'x', fault_status: 'generated', scenario: 'llm-api-degraded', gate: ['pytest'] },
      notGenerated,
    ],
  });
  const plan = await discover(ws.manifestPath);
  assert.deepEqual(plan.invariants.map((i) => [i.id, i.faultStatus]), [
    ['refund-never-exceeds-limit', 'generated'],
    ['uses-builtin', 'generated'],
    ['human-approval-is-recorded', 'not_generated'],
  ]);
  assert.equal(plan.invariants[0].mode, 'proxy');
  assert.equal(plan.invariants[1].scenario, 'llm-api-degraded');
  assert.equal(plan.invariants[2].faultReason, 'No deterministic injectable boundary was identified.');
  assert.equal(plan.invariants[2].gate, null);
  assert.equal(plan.invariants[2].shape, 'S8');
});

test('malformed manifests fail closed', async () => {
  const cases = [
    ['duplicate ids', { version: 1, invariants: [entry('a'), entry('a')] }, /duplicate id a/],
    ['generated without config or scenario', { version: 2, invariants: [{ id: 'a', invariant: 'x', fault_status: 'generated', gate: ['t'] }] }, /exactly one of "config"/],
    ['both config and scenario', { version: 1, invariants: [entry('a', { scenario: 'llm-api-degraded' })] }, /exactly one of "config"/],
    ['not_generated with config', { version: 2, invariants: [{ ...notGenerated, config: 'outage.yaml' }] }, /no "config" or "scenario"/],
    ['not_generated without a reason', { version: 2, invariants: [{ ...notGenerated, fault_reason: ' ' }] }, /"fault_reason"/],
    ['v2 entry without fault_status', { version: 2, invariants: [entry('a')] }, /"fault_status"/],
    ['fault_status in a v1 manifest', { version: 1, invariants: [{ ...entry('a'), fault_status: 'generated' }] }, /needs "version": 2/],
    ['invalid mode', { version: 1, invariants: [entry('a', { mode: 'kernel' })] }, /"mode"/],
    ['gate as a string', { version: 1, invariants: [entry('a', { gate: 'npm test' })] }, /"gate"/],
    ['gate with an empty argument', { version: 1, invariants: [entry('a', { gate: ['npm', ''] })] }, /"gate"/],
    ['empty invariants', { version: 1, invariants: [] }, /non-empty list/],
    ['unsupported version', { version: 3, invariants: [entry('a')] }, /unsupported "version" 3/],
    ['id not a slug', { version: 1, invariants: [entry('Not A Slug')] }, /kebab-case slug/],
    ['config escapes the directory', { version: 1, invariants: [entry('a', { config: '../../etc/passwd' })] }, /outside/],
    ['absolute config', { version: 1, invariants: [entry('a', { config: '/etc/passwd' })] }, /relative/],
    ['missing scenario file', { version: 1, invariants: [entry('a', { config: 'nope.yaml' })] }, /does not exist/],
    ['not JSON', '{ version: 1', /not valid JSON/],
  ];
  for (const [name, manifest, pattern] of cases) {
    const ws = makeWorkspace(manifest);
    await assert.rejects(discover(ws.manifestPath),
      (err) => err instanceof ManifestError && pattern.test(err.message), name);
  }
});

test('a symlinked config may not lead outside the manifest directory', async () => {
  const ws = makeWorkspace({ version: 1, invariants: [entry('a', { config: 'link.yaml' })] });
  const outside = path.join(ws.root, 'secret.yaml');
  fs.writeFileSync(outside, 'name: secret\n');
  fs.symlinkSync(outside, path.join(ws.dir, 'link.yaml'));
  await assert.rejects(discover(ws.manifestPath), /resolves outside/);
});

test('a missing manifest is a manifest error', async () => {
  await assert.rejects(discover('/nonexistent/manifest.json'),
    (err) => err instanceof ManifestError && /cannot read/.test(err.message));
});
