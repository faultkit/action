# faultkit/action

## What it does

faultkit/action replays the invariants recorded in `.faultkit/invariants/manifest.json`
under the faults they were built to prove, using one pinned, sha256-verified
faultkit release. It reports every invariant's proof state in the job log,
the GitHub Job Summary, and one optional pull request comment, and it gates
the workflow on a configurable proof-coverage threshold.

> The agent discovers the invariant once. Faultkit deterministically proves
> it on every relevant CI run.

## Usage

`v1.0.0` has not been released yet, so every `faultkit/action@<full-commit-sha>`
below is a placeholder. Replace `<full-commit-sha>` with the commit SHA of
the release you pin once one exists, and keep the version comment in sync.

With a PR comment (needs `pull-requests: write` and a token):

```yaml
name: Faultkit

on:
  pull_request:

permissions:
  contents: read
  pull-requests: write

jobs:
  resilience:
    runs-on: ubuntu-latest
    timeout-minutes: 15

    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          persist-credentials: false

      # Install what your gates need first, e.g. actions/setup-node + npm ci,
      # or actions/setup-python + pip install -r requirements.txt.

      - name: Prove resilience invariants
        uses: faultkit/action@<full-commit-sha> # v1.0.0
        with:
          manifest: .faultkit/invariants/manifest.json
          threshold: 100
          github-token: ${{ github.token }}
```

Without a comment, and with a lower threshold:

```yaml
name: Faultkit

on:
  pull_request:

permissions:
  contents: read

jobs:
  resilience:
    runs-on: ubuntu-latest
    timeout-minutes: 15

    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          persist-credentials: false

      # Install what your gates need first, e.g. actions/setup-node + npm ci,
      # or actions/setup-python + pip install -r requirements.txt.

      - name: Prove resilience invariants
        uses: faultkit/action@<full-commit-sha> # v1.0.0
        with:
          threshold: 80
```

Both examples trigger on `pull_request`, never `pull_request_target` — see
[Security](#security).

## Inputs

All inputs are optional.

| Input | Description | Default |
|---|---|---|
| `manifest` | Path to the invariant manifest, relative to the repository root. | `.faultkit/invariants/manifest.json` |
| `threshold` | Minimum proof score from 0 to 100: proven invariants over all known invariants, including those with no generated fault. A silent failure, invalid evidence, or an error fails the run at any threshold. | `100` |
| `github-token` | Used only to create or update the PR comment. Without it the comment is skipped. | — |
| `faultkit-path` | Run this faultkit binary instead of downloading the release this action pins. | — |

## Outputs

| Output | Description |
|---|---|
| `result` | `passed`, `failed`, or `error`. |
| `score` | Proven invariants as a percentage of all known invariants. |
| `threshold` | The threshold the score was compared with. |
| `total` | Invariants in the manifest. |
| `proven` | Invariants proven under fault. |
| `failed` | Invariants with a confirmed silent failure. |
| `invalid` | Invariants whose fault was never injected. |
| `not-generated` | Invariants with no generated fault scenario. |
| `reports-directory` | Where the faultkit report/v1 files are, relative to the repository root. |

## Threshold

`threshold` is the minimum proof score, from 0 to 100: proven invariants
divided by all known invariants, including invariants with no generated
fault (see [Manifest](#manifest)).

`threshold: 100` means every known invariant must have a generated scenario
and be proven; an invariant with no generated fault fails the run.

`threshold: 80` allows up to 20% of known invariants to lack fault coverage
without failing the run. It never permits a confirmed silent failure,
invalid evidence (a fault that was never injected), or an execution error —
those fail the run at any threshold, including 0.

## Manifest

The manifest is the file the [faultkit skill](https://github.com/faultkit/skills)
keeps at `.faultkit/invariants/manifest.json` (or wherever `manifest:`
points). It lists every invariant the skill has discovered, whether or not a
deterministic fault scenario could be generated for it.

**Version 1** manifests list only invariants that already have a scenario.
The action reads every entry as `fault_status: generated`; setting
`fault_status` on a version 1 entry is an error.

**Version 2** manifests add `fault_status`, which must be set per invariant
to `generated` or `not_generated`.

A `generated` invariant needs exactly one of `config` (a scenario file) or
`scenario` (a builtin faultkit scenario), and a `gate` — the test command,
as a list of arguments:

```json
{
  "version": 2,
  "invariants": [
    {
      "id": "paid-invoice-never-escalated",
      "invariant": "A paid invoice is never sent to collections.",
      "shape": "S3",
      "fault_status": "generated",
      "config": "paid-invoice-never-escalated.yaml",
      "base_url": false,
      "mode": "auto",
      "gate": [
        "pytest",
        "-q",
        "tests/test_paid_invoice.py"
      ]
    }
  ]
}
```

A builtin `scenario:` entry fires probabilistically, so a run can end as
invalid evidence — the fault simply didn't fire that time — with nothing
wrong. Prefer a `config` scenario with `probability: 1.0` when the manifest
entry is meant to be a proof, not a sample.

A `not_generated` invariant has no `config` and no `scenario`. It requires
`fault_reason` instead: a non-empty explanation of why no deterministic
fault could be built. It still counts toward the manifest's total, so it
lowers the score, and fails the run unless the threshold has enough slack
to absorb it:

```json
{
  "id": "human-approval-is-always-recorded",
  "invariant": "Every regulated action has a recorded human approval.",
  "shape": "S8",
  "fault_status": "not_generated",
  "fault_reason": "No deterministic injectable boundary was identified."
}
```

`config` is always a path relative to the manifest's own directory, and must
resolve inside it. This is checked after symlinks are resolved, so an
absolute path, a `..` escape, or a symlink that resolves outside that
directory fails the manifest closed.

## Security

- **Pin the action to a full commit SHA.** A tag or branch can move; a
  commit SHA cannot.
- **Use `pull_request`, never `pull_request_target`.** The danger with
  `pull_request_target` is checking out and running the pull request's code
  — which is what the gate does — while the workflow still holds that
  trigger's write token and secrets.
- **Network access is limited to two things:** downloading the one pinned
  faultkit release, and, only when `github-token` is set, calling the GitHub
  API to manage the PR comment. Nothing else — no telemetry, no other
  outbound calls.
- **The gate's environment is scrubbed, but it is not a sandbox.** Each
  invariant's `gate`, and faultkit itself, run without the action's own
  inputs (including `github-token`), the runner's `ACTIONS_*` tokens, and
  this step's workflow command files (`GITHUB_OUTPUT`, `GITHUB_STEP_SUMMARY`,
  `GITHUB_STATE`, `GITHUB_ENV`, `GITHUB_PATH`) in their environment. That
  keeps the token out of casual reach, but the gate still runs as the same
  user as the action — the real protection is the trigger. On
  `pull_request`, a fork's token is read-only and its secrets are withheld.
  Keep `persist-credentials: false` on the checkout step (see the examples
  above), so the job token is never written to `.git/config`, where the gate
  could read it.
- **The PR comment is matched by a hidden marker.** Anyone can comment on a
  pull request, so the action never trusts comment ownership by text alone —
  it updates the first comment whose author is a bot account (any bot
  account, not only a comment this action wrote) and whose body carries the
  marker. Use the workflow's `github.token` or a GitHub App token as
  `github-token`. A personal access token is authored by a human account, so
  the bot check never matches an old comment, and the action posts a new
  comment on every run instead of updating one.
- **All jobs on a pull request share one comment.** If more than one job in
  a workflow (or more than one workflow) runs this action on the same PR,
  the last one to finish overwrites the others' report, so pass
  `github-token` from one job only. A `concurrency:` group on the workflow
  keeps two runs of the same workflow from each creating their own comment.
- **`faultkit-path` bypasses the sha256 pin.** Use it only with a binary you
  trust. On `pull_request`, a path inside the checkout is controlled by the
  pull request.

## Network

- **The release download redirects.** It starts at github.com and redirects
  to GitHub's release-asset host. An egress allowlist, including on GHES,
  needs to permit both.
- **The gate keeps its own network access.** The gate is your application;
  this action does not restrict what it can reach.

## Limits

- **Windows runners are not supported.** faultkit ships Linux and macOS
  binaries for amd64 and arm64 only; the run fails with an error when a
  generated invariant needs the faultkit binary on an unsupported platform.
- **Invariants with `mode: ebpf` need a privileged runner.** Without one,
  faultkit exits with an error, and the invariant's row reports that error —
  it never passes silently.
- **There is no per-invariant timeout.** Set the job's `timeout-minutes`, as
  in the examples above.
- **The PR comment and the job summary are capped.** GitHub limits them to
  60,000 and 1,000,000 UTF-8 bytes respectively. A report with more than 25
  invariants collapses the full table into a `<details>` block, with rows
  that need attention left visible above it. If a report would still
  exceed its cap, rows that need attention are kept first and the rest
  become "…and N more" — the full list is always in the job log. An error
  message inside the Markdown is cut at 2,000 characters.

## Updating the pinned faultkit

This action pins one faultkit version and verifies its release archive by
sha256 before running it; it does not float to `latest`. To move the pin to
a new faultkit release:

1. Download that release's `checksums.txt` and `checksums.txt.sigstore.json`
   from the faultkit release page.
2. Verify them (needs cosign v2.4 or newer):
   ```shell
   cosign verify-blob \
     --bundle checksums.txt.sigstore.json \
     --certificate-identity cenk.kalpakoglu@gmail.com \
     --certificate-oidc-issuer https://accounts.google.com \
     checksums.txt
   ```
3. Copy the four `sha256` lines — `linux-amd64`, `linux-arm64`,
   `darwin-amd64`, `darwin-arm64` — into `src/binary.js`.
4. Bump `FAULTKIT_VERSION` and the asset file names in `src/binary.js` to
   match the new release.
5. Release a new version of this action.

## License

Apache-2.0, like [faultkit](https://github.com/faultkit/faultkit).
