# Lando v4 — Architecture Specification (Index)

> **Status:** Living document — the compatibility contract for the v4 build (currently in Beta 1; see [`ROADMAP.md`](./ROADMAP.md)). When code and this spec disagree, the spec wins.
> **Audience:** Lando Core maintainers, plugin authors, contributors building v4 from a clean slate, and embedding hosts integrating `@lando/core` as a library.

This is an architecture-level specification: every public contract (services, schemas, errors, events, commands, manifest keys, and invariants) is named and its rules stated; shapes, bodies, and mechanics live in code and generated reference docs.

The specification lives in nineteen focused parts. Files are canonical; **cross-references use stable `§N` section numbers independent of file numbers**, so a reference such as §4.2 remains valid when parts move. Use the topic lookup to map a section to its part.

The split is almost one section per file, with these principled merges and additions:

- **§1 + §14** share part 01 because mission, tenets, non-goals, and open decisions define the same boundary from opposite sides.
- **§3 + §11** share part 03 because lifecycle events are part of runtime architecture.
- **§16** is filed as part 09, between CLI and plugins, because the library is the CLI's peer imperative shell.
- **§17** is filed as part 15, after the appendices, because build and release engineering operationalize §13 distribution and quality policy.
- **§18** is filed as part 16 because one cross-cutting contract governs deprecation across every public surface.
- **§19** is filed as part 17 because executable guides connect authored documentation to §13 scenario testing.
- **§20** is filed as part 18 because the global app is a cross-cutting host-level app used by routing and shared services.
- **§21** is filed as part 19 because scratch apps are scope-bounded peers to user and global apps with distinct identity and persistence rules.

---

## Read in this order

| # | File | `§N` | Theme |
|---|---|---|---|
| 01 | [`01-mission-and-tenets.md`](./01-mission-and-tenets.md) | §1 + §14 | Defines the product mission, non-negotiable tenets, core ownership boundary, default distribution, non-goals, and decisions still open before GA. |
| 02 | [`02-toolchain.md`](./02-toolchain.md) | §2 | Sets Bun, TypeScript, Effect, schema, dependency, performance, dispatcher, documentation, and package-surface rules. |
| 03 | [`03-architecture.md`](./03-architecture.md) | §3 + §11 | Defines runtime layers, bootstrap levels, core Effect services, imperative shells, redaction, the event taxonomy, subscriber model, and lifecycle ordering. |
| 04 | [`04-pluggability.md`](./04-pluggability.md) | §4 | Catalogs every replaceable abstraction, its service tag and default, selection precedence, manifest registration, and mandatory plugin guarantees. |
| 05 | [`05-runtime-providers.md`](./05-runtime-providers.md) | §5 | Specifies the provider contract, capability negotiation, provider-neutral plans, Compose boundary, error family, bundled providers, and one-provider-per-app limit. |
| 06 | [`06-services.md`](./06-services.md) | §6 | Defines service bases and configuration, mounts, storage, routes, environment, types and features, the canonical catalog, build orchestration, and log sources. |
| 07 | [`07-landofile-and-config.md`](./07-landofile-and-config.md) | §7 | Covers Landofile discovery and merge, expressions and templates, translation, global config, includes, environment overrides, schema publication, and canonical serialization. |
| 08 | [`08-cli-and-tooling.md`](./08-cli-and-tooling.md) | §8 | Defines command identity and dispatch, built-ins, tooling, recipes, rendering, interaction, help, and machine-readable output. |
| 09 | [`09-embedding.md`](./09-embedding.md) | §16 | Defines the Effect-native library API, runtime and app handles, plugin/config policy, scope ownership, programmatic CLI access, testing exports, and compatibility. |
| 10 | [`10-plugins.md`](./10-plugins.md) | §9 | Defines plugin identity, discovery, manifest keys, contribution surfaces, install and loading policy, constrained context, and authoring commands. |
| 11 | [`11-subsystems.md`](./11-subsystems.md) | §10 | Specifies networking, routing, tunnels, trust and downloads, SSH, probes, file sync, setup, diagnostics, host proxy, data movement, managed files, remote sync, and MCP. |
| 12 | [`12-caches-and-persistence.md`](./12-caches-and-persistence.md) | §12 | Catalogs caches and persistent artifacts, encoding and atomicity, managed-file transactions, hot-path budgets, offline state, and `StateStore`. |
| 13 | [`13-testing-and-distribution.md`](./13-testing-and-distribution.md) | §13 | Defines test layers, schema/type/quality gates, synchronized binary and library distribution, CI cadences, release channels, and boundary enforcement. |
| 14 | [`14-appendices.md`](./14-appendices.md) | §15 | Provides provider-neutral terminology, forbidden dependencies, the source-derived acceptance checklist, historical dispatcher rationale, and glossary. |
| 15 | [`15-binary-build-and-release.md`](./15-binary-build-and-release.md) | §17 | Defines release stages, codegen ownership, embedded assets, signing, supply-chain artifacts, self-update, installation, release CI, and shipping criteria. |
| 16 | [`16-deprecation-and-surface-evolution.md`](./16-deprecation-and-surface-evolution.md) | §18 | Defines one deprecation notice and service model, event propagation, surface ownership matrix, renderer behavior, removal policy, and gates. |
| 17 | [`17-executable-tutorials.md`](./17-executable-tutorials.md) | §19 | Defines prose-first executable guides, typed components, scenario context, transcripts, codegen, source maps, lint, recipe README generation, and variants. |
| 18 | [`18-global-app.md`](./18-global-app.md) | §20 | Defines global-app identity and Landofile, plugin contributions, lifecycle and CLI, networking, storage, proxy realization, errors, and non-goals. |
| 19 | [`19-scratch-apps.md`](./19-scratch-apps.md) | §21 | Defines scratch identity and sources, scoped lifecycle, isolation, storage rewriting, routing, CLI and library access, cleanup, errors, and non-goals. |

---

## Topic lookup

If you are looking for a public surface or policy:

| Topic | Part | Section |
|---|---|---|
| Mission, product definition, and architectural tenets | 01 | §1.1 + §1.2 |
| Core ownership boundaries | 01 | §1.3 |
| Default plugins and distribution forms | 01 | §1.4 |
| Product non-goals | 01 | §14.1 |
| Open and deferred decisions | 01 | §14.2 |
| Bun policies and performance budgets | 02 | §2.1 |
| TypeScript policy | 02 | §2.2 |
| Native command dispatcher choice | 02 | §2.3 |
| Effect runtime, schema validation, logging, and docs rules | 02 | §2.4 + §2.5 |
| Forbidden runtime dependencies | 02 | §2.6 |
| `@lando/core` package exports | 02 | §2.7 |
| Runtime layers, dependency direction, and source layout | 03 | §3.1 + §3.3 |
| Bootstrap levels and fast paths | 03 | §3.2 |
| Core Effect service tags | 03 | §3.4 |
| Lifecycle event scopes and names | 03 | §3.5 |
| CLI and embedding imperative shells | 03 | §3.6 |
| Canonical secret and PII redaction | 03 | §3.7 |
| `EventService` operations and history | 03 | §11.1 |
| Event payload schema family | 03 | §11.2 |
| Subscriber priority, selectors, and factories | 03 | §11.3 |
| Standard lifecycle sequence, hot-path events, and subscriber failures | 03 | §11.4 + §11.5 + §11.6 |
| Replaceable abstraction catalog | 04 | §4.2 |
| Implementation selection precedence | 04 | §4.3 |
| Plugin manifest contribution registration | 04 | §4.4 |
| Mandatory abstraction guarantees | 04 | §4.5 |
| `RuntimeProvider` service and capability schema | 05 | §5.3 + §5.4 |
| `AppPlan` and `ServicePlan` schema families | 05 | §5.5 |
| Provider extensions and error family | 05 | §5.6 + §5.7 |
| Bundled providers and multi-provider non-goal | 05 | §5.8 + §5.9 |
| Service bases and common service schema | 06 | §6.1 + §6.2 |
| Artifact build contract | 06 | §6.3 |
| App mounts and mount realization | 06 | §6.4 |
| Storage scopes, labels, and cache volumes | 06 | §6.5 |
| Endpoints, hostnames, routes, and filters | 06 | §6.6 |
| Healthchecks, certificates, and trust injection | 06 | §6.7 + §6.8 |
| Reserved service environment variables and agent context | 06 | §6.9 |
| `ServiceInfo` schema | 06 | §6.10 |
| `ServiceType`, `ServiceFeature`, and `AppFeature` contracts | 06 | §6.11 |
| Canonical service-type catalog and credentials | 06 | §6.12 |
| `BuildOrchestrator`, `BuildPlan`, results, transcripts, and errors | 06 | §6.13 |
| Service log-source contracts | 06 | §6.14 |
| Landofile discovery and file forms | 07 | §7.1 |
| Six-layer Landofile merge | 07 | §7.2 |
| External file loading, expressions, and templates | 07 | §7.3 |
| Top-level Landofile and Compose-subset keys | 07 | §7.4 |
| Config translation contracts and diagnostics | 07 | §7.4.1 |
| Global config keys, root defaults, and pure path resolution | 07 | §7.5 + §7.5.1 |
| Environment override naming | 07 | §7.6 |
| Includes, fragments, lockfile, cache, and security | 07 | §7.7 |
| Schema and generated-reference publication | 07 | §7.8 |
| Canonical Landofile parser and serializer | 07 | §7.8.1 |
| Command kinds and namespaces | 08 | §8.1 |
| Top-level aliases and collision errors | 08 | §8.1.2 |
| Built-in command registry | 08 | §8.2 |
| App config, global config, shell, Bun, open, and MCP commands | 08 | §8.2.1 + §8.2.6 |
| `LandoCommandSpec`, command input, and command errors | 08 | §8.3 |
| Single native dispatch and help projection | 08 | §8.4.1 + §8.4.2 |
| Tooling schemas, steps, expressions, events, and scripts | 08 | §8.5 |
| `ToolingEngine` and compilation pipeline | 08 | §8.6 + §8.7 |
| Recipe manifests, prompts, actions, catalog, and errors | 08 | §8.8 |
| Renderer events, first paint, task trees, keymaps, and notifications | 08 | §8.9 |
| `InteractionService`, prompt schemas, and interaction errors | 08 | §8.10 |
| Machine-readable command envelopes and streams | 08 | §8.11 |
| Library entry points and runtime factory | 09 | §16.2 + §16.3 |
| Library plugin/config policy and scope ownership | 09 | §16.4 + §16.6 |
| Programmatic CLI and testing APIs | 09 | §16.7 + §16.8 |
| Library compatibility and non-goals | 09 | §16.9 + §16.10 |
| Plugin identity, discovery, and manifest schema | 10 | §9.1 + §9.4 |
| Plugin contribution surfaces | 10 | §9.5 |
| Plugin install, loading, trust, and updates | 10 | §9.6 + §9.7 |
| `LandoPluginContext` capabilities | 10 | §9.8 |
| Plugin authoring commands | 10 | §9.10 |
| Networking, routers, tunnels, and host ports | 11 | §10.1 + §10.2 |
| Certificate authority, proxy trust, HTTP, and downloads | 11 | §10.3 |
| SSH identity, sidecar and host agent forwarding, gpg agent | 11 | §10.4 |
| Probe, healthcheck, and scanner contracts | 11 | §10.5 |
| File-sync engine and Mutagen implementation | 11 | §10.6 |
| Setup and host integration | 11 | §10.8 |
| Doctor diagnostics and resilience | 11 | §10.9 |
| Host-proxy protocol and errors | 11 | §10.10 |
| `DataMover`, endpoints, snapshots, and errors | 11 | §10.11 |
| Remote source and dataset contracts | 11 | §10.12 |
| Managed-file ownership, ledger, and errors | 11 | §10.13 |
| MCP service, catalog, transport, and errors | 11 | §10.14 |
| Cache catalog and encodings | 12 | §12.1 + §12.2 |
| Atomic cache writes and persistent artifacts | 12 | §12.3 + §12.4 |
| Managed-file transaction journal and recovery | 12 | §12.4.1 |
| Hot-path and offline-state policies | 12 | §12.5 + §12.6 |
| `StateStore`, buckets, consumers, and plugin access | 12 | §12.7 |
| Test and contract-suite layers | 13 | §13.1 |
| Schema, documentation, type, and PR gates | 13 | §13.2 + §13.4 |
| Distribution forms, CI matrix, and release channels | 13 | §13.5 + §13.7 |
| Boundary gate policy | 13 | §13.8 |
| Provider-neutral vocabulary, forbidden dependencies, acceptance, glossary | 14 | §15 |
| Release pipeline, codegen ownership, and embedded assets | 15 | §17.1 + §17.3 |
| Signing, supply chain, update, and installation | 15 | §17.4 + §17.7 |
| Release workflow and shipping criteria | 15 | §17.8 + §17.9 |
| Deprecation schema, service, event, and surface matrix | 16 | §18.2 + §18.5 |
| Deprecation presentation, removal, and gates | 16 | §18.6 + §18.8 |
| Executable-guide model, components, and scenario runtime | 17 | §19.2 + §19.4 |
| Transcripts, codegen, source maps, and lint | 17 | §19.6 + §19.10 |
| Recipe README and library-guide integration | 17 | §19.13 + §19.14 |
| Guide acceptance and tabbed variants | 17 | §19.15 + §19.16 |
| Global-app identity, Landofile, and plugin contributions | 18 | §20.2 + §20.4 |
| Global service, lifecycle, CLI, networking, and storage | 18 | §20.5 + §20.9 |
| Global proxy realization, error family, and non-goals | 18 | §20.10 + §20.14 |
| Scratch identity, roots, sources, and service | 19 | §21.2 + §21.5 |
| Scratch lifecycle, isolation, storage, and routes | 19 | §21.6 + §21.9 |
| Scratch CLI, registry, library mode, and errors | 19 | §21.10 + §21.14 |
| Scratch non-goals | 19 | §21.15 |

---

## Conventions

- Cross-references use stable `§N` section numbers, not file numbers; section numbers are independent of part numbers.
- Schemas are named in the spec and published canonically from `@lando/sdk` and `@lando/core/schema` (§7.8).
- **MUST**, **MUST NOT**, **SHOULD**, and **MAY** carry RFC 2119 weight.

## Canonical Surface Governance

Public surfaces MUST have one canonical registry. Narrative sections may explain a surface, but they must not introduce commands, service tags, schemas, events, exports, recipe actions, or plugin contribution surfaces absent from the relevant canonical registry.

Canonical owners:

- Built-in commands, aliases, flags, args, bootstrap levels, recipe post-init eligibility, and command docs metadata: the `LandoCommandSpec` registry (§8.2, §8.3).
- Public schemas, event payload schemas, tagged errors, and plugin-facing contract metadata: the `@lando/sdk` schema, error, and event registries (§7.8, §13.2).
- Core service tags and public service exports: §3.4 plus `@lando/core/services` (§16.2).
- Secret and PII redaction: `@lando/sdk/secrets` owns the value layer, pattern-class catalog, `secrets`/`telemetry`/`transcript` profiles, and `[redacted]` sentinel, surfaced through `RedactionService` (§3.7, §3.4). This invariant is non-replaceable, has no `redactors:` plugin surface (§4.2), composes into every sensitive emitter, and is protected by the §13.4 boundary gate.
- Package entry points and public library exports: `package.json#exports` plus the API report gate (§2.7, §16.2, §13.4).
- Recipe action types and the `postInit.command` allowlist: generated from command metadata (§8.8.8).
- Acceptance checklist items: stable ids mapped to tests and public surfaces (§15, §17.9).
- Deprecation notices: schema annotations, contract fields, manifest fields, or TSDoc tags per §18.5, merged by `DeprecationService` (§18.3) and published as `dist/schemas/deprecation-notice.json` (§18.2).
- Executable-guide vocabulary: prop schemas, `GuideFrontmatter`, `ScenarioProps`, `MatcherSchema`, `Transcript`/`TranscriptFrame`, `TabAxis`/`TabAxisValue`, `TabsProps`/`TabProps`, and redactions belong to `@lando/sdk/docs/components` and `@lando/sdk/docs/redactions` (§19.3, §19.6, §19.16). JSX/Astro runtime implementations and Starlight integration belong to `@lando/core/docs/components`; `ScenarioContext` belongs to `@lando/core/testing` (§19.4, §16.8).

Surface change checklist:

- Add or update the canonical registry entry first.
- Update generated docs, codegen inputs, and this topic lookup when the surface is user-visible.
- Add or update schema, API, command, event, and service drift gates in §13.4 when the change creates a new surface class.
- Add a library/API test for public exports and a CLI/e2e test for user-visible commands.
- Update the acceptance checklist when the surface affects release readiness.

When the spec changes, edit the relevant part directly and update this index. There is no re-split step.
