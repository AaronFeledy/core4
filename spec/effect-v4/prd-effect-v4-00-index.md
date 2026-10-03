# Effect 4 upgrade implementation order

Priorities continue the global sequence after `../ir-gaps/` (which ends at 74). A dependency always has a lower priority. Stories run one after another in priority order. [`spec-effect-v4.md`](./spec-effect-v4.md) is normative; the stories live in [`prd-effect-v4-01-stories.md`](./prd-effect-v4-01-stories.md).

**Every story is one PR against `main` that ships a complete outcome, leaves Lando working, and passes the full standard gate.** No story builds scaffolding for a later one.

The wave runs in three steps:

1. **US-662** switches every package to Effect 4 at once. Effect 3 and Effect 4 types cannot coexist across `@lando/sdk`, and a bridge would be a forbidden shim. The PR leads with characterization tests that pass on Effect 3, then switches package by package in DAG order, so behavior changes surface as test failures, not surprises.
2. **US-663 to US-667** each finish one area in Effect 4 idiom: service shapes, layer names, `Effect.fn` tracing boundaries, and Effect modules in place of hand-rolled helpers. Two of them also ship user value: Effect's `HttpClient` (US-663) and the MCP server rebuilt on `effect/ai` (US-665). US-665 lands before the core pass, so its deleted transport is never refactored. The last pass adds the guard that keeps old forms out.
3. **US-668 to US-670** ship the remaining user-facing features: one definition of a valid Landofile, command tracing, and compiled decoders if they clear a measured bar.

## Standard gates

Every class includes the `main` gates, so every PR is green.

| Class | Required gates |
|---|---|
| main | focused tests with positive counts; `bun run typecheck`; `bun run test`; `bun run lint`; `bun run codegen:check`; `bun run check:boundaries`; `bun run gate:pr` before push |
| baseline | the `main` gates; measurements recorded per spec §12 |
| sdk | the `main` gates; SDK backward-compatibility test; `bun run codegen:schema-snapshot`; `bun run check:schema-compatibility`; `sdk/API_COMPATIBILITY.md` updated |
| user | the `main` gates; `bun run dev:guides <guide> --once` with a positive count for every touched guide; `bun run lint:guides`; `bun run check:guide-coverage`; `GUIDE_DRIFT_BASE_REF=origin/main bun run check:guide-drift`; `bun run check:public-transcripts` |
| switch | the `main`, `sdk`, and `user` gates; full `bun run test`; nightly-tier suites by path; live provider suites when `LANDO_TEST_PODMAN_SOCKET` connects; `docs:check`; `docs:test`; compiled binary build plus relocated-binary smoke; spec §12 measurements before and after |

## Stories

| Priority | Story | Scope | Class | Depends on |
|---:|---|---|---|---|
| 75 | US-662 | Lando on Effect 4.0.0 | switch | none |
| 76 | US-663 | SDK and primitives idiom pass; Effect `HttpClient` | sdk plus user | US-662 |
| 77 | US-664 | engine idiom pass; operation spans | main | US-663 |
| 78 | US-665 | MCP on Effect's MCP server | user | US-664 |
| 79 | US-666 | renderer, data-mover, core idiom pass; command spans | main | US-665 |
| 80 | US-667 | plugins and scaffold idiom pass; idiom guard | user | US-666 |
| 81 | US-668 | one definition of a valid Landofile | sdk plus user | US-663 |
| 82 | US-669 | command tracing, OTLP export, embedding hooks | user | US-667 |
| 83 | US-670 | compiled hot-path decoders if they help | baseline | US-668 |

## Branching

Each story opens a short-lived branch and one PR against `main`. `prd.json` names `main` as the branch for that reason.

## Risks the order is built around

- **US-662 is large.** It cannot be split without shims. Review stays tractable through the spec §3 commit order, and the characterization commit makes silent behavior changes fail loudly. Start it when no other wave has an open PR touching many files that import `effect`, and merge it quickly.
- **Schema meaning drift.** US-662 makes the compatibility gate compare meaning instead of generator output, and adds a test that no authored-input property accepts `null`.
- **Unstable upstream modules** (`effect/http`, `effect/ai`, `effect/observability`, `effect/schema` compilers). The exact catalog pin and its test keep them from moving underneath the repo.
- **Performance.** US-662 measures before and after. Every idiom pass reruns the benchmarks, because `Effect.fn` adds per-call work. US-670 adopts compiled decoders only past a fixed bar.
