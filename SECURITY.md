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
  resolved, must still be inside that directory. A manifest cannot point
  `config` outside it.
- **Gate environment scrubbing.** The gate and faultkit run with the job's
  environment minus the action's own inputs (including `github-token`), the
  runner's `ACTIONS_*` tokens, and this step's workflow command files. The
  gate is the pull request author's own code.
- **No telemetry.** The action makes no network calls beyond downloading
  the pinned faultkit release and, when `github-token` is set, calling the
  GitHub API to manage the PR comment.
- **The PR comment is the action's only GitHub mutation.** It does not open
  issues, push commits, create checks, or write anything else to the
  repository or the API.
