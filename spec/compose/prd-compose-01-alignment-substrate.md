# PRD: COMPOSE-01 — Spec-alignment substrate (vendored schema, disposition matrix, coverage gate)

## Introduction

Alignment with the upstream Compose spec must be mechanical, not remembered. This PRD builds the substrate the rest of the wave (and every future upstream change) stands on: the upstream Compose JSON Schema vendored from a **tagged `compose-spec/compose-go` release** and pinned by checksum; a **committed disposition matrix** assigning every service-schema key path exactly one of `normalized` / `preserved` / `rejected`; the **`check:compose-coverage` gate** that fails CI whenever the vendored schema contains a key path the matrix does not classify (or the matrix classifies a key the schema no longer has); and an **automated upstream-bump workflow** that turns new compose-go releases into PRs that cannot merge until new keys are classified.

Design constraints from the repo tenets: the Effect Schema in `@lando/sdk` remains the hand-authored public contract (spec §1.2 — no parallel generated type surface); the vendored JSON schema is the *coverage oracle*, not a codegen source. The matrix is the single source of truth consumed by the gate, the §7.4 published docs key matrix (PRD-04), and the conformance-fixture skip-list (PRD-04).

## Source References

- [`spec/07-landofile-and-config.md`](../07-landofile-and-config.md) §7.4 — disposition matrix and vendored-schema rules (normative).
- [`spec/05-runtime-providers.md`](../05-runtime-providers.md) §5.5.1 — planning consults the matrix.
- Root `AGENTS.md` — codegen conventions (generators emit + `biome check --write`; drift verified with `git diff --exit-code`), generated-workflow rules.
- Upstream: `compose-spec/compose-go/schema/compose-spec.json` at a tagged release (the `compose-spec/compose-spec` copy is an untagged mirror and MUST NOT be the pin source).

## Goals

- One command refreshes the vendored schema against the pin; drift between pin and vendored bytes is CI-detectable.
- The matrix is exhaustive over the service subtree of the vendored schema, and the gate proves it on every CI run.
- Upstream releases become classification PRs automatically; no human has to watch the upstream repo.

## User Stories

### US-466: Vendored pinned schema, disposition matrix, and coverage gate

**Description:** As a core maintainer, the upstream Compose JSON Schema is vendored in-repo, pinned to a tagged `compose-spec/compose-go` release with a checksum, every key path in its service subtree carries exactly one committed disposition, and CI fails the moment the schema and the matrix disagree in either direction.

**Acceptance Criteria:**

- [ ] `spec/compose/vendor/compose-spec.json` is committed, byte-identical to `schema/compose-spec.json` at the pinned compose-go tag; `spec/compose/vendor/pin.json` records `{ tag, sourceUrl, sha256 }` and the vendored file's checksum matches.
- [ ] `bun run codegen:compose-vendor` fetches the schema for the pinned tag, verifies the checksum, and rewrites the vendored file; it is the only path that touches the network, and it is not invoked by tests or `bun run codegen`'s offline gates.
- [ ] A unit test (offline) verifies vendored-file checksum against `pin.json` so manual edits to the vendored schema fail CI.
- [ ] A committed matrix module (e.g. `core/src/landofile/compose/dispositions.ts`) maps every service-subtree key path of the vendored schema to `normalized | preserved | rejected`, each entry carrying a short rationale and, for `rejected`, the remediation pointer (Lando key / provider extension / translator) used by PRD-04 error text.
- [ ] `bun run check:compose-coverage` walks the vendored schema's service definition, resolves `$ref`s, enumerates key paths, and fails listing (a) schema key paths with no matrix entry and (b) matrix entries with no schema key path. Exit code and output shape match the existing `check:*` gate conventions.
- [ ] Top-level project keys (`services`, `volumes`, `networks`, `configs`, `secrets`, `include`, `version`, `name`, `x-*`) are covered by a small static classification in the same module, asserted by the same gate.
- [ ] The gate runs in CI alongside the other boundary gates (workflow generator updated + `codegen` re-run; generated workflow diff committed together).
- [ ] The initial committed matrix classifies the full current vendored schema: the §6.2 normalized set, the §6.2 knob tier as `preserved`, and the §7.4 rejected list (`extends`, `container_name`, `network_mode`, `links`, Swarm `deploy` orchestration keys) as `rejected` — gate green.
- [ ] Unit tests cover the walker on a fixture schema (nested `$ref`, `oneOf` short/long forms, `patternProperties` like `x-*`); root `AGENTS.md` generated-files note gains the vendored path (generator-owned; hand edits forbidden).
- [ ] Tests pass
- [ ] Typecheck passes
- [ ] Lint passes

### US-467: Automated upstream-bump workflow

**Description:** As a core maintainer, when compose-go publishes a new tagged release, a PR appears that bumps the pin and vendored schema, and it cannot go green until any new key paths are classified.

**Acceptance Criteria:**

- [ ] A scheduled (nightly) generated workflow checks the latest compose-go tag against `pin.json`; when newer, it runs `codegen:compose-vendor` with the new tag and opens/updates a single rolling PR with the pin + vendored diff.
- [ ] The PR body lists added/removed key paths versus the previous vendored schema (the walker from US-466 reused as a diff reporter).
- [ ] `check:compose-coverage` failing on unclassified new keys is the intended merge blocker — verified by a test of the diff reporter against a synthetic schema bump; no auto-classification is ever attempted.
- [ ] The workflow is emitted by the workflow generator (never hand-edited), follows the existing nightly-workflow conventions (permissions, concurrency group, failure issue routing), and `git diff --exit-code` on generated paths is clean after `bun run codegen`.
- [ ] Tests pass
- [ ] Typecheck passes
- [ ] Lint passes

## Functional Requirements

- FR-1: The pin source MUST be a compose-go **tag**; untagged mirrors are forbidden as pin sources (§7.4).
- FR-2: The matrix is the single classification source consumed by the coverage gate, the published docs matrix (PRD-04), planning-time rejection (PRD-04), and the fixture skip-list (PRD-04). No second list may be hand-maintained.
- FR-3: All gate/test paths run offline; network access is confined to `codegen:compose-vendor` and the bump workflow.

## Non-Goals

- No codegen of Effect Schema or TypeScript types from the JSON schema.
- No auto-classification of new upstream keys.

## Success Metrics

- A synthetic upstream key addition (test fixture) turns CI red with an actionable message naming the unclassified path.
- Time-to-decision for a real upstream release is one review of a bot PR.

## Open Questions

- Rolling-PR vs issue-per-release for the bump surface; default is a single rolling PR.
