# PRD Index — Lando v4 Phase 1 (MVP / "walking skeleton")

> **Phase naming (reframed):** This is completed pre-alpha work. The release ladder was rescoped so that the originally-shipped phases are now **MVP → Alpha 1 → Alpha 2 → Alpha 3**, the remaining work is **Beta 1 (last feature surface, incl. `setup`/`uninstall`) → Beta 2 → RC → 4.0 GA**, and the alpha phases publish `4.0.0-alpha.N` on the `dev` channel. See [`spec/ROADMAP.md`](../ROADMAP.md) for the authoritative ladder.

## Introduction

Phase 1 of [`spec/ROADMAP.md`](../../spec/ROADMAP.md) — the "walking skeleton" MVP — is large enough that a single PRD would obscure the dependency structure between subsystems. This index splits the phase into six per-subsystem PRDs that can be picked up independently once their prerequisites are met.

**Phase 1 one-sentence goal (from the roadmap):** *One developer can run `lando start` against one app with one service on Linux x64 with system Docker installed, and see it work.*

**Primary architectural assertion:** the Lando-managed runtime (`@lando/provider-lando` driving a private Podman socket) is the must-ship path. `@lando/provider-docker` is a developer escape hatch / contract-suite cross-validator. Both target Linux x64 only at MVP.

## How to use this set of PRDs

- Each PRD is self-contained — it has its own user stories, functional requirements, non-goals, and exit criteria.
- The dependency graph below is **strict**: do not start a downstream PRD until its upstream prerequisites are accepted (all checkboxes ticked).
- Every story across every PRD follows the same TDD verification contract — see "Verification contract" below.
- When the PRD references a `§` section, that means a section in [`spec/`](../../spec/) (the source of truth — when the PRD and a spec part disagree, the spec part wins).

## PRDs in this set

| # | PRD | Subsystem | Depends on |
|---|---|---|---|
| 01 | [SDK contracts](./prd-mvp-01-sdk-contracts.md) | Schema, errors, events, service tags in `@lando/sdk` | — |
| 02 | [Foundation](./prd-mvp-02-foundation.md) | `LandoRuntimeLive`, `makeLandoRuntime`, OCLIF init hook, fast paths, build/test infra | 01 |
| 03 | [Effect services](./prd-mvp-03-effect-services.md) | The 12 Live service implementations | 01, 02 |
| 04 | [Runtime providers](./prd-mvp-04-providers.md) | `@lando/provider-lando` (Podman, primary) + `@lando/provider-docker` (stretch) | 01, 02, 03 |
| 05 | [Bundled services](./prd-mvp-05-bundled-services.md) | `@lando/service-lando` (node + postgres ServiceTypes) + `@lando/logger-pretty` | 01, 02, 03 |
| 06 | [CLI commands](./prd-mvp-06-cli-commands.md) | `start`, `stop`, `info`, `version`, `shellenv`, `init` | 01–05 |
| 07 | [CI + binary workflow artifacts](./prd-mvp-07-ci-and-binaries.md) | GitHub Actions workflow: static gates, binary build, full Podman provider integration; per-PR workflow artifacts (no Releases at MVP) | 01–06 |

## Dependency graph

```
                ┌─────────────────────┐
                │ 01 SDK contracts    │
                │ (semver-stable on   │
                │  first ship)        │
                └──────────┬──────────┘
                           │
                           ▼
                ┌──────────────────────┐
                │ 02 Foundation        │
                │ runtime layer +      │
                │ bootstrap +          │
                │ OCLIF init hook +    │
                │ build/test infra     │
                └──────────┬───────────┘
                           │
                           ▼
                ┌──────────────────────┐
                │ 03 Effect services   │
                │ (12 Live impls)      │
                └──────────┬───────────┘
                           │
              ┌────────────┴────────────┐
              ▼                         ▼
 ┌──────────────────────┐   ┌──────────────────────┐
 │ 04 Providers         │   │ 05 Bundled services  │
 │ provider-lando       │   │ service-lando +      │
 │ (+ docker stretch)   │   │ logger-pretty        │
 └──────────┬───────────┘   └──────────┬───────────┘
            │                          │
            └──────────┬───────────────┘
                       ▼
            ┌──────────────────────┐
            │ 06 CLI commands      │
            │ start / stop / info  │
            │ version / shellenv   │
            │ init                 │
            └──────────┬───────────┘
                       │
                       ▼
            ┌──────────────────────────────┐
            │ 07 CI + binary artifacts     │
            │ GitHub Actions: static +     │
            │ build + Podman integration;  │
            │ per-PR artifact upload only  │
            │ (no Releases at MVP)         │
            └──────────────────────────────┘
```

## Verification contract (applies to every story in every PRD)

Every story in this set follows **test-first (TDD)**:

1. **Red** — A failing test (unit, Effect service test, CLI scenario, or library-mode test as appropriate) is committed before the implementation. The test must fail for a reason that pins down the missing behavior, not just `not implemented` boilerplate.
2. **Green** — The implementation is added until the new test passes.
3. **Clean** — `bun run typecheck` (`tsc -b`) clean, `bun run lint` (`biome check .`) clean, `bun test` green for the whole workspace (no pre-existing failures regressed).

Every story therefore carries the following minimum acceptance criteria, in addition to its story-specific ones:

- [ ] Failing test exists before the implementation commit (and is part of the same PR series).
- [ ] After implementation, that specific test passes locally with `bun test <path>`.
- [ ] `bun run typecheck` passes.
- [ ] `bun run lint` passes.
- [ ] Whole-workspace `bun test` passes; no test removed or skipped to make this true.

## Cross-cutting non-goals (out of scope for the entire MVP set)

The following are explicitly **not** part of any Phase 1 PRD. If something below sneaks into a story, push it back to Alpha 1/Alpha 3:

- macOS or Windows support of any kind (Linux x64 only).
- VM lifecycle / `lando setup` / runtime bundle download / checksum verification (Alpha 1 for `provider-lando` macOS).
- Persistent caches (in-memory only at MVP — `§12.1` persistent caches are Alpha 1).
- Recipes other than the single hardcoded built-in (no `recipe.yml` parser, no remote sources, no prompts beyond `--name`).
- Plugin install / discovery beyond the bundled `BUNDLED_PLUGINS` array.
- Tooling system (`tooling:` Landofile section, `lando exec`/`shell`/`ssh`).
- Global app, scratch apps, file sync (Mutagen), proxy, certificates, healthchecks, scanner.
- Concurrent task tree renderer, first-paint banner, expand/collapse — plain text output only.
- Library API stability or documentation — internal-only, used by `bun test`.
- Signing, notarization, SBOM, self-update, installer scripts — Beta 1 concerns.
- Telemetry — Beta 1 concern.
- ~~CI — local-only verification at MVP.~~ **Updated:** CI ships at MVP — see PRD-07. Local-only verification is no longer the gate; per-PR GitHub Actions on Linux x64 is.
- OCLIF v5 migration — phase decision, see roadmap "Cross-cutting risks".

## Exit criteria for the whole MVP set

The roadmap defines a single exit command. All six PRDs must be accepted, then the following must succeed verbatim on a clean clone on a Linux x64 machine that already has Podman installed:

```bash
git clone … && bun install && bun run codegen && bun test && bun run build && \
  ./dist/lando init --full && cd <created-dir> && ../dist/lando start && ../dist/lando info
```

…and produce a working Node + Postgres app via the Lando-managed runtime (private Podman socket). The Docker path is the stretch goal — it is sufficient (but not required) for MVP exit if `provider-lando` works end-to-end.

## Open Questions

- Does the prototype `lando setup` for `provider-lando` (Linux) require manual Podman install on the dev box, or do we go ahead and download a pinned Podman binary at MVP? The roadmap leans manual ("Manual Podman install required on the dev machine"); we record `download + store a pinned Podman binary on first 'lando setup'` as a stretch goal in PRD-04.
- The bundled `@lando/logger-pretty` ships empty in MVP because Effect's default `Logger.pretty` is "good enough" — do we still need a non-empty plugin manifest so the `bundled.ts` codegen path is exercised? PRD-05 assumes yes (empty bodies but real manifest).
- The `bundled.ts` codegen script (`scripts/build-bundled-plugins.ts`) is called out as a Phase 1 risk mitigation in the roadmap but isn't in any phase's deliverable list explicitly. PRD-02 owns it.
