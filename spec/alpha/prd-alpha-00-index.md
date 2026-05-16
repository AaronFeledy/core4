# PRD Index — Lando v4 Phase 2 (Alpha / "happy path coverage")

## Introduction

Phase 2 of [`spec/ROADMAP.md`](../ROADMAP.md) turns the MVP walking skeleton into an externally testable Alpha. The roadmap's one-sentence goal is:

> A team can adopt Lando v4 for a real PHP/Drupal, Node, Python/Django, or Ruby/Rails project on Linux + macOS — using the Lando-managed runtime with no Docker prerequisite — and most things work most of the time.

MVP proved one Linux x64 happy path. Alpha adds common-stack breadth, managed-runtime setup, persistent caches, real tooling, real recipes, an unstable library API, and the first `dev`-channel distribution.

## How to use this set of PRDs

- Each PRD is self-contained and follows the Phase 1 MVP PRD convention: introduction, goals, user stories, functional requirements, non-goals, technical considerations, success metrics, and open questions.
- The dependency graph is strict: do not start a downstream PRD until its prerequisites are accepted.
- The spec parts in [`spec/`](../README.md) remain the source of truth. When these PRDs and a spec part disagree, the spec part wins and both should be updated together.
- Every story follows the same TDD verification contract below.
- Alpha is externally visible but still unstable: anything outside `@lando/sdk` may change before Beta.

## PRDs in this set

| # | PRD | Subsystem | Depends on |
|---|---|---|---|
| 01 | [Runtime providers](./prd-alpha-01-runtime-providers.md) | Managed provider maturity + Docker alternative | — |
| 02 | [Service catalog and app planning](./prd-alpha-02-service-catalog-and-app-planning.md) | Common stacks, mounts, storage, and env contract | PRD-01 |
| 03 | [Tooling and CLI coverage](./prd-alpha-03-tooling-and-cli-coverage.md) | Tooling schema, engines, app commands, and meta commands | PRD-01, PRD-02 |
| 04 | [Recipes and app initialization](./prd-alpha-04-recipes-and-app-initialization.md) | Recipe parser, prompts, canonical recipes, and programmatic Landofile | PRD-02, PRD-03 |
| 05 | [Renderer, errors, and diagnostics](./prd-alpha-05-renderer-errors-and-diagnostics.md) | Task tree, message contract, plain/json/lando output, and user-facing errors | PRD-03, PRD-04 |
| 06 | [Persistent caches and library API](./prd-alpha-06-persistent-caches-and-library-api.md) | §12 caches plus usable internal library/runtime API | PRD-01, PRD-02, PRD-03 |
| 07 | [CI, distribution, and release channel](./prd-alpha-07-ci-distribution-and-release-channel.md) | Schema gates, recipe/library CI, dev prereleases, npm dev tag | PRD-01 through PRD-06 |

## Dependency graph

```text
                ┌────────────────────────┐
                │ 01 Runtime providers   │
                └────────────┬───────────┘
                             │
                             ▼
                ┌────────────────────────┐
                │ 02 Service catalog     │
                │ + app planning         │
                └────────────┬───────────┘
                             │
                             ▼
                ┌────────────────────────┐
                │ 03 Tooling + CLI       │
                └──────┬─────────┬───────┘
                       │         │
                       ▼         ▼
          ┌──────────────────┐  ┌──────────────────┐
          │ 04 Recipes       │  │ 06 Caches        │
          │ + init           │  │ + library API    │
          └────────┬─────────┘  └────────┬─────────┘
                   │                     │
                   ▼                     │
          ┌──────────────────┐           │
          │ 05 Renderer      │           │
          │ + diagnostics    │           │
          └────────┬─────────┘           │
                   │                     │
                   └──────────┬──────────┘
                              ▼
                    ┌──────────────────┐
                    │ 07 CI + release  │
                    └──────────────────┘
```

## Verification contract (applies to every story in every PRD)

- [ ] Failing test exists before implementation and is part of the same PR series.
- [ ] After implementation, that specific test passes locally with `bun test <path>`.
- [ ] `bun run typecheck` passes.
- [ ] `bun run lint` passes.
- [ ] Whole-workspace `bun test` passes; no test removed or skipped to make this true.
- [ ] If the story changes generated files, `bun run codegen` is run and committed.
- [ ] If the story affects the compiled binary, source CLI and compiled `$bunfs` behavior are both verified.
- [ ] Live provider tests remain explicitly gated by environment variables and are not required on machines lacking the runtime.

## Cross-cutting non-goals (out of scope for the entire Alpha set)

The following are explicitly not part of Phase 2 Alpha. If something below sneaks into a story, push it back to Beta/RC/GA:

- Windows managed-runtime support.
- Go, MongoDB, Solr, Elastic, Opensearch, Meilisearch, Memcached, Valkey, and Mailpit service types.
- Mutagen/file-sync implementation.
- Global app, scratch apps, proxy, certs, scanner, host integration, and SSH sidecar/subsystem work. Alpha `ssh` is limited to provider-exec TTY command behavior.
- Remote recipe sources (`git`, `tarball`, `npm`, `registry`), dynamic recipe choices, recipe fetch allowlists, and programmatic `recipe.ts`.
- Service-mode `lando shell`.
- Tooling hot-path optimization.
- Renderer streaming tails, expand/collapse, and the full first-paint contract.
- Plugin trust/signing/new/test/build/link/unlink/publish command suite.
- Multi-platform release matrix beyond Linux x64 dev prerelease and explicitly scoped macOS Alpha validation.
- Signing, notarization, SBOM, self-update, installer scripts, telemetry, and curl-pipe installer.
- Stable library API documentation or compatibility promises outside `@lando/sdk`.

## Exit criteria for the whole Alpha set

A fresh alpha tester on Linux or macOS can install the dev-channel artifact, run `lando setup`, scaffold at least Drupal and Rails apps through interactive `lando init`, run `lando start`, execute framework tooling (`lando drush` / `lando rails`), inspect logs/info, stop/destroy the app from a separate CLI process, and file a bug report with `lando doctor` output. CI publishes the Linux x64 dev prerelease and npm `dev` packages only after static checks, schema gates, library API tests, recipe tests, and default unit/scenario tests pass.

## Open Questions

- Should macOS provider-lando validation be required in default CI during Alpha, or remain manual/opt-in until Beta's platform matrix?
- Which six canonical recipes are mandatory if implementation time forces a smaller set: Drupal, WordPress, Laravel, Node, Django, Rails, or another ordering?
- Should macOS users install Alpha primarily through npm/dev packages until macOS binary promotion lands, or should an unsigned macOS binary artifact be produced manually for testers?
