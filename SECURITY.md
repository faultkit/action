# Security Policy

## Reporting a vulnerability

Report vulnerabilities through GitHub's private vulnerability reporting on
this repository — open the **Security** tab on `faultkit/action` and choose
**Report a vulnerability**. Do not report a vulnerability in a public issue.

## Supported versions

The latest `v1.x` release is supported.

## Security properties

The maintainers treat the following as security properties of this action,
not incidental behavior:

- **Pinned sha256.** The action downloads the one faultkit release this
  version of the action pins, and verifies the downloaded archive's sha256
  against a value embedded in `src/binary.js` before running it. A mismatch
  is a hard failure.
- **No shell.** faultkit itself and each invariant's `gate` run as argv
  arrays with `shell: false`. Manifest and workflow content is never
  interpolated into a shell command.
- **Config path containment.** A manifest's `config` path is resolved
  relative to the manifest's own directory and, after symlinks are
  resolved, must still be inside that directory's real path. A manifest
  cannot point `config` outside it.
- **The gate's environment is scrubbed, but it is not a sandbox.** The gate
  and faultkit run without the action's own inputs (including
  `github-token`), the runner's `ACTIONS_*` tokens, and this step's workflow
  command files in their environment, but the gate — the pull request
  author's own code — still runs as the same user as the action. The real
  protection is the `pull_request` trigger: a fork's token is read-only and
  its secrets are withheld. Workflows should set `persist-credentials: false`
  on the checkout step, so the job token is never written to `.git/config`,
  where the gate could read it.
- **No telemetry.** The action makes no network calls beyond downloading
  the pinned faultkit release and, when `github-token` is set, calling the
  GitHub API to manage the PR comment.
- **The PR comment is the action's only GitHub mutation.** It does not open
  issues, push commits, create checks, or write anything else to the
  repository or the API.
