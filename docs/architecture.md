# Architecture

## Pipeline

```text
Manifest / Scenario Source
          |
          v
Normalized Invariant Plan
          |
          v
Faultkit Binary Resolver
          |
          v
Deterministic Proof Runner
          |
          v
Proof Results
     /          \
Console       GitHub
table         summary/comment
          |
          v
Threshold / CI verdict
```

In `src/index.js`: a `ScenarioSource`'s `discover()` produces the plan
(`src/manifest.js`); the binary resolver (`src/binary.js`) resolves the
faultkit binary to run — skipped entirely when no invariant in the plan
needs a generated fault; the runner (`src/runner.js`) runs each invariant
and derives its proof state (`src/results.js`); the renderer
(`src/markdown.js`) turns the results into the console table, the job
summary, and the PR comment; and the aggregator (`src/results.js`) turns
them into the threshold verdict that sets the exit code.

## Modules

| File | Responsibility |
|---|---|
| `src/main.js` | Entry point: calls `main()` unconditionally — no "am I the main module?" guard that could skip it. |
| `src/index.js` | Runs the pipeline: reads the inputs, writes the log, the job summary, the outputs, and the comment, and returns the exit code. The only module that reads `process.env`. |
| `src/manifest.js` | Manifest schema parsing, v1 compatibility, v2 validation, normalization into the invariant plan. |
| `src/binary.js` | Platform mapping, the fixed release URL, download, sha256 verification, safe tar extraction. |
| `src/runner.js` | Runs faultkit, which runs the gate — one child process per invariant — reads `report/v1`, and derives the proof state. |
| `src/results.js` | Aggregates proof states, calculates the score, applies threshold and hard-failure logic. |
| `src/markdown.js` | Renders the prove-all table, the job summary, and the PR comment. |
| `src/github.js` | Locates the PR, finds the existing marker comment, creates or updates it. The action's only GitHub mutation. |

## The `ScenarioSource` interface

A `ScenarioSource` is anything that can discover invariants and hand back a
plan: conceptually, `discover(context) → InvariantPlan`. v1 implements
exactly one: `ManifestScenarioSource`, in `src/manifest.js`, which reads and
validates the manifest file. Its `discover()` takes no arguments today — the
manifest path is bound in its constructor, so there is no `context` to pass
yet. A future source would need one, since it would have to receive things
a fixed file path doesn't carry, such as PR metadata or an API token.

The `InvariantPlan` it returns is a `source` tag, the manifest's `version`,
and a list of normalized invariants — each with an `id`, the `invariant`
statement, a `faultStatus` of `generated` or `not_generated`, and, when
generated, enough to run it: `config` or `scenario`, `mode`, `baseUrl`,
`provider`, and `gate`.

## Future scenario sources — design only, not implemented

v1 implements manifest replay only. The interface above is shaped to let
these sit alongside `ManifestScenarioSource` later, without changing the
replay engine. None of the following exists in the code today.

### Future A: a local coding agent

```text
PR
 |
 v
Claude / Codex / compatible coding agent
 |
 v
Faultkit skill
 |
 v
discover invariants
generate deterministic scenarios
update manifest
 |
 v
normal Faultkit replay
```

A `LocalAgentScenarioSource` would invoke a user-provided coding-agent
command to discover invariants and update the manifest before replay. The
core replay engine (`src/runner.js`, `src/results.js`) must not hardcode
Claude, Codex, or any other agent.

### Future B: a customer's LLM provider

```text
ProviderLLMScenarioSource
       |
       +-- OPENAI_API_KEY
       +-- ANTHROPIC_API_KEY
       +-- custom endpoint
       |
       v
Invariant discovery / scenario generation
       |
       v
Normalized manifest
       |
       v
existing deterministic replay engine
```

A customer would supply a provider identifier, an API endpoint, a model
name, and an API token through GitHub Secrets, so this source could call an
LLM to discover invariants and generate scenarios.

The design constraint: those variables must reach that source and nothing
else. `src/runner.js`'s `childEnv()` builds the environment the gate and
faultkit see, and anything in it can end up in the log, the faultkit
report, the job summary, or the PR comment — so a provider's token must
never be added there. An allowlist inside a process that also runs the gate
cannot keep a key from that gate: whatever that process can read from its
own environment, it can also pass down to the child process it spawns.
Provider keys need isolation at the step or job level instead — one step or
job holds the key and calls the provider, and a later one runs the replay
engine and the gate without that key in its environment anywhere. Design
only, not implemented.

### Future C: faultkit Cloud

```text
GitHub Action
     |
     v
Faultkit Cloud
     |
     +-- analyze repository/PR metadata
     +-- generate invariants/scenarios
     +-- return signed/validated manifest
     |
     v
local deterministic Faultkit replay
```

Possible future interaction:

```text
POST /runs
POST /webhooks/github
GET /manifests/<id>
```

A `CloudScenarioSource` would fetch or validate a manifest from a hosted
service and hand it to the same replay engine every other source uses.
Cloud concerns stay outside the deterministic runner.

## What the replay engine never sees

`src/runner.js` and `src/results.js` — the deterministic replay engine —
read only the normalized invariant plan's fields: `id`, `invariant`,
`faultStatus`, `config`/`scenario`, `mode`, `baseUrl`, `provider`, `gate`,
`faultReason`. They never read `InvariantPlan.source` or anything about
where an invariant was discovered. An invariant replays the same way
whether it came from a human editing the manifest by hand, the faultkit
skill, a coding agent, a future LLM provider, or faultkit Cloud.
