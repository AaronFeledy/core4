# PRD: BETA1-04 — Setup, uninstall & release remediation

## Introduction

PRD-ALPHA4-01 (setup & uninstall) and PRD-ALPHA4-08/-09/-10 (release, supply chain, installers) shipped with five acceptance shortfalls:

1. **Plugin `setup.flags` are declared but dead.** `sdk/src/schema/plugin.ts` defines the `setup.flags` contribution, and PRD-ALPHA4-01 US-200 AC-4 requires "Provider plugins can add setup flags through `setup.flags`, and those flags appear in command metadata and parsing tests" — but `core/src/cli/oclif/commands/meta/setup.ts` only hardcodes built-in flags; there is no merge path.
2. **Uninstall leaves provider machines behind.** `core/src/cli/commands/uninstall.ts` marks `managed-provider-machines` as `manual`, so a `--purge` uninstall does not tear down Lando-owned provider machines.
3. **The resumable report can vanish.** The uninstall report is skipped when `userDataRoot` was already purged, so a failure *after* destructive removal leaves no resumable report — contradicting "Partial failures leave a resumable uninstall report".
4. **macOS/Windows managed runtime falls back to system tooling.** `plugins/provider-lando/src/setup.ts` falls back to `makeSystemPodmanMachineRunner(undefined, …)` and reads `process.env.LANDO_TEST_PODMAN_SOCKET` when no socket is injected, instead of the bundled-Podman managed-machine path required by US-363..367. Linux is end-to-end; mac/win are thinner than their green flags imply.
5. **Release automation is dev-prerelease only.** `.github/workflows/release.yml` runs a Linux dev prerelease + npm alpha publish; nothing in CI invokes the 13-stage `scripts/release.ts` pipeline (signing, notarization, SBOM, provenance, installer signing, publish). If that is intentional pre-GA staging, no decision record says so.

## Source References

- [`spec/alpha-4/prd-alpha-4-01-setup-and-uninstall.md`](../alpha-4/prd-alpha-4-01-setup-and-uninstall.md) US-200, US-206, US-363..US-367.
- [`spec/alpha-4/prd-alpha-4-08-release-and-signing.md`](../alpha-4/prd-alpha-4-08-release-and-signing.md) — 13-stage pipeline requirements.
- [`spec/15-binary-build-and-release.md`](../15-binary-build-and-release.md) §17 release machinery and acceptance ladder.
- [`spec/11-subsystems.md`](../11-subsystems.md) §10.9 setup/doctor behaviors.
- [`spec/ROADMAP.md`](../ROADMAP.md) — RC gate owns the all-platform acceptance pass.

## Goals

- Make the declared plugin setup-flag contribution real end-to-end (schema → command metadata → parsing → plugin handler).
- Make `lando uninstall` actually complete its destructive contract (machines torn down, report always written).
- Close the mac/win managed-runtime gap or explicitly re-scope it with spec/PRD text.
- Record and implement the release-automation posture for Beta.

## User Stories

### US-384: Merge plugin `setup.flags` into `lando setup`

**Description:** As a provider-plugin author, flags I contribute through `setup.flags` appear in `lando setup --help`, parse correctly, and reach my setup subscriber — on both the OCLIF source path and the compiled binary path.

**Acceptance Criteria:**

- [ ] Bundled provider plugins' `setup.flags` contributions are merged into the `meta:setup` command metadata (help output, flag parsing) at the static OCLIF command surface; runtime-discovered plugin contributions are collision-checked at plugin load and dynamic external-flag parsing is deferred to a later two-phase parser story.
- [ ] Parsed plugin flag values are delivered to the contributing plugin's setup handler.
- [ ] Parsing tests cover a contributed flag (presence in metadata, value round-trip, unknown-flag rejection), fulfilling PRD-ALPHA4-01 US-200 AC-4.
- [ ] Source-dispatch and `runCompiledCli` behave identically (parity test), respecting the compiled manifest constraints in `core/AGENTS.md`.
- [ ] Cold-start budget holds: flag merging must not force plugin loading before the setup command actually runs.
- [ ] Tests pass
- [ ] Typecheck passes
- [ ] Lint passes

### US-385: Uninstall tears down Lando-owned provider machines

**Description:** As a user running `lando uninstall --purge`, Lando-owned provider machines (the managed Podman machine/socket) are stopped and removed automatically, not listed for manual cleanup.

**Acceptance Criteria:**

- [ ] The uninstall plan executes teardown for provider machines Lando created (stop the managed socket/service, remove the machine/VM state) instead of marking `managed-provider-machines` as `manual`.
- [ ] Machines *not* owned by Lando (system Docker/Podman) are never touched; ownership is determined from recorded setup state, and ambiguous ownership degrades to `manual` with remediation text.
- [ ] The uninstall report records each machine action (removed / skipped-not-owned / failed with remediation).
- [ ] Idempotency: re-running uninstall after a partial machine teardown converges without error.
- [ ] Scenario tests cover owned-machine removal and not-owned skip on the test provider; live provider integration remains env-gated per repo convention.
- [ ] Tests pass
- [ ] Typecheck passes
- [ ] Lint passes

### US-386: Uninstall report survives purge failures

**Description:** As a user whose `lando uninstall --purge` fails partway, I always get a resumable report telling me what was removed and what remains, even when `userDataRoot` itself is already gone.

**Acceptance Criteria:**

- [ ] The report writer no longer silently skips when `userDataRoot` was purged: the report is written to a fallback location that survives the purge (e.g. the OS temp dir or the invoking directory), and its path is printed in the failure output.
- [ ] The report content still enumerates completed, failed, and remaining steps with remediation, and a re-run consumes/reconciles it.
- [ ] A test simulates a step failure after `userDataRoot` removal and asserts a resumable report exists at the fallback path.
- [ ] Report writing itself routes through the sanctioned atomic-write helper (post-US-372).
- [ ] Tests pass
- [ ] Typecheck passes
- [ ] Lint passes

### US-387: macOS/Windows managed runtime uses bundled Podman machine tooling

**Description:** As a macOS or Windows user, `lando setup` stands up the Lando-managed runtime with the *bundled* Podman machine tooling and the Lando-owned socket — never by falling back to system Podman machine tooling or a test environment variable.

**Acceptance Criteria:**

- [ ] The mac/win `ensureRuntime` path in `plugins/provider-lando/src/setup.ts` resolves the machine runner from the installed runtime bundle (Paths-driven binaries), removing the `makeSystemPodmanMachineRunner(undefined, …)` production fallback.
- [ ] `process.env.LANDO_TEST_PODMAN_SOCKET` is honored only in explicit test wiring, never as a production fallback in the setup path (mirror the Linux socket-resolution precedence: explicit option > injected paths > managed default).
- [ ] Machine lifecycle (init/start/socket resolution/restart-on-stale) works from the bundled tooling; recorded setup state includes the machine identity and socket path needed for idempotent re-detection and for US-385 teardown.
- [ ] When the runtime bundle lacks machine tooling for the host platform, setup fails with a tagged remediation error naming the bundle/platform — it does not silently use system tooling.
- [ ] Unit/scenario coverage runs against fake runners for both platforms; live verification on real mac/win hosts is recorded via the provider-integration CI jobs (`provider-integration-darwin-*`, `provider-integration-windows-*`).
- [ ] Tests pass
- [ ] Typecheck passes
- [ ] Lint passes

### US-388: Release-automation posture is decided and wired

**Description:** As a maintainer preparing `4.0.0-beta.N`, CI can produce the full signed release (13-stage `scripts/release.ts`: build, sign, notarize, SBOM, provenance, installer signing, publish) — or, if beta releases are deliberately manual, that decision is recorded where the RC acceptance criteria will collect it.

**Acceptance Criteria:**

- [ ] A decision record lands (in this story's notes and the PRD-ALPHA4-08 open-questions section): full pipeline in CI for Beta, or manual invocation until RC.
- [ ] If CI: the release workflow generator (`scripts/build-release-workflow.ts`) emits a workflow that invokes the `scripts/release.ts` orchestrator with credential-gated signing stages (skipping cleanly with warnings when credentials are absent), and the generated workflow is committed via codegen with drift check clean.
- [ ] If manual-until-RC: the release runbook documents the exact invocation, required credentials, and verification steps, and the generated workflow's scope (dev prerelease only) is stated in the workflow header comment.
- [ ] Either way, the per-platform binary jobs and the release workflow reference the same platform id vocabulary (`windows-x64` CI/release domain vs `win32-x64` runtime host key preserved).
- [ ] Tests pass
- [ ] Typecheck passes
- [ ] Lint passes

## Functional Requirements

- **FR-1:** Every contribution surface declared in the SDK plugin schema is either consumed by the runtime or removed from the schema — no dead declared surfaces.
- **FR-2:** Uninstall's destructive modes complete their contract or degrade with explicit remediation; a report is always produced on failure.
- **FR-3:** Production setup paths never read test-only environment variables.
- **FR-4:** The release pipeline's CI posture is an explicit, recorded decision, not an accident of what got wired.

## Non-Goals

- No new setup subsystems or providers.
- No all-platform §17.9 acceptance pass — that remains the RC gate per the roadmap.
- No installer script feature work (channel resolution and verification shipped and were verified green in the audit).

## Technical Considerations

- Flag merging happens at the OCLIF metadata boundary; the compiled manifest is generated (`codegen:oclif-manifest`), so dynamic plugin flags must merge at runtime parse time on both paths, not at manifest generation time.
- US-385 teardown depends on setup state recorded by US-387 (machine identity); implement US-387's state recording first or land the state shape in a shared preparatory commit.
- Machine teardown on Windows may require elevation; route through the existing privilege service used by setup rather than shelling out directly.

## Success Metrics

- A fixture plugin contributing a setup flag shows it in `lando setup --help` on both dispatch paths.
- `lando uninstall --purge` on a Lando-managed host leaves no running machine and always writes a report on failure.
- `grep -rn "LANDO_TEST_PODMAN_SOCKET" plugins/provider-lando/src` shows test-wiring-only usage.

## Guide Coverage

| Surface | Guide | Status |
| --- | --- | --- |
| `lando setup` provider flags (mac/win managed runtime) | `docs/guides/setup/provider-selection.mdx` | Update — re-run drift gate after US-384/US-387 |
| `lando uninstall` walkthrough | owned by PRD-ALPHA4-01's guide surface | Update — re-run drift gate after US-385/US-386 |

## Open Questions

- Is a partial mac/win managed-machine path acceptable for Beta 1 with full parity at RC? If so, US-387's scope must be cut down *in the PRD text*, not silently.
- Who owns release credentials (Apple notarization, Windows cert, cosign identity) for CI, and are they available before RC? This gates the US-388 decision.
