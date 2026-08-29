# PRD set: public Alpha 1

## Introduction

No public release has shipped. Historical internal phases are pre-alpha. Alpha 1 is current.

This set sequences the first public Alpha: unsigned `4.0.0-dev.N` binaries and the canonical npm workspace set on the `dev` channel for all six compile targets, live `lando setup` and `lando doctor` on each target, the existing Drupal recipe proven on each target, and Rails added in contract-then-recipe-then-journey order. Production-grade distribution (signing, installers, self-update) is later. Beta is later.

## How to use

1. These PRDs sequence implementation. They do not own `spec/ROADMAP.md`. The only allowed spec-part edit is US-597's targeted change to `spec/08-cli-and-tooling.md` section 8.8.10 (Rails staged to bundled). Every other spec-part rewrite is out of scope.
2. Execute stories in `prd.json` **priority** order (strict). Ordering guarantees no story depends on a later story.
3. US-592 is the contract for this set. Keep it `passes: false` until the contract checks in PRD-01 are done.
4. Live all-six evidence is required for setup, doctor, Drupal, and Rails. Compile smoke does not close those stories.
5. Full-suite lock is always `bun test` (or explicit shard `--run` commands) with positive test counts.

## PRD table

| # | PRD | Subsystem | Depends on |
|---|-----|-----------|------------|
| 00 | this index | wave map | none |
| 01 | Contract | public Alpha 1 contract in `spec/alpha/` | none |
| 02 | Distribution | six-target unsigned `4.0.0-dev.N` on `dev`, plus the canonical npm workspace set | 01 |
| 03 | Intel macOS | provider-lando fail-closed; provider-docker live | 01 |
| 04 | Platform readiness | live `lando setup` and `lando doctor` on every compile target | 01, 02, 03 |
| 05 | Drupal journey | existing Drupal recipe proven on every compile target | 04 |
| 06 | Rails | contract, then bundled recipe, then all-six journey | 01 (contract); 04+recipe for journey |
| 07 | Closure | Alpha 1 exit lock | 02 through 06 |

## Dependency graph

```
US-592 (contract)
    -> US-593 (six-target unsigned 4.0.0-dev.N on dev)
    -> US-594 (Intel macOS: provider-lando fail-closed; provider-docker live)
    -> US-597 (Rails recipe contract)
US-593 + US-594 -> US-595 (live lando setup and lando doctor on every compile target)
US-595 -> US-596 (Drupal canonical journey on every compile target)
US-597 -> US-598 (Rails bundled recipe)
US-595 + US-598 -> US-599 (Rails canonical journey on every compile target)
US-593..US-599 -> US-600 (Alpha 1 exit lock)
```

## Parallelism

US-593, US-594, and US-597 can parallelize after US-592. US-595 waits for both distribution and the Intel macOS split. US-596 waits for live setup/doctor. US-598 waits for the Rails contract. US-599 waits for live setup/doctor and the bundled Rails recipe. US-600 waits for US-593 through US-599.

## Verification contract

Every story ends with tests/typecheck/lint plus the evidence that story names:

- `bun run typecheck` and `bun test` with positive test counts
- `bun run lint`; `bun run codegen:check` when generated outputs move
- Live setup/doctor and both journeys on all six compile targets: linux-x64, linux-arm64, darwin-x64, darwin-arm64, windows-x64, windows-arm64
- darwin-x64 live path is provider-docker; provider-lando must reject with tagged remediation
- Recipe work uses `recipes/` as public SoT; load `lando-write-docs` before README.mdx

## Non-goals

- Signing, notarization, installers, `get.lando.dev`, and self-update
- Beta / `next` channel / `4.0.0-beta.N`
- 4.1 implementations (hosters/RemoteSource, deferred commands, remaining staged recipes besides the Rails Alpha 1 move)
- Making Docker the product default. Default provider stays `lando` except darwin-x64, where provider-lando fail-closes
- A second Drupal recipe
- A second Rails source beside the upgraded `recipes/rails` tree
- Editing `spec/ROADMAP.md`

## Exit criteria

All US-592..US-600 `passes: true` with green verification. Unsigned `4.0.0-dev.N` exists on `dev` for all six targets. Every target has live setup, live doctor, live Drupal journey, and live Rails journey. Intel macOS uses provider-docker while provider-lando rejects with tagged remediation. Compile-only evidence is not an exit.

## Authoritative spec parts

§5 (bundled providers, capabilities, fail-closed unsupported intent), §8.8 (recipes, `recipes/` layout, bundled vs staged), §10.8 (`lando setup`, `lando doctor`), §13.5 (distribution forms and compile targets), §17 (binary build pipeline; signing stages stay non-goals for this wave), §19 (executable recipe READMEs).
