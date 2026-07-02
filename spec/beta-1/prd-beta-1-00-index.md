# PRD Index — Lando v4 Phase 5 (Beta 1 / "contract completion + the agent-native feature wave")

> **Phase position:** Beta 1 is the **fifth** shipped phase (**MVP → Alpha 1 → Alpha 2 → Alpha 3 → Alpha 4 → Beta 1**) and the first beta, sitting between Alpha 4 ("governance + the last feature surface") and Beta 2 ("feature-freeze hardening"). It has two halves. **Remediation (PRD-01..05):** every story either completes a contract that a shipped Alpha 4 PRD already promised (an explicit MUST in `spec/alpha-4/prd-alpha-4-*.md` whose story was marked `passes: true` while an acceptance sub-requirement remained unmet), or closes spec §8/§12 drift that no later phase owns. **Feature wave (PRD-06..09):** a bounded, deliberate set of new feature surface — the agent-native surfaces (`lando mcp` + agent-context env forwarding), `lando open`, the Landofile version constraint, and the disposable tool runner (`lando run`) — sequenced here because each either realizes the agent-native tenet (§1.2) on primitives Alpha 4 already shipped or is a small, high-leverage DX surface, and Beta 1 is the last phase that can add SDK surface before freeze. At the end of Beta 1 the first signed `4.0.0-beta.N` ships on the `next` channel and **feature freeze is entered**. See [`spec/ROADMAP.md`](../ROADMAP.md) Phase 5 for the authoritative ladder.

## Introduction

A post-Alpha-4 gap audit (2026-07-02) compared every Alpha 4 PRD acceptance criterion and the normative spec parts (§3, §6, §8, §12) against the working tree. All 172 Alpha 4 stories carry `passes: true`, but the audit surfaced a set of **real, verifiable gaps behind the green flags**:

- **Durability MUSTs not met.** PRD-ALPHA4-13 FR-3 requires temp + **fsync** + rename for every durable write; no write path fsyncs. The same PRD's success metric requires **one** durable-store implementation under `core/src/state/`; a second one (`core/src/state-store/json-bucket.ts`) still ships and the managed-file ledger uses it.
- **The probe primitive has zero consumers.** PRD-ALPHA4-14 US-317 requires `HealthcheckRunner`, `UrlScanner`, doctor, downloader, and setup readiness to build on `@lando/sdk/probe`'s `runProbe`; there are **no `runProbe` call sites in `core/src`**, and healthcheck/scanner are still "Unavailable" stubs wired into `lando doctor`.
- **Managed-file contract shortfalls.** PRD-ALPHA4-18 requires `RedactionService`-routed events (the live layer uses a local empty redactor), a `PathsService.managedFileLedger(appId)` member (only an internal helper exists), and a frozen 7-value `FileFormat` enum (the shipped schema adds `javascript`/`typescript`).
- **Renderer ownership.** PRD-ALPHA4-12 moves the default TTY renderer behind `@lando/renderer-lando`; the plugin exports `renderer = Layer.empty` while core still assembles the real renderer.
- **Setup/uninstall/release acceptance residue.** Plugin `setup.flags` are declared in the SDK schema but never merged into `lando setup` metadata; uninstall marks managed provider machines `manual` and can drop the resumable report after a purge failure; macOS/Windows `ensureRuntime` still falls back to system Podman machine tooling and the `LANDO_TEST_PODMAN_SOCKET` test variable; the committed release workflow runs only the dev prerelease, not the 13-stage pipeline.
- **Spec §8 CLI parity drift.** Config surfaces are read-only where §8.2 requires write; `app shell`, `app logs`, `app includes update`, the global-app commands, and `lando version` all diverge from their spec'd contracts; §12 cache writes bypass the atomic helper.

This PRD set picks up at **US-372** (Alpha 4 ended at US-371) and runs through **US-409**: US-372..US-395 are the remediation stories, US-396..US-409 are the feature-wave stories.

The feature wave is spec'd first, PRD'd second: the four features were worked into the normative spec parts before these PRDs were written — `McpService` (§10.14) + `meta:mcp` (§8.2.6) + `mcpAllowed:` (§8.3), agent-context env forwarding (§6.9.1, §7.4, §7.5), `app:open` (§8.2.5), the `lando:` version constraint (§7.4), and `apps:scratch:run` + the `toolbox` recipe (§21.10.3, §8.8.10). When a feature PRD and a spec part disagree, the spec part wins.

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
