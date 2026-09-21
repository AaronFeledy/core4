# Lando v4 — Deprecation and Surface Evolution

> **Part 16 of 18** · [Index](./README.md)
> **Read next:** [17 Executable Guides and Scenarios](./17-executable-tutorials.md)

This part defines the single machine-readable deprecation contract for every public v4 surface.

---

## 18. Deprecation and Surface Evolution

### 18.1 Principles

1. Every public surface MUST support a `DeprecationNotice`; ad hoc free-text deprecation is forbidden.
2. One notice model is expressed through schema annotations, contract fields, manifest fields, or paired TSDoc/runtime declarations.
3. A declaration MUST propagate to JSON Schema, generated docs, IDE metadata where applicable, runtime reporting, `deprecation-used`, telemetry eligibility, and `lando doctor`.
4. Aliases and canonical surfaces deprecate independently, but a non-deprecated alias MUST NOT point to a deprecated canonical surface.
5. User warnings deduplicate once per `(surfaceKind, surfaceId)` per process.
6. `removeIn` is release-enforced; due or overdue surfaces block publication.
7. Plugin deprecations use the same schema and propagation rules as core deprecations.
8. Telemetry consumption follows the normal Telemetry disablement and redaction rules (§4.2).

### 18.2 The `DeprecationNotice` schema

`DeprecationNotice` is an Effect Schema in `@lando/sdk`, re-exported by `@lando/core/schema`, and published through the §13.2 artifact set.

| Field | Contract |
|---|---|
| `since` | Required semver that introduced the deprecation. |
| `removeIn` | Optional scheduled removal semver; required once the notice is older than 12 months. |
| `severity` | `info`, `warn`, or `error`; defaults to `warn`. |
| `replacement` | Optional canonical replacement id. |
| `note` | Required actionable user-facing sentence. |
| `docsUrl` | Optional migration or deprecation documentation URL. |
| `ticket` | Optional internal tracking reference, exposed only in verbose diagnostic/reporting surfaces. |

Structural identity for deduplication uses `since`, `removeIn`, and `note`. The schema MUST round-trip without loss and generate `dist/schemas/deprecation-notice.json`.

### 18.3 The `DeprecationService`

`DeprecationService` records use, exposes process summaries, performs `(kind, id)` lookup, and registers notices from core registries, plugin manifests, and schema annotations. `DeprecationUse` carries `kind`, `id`, `notice`, optional `callsite`, `app`, and `plugin`, plus `timestamp`.

The surface-kind vocabulary includes command, flag, arg, tooling task, recipe, recipe prompt, Landofile key, config key, env override, schema, schema field, event, event field, render event, service type, service feature, route filter, provider extension, manifest field, manifest contribution, plugin, public export, and tagged error.

Hot-path rules:

- The service is available at bootstrap level `minimal`; the full registry is populated at `plugins`.
- Repeated `use` calls MUST short-circuit warning/event emission after the first `(kind, id)` while retaining a count.
- `lookup` MUST use a prebuilt keyed index.
- Registration happens only during registry construction and MUST NOT run on a command hot path.
- Deprecation reporting uses late subscriber priority and MUST NOT delay the triggering operation.

`info` and `warn` record and emit without failing. `error` fails use with `DeprecatedSurfaceError`. A contradictory non-deprecated alias fails registration with `DeprecationContradictionError`.

### 18.4 The `deprecation-used` lifecycle event

Every first recorded runtime use publishes typed `deprecation-used` with the `DeprecationUse` payload after recording and before further surface behavior. Registration alone MUST NOT publish it.

Subscribers SHOULD use the late priority band. Subscriber failure is logged and MUST NOT abort deprecation reporting. The renderer owns once-per-process presentation; Telemetry consumes through its standard service rather than direct plugin subscriptions.

### 18.5 Surface deprecation matrix

| Surface kind | Canonical owner | Declaration mechanism |
|---|---|---|
| Built-in command | `LandoCommandSpec` | `deprecated` contract field |
| Plugin command | Plugin command contribution and spec | Manifest plus contract field |
| Top-level alias | `LandoCommandSpec.topLevelAlias` | Alias-scoped notice |
| Namespaced alias | `LandoCommandSpec.aliases[]` | Per-alias notice |
| Command flag | `FlagSpec` | `deprecated` contract field |
| Command arg | `ArgSpec` | `deprecated` contract field |
| Tooling task | Tooling schema | Task `deprecated` field |
| Tooling flag/arg | Tooling schema | Flag/arg `deprecated` field |
| Recipe | `recipe.yml` | Root `deprecated` field |
| Recipe prompt | Recipe prompts | Prompt `deprecated` field |
| Landofile key | Landofile schema | Schema annotation |
| Compose-subset key | Landofile schema | Schema annotation |
| Global config key | Global config schema | Schema annotation |
| Env-var override | Env-override schema | Schema annotation |
| `@lando/sdk` schema | Public schema registry | Whole-schema annotation |
| Schema field | Public schema registry | Field annotation |
| Lifecycle event | Event registry | Tagged-schema annotation |
| Event payload field | Event registry | Field annotation |
| Render event | Renderer event registry | Schema annotation |
| Service type | `ServiceType` registry | `deprecated` contract field |
| Service feature | `ServiceFeature` registry | `deprecated` contract field |
| Route filter | `RouteFilter` registry | `deprecated` contract field |
| Provider extension | Provider-extension schema | Schema annotation |
| Plugin manifest field | Plugin manifest schema | Schema annotation |
| Plugin contribution entry | `provides.<surface>[]` | Manifest `deprecated` field |
| Whole plugin | Plugin manifest root | Manifest `deprecated` field |
| Public TS export | `package.json#exports` surface | TSDoc `@deprecated` plus `markDeprecated` runtime declaration |
| Tagged error class | `@lando/sdk` error registry | TSDoc plus class deprecation metadata |
| Acceptance checklist item | §15.C and §17.9 | Checklist annotation plus adjacent notice |

Registry precedence is schema annotations, then built-in contracts, then loaded plugin manifests. Multiple valid declarations for the same surface are merged. Registry construction MUST use cached registration data and MUST NOT scan on the tooling hot path.

JSON Schema output MUST emit `deprecated: true` and full `x-deprecation` data; draft-07 compatibility MAY prefix the description. Generated docs MUST render from the same registry so runtime and documentation cannot disagree.

### 18.6 Renderer behavior

The renderer emits one warning per `(kind, id)` per process. The warning names the surface, `since`, `removeIn` when present, the actionable note, and optional replacement and docs URL. Repeated uses increment service counts without another warning. `info` notices MAY be summarized once at command completion; warn/error notices are not repeated in the summary.

`--no-deprecation-warnings` and `LANDO_DEPRECATION_WARNINGS=0` suppress only human renderer lines. They MUST NOT suppress recording, `deprecation-used`, telemetry, structured JSON stderr events, or `lando doctor --deprecations`. Diagnostic/config reporting ignores suppression. Deprecations are post-paint and MUST NOT block §8.9.1 first paint.

### 18.7 Removal policy and release-time gates

- `since` is REQUIRED and MUST name a released or pending semver.
- `removeIn` is REQUIRED once a notice is older than 12 months.
- `removeIn` MUST be a future major or minor version; patch removals are forbidden.
- `severity` defaults to `warn`. `info` is advisory. `error` is reserved for the final release before removal and requires at least one prior minor cycle at `warn`.

`scripts/check-deprecations.ts` runs after codegen in §17.1 and through PR lint. If `removeIn` equals the release and the surface remains registered, release fails with `DeprecationStaleError`. If `removeIn` is earlier than the release, release fails with `DeprecationOverdueError`. A notice without `removeIn` older than 12 months produces a soft warning. Removing a surface MUST also remove its notice.

Adding a deprecation requires a canonical registry declaration, a test that triggers it, and migration docs when the change is non-trivial. Removing one requires deleting the surface and notice together, updating tests and generated artifacts, and recording the removal in the relevant changelog.

### 18.8 Test gates

- Schema tests cover `DeprecationNotice`, `DeprecationUse`, and `deprecation-used` round trips and semver/severity constraints.
- Effect tests cover registration, lookup, summary, failure policy, and per-process deduplication.
- CLI tests prove once-only warnings and suppression without loss of recording or events.
- Library tests prove embedding hosts receive typed events and may choose their own presentation policy (§16.6).
- Schema/docs tests prove every annotation produces valid `x-deprecation` data and generated callouts.
- Lint MUST pair public TSDoc `@deprecated` exports with `markDeprecated` and validate removal policy.
- The release gate fails closed on stale or overdue notices.
- Acceptance coverage MUST exercise every matrix surface kind, doctor reporting, suppression semantics, and stale-notice rejection (§15.C).
