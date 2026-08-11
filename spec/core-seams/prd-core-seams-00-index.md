# PRD set: Core Seams

## Introduction

This concurrent **meta/infra** wave finishes the job `spec/architecture-simplicity/` started: it promotes the remaining load-bearing ownership boundaries inside `@lando/core` from AST lint rules into real private workspace packages enforced by `check:package-dag`. It does **not** add user-facing product features, does **not** reopen Beta 1 feature freeze, and does **not** split the public `@lando/core` publish surface (the §2.7 rejection stands).

Root diagnosis: `@lando/core` is a god package. Excluding tests, `core/src/cli/` is ~39k LOC — roughly 45% of core source — while the runtime brain (planner, services, subsystems, lifecycle, Landofile resolution, data movement, managed files) lives beside it in the same package with no structural boundary. The consequences are measurable today:

- The public library API imports CLI command implementations (`core/src/app/operations.ts` → `core/src/cli/commands/{destroy,exec,...}.ts`; `core/src/app/handle.ts` → `core/src/cli/app-resolution.ts`). The §3.1 four-layer model is inverted: the imperative shell owns business logic and the runtime calls *into* it.
- A core service imports the CLI (`core/src/services/command-registry.ts` → `core/src/cli/app-resolution.ts`).
- ~24 of the 26 `check:*` gates are behavioral/AST source scans compensating for missing package seams; only `check:package-dag` and `check:import-cycle` are structural, and package-dag governs plugin edges plus a seam allowlist, not the whole workspace.
- `core/src/landofile/` reaches sideways into `core/src/cache/`, `core/src/http-client/`, `core/src/recipes/`, and the generated plugin composition root, so Landofile resolution cannot be reasoned about (or tested) as a unit.

The `@lando/paths` and `@lando/state-store` extractions proved the pattern: each one moved a seam behind a package edge and shrank its scanner to a residual behavioral ban. This wave applies the same move to the two biggest seams left — Landofile resolution and the runtime engine — then extends `check:package-dag` to a full workspace DAG contract and thins the scanner suite accordingly. Pre-first-ship gut-and-replace applies: no compatibility shims, no dual paths.

## How to use this set of PRDs

1. Spec parts are normative; these PRDs sequence implementation.
2. Execute stories in `prd.json` **priority** order (strict).
3. US-535..US-536 are contract/scaffolding (spec text + workspace DAG) and land first.
4. Implementation order after that: **L** (Landofile seam) → **E** (engine seam) → **G** (gate thinning) → closure.
5. US-542 lands together with its bootstrap-layer/composition-root codegen retarget in one change; splitting them leaves an intermediate state that cannot typecheck.

## PRDs in this set

| # | PRD | Subsystem | Depends on |
|---|-----|-----------|------------|
| 00 | this index | wave map | — |
| 01 | Contract and workspace DAG | spec text; `check:package-dag` governs every workspace edge | — |
| 02 | Landofile seam | `@lando/landofile`; app-resolution layering fix | 01 |
| 03 | Engine seam | `@lando/engine`; logic out of command bodies; core becomes shell | 01, 02 |
| 04 | Gate thinning and closure | boundary-rule inventory v2; new-gate bar; wave closure | 01–03 |

## Dependency graph

```
US-535..536 (contract + workspace DAG)
    → US-537..539 (L Landofile seam)
    → US-540..544 (E engine seam)
    → US-545..547 (G gate thinning)
    → US-548 (closure)
```

The Landofile seam lands before the engine seam because `@lando/engine` imports `@lando/landofile`.

## Verification contract

Every story ends with tests/typecheck/lint. Wave closure additionally requires:

- `bun run codegen:check` (pure drift, including regenerated bootstrap layers and composition root)
- `bun run scripts/check-boundaries.ts --all` and `check:package-dag` on the extended workspace DAG
- `bench:tooling-hot-path` and cold-start budgets hold (§2.1); the engine move must not add cold-start imports
- `bun run check:guide-coverage` (all PRDs internal/None)
- Library API contract suite and schema snapshot unchanged for public surfaces (§16.2, §2.7)

## Cross-cutting non-goals

- New end-user commands, flags, or Landofile keys.
- Splitting public `@lando/core` into separate runtime and CLI **publish** packages (§2.7 rejection stands; `@lando/landofile` and `@lando/engine` are private, like `@lando/paths` and `@lando/state-store`).
- Extracting `core/src/recipes/`, `core/src/mcp/`, or the network subsystem into packages (deferred; revisit post-wave).
- Decomposing `core/src/cli/` internally (mega-router and command-file size are follow-up work once the engine seam exists).
- Deleting the boundary substrate engine or the residual behavioral bans (`console.*`, hand-rolled retry, ad-hoc redaction).

## Exit criteria

All US-535..US-548 `passes: true` with green verification; `@lando/landofile` and `@lando/engine` exist as private workspace packages behind the workspace DAG; no module under `core/src/app/**`, `core/src/services/**`, or either seam package imports `core/src/cli/**`; CLI command bodies are thin adapters over engine operations; `check:package-dag` validates the full declared workspace edge set; the boundary-rule inventory documents every surviving scanner as a residual behavioral ban with a justification, and at least the seam-ownership halves of the paths/state-store/renderer/redaction/probe rules are retired or thinned.

## Spec parts that remain authoritative

§1, §2.7 (package surface; private-seam allowance), §3.1–§3.4 (four layers, bootstrap, source layout, service catalog), §7 (Landofile and config), §13.8 (package-dag primacy), §16.2 (public API surface), §17.2 (codegen catalog).

## Follow-on wave

Residual engine grab-bag debt after this wave (managed-file still inside `@lando/engine`, planner/update god-modules, package.json boundary alias sprawl, composite `codegen:check`) is sequenced in **`spec/scanner-retirement/`** (US-551..US-560).
