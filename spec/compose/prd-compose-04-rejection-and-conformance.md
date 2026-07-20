# PRD: COMPOSE-04 — Rejection surface, conformance fixtures, and published matrix

## Introduction

The vocabulary promise is only honest if the boundary is sharp on both sides: everything in the vocabulary works (PRD-02/03), and everything outside it fails **closed, tagged, and helpfully** — never silently dropped, never half-supported. This PRD lands the rejection surface for the §7.4 rejected dispositions (including `!reset`/`!override` YAML tags at load time and `kind: compose` include fragments), the fixture-driven conformance suite that proves the vocabulary against real Compose material, the published docs key matrix generated from the PRD-01 disposition matrix, an executable guide, and the SDK snapshot reconciliation that closes the wave.

## Source References

- [`spec/07-landofile-and-config.md`](../07-landofile-and-config.md) §7.4 — rejected list, `kind: compose` fragment rule, docs-matrix mandate; §7.2 merge (unchanged).
- [`spec/06-services.md`](../06-services.md) §6.2 — rejection bullet; §6.11.1 `type:` inheritance (the `extends` remediation target).
- [`spec/17-executable-tutorials.md`](../17-executable-tutorials.md) + root `AGENTS.md` guide gates — `lint:guides`, `check:guide-coverage`, `check:guide-drift`.
- Upstream: `compose-spec/conformance-tests` fixtures; compose-go loader test fixtures as supplementary corpus.
- `core/src/landofile/service.ts`, `core/src/landofile/lint.ts` — decode/lint seams for rejection errors.

## Goals

- Every rejected key fails with one tagged error shape carrying the key, the disposition, and a remediation naming the Lando-owned alternative.
- The conformance suite consumes upstream fixtures with a skip-list that is *derived from* the disposition matrix — a fixture may only be skipped because it uses rejected keys.
- The docs matrix, the error remediation text, and the skip-list all come from the single PRD-01 matrix.

## User Stories

### US-475: Tagged rejection surface

**Description:** As a user whose service block uses a rejected key, I get a tagged, machine-readable error telling me exactly which key, why, and what Lando surface replaces it — in my Landofile and in `kind: compose` include fragments alike.

**Acceptance Criteria:**

- [ ] A `Schema.TaggedError` (e.g. `ComposeKeyRejectedError`) carries `{ service?, keyPath, remediation }`; remediation text comes from the matrix entry (US-466), not hand-written per call site.
- [ ] All §7.4 rejected keys produce it: `extends` (→ `type:` inheritance §6.11.1 / recipes / `includes:`), `container_name` (→ Lando naming), `network_mode`, `links`, Swarm `deploy` orchestration keys (keyPath-precise, e.g. `deploy.replicas` rejects while `deploy.resources` preserves).
- [ ] `!reset` and `!override` YAML tags are rejected at YAML load with the same error shape and a §7.2-merge remediation; YAML anchors/aliases/merge-keys (`<<:`) continue to work, tested.
- [ ] `kind: compose` include fragments route through the same decode path and produce identical errors with the fragment source attributed.
- [ ] Errors surface through the standard CLI failure formatter and `--format json` envelope; `lando config` on a rejecting file shows the tagged failure, not a stack.
- [ ] Landofile lint reports rejected keys as errors with the same remediation.
- [ ] Tests pass
- [ ] Typecheck passes
- [ ] Lint passes

### US-476: Conformance fixture suite

**Description:** As a core maintainer, the vocabulary is proven against upstream Compose fixture material on every CI run, and the skip-list cannot quietly hide unsupported-but-classified-supported behavior.

**Acceptance Criteria:**

- [ ] Service-level fixtures vendored from `compose-spec/conformance-tests` (plus a curated real-world corpus: the `depends_on`-condition, long-form-ports/volumes, list-env, Compose-healthcheck patterns from the PRD-02 success metric) live under `core/test/fixtures/compose/`.
- [ ] A loader-level suite decodes each fixture's service blocks in a Landofile context and asserts per-key outcomes against the disposition matrix: `normalized` keys produce their plan fields, `preserved` keys round-trip through `extensions.compose`, `rejected` keys produce `ComposeKeyRejectedError`.
- [ ] The skip-list is computed: a fixture may be skipped only if the walker finds a rejected-disposition key in it; a stale skip entry (fixture no longer uses rejected keys) fails the suite.
- [ ] Fixture refresh is a codegen script with a pin (same pattern as US-466), offline at test time.
- [ ] Provider-level spot checks for a small fixture subset run in the env-gated Podman integration suite.
- [ ] Tests pass
- [ ] Typecheck passes
- [ ] Lint passes

### US-477: Published matrix, executable guide, and SDK reconciliation

**Description:** As a user, I can read exactly which Compose keys work, which are provider-dependent, and which are replaced by Lando surfaces, and follow a runnable guide that pastes a Compose service into a Landofile — and as an SDK consumer, the wave's schema additions are published coherently with nothing left drifting.

**Acceptance Criteria:**

- [ ] The §7.4-mandated docs key matrix is generated from the disposition matrix (key, disposition, normalization target or capability note or remediation) by a `codegen:*` script; drift-gated with `git diff --exit-code` like other generated docs.
- [ ] An executable guide (`docs/guides/...mdx`) ports a realistic Compose service block (long-form ports, `depends_on` condition, a knob like `extra_hosts`) into a Landofile and runs it; one rejected-key step shows the tagged error and applies the remediation.
- [ ] `bun run dev:guides <guide> --once` passes; `lint:guides`, `check:guide-coverage`, and `check:public-transcripts`/`check:guide-drift` gates green.
- [ ] The guide and the matrix cross-link; no hand-maintained key list exists anywhere in docs.
- [ ] `codegen:schema-snapshot` output reflects the final `ServiceConfig`/`LandofileShape` (all PRD-02/03 shapes, `composeBuild` removal); committed snapshot matches with `git diff --exit-code`.
- [ ] Published JSON Schema (`sdk/src/schema/json-schema.ts` registry) includes the new shapes with annotations (descriptions, deprecations where §18 requires); `COMPOSE_TOP_LEVEL_KEYS`/display constants reconciled with the top-level classification from US-466.
- [ ] `sdk/API_COMPATIBILITY.md` documents the wave's additive surface and the `composeBuild` gut-and-replace in one entry.
- [ ] The §4.2 plugin-abstraction coverage suite and all boundary gates (`check:renderer-boundary`, `check:probe-boundary`, `check:paths-boundary`, `check:state-store-boundary`, `check:redaction-boundary`, `check:compose-coverage`) pass on the completed wave.
- [ ] Full gate: `bun run typecheck`, `bun test`, `bun run lint` green at the wave's head.
- [ ] Tests pass
- [ ] Typecheck passes
- [ ] Lint passes

## Functional Requirements

- FR-1: One error shape for all rejections; remediation text sourced from the matrix.
- FR-2: The skip-list, docs matrix, and remediation text are derived artifacts of the PRD-01 matrix — three consumers, one source.
- FR-3: Rejection happens at decode/lint time where shape suffices, at planning time where context is required (e.g. `deploy` subkey split); never at provider time.

## Non-Goals

- No auto-translation of rejected keys (no `extends` flattener, no `container_name` honoring); translators remain the §7.4.1 config-translator surface.
- No file-level `docker-compose.yml` import command (that is translator territory).

## Success Metrics

- Corpus rate: the committed real-world fixture corpus decodes ≥ the target ratio agreed at kickoff (goal: "most compose parses" made measurable), with every failure attributable to a `rejected` disposition.
- Zero hand-maintained key lists in docs, errors, or tests.

## Open Questions

- Whether the docs matrix also publishes per-provider knob support (from US-473 declarations); nice-to-have, not gating.
