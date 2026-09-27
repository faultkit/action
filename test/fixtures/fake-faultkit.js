#!/usr/bin/env node
// Stand-in for the faultkit binary. It appends its argv and env names to
// $FAKE_FAULTKIT_LOG, writes a report/v1 file, and exits with the code the
// test chose for the scenario in $FAKE_FAULTKIT_PLAN:
//   { "<config file name or builtin>": { "exit": 1, "fired": 2, "report": true, "schema": "…" } }
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null);
const key = flag('--config') ? path.basename(flag('--config')) : flag('--scenario');
const plan = { exit: 0, fired: 1, report: true, ...(JSON.parse(process.env.FAKE_FAULTKIT_PLAN ?? '{}')[key] ?? {}) };

if (process.env.FAKE_FAULTKIT_LOG) {
  fs.appendFileSync(process.env.FAKE_FAULTKIT_LOG, `${JSON.stringify({ args, env: Object.keys(process.env).sort() })}\n`);
}
const report = flag('--report');
if (report && plan.report) {
  fs.writeFileSync(report, JSON.stringify({
    schema: plan.schema ?? 'faultkit.dev/report/v1',
    scenario: key,
    target: args.slice(args.indexOf('--') + 1),
    target_exit: plan.exit === 1 ? 1 : 0,
    events: Array.from({ length: plan.fired }, (_, i) => ({ experiment: `e${i}`, fired: true })),
  }));
}
process.exit(plan.exit);
