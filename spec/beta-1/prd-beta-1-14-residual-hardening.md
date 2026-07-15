# PRD: BETA1-14 — Residual hardening from closure-wave review deferrals

## Introduction

US-430..US-443 closed the Beta 1 closure-wave story ledger, but review and verify notes still deferred concrete hardening that is required before feature freeze can honestly claim "no residual gaps." This PRD keeps that work **inside Beta 1** rather than silently pushing it past freeze.

Scope is hardening and contract parity only: no new commands, flags, service types, or optional feature surface. Feature-shaped follow-ups that would expand freeze surface are listed as non-goals and deferred post-4.0.

## Source References

- [`progress.txt`](./progress.txt) — US-430, US-431, US-433, US-436, US-440, US-441, US-442, US-443 review/verify deferrals
- [`prd-beta-1-13-beta-closure.md`](./prd-beta-1-13-beta-closure.md) — completed closure stories that left residuals
- [`../08-cli-and-tooling.md`](../08-cli-and-tooling.md) — CLI parsing, MCP stdio, doctor surfaces
- [`../07-landofile-and-config.md`](../07-landofile-and-config.md) §7.1.1 form parity
- [`../11-subsystems.md`](../11-subsystems.md) §10.10 host-proxy
- [`../13-testing-and-distribution.md`](../13-testing-and-distribution.md) / guide gates — public transcript inventory
- [`../15-binary-build-and-release.md`](../15-binary-build-and-release.md) — runtime-bundle release hygiene
- [`../17-executable-tutorials.md`](../17-executable-tutorials.md) — executable guides

## Goals

- Close host-proxy transport hardening deferred from US-433 (IPC backpressure, doctor DNS).
- Make defensive CLI flag parsing and pre-command failure surfaces fail-closed and agent-drivable.
- Restore clean-tree operability of public-transcript / guide inventory gates.
- Pin runtime-bundle CI supply-chain residuals called out in US-430 security review.
- Bound MCP response serialization memory the way request/queue bytes are already bounded; ship an MCP serve guide.
- Close the Landofile TypeScript-form lint/include-update form-parity gap without expanding TS execution surface.
- Lock the Windows managed-machine trust + Hyper-V privilege contract (US-423/US-436): non-elevating trust sync, permanent manual Hyper-V remediation — no UAC path for either.
- Prove macOS/Windows machine lifecycle with structured pass/fail/skip cells.

## Non-goals

- Expanding the host-proxy allowlist beyond the generated `app:open` set (post-4.0).
- Graduating tooling schema fields (`topLevelAlias`, `disabled`, `aliases`, `namespace`).
- Adding MCP HTTP transport or new MCP tools beyond guide coverage of the existing stdio surface.
- New `RuntimeProvider` artifact-existence / prune APIs or service-plugin version provenance in `buildKey`.
- Dynamic external-flag two-phase parser for plugin `setup.flags`.
- Broader TypeScript Landofile loader isolation/purity enforcement beyond form-parity.
- Privileged hosts-file mutation for `host.lando.internal` (rejected in US-439 in favor of `LANDO_HOST_IP`).
- Windows UAC / `PrivilegeService.elevate` for Hyper-V prep, machine-trust sync, or any other path that reopens the US-423/US-436 no-auto-elevate contract. Host CA trust-store UAC (if still incomplete) is a separate setup/`PrivilegeService` concern, not US-450.

## User Stories

### US-444: Host-proxy worker IPC write backpressure

**Description:** As a host-proxy operator, detached-worker startup cannot hang or lose payload bytes when the worker stdin pipe applies backpressure.

**Acceptance Criteria:**

- [ ] Worker payload delivery uses backpressure-aware write/end semantics (or an equivalent bounded framing path) rather than a single unbounded `stdin.write` of the full payload.
- [ ] Oversized or slow-consumer cases fail with a tagged, remediated error and do not leave orphan workers or half-started sessions.
- [ ] Focused tests cover successful delivery, partial-write/backpressure, and failure cleanup; existing toolbox/host-proxy readiness proofs remain green.
- [ ] Tests pass
- [ ] Typecheck passes
- [ ] Lint passes

### US-445: Malformed CLI flag-value parsing fails closed

**Description:** As a CLI user, malformed flag values produce tagged failures with remediation instead of silent mis-parses or defect paths.

**Acceptance Criteria:**

- [ ] Representative OCLIF and compiled-dispatch flag parsers reject malformed values (missing required values, illegal shapes, truncated combined forms) with tagged errors and non-zero exit codes.
- [ ] Source and compiled dispatch share the failure identity and exit-code parity for the covered cases.
- [ ] Machine-output mode emits the standard error envelope (`_tag` / `message` / `remediation`) without leaking secrets.
- [ ] Tests pass
- [ ] Typecheck passes
- [ ] Lint passes

### US-446: Clean-tree public-transcript inventory gate

**Description:** As a maintainer on a clean build tree, public-transcript / guide inventory gates are operable without requiring an unrelated full generated transcript corpus to already exist.

**Acceptance Criteria:**

- [ ] `check:public-transcripts` (and any dependent inventory gate used in CI) either generates the required corpus as part of the gate or documents and implements a deterministic bootstrap path that works from a clean tree.
- [ ] Clean-tree CI/local reproduction no longer reports the gate as "unavailable" solely because generated transcripts were absent after `bun run clean` / a fresh clone build.
- [ ] Guide lint/coverage/drift gates remain green for existing owned guides.
- [ ] Tests pass
- [ ] Typecheck passes
- [ ] Lint passes

### US-447: Runtime-bundle CI supply-chain pin residuals

**Description:** As a release owner, runtime-bundle publish workflows pin third-party actions and build package inputs tightly enough that the US-430 non-blocking security residuals are closed.

**Acceptance Criteria:**

- [ ] Runtime-bundle (and closely related publish) workflows pin GitHub Actions to immutable digests or an equivalent fail-closed pin policy already used elsewhere in the repo; mutable floating tags are not reintroduced for those steps.
- [ ] Ubuntu/build package installs used to assemble runtime bundles are version-pinned or otherwise locked so unversioned package drift cannot silently change bundle contents.
- [ ] Generated workflow drift checks and runtime-bundle tests remain green after the pin changes.
- [ ] Tests pass
- [ ] Typecheck passes
- [ ] Lint passes

### US-448: MCP streaming JSON serialization bounds

**Description:** As an MCP client, large command results cannot grow process memory without bound during JSON serialization even when the retained outbound queue is already byte-capped.

**Acceptance Criteria:**

- [ ] Serialization of MCP tool results / progress payloads is bounded or streamed such that a single oversized result cannot retain unbounded intermediate buffers beyond a documented limit.
- [ ] Oversized results fail with a tagged transport/result error and free retained buffers; active request caps and completion tombstone caps from US-440 remain intact.
- [ ] Focused adversarial tests cover large result bodies and prove process-level retention stays under the documented bound (or fails closed before exceeding it).
- [ ] Tests pass
- [ ] Typecheck passes
- [ ] Lint passes

### US-449: Landofile TypeScript-form lint and include-update parity

**Description:** As an author of TypeScript Landofiles, lint and include-update paths honor the same §7.1.1 form-parity rules as YAML layers instead of silently skipping or mis-handling TS forms.

**Acceptance Criteria:**

- [ ] Lint and include-update entrypoints accept TypeScript-form layers where §7.1.1 permits them, or fail closed with tagged remediation when a path cannot be handled — never silently no-op.
- [ ] Same-layer YAML+TypeScript dual forms still fail through `LandofileFormConflictError` (or the current canonical tagged conflict).
- [ ] Focused tests cover TS-only roots, mixed-layer apps, and include-update behavior without expanding the TS loader security model beyond existing trusted-author assumptions.
- [ ] Tests pass
- [ ] Typecheck passes
- [ ] Lint passes

### US-450: Windows managed-machine trust + Hyper-V privilege contract closure

**Description:** As a Windows user of the managed Podman machine, ownership-gated CA trust sync completes without elevation, and Hyper-V / virtualization gaps stay fail-closed manual remediation — never auto-elevated — matching US-423 and US-436.

**Acceptance Criteria:**

- [ ] Ownership-gated Windows managed-machine trust sync (`podman machine init|set --import-native-ca` for Lando-owned machines only) is documented and tested as **non-elevating**: it does not call `PrivilegeService.elevate` and does not request UAC.
- [ ] Windows Hyper-V / virtualization prerequisite failures remain fail-closed tagged errors (e.g. `WindowsMachinePrerequisiteError`) whose remediation names the exact manual steps (`wsl --install` / `wsl --update` / elevated `podman system hyperv-prep` as applicable) and states that Lando never runs prep or elevates for the user — reaffirming US-423 and US-436, not reopening them.
- [ ] Non-Windows hosts remain structured skips or unchanged; Linux/macOS trust-import behavior does not regress.
- [ ] Platform- or env-gated tests lock the no-auto-elevate contracts (trust sync does not elevate; Hyper-V remediation never auto-runs prep); secrets and host paths stay redacted in remediation and events.
- [ ] Tests pass
- [ ] Typecheck passes
- [ ] Lint passes

### US-451: Host-proxy doctor DNS reachability check

**Description:** As a user debugging in-container `runLando` failures, doctor reports host-proxy DNS/name reachability problems with structured remediation rather than only failing at request time.

**Acceptance Criteria:**

- [ ] Doctor includes a host-proxy DNS/reachability check for the production transport (Unix socket path or Windows Desktop alias/loopback bridge as applicable).
- [ ] Failures are typed doctor findings with remediation; passes are silent or informational without false alarms when host-proxy is intentionally unavailable/no-op.
- [ ] NDJSON/text doctor output stays on the renderer/redaction seams.
- [ ] Tests pass
- [ ] Typecheck passes
- [ ] Lint passes

### US-452: MCP serve executable guide

**Description:** As a developer wiring agents to Lando, an executable guide documents MCP serve startup, allowlisted tools, refusal modes, and bounded stdio behavior.

**Acceptance Criteria:**

- [ ] An executable guide under `docs/guides/` covers `lando mcp` / serve startup, non-interactive stdio requirements, startup refusals (TTY/unusable stdio/incompatible machine-output), and at least one successful tool call path.
- [ ] Guide codegen, lint, coverage, and public-transcript gates pass for the new guide (or an explicit matrix entry if required).
- [ ] The guide does not claim write-capable app-config tools; read-only projection from US-438 remains authoritative.
- [ ] Tests pass
- [ ] Typecheck passes
- [ ] Lint passes

### US-453: macOS/Windows machine lifecycle live acceptance

**Description:** As a release owner, managed/system machine lifecycle on macOS and Windows is either live-proven or structured-skipped with release-policy clarity — not silently untested.

**Acceptance Criteria:**

- [ ] Env-gated acceptance cells exist for macOS and Windows machine start/stop (and destroy where claimed) for the providers Beta 1 still supports on those hosts.
- [ ] Missing credentials, unsupported host, or absent machine tooling produces a structured skip with reason; a broken claimed path fails, never passes.
- [ ] CI/release reporting distinguishes pass/fail/skip; release-blocking cells are named in the story notes or provider-matrix config.
- [ ] Linux cells from US-432 remain green and are not regressed.
- [ ] Tests pass
- [ ] Typecheck passes
- [ ] Lint passes

### US-454: Pre-command failure surface consistency

**Description:** As an agent or CI consumer, failures that occur before a resolved command lifecycle still emit consistent tagged machine envelopes and exit codes.

**Acceptance Criteria:**

- [ ] Pre-parse validation failures and runtime-layer construction failures that are user-facing emit the standard machine error envelope (or documented bootstrap equivalent) with non-zero exit codes on both source and compiled paths.
- [ ] These failures are either (a) explicitly documented as outside generic `cli-*-init/run/error` events with tests locking that contract, or (b) folded into a minimal bootstrap lifecycle without inventing new public event schema fields unless required.
- [ ] Secret-bearing argv/env fragments are not echoed in failure messages.
- [ ] Tests pass
- [ ] Typecheck passes
- [ ] Lint passes

### US-461: Windows managed setup reaches Podman API (win-sshproxy helpers)

**Description:** As a Windows user of provider-lando, `lando setup --provider=lando` completes with a reachable managed Podman API after machine create/trust — not a green machine with a dead client connection — so real Windows first-run works.

**Acceptance Criteria:**

- [ ] The win32-x64 runtime bundle (and post-extract runtime bin dir) ships the Windows machine helper binaries Podman needs for client API reachability after `podman machine start` — at minimum `win-sshproxy.exe` alongside existing helpers such as `gvproxy.exe` — and managed `containers.conf` / helper discovery points at that directory so Podman does not fail with missing `helper_binaries_dir` entries.
- [ ] On Windows, non-interactive `lando setup --yes --no-interactive --provider=lando` ends with a reachable Podman API for the Lando-owned machine (ping/info succeed) when Hyper-V/WSL virtualization prerequisites are already satisfied; machine ownership-gated native CA trust (`ImportNativeCA` / startup CA import) remains non-elevating and Hyper-V prep remains manual-only (US-423/US-436/US-450).
- [ ] When helper or API reachability fails, the failure is a tagged, remediated `ProviderUnavailableError` (or existing equivalent) that names the missing helper or connection surface without leaking host secrets; setup does not claim success with an unreachable runtime.
- [ ] CI proves the Windows green path beyond `--version`/`--help`/`shellenv` smoke: at least one `windows-2022` job runs compiled-binary setup (or an env-gated live cell) that asserts machine + API reachability, or structured-skips only when the runner cannot host a Podman machine — never silent pass on a broken claimed path. US-453 lifecycle cells may share infrastructure but do not replace this setup/API gate.
- [ ] Linux/macOS managed setup paths do not regress.
- [ ] Tests pass
- [ ] Typecheck passes
- [ ] Lint passes

**Notes:** Origin US-450 Windows interop verify: machine created with `ImportNativeCA: true` and successful host CA import without UAC, then setup failed because `win-sshproxy.exe` was missing from helper discovery. Existing CI windows jobs smoke the binary and run contract unit tests; they do not prove live managed setup→API.

## Functional Requirements

- **FR-1:** Every story is hardening or parity against already-shipped contracts; no new user-facing feature surface.
- **FR-2:** Tagged failures and doctor findings remain machine-legible (`_tag` / remediation / doctor section schema).
- **FR-3:** Source and compiled CLI paths stay paired wherever CLI parsing or doctor projection changes.
- **FR-4:** Generated workflows/manifests are updated via generators, not hand-edited.
- **FR-5:** Guides for US-452 are executable and owned by the guide pipeline.

## Technical Considerations

- Prefer reusing existing host-proxy, MCP transport, doctor, and Landofile seams over new subsystems.
- US-448 memory bounds should align with US-440 queue byte policy when one is already normative.
- US-450 is contract proof, not a new elevation path: machine trust stays non-privileged; Hyper-V prep stays permanent manual remediation. Do not add UAC/`runas` for either surface.
- US-454 may document exclusion from generic lifecycle events rather than inventing schema if the shared boundary still lacks a resolved command identity.

## Success Metrics

- `spec/beta-1/prd.json` contains unique ordered US-444..US-454 and US-461 entries with priorities continuing after US-443 (US-461 inserted at high priority after US-450 verify findings) and residual stories start at `passes: false` until closed.
- Every residual row in the index traceability table maps to a story in this PRD or an explicit post-4.0 non-goal.
- Beta 1 feature freeze is not claimed until US-444..US-454 and US-461 pass or are deliberately reclassified with source-backed rationale and synchronized PRD/spec text.

## Guide Coverage

| Surface | Guide | Status |
| --- | --- | --- |
| MCP serve / stdio hardening | new MCP guide (US-452) | Pending |
| Host-proxy doctor DNS | doctor guide / host-proxy notes | Update when US-451 lands |
| Public transcripts on clean trees | guide pipeline runbook | Update when US-446 lands |

## Open Questions

- Exact memory bound for US-448 if not already normative in MCP queue policy.
- Whether US-454 should emit any bootstrap event at all, or only envelope/exit-code parity.

**Resolved:** US-450 does **not** add UAC-prompt elevation for Hyper-V prep or machine-trust sync. Remediation-only for Hyper-V; non-elevating ownership-gated trust import for machine CA sync. Aligns with US-423, US-436, and agent-drivable failure surfaces.
