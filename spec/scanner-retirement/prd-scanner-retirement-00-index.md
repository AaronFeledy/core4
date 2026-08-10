# PRD set: Scanner Retirement

## Introduction

This concurrent **meta/infra** wave finishes the job `spec/architecture-simplicity/` and `spec/core-seams/` started: it stops treating architecture as something scanners *verify* after the fact and completes the move to package seams and module ownership that make the same constraints *unrepresentable* to violate.

Root diagnosis (post core-seams): `@lando/engine` is still a coarse grab-bag. Several cohesive concerns cohabit the package, so producer and consumer of a constraint share a package edge and the residual scanners stay fat:

- `ManagedFileService` lives at `engine/src/managed-file/` while the `managed-file` boundary rule exists *because* "the service and most consumers share `@lando/engine`" (boundary inventory justification). Contracts already live in `@lando/sdk`; the only engine-internal dep is a thin paths delegate.
- `engine/src/services/planner.ts` (~1.8k LOC) mixes service-type resolution, compose-capability checks, file-sync, storage, authored knobs, endpoints, extensions, naming, and the `planApp` assembly body in one module — the change-magnet of the runtime brain.
- `engine/src/operations/update.ts` (~1.4k LOC) packs nine tagged errors, manifest/channel/platform logic, cosign/checksum verification, and the operation entry into one "operation" file.
- The contributor gate surface still exposes ~14 per-rule `check:*-boundary` package.json aliases plus a composite `codegen:check` that also runs deprecations and typecheck, so a red `codegen:check` is not necessarily a drift failure (architecture-simplicity US-505 target not fully landed).

This wave: (1) extracts `@lando/managed-file` and pays the scanner-retirement ratchet; (2) decomposes the planner and update god-modules inside `@lando/engine` without new package edges; (3) collapses the package.json boundary alias surface to `check:boundaries` while keeping per-rule scripts as test-support APIs; (4) makes `codegen:check` drift-only. Pre-first-ship gut-and-replace applies: no dual import paths, no behavior changes.

Executable work plan (decision-complete for implementers): `.omo/plans/finish-scanner-retirement.md` (high-accuracy dual review approved). Spec PRDs are the normative sequencing contract; the plan is the execution checklist.

## How to use this set of PRDs

1. Spec parts are normative; these PRDs sequence implementation.
2. Execute stories in `prd.json` **priority** order (strict).
3. US-551 is contract/scaffolding (spec text) and lands first.
4. Implementation order after that: **M** (managed-file seam) → **E** (engine module decomposition: update then planner) → **G** (gate surface) → closure.
5. Alias collapse (US-559) and its CI/docs/test rewrites land as **one commit** so main never points at deleted package.json aliases mid-way.
6. Full-suite lock is always `bun test` (or explicit `test:unit:shard` commands). Never treat bare `bun run test` / `scripts/test-shards.ts` without `--run` as a suite run — it only prints shard commands.

## PRDs in this set

| # | PRD | Subsystem | Depends on |
|---|-----|-----------|------------|
| 00 | this index | wave map | — |
| 01 | Contract | spec text; private-seam + layout + gate surface authorization | — |
| 02 | Managed-file seam | `@lando/managed-file`; owner-excluding rule shrink (ratchet) | 01 |
| 03 | Engine module decomposition | `engine/src/update/`, `engine/src/planner/`; thin orchestrators | 01 (parallel-safe with 02 after contract) |
| 04 | Gate surface and closure | `codegen:check` drift-only; `check:boundaries`; wave closure | 01–03 |

## Dependency graph

```
US-551 (contract)
    → US-552..555 (M managed-file seam + ratchet)
    → US-556..557 (E update split + planner decomposition)
    → US-558..559 (G codegen:check + boundary alias collapse; 559 one-commit with CI)
    → US-560 (closure)
```

US-556 (update) MAY start in parallel with US-552..555 after US-551. US-557 (planner) SHOULD follow the managed-file seam so the extraction/re-export pattern is proven first. US-558 MAY parallelize with US-556.

## Verification contract

Every story ends with tests/typecheck/lint. Wave closure additionally requires:

- `bun run codegen:check` (pure drift only — equals `bun run codegen && bun run check:codegen-drift`)
- `bun run check:boundaries` (all registry rules in one pass) and single-rule debug via `bun run scripts/check-boundaries.ts <rule-id>`
- `bun run typecheck`, `bun run lint` (lint still owns `check:deprecations`)
- Full-suite lock via **`bun test`** with positive test counts (never inferred passes)
- Portable `static-checks-platform` still MUST NOT gain a typecheck step (existing CI locks)
- Per-rule `scripts/check-*.ts` files remain on disk as programmatic test APIs
- `bun run check:guide-coverage` (all PRDs internal/None)
- Library API + schema snapshot unchanged for public surfaces

## Cross-cutting non-goals

- New end-user commands, flags, or Landofile keys.
- Splitting public `@lando/core` into separate runtime and CLI **publish** packages (§2.7 rejection stands).
- Extracting `data-mover`, `scratch-app`, or other remaining engine directories into packages (deferred; revisit post-wave).
- Deleting the boundary substrate engine or residual behavioral bans that a package edge cannot express.
- Deleting per-rule `scripts/check-*.ts` shim scripts (they export typed APIs used by dedicated tests).
- Adding `run: bun run typecheck` to the portable static-checks matrix.
- Migrating `runLaunchProbe` onto `runProbe` (behavior-preserving split only; current code is a single `ProcessRunner.run`).
- SDK contract / schema snapshot changes.

## Exit criteria

All US-551..US-560 `passes: true` with green verification; `@lando/managed-file` exists as a private workspace package; `engine/src/managed-file/` is gone; the `managed-file` boundary rule is owner-excluding; `engine/src/operations/update.ts` and `engine/src/services/planner.ts` are thin re-export/orchestrator surfaces over `engine/src/update/` and `engine/src/planner/`; package.json exposes `check:boundaries` instead of fourteen per-rule aliases; `codegen:check` fails only on drift; full `bun test` lock matches the pre-wave baseline.

## Spec parts that remain authoritative

§1, §2.7 (package surface; private-seam allowance), §3.1–§3.4 (layers, bootstrap, source layout, service catalog — ManagedFileService Live home), §10.13 (managed-file semantics unchanged), §13.4 / §13.8 (gates; package-dag primacy; gate surface), §16.2 (public API), §17.2 (codegen catalog).

## Relationship to prior waves

| Wave | What it paid | What this wave finishes |
|---|---|---|
| architecture-simplicity (US-500..534) | state-store seam; package-dag start; dual CLI collapse; codegen:check *target* | pure-drift `codegen:check` in practice; managed-file no longer deferred |
| core-seams (US-535..550) | landofile + engine packages; workspace DAG; inventory v2 / ratchet bar | managed-file out of engine; engine internal god-modules split; alias surface collapsed |
