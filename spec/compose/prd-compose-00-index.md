# PRD Index — Compose Service-Key Vocabulary (post-freeze feature wave, 4.1 target)

> **Phase position:** This wave is **post-feature-freeze feature work** targeted at 4.1 (see `spec/ROADMAP.md` Phase 9). Feature freeze was entered at the end of Beta 1, so this set follows the frozen-contract precedent (`TunnelService`/`RemoteSource`): the spec parts were amended **first** (§6.2, §7.4, §5.5.1 — all in the same change that created this directory), and the SDK schema additions here are **additive** under `sdk/AGENTS.md` compatibility rules. When these PRDs and a spec part disagree, the spec part wins and both must be reconciled together.

## Introduction

Lando's Compose compatibility promise is now normatively defined (§7.4) as a **service-key vocabulary, not a file-format promise**: any Compose *service definition* pastes under `services.<name>` and works; project-level composition (shared bases, multi-file overrides, override tags) is owned by Lando primitives (`type:`/recipes/§6.11.1 inheritance, `includes:`, the §7.2 merge). This wave makes that promise true and — equally important — makes it **cheap to keep true** as the upstream Compose spec evolves.

The current shipped surface falls short of the vocabulary in three ways:

1. **Ordinary Compose service blocks do not parse.** `ServiceConfig` (`sdk/src/schema/landofile.ts`) accepts only Lando spellings (`dependsOn`, `workingDirectory`, `composeBuild`) and only short syntax: `environment` map-only, `ports`/`volumes` short-string-only, no `depends_on` condition map, no Compose-shaped `healthcheck`, no `env_file`, no service-level `labels`/`networks`/`expose`/`restart`.
2. **The per-container runtime-knob tier is absent.** Keys with no Lando abstraction (`cap_add`, `privileged`, `ulimits`, `tmpfs`, `extra_hosts`, `shm_size`, ...) — the tier users actually hit when a service needs a knob Lando didn't anticipate — have no schema shape and no preserve path, so they fail validation with no remediation story.
3. **Nothing tracks the upstream spec.** There is no vendored upstream schema, no committed key-disposition record, and no gate that forces a decision when upstream adds a key. Alignment today is manual and silent-drift-prone.

This set fixes all three with four PRDs: an **alignment substrate** (vendored pinned schema + disposition matrix + `check:compose-coverage` + automated bump), the **vocabulary normalizations** (Compose spellings, short/long forms, `build:` shape discrimination, `depends_on` conditions into orchestration), the **runtime-knob tier** (schema shapes → `extensions.compose` → capability check → Podman realization), and the **rejection + conformance surface** (tagged rejections with remediation, fixture-driven conformance, published docs matrix, guide coverage).

This PRD set picks up at **US-466** (Beta 1 ended at US-465) and runs through **US-477**.

## Source References

- [`spec/07-landofile-and-config.md`](../07-landofile-and-config.md) §7.4 — the vocabulary principle, disposition matrix, vendored-schema pin, rejected project machinery, `kind: compose` fragment rules.
- [`spec/06-services.md`](../06-services.md) §6.2 — normalization contract (spellings, short/long forms, `build:` shape discrimination, `depends_on` conditions, knob tier), §6.7 healthcheck model, §6.13 orchestration DAG.
- [`spec/05-runtime-providers.md`](../05-runtime-providers.md) §5.5.1 — normalize/preserve/capability-check/reject order, `composeSpec: none | portable | native` capability.
- [`sdk/AGENTS.md`](../../sdk/AGENTS.md) — additive SDK surface rules, schema snapshot workflow.
- Upstream: `compose-spec/compose-go` (tagged releases; canonical `schema/compose-spec.json`), `compose-spec/conformance-tests` (fixture suite, WIP).

## Goals

- Any Compose service definition using `normalized` or `preserved` keys parses and plans; every `rejected` key fails closed with a tagged error and remediation naming the Lando-owned alternative.
- Every key path in the vendored upstream service schema has exactly one committed disposition, and CI fails when upstream introduces an unclassified key.
- The knob tier reaches real containers: the bundled Podman provider realizes the common knobs, capability-gated per §5.5.1.
- The published docs key matrix, the conformance fixtures, and the disposition matrix are generated from the same source of truth — no hand-maintained parallel lists.

## Non-Goals

- No Compose project-file compatibility: no `extends`, no multi-file override semantics, no `!reset`/`!override` tags, no compose-go loader port.
- No Swarm orchestration (`deploy` beyond `resources`), no `container_name`, `network_mode`, or `links`.
- No new provider capabilities beyond the existing `composeSpec` axis; no provider-neutral planner semantics for preserved knobs.
- No changes to Lando's own composition primitives (`includes:`, recipes, §7.2 merge).

## PRDs in this set

| #  | PRD | Subsystem | US range | Depends on |
| -- | --- | --------- | -------- | ---------- |
| 01 | [Spec-alignment substrate](./prd-compose-01-alignment-substrate.md) | vendored pinned compose-go schema + committed disposition matrix + `check:compose-coverage` gate, automated upstream-bump workflow | US-466..US-467 | — |
| 02 | [Service-key vocabulary normalization](./prd-compose-02-service-vocabulary.md) | Compose spellings + alternate forms, `ports`/`expose`/`volumes` long syntax, Compose `healthcheck` shape, `build:` shape discrimination, `depends_on` conditions in orchestration | US-468..US-472 | PRD-01 (matrix classifies the keys) |
| 03 | [Per-container runtime knobs](./prd-compose-03-runtime-knobs.md) | knob-tier schema shapes + preserve + capability planning path, Podman realization | US-473..US-474 | PRD-01; PRD-02 (US-469 tmpfs routing) |
| 04 | [Rejection surface & conformance](./prd-compose-04-rejection-and-conformance.md) | tagged rejections + remediation (incl. `kind: compose` fragments and YAML override tags), conformance fixtures, closeout: published docs matrix + executable guide + SDK snapshot reconciliation | US-475..US-477 | PRD-01..03 |

## Verification contract

Every story carries TDD acceptance criteria plus `Tests pass`, `Typecheck passes`, `Lint passes`, and any touched boundary/codegen gate (`check:compose-coverage` once it exists, `codegen:schema-snapshot`, `lint:guides`/`check:guide-coverage` where guides change). Stories adding SDK surface update `sdk/API_COMPATIBILITY.md` and refresh the schema snapshot in the same change.

## Open questions

- Whether `deploy.resources` should eventually normalize into a provider-neutral `resources:` plan field instead of riding `extensions.compose`; deferred until a second provider needs it.
- Whether `profiles:` should gain active semantics (service subset activation) or remain shape-accepted and inert; current disposition is `preserved`-inert pending user signal.
- Granularity of the `composeSpec` capability: if providers need per-knob capability reporting (e.g. `gpus` vs `ulimits`), the capability axis may grow a knob-level detail map; out of scope here.
