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
- [ ] `!reset` and `!override` YAML tags are rejected at YAML load with the same tagged error shape and a §7.2-merge remediation; a quoted occurrence (e.g. `"!reset"`) is an ordinary string literal and is not rejected. YAML anchor, alias, and merge-key (`<<:`) *support* is outside this story's scope — the tested criterion here is a regression guard proving these forms are not misclassified as a Compose key rejection, not a claim that they are supported.
- [ ] `kind: compose` include fragments route through the same decode path and produce identical errors with the fragment source attributed.
- [ ] Errors surface through the standard CLI failure formatter and `--format json` envelope; `lando app config` / `lando info` / `lando app config lint` on a rejecting file shows the tagged failure, not a stack. (Bare top-level `lando config` reads global config, not the app Landofile, and cannot prove this.)
- [ ] Landofile lint reports rejected keys as errors with the same remediation.
- [ ] Tests pass
- [ ] Typecheck passes
- [ ] Lint passes

### US-476: Conformance fixture suite

**Description:** As a core maintainer, the vocabulary is proven against upstream Compose fixture material on every CI run, and the skip-list cannot quietly hide unsupported-but-classified-supported behavior.

**Acceptance Criteria:**

- [ ] Service-level fixtures vendored from `compose-spec/conformance-tests` (plus a curated real-world corpus: the `depends_on`-condition, long-form-ports/volumes, list-env, Compose-healthcheck patterns from the PRD-02 success metric) live under `core/test/fixtures/compose/`. Fixture selection is limited to normalized and preserved production behavior implemented before US-476; discovering a missing production contract creates a binding prerequisite story and MUST NOT add that behavior inside the fixture story.
- [ ] A loader-level suite decodes each fixture's service blocks in a Landofile context and asserts per-key outcomes against the disposition matrix: `normalized` keys produce their plan fields, `preserved` keys round-trip through `extensions.compose`, `rejected` keys produce `ComposeKeyRejectedError`.
- [ ] The skip-list is computed: a fixture may be skipped only if the walker finds a rejected-disposition key in it; a stale skip entry (fixture no longer uses rejected keys) fails the suite.
- [ ] Fixture refresh is a codegen script with a pin (same pattern as US-466), offline at test time.
- [ ] Provider-level spot checks for a small fixture subset run in the env-gated Podman integration suite.
- [ ] Tests pass
- [ ] Typecheck passes
- [ ] Lint passes

### US-482: Native Compose service fields are honest end to end

**Description:** As a user authoring supported Compose-native service fields, `networks`, `configs`, `secrets`, `profiles`, and service-level `x-*` values are accepted and preserved only when the selected provider can realize their documented semantics or rejects them before provider action.

**Acceptance Criteria:**

- [ ] The published `ServiceConfigInput` and canonical `ServiceConfig` schemas accept the vendored short and long forms of service-level `networks`, `configs`, `secrets`, `profiles`, and `x-*`; schema annotations state whether each field is active or preserved-inert, and no annotation promises profile activation before it exists.
- [ ] Planning preserves every accepted value losslessly under `ServicePlan.extensions.compose`, including nested `x-*`, without overwriting labels or other extension data contributed earlier in service composition.
- [ ] Capability validation is fail-closed before provider action. A provider may accept one of these fields only when it realizes that field's documented semantics; coarse `composeSpec: native` MUST NOT silently bless an ignored field. The capability/declaration contract is refined if the existing tier cannot express truthful partial support.
- [ ] The bundled provider either realizes service network attachments, config mounts, secret mounts, profile behavior, and declared extension semantics, or explicitly rejects each unsupported field during planning with `CapabilityError` naming the service, field, and provider. No accepted field is silently dropped.
- [ ] The upstream `different_networks`, `simple_network`, `simple_configfile`, and `simple_secretfile` fixtures move into this story with loader-level literal expectations and provider-level realization-or-rejection assertions; service `profiles` and `x-*` receive equivalent curated fixtures.
- [ ] Planner cache semantics and binary fixtures are revised only after the final preserved plan shape is fixed; cache-hit capability checks cannot bypass the same fail-closed decision as cache misses.
- [ ] `sdk/API_COMPATIBILITY.md`, compatibility exceptions, generated schema artifacts, and generated schema reference pages are updated together. Internal field maps or base structs are not exported unless an SDK consumer contract requires them.
- [ ] Focused SDK schema, loader, planner, cache, provider contract, and env-gated provider integration tests cover accepted and rejected paths.
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

### US-478: Native YAML anchors, aliases, and merge keys

**Description:** As a Landofile author, I can use native YAML anchors, aliases, and merge keys through the documented parser boundary without those forms being misclassified as rejected Compose vocabulary.

**Acceptance Criteria:**

- [ ] The canonical YAML parser resolves anchors and aliases before Landofile schema decoding for root files and included `landofile`/`compose` fragments.
- [ ] YAML merge keys (`<<:`) merge mapping aliases with deterministic YAML precedence before the existing Landofile layer merge runs.
- [ ] Unknown aliases, recursive alias graphs, invalid merge targets, and duplicate anchor definitions fail with `LandofileParseError` carrying source location and remediation; they never produce `ComposeKeyRejectedError`.
- [ ] `!reset` and `!override` remain rejected through `ComposeKeyRejectedError`, while quoted occurrences remain ordinary strings.
- [ ] Loader-, include-, and lint-level tests prove the production parser path and guard against tag-rejection misclassification.
- [ ] Tests pass
- [ ] Typecheck passes
- [ ] Lint passes

### US-479: Unify tooling fragments under includes kind tooling

**Description:** As a Landofile author, tooling-only fragments can use the canonical `includes:` surface with `kind: tooling` without publishing a schema literal ahead of its resolution and namespacing behavior.

**Acceptance Criteria:**

- [ ] `IncludeEntry.kind` additively accepts `tooling` only when the same change implements app-plan compile-time tooling-fragment resolution.
- [ ] `kind: tooling` preserves the `toolingIncludes:` namespace, flatten, internal, aliases, excludes, and vars contract from spec §8.5.8.
- [ ] `toolingIncludes:` and `includes:` entries with `kind: tooling` route through one implementation and produce equivalent plans; no compatibility shim or dual resolver is introduced.
- [ ] Schema artifacts, API compatibility notes, generated references, and executable tooling guide coverage are updated together.
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
