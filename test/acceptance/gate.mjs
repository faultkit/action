// Gate for the acceptance fixtures. Invariant: a ticket is stored as triaged
// only when the model classified it. Usage: node gate.mjs guarded|unguarded|idle
import { triage } from './app.mjs';

const mode = process.argv[2];
if (mode === 'idle') process.exit(0); // makes no model call, so no fault can fire
const record = await triage('Checkout is down for every customer', { guarded: mode === 'guarded' });
if (record.status === 'triaged' && record.source !== 'model') {
  console.error(`SILENT FAILURE: stored as triaged by ${record.source}`);
  process.exit(1);
}
console.log(`invariant holds: ticket ${record.status}`);
