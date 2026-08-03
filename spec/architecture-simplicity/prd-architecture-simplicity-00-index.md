# PRD set: Architecture Simplicity

## Introduction

This concurrent **meta/infra** wave reduces the cost of keeping Lando's many representations of truth in lockstep. It does **not** add user-facing product features and does **not** reopen Beta 1 feature freeze for product surface. It **does** reopen the closed §14.2 dual-dispatch decision and the packaging/codegen commit policy.

Root diagnosis: one contract (the spec + Effect schemas + command registry) is currently mirrored through dual CLI engines, committed generated trees, per-domain drift checkers, and AST boundary rules that simulate package seams. Agents and humans pay a constant resynchronization tax.

## How to use this set of PRDs

1. Spec parts are normative; these PRDs sequence implementation.
2. Execute stories in `prd.json` **priority** order (strict).
3. US-500..US-504 are contract/scaffolding (land with the wave docs).
4. Implementation order after that: **D** (drift) → **B** (artifacts) → **C** (seams) → **A** (CLI collapse) → closure.

## PRDs in this set

| # | PRD | Subsystem | Depends on |
|---|-----|-----------|------------|
| 00 | this index | wave map | — |
| 01 | CLI dispatch | single native dispatcher; remove shipping OCLIF | Spec A; after D/B catalog clean preferred |
| 02 | Derived artifacts | gitignore/untrack regen-only outputs | Spec B; after D |
| 03 | Package seams | `@lando/state-store` + DAG; thin AST rules | Spec C |
| 04 | Codegen drift gate | one `codegen:check` | Spec D; first code wave |

## Dependency graph

```
US-500..504 (contract + scaffolding)
    → US-505..509 (D drift)
    → US-510..515, US-533 (B artifacts; US-533 = schema-compat base regen after untrack)
    → US-516..521 (C seams)
    → US-522..531 (A CLI)
    → US-532 (closure)
```

## Verification contract

Every story ends with tests/typecheck/lint. Wave closure additionally requires:

- `bun run codegen:check` (strengthened pure-drift)
- boundary suite / `check:package-dag`
- focused CLI machine-output + relocated binary smoke
- `bun run check:guide-coverage` (all PRDs internal/None)

## Cross-cutting non-goals

- New end-user commands or Landofile keys.
- Splitting public `@lando/core` into separate runtime and CLI **publish** packages (§2.7 rejection stands for the public surface).
- Extracting network/managed-file packages (deferred).
- Re-introducing OCLIF as a second shipping engine.

## Exit criteria

All US-500..US-532 `passes: true` with green verification; dual-dispatch permanence language remains only as historical/superseded notes; derived schema trees are not git SoT; `codegen:check` is the pure-drift gate; `@lando/state-store` (or documented equivalent) owns durable state behind the package DAG.

## Spec parts that remain authoritative

§1, §2.7, §4.2, §8 (esp. §8.4.1 rewrite), §9, §12.7, §13, §14 Appendix D.1 (historical + supersession), §15/§17.2, §19.6 model for gitignore.
