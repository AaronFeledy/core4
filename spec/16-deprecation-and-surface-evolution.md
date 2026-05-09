# Lando v4 — Deprecation and Surface Evolution

> **Part 16 of 17** · [Index](./README.md)
> **Read next:** [17 Executable Tutorials](./17-executable-tutorials.md)

This part defines how Lando v4 deprecates public surfaces — built-in commands, plugin contributions, Landofile and global-config keys, schemas, public exports, lifecycle events, recipes, tagged errors — across the lifetime of the v4 series. Deprecation is a cross-cutting concern: every part of the spec that describes a public surface refers back here for the *how*, while §18 owns the *what*.

The goal is that every deprecation in v4 follows the same machine-readable contract, propagates uniformly to JSON Schema, generated docs, runtime warnings, telemetry, and `lando doctor`, and is removed on a release-pipeline-enforced schedule. There is no surface in v4 — none — that is allowed to deprecate ad hoc.

Covered here: the deprecation principles, the canonical `DeprecationNotice` schema (one shape, every surface), the `DeprecationService` Effect interface and its hot-path performance rules, the typed `deprecation-used` lifecycle event, the surface-by-surface deprecation matrix that maps every public surface to the mechanism it uses to declare deprecation (schema annotation, contract field, manifest field, JSDoc tag), the renderer's once-per-process warning behavior and opt-out rules, the semver-bound removal policy and the release-pipeline `removeIn` enforcement gate, and the test/lint gates that keep all of this honest.

---

## 18. Deprecation and Surface Evolution

### 18.1 Principles

Every public surface in v4 is deprecable. The mechanism varies by surface kind, but the *contract* is uniform.

1. **Every public surface MUST be deprecable.** Built-in commands, plugin contributions, Landofile and global-config keys, schemas, public exports, lifecycle events, recipes, tagged errors, render events, route filters, service types, service features, plugin sources, init sources, doctor checks — every entry in the canonical surface governance list (README §"Canonical Surface Governance") MUST support a `DeprecationNotice`.

2. **Deprecation is machine-readable.** The deprecation declaration is structured data — never a free-text comment. The `DeprecationNotice` schema (§18.2) carries `since`, `removeIn`, `severity`, `replacement`, `note`, and optional `docsUrl` and `ticket` fields.

3. **One model, four expression mechanisms.** The single `DeprecationNotice` schema is expressed across surfaces through four mechanisms:
   - **Schema annotations** for data surfaces (Landofile keys, global config, schemas in `@lando/sdk`).
   - **Contract fields** for behavior surfaces (`LandoCommandSpec.deprecated`, `FlagSpec.deprecated`, `ServiceType.deprecated`, etc.).
   - **Manifest fields** for plugin contributions (`provides.<surface>[].deprecated`, manifest-root `deprecated`).
   - **TSDoc `@deprecated` tags** for public TypeScript exports, paired with a runtime `markDeprecated()` wrap.

4. **Uniform propagation.** Every deprecation declaration produces, automatically:
   - A JSON Schema `deprecated: true` annotation plus an `x-deprecation` extension carrying the full notice (§18.5).
   - A "Deprecated since X" callout in the generated docs (Starlight site; §2.4).
   - An IDE hover (TSDoc → tsserver → editor).
   - A runtime `message.warn` the first time the surface is used per process (§18.6).
   - A `deprecation-used` lifecycle event (§18.4) that telemetry and `lando doctor` consume.

5. **Aliases and deprecation are orthogonal.** A canonical command may be deprecated; an alias may be deprecated independently of its canonical; a non-deprecated alias of a deprecated canonical is rejected at registration as `DeprecationContradictionError`.

6. **Warnings dedupe per process.** The renderer emits each unique `(surfaceKind, surfaceId)` deprecation warning at most once per process. Tooling tasks that loop over a deprecated step do not flood the user.

7. **`removeIn` is enforced.** The release pipeline (§17) reads every `DeprecationNotice` in the codebase and bundled plugins and *fails the release* if a notice's `removeIn` matches the version being released and the surface is still present, or if a notice's `removeIn` is in the past and the notice is still on disk.

8. **Telemetry-eligible.** `deprecation-used` events are eligible for the core telemetry sink (§4.2 `Telemetry`) and respect the same disablement rules as every other telemetry event.

9. **Plugins follow the same contract.** A plugin manifest MAY declare `deprecated:` on the manifest root (the whole plugin is deprecated) or on any single `provides.<surface>[]` entry (one contribution is deprecated). Plugin-side deprecations propagate identically to core deprecations.

### 18.2 The `DeprecationNotice` schema

The canonical deprecation contract is one Effect Schema, defined in `@lando/sdk` and re-exported through `@lando/core/schema`.

```ts
export const DeprecationSeverity = Schema.Literal("info", "warn", "error");
export type DeprecationSeverity = Schema.Schema.Type<typeof DeprecationSeverity>;

export const DeprecationNotice = Schema.Struct({
  /** Semver of the version that introduced the deprecation, e.g. "4.2.0". */
  since: Schema.String,

  /** Semver of the version the surface will be removed in, e.g. "5.0.0".
   *  Optional only for "soft" deprecations whose removal is not yet scheduled;
   *  the release pipeline (§18.7) requires every notice older than 12 months
   *  to carry a concrete removeIn. */
  removeIn: Schema.optional(Schema.String),

  /** Default "warn". "info" suppresses the renderer line (still recorded);
   *  "error" causes the surface use to fail with DeprecatedSurfaceError. */
  severity: Schema.optionalWith(DeprecationSeverity, { default: () => "warn" as const }),

  /** Canonical id of the replacement surface — a command id, a Landofile
   *  key path, an export name, etc. Format depends on surface kind. */
  replacement: Schema.optional(Schema.String),

  /** User-facing one-liner. Rendered in CLI, JSON Schema description,
   *  generated docs callout, and editor hover. MUST be actionable. */
  note: Schema.String,

  /** Optional link to a deprecation guide or migration page on the docs site. */
  docsUrl: Schema.optional(Schema.String),

  /** Internal: a tracking issue / PR / ADR. Surfaced only in `lando doctor
   *  --verbose` and in the deprecation report; not shown to end users. */
  ticket: Schema.optional(Schema.String),
}).annotations({
  identifier: "DeprecationNotice",
  title: "Deprecation Notice",
  description: "A structured deprecation declaration attached to a public surface.",
});
export type DeprecationNotice = Schema.Schema.Type<typeof DeprecationNotice>;
```

`DeprecationNotice` instances are compared by structural identity. Two `DeprecationNotice`s with the same `since`, `removeIn`, and `note` are interchangeable for dedup purposes.

The schema is round-trip tested in §13.2 alongside every other public schema. JSON Schema output is generated through the standard pipeline (§17.2 codegen) and embedded in the published `dist/schemas/deprecation-notice.json` artifact.

### 18.3 The `DeprecationService`

`DeprecationService` is a core Effect service that records deprecated-surface usage, emits the `deprecation-used` event, and answers lookups from `lando doctor`, `lando config`, and the generated docs build.

```ts
export const DeprecationSurfaceKind = Schema.Literal(
  "command",                // built-in or plugin command id (canonical or alias)
  "flag",                   // command flag name (scoped to a command id)
  "arg",                    // command positional arg name (scoped to a command id)
  "tooling-task",           // tooling task canonical id (e.g. "app:composer")
  "recipe",                 // recipe id (e.g. "drupal-11")
  "recipe-prompt",          // prompt name within a recipe
  "landofile-key",          // dotted path into Landofile (e.g. "services.web.legacy")
  "config-key",             // dotted path into global config
  "env-override",           // env-var override name
  "schema",                 // schema identifier (e.g. "RoutePlan")
  "schema-field",           // field path inside a schema
  "event",                  // lifecycle event name (e.g. "pre-start")
  "event-field",            // field inside an event payload schema
  "render-event",           // render event name (e.g. "table.row")
  "service-type",           // service type id (e.g. "mailhog")
  "service-feature",        // service feature id
  "route-filter",           // route filter id
  "provider-extension",     // provider extension key
  "manifest-field",         // plugin-manifest field path
  "manifest-contribution",  // a single provides[] entry
  "plugin",                 // a whole plugin (by manifest id)
  "export",                 // a public TS export (by entry-point + name)
  "tagged-error",           // a tagged-error class (by _tag)
);
export type DeprecationSurfaceKind = Schema.Schema.Type<typeof DeprecationSurfaceKind>;

export const DeprecationUse = Schema.Struct({
  kind: DeprecationSurfaceKind,
  id: Schema.String,                          // surface id; format depends on kind
  notice: DeprecationNotice,
  callsite: Schema.optional(Schema.String),   // command id, plugin id, or app id triggering the use
  app: Schema.optional(Schema.String),
  plugin: Schema.optional(Schema.String),
  timestamp: Schema.DateTimeUtc,
});
export type DeprecationUse = Schema.Schema.Type<typeof DeprecationUse>;

export class DeprecationService extends Context.Service<DeprecationService, {
  /** Record a deprecated surface was just used. The service dedupes per
   *  (kind, id) per process — repeated calls in a loop produce a single warn. */
  readonly use: (use: DeprecationUse) => Effect.Effect<void>;

  /** Read the recorded uses for the current process. Consumed by
   *  `lando doctor`, `lando config`, and the renderer's session summary. */
  readonly summary: () => Effect.Effect<ReadonlyArray<DeprecationUse>>;

  /** Look up a registered notice by surface kind and id. Resolves against:
   *  built-in registries (commands, schemas, events), plugin manifests, and
   *  the schema-annotation walk performed at registration. Returns Option.none
   *  when the surface is not deprecated. */
  readonly lookup: (
    kind: DeprecationSurfaceKind,
    id: string,
  ) => Effect.Effect<Option.Option<DeprecationNotice>>;

  /** Internal: register a notice from a registry source. Called by the
   *  command registry, the plugin loader, and the schema-annotation walker
   *  at startup. Plugin code MUST NOT call this directly. */
  readonly register: (
    source: "core" | "plugin" | "schema-walk",
    kind: DeprecationSurfaceKind,
    id: string,
    notice: DeprecationNotice,
  ) => Effect.Effect<void>;
}>()("@lando/core/DeprecationService") {}
```

**Hot-path performance rules:**

- `DeprecationService` lives at bootstrap level `minimal` (§3.2) so that level-`tooling` and level-`none` code paths can record uses. The internal registry index is empty at level `minimal` and populated at level `plugins`.
- `use` MUST short-circuit to a no-op when the dedup table indicates this surface has already produced a warn this process. The check is a single Map lookup; recording the use updates a per-(kind,id) counter without re-emitting.
- `lookup` is O(1) against the registry Map.
- `register` is called once per surface at registration time; it MUST NOT be called on any hot path. Subscriber priority for `deprecation-used` is `late` (§11.3) — deprecation reporting MUST NOT delay the lifecycle step that triggered it.

**Failure handling:**

- `severity: "warn"` and `severity: "info"` never fail. The service records and emits.
- `severity: "error"` raises `DeprecatedSurfaceError` from `use`. The lifecycle step that called `use` propagates the error per the normal subscriber-failure rules (§11.6).

`DeprecatedSurfaceError` and `DeprecationContradictionError` are tagged errors in the `@lando/sdk` error catalog (§13.2):

```ts
export class DeprecatedSurfaceError extends Schema.TaggedError<DeprecatedSurfaceError>()(
  "DeprecatedSurfaceError",
  {
    kind: DeprecationSurfaceKind,
    id: Schema.String,
    notice: DeprecationNotice,
  },
) {}

export class DeprecationContradictionError extends Schema.TaggedError<DeprecationContradictionError>()(
  "DeprecationContradictionError",
  {
    canonicalId: Schema.String,
    aliasId: Schema.String,
    canonicalNotice: DeprecationNotice,
  },
) {}
```

`DeprecationContradictionError` is raised at command-registration time when a non-deprecated alias points at a deprecated canonical (principle 5 in §18.1).

### 18.4 The `deprecation-used` lifecycle event

Every recorded deprecation use publishes a typed `deprecation-used` event through `EventService` (§11). The event payload is the same `DeprecationUse` schema from §18.3.

```ts
export const DeprecationUsedEvent = Schema.TaggedStruct("deprecation-used", {
  use: DeprecationUse,
});
export type DeprecationUsedEvent = Schema.Schema.Type<typeof DeprecationUsedEvent>;
```

Event taxonomy entry (added to the §3.5 table): `Cross-cutting | deprecation-used | published whenever a registered deprecated surface is used at runtime`.

The event fires AFTER the deprecation has been recorded by the service (so subscribers see a stable summary) and BEFORE the surface's own behavior runs further. Subscriber rules:

- Default subscriber priority band is `late` (§11.3). Plugins SHOULD NOT subscribe at `critical` or `early` because deprecation reporting is intentionally non-blocking.
- Subscriber failures are logged at warn level and do not abort. Even if a telemetry sink throws, deprecation reporting continues.
- The renderer's subscriber emits `message.warn` on the first event per `(kind, id)` per process; subsequent events for the same `(kind, id)` are silently absorbed (still recorded by the service, but not re-emitted).
- Plugin telemetry sinks consume the event via the standard `Telemetry` service (§4.2); they do not subscribe directly. This keeps the disablement contract uniform.

The `deprecation-used` event is published only when a deprecated surface is actually used at runtime. There is no implicit `deprecation-used` event published at startup just because a surface is registered as deprecated.

### 18.5 Surface deprecation matrix

Each row is the canonical mechanism a surface uses to declare a deprecation. Where two mechanisms apply (e.g., a plugin contributes a Landofile schema fragment that needs both manifest-field and schema-annotation deprecation), each is independently valid; the registry merges them.

| Surface kind | Owner / canonical registry | Mechanism | Concrete shape |
|---|---|---|---|
| Built-in command | `LandoCommandSpec` registry (§8.2/§8.3) | Contract field | `LandoCommandSpec.deprecated?: DeprecationNotice` |
| Plugin command | Plugin manifest `provides.commands[]` (§9.4) | Manifest field + contract field | `provides.commands[].deprecated:` (manifest) and the same on the spec |
| Top-level alias | `LandoCommandSpec.topLevelAlias` | Alias-scoped notice | When `topLevelAlias` is the object form, `topLevelAlias.deprecated?: DeprecationNotice` |
| Namespaced alias | `LandoCommandSpec.aliases[]` | Per-alias notice | `aliases[]` accepts the union `string \| { name: string; deprecated?: DeprecationNotice }` |
| Command flag | `FlagSpec` (§8.3) | Contract field | `FlagSpec.deprecated?: DeprecationNotice` |
| Command arg | `ArgSpec` (§8.3) | Contract field | `ArgSpec.deprecated?: DeprecationNotice` |
| Tooling task | Tooling YAML schema (§8.5) | YAML field | `tooling.<name>.deprecated:` |
| Tooling flag/arg | Tooling YAML schema (§8.5.1) | YAML field | `tooling.<name>.flags.<flag>.deprecated:` |
| Recipe | `recipe.yml` (§8.8.3) | YAML field | `recipe.yml#deprecated:` |
| Recipe prompt | `recipe.yml` prompts (§8.8.5) | YAML field | `recipe.yml#prompts[].deprecated:` |
| Landofile key | Landofile schema (§7.4) | Schema annotation | `Schema.annotations({ deprecated: <DeprecationNotice> })` on the field |
| Compose-subset key | Landofile schema (§7.4) | Schema annotation | Same — annotated on the schema entry; the obsolete `version:` key is the worked example |
| Global config key | Global config schema (§7.5) | Schema annotation | Same |
| Env-var override | Env-override schema (§7.6) | Schema annotation | Same |
| `@lando/sdk` schema | Schema (§7.8) | Schema annotation | Annotated on the `Schema.Struct(...)` itself for whole-schema deprecation |
| Schema field | Schema (§7.8) | Schema annotation | Annotated on the individual field |
| Lifecycle event | Event payload schema (§11.2) | Schema annotation | Annotated on the `Schema.TaggedStruct(...)` |
| Event payload field | Event payload schema (§11.2) | Schema annotation | Annotated on the individual field |
| Render event | Renderer event schema (§8.9) | Schema annotation | Same |
| Service type | `ServiceType` definition (§6.11) | Contract field | `ServiceType.deprecated?: DeprecationNotice` |
| Service feature | `ServiceFeature` definition (§6.11) | Contract field | `ServiceFeature.deprecated?: DeprecationNotice` |
| Route filter | `RouteFilter` definition (§6.6) | Contract field | `RouteFilter.deprecated?: DeprecationNotice` |
| Provider extension | Provider-extension schema (§5.6) | Schema annotation | Same |
| Plugin manifest field | Plugin manifest schema (§9.4) | Schema annotation | Same |
| Plugin contribution entry | Plugin manifest `provides.<surface>[]` (§9.4) | Manifest field | `provides.<surface>[].deprecated:` |
| Whole plugin | Plugin manifest root (§9.4) | Manifest field | `manifest.deprecated:` |
| Public TS export | `package.json#exports` entry (§2.7) | TSDoc tag + runtime wrap | `/** @deprecated since 4.2.0 — use Y; remove in 5.0.0 */` AND `export const x = markDeprecated(notice, impl);` |
| Tagged error class | `@lando/sdk` error registry (§13.2) | TSDoc tag + class metadata | TSDoc + `static readonly deprecation: DeprecationNotice` |
| Acceptance checklist item | §15.C / §17.9 | Checklist note | The checklist line carries `(deprecated since X — remove in Y)` and the checked item has a `DeprecationNotice` adjacent in source |

The registry is built at startup by walking three sources, in this order:

1. **Schema-annotation walk.** Every public schema in `@lando/sdk` is traversed; fields and structs carrying a `deprecated` annotation register a notice keyed by their schema-id + dotted field path.
2. **Built-in contract walk.** The `LandoCommandSpec` registry, `ServiceType` registry, `ServiceFeature` registry, and `RouteFilter` registry are scanned for `deprecated` fields.
3. **Plugin-manifest walk.** For each loaded plugin, the manifest root and every `provides.<surface>[]` entry are scanned. Plugin-contributed schemas register through step 1 once the schema is loaded.

The walk is cached in the `plugin-command` and `app-plugin` indexes (§12.1) so it does not run on the tooling fast path. The deprecation registry is a derived view over those caches and is populated lazily on first call to `DeprecationService.lookup`.

**JSON Schema propagation.** The schema-to-JSON-Schema converter (§7.8 / §17.2 codegen) reads the `deprecated` annotation and emits both:

- `deprecated: true` (standard JSON Schema draft 2019-09+; falls back to a `description:` prefix `[DEPRECATED] ` for draft-07 editors that do not understand the keyword).
- `x-deprecation: { since, removeIn, severity, replacement, note, docsUrl }` for editors that want richer hover content.

**Generated-docs propagation.** The Starlight site (§2.4) renders a deprecation callout on every entry whose canonical record carries a `DeprecationNotice`. The callout is shaped:

```
⚠️  Deprecated since 4.2.0 — will be removed in 5.0.0.
    <note>
    Replacement: <replacement>
    See: <docsUrl>
```

The callout is generated from the same registry walk that powers the runtime, so docs and runtime never disagree.

### 18.6 Renderer behavior

The renderer is the only component that surfaces deprecation to the end user. The contract:

- On the first `deprecation-used` event for a unique `(kind, id)` per process, the renderer emits a `message.warn` whose body is:
  ```
  Deprecated: <id> (since <since>; remove in <removeIn>). <note>
  ```
  followed by `Replacement: <replacement>` on a second line when `replacement` is set, and `Docs: <docsUrl>` on a third line when `docsUrl` is set.
- Subsequent events for the same `(kind, id)` increment the per-(kind, id) counter and do not re-emit.
- At end of run, if any `severity: "info"` deprecations fired, the renderer emits a single `message.info` summary line: `N deprecation notices recorded — run \`lando doctor --deprecations\` for details.` `severity: "warn"` and `"error"` deprecations are not summarized (they were already shown).
- `--no-deprecation-warnings` flag and `LANDO_DEPRECATION_WARNINGS=0` env suppress the per-(kind,id) renderer line. They do not suppress recording, the lifecycle event, telemetry, or `lando doctor` output. CI pipelines that need clean output during a planned migration window are the intended consumers.
- `lando doctor --deprecations` and `lando config --format yaml` ignore the suppression flag entirely. Their output always includes deprecations.
- The JSON renderer (§8.9) emits deprecations as structured `deprecation-used` events on stderr alongside the typed result on stdout. The structured form is the intended consumer for CI deprecation-tracking pipelines.

The first-paint contract (§8.9.1) is unaffected: deprecations are post-paint and never block the banner.

### 18.7 Removal policy and release-time gates

The release pipeline (§17) treats `removeIn` as a hard gate.

**Authoring rules:**

- `since` is REQUIRED on every `DeprecationNotice`. It MUST match a released or pending semver.
- `removeIn` is REQUIRED for any notice older than 12 months. The release pipeline reports a "soft" warning during stages 1–4 if a notice with no `removeIn` is older than 12 months by `since` date.
- `removeIn` MUST be a future major or minor version. Patch removals are forbidden by semver and rejected at lint.
- `severity` defaults to `"warn"`. Authors choose `"info"` only when the surface is genuinely advisory and the user does not need to act yet. `"error"` is reserved for the final release before removal — the user has had at least one minor cycle of `"warn"` first.

**Release pipeline enforcement (added to §17.1):**

- A new orchestrator script, `scripts/check-deprecations.ts`, runs immediately after codegen (§17.2). It loads every `DeprecationNotice` in the codebase and bundled plugins via the same registry walk used at runtime (§18.5).
- If any notice's `removeIn` equals the version being released AND the corresponding surface is still present in the source tree, the build fails with `DeprecationStaleError` and prints the offending `(kind, id, removeIn)` triplets.
- If any notice's `removeIn` is *less than* the version being released, the build fails with `DeprecationOverdueError`. This catches forgotten removals from prior majors.
- A surface is "still present" if its registry walk still returns it. Removing the surface MUST also remove the `DeprecationNotice` (the notice is dead-weight after removal).
- The check is also wired into `bun run codegen:check` so CI catches the issue before tagging the release.

**Surface change checklist (extension to the README's existing list):**

- When *adding* a deprecation: add the `DeprecationNotice` to the canonical registry entry, add or update an end-to-end test that triggers the warning, add a docs migration page when the migration is non-trivial.
- When *removing* a deprecated surface: delete the surface, delete the `DeprecationNotice` declaration, delete the end-to-end test that triggered the warning, update the JSON Schema and generated docs (codegen drift gate enforces this), update the surface-removal note in the relevant `CHANGELOG.md`.

### 18.8 Test gates

Tests for deprecation-related behavior live alongside the existing test layers (§13.1):

- **Unit:** round-trip encode/decode for `DeprecationNotice`, `DeprecationUse`, `DeprecationUsedEvent` schemas. Validation of every legal/illegal combination of `severity`, `since`, `removeIn`.
- **Effect service:** `DeprecationService` use/summary/lookup against a `TestDeprecationService` that does not publish to the real event bus. Dedup behavior verified across loops.
- **CLI:** running a command that triggers a deprecated flag emits `message.warn` exactly once per `(kind, id)` per process; running the same flag in a tooling loop emits exactly once.
- **Library API:** an embedding host that uses a deprecated public export receives a `deprecation-used` event on its subscribed stream and the host can decide to re-emit, suppress, or hard-fail (the contract for hosts is documented in §16.6).
- **Schema gate (§13.2):** every `DeprecationNotice` in the codebase round-trips through schema decode without loss; every annotated schema produces a JSON Schema with a valid `x-deprecation` extension.
- **Lint gate (§13.4):** every TS export carrying a TSDoc `@deprecated` tag MUST be wrapped with `markDeprecated(notice, impl)`. The lint rule walks AST and asserts the wrap. The check is part of `bun run lint:deprecations` and is wired into the merge gate.
- **`removeIn` gate (§18.7):** as described above; runs in the build pipeline, fails closed.
- **Acceptance checklist (§15.C):** new items:
  - Every surface kind in §18.5 has at least one end-to-end test exercising deprecation.
  - The `removeIn` enforcement gate fails the build when a stale notice is committed.
  - `--no-deprecation-warnings` suppresses renderer output without affecting recording, the event, or `lando doctor`.
  - `lando doctor --deprecations` lists every recorded deprecation from the current run with `(kind, id, since, removeIn, replacement)` columns.

---
