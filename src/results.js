// Proof states and the CI verdict. The strings and the proof-state rule match
// run_faultkit.py in faultkit/skills; change them together or not at all.

export const PROVEN = 'invariant proven under fault';
export const SILENT_FAILURE = 'silent failure confirmed';
export const INVALID_EVIDENCE = 'invalid evidence: nothing was injected';
export const NOT_GENERATED = 'fault not generated';

export const EXIT_OK = 0;
export const EXIT_TARGET_FAILED = 1;
export const EXIT_FAULT_NOT_FIRED = 3;

/** The proof state of one faultkit run, from its exit code and the faults its report says fired. */
export function proofState(exitCode, fired) {
  const nothingInjected =
    exitCode === EXIT_FAULT_NOT_FIRED ||
    (fired === 0 && (exitCode === EXIT_OK || exitCode === EXIT_TARGET_FAILED));
  if (nothingInjected) return INVALID_EVIDENCE;
  if (exitCode === EXIT_TARGET_FAILED) return SILENT_FAILURE;
  if (exitCode === EXIT_OK) return PROVEN;
  return `error: faultkit exited ${exitCode}`;
}

export const NO_INVARIANT = 'no invariant yet';
/** Worst first. */
export const SEVERITY = { error: 0, failed: 1, invalid: 2, not_generated: 3, proven: 4 };

/** The bucket a proof state counts in. Every "error: …" state is an error. */
export function kind(state) {
  switch (state) {
    case PROVEN: return 'proven';
    case SILENT_FAILURE: return 'failed';
    case INVALID_EVIDENCE: return 'invalid';
    case NOT_GENERATED: return 'not_generated';
    default: return 'error';
  }
}

/** The threshold input: a number from 0 to 100, 100 when empty. */
export function parseThreshold(raw) {
  const text = String(raw ?? '').trim();
  if (text === '') return 100;
  if (!/^\d+(\.\d+)?$/.test(text) || Number(text) > 100) {
    throw new RangeError(`threshold must be a number from 0 to 100, got "${text}"`);
  }
  return Number(text);
}

/** The worst of several proof states; on a tie, the first. */
export function worstState(states) {
  return states.reduce((worst, s) => (SEVERITY[kind(s)] < SEVERITY[kind(worst)] ? s : worst));
}

/**
 * Outcome coverage, as run_faultkit.py prints it: each declared outcome in id
 * order, the invariants that name it, and their worst state (null: none does).
 */
export function coverage(values, rows) {
  const outcomes = [...values.outcomes]
    .sort((a, b) => Number(a.id.slice(3)) - Number(b.id.slice(3)))
    .map((o) => {
      const linked = rows.filter((r) => r.outcome === o.id);
      return {
        id: o.id, text: o.text, invariants: linked.map((r) => ({ id: r.id, state: r.state })),
        worst: linked.length ? worstState(linked.map((r) => r.state)) : null,
      };
    });
  const covered = outcomes.filter((o) => o.worst !== null).length;
  return {
    outcomes, declared: outcomes.length, covered, uncovered: outcomes.length - covered,
    unlinked: rows.filter((r) => !r.outcome).length, inferred: values.inferred,
  };
}

/**
 * Aggregate rows into the verdict. Not-generated invariants stay in the
 * denominator, so a coverage gap lowers the score. A silent failure, invalid
 * evidence, or an error fails the run whatever the threshold. With
 * failOnUncovered, a declared outcome no invariant names fails it like a
 * threshold miss.
 */
export function summarize(rows, threshold, { uncovered = 0, failOnUncovered = false } = {}) {
  if (rows.length === 0) return errorSummary('the manifest lists no invariants', threshold);
  const counts = { proven: 0, failed: 0, invalid: 0, error: 0, not_generated: 0 };
  for (const row of rows) counts[kind(row.state)] += 1;
  const total = rows.length;
  const score = total === 0 ? 0 : Math.round((counts.proven / total) * 10000) / 100;
  const belowThreshold = counts.proven * 100 < threshold * total;
  const uncoveredFails = failOnUncovered && uncovered > 0;
  let result = 'passed';
  if (counts.error > 0) result = 'error';
  else if (counts.failed > 0 || counts.invalid > 0 || belowThreshold || uncoveredFails) result = 'failed';
  return {
    result, score, threshold, total,
    proven: counts.proven, failed: counts.failed, invalid: counts.invalid,
    errors: counts.error, notGenerated: counts.not_generated, belowThreshold, uncovered, uncoveredFails, message: null,
  };
}

/** The verdict when nothing could run: a bad input, manifest, or binary. */
export function errorSummary(message, threshold) {
  return {
    result: 'error', score: 0, threshold, total: 0,
    proven: 0, failed: 0, invalid: 0, errors: 0, notGenerated: 0, belowThreshold: false,
    uncovered: 0, uncoveredFails: false, message,
  };
}
