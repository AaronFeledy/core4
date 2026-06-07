# PRD: MVP-01 — SDK contracts (`@lando/sdk`)

## Introduction

`@lando/sdk` is the API-stable surface of Lando v4. Per [`spec/ROADMAP.md`](../../spec/ROADMAP.md) Phasing principle 1, *anything* that ends up in `@lando/sdk` is semver-stable from the moment it ships in MVP — there is no "we can fix it later". This PRD covers the schemas, tagged errors, lifecycle event payloads, and Effect service tags that Phase 1 needs to ship and lock.

Today (Phase 0), the SDK is mostly type stubs:

- [`sdk/src/schema/index.ts`](../../sdk/src/schema/index.ts) declares branded primitives but no full schema.
- [`sdk/src/services/index.ts`](../../sdk/src/services/index.ts) declares `Context.Tag` shapes whose interfaces reference types that don't all exist yet.
- [`sdk/src/errors/index.ts`](../../sdk/src/errors/index.ts) and [`sdk/src/events/index.ts`](../../sdk/src/events/index.ts) are barrels.

This PRD turns those stubs into real, frozen contracts.

## Goals

- Ship the full Effect Schema, tagged errors, lifecycle event payloads, and service tags that the Phase 1 deliverable list (roadmap §"SDK contracts shipped") names.
- Every shape exported from `@lando/sdk` has a derived JSON Schema available (even if Schema-publication automation comes later).
- The contract is dogfood-tested: at least one consumer in `@lando/core` or `@lando/core/testing` round-trips through every tagged error and every lifecycle event published by `app:start`/`app:stop`.
- `import {…} from '@lando/sdk'`, `'@lando/sdk/schema'`, `'@lando/sdk/errors'`, `'@lando/sdk/events'`, `'@lando/sdk/services'`, `'@lando/sdk/test'` all resolve and type-check.

## User Stories

### US-001: Lock `BootstrapLevel` schema export from SDK

**Description:** As a plugin author, I need a single, semver-stable `BootstrapLevel` literal exported from `@lando/sdk/schema` so I can declare the bootstrap depth my command needs without depending on `@lando/core` internals.

**Acceptance Criteria:**
- [ ] Failing test in `sdk/test/schema/bootstrap.test.ts` asserts that `BootstrapLevel` is a `Schema.Literal` containing exactly `none | minimal | plugins | commands | tooling | provider | global | scratch | app`, and that an unknown literal fails decoding with a structured `ParseError`.
- [ ] Test passes after `BootstrapLevel` is exported from `sdk/src/schema/index.ts` (re-exported from `core/src/runtime/bootstrap.ts` is acceptable as long as `@lando/sdk/schema` is the canonical import path).
- [ ] `BOOTSTRAP_RANK` exported alongside, with a frozen ordering test that fails if any rank value changes.
- [ ] Typecheck/lint/whole-workspace tests pass.

### US-002: Ship `AppRef`, `AppPlan`, `ServicePlan` schemas

**Description:** As `@lando/core`, I need full Effect Schemas for `AppRef`, `AppPlan`, and `ServicePlan` so the planner and providers consume a shared, validated shape — not a structurally-typed interface.

**Acceptance Criteria:**
- [ ] Failing test in `sdk/test/schema/app-plan.test.ts` decodes a fixture matching the minimal MVP shape (one app, one node service, one postgres service, one mount, endpoints) and asserts every required field is present in the decoded value.
- [ ] Test asserts that decoding rejects: unknown `serviceType`, missing `appId`, missing `services` array, and any field marked required in the spec.
- [ ] `AppRef` schema includes the fields enumerated in `spec/03-architecture.md` (at minimum: `appId`, `landofileDir`, `landofileShape`).
- [ ] `AppPlan` schema includes `appRef`, `services` (array of `ServicePlan`), `mounts`, `endpoints`, plus a `providerId` discriminator pointing at the chosen provider.
- [ ] `ServicePlan` schema includes `serviceName`, `serviceType` (literal union for MVP: `node | postgres`), `image`, `ports`, `environment`, `volumes`, `dependsOn`.
- [ ] Test passes after schemas are added to `sdk/src/schema/`.
- [ ] Typecheck/lint/whole-workspace tests pass.

### US-003: Ship `ProviderCapabilities` schema (full shape)

**Description:** As a provider author, I need the *full* `ProviderCapabilities` schema in MVP — even though only one capability is exercised — so the contract doesn't change in Alpha 1 when more providers ship.

**Acceptance Criteria:**
- [ ] Failing test in `sdk/test/schema/provider-capabilities.test.ts` asserts the schema contains every field listed in `spec/05-runtime-providers.md` capability matrix (e.g. `bindMountPerformance`, `sharedCrossAppNetwork`, `copyOnWriteAppRoot`, etc.).
- [ ] Test asserts decoding of a `provider-lando` fixture with `bindMountPerformance: "native"` and a `provider-docker` fixture with `bindMountPerformance: "slow"`.
- [ ] Required vs optional fields match the spec exactly — defaults must come from decode, not from caller code.
- [ ] Test passes after schema is added to `sdk/src/schema/`.
- [ ] Typecheck/lint/whole-workspace tests pass.

### US-004: Ship landofile parse-input schemas

**Description:** As `@lando/core`, I need a frozen schema for the parsed Landofile shape (`LandofileShape`) and `GlobalConfig` so the LandofileService and ConfigService work against a stable contract.

**Acceptance Criteria:**
- [ ] Failing test in `sdk/test/schema/landofile.test.ts` decodes a minimal MVP Landofile (one app name, one service block, basic Compose-subset keys: `image`, `ports`, `environment`, `volumes`, `command`, `dependsOn`) and asserts every required field is present.
- [ ] Test asserts decoding *rejects* Compose keys outside the MVP allowlist with a `LandofileValidationError` that includes the rejected key in its message.
- [ ] `GlobalConfig` schema covers: `userDataRoot`, `userConfRoot`, `defaultProviderId`, `telemetry.enabled` (with default false at MVP).
- [ ] Test passes after schemas are added to `sdk/src/schema/`.
- [ ] Typecheck/lint/whole-workspace tests pass.

### US-005: Ship the five MVP-mandated tagged errors

**Description:** As a plugin author or library consumer, I need stable, untyped-erasure-resistant tagged errors for the failure modes Phase 1 publishes.

**Acceptance Criteria:**
- [ ] Failing test in `sdk/test/errors/tagged-errors.test.ts` constructs each of these errors (using the Effect `TaggedError` pattern) and asserts both the `_tag` discriminator and the structured payload:
  - `LandoRuntimeBootstrapError`
  - `ProviderCapabilityError`
  - `LandofileParseError`
  - `PluginLoadError`
  - `NoProviderInstalledError`
- [ ] Each error has the payload fields needed for downstream rendering (e.g. `LandofileParseError` carries `{ filePath, message, line?, column? }`; `ProviderCapabilityError` carries `{ providerId, capability, requiredValue, actualValue }`).
- [ ] Tests assert that `Effect.failCause` paths preserve the `_tag` after `Effect.runPromiseExit`.
- [ ] Test passes after errors are added to `sdk/src/errors/`.
- [ ] Typecheck/lint/whole-workspace tests pass.

### US-006: Ship lifecycle event payload schemas (8–10 events for start/stop)

**Description:** As an event subscriber (plugins, telemetry, future renderer), I need frozen payload shapes for the lifecycle events `app:start` / `app:stop` publish, per `spec/03-architecture.md` §3.5.

**Acceptance Criteria:**
- [ ] Failing test in `sdk/test/events/app-lifecycle.test.ts` asserts schemas exist and decode for each of:
  - `pre-app-start`, `post-app-start`
  - `pre-app-stop`, `post-app-stop`
  - `pre-service-start`, `post-service-start`
  - `pre-service-stop`, `post-service-stop`
  - `pre-build`, `post-build`
- [ ] Each payload schema includes: `appRef`, `serviceName?` (services-scoped events only), `providerId`, `timestamp`.
- [ ] Each event has a literal `eventName` field that pins the discriminator.
- [ ] Test passes after schemas are added to `sdk/src/events/`.
- [ ] Typecheck/lint/whole-workspace tests pass.

### US-007: Ship Effect service tags with frozen interface shapes

**Description:** As a plugin author, I need the Effect Service tags (Context.Tag class-extending pattern) for every service Phase 1 ships. Their *shapes* — method names and Effect signatures — are semver-stable; Live Layer impls live in `@lando/core`.

**Acceptance Criteria:**
- [ ] Failing test in `sdk/test/services/tags.test.ts` asserts each tag below is exported, is a `Context.Tag`, and has the documented method names with Effect-typed return signatures:
  - `Logger`
  - `EventService`
  - `RuntimeProvider`
  - `RuntimeProviderRegistry`
  - `ConfigService`
  - `LandofileService`
  - `PluginRegistry`
  - `CacheService`
  - `FileSystem`
  - `ProcessRunner`
  - `ShellRunner`
- [ ] Each method's failure channel is typed with one or more SDK tagged errors (no `unknown`, no bare `Error`).
- [ ] Test passes after tags are filled out in `sdk/src/services/index.ts`.
- [ ] Typecheck/lint/whole-workspace tests pass.

### US-008: Provider contract test stub in `@lando/sdk/test`

**Description:** As a provider author (today: us shipping the bundled providers; later: third parties), I need a published contract test suite I can run my Live Layer through to prove conformance to the `RuntimeProvider` interface.

**Acceptance Criteria:**
- [ ] Failing test in `sdk/test/contract/provider.test.ts` documents the contract assertions Phase 1 requires (capability matrix exists, `bringUp`/`bringDown` are Effect-typed, `exec` returns a `Stream` of stdio chunks, `logs` returns a `Stream<LogChunk>`, `inspect` returns a structured snapshot).
- [ ] Suite is exported from `@lando/sdk/test` as a `runProviderContract(provider: RuntimeProvider): Effect<void, ContractFailure>` helper.
- [ ] A trivial in-memory `TestRuntimeProvider` (in `sdk/src/test/`) passes the suite — proves the suite is runnable.
- [ ] Test passes after the suite + `TestRuntimeProvider` land.
- [ ] Typecheck/lint/whole-workspace tests pass.

### US-009: Verify package exports surface

**Description:** As an embedding host, I need every PRD-mandated entry point to resolve cleanly so I can pin against a stable surface.

**Acceptance Criteria:**
- [ ] Failing test in `sdk/test/library/exports.test.ts` does `await import('@lando/sdk')`, `'@lando/sdk/schema'`, `'@lando/sdk/errors'`, `'@lando/sdk/events'`, `'@lando/sdk/services'`, `'@lando/sdk/test'` and asserts each resolves and re-exports the expected symbols (at least one canonical sample per entry).
- [ ] Test passes after `sdk/package.json` `exports` is updated to publish all six entry points.
- [ ] Typecheck/lint/whole-workspace tests pass.

## Functional Requirements

- FR-1: `@lando/sdk/schema` exports `BootstrapLevel`, `BOOTSTRAP_RANK`, `AppRef`, `AppPlan`, `ServicePlan`, `ProviderCapabilities`, `LandofileShape`, `GlobalConfig`, plus the branded primitives (`AppId`, `ServiceName`, `ProviderId`, `HostPlatform`, `ServiceInfo`, `PluginManifest`).
- FR-2: `@lando/sdk/errors` exports `LandoRuntimeBootstrapError`, `ProviderCapabilityError`, `LandofileParseError`, `PluginLoadError`, `NoProviderInstalledError`, plus the supporting errors already referenced by the service tags (e.g. `ConfigError`, `CacheError`, `EventError`).
- FR-3: `@lando/sdk/events` exports the 10 lifecycle event payload schemas listed in US-006, plus a `LandoEvent` discriminated union over them.
- FR-4: `@lando/sdk/services` exports the 11 Effect Service tags listed in US-007, each with a method-typed shape using SDK errors in failure channels.
- FR-5: `@lando/sdk/test` exports the contract suite helper `runProviderContract` and a `TestRuntimeProvider` reference impl.
- FR-6: Every schema in FR-1 has a generated JSON Schema reachable from a single `getJsonSchema(<schemaName>)` helper exported from `@lando/sdk/schema` (publication pipeline is Beta 1; the helper is MVP).
- FR-7: All exports above are listed in `sdk/package.json` `"exports"` field; `@lando/sdk` is publishable to the local `bun pm` cache without errors.

## Non-Goals

- No deprecation governance (`DeprecationNotice`, `markDeprecated()`) — that is Beta 1 (`spec/16-deprecation-and-surface-evolution.md`).
- No JSON Schema *publication* to `https://schemas.lando.dev/` — Beta 1.
- No tagged errors for subsystems not used at MVP (proxy, certs, sync, scanner, scratch, global app).
- No event payloads for events outside the start/stop lifecycle (recipe events, plugin install events, etc. — Alpha 3).
- No Effect service tags for subsystems not used at MVP (`ProxyService`, `CertificateAuthority`, `HealthcheckService`, etc. — Alpha 3).
- No `@lando/sdk/test` provider contract assertions for capabilities that don't exist yet (file sync, copy-on-write, shared cross-app network).
- No published reference docs site — Beta 1.
- No published-to-npm package — Alpha 1 (this PRD only requires `@lando/sdk` resolves locally in the workspace).

## Technical Considerations

- Use the modern Effect 3.x `Context.Tag` class-extending pattern, i.e. `class X extends Context.Tag("@lando/core/X")<X, Shape>() {}`. This is already the convention in `sdk/src/services/index.ts`.
- Use `Schema.TaggedError` for all errors so `_tag` discrimination works through `Effect.runPromiseExit` cause channels.
- Schemas defined in `sdk/src/schema/` are *re-exported* from `core/src/schema/` only when core needs to extend them with private fields — *never* the other way around (no SDK→core import).
- Branded primitives (`AppId`, `ServiceName`, etc.) live in `sdk/src/schema/branded.ts` and are imported by every consumer; they must not be redeclared elsewhere.
- The MVP Compose-subset allowlist is owned by this PRD's `LandofileShape` schema. Each accepted key needs a comment citing why MVP needs it; each rejection emits the key name + a remediation pointing at the spec section.

## Success Metrics

- Zero changes to `sdk/src/` between MVP exit and 4.0 GA (excluding additions for new subsystems shipped in Alpha 1/Alpha 3 — additions are fine; modifications to Phase 1 shapes are not).
- 100% of `@lando/core` failure channels reference SDK-exported tagged errors (no anonymous `Error`, no `string` failures, no `unknown`).
- The provider contract suite (US-008) passes against `TestRuntimeProvider`, `provider-docker` (PRD-04 stretch), and `provider-lando` Linux (PRD-04 must-ship).

## Open Questions

- `LandofileShape` for MVP includes Compose-subset keys — exact allowlist must be confirmed against `spec/06-services.md` and `spec/07-landofile-and-config.md`. The PRD enumerates a starting set (`image`, `ports`, `environment`, `volumes`, `command`, `dependsOn`); the implementer must add only what `node` and `postgres` ServiceTypes actually need.
- Should `getJsonSchema()` be in `@lando/sdk/schema` or in a separate `@lando/sdk/schema-meta` entry to keep the core SDK lean? Default: same entry until publication automation in Beta 1 says otherwise.
