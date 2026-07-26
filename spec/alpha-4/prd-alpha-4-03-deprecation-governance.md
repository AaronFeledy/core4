# PRD: ALPHA4-03 — Deprecation governance

## Introduction

Deprecation governance (§18 / `spec/16-deprecation-and-surface-evolution.md`, plus §20.4 in `spec/18-global-app.md`) makes every public Lando surface deprecatable through one machine-readable model. Alpha 4 ships the canonical `DeprecationNotice`, records runtime usage through `DeprecationService`, propagates notices into schemas, docs, contracts, manifests, IDE hovers, renderer warnings, lifecycle events, and release gates, and gives operators a `lando doctor --deprecations` report.

Depends on: no Alpha 4 PRD prerequisite. Downstream PRDs that publish schemas, telemetry, release machinery, and signing depend on this one.

## Source References

- [`spec/16-deprecation-and-surface-evolution.md`](../16-deprecation-and-surface-evolution.md) §18.1 through §18.8.
- [`spec/18-global-app.md`](../18-global-app.md) §20.4 `globalServices:` deprecation field.
- [`spec/13-testing-and-distribution.md`](../13-testing-and-distribution.md) §13.2 and §13.4 schema, deprecation, and merge gates.
- [`spec/15-binary-build-and-release.md`](../15-binary-build-and-release.md) §17.1 release pipeline ordering.

## Goals

- Publish one canonical `DeprecationNotice` model from `@lando/sdk` and re-export it from `@lando/core/schema`.
- Record deprecation usage once per process per `(kind,id)` while still counting repeated use for summaries.
- Propagate notices automatically through JSON Schema, generated docs, command and plugin contracts, manifests, public TypeScript exports, runtime warnings, and lifecycle events.
- Enforce `removeIn` policy during release and codegen checks before type checking begins.
- Give users and support staff a clear per-app deprecation report through `lando doctor --deprecations`.

## User Stories

### US-215: `DeprecationNotice` schema and publication

**Description:** As a plugin author, I need a canonical deprecation notice schema so every public surface describes deprecation state the same way.

**Acceptance Criteria:**

- [ ] `DeprecationNotice` is published from `@lando/sdk` and re-exported by `@lando/core/schema`.
- [ ] The schema includes `since`, `removeIn`, `severity`, `replacement`, `note`, `docsUrl`, and `ticket` with the defaults and required fields from §18.2.
- [ ] `removeIn` validation rejects patch removals, past releases, and missing values once a notice is older than 12 months.
- [ ] Structural dedupe uses `since`, `removeIn`, and `note`.
- [ ] The §13.2 schema snapshot gate round-trips the notice losslessly and emits `dist/schemas/deprecation-notice.json`.
- [ ] Tests pass.
- [ ] Typecheck passes.
- [ ] Lint passes.

### US-216: `DeprecationService` registry and usage API

**Description:** As the runtime, I need a central service that registers deprecated surfaces, records actual use, and answers summary and lookup requests.

**Acceptance Criteria:**

- [ ] `DeprecationService` ships at bootstrap level `minimal` with `use`, `summary`, `lookup`, and internal `register` operations.
- [ ] The registry index is populated by the `plugins` bootstrap level, while `register` remains off the hot path.
- [ ] `use` short-circuits repeated `(kind,id)` warnings in a single process while summaries retain usage counts.
- [ ] `severity: "error"` fails with `DeprecatedSurfaceError` on use.
- [ ] A non-deprecated alias that points at a deprecated canonical surface fails with `DeprecationContradictionError`.
- [ ] Tests pass.
- [ ] Typecheck passes.
- [ ] Lint passes.

### US-217: `deprecation-used` lifecycle event

**Description:** As an embedding host or telemetry subscriber, I need to receive a typed event when deprecated runtime behavior is actually used.

**Acceptance Criteria:**

- [ ] `DeprecationUse` and `DeprecationUsedEvent = { use: DeprecationUse }` schemas are published from `@lando/sdk`.
- [ ] `DeprecationService.use` emits `deprecation-used` after recording usage and before the deprecated behavior continues.
- [ ] Event subscribers are recommended to use `late` priority, and subscriber failures do not abort the originating command.
- [ ] Library API tests prove subscribed hosts receive the event without going through the CLI renderer.
- [ ] Telemetry can consume the same event through the `Telemetry` service without a second deprecation path.
- [ ] Tests pass.
- [ ] Typecheck passes.
- [ ] Lint passes.

### US-218: Schema-annotation propagation

**Description:** As a docs and tooling consumer, I need schema-level deprecations to flow into JSON Schema and generated reference content without hand-maintained tables.

**Acceptance Criteria:**

- [ ] Effect Schema annotations accept a `DeprecationNotice` on deprecated schemas and fields.
- [ ] JSON Schema generation emits both `deprecated: true` and `x-deprecation` for every annotated surface.
- [ ] Generated Starlight reference content receives a deprecation callout from the same schema walk.
- [ ] IDE hover data includes the deprecation note where the schema-driven type surface supports it.
- [ ] The schema gate verifies every emitted `x-deprecation` validates against `DeprecationNotice`.
- [ ] Tests pass.
- [ ] Typecheck passes.
- [ ] Lint passes.

### US-219: Contract-field and manifest-field deprecation

**Description:** As a core maintainer or plugin author, I need command, tooling, recipe, service, provider, and plugin surfaces to carry deprecation notices through their existing contracts.

**Acceptance Criteria:**

- [ ] Built-in commands, flags, args, service types, service features, route filters, lifecycle events, event fields, render events, and provider extensions accept deprecation contract fields where §18.5 assigns them.
- [ ] Plugin command, whole-plugin, plugin manifest field, `globalServices:`, recipe, prompt, tooling task, tooling flag, and tooling arg deprecations are accepted through manifest or YAML fields.
- [ ] Plugin loading validates deprecation notices, records them in `DeprecationService`, and fails invalid notices before the deprecated surface is used.
- [ ] Alias-scoped deprecations are tracked separately from canonical command deprecations.
- [ ] Registry construction performs the three required walks: schema annotations, built-in contracts, and plugin manifests.
- [ ] Tests pass.
- [ ] Typecheck passes.
- [ ] Lint passes.

### US-220: TSDoc `@deprecated` and `markDeprecated()` enforcement

**Description:** As a TypeScript consumer, I need public deprecated exports and tagged errors to show IDE deprecation hints and record runtime use when called.

**Acceptance Criteria:**

- [ ] Public TypeScript exports can pair TSDoc `@deprecated` with `markDeprecated(notice, impl)` for runtime recording.
- [ ] Deprecated tagged error classes can expose `static readonly deprecation: DeprecationNotice` and TSDoc `@deprecated`.
- [ ] The lint gate fails when a public export has TSDoc `@deprecated` without a matching `markDeprecated()` wrapper or accepted tagged-error deprecation metadata.
- [ ] `markDeprecated()` records through `DeprecationService.use` and preserves the original implementation's callable behavior.
- [ ] IDE hover and API report output include the same actionable note and replacement text.
- [ ] Tests pass.
- [ ] Typecheck passes.
- [ ] Lint passes.

### US-221: Renderer warnings and suppression controls

**Description:** As a CLI user, I need clear deprecation warnings by default, with suppression controls that silence renderer output but not machine-readable diagnostics.

**Acceptance Criteria:**

- [ ] The first use of each `(kind,id)` emits one warning line through the renderer, and later uses only increment the summary count.
- [ ] `severity: "info"` notices emit one end-of-run summary line instead of immediate warning spam.
- [ ] `--no-deprecation-warnings` and `LANDO_DEPRECATION_WARNINGS=0` suppress only renderer warning output.
- [ ] `lando doctor --deprecations` and `lando config --format yaml` ignore suppression and still report deprecations.
- [ ] The JSON renderer emits structured `deprecation-used` events on stderr.
- [ ] Tests pass.
- [ ] Typecheck passes.
- [ ] Lint passes.

### US-222: `scripts/check-deprecations.ts` release gate

**Description:** As a release engineer, I need stale and overdue deprecations to fail before Beta or GA artifacts are built.

**Acceptance Criteria:**

- [ ] `scripts/check-deprecations.ts` runs after codegen and before type checking through `bun run codegen:check`.
- [ ] The gate verifies `since` matches a released or pending semver.
- [ ] The gate requires `removeIn` once a notice is older than 12 months and ensures `removeIn` is a future major or minor release.
- [ ] A surface still present at its `removeIn` release fails with `DeprecationStaleError`.
- [ ] A surface still present after its `removeIn` release fails with `DeprecationOverdueError`, and removing a surface requires removing its notice plus updating tests, docs, and changelog.
- [ ] Tests pass.
- [ ] Typecheck passes.
- [ ] Lint passes.

### US-223: `lando doctor --deprecations` report

**Description:** As an operator, I need a per-app report of deprecated surfaces used by the current app and its loaded plugins.

**Acceptance Criteria:**

- [ ] `lando doctor --deprecations` prints a dedicated deprecations section with columns for kind, id, severity, since, removeIn, replacement, note, docsUrl, source, and count.
- [ ] The report reads from `DeprecationService.summary()` and `lookup(kind,id)` rather than re-walking manifests ad hoc.
- [ ] App, plugin, global-service, Landofile, config, env override, command, and event deprecations are represented when present.
- [ ] Empty reports state that no deprecations were used or registered for the app.
- [ ] JSON and YAML doctor output expose the same structured data without renderer-warning suppression.
- [ ] Tests pass.
- [ ] Typecheck passes.
- [ ] Lint passes.

## Functional Requirements

- FR-1: Every public surface MUST be deprecatable through schema annotations, contract fields, manifest fields, or TSDoc plus `markDeprecated()`.
- FR-2: `DeprecationNotice` is the only notice model and MUST be published from `@lando/sdk` and re-exported by `@lando/core/schema`.
- FR-3: Runtime use MUST be recorded through `DeprecationService.use`, deduped per process by `(kind,id)`, and counted for summaries.
- FR-4: Runtime use MUST emit `deprecation-used` after recording and before continuing behavior.
- FR-5: JSON Schema output MUST include `deprecated: true` and `x-deprecation` for schema-annotated surfaces.
- FR-6: Renderer output MUST warn once per `(kind,id)`, support renderer-only suppression, and keep structured JSON events on stderr.
- FR-7: `scripts/check-deprecations.ts` MUST enforce `since` and `removeIn` policy during `bun run codegen:check`.
- FR-8: `lando doctor --deprecations` MUST report registered and used deprecations in human and machine-readable formats.

## Non-Goals

- Removing any deprecated surface during Alpha 4 unless a separate story explicitly owns the removal.
- GA schema-artifact caching at `https://schemas.lando.dev/v4/`.
- A web dashboard for deprecation analytics.
- Automatic source-code rewrites from deprecated APIs to replacements.
- Per-user persistence of warning dedupe across processes.

## Technical Considerations

- `DeprecationService` is available at `minimal`, but full registry population waits for `plugins` so hot-path commands do not scan plugin manifests early.
- The registry should be built from source-of-truth declarations, not from generated docs output.
- Severity `error` is still a deprecation state, not a removal. It records use and then fails with a typed error.
- Renderer suppression must live at the output layer so `doctor`, `config`, telemetry, and library subscribers still receive structured data.
- The `globalServices:` `deprecated?: DeprecationNotice` field from §20.4 uses the same plugin-manifest validation and registry path as other plugin contribution surfaces.

## Success Metrics

- A deprecated command flag used three times in one process emits exactly one human warning and reports count `3` in the summary.
- Every deprecation notice in the registry round-trips through the §13.2 schema gate and validates as `DeprecationNotice`.
- A release rehearsal with an overdue `removeIn` fixture fails before type checking with the expected tagged error.

## Guide Coverage

Per [PRD-12 US-198](../alpha-3/prd-alpha-3-12-executable-guides.md) (`## Guide Coverage` convention) and [US-199](../alpha-3/prd-alpha-3-12-executable-guides.md) (drift gate), this PRD owns the executable guides listed below. Each guide exercises the happy path of its mapped user story; failure modes remain covered by unit and integration tests in the named packages. PRs that touch the listed surface paths MUST also touch the corresponding guide(s), or use the `Guide-Coverage-Skip:` escape hatch.

**Guides owned by this PRD:**

| User Story | Feature | Guide Path | Acceptance |
|---|---|---|---|
| US-221 | CLI deprecation warnings and suppression | `docs/guides/deprecations/cli-warnings-and-suppression.mdx` | Required at story acceptance |
| US-223 | `lando doctor --deprecations` report | `docs/guides/deprecations/doctor-report.mdx` | Required at story acceptance |
| US-219 | Plugin manifest and `globalServices:` deprecations | `docs/guides/plugins/deprecating-plugin-surfaces.mdx` | Required at story acceptance |

**CLI / source surface paths covered (drift gate input):**

- `sdk/src/deprecation/**`
- `sdk/src/schema/**`
- `core/src/deprecation/**`
- `core/src/cli/commands/doctor/**`
- `core/src/cli/renderer/**`
- `core/src/plugins/**`
- `plugins/*/src/**`
- `scripts/check-deprecations.ts`
- `scripts/codegen*`

## Open Questions

- Should `severity: "error"` render as a deprecation warning before the failure diagnostic, or only as the failure diagnostic? Default: render through the failure diagnostic only, while still emitting `deprecation-used`.
- Should `ticket` appear in public JSON Schema output? Default: include it only in internal metadata and omit it from public docs.
- Should `removeIn` be required earlier than 12 months for Beta-only surfaces? Default: no, use the same rule for all public surfaces.
