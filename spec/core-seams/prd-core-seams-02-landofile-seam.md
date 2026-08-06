# PRD: SEAMS-02 — Landofile seam

## Introduction

Extract Landofile discovery, merge, includes, and app resolution into a private `@lando/landofile` workspace package. Today `core/src/landofile/` (~5.6k LOC) is cohesive in purpose but not in structure: it imports `core/src/cache/paths.ts`, `core/src/http-client/json-fetch.ts`, `core/src/recipes/{git,npm}-source.ts`, and the generated plugin composition root (`core/src/plugins/generated/bundled.ts`), while the app-resolution helpers that both the CLI and the public library API need live under `core/src/cli/` — producing the app→cli and services→cli layering inversions. This PRD moves the domain behind a package edge, inverts the sideways reaches into injected ports, and gives `loadUserLandofile` a home that is not the CLI.

## Source References

- `spec/07-landofile-and-config.md` §7.1–§7.2 (discovery, merge order), §7.7 (includes), §7.8.1 (canonical serializer)
- `spec/02-toolchain.md` §2.7 (`@lando/core/landofile` public entry point)
- `spec/03-architecture.md` §3.1 (layering), §3.4 (service catalog)
- `spec/core-seams/prd-core-seams-01-contract-and-workspace-dag.md` (edge contract this package must satisfy)

## Goals

- `@lando/landofile` owns discovery, merge, includes resolution, and user-app resolution behind the workspace DAG.
- The package depends only on `@lando/sdk`, `@lando/paths`, and `@lando/state-store`; every other capability (HTTP fetch, cache paths, recipe sources, bundled-plugin knowledge) arrives via sdk-published service tags or package-defined ports provided by core.
- No module under `core/src/app/**` or `core/src/services/**` imports `core/src/cli/**` for app resolution.

## User Stories

### US-537: Scaffold @lando/landofile workspace package

**Description:** As a maintainer, a private `@lando/landofile` package exists, modeled on `@lando/state-store`, wired into the workspace, tsconfig references, and the US-536 edge table.

**Acceptance Criteria:**

- [ ] Package exists with build/typecheck/test scripts matching sibling seam packages; root workspace list and tsconfig references updated; `bun install` run.
- [ ] Declared edges: `@lando/landofile` → {`@lando/sdk`, `@lando/paths`, `@lando/state-store`} only; `check:package-dag` enforces it.
- [ ] The scaffold changes no public surface: the `@lando/core/landofile` entry point (`core/src/landofile/index.ts` today) is untouched until US-538 moves the domain behind it.
- [ ] Tests pass; typecheck passes; lint passes

### US-538: Move Landofile domain code and invert sideways dependencies

**Description:** As a maintainer, discovery, merge, includes, and the serializer glue move into `@lando/landofile`, with the current reaches into cache/http-client/recipes/composition-root inverted into ports the caller provides.

**Acceptance Criteria:**

- [ ] `core/src/landofile/**` contents move into the package; core keeps at most thin re-export shims required by §2.7 entry points.
- [ ] Includes fetching consumes an injected HTTP/downloader capability (sdk-published tag or a package-defined port satisfied by core's `HttpClient`-backed layer); the package has no import of `core/src/http-client/**`.
- [ ] Cache-path knowledge arrives via `@lando/paths`/injected config, recipe-source resolution via a port core provides from `core/src/recipes/**`, and bundled-plugin metadata via an injected input rather than an import of `core/src/plugins/generated/**`.
- [ ] The public `@lando/core/landofile` entry point (§2.7) now re-exports from the package with no public API change; schema snapshot and API report gates unchanged.
- [ ] The `LandofileService` tag stays sdk-published (`sdk/src/services/landofile.ts`); the package exports implementation functions and port interfaces while core keeps the Live layer that wires ports. If generated bootstrap-layer dependency tables change, the generator is updated in the same change and `codegen:check` is drift-clean.
- [ ] Existing landofile unit tests move with the code and run under the package with a positive test count; includes lockfile behavior is covered by focused tests at the package level.
- [ ] Tests pass; typecheck passes; lint passes

### US-539: App resolution leaves the CLI

**Description:** As a maintainer, `loadUserLandofile` and the `ResolvedAppTarget` helpers move from `core/src/cli/app-resolution.ts` onto the Landofile seam, killing the app→cli and services→cli inversions.

**Acceptance Criteria:**

- [ ] User-app resolution (discovery walk, cwd mapping, `ResolvedAppTarget`/`loadUserLandofile`) lives on the Landofile seam (in-package, or a core non-CLI module that only wraps the package), and `core/src/cli/app-resolution.ts` is deleted or reduced to a re-export consumed only by CLI modules.
- [ ] `core/src/app/resolve.ts` and `core/src/services/command-registry.ts` no longer import anything under `core/src/cli/**`; `core/src/app/handle.ts` drops its `cli/app-resolution.ts` import. Its remaining `cli/commands/logs.ts` type import — and `core/src/app/operations.ts`'s imports of command implementations — are US-541 burn-down, not this story.
- [ ] CLI commands still resolve apps through the one shared path (no per-command rediscovery); root and core AGENTS.md guidance pointing at `core/src/cli/app-resolution.ts` is updated to the new home.
- [ ] A residual layering check (import-cycle config or a thin boundary rule) fails on **new** `core/src/{app,services}/** → core/src/cli/**` imports, with the known surviving edges (`app/operations.ts` and `app/handle.ts` → `cli/commands/*`) pinned in an explicit burn-down allowlist that US-541 empties and deletes.
- [ ] Tests pass; typecheck passes; lint passes

## Functional Requirements

- Landofile behavior (merge order, includes semantics, lockfile verification, version-constraint errors) is unchanged; this is a seam move, not a redesign.
- All tagged errors remain the sdk-published types; no new error taxonomy.
- The package MUST be testable without constructing a core runtime: ports get in-memory/test layers.

## Non-Goals

- Changing Landofile syntax, merge semantics, or the includes source schemes.
- Moving `core/src/recipes/**` into a package (only a port is defined here).
- Public API changes to `@lando/core/landofile`.

## Technical Considerations

- `core/src/config/version-constraint.ts` is imported by landofile code today; it moves with the domain or into sdk, whichever the constraint's owner is per §7.4 — do not leave a package→core import.
- Watch `check:spec-reference`: moved files must not carry spec citations out of the spec tree.
- The residual layering check in US-539 is temporary scaffolding; PRD-04 decides whether it survives once the engine seam makes the direction structural.

## Success Metrics

- `@lando/landofile` unit tests run in isolation with no core imports.
- Zero imports of `cli/app-resolution.ts` from outside `core/src/cli/**`; the only remaining app→cli edges are the enumerated burn-down entries US-541 owns.

## Guide Coverage

**None — internal/infra PRD.** No end-user CLI or Landofile behavior changes.

## Open Questions

- None blocking.
