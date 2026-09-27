// The action's entry point. It always runs the check: there is no
// "am I the main module?" guard that could skip it and exit 0.
import { main } from './index.js';

process.exitCode = await main();
