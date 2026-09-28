import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ValuesError, checkOutcomes, parseValues } from '../src/values.js';

// The fixtures are copied from faultkit/skills tests/fixtures/values: the JSON
// is Python's dataclasses.asdict, so the keys are snake_case.
const FIXTURES = fileURLToPath(new URL('./fixtures/values/', import.meta.url));
const read = (dir) => fs.readdirSync(path.join(FIXTURES, dir)).filter((f) => f.endsWith('.md')).sort();
const asFixture = (v) => ({
  business_value: v.businessValue, outcomes: v.outcomes, out_of_scope: v.outOfScope,
  workflow: v.workflow, domains: v.domains, owner: v.owner, inferred: v.inferred,
});

test('the fixture sets are complete', () => {
  assert.equal(read('valid').length, 7);
  assert.equal(read('invalid').length, 13);
});

for (const file of read('valid')) {
  test(`valid fixture ${file} parses to its JSON`, () => {
    const text = fs.readFileSync(path.join(FIXTURES, 'valid', file), 'utf8');
    const expected = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'valid', file.replace(/\.md$/, '.json')), 'utf8'));
    assert.deepEqual(asFixture(parseValues(text, 'values.md')), expected);
  });
}

for (const file of read('invalid')) {
  test(`invalid fixture ${file} names its line`, () => {
    const text = fs.readFileSync(path.join(FIXTURES, 'invalid', file), 'utf8');
    const expected = fs.readFileSync(path.join(FIXTURES, 'invalid', file.replace(/\.md$/, '.error')), 'utf8').trim();
    assert.throws(() => parseValues(text, 'values.md'), (err) => err instanceof ValuesError && err.message === expected);
  });
}

test('CRLF reads like LF', () => {
  const text = fs.readFileSync(path.join(FIXTURES, 'valid', 'full.md'), 'utf8');
  assert.deepEqual(parseValues(text.replace(/\n/g, '\r\n')), parseValues(text));
});

test('a blank outcome text is not an outcome', () => {
  assert.throws(() => parseValues('## Business value\nv\n## Unacceptable outcomes\n- UO-1:  \n'), ValuesError);
});

test('a frontmatter key named like an Object property is an ordinary key', () => {
  const v = parseValues('---\nconstructor: x\nowner: team\n---\n## Business value\nv\n## Unacceptable outcomes\n- UO-1: a\n');
  assert.equal(v.owner, 'team');
});

const values = parseValues('## Business value\nv\n## Unacceptable outcomes\n- UO-1: a\n- UO-2: b\n');

test('declared outcomes pass the check', () => {
  assert.doesNotThrow(() => checkOutcomes([{ id: 'x', outcome: 'UO-2' }, { id: 'y', outcome: null }], values, 'values.md'));
});

test('an undeclared outcome is an error', () => {
  assert.throws(() => checkOutcomes([{ id: 'x', outcome: 'UO-3' }], values, 'values.md'), /x: outcome UO-3 is not declared/);
});

test('an outcome with no values file is a dangling reference', () => {
  assert.throws(() => checkOutcomes([{ id: 'x', outcome: 'UO-1' }], null, '.faultkit/values.md'), /dangling outcome reference/);
  assert.doesNotThrow(() => checkOutcomes([{ id: 'x', outcome: null }], null, null));
});
