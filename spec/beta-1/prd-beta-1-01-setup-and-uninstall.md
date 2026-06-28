# PRD: BETA1-01 — Setup & uninstall completion

## Introduction

Beta 1 completes the host setup and uninstall lifecycle that users hit before and after every local development session. `lando setup` becomes a re-runnable readiness command that prepares the provider, certificate authority, proxy, shell integration, and file sync engine through the plugin system and direct service calls. `lando uninstall` becomes a first-class destructive command with clear previews, confirmations, and data-retention choices.

This work closes the remaining setup and uninstall feature surface called out by the Beta 1 index and ROADMAP, then keeps source-mode OCLIF dispatch and the compiled `$bunfs` dispatcher in parity.

## Source References

- [`spec/11-subsystems.md`](../11-subsystems.md) §10.3 certificate authority and §10.3.1 corporate proxy / custom CA handling.
- [`spec/11-subsystems.md`](../11-subsystems.md) §10.6 file sync and Mutagen setup.
- [`spec/11-subsystems.md`](../11-subsystems.md) §10.8 `lando setup` and host integration.
- [`spec/11-subsystems.md`](../11-subsystems.md) §10.9 logs, diagnostics, and readiness reporting.
- [`spec/08-cli-and-tooling.md`](../08-cli-and-tooling.md) §8.2 built-in command list, including `lando uninstall`.
- [`spec/15-binary-build-and-release.md`](../15-binary-build-and-release.md) §17.7 first-run UX and uninstall.
- [`spec/beta-1/prd-beta-1-00-index.md`](./prd-beta-1-00-index.md) verification contract, dual-dispatch parity, and destructive-confirmation rules.

## Goals

- Make `lando setup` the one command that prepares a host for Beta 1 use.
- Keep setup safe to rerun, with already-satisfied steps reported rather than repeated.
- Honor provider, proxy, CA, shell, and file-sync choices through explicit flags.
- Give `lando doctor` a complete readiness summary from the latest setup run.
- Make `lando uninstall` predictable, previewable, and gated before any destructive work.
- Keep source CLI and compiled binary behavior identical for setup and uninstall.
- Make a working Lando-managed runtime come up automatically: extract the bundle binaries, and have the provider launch and own the private Podman API socket via an idempotent `ensureRuntime` triggered by `lando start` (and called eagerly by `lando setup`), with no manual `podman system service` or systemd step.
- Resolve the runtime socket and binaries from the Paths primitive so production never depends on the `LANDO_TEST_PODMAN_SOCKET` test variable.
- Make CI exercise the default Lando provider through `lando setup`, with no manual socket bring-up.

## User Stories

### US-200: `lando setup` orchestrates provider, CA, proxy, shell, and file-sync setup

**Description:** As a new user, I can run `lando setup` once and have Lando prepare every required host integration for the selected provider.

**Acceptance Criteria:**
- [x] `meta:setup` is registered at bootstrap `minimal` with the top-level `lando setup` alias.
- [x] The setup flow runs provider, CA, proxy, shell-integration, and file-sync setup through plugin subscribers and direct service calls in a deterministic order.
- [x] Flags are accepted and honored: `--yes`, `--provider=<id>`, `--skip-provider`, `--skip-proxy`, `--skip-install-ca`, `--skip-shell-integration`, and `--skip-file-sync`.
- [x] Provider plugins can add setup flags through `setup.flags`, and those flags appear in command metadata and parsing tests.
- [x] Default setup installs the Lando-managed runtime. `--provider=docker` and `--provider=podman` fail with remediation unless the matching system runtime already exists.
- [x] Tests pass
- [x] Typecheck passes
- [x] Lint passes

### US-201: File-sync setup downloads Mutagen only when the active provider needs it

**Description:** As a user on a slow bind-mount provider, I get Mutagen acceleration prepared during setup, while users on native providers do no extra file-sync work.

**Acceptance Criteria:**
- [x] Providers with `bindMountPerformance: "slow"` trigger `FileSyncEngine.setup()` during setup unless `--skip-file-sync` is passed.
- [x] Mutagen host CLI downloads to `<userDataRoot>/bin/mutagen` or `<userDataRoot>/bin/mutagen.exe` with a pinned checksum.
- [x] Per-platform Mutagen agents download to `<userDataRoot>/bin/mutagen-agents/mutagen-agent-<platform>` with pinned checksums.
- [x] `--skip-file-sync` records setup as deferred so the first accelerated `app:start` can finish file-sync setup with clear messaging.
- [x] Providers with `bindMountPerformance: "native"` report file sync as already satisfied and do not download Mutagen.
- [x] Tests pass
- [x] Typecheck passes
- [x] Lint passes

### US-202: Setup validates corporate proxy and custom CA configuration before long downloads

**Description:** As a user behind a corporate proxy or TLS interception, setup checks my network trust settings first and tells me exactly what to fix before large downloads start.

**Acceptance Criteria:**
- [ ] All setup downloads honor proxy precedence: `network.proxy`, then `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY`.
- [ ] Additional CAs are loaded from `network.ca.certs` and `LANDO_NETWORK_CA_CERTS` before download probes run.
- [ ] Setup validates proxy and CA configuration before provider or Mutagen downloads begin.
- [ ] Failures distinguish TLS interception, proxy authentication, missing custom CA, and blocked registry cases.
- [ ] Every failure includes platform-specific remediation and the config key or environment variable the user should change.
- [ ] Tests pass
- [ ] Typecheck passes
- [ ] Lint passes

### US-203: Setup uses `PrivilegeService` for elevation and exposes `lando shellenv`

**Description:** As an operator, host-level changes go through the privilege abstraction, and I can print shell snippets that add Lando's bin directory to PATH.

**Acceptance Criteria:**
- [ ] CA trust-store installation, provider installation, and shell-profile writes use `PrivilegeService` rather than direct privileged shell calls.
- [ ] Linux sudo-prompting commands set `SUDO_ASKPASS` when an askpass helper exists.
- [ ] `lando shellenv` prints shell-profile snippets that add `<userDataRoot>/bin` to PATH without modifying files.
- [ ] Shell snippets cover supported POSIX shells and PowerShell with tests for path escaping.
- [ ] Setup can apply shell integration when requested, while `lando shellenv` remains a safe manual path.
- [ ] Tests pass
- [ ] Typecheck passes
- [ ] Lint passes

### US-204: Setup is idempotent, re-entrant, and feeds doctor readiness

**Description:** As a support engineer, I can ask a user to rerun setup and read a readiness summary that explains what is ready, skipped, deferred, or failed.

**Acceptance Criteria:**
- [ ] Re-running `lando setup` never corrupts existing provider state, CA trust, Mutagen binaries, shell entries, or proxy state.
- [ ] Already-satisfied steps are reported as satisfied with evidence, not silently skipped.
- [ ] Interrupted setup can resume from the last safe point without forcing users to delete data roots.
- [ ] Setup writes a structured readiness summary consumed by `lando doctor` §10.9 diagnostics.
- [ ] Every readiness failure includes per-platform remediation and enough detail for support triage without leaking secrets.
- [ ] Tests pass
- [ ] Typecheck passes
- [ ] Lint passes

### US-205: `lando uninstall` enumerates destructive work and supports dry runs

**Description:** As a user removing Lando, I can preview every action before anything is deleted, and destructive execution requires explicit confirmation.

**Acceptance Criteria:**
- [ ] `meta:uninstall` is registered at bootstrap `minimal` with the top-level `lando uninstall` alias.
- [ ] `lando uninstall --dry-run` prints every planned destructive and non-destructive step without changing the system.
- [ ] `lando uninstall` without `--yes` refuses destructive execution and tells the user to rerun with `--yes` after reviewing the plan.
- [ ] The plan lists managed provider runtimes or machines, Mutagen binaries, CA trust-store changes, global app state, caches, installed binary, shell entries, `<userDataRoot>`, and `<userCacheRoot>` when applicable.
- [ ] The rendered plan marks steps as owned by Lando, user-owned, skipped, or requiring manual remediation.
- [ ] Tests pass
- [ ] Typecheck passes
- [ ] Lint passes

### US-206: Uninstall splits toolchain removal from data destruction

**Description:** As a user, I can remove Lando's toolchain while keeping application data, or explicitly purge all Lando-owned state.

**Acceptance Criteria:**
- [ ] `--keep-data` removes the Lando-owned toolchain but preserves user data roots, app data, and global app state that would destroy local work.
- [ ] `--purge` opts into deliberate data destruction and is still gated by `--yes`.
- [ ] Managed provider runtimes, provider machines, downloaded Mutagen binaries and agents, CA root trust, global app state, caches, installed binary, shell-env entries, `<userDataRoot>`, and `<userCacheRoot>` are removed only when owned by Lando and allowed by the chosen mode.
- [ ] The installed binary is removed only when Lando owns the path; otherwise the command prints exact manual removal steps.
- [ ] Partial failures leave a resumable uninstall report with completed, failed, skipped, and manual steps.
- [ ] Tests pass
- [ ] Typecheck passes
- [ ] Lint passes

### US-207: Setup and uninstall dispatch identically in source and compiled binary paths

**Description:** As a user, I get the same setup and uninstall behavior whether I run from source or the compiled `$bunfs` binary.

**Acceptance Criteria:**
- [ ] OCLIF command registrations and `runCompiledCli` branches cover `setup`, `meta:setup`, `shellenv`, `uninstall`, and `meta:uninstall` in the same change.
- [ ] Shared command helpers own parsing, setup planning, uninstall planning, rendering, and error mapping.
- [ ] Parity tests cover flags, aliases, unknown flags, dry-run rendering, destructive confirmation, and representative failure cases.
- [ ] Compiled-binary tests verify no OCLIF-only assumptions are required for setup or uninstall.
- [ ] Renderer-boundary tests confirm command output flows through the renderer seam.
- [ ] `lando setup` resolves the runtime bundle from a manifest and verifies SHA-256; `--runtime-bundle-url` requires a paired `--runtime-bundle-sha256`, and `LANDO_RUNTIME_BUNDLE_MANIFEST` redirects to a local bundle with verification still enforced.
- [ ] CI runs the real `lando setup` runtime-bundle download+verify path against a current-commit bundle via `scripts/build-runtime-bundle.ts --local` + `LANDO_RUNTIME_BUNDLE_MANIFEST`.
- [ ] Tests pass
- [ ] Typecheck passes
- [ ] Lint passes

> **Runtime-socket autosetup remediation (US-363..US-367).** US-200..US-207 wired the setup *orchestration* and the runtime-bundle *download + checksum verify*, but they stop short of producing a working runtime: the verified bundle is never extracted, nothing launches the Lando-owned Podman API socket, and the provider only reaches a socket when one is handed to it via the `LANDO_TEST_PODMAN_SOCKET` test variable (confirmed in `plugins/provider-lando/src/{setup,index,runtime-bundle}.ts` and `core/src/providers/registry.ts`). The following stories close that gap so `lando setup` stands up a usable Lando-managed runtime end-to-end and CI exercises the default provider with no manual socket bring-up. They carry top-band priorities (1..5) in `prd.json`.

### US-363: `lando setup` extracts and installs the verified runtime bundle into a private bin directory

**Description:** As a user running setup, the verified Lando runtime bundle is unpacked into a private runtime bin directory so the Lando-managed Podman and its helper binaries are present and executable on my host.

**Acceptance Criteria:**
- [ ] `@lando/core/paths` (`makeLandoPaths`) and `PathsService` expose `runtimeBinDir` (`<userDataRoot>/runtime/bin`), `runtimeRunDir` (`<userDataRoot>/runtime/run`), `providerSocketPath` (`<userDataRoot>/runtime/run/podman.sock`), and `providerPidPath` (`<userDataRoot>/runtime/run/podman.pid`) per §12.4, and pass `check:paths-boundary` (no hand-spelled joins).
- [ ] After `verifyRuntimeBundle` passes, `lando setup` extracts the bundle archive into `runtimeBinDir` and sets the executable bit on `podman` and the helper binaries (e.g. `gvproxy`, `conmon`, `crun`/`runc`, `netavark`, `aardvark-dns`); no file is written when the checksum does not match.
- [ ] Extraction supports the manifest filenames for `.tar.gz` (Linux/macOS) and `.zip` (Windows); archive entries that escape `runtimeBinDir` (path traversal, absolute paths, unsafe symlinks) are rejected with remediation.
- [ ] Extraction is version-idempotent: a re-run whose installed `runtimeVersion` already matches reports the step as already satisfied and does not re-extract; a version change replaces the bin tree atomically (temp dir + rename).
- [ ] The installed runtime bin directory and `runtimeVersion` are recorded in the provider setup state so `lando doctor` and the provider can resolve the binaries without re-downloading.
- [ ] Tests pass
- [ ] Typecheck passes
- [ ] Lint passes

### US-364: `@lando/provider-lando` owns an idempotent `ensureRuntime` that starts the private Podman API socket on demand

**Description:** As a user, the Lando provider brings its private Podman API socket up whenever a command needs it (`lando start`, `exec`, tooling) and keeps it up across reboots, so I never run `podman system service` or re-run setup to get a working runtime.

**Acceptance Criteria:**
- [ ] `@lando/provider-lando` exposes a provider-owned idempotent `ensureRuntime` primitive (§5.2 principle 8): a reachable socket is a no-op; a stale PID or unreachable socket is reaped (PID terminated if alive, socket/PID files unlinked) and relaunched; an absent socket is launched.
- [ ] `ensureRuntime` launches the extracted `podman system service` bound to `providerSocketPath`, pinned to private roots via `--root`/`--runroot`/`--config` under `<userDataRoot>/runtime/` so it never reads or writes system-wide Podman or Docker state, spawned detached so it outlives the CLI process, with its PID written to `providerPidPath` (§5.8.1, §12.4).
- [ ] The launch is an injectable `PodmanServiceRunner` seam (mirroring `PodmanCommandRunner`/`PodmanMachineRunner` in `setup.ts`) with a real detached default and a test fake; unit tests assert the argv, private-root flags, socket path, and PID write, plus the no-op / reap / launch branches, without spawning Podman.
- [ ] `lando start`, `exec`, and runtime-needing tooling call `ensureRuntime` before `apply`/exec; the cheap reachability probe rides the cold path (not the tooling hot path) and the actual launch happens at most once per boot. After it runs, the `api.info` probe succeeds with no `LANDO_TEST_PODMAN_SOCKET`.
- [ ] `lando setup` calls the same `ensureRuntime` as its final readiness step (setup does not own the socket); rootless launch prerequisites are classified with actionable, per-prerequisite remediation (missing `/etc/subuid`+`/etc/subgid`, missing `newuidmap`/`newgidmap`, cgroups v2 delegation, missing `XDG_RUNTIME_DIR`), distinct from a generic launch failure, extending the §10.8 setup preflight remediation contract.
- [ ] On macOS and Windows the socket is provided by the managed Podman machine created in US-200; `ensureRuntime` resolves and (re)starts the machine connection socket (using the bundled Podman with a Lando-private connection) instead of launching a host service, and records it identically.
- [ ] Tests pass
- [ ] Typecheck passes
- [ ] Lint passes

### US-365: Lando runtime service reports real status, self-heals, and is torn down by poweroff and uninstall

**Description:** As a support engineer, the Lando runtime service reports accurate status to doctor, comes back automatically after a stop/reboot/kill, and is cleaned up by poweroff and uninstall.

**Acceptance Criteria:**
- [ ] `RuntimeProvider.getStatus` for `lando` probes the socket/PID instead of returning a hardcoded `running: true`, and `lando doctor` surfaces runtime-service health plus orphan-PID detection (§10.9).
- [ ] `apps:poweroff` stops the Lando runtime service after stopping apps and honors the existing `--keep-global`/`--keep-scratch` flags.
- [ ] After a stop, reboot, or manual kill, the next `lando start` / `exec` / `lando setup` transparently re-runs `ensureRuntime` (US-364) and the runtime comes back with no user action; a cross-process test proves the self-heal.
- [ ] `lando uninstall` enumerates and performs runtime-service teardown (terminate PID, unlink socket/PID, remove `<userDataRoot>/runtime/`) under the chosen `--keep-data`/`--purge` retention mode (US-205/US-206 plan lists these steps).
- [ ] The US-204 readiness summary includes runtime-service state (running flag, socket path, PID, runtime version) consumed by `lando doctor`.
- [ ] Tests pass
- [ ] Typecheck passes
- [ ] Lint passes

### US-366: Provider registry resolves the Lando socket from Paths so production never depends on `LANDO_TEST_PODMAN_SOCKET`

**Description:** As a developer, every command resolves the Lando-managed socket and runtime binaries from the Paths primitive injected by the provider registry, so production no longer falls back to the `LANDO_TEST_PODMAN_SOCKET` test variable.

**Acceptance Criteria:**
- [ ] `core/src/providers/registry.ts` constructs `@lando/provider-lando` with the `PathsService`-resolved `socketPath` (and runtime bin dir), so `apply`/`exec`/`logs`/`inspect`/`destroy` reach the Lando-owned socket in a fresh CLI process with no environment variable.
- [ ] `provider-lando` derives its default socket path from the injected paths; resolution precedence is explicit option > `LANDO_TEST_PODMAN_SOCKET` (documented test/CI override only) > Paths default, and the default-from-Paths path is covered by a test with no env var set.
- [ ] `makeRuntimeProvider` no longer treats a missing `LANDO_TEST_PODMAN_SOCKET` as "no socket" in production; a test asserts a runtime built without the env var still resolves a socket path.
- [ ] The Podman API client continues to reach the private socket (curl `--unix-socket` and the native socket transport) using the Paths-derived path; no production behavior depends on a socket outside `<userDataRoot>/runtime/run/`.
- [ ] Tests pass
- [ ] Typecheck passes
- [ ] Lint passes

### US-367: CI prepares the Lando provider via `lando setup` with no manual socket bring-up

**Description:** As a maintainer, CI proves the default Lando-managed runtime end-to-end by running `lando setup` to prepare the environment, with no manually started `podman system service` and no `LANDO_TEST_PODMAN_SOCKET` export.

**Acceptance Criteria:**
- [ ] The generated `provider-integration-linux-*` CI job no longer runs `podman system service ... unix:///tmp/podman.sock` and no longer exports `LANDO_TEST_PODMAN_SOCKET`; it runs the compiled `lando setup --yes` with a current-commit local bundle (`scripts/build-runtime-bundle.ts --local` + `LANDO_RUNTIME_BUNDLE_MANIFEST`) to provision the runtime, and the socket is brought up by `ensureRuntime` (via setup's readiness step and/or the suites' `lando start`), never a manual service.
- [ ] The provider integration and contract suites run against the Lando-managed socket brought up by `ensureRuntime` (US-364) and resolved from setup state / Paths rather than the removed env var.
- [ ] The CI change is made in the generator `scripts/build-ci-workflow.ts` (hand-edits to `.github/workflows/ci.yml` are forbidden); `bun run codegen` is run and `git diff --exit-code` on the generated workflow shows only the intended change; `core/test/build/ci-workflow.test.ts` is updated.
- [ ] The runner provisions only the host prerequisites the Lando rootless runtime needs (subuid/subgid, uidmap, cgroups v2 delegation); a documented `LANDO_TEST_PODMAN_SOCKET` rehearsal fallback remains for local/sandbox environments where rootless service launch is unavailable.
- [ ] `docs/ci-runbook.md` is updated to describe the setup-driven provider preparation.
- [ ] Tests pass
- [ ] Typecheck passes
- [ ] Lint passes

## Functional Requirements

- FR-1: `lando setup` MUST run provider, CA, proxy, shell-integration, and file-sync setup through plugin subscribers and direct service calls.
- FR-2: `lando setup` MUST accept `--yes`, `--provider=<id>`, `--skip-provider`, `--skip-proxy`, `--skip-install-ca`, `--skip-shell-integration`, `--skip-file-sync`, `--runtime-bundle-url`, and `--runtime-bundle-sha256`.
- FR-3: Provider setup flags supplied by `setup.flags` MUST be represented in command metadata and parsed by both dispatch paths.
- FR-4: The default provider path MUST install the Lando-managed runtime; `docker` and `podman` provider choices MUST require an existing system runtime.
- FR-5: CA trust-store installation and any privileged host changes MUST go through `PrivilegeService`.
- FR-6: Linux sudo-prompting setup commands MUST set `SUDO_ASKPASS` when an askpass helper exists.
- FR-7: `lando shellenv` MUST print shell snippets that add `<userDataRoot>/bin` to PATH.
- FR-8: Slow bind-mount providers MUST run active `FileSyncEngine.setup()` and download pinned Mutagen host and agent binaries unless skipped.
- FR-9: Native bind-mount providers MUST treat file-sync setup as a no-op.
- FR-10: Setup downloads MUST honor corporate proxy and custom CA configuration before long download work begins.
- FR-11: Setup MUST be idempotent, re-entrant, and able to produce a doctor-consumable readiness summary.
- FR-12: `lando uninstall` MUST support `--dry-run`, require `--yes` for destructive execution, and enumerate every destructive step before execution.
- FR-13: `--keep-data` and `--purge` MUST split toolchain removal from deliberate data destruction.
- FR-14: OCLIF source dispatch and compiled `$bunfs` dispatch MUST stay in parity for setup, shellenv, and uninstall.
- FR-15: `lando setup` MUST resolve the Lando-managed runtime bundle from a per-platform manifest and MUST support redirecting to a locally-built bundle via `LANDO_RUNTIME_BUNDLE_MANIFEST` or the paired `--runtime-bundle-url`/`--runtime-bundle-sha256` flags, with SHA-256 verification always enforced and never disabled (§5.8.1). Override-loaded manifest entries MAY use `file://` URLs; the bundled production manifest MUST stay `https://`-pinned.
- FR-16: CI MUST verify the real `lando setup` runtime-bundle download-and-verify path against a bundle built from the current commit, using `scripts/build-runtime-bundle.ts --local` + `LANDO_RUNTIME_BUNDLE_MANIFEST` (§13.5).
- FR-17: `@lando/core/paths` and `PathsService` MUST expose `runtimeBinDir`, `runtimeRunDir`, `providerSocketPath`, and `providerPidPath` per §12.4 and MUST pass `check:paths-boundary` (no hand-spelled roots in the provider or core).
- FR-18: `lando setup` MUST extract the verified runtime bundle into `runtimeBinDir` and mark Podman plus helper binaries executable; extraction MUST be checksum-gated (no write before `verifyRuntimeBundle` passes), traversal-safe, and version-idempotent (atomic replace on a version change).
- FR-19: `@lando/provider-lando` MUST own an idempotent `ensureRuntime` that, on Linux, launches the bundled `podman system service` as a detached daemon bound to `providerSocketPath`, pinned to private roots via `--root`/`--runroot`/`--config` under `<userDataRoot>/runtime/`, writing its PID to `providerPidPath` (§5.8.1, §12.4); on macOS and Windows it MUST resolve/(re)start the managed Podman machine connection socket instead. `lando start`, `exec`, and runtime-needing tooling MUST call `ensureRuntime` before they use the runtime, and `lando setup` MUST call the same primitive as a readiness step (setup is not the sole starter).
- FR-20: `ensureRuntime`'s launch MUST use an injectable seam, MUST be idempotent (a reachable socket is not relaunched; a stale PID/socket is reaped and relaunched), and MUST classify rootless prerequisites (`subuid`/`subgid`, `newuidmap`/`newgidmap`, cgroups v2 delegation, `XDG_RUNTIME_DIR`) with per-prerequisite remediation distinct from a generic launch failure.
- FR-21: `RuntimeProvider.getStatus` for `lando` MUST probe the socket/PID rather than return a constant; `apps:poweroff` and `lando uninstall` MUST tear the runtime service down per the chosen retention mode; the US-204 readiness summary MUST include runtime-service state.
- FR-22: `core/src/providers/registry.ts` MUST inject the `PathsService`-resolved socket path so production resolution never depends on `LANDO_TEST_PODMAN_SOCKET`; the env var MUST be demoted to a documented test/CI override with precedence explicit option > env override > Paths default.
- FR-23: CI MUST prepare the Lando provider by running `lando setup` (with a current-commit local bundle) instead of manually starting `podman system service` or exporting `LANDO_TEST_PODMAN_SOCKET`; the change MUST be made in `scripts/build-ci-workflow.ts` and leave `bun run codegen` drift clean except for the intended workflow change.

## Non-Goals

- Replacing provider-specific installers outside the Lando-managed runtime path.
- Silently elevating privileges or storing sudo credentials.
- Embedding Mutagen in the compiled Lando binary.
- Supporting Homebrew, scoop, winget, distro packages, or OCI installers in this PRD.
- Auto-running setup from unrelated commands beyond the explicit Beta 1 setup surface.

## Technical Considerations

- Keep setup planning separate from execution so `lando doctor`, dry-run style renderers, and tests can inspect the same plan.
- Use the existing renderer boundary for user output; setup progress may need task-tree events but must not write directly to stdout or stderr from `core/src/**`.
- Store readiness summaries in a stable schema so doctor can read them without rerunning long setup probes.
- Treat provider-owned state and user-owned app data differently in uninstall planning to avoid deleting user work.
- Keep compiled dispatch free of OCLIF assumptions by sharing pure parsing and command-effect helpers.

## Success Metrics

- On a fresh supported host, `lando setup --yes` completes without manual commands and `lando doctor` reports setup readiness.
- Rerunning `lando setup --yes` reports already-satisfied steps and exits successfully.
- `lando uninstall --dry-run` lists every step a support engineer expects to see, with no filesystem or provider mutations.
- Dual-dispatch parity tests cover every setup, shellenv, and uninstall alias and pass on linux-x64.
- On a fresh supported Linux host, `lando setup --yes` ends with a reachable Lando-owned Podman socket under `<userDataRoot>/runtime/run/` and `lando start` works with no `LANDO_TEST_PODMAN_SOCKET` set.
- The `provider-integration-linux-*` CI job stands up the runtime via `lando setup` and runs the integration + contract suites against the Lando-managed socket with no manual `podman system service`.

## Guide Coverage

Per [Beta 1 index verification](./prd-beta-1-00-index.md) and the §19 guide convention, this PRD owns the executable guides listed below. Each guide exercises the happy path of its mapped user story; failure modes remain covered by unit and integration tests in the named packages. PRs that touch the listed surface paths MUST also touch the corresponding guide(s), or use the `Guide-Coverage-Skip:` escape hatch.

**Guides owned by this PRD:**

| User Story | Feature | Guide Path | Acceptance |
|---|---|---|---|
| US-200, US-204, US-363, US-364, US-365 | First-run setup, runtime service, and readiness | `docs/guides/setup/first-run-readiness.mdx` | Required at story acceptance |
| US-201, US-202 | File sync, proxy, and custom CA setup | `docs/guides/setup/network-and-file-sync.mdx` | Required at story acceptance |
| US-203 | Shell PATH integration | `docs/guides/setup/shellenv-path.mdx` | Required at story acceptance |
| US-205, US-206 | Safe uninstall and purge choices | `docs/guides/setup/uninstall-and-purge.mdx` | Required at story acceptance |
| US-207 | Source and compiled setup parity | `docs/guides/setup/compiled-binary-setup-parity.mdx` | Required at story acceptance |

**CLI / source surface paths covered (drift gate input):**

- `core/src/cli/commands/meta/setup*`
- `core/src/cli/commands/meta/uninstall*`
- `core/src/cli/commands/shellenv*`
- `core/src/setup/**`
- `core/src/uninstall/**`
- `core/src/doctor/**`
- `core/src/cli/run.ts`
- `plugins/provider-*/src/setup*`
- `plugins/file-sync-mutagen/src/**`
- `plugins/ca-mkcert/src/**`
- `plugins/provider-lando/src/runtime-bundle*`
- `plugins/provider-lando/src/index.ts`
- `core/src/config/paths.ts`
- `core/src/providers/registry.ts`
- `scripts/build-runtime-bundle.ts`
- `scripts/build-ci-workflow.ts`

## Open Questions

- Should `lando setup` offer interactive provider selection when `--yes` is absent, or only print the default plan? Default: interactive selection when stdin is TTY.
- Should `--skip-file-sync` be recorded globally or only for the active provider? Default: active provider only.
- Should `--keep-data` preserve caches as data or remove them as toolchain state? Default: preserve app-affecting caches, remove disposable download caches.
- Should uninstall remove shell entries automatically or only print remediation when the profile file has user edits near the Lando block? Default: remove only clearly delimited Lando-managed blocks.
- Should `lando setup` own socket startup, or should the runtime come up on demand? **Resolved:** the socket lifecycle is a provider-owned idempotent `ensureRuntime` (§5.2 principle 8). `lando start`/`exec`/tooling call it before they need the runtime so reboots, crashes, and manual kills self-heal; `lando setup` calls the same primitive eagerly as a readiness step rather than owning it. The socket + PID stay persistent artifacts under `<userDataRoot>/runtime/run/` (§12.4); per-command teardown is rejected for cold-path latency. This mirrors the spec's `ProxyService.setup` → `GlobalAppService.ensureRunning` precedent (§10.8).
- On hosts where rootless `podman system service` cannot run (no subuid/subgid delegation, no cgroups v2), should `lando setup` fail hard or fall back to an external/system socket? Default: fail with per-prerequisite remediation; the `LANDO_TEST_PODMAN_SOCKET` override remains a documented escape hatch for sandboxes and CI rehearsal only.
