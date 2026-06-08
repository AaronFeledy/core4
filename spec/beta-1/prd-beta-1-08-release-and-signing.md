# PRD: BETA1-08 — Release engineering & code signing

## Introduction

Beta 1 turns the release script from partial machinery into the ordered release orchestrator for signed `4.0.0-beta.N` artifacts on the `next` channel. The release flow has one entry point, `scripts/release.ts`, and a fixed 13-stage order that covers codegen, gates, bundles, compiled binaries, signing, notarization, manifests, provenance, SBOMs, and publish.

This PRD covers §17.1 through §17.4 and the release-time deprecation gate from §18.7. Supply-chain attestations, self-update, and installers are covered by later Beta 1 PRDs but depend on this pipeline shape.

## Source References

- [`spec/15-binary-build-and-release.md`](../15-binary-build-and-release.md) §17.1 build pipeline and single orchestrator.
- [`spec/15-binary-build-and-release.md`](../15-binary-build-and-release.md) §17.2 codegen catalog.
- [`spec/15-binary-build-and-release.md`](../15-binary-build-and-release.md) §17.3 asset embedding.
- [`spec/15-binary-build-and-release.md`](../15-binary-build-and-release.md) §17.4 code signing and notarization.
- [`spec/16-deprecation-and-surface-evolution.md`](../16-deprecation-and-surface-evolution.md) §18.7 release-time `removeIn` enforcement.
- [`spec/beta-1/prd-beta-1-00-index.md`](./prd-beta-1-00-index.md) PRD-08 range, dependencies, local rehearsal rule, and verification contract.

## Goals

- Provide one release orchestrator that runs the 13 stages in the spec order.
- Stop releases at the first failed stage with tagged, actionable release errors.
- Split binary and library artifact families without reordering shared stages.
- Let maintainers rehearse release prefixes locally without secrets.
- Wire the deprecation gate immediately after codegen.
- Sign and notarize platform artifacts with the correct platform-specific tooling.
- Keep one-target cold release rehearsal under the linux-x64 budget.

## User Stories

### US-251: `scripts/release.ts` runs the 13-stage pipeline in order

**Description:** As a release manager, I can start one script and trust it to run the required release stages in the fixed order.

**Acceptance Criteria:**
- [ ] `scripts/release.ts` defines the 13 ordered stages: Codegen, Type-check, Lint/format, Test gates, Schema artifacts, Library bundle, Compile, Strip, Sign, Notarize, Manifest, Provenance & SBOM, Publish.
- [ ] Stages may be skipped per artifact family but cannot be reordered by CLI flags or config.
- [ ] Shell-shaped stages use `Bun.$`; argv-precise tools use `Bun.spawn`.
- [ ] Any stage failure halts the pipeline and reports a tagged release error with stage id, artifact family, command summary, and remediation.
- [ ] Unit tests prove stage ordering, halt behavior, and shell-vs-argv runner selection.
- [ ] Tests pass
- [ ] Typecheck passes
- [ ] Lint passes

### US-252: Artifact-family stage split and local rehearsal behavior are explicit

**Description:** As a maintainer, I can rehearse part of a release locally and know which stages apply to binaries, libraries, and credential-gated work.

**Acceptance Criteria:**
- [ ] Compiled binaries run stages 1 through 5 and 7 through 13.
- [ ] The library package runs stages 1 through 6 and 11 through 13.
- [ ] Local rehearsal can run any prefix without secrets.
- [ ] With `LOCAL_REHEARSAL=1`, stage 9 (sign), stage 10 (notarize), the GPG/cosign signing performed inside stage 11 (manifest), stage 12 (provenance & SBOM), and stage 13 (publish) skip with warnings when credentials are absent; the non-signing portion of stage 11 (writing `SHA256SUMS`/`SHA512SUMS`/`update-manifest.json`) still runs.
- [ ] Stage 7 can compile the maintainer's current platform locally without cross-platform signing secrets.
- [ ] Tests pass
- [ ] Typecheck passes
- [ ] Lint passes

### US-253: The deprecation gate runs after codegen and before type-check

**Description:** As a maintainer, I cannot release a version that still contains surfaces whose `removeIn` version has arrived.

**Acceptance Criteria:**
- [ ] `scripts/check-deprecations.ts` runs immediately after stage 1 Codegen and before stage 2 Type-check.
- [ ] The release fails if any deprecation notice has `removeIn` matching or preceding the release version.
- [ ] The failure lists each offending surface, declaration file, `removeIn` value, and the expected removal action.
- [ ] Local rehearsal runs the same deprecation gate as CI.
- [ ] Tests include a synthetic expired deprecation fixture and verify the gate blocks release.
- [ ] Tests pass
- [ ] Typecheck passes
- [ ] Lint passes

### US-254: macOS artifacts are Developer ID signed, notarized, and stapled

**Description:** As a macOS user, I receive a binary that passes Gatekeeper checks because the release pipeline signs, notarizes, and staples it.

**Acceptance Criteria:**
- [ ] Darwin x64 and arm64 binaries are signed with the configured Developer ID identity.
- [ ] Signed macOS artifacts are submitted through `notarytool submit` with credential-gated execution.
- [ ] Successful notarization runs `stapler staple` and verifies the stapled ticket.
- [ ] Missing macOS credentials skip only in local rehearsal and fail in CI release mode.
- [ ] Tests cover command construction, credential gating, and tagged errors without requiring live Apple credentials.
- [ ] Tests pass
- [ ] Typecheck passes
- [ ] Lint passes

### US-255: Windows artifacts are Authenticode signed and cosign signed

**Description:** As a Windows user, I receive an Authenticode-signed binary with an additional cosign signature for release verification.

**Acceptance Criteria:**
- [ ] Windows binaries are signed with `signtool` using configured certificate material.
- [ ] The signed Windows binary receives a cosign signature as part of the Sign stage.
- [ ] Missing Windows signing credentials skip only in local rehearsal and fail in CI release mode.
- [ ] Verification commands confirm Authenticode status and cosign signature presence before Manifest generation.
- [ ] Tests cover `signtool` argument construction, cosign invocation, and failure mapping.
- [ ] Tests pass
- [ ] Typecheck passes
- [ ] Lint passes

### US-256: Linux artifacts publish GPG and cosign signed checksum manifests

**Description:** As a Linux user, I can verify downloaded binaries through a signed checksum manifest and cosign signature.

**Acceptance Criteria:**
- [ ] Linux release artifacts produce a `SHA256SUMS` manifest (in the Manifest stage, stage 11) covering linux-x64 and linux-arm64 binaries.
- [ ] `SHA256SUMS` and `SHA512SUMS` are generated and GPG-signed in the Manifest stage (stage 11) when release credentials are present — Linux is signed at the manifest layer, not in the Sign stage (stage 9), per §17.1.
- [ ] `SHA256SUMS` is cosign-signed in the Provenance & SBOM stage (stage 12) per §17.5 (keyless cosign; see PRD-09 US-260).
- [ ] Verification confirms checksum coverage and both the GPG and cosign signatures before the Publish stage (stage 13).
- [ ] Tests cover manifest generation, missing binary failure, GPG command construction, cosign command construction, and local rehearsal skipping.
- [ ] Tests pass
- [ ] Typecheck passes
- [ ] Lint passes

### US-257: Compiled binaries use `--bytecode` and stay within the cold-build budget

**Description:** As a maintainer, I can compile Beta 1 binaries with Bun bytecode enabled and catch release-time build slowdowns early.

**Acceptance Criteria:**
- [ ] Stage 7 Compile invokes `bun build --compile --bytecode` against the canonical compiled entry.
- [ ] Compile targets preserve the Beta 1 platform ids from the generated CI workflow.
- [ ] A perf guard measures one-target cold build time on reference linux-x64 and fails above 10 minutes.
- [ ] Local rehearsal reports compile duration even when later signing stages are skipped.
- [ ] Tests verify `--bytecode` is present and that the budget guard reports tagged failures.
- [ ] Tests pass
- [ ] Typecheck passes
- [ ] Lint passes

## Functional Requirements

- FR-1: `scripts/release.ts` MUST be the single release orchestrator for Beta 1 release artifacts.
- FR-2: The orchestrator MUST define and run the 13 spec stages in order.
- FR-3: Stage failures MUST halt the pipeline with tagged release errors.
- FR-4: Shell-shaped stages MUST use `Bun.$`; argv-precise tools MUST use `Bun.spawn`.
- FR-5: Binary artifacts MUST run stages 1 through 5 and 7 through 13.
- FR-6: Library artifacts MUST run stages 1 through 6 and 11 through 13.
- FR-7: `scripts/check-deprecations.ts` MUST run after Codegen and before Type-check.
- FR-8: Local rehearsal MUST run prefixes without secrets and warn when credential-gated stages are skipped.
- FR-9: macOS binaries MUST be Developer ID signed, notarized with `notarytool`, and stapled.
- FR-10: Windows binaries MUST be Authenticode signed with `signtool` and cosign signed.
- FR-11: Linux binaries MUST be covered by GPG-signed and cosign-signed `SHA256SUMS`.
- FR-12: Compiled binaries MUST be built with `--bytecode`.
- FR-13: One-target cold compile on reference linux-x64 MUST remain under 10 minutes.

## Non-Goals

- Implementing SBOM generation, SLSA provenance, self-update, or installer scripts in this PRD.
- Releasing all-platform RC acceptance. Beta 1 requires linux-x64 release machinery to be implemented and green.
- Supporting release tooling outside Bun.
- Adding Homebrew, scoop, winget, distro, or OCI publication paths.
- Changing platform ids or generated CI workflow semantics.

## Technical Considerations

- Model stages as data so tests can assert order, artifact-family applicability, and local rehearsal behavior without invoking live tools.
- Keep signing command construction separated from credential lookup so unit tests can cover arguments safely.
- Treat local rehearsal skips as warnings, not successful signing, so CI release mode cannot accidentally skip credential-gated stages.
- Stage 11 Manifest must depend on prior signing outputs because later PRDs use it for self-update and installers.
- Keep release errors tagged and schema-friendly so CI summaries and future release notes can render them consistently.

## Success Metrics

- `LOCAL_REHEARSAL=1` can run through Compile for the maintainer's platform and then warn-skip credential-gated stages.
- A synthetic expired deprecation blocks release before type-check begins.
- Signing-stage tests cover macOS, Windows, and Linux command paths without real signing credentials.
- One-target linux-x64 cold compile reports under the 10 minute budget.

## Guide Coverage

Per [Beta 1 index verification](./prd-beta-1-00-index.md) and the §19 guide convention, this PRD owns the executable guides listed below. Each guide exercises the happy path of its mapped user story; failure modes remain covered by unit and integration tests in the named packages. PRs that touch the listed surface paths MUST also touch the corresponding guide(s), or use the `Guide-Coverage-Skip:` escape hatch.

**Guides owned by this PRD:**

| User Story | Feature | Guide Path | Acceptance |
|---|---|---|---|
| US-251, US-252 | Release orchestrator rehearsal | `docs/guides/release/local-rehearsal.mdx` | Required at story acceptance |
| US-253 | Deprecation gate in release | `docs/guides/release/deprecation-gate.mdx` | Required at story acceptance |
| US-254, US-255, US-256 | Platform signing overview | `docs/guides/release/signing-artifacts.mdx` | Required at story acceptance |
| US-257 | Bytecode compile and budget | `docs/guides/release/compiled-bytecode-budget.mdx` | Required at story acceptance |

**CLI / source surface paths covered (drift gate input):**

- `scripts/release.ts`
- `scripts/check-deprecations.ts`
- `scripts/release/**`
- `scripts/build-ci-workflow.ts`
- `core/bin/lando.ts`
- `core/src/version.ts`
- `core/build.config.ts`
- `.github/workflows/ci.yml`
- `.github/workflows/nightly.yml`

## Open Questions

- Should release rehearsal support `--from-stage` as well as prefix execution? Default: no, only prefixes, because ordered prereqs matter.
- Should signing command logs include full tool paths? Default: include tool basename and redacted args only.
- Should the 10 minute budget measure Compile alone or Codegen through Compile? Default: Compile alone for US-257, with broader release timing tracked later.
