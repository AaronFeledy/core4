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
- [ ] Tests pass
- [ ] Typecheck passes
- [ ] Lint passes

## Functional Requirements

- FR-1: `lando setup` MUST run provider, CA, proxy, shell-integration, and file-sync setup through plugin subscribers and direct service calls.
- FR-2: `lando setup` MUST accept `--yes`, `--provider=<id>`, `--skip-provider`, `--skip-proxy`, `--skip-install-ca`, `--skip-shell-integration`, and `--skip-file-sync`.
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

## Guide Coverage

Per [Beta 1 index verification](./prd-beta-1-00-index.md) and the §19 guide convention, this PRD owns the executable guides listed below. Each guide exercises the happy path of its mapped user story; failure modes remain covered by unit and integration tests in the named packages. PRs that touch the listed surface paths MUST also touch the corresponding guide(s), or use the `Guide-Coverage-Skip:` escape hatch.

**Guides owned by this PRD:**

| User Story | Feature | Guide Path | Acceptance |
|---|---|---|---|
| US-200, US-204 | First-run setup and readiness | `docs/guides/setup/first-run-readiness.mdx` | Required at story acceptance |
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

## Open Questions

- Should `lando setup` offer interactive provider selection when `--yes` is absent, or only print the default plan? Default: interactive selection when stdin is TTY.
- Should `--skip-file-sync` be recorded globally or only for the active provider? Default: active provider only.
- Should `--keep-data` preserve caches as data or remove them as toolchain state? Default: preserve app-affecting caches, remove disposable download caches.
- Should uninstall remove shell entries automatically or only print remediation when the profile file has user edits near the Lando block? Default: remove only clearly delimited Lando-managed blocks.
