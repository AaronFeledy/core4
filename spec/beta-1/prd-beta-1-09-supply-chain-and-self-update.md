# PRD: BETA1-09 — Supply chain & self-update

## Introduction

Beta 1 adds verifiable release artifacts and a safe self-update path. Every published artifact gets SBOM coverage, keyless provenance, and signature checks. `lando update` then consumes the signed update manifest, verifies downloaded artifacts before trusting them, replaces binaries atomically, and rolls back when launch probes fail.

This PRD depends on PRD-08's release pipeline. It fills §17.5 supply-chain requirements and §17.6 self-update behavior for the Beta 1 release train.

## Source References

- [`spec/15-binary-build-and-release.md`](../15-binary-build-and-release.md) §17.5 supply-chain artifacts.
- [`spec/15-binary-build-and-release.md`](../15-binary-build-and-release.md) §17.6 self-update flow.
- [`spec/15-binary-build-and-release.md`](../15-binary-build-and-release.md) §17.6.1 update manifest schema and channel URLs.
- [`spec/15-binary-build-and-release.md`](../15-binary-build-and-release.md) §17.6.2 POSIX and Windows replacement behavior.
- [`spec/beta-1/prd-beta-1-00-index.md`](./prd-beta-1-00-index.md) PRD-09 range, dependency on PRD-08, and verification contract.

## Goals

- Publish a CycloneDX SBOM for every release artifact.
- Publish SLSA v1.0 provenance attestations signed keylessly through GitHub Actions OIDC.
- Make every binary cosign-verifiable through published identity and issuer details.
- Add signed update manifests for `stable`, `next`, and `dev` channels.
- Replace POSIX binaries atomically with launch-probe and rollback safety.
- Handle Windows running-exe replacement without corrupting the current binary.
- Report update telemetry only as redacted success and failure categories.

## User Stories

### US-258: Each release artifact includes a CycloneDX SBOM

**Description:** As a security reviewer, I can inspect a CycloneDX SBOM for every published Lando artifact.

**Acceptance Criteria:**
- [ ] The release pipeline emits `dist/lando-${V}-sbom.cdx.json` for each binary artifact and the library archive.
- [ ] SBOM files use CycloneDX JSON format and include artifact name, version, checksum, component list, and tool metadata.
- [ ] Stage 12 fails if any publishable artifact lacks a matching SBOM.
- [ ] Release manifest entries link each artifact to its SBOM path and checksum.
- [ ] Tests cover SBOM naming, required fields, missing-SBOM failure, and manifest linkage.
- [ ] Tests pass
- [ ] Typecheck passes
- [ ] Lint passes

### US-259: Release provenance uses SLSA v1.0 keyless cosign through OIDC

**Description:** As a downstream verifier, I can confirm that published artifacts came from the official GitHub Actions release workflow.

**Acceptance Criteria:**
- [ ] Stage 12 emits SLSA v1.0 provenance attestations for every published artifact.
- [ ] Provenance attestations are keyless-signed with cosign using GitHub Actions OIDC.
- [ ] Attestations include builder identity, source ref, commit SHA, artifact digest, workflow path, and release version.
- [ ] CI fails release mode if OIDC identity or issuer does not match the configured release workflow.
- [ ] Tests cover attestation payload shape, OIDC issuer configuration, and missing-attestation failure without requiring live OIDC.
- [ ] Tests pass
- [ ] Typecheck passes
- [ ] Lint passes

### US-260: Binary signatures are verified in CI and documented in release notes

**Description:** As a user downloading a binary, I can run the published verification command and get the same success CI proved before publish.

**Acceptance Criteria:**
- [ ] Every binary gets a keyless cosign signature before publish.
- [ ] CI runs `cosign verify-blob` for every published binary using the configured OIDC identity and issuer.
- [ ] Release notes publish each binary's signature, certificate, and exact verification command.
- [ ] Publish fails if any binary cannot be verified with the published command.
- [ ] Tests cover release-note command rendering, identity / issuer mismatch, and missing-signature failure.
- [ ] Tests pass
- [ ] Typecheck passes
- [ ] Lint passes

### US-261: `lando update` resolves a channel and verifies a signed manifest before trusting it

**Description:** As a user, I can run `lando update` and know the update metadata was verified before Lando downloads or replaces anything.

**Acceptance Criteria:**
- [ ] `meta:update` and top-level `lando update` resolve channels `stable`, `next`, and `dev`.
- [ ] Manifest URLs are `https://update.lando.dev/v4/{stable,next,dev}.json`.
- [ ] `UpdateManifestSchema` validates channel, version, minimum, artifact URLs, checksums, signatures, and platform entries.
- [ ] The manifest sibling `.sig` is verified before any manifest fields are trusted.
- [ ] A signed manifest older than the newest signed manifest previously observed for that channel is refused as possible replay.
- [ ] The `minimum` field blocks auto-update for binaries that are too old and prints manual update remediation.
- [ ] Tests pass
- [ ] Typecheck passes
- [ ] Lint passes

### US-262: POSIX self-update replaces the binary atomically and re-execs

**Description:** As a POSIX user, a successful update downloads, verifies, probes, atomically swaps the binary, and restarts into the new version.

**Acceptance Criteria:**
- [ ] POSIX update downloads to a temp file in the target filesystem and verifies checksum plus signature before execution.
- [ ] A launch probe runs the downloaded binary before replacement.
- [ ] Replacement uses `rename(2)` and preserves a `.bak` rollback file.
- [ ] Successful replacement runs `execve(2)` into the updated binary with the expected argv and environment.
- [ ] Tests cover temp-file placement, checksum failure, signature failure, launch probe success, rename behavior, and re-exec argument preservation.
- [ ] Tests pass
- [ ] Typecheck passes
- [ ] Lint passes

### US-263: Failed launch probes restore `.bak` and raise `UpdateLaunchProbeError`

**Description:** As a user, if the downloaded binary cannot start, Lando restores the previous binary and tells me what failed.

**Acceptance Criteria:**
- [ ] Failed launch probe restores the `.bak` binary before returning control to the user.
- [ ] Launch probe failures surface `UpdateLaunchProbeError` with platform, attempted version, probe command, and redacted output summary.
- [ ] Rollback failure is reported separately and never hides the original probe error.
- [ ] The update cache records the failed category without storing paths, hostnames, or user identifiers.
- [ ] Tests cover probe failure, successful rollback, rollback failure, and redacted error rendering.
- [ ] Tests pass
- [ ] Typecheck passes
- [ ] Lint passes

### US-264: Windows self-update handles running `.exe` replacement safely

**Description:** As a Windows user, updating a running Lando executable uses a delayed swap or spawn-and-exit flow instead of trying to overwrite the locked executable.

**Acceptance Criteria:**
- [ ] Windows update detects the running `.exe` lock and avoids direct overwrite.
- [ ] The update flow supports delayed swap or spawn-and-exit replacement with a verified downloaded binary.
- [ ] If the delayed swap cannot be scheduled, Lando prints exact manual fallback instructions.
- [ ] Windows replacement preserves rollback behavior where the platform permits it.
- [ ] Tests cover locked-exe detection, swap helper invocation, fallback instruction rendering, and failure mapping.
- [ ] Tests pass
- [ ] Typecheck passes
- [ ] Lint passes

### US-265: Update permission errors and telemetry are safe and actionable

**Description:** As a user without write permission to the install path, I get exact manual remediation and Lando never silently elevates.

**Acceptance Criteria:**
- [ ] EACCES during download placement, replacement, backup, or rollback surfaces `UpdatePermissionError`.
- [ ] `UpdatePermissionError` includes exact manual sudo or UAC remediation for the detected install path without running elevation itself.
- [ ] Update never invokes sudo, UAC, or `PrivilegeService` silently.
- [ ] Update telemetry reports success and failure categories only.
- [ ] Telemetry payloads do not include paths, hostnames, user IDs, full URLs with tokens, or raw command output.
- [ ] Tests pass
- [ ] Typecheck passes
- [ ] Lint passes

## Functional Requirements

- FR-1: Every release artifact MUST have a CycloneDX SBOM named `dist/lando-${V}-sbom.cdx.json` or an artifact-specific equivalent linked from the release manifest.
- FR-2: Every release artifact MUST have SLSA v1.0 provenance keyless-signed with cosign through GitHub Actions OIDC.
- FR-3: Every binary MUST have a keyless cosign signature.
- FR-4: CI MUST run `cosign verify-blob` for every published binary using the published OIDC identity and issuer.
- FR-5: Release notes MUST publish signature, certificate, and verification command details.
- FR-6: `lando update` MUST resolve `stable`, `next`, and `dev` to `https://update.lando.dev/v4/{stable,next,dev}.json`.
- FR-7: Update manifests MUST be validated by `UpdateManifestSchema` and verified through a sibling `.sig` before fields are trusted.
- FR-8: The manifest `minimum` field MUST block auto-update for too-old binaries.
- FR-8a: A signed update manifest MUST NOT move a channel below the newest signed version previously observed by that local install.
- FR-9: POSIX update MUST use temp download, launch probe, checksum and signature verification, `rename(2)`, `.bak` rollback, and `execve(2)`.
- FR-10: Failed launch probes MUST restore `.bak` and surface `UpdateLaunchProbeError`.
- FR-11: Windows update MUST use delayed swap or spawn-and-exit replacement for running `.exe` files.
- FR-12: EACCES MUST surface `UpdatePermissionError` with manual sudo or UAC remediation and no silent elevation.
- FR-13: Update telemetry MUST contain only redacted success and failure categories.

## Non-Goals

- Implementing installer scripts or installer trust roots in this PRD.
- Supporting package-manager updates through Homebrew, scoop, winget, distro packages, or OCI images.
- Auto-elevating update permissions.
- Adding downgrade or arbitrary version selection beyond channel-based update.
- Publishing host-specific paths, hostnames, or user identifiers in telemetry or release notes.

## Technical Considerations

- Treat manifest verification as the trust root for update metadata; no URL from the manifest should be used before signature verification.
- Keep platform replacement code split behind a shared verified-download and launch-probe pipeline.
- Make launch probes cheap and deterministic, such as invoking the downloaded binary with a version command.
- Keep telemetry fire-and-forget and category-only so update failure handling never depends on network telemetry.
- Store update cache entries with stable schemas so doctor can report recent update failures later without exposing sensitive host data.

## Success Metrics

- CI proves `cosign verify-blob` succeeds for every binary before publish.
- A tampered update manifest is rejected before any artifact download starts.
- A POSIX launch-probe failure restores `.bak` in tests and reports `UpdateLaunchProbeError`.
- Windows locked-exe tests prove direct overwrite is never attempted.

## Guide Coverage

Per [Beta 1 index verification](./prd-beta-1-00-index.md) and the §19 guide convention, this PRD owns the executable guides listed below. Each guide exercises the happy path of its mapped user story; failure modes remain covered by unit and integration tests in the named packages. PRs that touch the listed surface paths MUST also touch the corresponding guide(s), or use the `Guide-Coverage-Skip:` escape hatch.

**Guides owned by this PRD:**

| User Story | Feature | Guide Path | Acceptance |
|---|---|---|---|
| US-258, US-259, US-260 | Verifying release artifacts | `docs/guides/release/verify-supply-chain-artifacts.mdx` | Required at story acceptance |
| US-261 | Update channels and signed manifests | `docs/guides/update/channels-and-manifests.mdx` | Required at story acceptance |
| US-262, US-263 | POSIX update and rollback | `docs/guides/update/posix-atomic-update.mdx` | Required at story acceptance |
| US-264 | Windows update flow | `docs/guides/update/windows-update-flow.mdx` | Required at story acceptance |
| US-265 | Update permission remediation | `docs/guides/update/permission-errors.mdx` | Required at story acceptance |

**CLI / source surface paths covered (drift gate input):**

- `scripts/release.ts`
- `scripts/release/**`
- `core/src/self-update/**`
- `core/src/cli/commands/update.ts`
- `core/src/cli/commands/meta/update*`
- `core/src/cli/run.ts`
- `sdk/src/schema/update-manifest.ts`
- `core/src/telemetry/**`
- `sdk/src/**/update*`
- `sdk/src/**/supply*`
- `.github/workflows/ci.yml`

## Open Questions

- Should `lando update` default to the binary's current channel or always `stable` when no channel is passed? Default: current channel.
- What is the exact GitHub Actions OIDC subject string for release verification? Default: the release workflow on protected release tags.
- Should failed update telemetry be sent before rollback or after rollback completes? Default: after rollback completes or fails, so category reflects final outcome.
- Should `minimum` block print installer guidance or GitHub Releases guidance first? Default: installer guidance for supported platforms, GitHub Releases as fallback.
