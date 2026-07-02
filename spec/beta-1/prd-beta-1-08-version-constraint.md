# PRD: BETA1-08 — Landofile version constraint (`lando:`)

## Introduction

Beta 1 is the contract completion and agent-native feature wave before feature freeze. The top-level `lando:` Landofile key is part of that wave: it lets a project state the Lando core version range it requires, then fail early when a teammate, CI runner, or agent uses an incompatible binary.

This PRD covers the schema, merge-layer semantics, tagged failure, emergency skip path, hot-path enforcement, and doctor reporting for the version constraint. It does not change `runtime:` or per-service `api:` semantics. Those version surfaces remain separate from the core-version constraint.

## Source References

- [`spec/07-landofile-and-config.md`](../07-landofile-and-config.md) §7.2 merge order and §7.4 top-level `lando: <semver-range>` key, including the "Version constraint (`lando:`)" rules block.
- [`spec/07-landofile-and-config.md`](../07-landofile-and-config.md) §7.8 schema publication and JSON Schema generation.
- [`spec/08-cli-and-tooling.md`](../08-cli-and-tooling.md) §8.5 tooling compilation and hot-path behavior.
- [`spec/08-cli-and-tooling.md`](../08-cli-and-tooling.md) §8.11 machine-readable output contract.
- [`spec/ROADMAP.md`](../ROADMAP.md) Phase 5, Beta 1 feature-wave framing.

## Goals

- Add the `lando:` Landofile key to the public schema as a semver range constraint on the running Lando core version.
- Validate bad range syntax as Landofile parse failure and evaluate valid constraints after the full six-file merge.
- Accumulate every declared range across merge layers and fail closed when the embedded `CORE_VERSION` satisfies anything less than all ranges.
- Carry enough provenance in errors, warnings, JSON output, app-plan cache, and doctor output for users and agents to fix the mismatch without guessing.
- Preserve tooling hot-path performance by enforcing the cached constraint without provider contact.

## User Stories

### US-404: The `lando:` Landofile key

**Description:** As a project maintainer, I can declare `lando: <semver-range>` in any Landofile layer so every developer and CI runner fails early with a clear version error when their Lando core is too old, too new, or outside the team's supported range.

**Acceptance Criteria:**

- [ ] The published Landofile Effect Schema accepts an optional top-level `lando:` string and rejects unparseable semver ranges during Landofile validation with tagged `LandofileParseError` and remediation showing valid range syntax.
- [ ] The JSON Schema and generated schema artifacts expose `lando:` as the core-version constraint field; SDK schema snapshot regeneration is run with `bun run codegen:schema-snapshot` for the public schema change.
- [ ] Version-constraint evaluation runs after the §7.2 six-file merge and before app planning, with provenance for every source layer that declared a range.
- [ ] Constraints accumulate across merge layers: the running version must satisfy every declared range, and a higher-precedence layer can tighten but not erase a lower-precedence requirement.
- [ ] Semver evaluation includes prereleases so a range such as `>=4.1` is satisfied by `4.1.0-beta.2`.
- [ ] Unsatisfied constraints fail closed with tagged `LandofileVersionConstraintError` carrying declared range or ranges, source layer or layers, running version, and remediation to run `lando update` or edit the constraint.
- [ ] `LANDO_SKIP_VERSION_CONSTRAINT=1` downgrades the failure to a renderer warning for the current invocation and records the same range, source, running-version, and remediation context in machine-readable warnings.
- [ ] Tests prove `lando:` is distinct from `runtime:` and per-service `api:` and does not change their validation paths.
- [ ] Tests pass
- [ ] Typecheck passes
- [ ] Lint passes

### US-405: Hot-path and reporting surfaces

**Description:** As a user or automation agent running Lando commands, I get the same version-constraint protection on every app-loading command, including the tooling hot path, and I can see skipped or unsatisfied constraints in `lando doctor`.

**Acceptance Criteria:**

- [ ] Every command that loads an app enforces the accumulated `lando:` constraints before planning or provider action, including config, lifecycle, exec, tooling, and app-inspection commands.
- [ ] The app plan cache carries the normalized constraint set and source-layer provenance so the tooling bootstrap hot path compares it against embedded `CORE_VERSION` without re-parsing the Landofile or contacting the provider.
- [ ] A stale or missing cached constraint forces the same safe app-plan refresh path as other plan-cache invalidation cases, then enforces the refreshed constraint before tooling execution.
- [ ] Hot-path benchmark coverage remains green, with no regression outside the existing budget for cached tooling command startup.
- [ ] `lando doctor` reports apps with unsatisfied constraints and invocations where `LANDO_SKIP_VERSION_CONSTRAINT=1` is active, including remediation and source-layer context.
- [ ] `--format json` output for command failures and doctor findings uses the central machine-output contract and encodes `LandofileVersionConstraintError` through the tagged-error schema.
- [ ] Executable guide coverage documents authoring `lando:`, the failure payload, the skip warning, and the repair workflow.
- [ ] Tests pass
- [ ] Typecheck passes
- [ ] Lint passes

## Functional Requirements

- **FR-1:** `lando:` is a public Landofile schema field whose value is a valid semver range string.
- **FR-2:** Invalid range syntax fails Landofile validation as `LandofileParseError`; valid but unsatisfied ranges fail runtime loading as `LandofileVersionConstraintError` unless skipped.
- **FR-3:** Constraint evaluation happens after the full §7.2 merge and accumulates every declared range with source-layer provenance.
- **FR-4:** Range evaluation is prerelease-inclusive, matching the spec example where `>=4.1` accepts `4.1.0-beta.2`.
- **FR-5:** Every app-loading command enforces the constraint, and tooling hot-path enforcement uses cached constraint data plus embedded `CORE_VERSION` without provider contact.
- **FR-6:** `LANDO_SKIP_VERSION_CONSTRAINT=1` produces a renderer warning rather than a hard failure for that invocation and remains visible to doctor and machine-output consumers.
- **FR-7:** `lando doctor` reports unsatisfied and skipped constraints with remediation.

## Non-Goals

- No new Landofile version surfaces beyond `lando:`; `runtime:` and service `api:` stay unchanged.
- No provider, recipe, or service-level version negotiation.
- No compatibility shim that silently ignores constraints for older projects.
- No network contact during tooling hot-path constraint checks.

## Technical Considerations

- The semver parser must support the range grammar exposed in remediation and must be configured for prerelease-inclusive satisfaction.
- The implementation needs both merged-tree evaluation and layer-level provenance. A single post-merge scalar is not enough because constraints accumulate rather than replace.
- The app-plan cache should store a normalized, schema-encoded form of the constraint set so both source and compiled dispatch paths read the same shape.
- The skip path must be a narrow invocation-scoped env escape hatch. It should not mutate the app plan cache or mark the constraint as satisfied.
- Error and warning payloads need redaction review even though version ranges are not secrets, because they flow through the shared machine-output seam.

## Success Metrics

- A project with `lando: ">=4.1 <5"` fails with `LandofileVersionConstraintError` under an incompatible `CORE_VERSION` before provider contact.
- The same project runs on `4.1.0-beta.2` when the range is `>=4.1`.
- Cached tooling execution remains within the established hot-path benchmark budget while enforcing the constraint.
- `lando doctor --format json` exposes unsatisfied and skipped constraints without prose scraping.

## Guide Coverage

| Surface | Guide | Status |
| --- | --- | --- |
| Landofile `lando:` authoring and repair | `docs/guides/config/version-constraint.mdx` | Planned (new guide, this PRD) |
| `LANDO_SKIP_VERSION_CONSTRAINT=1` emergency path | `docs/guides/config/version-constraint.mdx` | Planned (new guide, this PRD) |
| Doctor reporting for constraints | owned by the doctor diagnostics guide surface | Update, re-run guide drift gate |

## Open Questions

- Which semver library or internal parser is the canonical implementation for prerelease-inclusive range checks across Bun source mode and compiled binaries?
- What exact hot-path benchmark name owns cached tooling startup, and what threshold is considered the regression budget for this PRD?
