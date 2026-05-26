# PRD: BETA-01 — Provider matrix complete

## Introduction

This PRD covers Phase 3 Beta work for the **runtime-provider matrix**. Alpha brought `@lando/provider-lando` to Linux + macOS and `@lando/provider-docker` to Linux + macOS. Beta finishes the picture: Windows for both, the opt-in `@lando/provider-podman`, and one shared contract suite that every provider passes on every platform it declares support for.

Depends on: **—** (Beta entry point).

## Source References

- [`spec/05-runtime-providers.md`](../05-runtime-providers.md) — `RuntimeProvider` contract, capability matrix, setup, bundle download/checksum (§5.8.1).
- [`spec/08-cli-and-tooling.md`](../08-cli-and-tooling.md) — `meta:setup`, `meta:doctor`, provider selection flags.
- [`spec/13-testing-and-distribution.md`](../13-testing-and-distribution.md) — provider contract test layer.

## Goals

- Make `@lando/provider-lando` fully usable on Windows (managed Podman VM lifecycle).
- Make `@lando/provider-docker` fully usable on Windows (Docker Desktop).
- Ship `@lando/provider-podman` as an opt-in provider on Linux + Podman Desktop on macOS/Windows.
- Run a single provider contract suite across `TestRuntimeProvider`, `provider-lando`, `provider-docker`, and `provider-podman` on every platform each declares.

## User Stories

### US-074: provider-lando Windows VM lifecycle

**Description:** As a Windows tester, I can run `lando setup` and have `@lando/provider-lando` create, start, stop, and tear down the managed Podman machine without leaving WSL2/Hyper-V state behind.

**Acceptance Criteria:**
- [ ] Fake-client unit tests cover create / start / stop / upgrade / teardown transitions for Windows.
- [ ] `ProviderCapabilities` declares Windows support with `bindMountPerformance: "slow"`.
- [ ] `lando setup` reports actionable remediation when virtualization prerequisites (Hyper-V, WSL2, Virtual Machine Platform) are missing.
- [ ] Live test gated behind `LANDO_TEST_WINDOWS_PROVIDER_LANDO=1` and skipped by default.
- [ ] Tests pass; typecheck passes; lint passes.

### US-075: provider-lando Windows runtime-bundle download and checksum verification

**Description:** As a Windows tester, the runtime-bundle download path matches §5.8.1 — same checksum/signature semantics as Linux + macOS — and stores the bundle under the per-user state directory.

**Acceptance Criteria:**
- [ ] Bundle URL and SHA-256 are resolved through the same pinned manifest used by Linux + macOS.
- [ ] Checksum mismatch fails closed with a tagged `ProviderBundleChecksumError`; remediation cites §5.8.1.
- [ ] Re-runs are idempotent (existing valid bundle is reused).
- [ ] Tests pass; typecheck passes; lint passes.

### US-076: provider-lando Windows capability surface in `meta:doctor`

**Description:** As a Windows tester, `lando doctor` surfaces every §5.4 capability for provider-lando and explains any missing one with a Windows-specific remediation.

**Acceptance Criteria:**
- [ ] `meta:doctor` reports `bindMountPerformance`, `sharedCrossAppNetwork` (false until PRD-04), socket/machine status, and bundle version for the Windows provider.
- [ ] Snapshot-tested JSON output for the Windows path; live block skipped without `LANDO_TEST_WINDOWS_PROVIDER_LANDO=1`.
- [ ] Tests pass; typecheck passes; lint passes.

### US-077: provider-docker Windows (Docker Desktop)

**Description:** As a Windows tester with Docker Desktop, I can use `@lando/provider-docker` to apply, inspect, exec, log, and destroy plans through the Docker Engine HTTP API.

**Acceptance Criteria:**
- [ ] Docker Desktop named-pipe / TCP discovery: `DOCKER_HOST`, `npipe://./pipe/docker_engine`, fall-back order documented and tested.
- [ ] Fake-client tests cover apply / inspect / exec / logs / destroy.
- [ ] Declares `bindMountPerformance: "slow"` for Docker Desktop.
- [ ] Live test gated by `LANDO_TEST_WINDOWS_DOCKER_SOCKET` or `DOCKER_HOST` and skipped by default.
- [ ] Tests pass; typecheck passes; lint passes.

### US-078: ship `@lando/provider-podman` as an opt-in provider (Linux)

**Description:** As a Linux user with a pre-existing rootless Podman install, I can opt into `@lando/provider-podman` and reuse the Podman API contract.

**Acceptance Criteria:**
- [ ] Plugin published at `@lando/provider-podman` with a `RuntimeProvider` Live Layer; not auto-loaded — opt-in via Landofile or `--provider=podman`.
- [ ] Discovers a user-installed Podman socket (`$XDG_RUNTIME_DIR/podman/podman.sock` or `DOCKER_HOST`-style override).
- [ ] Declares `bindMountPerformance: "native"` on Linux, `"slow"` on macOS/Windows.
- [ ] Selection rejects opt-in if `lando setup` recorded a conflict with `@lando/provider-lando`'s private socket; remediation describes the conflict.
- [ ] Tests pass; typecheck passes; lint passes.

### US-079: `@lando/provider-podman` on macOS + Windows via Podman Desktop

**Description:** As a macOS/Windows user with Podman Desktop, I can drive `@lando/provider-podman` against the Podman Desktop machine.

**Acceptance Criteria:**
- [ ] Discovery covers the Podman Desktop default machine names + sockets per platform.
- [ ] Fake-client tests cover apply / inspect / exec / logs / destroy and machine-not-running remediation.
- [ ] Live tests gated by `LANDO_TEST_PODMAN_DESKTOP_SOCKET` and skipped by default.
- [ ] `meta:doctor` distinguishes `provider-lando` (managed) from `provider-podman` (user-installed) in its output.
- [ ] Tests pass; typecheck passes; lint passes.

### US-080: shared provider contract suite covers all three providers

**Description:** As a provider maintainer, I can run one contract suite (from `@lando/sdk/test`) and have it cover `TestRuntimeProvider`, `provider-lando`, `provider-docker`, and `provider-podman` on every supported platform.

**Acceptance Criteria:**
- [ ] `@lando/sdk/test` exports a single contract-suite runner; the four provider packages each have a contract-test entry point.
- [ ] Suite covers lifecycle (apply / inspect / exec / logs / destroy), capability matrix, error contract (`ProviderCapabilityError`, `NoProviderInstalledError`, redacted-detail rules from §5.7), and bundle/setup invariants.
- [ ] Suite is matrix-driven over platform × provider; cells without a supported declaration are skipped with a reason.
- [ ] Tests pass; typecheck passes; lint passes.

### US-081: provider negative-path coverage (partial-failure cleanup, abort signal)

**Description:** As an operator, failed apply/destroy operations honor the abort signal and converge to a documented partial-state.

**Acceptance Criteria:**
- [ ] Fake-provider tests cover partial apply failure after network creation and after one service start; cleanup preserves app-scoped volumes unless `destroy({ volumes: true })` is requested.
- [ ] All three providers honor the AbortSignal forwarded from the CLI; pending operations stop before bring-up completes.
- [ ] Errors include `providerId`, operation name, redacted details, and original cause per §5.7.
- [ ] Tests pass; typecheck passes; lint passes.

### US-082: provider selection precedence and conflict diagnostics

**Description:** As a user with multiple providers installed, selection follows `flag > Landofile > env > config > capability-based default` and conflicts are diagnosed clearly.

**Acceptance Criteria:**
- [ ] Precedence resolver tested for every pair of (`--provider`, Landofile `provider:`, `LANDO_PROVIDER`, `~/.lando/config.yml`, capability default).
- [ ] `meta:doctor` reports the resolved provider and the inputs that led to it.
- [ ] Conflict between `provider-lando` and `provider-podman` (both targeting Podman API) is reported with remediation (`lando setup --provider=…`).
- [ ] Tests pass; typecheck passes; lint passes.

## Functional Requirements

- FR-1: `@lando/provider-lando` declares Windows support with `bindMountPerformance: "slow"` and uses managed Podman machine lifecycle through WSL2 / Hyper-V.
- FR-2: `@lando/provider-docker` declares Windows support targeting Docker Desktop (named-pipe + TCP discovery).
- FR-3: `@lando/provider-podman` ships as an opt-in plugin and works on Linux, macOS Podman Desktop, and Windows Podman Desktop.
- FR-4: All four providers (`TestRuntimeProvider`, `provider-lando`, `provider-docker`, `provider-podman`) pass the same `@lando/sdk/test` contract suite on every platform they declare.
- FR-5: Provider selection follows `flag > Landofile > env > config > capability-based default`; conflicts are reported by `meta:doctor`.
- FR-6: Runtime-bundle download verifies SHA-256 per §5.8.1 on every platform; mismatches fail closed.

## Non-Goals

- Code signing / notarization of provider runtime bundles (RC).
- Kubernetes provider (post-4.0).
- Multi-provider per-app (post-4.0 — §14.2 deferral; design preserved by `ProviderCapabilities`).
- Auto-installation of Docker Desktop or Podman Desktop (out of scope — `lando setup` only manages `provider-lando`'s bundle).
- Provider trust / signing model for community providers (RC).

## Technical Considerations

- WSL2 detection: Windows provider-lando needs to detect WSL2 + Virtual Machine Platform feature state; surface a remediation pointing at `wsl --install` and platform docs when missing.
- Docker Desktop on Windows exposes both `npipe://./pipe/docker_engine` and TCP; the discovery order is documented in the test fixtures.
- `provider-podman` and `provider-lando` both speak the Podman REST API. The contract-suite cells must reuse the same fake client to avoid drift.
- AbortSignal threading from the CLI down into provider apply/destroy follows the pattern established in MVP US-053; Windows provider-lando uses the same field on `BringUpOptions` / `DestroyOptions`.

## Success Metrics

- Provider contract suite green on all four providers × every supported platform cell in nightly CI.
- `meta:doctor --json` lists every §5.4 capability for the selected provider on every platform with no `null`/`undefined`.
- Zero provider-specific call sites in `core/src/cli/run.ts` — every CLI command goes through `RuntimeProvider`.

## Guide Coverage

Per [PRD-12 US-198](./prd-beta-12-executable-guides-beta.md) (`## Guide Coverage` convention) and [US-199](./prd-beta-12-executable-guides-beta.md) (drift gate), this PRD owns the executable guides listed below. Each guide exercises the happy path of its mapped user story; failure modes remain covered by unit and integration tests in the named packages. PRs that touch the listed surface paths MUST also touch the corresponding guide(s), or use the `Guide-Coverage-Skip:` escape hatch.

**Guides owned by this PRD:**

| User Story | Feature | Guide Path | Acceptance |
|---|---|---|---|
| US-074 | provider-lando Windows VM lifecycle | `docs/guides/setup/provider-lando-windows.mdx` | Required at story acceptance |
| US-077 | provider-docker on Windows (Docker Desktop) | `docs/guides/setup/provider-docker-windows.mdx` | Required at story acceptance |
| US-078 | @lando/provider-podman opt-in on Linux | `docs/guides/setup/provider-podman-linux.mdx` | Required at story acceptance |
| US-082 | provider selection precedence + conflict diagnostics | `docs/guides/setup/provider-selection.mdx` | Required at story acceptance |

**CLI / source surface paths covered (drift gate input):**

- `plugins/provider-lando/**`
- `plugins/provider-docker/**`
- `plugins/provider-podman/**`
- `core/src/cli/commands/meta/setup.ts`
- `core/src/cli/commands/meta/doctor.ts`

## Open Questions

- Should `lando setup --provider=podman` be allowed to coexist with a previously-set-up `provider-lando`, or should they be mutually exclusive per machine? Default in this PRD: coexist with a doctor-reported conflict warning.
- Windows Podman machine teardown can leave WSL2 distros behind; should `meta:setup --teardown` aggressively `wsl --unregister` the lando-managed distro? Default: yes, with confirmation prompt unless `--yes`.
