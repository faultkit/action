import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  INVALID_EVIDENCE, NOT_GENERATED, PROVEN, SILENT_FAILURE, parseThreshold, proofState, summarize,
} from '../src/results.js';

test('proof state follows run_faultkit.py', () => {
  const cases = [
    [0, 1, PROVEN],
    [1, 2, SILENT_FAILURE],
    [0, 0, INVALID_EVIDENCE],
    [1, 0, INVALID_EVIDENCE],
    [3, 0, INVALID_EVIDENCE],
    [2, 0, 'error: faultkit exited 2'],
    [4, 0, 'error: faultkit exited 4'],
  ];
  for (const [exit, fired, want] of cases) assert.equal(proofState(exit, fired), want, `exit ${exit}, fired ${fired}`);
});

const rows = (spec) => Object.entries(spec).flatMap(([state, n]) =>
  Array.from({ length: n }, (_, i) => ({ id: `inv-${state.length}-${i}`, state })));

test('threshold decides coverage only; failures, invalid evidence, and errors always fail', () => {
  const cases = [
    ['10/10 proven at 100', { [PROVEN]: 10 }, 100, 'passed', 100],
    ['8 proven + 2 not generated at 80', { [PROVEN]: 8, [NOT_GENERATED]: 2 }, 80, 'passed', 80],
    ['8 proven + 2 not generated at 81', { [PROVEN]: 8, [NOT_GENERATED]: 2 }, 81, 'failed', 80],
    ['9 proven + 1 silent failure at 50', { [PROVEN]: 9, [SILENT_FAILURE]: 1 }, 50, 'failed', 90],
    ['9 proven + 1 invalid at 50', { [PROVEN]: 9, [INVALID_EVIDENCE]: 1 }, 50, 'failed', 90],
    ['9 proven + 1 error at 0', { [PROVEN]: 9, 'error: faultkit exited 2': 1 }, 0, 'error', 90],
    ['2 proven + 1 not generated at 100', { [PROVEN]: 2, [NOT_GENERATED]: 1 }, 100, 'failed', 66.67],
    ['2 proven + 1 not generated at 60', { [PROVEN]: 2, [NOT_GENERATED]: 1 }, 60, 'passed', 66.67],
    ['2 proven + 1 silent failure at 0', { [PROVEN]: 2, [SILENT_FAILURE]: 1 }, 0, 'failed', 66.67],
  ];
  for (const [name, spec, threshold, result, score] of cases) {
    const s = summarize(rows(spec), threshold);
    assert.equal(s.result, result, name);
    assert.equal(s.score, score, name);
  }
});

test('the summary counts every bucket', () => {
  const s = summarize(rows({ [PROVEN]: 7, [NOT_GENERATED]: 1 }), 80);
  assert.deepEqual(
    [s.total, s.proven, s.failed, s.invalid, s.errors, s.notGenerated, s.score, s.threshold],
    [8, 7, 0, 0, 0, 1, 87.5, 80],
  );
});

test('the threshold input is a number from 0 to 100, default 100', () => {
  assert.equal(parseThreshold(''), 100);
  assert.equal(parseThreshold('80'), 80);
  assert.equal(parseThreshold('66.5'), 66.5);
  for (const bad of ['-1', '101', 'abc', '1e2', '50%']) assert.throws(() => parseThreshold(bad), RangeError, bad);
});
