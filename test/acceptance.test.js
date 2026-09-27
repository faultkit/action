import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { main } from '../src/index.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const skip = process.env.FAULTKIT_ACCEPTANCE === '1' ? false : 'set FAULTKIT_ACCEPTANCE=1 to download faultkit and run the fixtures';
const outputs = (file) => Object.fromEntries(fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => l.split(/=(.*)/s).slice(0, 2)));

// counts is failed/invalid/not-generated.
for (const [name, threshold, expected, counts] of [
  ['all-proven', '100', 'passed', '0/0/0'],
  ['coverage-gap', '100', 'failed', '0/0/1'],
  ['coverage-gap', '60', 'passed', '0/0/1'],
  ['regression', '0', 'failed', '1/0/0'],
  ['never-fires', '0', 'failed', '0/1/0'],
]) {
  test(`acceptance: ${name} at threshold ${threshold} is ${expected}`, { skip }, async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'faultkit-acceptance-'));
    const output = path.join(tmp, 'output');
    fs.writeFileSync(output, '');
    const env = {
      PATH: process.env.PATH, HOME: process.env.HOME, GITHUB_WORKSPACE: ROOT, RUNNER_TEMP: tmp, GITHUB_OUTPUT: output,
      INPUT_MANIFEST: `test/acceptance/${name}/.faultkit/invariants/manifest.json`, INPUT_THRESHOLD: threshold,
    };
    const code = await main(env);
    const out = outputs(output);
    assert.equal(out.result, expected);
    assert.equal(`${out.failed}/${out.invalid}/${out['not-generated']}`, counts);
    assert.equal(code, expected === 'passed' ? 0 : 1);
  });
}
