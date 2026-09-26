# faultkit/action

GitHub Action that replays the invariants the
[faultkit skill](https://github.com/faultkit/skills) keeps in
`.faultkit/invariants/` and posts the proof table on the pull request.

**Status: not released.** Until v1 ships, CI replays the same proofs with the
helper step in [CI usage](https://faultkit.dev/docs/ci/).

## Planned usage

```yaml
# .github/workflows/faultkit.yml
- uses: faultkit/action@v1
```

It replays every invariant in `.faultkit/invariants/manifest.json` under its
fault and fails the job unless each one is proven.

## License

Apache-2.0, like [faultkit](https://github.com/faultkit/faultkit).
