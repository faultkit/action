import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { main } from '../src/index.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const skip = process.env.FAULTKIT_ACCEPTANCE === '1' ? false : 'set FAULTKIT_ACCEPTANCE=1 to download faultkit and run the fixtures';

for (const [name, threshold, expected] of [
  ['all-proven', '100', 'passed'],
  ['coverage-gap', '100', 'failed'],
  ['coverage-gap', '60', 'passed'],
  ['regression', '0', 'failed'],
  ['never-fires', '0', 'failed'],
]) {
  test(`acceptance: ${name} at threshold ${threshold} is ${expected}`, { skip }, async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'faultkit-acceptance-'));
    const output = path.join(tmp, 'output');
    fs.writeFileSync(output, '');
    const env = {
      PATH: process.env.PATH, HOME: process.env.HOME, GITHUB_WORKSPACE: ROOT, RUNNER_TEMP: tmp, GITHUB_OUTPUT: output,
      INPUT_MANIFEST: `test/acceptance/${name}/.faultkit/invariants/manifest.json`, INPUT_THRESHOLD: threshold,
    };
    await main(env);
    assert.equal(/^result=(.*)$/m.exec(fs.readFileSync(output, 'utf8'))[1], expected);
  });
}
