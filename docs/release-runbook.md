# Release runbook

Beta posture: the full signed release is run **manually**, not from CI, until RC. See the "Release-automation posture" entry in `docs/beta-1-decisions.md` for the decision and rationale. The generated `release` workflow (`.github/workflows/release.yml`) is scoped to dev prereleases only: it republishes the ci-built `linux-x64` binary as a `v4.0.0-dev.N` GitHub prerelease and publishes npm `dev`-tag packages. It never signs, notarizes, or publishes a stable release.

Use this runbook to drive the 13-stage orchestrator (`scripts/release.ts`) by hand when cutting `4.0.0-beta.N`.

## Invocation

The orchestrator is `bun run release` (`scripts/release.ts`). Pass the artifact target and, optionally, a stage prefix.

```bash
# Full release, all artifact families (binary + library), every stage in order.
bun run release -- --all

# Binary-only release (skips the library-bundle stage).
bun run release -- --binary

# Library-only release (skips compile, strip, sign, notarize).
bun run release -- --library

# Stop after a named stage (ordered prerequisites still run; prefixes only, no --from-stage).
bun run release -- --binary --through-stage=7-compile
```

Stages run in order and are numbered `1-codegen`, `2-typecheck`, `3-lint-format`, `4-test-gates`, `5-schema-artifacts`, `6-library-bundle`, `7-compile`, `8-strip`, `9-sign`, `10-notarize`, `11-manifest`, `12-provenance-sbom`, `13-publish`. `--through-stage` accepts a stage id or its leading number.

### Platform scope

By default the orchestrator targets every CI platform (`darwin-arm64`, `darwin-x64`, `linux-arm64`, `linux-x64`, `windows-x64`). Scope a run to one platform with `LANDO_RELEASE_PLATFORM`, using the CI/release platform id:

```bash
LANDO_RELEASE_PLATFORM=windows-x64 bun run release -- --binary
```

`windows-x64` is the CI/release artifact vocabulary. The `win32-x64` runtime host key is a separate domain (runtime bundle and mutagen host keys) and must not be used here.

### Rehearsal without credentials

`LOCAL_REHEARSAL=1` scopes the run to the host platform and turns credential-gated stages into warning-skips instead of hard failures, so you can exercise the ordering locally without any signing material:

```bash
LOCAL_REHEARSAL=1 bun run release -- --all
LOCAL_REHEARSAL=1 bun run release -- --library --through-stage=11-manifest
```

See `docs/guides/release/local-rehearsal.mdx` for the rehearsal contract and `docs/guides/release/linux-acceptance-rehearsal.mdx` for the Linux acceptance walkthrough.

## Required credentials

Outside `LOCAL_REHEARSAL`, the signing and publishing stages require the environment below. Each row lists the accepted variables and the stage that consumes them; absence fails that stage (except where local rehearsal warning-skips apply).

| Stage | Purpose | Environment |
| --- | --- | --- |
| `9-sign` (macOS) | Developer ID codesign | `LANDO_RELEASE_SIGNING_IDENTITY` |
| `9-sign` (Windows) | Authenticode + keyless cosign | `LANDO_RELEASE_WINDOWS_CERTIFICATE`, `ACTIONS_ID_TOKEN_REQUEST_TOKEN`, `ACTIONS_ID_TOKEN_REQUEST_URL` |
| `10-notarize` (macOS) | notarytool submit + stapler | `LANDO_RELEASE_APPLE_KEYCHAIN_PROFILE` |
| `11-manifest` | Checksum manifest signing | `LANDO_RELEASE_GPG_KEY` or `GPG_PRIVATE_KEY`; keyless manifest signing reuses `ACTIONS_ID_TOKEN_REQUEST_TOKEN` + `ACTIONS_ID_TOKEN_REQUEST_URL` |
| `12-provenance-sbom` | SBOM + SLSA provenance + keyless signatures | `ACTIONS_ID_TOKEN_REQUEST_TOKEN`, `ACTIONS_ID_TOKEN_REQUEST_URL` |
| `13-publish` (npm) | Publish workspace packages | `LANDO_RELEASE_NPM_TOKEN` or `NPM_TOKEN` |
| `13-publish` (GitHub) | Create the GitHub release | `GH_TOKEN` or `GITHUB_TOKEN` |

Keyless signing (`ACTIONS_ID_TOKEN_REQUEST_*`) is an OIDC identity issued to a GitHub Actions job. Running signed manifest/provenance stages fully outside Actions requires an equivalent keyless identity; use `LOCAL_REHEARSAL=1` to rehearse those stages locally.

Credential ownership (Apple notarization, Windows certificate, cosign/OIDC identity) must be assigned before RC. Until then, keep the full pipeline manual so a run either produces a genuinely signed release or fails closed, rather than a CI job that silently warning-skips every signing stage.

## Verification

A release is only complete when its artifacts verify. Confirm, per stage output and on disk:

1. Checksums: `dist/SHA256SUMS` and `dist/SHA512SUMS` exist and match the built binaries (`sha256sum -c dist/SHA256SUMS`).
2. Binary smoke: each compiled binary runs and reports the expected version (`./dist/lando-<platform> --version`).
3. Signatures: macOS artifacts are Developer ID signed, notarized, and stapled; Windows artifacts carry an Authenticode signature; checksum manifests carry detached signatures. Follow `docs/guides/release/signing-artifacts.mdx`.
4. Supply chain: every publishable artifact has a matching SBOM and SLSA provenance attestation, and the keyless signatures verify against the pinned identity and OIDC issuer. Follow `docs/guides/release/verify-supply-chain-artifacts.mdx`.
5. npm: the published packages resolve on the intended dist-tag and did not move the `latest` tag (`npm view @lando/core dist-tags`).
6. GitHub release: the release exists with the expected assets attached.

## Related guides

- `docs/guides/release/local-rehearsal.mdx` — stage-prefix and credential-gating rehearsal contract.
- `docs/guides/release/signing-artifacts.mdx` — per-platform signing responsibilities and commands.
- `docs/guides/release/verify-supply-chain-artifacts.mdx` — SBOM and provenance verification.
- `docs/guides/release/linux-acceptance-rehearsal.mdx` — Linux acceptance rehearsal.
- `docs/guides/release/compiled-bytecode-budget.mdx` — compile-stage bytecode budget.
