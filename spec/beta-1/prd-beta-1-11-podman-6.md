# PRD: BETA1-11 — Podman 6 runtime contract

## Introduction

Beta 1 now makes Podman 6 the runtime floor for both Podman-backed providers. The normative spec already requires `@lando/provider-lando`'s bundled runtime and `@lando/provider-podman`'s user-installed runtime to gate on Podman >= 6.0.0 with numeric `major.minor.patch` comparison and pre-release/build suffixes ignored; it also drops unsupported upstream stacks: Intel macOS, Windows 10, cgroups v1, iptables, CNI, and `slirp4netns`.

This PRD turns that contract into decision-complete future implementation work. It does not implement product behavior. It scopes the required changes to version gates, libpod API prefixing, Podman machine semantics, runtime-bundle target fallout, CI provider integration, pull/health/OOM/volume semantics, managed-machine trust behavior, and managed `containers.conf` loopback binding. Where source evidence conflicts, the story carries an explicit acceptance path and the conflict remains in Open Questions.

## Source References

- [`spec/05-runtime-providers.md`](../05-runtime-providers.md) §5.8.1 and §5.8.3 — Podman >= 6.0.0 runtime floor, suffix-ignored numeric comparison, Apple Silicon macOS/Windows 11+/cgroups v2/nftables/Pasta + Netavark/Aardvark v2 contract, and machine command spelling caveat.
- [`spec/13-testing-and-distribution.md`](../13-testing-and-distribution.md) §13.5 — four shipped binary platform ids and provider integration expectations.
- [`spec/15-binary-build-and-release.md`](../15-binary-build-and-release.md) §17.2 and §17.8 — runtime-bundle manifest/codegen and generated workflow ownership.
- [`prd-beta-1-10-runtime-bundle-publishing.md`](./prd-beta-1-10-runtime-bundle-publishing.md) US-410..US-412 — four runtime host keys only (`linux-x64`, `linux-arm64`, `darwin-arm64`, `win32-x64`), Podman 6 bundle line, `passt`/pasta, Netavark/Aardvark v2.x, and generated runtime-bundle workflow invariants.
- `plugins/provider-lando/src/setup.ts:29-31` — current `MINIMUM_PODMAN_VERSION = "4.9.0"` anchor to bump.
- `plugins/provider-lando/src/setup.ts:438-455` and `plugins/provider-lando/src/setup.ts:657-707` — current CLI-version/API-info version extraction paths.
- `plugins/provider-lando/src/setup.ts:279-329` — current managed machine argv seam (`machine init`, `machine start`, `machine os apply`, `machine rm`).
- `plugins/provider-lando/src/capabilities.ts:74-100` and `plugins/provider-lando/src/capabilities.ts:172-200` — current `/v5.0.0` libpod prefix in socket transport and curl URL construction.
- `plugins/provider-podman/src/named-pipe.ts:84-108` — current Windows named-pipe client `/v5.0.0` prefix and `/libpod/info` path.
- `plugins/provider-podman/src/index.ts:623-640` — current provider-podman `getVersions` and no-op setup anchor.
- `plugins/provider-podman/src/index.ts:241-274` — current provider-podman platform capability matrix.
- `plugins/provider-lando/src/runtime-config.ts:17-29` — current managed `containers.conf` writer only emits `[engine].helper_binaries_dir`.
- `scripts/build-provider-matrix-workflow.ts:116-150` — current generated provider matrix installs unqualified `podman` and runs provider contract tests.
- `.omo/evidence/task-1-podman-6-upgrade.txt` — source-backed Podman 6 facts and caveats: `podman machine os update` vs `upgrade`; partial upstream-canonical-source status for `[network].default_host_ips`.

## Goals

- Enforce Podman >= 6.0.0 in both Podman-backed providers using one numeric suffix-ignored floor policy.
- Move all libpod HTTP clients and fixtures from the v5.0.0 API prefix/version line to the Podman 6 line.
- Align managed machine setup and trust behavior with Podman 6 without stealing a user's default machine connection or auto-elevating Windows hosts.
- Remove Intel Mac runtime-bundle and release/CI assumptions while preserving the `windows-x64` release id vs `win32-x64` runtime host-key domain separation.
- Capture Podman 6 API behavior changes for pull progress/errors, container health, OOM died events, volume prune/filter semantics, and loopback-bound managed `containers.conf`.

## User Stories

### US-413: provider-lando Podman 6 version gate

**Description:** As a Lando-managed runtime user, `lando setup --provider=lando` rejects Podman runtimes below 6.0.0 and reports a tagged remediation before any provider action depends on removed Podman 5 behavior.

**Acceptance Criteria:**

- [ ] Future implementation bumps `MINIMUM_PODMAN_VERSION` in `plugins/provider-lando/src/setup.ts:29-31` to `6.0.0` and routes every setup error/remediation string that names the Podman floor through that constant.
- [ ] The version-floor parser covers both current setup sources: CLI output from `podman --version` (`plugins/provider-lando/src/setup.ts:201-218`, parsed at `plugins/provider-lando/src/setup.ts:438-440`) and API info `version.Version` (`plugins/provider-lando/src/setup.ts:443-455`, selected at `plugins/provider-lando/src/setup.ts:694-707`).
- [ ] Version comparison is numeric over `major.minor.patch`; pre-release and build suffixes are ignored, so `5.2.0` rejects, `6.0.0` accepts, and `6.1.0-rc1` accepts as `6.1.0`.
- [ ] Rejection uses a `ProviderUnavailableError`-family tagged error with `providerId: "lando"`, `operation: "setup"`, details that include the observed version/source, and remediation telling the user to install or select Podman >= 6.0.0.
- [ ] Tests cover CLI-version rejection/acceptance and API-info rejection/acceptance without shelling out to a real Podman binary.
- [ ] Tests pass
- [ ] Typecheck passes
- [ ] Lint passes

### US-414: provider-podman Podman 6 version gate

**Description:** As a user-installed Podman provider user, provider selection/readiness rejects Podman below 6.0.0 using the `/libpod/info` server version and exposes the accepted runtime version through `getVersions.runtime`.

**Acceptance Criteria:**

- [ ] Future implementation reads the server version from `/libpod/info` through the existing `podmanApi.info` path used by provider availability (`plugins/provider-podman/src/index.ts:632-635`) and does not execute `podman version` or any other shell command.
- [ ] `getVersions` changes from the current provider-only shape at `plugins/provider-podman/src/index.ts:638` to include `runtime: <server version>` after a successful info read, while preserving `provider: "0.0.0"` until the core version story changes provider versioning.
- [ ] Provider selection/readiness fails closed for `< 6.0.0` with a `ProviderUnavailableError`-family tagged error carrying `providerId: "podman"`, `operation: "select"` or `"setup"`, the observed server version, and remediation to upgrade Podman Desktop/system Podman to >= 6.0.0.
- [ ] Tests cover `/libpod/info` server versions `5.2.0`, `6.0.0`, and `6.1.0-rc1`; the test double proves no command-runner seam is invoked.
- [ ] The provider capability matrix at `plugins/provider-podman/src/index.ts:241-274` remains capability-only; version gating happens before capabilities are trusted.
- [ ] Tests pass
- [ ] Typecheck passes
- [ ] Lint passes

### US-415: libpod API prefix and fixture migration

**Description:** As a runtime maintainer, all Podman HTTP traffic targets the Podman 6 libpod API prefix and all Podman 5 fixture versions migrate to Podman 6 fixture versions, so API correctness is independent from version-gate enforcement.

**Acceptance Criteria:**

- [ ] Future implementation updates the provider-lando socket transport/curl prefix from `/v5.0.0` to `/v6.0.0` at `plugins/provider-lando/src/capabilities.ts:74-100` and `plugins/provider-lando/src/capabilities.ts:172-200`.
- [ ] Future implementation updates the provider-podman named-pipe API prefix from `/v5.0.0` to `/v6.0.0` at `plugins/provider-podman/src/named-pipe.ts:84-108`.
- [ ] Container-runtime transport tests and provider fixtures currently asserting `/v5.0.0` or `5.2.0` migrate to `/v6.0.0` and `6.0.2`, except tests explicitly named to prove US-413/US-414 reject `5.2.0`.
- [ ] The story text and implementation comments make clear that the prefix bump is API-correctness work, while US-413 and US-414 are the enforcement stories for the runtime floor.
- [ ] A focused grep gate fails if production provider code still constructs `http://localhost/v5.0.0` or `apiPrefix: "/v5.0.0"` after the migration.
- [ ] Tests pass
- [ ] Typecheck passes
- [ ] Lint passes

### US-416: managed machine v6 argv behavior

**Description:** As a macOS or Windows managed-runtime user, Lando's Podman 6 machine commands preserve the user's default connection, handle the OS-command spelling conflict conservatively, and avoid WSL-unsupported machine OS operations.

**Acceptance Criteria:**

- [ ] Future implementation changes managed machine start argv at `plugins/provider-lando/src/setup.ts:279-329` to pass `podman machine start --update-connection=false lando` (or the equivalent documented ordering if Podman requires the flag after the machine name), with seam tests asserting exact argv.
- [ ] The machine OS operation carries the task-1 evidence caveat: Podman v6.0.0 release notes say `podman machine os update`, while v6.0.0/latest manpages expose `podman machine os upgrade`; implementation must either probe/accept both spellings or deliberately target `upgrade` with a test proving the chosen command is documented.
- [ ] WSL-backed Windows machines do not run unsupported machine OS update/upgrade/apply paths; Lando either skips the operation with a typed readiness note or fails with remediation that explains the WSL limitation.
- [ ] Existing machine ownership preservation (`plugins/provider-lando/src/setup.ts:142-196` and `plugins/provider-lando/src/setup.ts:709-728`) remains intact: existing non-Lando machines are not reclassified as Lando-owned.
- [ ] Seam tests cover create, start, OS update/upgrade/apply decision, stop, and teardown argv on both `darwin` and `win32` without requiring real Podman machine tooling.
- [ ] Tests pass
- [ ] Typecheck passes
- [ ] Lint passes

### US-417: drop `darwin-x64` from runtime targets and host gates

**Description:** As a release maintainer, every runtime-bundle, manifest, CI, and host-gate path reflects Podman 6's removal of Intel Mac support while preserving existing platform-token domains.

**Acceptance Criteria:**

- [ ] Runtime-bundle targets and committed manifests are exactly `linux-x64`, `linux-arm64`, `darwin-arm64`, and `win32-x64`, matching PRD-10 US-410/US-412 and never including `darwin-x64`.
- [ ] Generated release/CI workflows keep release artifact id `windows-x64` separate from runtime host key `win32-x64`; no migration collapses those token domains.
- [ ] Host detection gates fail on Intel macOS with tagged remediation that names Podman 6's upstream removal and points users to Apple Silicon macOS, Linux, or Windows 11+.
- [ ] Future generated paths are updated through generators, not hand edits: a `scripts/build-runtime-bundle-workflow.ts`-style generator for runtime bundles and the existing CI/release workflow generators, followed by generated workflow drift checks.
- [ ] Tests cover host-key set validation and Intel Mac remediation without requiring an Intel Mac runner.
- [ ] Tests pass
- [ ] Typecheck passes
- [ ] Lint passes

### US-418: CI provider integration runs on Podman 6

**Description:** As a maintainer, provider integration CI proves the Podman 6 contract before running Podman-backed contract tests, rather than silently inheriting whatever Podman line the runner image provides.

**Acceptance Criteria:**

- [ ] Future implementation updates the generated provider matrix path anchored at `scripts/build-provider-matrix-workflow.ts:116-150` to install or stage Podman >= 6.0.0, `passt`/pasta, Netavark v2.x, and Aardvark v2.x on Linux provider-integration runners.
- [ ] CI asserts `podman version` is >= 6.0.0 with the same numeric suffix-ignored policy before starting `podman system service`; a failed assertion exits before tests start and prints remediation in the job log.
- [ ] Ubuntu 24.04 distro/OBS package selection is explicit in generated workflow input or docs; if OBS availability is unresolved, the workflow carries a temporary fallback comment and the Open Question remains active.
- [ ] Generated workflow changes land through the generator and pass `git diff --exit-code` on the generated workflow path, plus any named generated workflow gate used by this repo.
- [ ] `docs/ci-runbook.md` is updated in the future implementation change if CI setup commands change, and guide/runbook drift gates are run in that same change.
- [ ] Tests pass
- [ ] Typecheck passes
- [ ] Lint passes

### US-419: pull progress and typed pull failures

**Description:** As a user pulling artifacts through Podman 6, Lando requests streaming pull progress, routes all user-visible output through the renderer, and reports non-200 pull failures as typed provider errors with redacted details.

**Acceptance Criteria:**

- [ ] Future implementation changes Podman image pull requests to include `pullProgress=true`, matching the Podman 6 Libpod Pull endpoint behavior from task-1 evidence.
- [ ] Non-200 pull responses become typed `ProviderUnavailableError` or operation-specific pull errors instead of assuming Podman pull endpoints always return HTTP 200 on failure.
- [ ] Pull progress is rendered only through the `Renderer` service; no new `console.*` or `process.std*.write` appears under `core/src/**` or `plugins/**`, and `check:renderer-boundary` passes.
- [ ] Error bodies and progress details pass through `RedactionService` before events, transcripts, or structured output store registry/image names that may include credentials or private hosts; `check:redaction-boundary` passes.
- [ ] Tests cover progress frames, non-200 failure mapping, renderer-only output, and redacted transcript/event payloads.
- [ ] Tests pass
- [ ] Typecheck passes
- [ ] Lint passes

### US-420: service health uses Podman 6 `Health` and `runProbe`

**Description:** As a user inspecting app readiness on Podman 6, Lando derives service health from the container `Health` field and uses the shared probe primitive for polling.

**Acceptance Criteria:**

- [ ] Future implementation maps the Podman 6 container `Health` field into `ServiceRuntimeInfo` health/readiness output instead of deriving readiness only from `State.Running`/`State.Status` as currently anchored in `plugins/provider-lando/src/inspect.ts:12-19` and `plugins/provider-lando/src/inspect.ts:61-132`.
- [ ] Polling/backoff/timeout behavior for health waits uses `@lando/sdk/probe`'s `runProbe`; no new hand-rolled `Effect.retry`, `Effect.repeat`, or `Schedule.*` loop is introduced in provider health code, and `check:probe-boundary` passes.
- [ ] Probe failures redact `ProbeResult.lastError` through `RedactionService` before events, transcripts, or readiness summaries; `check:redaction-boundary` passes.
- [ ] Tests cover healthy, starting, unhealthy, missing-health, timeout, and redacted-last-error cases with a fake Podman API response.
- [ ] Provider capabilities remain honest: any health capability change must update the provider contract suite and `@lando/sdk` schema/compatibility artifacts if public schema changes.
- [ ] Tests pass
- [ ] Typecheck passes
- [ ] Lint passes

### US-421: OOMKilled died-event doctor surfacing

**Description:** As a user diagnosing a stopped service, `lando doctor` surfaces Podman 6 died events with `OOMKilled` and gives remediation to raise memory or reduce workload.

**Acceptance Criteria:**

- [ ] Future implementation consumes Podman container died-event payloads that include the `OOMKilled` attribute described in task-1 evidence and correlates them to the affected app/service where possible.
- [ ] Doctor output extends the runtime diagnostic model anchored at `core/src/cli/commands/doctor.ts:60-92` with a warning/failure solution when `OOMKilled` is set, without leaking raw event payloads.
- [ ] Remediation tells users to increase Podman machine/runtime memory, reduce service memory demand, or inspect the service logs; Windows/macOS remediation may mention Podman Desktop machine resource settings.
- [ ] Event details are redacted before doctor NDJSON/text output and transcripts; `check:redaction-boundary` and `check:renderer-boundary` pass for any touched output paths.
- [ ] Tests cover OOMKilled present, absent, malformed, and unrelated died events.
- [ ] Tests pass
- [ ] Typecheck passes
- [ ] Lint passes

### US-422: volume prune and filter semantics

**Description:** As a user cleaning Podman volumes, Lando's prune behavior matches Podman 6 anonymous-only defaults, AND filter semantics, and explicit destructive intent.

**Acceptance Criteria:**

- [ ] Future implementation never relies on Podman 5's broad `podman volume prune` behavior; anonymous-only default is preserved unless the user explicitly asks for named-volume cleanup.
- [ ] Any Lando volume cleanup that intends to remove named unused volumes passes explicit `--all`/API equivalent and exposes a `--dry-run` or dry-run result path before destructive deletion.
- [ ] Multiple filters use Podman 6's AND semantics, including `label!=` behavior called out in task-1 evidence; tests prove the selected filter set cannot delete volumes outside the current app/provider labels.
- [ ] The existing destroy-volume pattern anchored in `plugins/provider-docker/src/index.ts:936-1004` and provider-podman delegation at `plugins/provider-podman/src/index.ts:651-661` remains explicit per app stores; no provider-wide prune happens as an incidental destroy side effect.
- [ ] State updates for removed volumes use `StateStore`/existing app-plan persistence seams where state is durable, and `check:state-store-boundary` passes if those paths are touched.
- [ ] Tests pass
- [ ] Typecheck passes
- [ ] Lint passes

### US-423: managed machine trust and Windows remediation

**Description:** As a macOS or Windows user, Lando imports native CA trust only into machines it owns and reports Windows Hyper-V prep as manual remediation rather than auto-elevating.

**Acceptance Criteria:**

- [ ] Future implementation passes `--import-native-ca` only when creating or managing a Lando-owned machine, using the ownership state anchored at `plugins/provider-lando/src/setup.ts:142-196` and `plugins/provider-lando/src/setup.ts:709-728`; user-owned machines are not modified implicitly.
- [ ] Windows Hyper-V remediation may recommend `podman system hyperv-prep` and explain that admin privileges are required for prep, but Lando never auto-elevates or runs the prep command for the user.
- [ ] The audit is narrow and multi-provider aware: `@lando/provider-lando` managed machine behavior is updated, while `@lando/provider-podman` user-installed Podman Desktop behavior remains advisory/readiness-only.
- [ ] Tests cover Lando-owned machine create, existing user-owned machine, Windows missing Hyper-V prerequisites, and remediation text without requiring a Windows admin runner.
- [ ] Any machine trust events/transcripts redact local certificate paths and host-specific details before output; `check:redaction-boundary` and `check:renderer-boundary` pass if output changes.
- [ ] Tests pass
- [ ] Typecheck passes
- [ ] Lint passes

### US-424: managed containers.conf loopback binding

**Description:** As a managed-runtime user, Lando writes a managed `containers.conf` that keeps default published ports on loopback once the upstream-canonical `default_host_ips` source is confirmed.

**Acceptance Criteria:**

- [ ] Future implementation extends `plugins/provider-lando/src/runtime-config.ts:17-29` so the managed `containers.conf` includes `[network].default_host_ips` set to loopback-only values for managed runtimes, while preserving `[engine].helper_binaries_dir`.
- [ ] Because task-1 evidence confirmed `default_host_ips` existence but only partially confirmed the canonical upstream exact shape, implementation must first cite the upstream `containers/common` commit or canonical manpage for `[network].default_host_ips = ["127.0.0.1", "::1"]` or adjust the emitted shape to the confirmed source.
- [ ] The generated config is owned by Lando's managed runtime only; user/system `containers.conf` files are not modified, and managed-file writes pass `check:managed-file-boundary` if the future implementation routes this through managed-file ownership.
- [ ] Tests parse the emitted TOML and prove loopback defaults coexist with `helper_binaries_dir`; a regression test proves no LAN wildcard default is emitted for managed runtime config.
- [ ] Network isolation/cross-app reachability behavior is tested or explicitly left behind the Open Question before changing shared network defaults.
- [ ] Tests pass
- [ ] Typecheck passes
- [ ] Lint passes

## Functional Requirements

- **FR-1:** Both Podman-backed providers MUST enforce Podman >= 6.0.0 before trusting runtime behavior; version comparison is numeric over `major.minor.patch`, ignoring pre-release/build suffixes for the floor check.
- **FR-2:** Production libpod HTTP clients MUST use the Podman 6 API prefix `/v6.0.0`; Podman 5 fixture versions remain only in rejection tests.
- **FR-3:** Runtime-bundle target and manifest host keys MUST be exactly `linux-x64`, `linux-arm64`, `darwin-arm64`, and `win32-x64`; release artifact id `windows-x64` remains a separate domain.
- **FR-4:** Provider integration CI MUST assert the Podman 6 host contract before Podman-backed tests run.
- **FR-5:** New Podman 6 API outputs that reach users, events, transcripts, or diagnostics MUST pass through Renderer/Redaction/Probe/StateStore/Managed-file boundaries as applicable.
- **FR-6:** Unresolved Podman-source conflicts MUST remain explicit Open Questions; implementation stories may include dual-spelling or source-confirmation acceptance paths but must not silently guess.

## Non-Goals

- Implementing any product behavior in this PRD-authoring task.
- Modifying `spec/beta-1/prd.json` or wiring PRD-11 into `spec/beta-1/prd-beta-1-00-index.md`.
- Changing existing US-372..US-412 text, PRD-10, product code, tests, docs/guides, CI generators, manifests, or phase-history files.
- Supporting Intel macOS, Windows 10, cgroups v1, iptables, CNI, or `slirp4netns` as compatibility fallback paths.
- Choosing a final network isolation/cross-app reachability policy without resolving the Open Question.

## Technical Considerations

- The safest implementation order is API prefix/fixtures first, then provider-lando/provider-podman version gates, then machine/CI/runtime-bundle fallout, then behavior-specific API changes.
- US-413 and US-414 should share one small version-floor parser to avoid policy drift, but public types should remain derived from existing Effect Schema contracts rather than hand-written duplicates.
- The Podman 6 machine OS command conflict requires a runtime-tolerant implementation or a source-backed decision: release notes say `update`, while published manpages expose `upgrade`.
- `default_host_ips` is intentionally decision-complete only after canonical-source confirmation; the PRD still decides the Lando-managed outcome: loopback-only defaults for managed runtime config.
- Generated workflows remain generated outputs. Future implementation edits must touch generators and emitted workflows together, then run drift gates.

## Success Metrics

- `lando setup --provider=lando` rejects Podman `5.2.0` and accepts `6.0.0`/`6.1.0-rc1` through both CLI and API-info paths.
- `@lando/provider-podman` reports `getVersions.runtime` from `/libpod/info` and rejects server version `5.2.0` without shelling out.
- `git grep '/v5.0.0' plugins/provider-lando plugins/provider-podman container-runtime/test` returns no production prefix hits after US-415, except historical rejection fixtures explicitly named as Podman 5 tests.
- Provider integration CI logs a Podman >= 6.0.0 assertion before running Podman-backed tests.
- Managed runtime `containers.conf` binds default published ports to loopback once the canonical `default_host_ips` source is confirmed.

## Guide Coverage

- `provider-podman-linux` guide coverage must describe Podman >= 6.0.0, cgroups v2/nftables, Pasta, Netavark/Aardvark v2, and CI/local readiness commands.
- `provider-podman-macos` guide coverage must state Apple Silicon macOS only and document Podman Desktop/machine readiness without Intel Mac fallback language.
- `provider-podman-windows` guide coverage must state Windows 11+, Hyper-V/WSL caveats, manual `podman system hyperv-prep` remediation, and no auto-elevation.
- `provider-selection` guide coverage must explain the distinction between `@lando/provider-lando` managed runtime and `@lando/provider-podman` user-installed runtime under the same Podman 6 floor.
- `provider-auto-setup` guide coverage must cover managed runtime bundle install, version gate failures, machine ownership, and `--update-connection=false` behavior once implemented.
- `first-run-readiness` guide coverage must cover Podman 6 readiness checks, health/OOM diagnostics, and remediation surfaces.
- `env-overrides` guide coverage must keep runtime-bundle and provider override escape hatches accurate after the Podman 6 migration.
- Future implementation that changes guide-owned CLI surface or transcripts must run `bun run lint:guides`, `bun run check:guide-coverage`, `bun run check:public-transcripts`, and `bun run check:guide-drift` as applicable.

## Open Questions

- **Machine OS command spelling:** Podman v6.0.0 release notes say `podman machine os update`, while v6.0.0/latest manpages expose `podman machine os upgrade` and no `update` manpage. Should Lando target `upgrade`, target `update`, or probe/accept both if both are present at runtime?
- **`default_host_ips` canonical source:** Podman v6.0.0 release notes confirm the field and downstream manpages document `[network].default_host_ips=[]`, but task-1 did not find a current upstream `containers/common` raw-doc/default-config source for the exact section/value shape. Which upstream source should implementation cite before emitting it?
- **Network isolation and cross-app reachability:** Podman 6 enables network isolation by default. Should Lando explicitly configure per-app/shared networks to preserve intended cross-app/service reachability, and how should that interact with loopback-only published ports?
- **OBS availability for Ubuntu 24.04 Podman 6:** Should CI rely on OBS packages for Ubuntu 24.04, staged runtime-bundle artifacts, or another pinned source if distro packages lag Podman >= 6.0.0?
- **Hyper-V QA without Windows runner:** If the project still lacks a Windows runner with Hyper-V privileges, what is the minimum acceptable automated QA for `podman system hyperv-prep` remediation and non-admin start/stop behavior?
