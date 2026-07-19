# PRD Index — Lando v4 Phase 5 (Beta 1 / "contract completion + feature wave + closure wave")

> **Phase position:** Beta 1 is the **fifth** shipped phase (**MVP → Alpha 1 → Alpha 2 → Alpha 3 → Alpha 4 → Beta 1**) and the first beta, sitting between Alpha 4 ("governance + the last feature surface") and Beta 2 ("feature-freeze hardening"). It has five parts. **Remediation (PRD-01..05):** every story either completes a contract that a shipped Alpha 4 PRD already promised (an explicit MUST in `spec/alpha-4/prd-alpha-4-*.md` whose story was marked `passes: true` while an acceptance sub-requirement remained unmet), or closes spec §8/§12 drift that no later phase owns. **Feature wave (PRD-06..12):** a bounded, deliberate set of new feature surface sequenced here because each either realizes the agent-native tenet (§1.2) on primitives Alpha 4 already shipped or is a small, high-leverage DX/runtime surface, and Beta 1 is the last phase that can add SDK surface before freeze. **Closure wave (PRD-13):** every residual gap recorded in `progress.txt` and prior review is explicit Beta 1 work, not silently deferred post-Beta scope. **Residual hardening (PRD-14):** review/verify hardening deferrals that remained after the closure wave, still inside Beta 1 and still hardening-only (no new freeze surface). **Renderer-substrate wave (PRD-15):** the bundled renderer's specified OpenTUI substrate (§8.9.3), desktop notifications (§8.9.7), and the contract-only freeze of the 4.1 renderer surfaces (§8.9.4–§8.9.8) per the `TunnelService`/`RemoteSource` precedent. At the end of Beta 1 the first signed `4.0.0-beta.N` ships on the `next` channel and **feature freeze is entered**. See [`spec/ROADMAP.md`](../ROADMAP.md) Phase 5 for the authoritative ladder.

## Introduction

A post-Alpha-4 gap audit (2026-07-02) compared every Alpha 4 PRD acceptance criterion and the normative spec parts (§3, §6, §8, §12) against the working tree. All 172 Alpha 4 stories carry `passes: true`, but the audit surfaced a set of **real, verifiable gaps behind the green flags**:

- **Durability MUSTs not met.** PRD-ALPHA4-13 FR-3 requires temp + **fsync** + rename for every durable write; no write path fsyncs. The same PRD's success metric requires **one** durable-store implementation under `core/src/state/`; a second one (`core/src/state-store/json-bucket.ts`) still ships and the managed-file ledger uses it.
- **The probe primitive has zero consumers.** PRD-ALPHA4-14 US-317 requires `HealthcheckRunner`, `UrlScanner`, doctor, downloader, and setup readiness to build on `@lando/sdk/probe`'s `runProbe`; there are **no `runProbe` call sites in `core/src`**, and healthcheck/scanner are still "Unavailable" stubs wired into `lando doctor`.
- **Managed-file contract shortfalls.** PRD-ALPHA4-18 requires `RedactionService`-routed events (the live layer uses a local empty redactor), a `PathsService.managedFileLedger(appId)` member (only an internal helper exists), and a frozen 7-value `FileFormat` enum (the shipped schema adds `javascript`/`typescript`).
- **Renderer ownership.** PRD-ALPHA4-12 moves the default TTY renderer behind `@lando/renderer-lando`; the plugin exports `renderer = Layer.empty` while core still assembles the real renderer.
- **Setup/uninstall/release acceptance residue.** Plugin `setup.flags` are declared in the SDK schema but never merged into `lando setup` metadata; uninstall marks managed provider machines `manual` and can drop the resumable report after a purge failure; macOS/Windows `ensureRuntime` still falls back to system Podman machine tooling and the `LANDO_TEST_PODMAN_SOCKET` test variable; the committed release workflow runs only the dev prerelease, not the 13-stage pipeline.
- **Spec §8 CLI parity drift.** Config surfaces are read-only where §8.2 requires write; `app shell`, `app logs`, `app includes update`, the global-app commands, and `lando version` all diverge from their spec'd contracts; §12 cache writes bypass the atomic helper.

This PRD set picks up at **US-372** (Alpha 4 ended at US-371) and runs through **US-464**: US-372..US-395 are the remediation stories, US-396..US-409 are the agent-native feature-wave stories, US-410..US-412 (PRD-10) cover runtime-bundle distribution, US-413..US-424 (PRD-11) lock the Podman 6 runtime contract, US-425..US-429 (PRD-12) add the service-log-sources primitive (§6.14), US-430..US-443 (PRD-13) are the Beta 1 closure wave, US-444..US-454 plus US-461 (PRD-14) close review-time hardening deferrals (including the Windows managed setup→API gap found in US-450 verify), and US-455..US-460 (PRD-15) land the renderer-substrate wave — the §8.9.3 OpenTUI substrate contract, desktop notifications, and the contract-only freeze of the 4.1 renderer surfaces (§8.9.4–§8.9.8) per the `TunnelService`/`RemoteSource` precedent. US-462..US-464 (also PRD-15) close the event-subsystem spec parity gaps found reviewing US-459: `EventService.publish` payload validation plus the §11.1 zero-subscriber fast path, bootstrap-level subscriber validation (`SubscriberLevelMismatchError`) with per-level bootstrap event names, and actual emission of the §11.4 bootstrap lifecycle sequence. PRD-10 stood up the in-repo `runtime-v*` publishing pipeline and the §5.8.1 committed-manifest invariant. PRD-13 closed the remote-only Linux asset defect and the primary residual progress gaps. PRD-14 keeps the remaining review/verify hardening residuals inside Beta 1 scope rather than silently deferring them past feature freeze.

The feature wave is spec'd first, PRD'd second: the four features were worked into the normative spec parts before these PRDs were written — `McpService` (§10.14) + `meta:mcp` (§8.2.6) + `mcpAllowed:` (§8.3), agent-context env forwarding (§6.9.1, §7.4, §7.5), `app:open` (§8.2.5), the `lando:` version constraint (§7.4), and `apps:scratch:run` + the `toolbox` recipe (§21.10.3, §8.8.10). When a feature PRD and a spec part disagree, the spec part wins.

The Podman 6 and closure waves follow the same convention: the runtime/CLI/tooling contracts were spec'd first, and PRD-11/PRD-13 record the Beta 1 stories that make those contracts true before feature freeze. PRD-13 stories are closure work for this beta; they are not a post-Beta backlog.

## How to use this set of PRDs

- Each PRD is self-contained and follows the Alpha 4 convention: introduction, source references, goals, user stories, functional requirements, non-goals, technical considerations, success metrics, guide coverage, and open questions.
- The spec parts in [`spec/`](../README.md) remain source of truth. When these PRDs and a spec part disagree, the spec part wins and both must be updated together.
- Every story follows the Alpha 4 verification contract: TDD acceptance criteria, plus `Tests pass`, `Typecheck passes`, `Lint passes`, and any touched boundary/codegen gate.
- Where a Alpha 4 PRD is the origin of a requirement, the story cites the originating PRD and criterion so the remediation is traceable.
- Stories that **relax** a shipped contract (e.g. `FileFormat`) must update the originating Alpha 4 PRD text and the schema snapshot in the same change; silent drift between PRD text and shipped schema is exactly what this phase exists to eliminate.

## PRDs in this set

| #  | PRD | Subsystem | US range | Depends on |
| -- | --- | --------- | -------- | ---------- |
| 01 | [Durability & probe-consumer remediation](./prd-beta-1-01-durability-and-probe.md) | fsync-backed atomic writes, single durable store, `runProbe`-backed healthcheck/scanner/doctor/downloader/setup, event-test coverage, working-tree hygiene | US-372..US-378 | — |
| 02 | [Managed-file contract completion](./prd-beta-1-02-managed-file-completion.md) | `RedactionService` wiring, `PathsService.managedFileLedger`, `FileFormat` reconciliation | US-379..US-381 | PRD-01 (StateStore unification) |
| 03 | [Renderer ownership & machine-output seam](./prd-beta-1-03-renderer-and-output-seam.md) | `@lando/renderer-lando` owns the default renderer layer; doctor NDJSON through the central StreamFrame seam | US-382..US-383 | — |
| 04 | [Setup, uninstall & release remediation](./prd-beta-1-04-setup-uninstall-release.md) | plugin `setup.flags` merge, uninstall machine teardown + report durability, macOS/Windows managed-runtime path, release-automation decision | US-384..US-388 | — |
| 05 | [CLI spec parity (§8)](./prd-beta-1-05-cli-spec-parity.md) | config write surfaces, translate flow, includes update scoping, shell parity, logs follow/since, global-app stubs, real version | US-389..US-395 | PRD-01 (US-372 atomic helper) |
| 06 | [Agent-native surfaces](./prd-beta-1-06-agent-native-surfaces.md) | `McpService` + `meta:mcp` (§10.14, §8.2.6), `mcpAllowed:` allowlist + cache, MCP contract suite + doctor check, agent-context env forwarding (§6.9.1) | US-396..US-401 | PRD-03 (output seam) |
| 07 | [`lando open`](./prd-beta-1-07-app-open.md) | `app:open` target resolution, opener helper, headless degradation, host-proxy round-trip (§8.2.5) | US-402..US-403 | — |
| 08 | [Landofile version constraint](./prd-beta-1-08-version-constraint.md) | top-level `lando:` key, accumulate-across-layers evaluation, `LandofileVersionConstraintError`, hot-path enforcement, doctor reporting (§7.4) | US-404..US-405 | — |
| 09 | [Disposable tool runner](./prd-beta-1-09-disposable-tool-runner.md) | `apps:scratch:run` (`lando run`), bundled `toolbox` recipe, exit-code propagation, `--keep`, reserved `run` alias (§21.10.3, §8.8.10) | US-406..US-409 | PRD-06 (US-400 env forwarding) |
| 10 | [Runtime-bundle publishing](./prd-beta-1-10-runtime-bundle-publishing.md) | in-repo `runtime-v*` release series, real pinned `runtime-bundle-versions.json` (local builds run `lando setup` with zero overrides), committed-manifest invariant gates (§5.8.1, §13.5, §17.8) | US-410..US-412 | — (US-387 adjacent, not blocking) |
| 11 | [Podman 6 runtime contract](./prd-beta-1-11-podman-6.md) | Podman 6 bundle baseline, machine OS upgrade/remediation flow, provider capability probes, runtime-bundle manifest alignment, rollback guidance | US-413..US-424 | PRD-10 (runtime-bundle publishing) |
| 12 | [Service log sources](./prd-beta-1-12-service-log-sources.md) | `LogSource` schema + `LogChunk.source` + `serviceLogSources` capability, service-type/Landofile `logs:` intent, build-time `redirect` reification, provider-owned `follow` semantics, `lando logs --source` + redaction boundary (§6.14, §5.3, §5.4, §10.9) | US-425..US-429 | PRD-05 (US-393 logs follow/since) |
| 13 | [Beta closure wave](./prd-beta-1-13-beta-closure.md) | corrected local-engine Linux runtime bundle, independent closure review lanes, live Podman 6 acceptance, production runLando transport, real log-follow file access, buildKey short-circuit, remaining Podman seams, global rebuild, MCP read-only config projection, Bun.$ host REPL, MCP stdio hardening, version-constraint closure, generic CLI lifecycle events, tooling-router dispatch | US-430..US-443 | PRD-05, PRD-06, PRD-08, PRD-09, PRD-10, PRD-11, PRD-12 |
| 14 | [Residual hardening](./prd-beta-1-14-residual-hardening.md) | host-proxy IPC backpressure, CLI flag-parse fail-closed, clean-tree public-transcript gate, runtime-bundle CI supply-chain pins, MCP serialization bounds, Landofile TS form-parity, Windows machine trust + Hyper-V privilege contract closure, Windows managed setup→API (win-sshproxy helpers), host-proxy doctor DNS, MCP serve guide, macOS/Windows machine live cells, pre-command failure surface consistency | US-444..US-454, US-461 | PRD-13 (closure-wave review deferrals) + US-450 Windows interop verify |
| 15 | [Renderer substrate & notifications](./prd-beta-1-15-renderer-substrate-and-notifications.md) | OpenTUI `^0.4.3` substrate + import-discipline/degradation contract (§8.9.3) + per-target compiled native packaging via `scripts/build-compiled-binary.ts`'s onResolve plugin pruning 7 of 8 catalog native packages (§17.3.1), split-footer task-tree live region, prompt chrome + frame-snapshot harness, complete `RendererCapabilities` + foreground-only `notify.desktop`/`NotifyConfig` realized through OpenTUI's `triggerNotification` + deletion of the accidental `HostProxyRequest` `notify`/`clipboardCopy` verbs + bundled `@lando/notify-lando` implementing the §11.3.1/§9.5 schema-derived subscriber manifest/context/`configKey` surface, contract-only freeze of the 4.1 renderer surfaces (§8.9.4–§8.9.6, §8.9.8, `rendererPanels:` §9.5), event-subsystem spec parity follow-ups from US-459 review (publish validation + §11.1 zero-subscriber fast path, `SubscriberLevelMismatchError` + per-level bootstrap event names, §11.4 bootstrap lifecycle emission) | US-455..US-460, US-462..US-464 | PRD-03 (renderer ownership) |

## Verification contract (applies to every story)

1. Write failing tests first (unit or scenario) that encode the acceptance criteria, then implement until green.
2. `bun run typecheck`, `bun test`, and `bun run lint` pass.
3. Any touched boundary gate passes: `check:renderer-boundary`, `check:managed-file-boundary`, `check:state-store-boundary`, `check:probe-boundary`, `check:redaction-boundary`, `check:paths-boundary`, plus guide gates when guide-owned surfaces change.
4. If a generator output changes, the generator and its emitted files land in the same change with `git diff --exit-code` clean on the generated paths.
5. If an `@lando/sdk` export or schema changes, follow `sdk/AGENTS.md`: update `sdk/API_COMPATIBILITY.md` where required and refresh `bun run codegen:schema-snapshot`.

## Origin-audit traceability

| Gap | Origin | Remediated by |
| --- | ------ | ------------- |
| No fsync in durable/atomic write paths | PRD-ALPHA4-13 FR-3 | US-372 |
| Second durable store (`json-bucket.ts`) + ledger consumer | PRD-ALPHA4-13 FR-1 / success metric | US-373 |
| Healthcheck/scanner are Unavailable stubs; no `runProbe` consumers | PRD-ALPHA4-14 US-317 | US-374, US-375, US-376 |
| `waitForEvent` has no runtime behavior test | PRD-ALPHA4-14 FR-9 | US-377 |
| Orphaned untracked Mutagen downloader files | working-tree discipline (root `AGENTS.md`) | US-378 |
| Managed-file events bypass `RedactionService` | PRD-ALPHA4-18 | US-379 |
| `PathsService.managedFileLedger(appId)` missing | PRD-ALPHA4-18 | US-380 |
| `FileFormat` wider than the frozen enum | PRD-ALPHA4-18 | US-381 |
| `@lando/renderer-lando` exports an empty renderer layer | PRD-ALPHA4-12 | US-382 |
| Raw `JSON.stringify` StreamFrame call sites in doctor commands | PRD-ALPHA4-15 US-326 | US-383 |
| Plugin `setup.flags` never merged into setup metadata | PRD-ALPHA4-01 US-200 AC-4 | US-384 |
| Uninstall leaves provider machines to manual teardown | PRD-ALPHA4-01 | US-385 |
| Uninstall report dropped on purge failure | PRD-ALPHA4-01 US-206 | US-386 |
| macOS/Windows runtime falls back to system Podman machine + test env var | PRD-ALPHA4-01 US-363..367 | US-387 |
| Release CI runs only dev prerelease, not the 13-stage pipeline | PRD-ALPHA4-08 | US-388 |
| Read-only config surfaces (`app config` / `meta config` / `meta global config`) | spec §8.2.1 / §8.2.2 / §8.4 | US-389 |
| `app config translate` missing detect/list/from/file flow | spec §8.2.1 | US-390 |
| `app includes update` missing source scoping + `--no-network` | spec §8.2.3 | US-391 |
| `app shell` service-mode default, `child_process` host path, missing flags | spec §8.2.4 | US-392 |
| `app logs` missing `--follow` / `--since` | spec §8.2.5 | US-393 |
| `meta global list/info/logs/restart` are deferred stubs | spec §8.4 / §18 (global app) | US-394 |
| `lando version` / `CORE_VERSION` are `0.0.0` placeholders | spec §8.1 / §17 | US-395 |
| `runtime-bundle-versions.json` is a placeholder (dead repo URLs, zero checksums); `lando setup` requires `LANDO_RUNTIME_BUNDLE_MANIFEST` | spec §5.8.1 / §13.5 / §17.8 | US-410, US-411, US-412 |
| Published Linux runtime asset is checksum-valid but remote-only and rejects managed-service `--root` / `--runroot` | progress US-411 verify/review entries | US-430 |
| Review lanes returned timeout/empty/instruction-only results but were previously near closure evidence | Beta closure review discipline / progress review notes | US-431 |
| Live Podman 6 E2E acceptance still needs supported provider/host pass-vs-skip evidence, including managed setup after corrected bundle | PRD-11 / progress runtime verification notes | US-432 |
| Host-proxy runLando has logical dispatcher coverage but no production socket/shim/mount/token/concurrency/recursion transport | spec §10.10 / progress host-proxy notes | US-433 |
| Provider log-follow must prove real container file access and rotation/truncation/follow cleanup end-to-end | spec §6.14 / PRD-12 | US-434 |
| `lando run` proves fresh scratch identity but not the §6.13.5 buildKey/build-results short-circuit | spec §6.13.5 / PRD-09 progress notes | US-435 |
| Podman 6 image-pull, volume-prune, doctor-OOM, and machine-trust seams need live or env-gated safety/redaction evidence | PRD-11 residual seams | US-436 |
| `meta:global:rebuild` remains a `NotImplementedError` after list/info/logs/restart graduated | spec §8.4 / progress global command notes | US-437 |
| MCP cannot expose `app:config get/view` safely while the command registry is canonical-id scoped around a write-capable umbrella command | spec §8.3 / progress MCP allowlist notes | US-438 |
| Full §8.2.3 Bun.$ host REPL with per-line redacted history/events remains unimplemented | spec §8.2.3 / progress shell review notes | US-439 |
| MCP serve startup-refusal parity and bounded stdio buffering/backpressure need adversarial coverage | spec §8.2.6 / §10.14 | US-440 |
| Version-constraint implementation lacks six-file provenance, full npm-semver grammar, schema-level validation/predicates, structured warnings, and cache correctness | spec §7.4 / PRD-08 progress review notes | US-441 |
| Generic CLI command lifecycle events remain a CLI hook TODO beyond command-specific events | spec §3.5 / §8.11 / progress app:open review notes | US-442 |
| `command_not_found` tooling-router path remains a source-router stub that does not dispatch tooling with version/cache/network policies | spec §16.7 / progress tooling-router notes | US-443 |
| Detached-worker payload `stdin.write` without backpressure | US-433 verify Bugbot follow-up | US-444 |
| Malformed flag-value parsing is a pre-existing defensive CLI concern | US-431 review deferred | US-445 |
| Public-transcript inventory unavailable on clean build trees | US-433 / US-439 / US-443 verification notes | US-446 |
| Mutable action tags + unversioned Ubuntu build packages | US-430 non-blocking security residuals | US-447 |
| MCP streaming JSON serialization not bounded | US-440 review deferred | US-448 |
| TypeScript-form lint/include-update parser gap (§7.1.1) | US-441 review deferred | US-449 |
| Windows managed-machine trust + Hyper-V privilege contract needs explicit non-elevate closure (not a UAC path) | US-436 completion notes / US-423 no-auto-elevate | US-450 |
| Windows managed setup creates machine/trust but Podman API stays unreachable (`win-sshproxy` / helper_binaries_dir) | US-450 Windows interop verify | US-461 |
| Host-proxy DNS doctor check broader follow-up | US-433 review deferred | US-451 |
| MCP serve guide not authored | US-440 review deferred | US-452 |
| macOS/Windows machine lifecycle not live-exercised from Linux | Podman 6 wave / US-432 advisory skips | US-453 |
| Pre-parse / runtime-layer failures outside shared command lifecycle | US-442 review deferred | US-454 |
| `EventService.publish` never validates payloads and only gates manifest-subscriber dispatch, not the full §11.1 zero-subscriber no-op | US-459 review / spec §3.5 publish contract | US-462 |
| `SubscriberLevelMismatchError` is spec-only; no manifest `bootstrap:` declaration, and the SDK taxonomy lacks the per-level `pre/post-bootstrap-<level>` names | US-459 review / spec §3.5 | US-463 |
| No production code emits the §11.4 bootstrap lifecycle events (`pre/post-bootstrap-<level>`, `post-bootstrap`, `ready`, `before-exit`) | US-459 review / spec §3.5 | US-464 |

## Explicit post-4.0 deferrals (not Beta 1 stories)

These were recorded in progress as deferred or rejected-as-broader-scope and must **not** be pulled into PRD-14 as feature work:

| Deferred capability | Why not Beta 1 residual hardening | Suggested later home |
| --- | --- | --- |
| Host-proxy generic dispatch beyond generated `app:open` allowlist | New command surface / allowlist expansion | 4.1+ agent/host-proxy polish |
| Tooling schema graduation (`topLevelAlias` / `disabled` / `aliases` / `namespace`) | New tooling schema surface; intentionally rejected by Beta parser | 4.1 tooling schema |
| Service-plugin version provenance in `buildKey` | Needs `ServicePlan` contributor metadata (schema) | 4.1 scratch/build provenance |
| Stale external image pruning / artifact-existence contract | New `RuntimeProvider` capability | 4.1+ provider data-plane |
| MCP HTTP transport | New transport surface; stdio-only for v4.0 | 4.2+ agent surfaces |
| Dynamic external-flag two-phase parser for plugin `setup.flags` | New CLI parser architecture | 4.2 plugin authoring polish |
| Broader TypeScript Landofile loader isolation/purity enforcement | Security architecture beyond form-parity | 4.1+ Landofile hardening |
| Privileged host DNS / hosts-file mutation for `host.lando.internal` | Rejected in US-439 in favor of `LANDO_HOST_IP` | only if product revisits |
