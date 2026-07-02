# PRD: ALPHA4-14 — Probe primitive, EventService query, & the plugin-abstraction contract kit

## Introduction

Alpha 4 lands three remaining additive SDK primitives that were written into the spec ahead of an implementation plan, so they ship inside the last feature-surface phase rather than drifting into orphaned spec text. All three are consumed by plugin authors and embedding hosts, all three are governed by the README's Canonical Surface Governance rule (a public surface must have a canonical registry, a drift/test gate, and an implementing plan), and none of them is a pluggable `Context.Tag` abstraction — they are contracts-only or fixed-runtime primitives. They stay in one PRD because they share the same shape of work (publish a small `@lando/sdk` surface, wire it through the consumers that already exist, lock it with a contract/boundary gate) and because two of the three are gated on the same upstream primitives (the canonical `RedactionService` from PRD-06 and the `@lando/core/testing` surface from PRD-11).

Alpha 4 is still the last feature-surface phase, so these primitives land now instead of being deferred to a post-freeze release. Each one consolidates duplication that already exists in shipped code:

- **Probe / `RetryPolicy` (§10.5.1).** `HealthcheckRunner`, `UrlScanner`, `DoctorService` shell checks, the `Downloader` retry path (PRD-09), and `lando setup` readiness waits each carry their own retry/delay/timeout loop and their own green/yellow/red verdict shape. There is no shared, `TestClock`-deterministic probe runner, so attempt-count and backoff behavior are re-implemented per surface and asserted (where asserted at all) against the wall clock. The §13.1 Effect-service test row and §10.5/§10.5.1 already name `@lando/sdk/probe` as the single backoff/verdict primitive these surfaces build on; this PRD ships it.

- **EventService query, timeout, and history (§11.1).** The live `subscribe` stream exists, but the one-shot `waitFor` / `waitForAny` awaits, the retrospective `query` scan, the bounded **redacted** history buffer, the `EventError` (`reason: "timeout"`) deadline contract, and the typed generic narrowing (`subscribe<E>` / `waitFor<E>` / `query<E>`) are spec-only. Embedding hosts (IDE extensions, dashboards), `lando events --follow`, and the executable-guide `<Verify event=…>` matcher all need "await/inspect an event matching a predicate," and `@lando/core/testing`'s `expectEvent` / `recordedEvents` are documented as thin wrappers over these members — but the runtime members they wrap do not exist yet.

- **The §4.2 plugin-abstraction contract kit (§13.1).** Alpha 4 already ships shared `@lando/sdk/test` contract suites for `Downloader`, `RedactionService`, `InteractionService`, the Landofile serializer, and `StateStore`. The §13.1 test-layer table also specifies six more — `tooling-engine`, `route-filter`, `secret-store`, `config-translator`, `plugin-source`, and `doctor-check` — but no story builds them. These are the literal "unlock plugin authors" payload: without a published harness, a plugin author writing one of these six abstractions has no way to prove their implementation preserves the spec's MUST/SHOULD guarantees, and the built-in implementations have no shared regression contract.

This PRD implements the normative surfaces already present in §10.5.1 (probe), §11.1 (EventService query/history), and §13.1 (the six contract suites), and aligns the existing consumers onto them. It adds no new pluggable abstraction, no new persisted wire schema, and no new JSON Schema artifact.

Depends on: **ALPHA4-04** (the canonical Landofile serializer the `config-translator` contract suite round-trips fragments through, and SDK surface discipline), **ALPHA4-06** (the canonical `RedactionService` that probe consumers and the event history buffer redact through, and the redaction-boundary gate the contract suites assert against), **ALPHA4-09** (the `Downloader` retry path is a probe consumer and its contract suite is the template for the plugin-abstraction kit), and **ALPHA4-11** (`@lando/core/testing` stability and the import-boundary / library-API contract gates the new SDK exports join).

## Source References

### Probe primitive source references

- [`spec/11-subsystems.md`](../11-subsystems.md) §10.5.1 the probe primitive (`RetryPolicy`, `ProbeSpec`, `ProbeResult`, `ProbeError`/`ProbeTimeoutError`, `toSchedule`, `runProbe`, required behaviors), and §10.5 the `HealthcheckRunner` / `UrlScanner` behaviors that map their `retry`/`delay`/`timeout` config onto a `RetryPolicy` and their `ready`/verdict onto a `ProbeOutcome`.
- [`spec/02-toolchain.md`](../02-toolchain.md) §2.7 package surface — the contracts-only `@lando/sdk/probe` tier (peer of `@lando/sdk/secrets` / `@lando/sdk/expressions`), importable without a `LandoRuntime`.
- [`spec/03-architecture.md`](../03-architecture.md) §3.7 redaction — the consumer-owned redaction of `ProbeResult.lastError` before it reaches events/transcripts.
- [`spec/13-testing-and-distribution.md`](../13-testing-and-distribution.md) §13.1 Effect-service test layer (probe asserted under `TestClock`) and §13.4 the boundary gate that keeps net-new `Effect.retry(… Schedule …)` loops out of `core/src/**` outside the primitive and its consumers.
- [`spec/04-pluggability.md`](../04-pluggability.md) §4.2 — the probe primitive is explicitly NOT a pluggable abstraction and NOT a service tag.
- [`spec/alpha-4/prd-alpha-4-00-index.md`](./prd-alpha-4-00-index.md) verification contract, SDK/schema lockstep, and dual-dispatch rules.

### EventService query source references

- [`spec/03-architecture.md`](../03-architecture.md) §11.1 the `EventService` interface — typed `subscribe<E>` / `waitFor<E>` / `waitForAny<E>` / `query<E>`, the bounded redacted history buffer, the `EventError` (`reason: "timeout"`) contract, and the zero-subscriber / zero-history short-circuits.
- [`spec/03-architecture.md`](../03-architecture.md) §3.7 redaction — events are redacted through `RedactionService` before they are buffered.
- [`spec/09-embedding.md`](../09-embedding.md) §16.6 lifecycle and scopes for hosts, §16.8 the `@lando/core/testing` event helpers (`expectEvent` / `waitForEvent` / `recordedEvents`) that wrap these members.
- [`spec/13-testing-and-distribution.md`](../13-testing-and-distribution.md) §13.1 the Effect-service test layer exercising typed narrowing + bounded-history semantics, and the `expectTypeOf` tests in `test/types/`.
- [`spec/alpha-4/prd-alpha-4-00-index.md`](./prd-alpha-4-00-index.md) verification contract and SDK/schema rules.

### Plugin-abstraction contract kit source references

- [`spec/13-testing-and-distribution.md`](../13-testing-and-distribution.md) §13.1 the six contract suites: tooling-engine, route-filter, secret-store, config-translator, plugin-source, doctor-check (each suite's enumerated MUST/SHOULD assertions).
- [`spec/04-pluggability.md`](../04-pluggability.md) §4.2 the abstractions under contract (`ToolingEngine`, `RouteFilter`, `SecretStore`, `ConfigTranslator`, `PluginSource`, `DoctorService`/`doctorChecks`) and the mandatory abstraction guarantees in §4.5.
- [`spec/10-plugins.md`](../10-plugins.md) §9.5 the contribution rules for each surface (config-translator, doctor-check, etc.) the suites assert against.
- [`spec/06-services.md`](../06-services.md) §6.11.3 service-type-shipped tooling and §8.5–§8.7 the `ToolingEngine` contract; [`spec/11-subsystems.md`](../11-subsystems.md) §10.2 route filters, §10.7 SQL/secret resolution, §10.9 doctor.
- [`spec/07-landofile-and-config.md`](../07-landofile-and-config.md) §7.8.1 the canonical Landofile serializer the config-translator suite round-trips emitted fragments through.
- [`spec/09-embedding.md`](../09-embedding.md) §16.8 `@lando/core/testing` test doubles; [`spec/03-architecture.md`](../03-architecture.md) §3.7 redaction the secret-store / tooling-engine / doctor-check suites assert.
- [`spec/alpha-4/prd-alpha-4-00-index.md`](./prd-alpha-4-00-index.md) verification contract and SDK/test-surface rules.

## Goals

### Probe primitive goals

- Publish `@lando/sdk/probe` as a pure, dependency-light, contracts-only module exporting `RetryPolicy`, `ProbeSpec`, `ProbeOutcome`, `ProbeResult`, the `ProbeError` / `ProbeTimeoutError` tagged errors (off the frozen `@lando/sdk/errors` barrel), and the pure `toSchedule` / `runProbe` helpers.
- Make `runProbe` deterministic under Effect's `TestClock` (delay, exponential backoff, jitter, and overall `timeout` driven through `Clock`/`Schedule`, never `Date.now()` / `setTimeout`), with attempt counts and elapsed time asserted without wall-clock flake.
- Migrate `HealthcheckRunner`, `UrlScanner`, `DoctorService` shell checks, the `Downloader` retry path, and `lando setup` readiness waits onto `runProbe`, mapping each surface's `retry`/`delay`/`timeout` onto a `RetryPolicy` and its verdict onto a `ProbeOutcome`.
- Add a §13.4-style boundary gate that forbids net-new hand-rolled `Effect.retry(… Schedule …)` / backoff loops in `core/src/**` outside the primitive and its named consumers.
- Keep redaction consumer-owned: `runProbe` performs no IO, logging, or redaction; consumers pass `ProbeResult.lastError` through `RedactionService` before it reaches an event, transcript, or `lando info`.

### EventService query goals

- Extend the `EventService` interface with typed `waitFor<E>` / `waitForAny<E>` (one-shot awaits with an `EventError` `reason: "timeout"` deadline driven through `Clock`) and `query<E>` (non-blocking retrospective scan of the history buffer).
- Add a bounded in-memory ring buffer that holds **redacted** payloads only (redacted through `RedactionService` before buffering), evicts oldest-first, defaults to a small fixed cap, and is a zero-allocation no-op when a host sets the cap to 0.
- Preserve the existing zero-subscriber short-circuit and `subscribe` semantics; add typed generic narrowing on `E["name"]` across `subscribe` / `waitFor` / `query`, enforced by `expectTypeOf` tests.
- Re-point `@lando/core/testing`'s `expectEvent` / `waitForEvent` / `recordedEvents` to wrap `waitFor` / `query` so the test surface and runtime surface share one implementation.

### Plugin-abstraction contract kit goals

- Publish, from `@lando/sdk/test`, the six §13.1 contract suites — `tooling-engine`, `route-filter`, `secret-store`, `config-translator`, `plugin-source`, `doctor-check` — each asserting the enumerated MUST/SHOULD guarantees for that abstraction.
- Run every built-in implementation through its suite (the `providerExec` / `host` tooling engines; the six built-in route filters; the env secret store; the registry/git/local/tarball plugin sources; the built-in doctor checks).
- Ship the test doubles the suites and downstream tests need (e.g. an in-memory `TestSecretStore`) where one does not already exist, and reuse existing doubles otherwise.
- Wire the kit into the §13.1 layer-coverage rules and the `@lando/sdk/test` exports gate so a missing or weakened suite fails the build.

## User Stories

### US-316: Publish the `@lando/sdk/probe` primitive

**Description:** As a plugin author or core subsystem, I can describe a retry/backoff/timeout policy and run an attempt to a green/yellow/red verdict through one pure, `TestClock`-deterministic helper instead of hand-rolling a `Schedule`.

**Acceptance Criteria:**

- [ ] `@lando/sdk/probe` exports `RetryPolicy`, `ProbeSpec`, `ProbeOutcome`, `ProbeResult` schemas and the `toSchedule(policy)` and `runProbe(spec, attempt)` helpers, matching §10.5.1; the subpath is registered in `sdk/package.json#exports`.
- [ ] `@lando/sdk/probe` imports neither `effect` runtime services nor `@lando/sdk` runtime modules beyond `effect`'s `Schema`/`Schedule`/`Effect`/`Clock` and type-only schema imports; an import-boundary test proves it constructs no `LandoRuntime` and pulls no service Layer.
- [ ] `ProbeError` and its `ProbeTimeoutError` deadline sub-shape are tagged errors exported from `@lando/sdk/probe` and deliberately do NOT ride the frozen `@lando/sdk/errors` barrel (mirroring `@lando/sdk/expressions`), so no frozen error union widens; the schema-snapshot gate runs clean with no `JSON_SCHEMA_REGISTRY` entry added.
- [ ] `runProbe` is deterministic under Effect's `TestClock`: a test drives `maxAttempts`, `delay`, `backoff: "exponential"` with `factor`/`maxDelay`, `jitter`, and the overall `timeout` and asserts attempt count and elapsed time with no wall-clock dependency.
- [ ] `runProbe` stops at the first `green`, retries on `red`/`yellow` per `policy`, and resolves with a `ProbeResult` (`outcome`, `attempts`, `elapsedMs`, optional `lastError`); exhausting `maxAttempts` or hitting `timeout` resolves with the last non-`green` `ProbeResult` and does NOT fail the Effect.
- [ ] `runProbe` performs no IO, logging, or redaction; a test asserts `lastError` is returned verbatim for the consumer to redact.
- [ ] `sdk/API_COMPATIBILITY.md` records `@lando/sdk/probe` as an additive contracts-only subpath; SDK export fixtures and `sdk/test/library/exports.test.ts` are updated in the same change.
- [ ] Tests pass.
- [ ] Typecheck passes.
- [ ] Lint passes.

### US-317: Migrate probe consumers onto `runProbe` and gate against regrowth

**Description:** As a maintainer, I can reason about one backoff/verdict implementation instead of auditing duplicate retry loops across healthcheck, scanner, doctor, downloader, and setup readiness.

**Acceptance Criteria:**

- [ ] The default `HealthcheckRunner` builds on `runProbe`: the object-form `retry`/`delay`/`timeout` map onto a `RetryPolicy` and the `ready` verdict is the probe's `green` `ProbeOutcome`; existing healthcheck tests stay green.
- [ ] The default `UrlScanner` builds on `runProbe`: `retry`/`delay`/`timeout` resolve to a `RetryPolicy` and the green/yellow/red result is the probe's `ProbeOutcome`; `okCodes`/`maxRedirects`/`path` behavior is unchanged.
- [ ] `DoctorService` shell checks, the `Downloader` retry path (PRD-09), and `lando setup` readiness waits consume `runProbe` rather than a private retry loop; each consumer redacts `ProbeResult.lastError` through `RedactionService` (§3.7) before it reaches an event, transcript, or readiness summary.
- [ ] A §13.4-style boundary check (test or lint) proves no net-new hand-rolled `Effect.retry(… Schedule …)` / backoff loop exists in `core/src/**` outside `@lando/sdk/probe` and its named consumers; pre-existing non-probe `Schedule` uses are explicitly allowlisted.
- [ ] No behavior change for default inputs: healthcheck readiness, scanner verdicts, doctor remediation, downloader retries, and setup readiness are observably identical for unchanged inputs, verified by the existing suites.
- [ ] Source-mode and compiled `$bunfs` dispatch paths consume the same probe-backed healthcheck/scanner/doctor/setup behavior (dual-dispatch parity preserved).
- [ ] Tests pass.
- [ ] Typecheck passes.
- [ ] Lint passes.

### US-318: Extend `EventService` with typed `waitFor`/`query` and a bounded redacted history buffer

**Description:** As an embedding host, a guide assertion, or a test, I can await an event matching a predicate with a timeout, or scan recent events that already fired, without racing the live stream.

**Acceptance Criteria:**

- [ ] `EventService` gains `waitFor<E>(name, { filter?, timeout? })`, `waitForAny<E>(specs, { timeout? })`, and `query<E>(name, filter?)`; `subscribe<E>` / `waitFor<E>` / `query<E>` narrow on `E["name"]`, and `expectTypeOf` tests in `test/types/` lock the typed signatures.
- [ ] `waitFor` resolves from the live stream and fails with `EventError` (`reason: "timeout"`) when the deadline elapses, driven through Effect's `Clock` so a `TestClock` test asserts it deterministically; without `timeout` it waits indefinitely. `waitForAny` resolves with the first matching event across its specs under the same timeout contract.
- [ ] `EventService` retains a bounded in-memory ring buffer (small fixed default cap, oldest-evicted-first) that holds payloads **redacted through `RedactionService` (§3.7) before buffering**; a test proves `query` and the history snapshot never observe an un-redacted payload.
- [ ] `query(name, filter?)` scans the buffer and returns matching events without blocking; events evicted from the buffer are never returned; a host that sets the cap to 0 incurs a zero-allocation no-op (asserted).
- [ ] The existing zero-subscriber short-circuit and `subscribe` completion-on-scope-close semantics are unchanged; a regression test covers both.
- [ ] `@lando/core/testing` `expectEvent` / `waitForEvent` are reimplemented as thin wrappers over `EventService.waitFor` (with a default test timeout for `expectEvent`), and `recordedEvents` is `query("*")` over the test runtime history; existing tests using these helpers stay green.
- [ ] `sdk/API_COMPATIBILITY.md` records the `EventService` interface additions as additive; SDK export fixtures, the schema-snapshot gate (`EventError` reason addition if any), and `exports.test.ts` are updated in the same change.
- [ ] Tests pass.
- [ ] Typecheck passes.
- [ ] Lint passes.

### US-319: Publish the declarative plugin-abstraction contract suites (route-filter, secret-store, config-translator, doctor-check)

**Description:** As a plugin author, I can prove a `RouteFilter`, `SecretStore`, `ConfigTranslator`, or `doctorChecks` contribution preserves the spec's guarantees by running it through a published shared suite.

**Acceptance Criteria:**

- [ ] `@lando/sdk/test` exports `makeRouteFilterContractSuite`, `makeSecretStoreContractSuite`, `makeConfigTranslatorContractSuite`, and `makeDoctorCheckContractSuite`, each asserting the enumerated §13.1 guarantees for its abstraction.
- [ ] The route-filter suite asserts provider-neutrality (declarative transform, never proxy-native middleware), pure/deterministic/idempotent `apply`, capability-vs-behavior match, schema-decode failure on invalid options, and stable ordering across replays; the six built-in filters (`requestHeader`/`responseHeader`/`redirect`/`rewritePath`/`stripPrefix`/`addPrefix`) pass it.
- [ ] The secret-store suite asserts `resolve(ref)` returns known values and fails with `SecretNotFoundError` for unknown refs, resolved values register with the canonical redactor (§3.7) so they never appear in logs/events/transcripts/lockfiles/cache metadata, `resolve` is read-only/side-effect-free, missing-backend/auth failures surface tagged errors, and already-cached secrets resolve offline (§12.6); the built-in env store passes it.
- [ ] The config-translator suite asserts `detect()` is authoritative over advisory `detects:` globs, `translate()` returns a schema-valid `LandofileShape` fragment plus diagnostics (never an `AppPlan`, never mutates files/contacts providers/installs plugins), `optionsSchema` validates caller options before `translate`, output is deterministic, and the emitted fragment round-trips through the canonical Landofile serializer (§7.8.1).
- [ ] The doctor-check suite asserts `run()` returns issues carrying severity/context and an `automatic` or `manual` solution, default runs are read-only and only `--fix` executes automatic solutions, shell-shaped probes route through `ShellRunner` (so they appear in the redacted doctor transcript, §10.9), and secrets are redacted; the built-in core checks pass it.
- [ ] An in-memory `TestSecretStore` (and any other test double the suites require that does not already exist) is exported from `@lando/core/testing` and satisfies its suite.
- [ ] `sdk/API_COMPATIBILITY.md`, SDK export fixtures, and `sdk/test/library/exports.test.ts` are updated for the new `@lando/sdk/test` exports.
- [ ] Tests pass.
- [ ] Typecheck passes.
- [ ] Lint passes.

### US-320: Publish the execution/resolution contract suites (tooling-engine, plugin-source)

**Description:** As a plugin author, I can prove a `ToolingEngine` or `PluginSource` contribution preserves the spec's execution, cancellation, redaction, and containment guarantees.

**Acceptance Criteria:**

- [ ] `@lando/sdk/test` exports `makeToolingEngineContractSuite` and `makePluginSourceContractSuite`, each asserting the enumerated §13.1 guarantees for its abstraction.
- [ ] The tooling-engine suite asserts capability-vs-behavior match, dependency-ordered step execution with documented concurrency, `Effect.interrupt` cancelling in-flight steps and finalizing child processes, `tooling-step-start`/`-complete`/`-skip`/`-fail` events publishing with redacted command shapes, `sources`/`generates` up-to-date short-circuit to `-skip`, a non-zero step exit mapping to a tagged `ToolingExecError` carrying the failing step id, and secret-resolved values never reaching event/transcript output; the built-in `providerExec` and `host` engines pass it.
- [ ] The plugin-source suite asserts `resolve(spec)` yields a package root contained under a Lando-managed store after realpath resolution (escapes fail with `PluginModulePathError`), resolution honors `network.proxy` / `network.ca` (§10.3.1), registry auth tokens are redacted from logs/events, resolution is offline-safe for already-locked sources (§9.3) and never re-fetches without a lockfile change, and failures surface tagged errors with remediation; the built-in registry/git/local/tarball sources pass it.
- [ ] The suites run against the built-in implementations using existing test doubles (`TestRuntimeProvider`, in-memory `FileSystem`/`ProcessRunner`, the `BunSelfRunner` recording fixture) without contacting a real provider, network, or registry.
- [ ] `sdk/API_COMPATIBILITY.md`, SDK export fixtures, and `sdk/test/library/exports.test.ts` are updated for the new `@lando/sdk/test` exports.
- [ ] Tests pass.
- [ ] Typecheck passes.
- [ ] Lint passes.

### US-321: Wire the contract kit into the §13.1 layer-coverage and exports gate

**Description:** As a maintainer or security reviewer, I can rely on a gate that fails when any §4.2 plugin-abstraction loses or weakens its shared contract suite.

**Acceptance Criteria:**

- [ ] The §13.1 plugin-SDK-contract test layer runs all six suites (tooling-engine, route-filter, secret-store, config-translator, plugin-source, doctor-check) alongside the already-shipped Downloader/Redaction/Interaction/serializer/StateStore suites; the layer-coverage rule treats a §4.2 abstraction with a published suite but no built-in invocation as a failure.
- [ ] A gate (test or lint) asserts that every §4.2 abstraction with a contract suite in `@lando/sdk/test` has its built-in implementation(s) exercised by that suite, and that a plugin-contributed implementation cannot satisfy the abstraction interface while weakening checksum/containment/redaction/determinism guarantees the suite enforces.
- [ ] The `@lando/sdk/test` exports gate (`sdk/test/library/exports.test.ts` + fixtures) lists every `make*ContractSuite` export; removing or renaming a suite fails the gate.
- [ ] The repo `AGENTS.md` plugin-contract-kit note and the §13.1 / §4.2 spec surfaces are present and consistent (every §4.2 abstraction's row points at its suite).
- [ ] The §16/§9 import-boundary test still passes (`@lando/sdk/test` and `@lando/core/testing` stay free of OCLIF; the default `@lando/core` entry stays OCLIF-free).
- [ ] Tests pass.
- [ ] Typecheck passes.
- [ ] Lint passes.

## Functional Requirements

### Probe primitive functional requirements

- FR-1: All host- or provider-shaped retry/backoff/timeout-to-verdict probing in `core/src/**` MUST build on `@lando/sdk/probe`'s `runProbe`; net-new hand-rolled `Schedule`/backoff/retry loops outside the primitive and its named consumers are forbidden and gated.
- FR-2: `@lando/sdk/probe` MUST be pure and contracts-only (no service tag, no Layer, no IO, no redaction) and MUST be importable without constructing a `LandoRuntime`.
- FR-3: `runProbe` MUST be deterministic under `TestClock` and MUST resolve (not fail) with the last non-`green` `ProbeResult` on exhausted attempts or elapsed `timeout`; the consumer decides whether a non-`green` outcome fails its own Effect.
- FR-4: `ProbeError` / `ProbeTimeoutError` MUST NOT ride the frozen `@lando/sdk/errors` barrel and MUST add no `JSON_SCHEMA_REGISTRY` entry.
- FR-5: Consumers MUST redact `ProbeResult.lastError` through `RedactionService` (§3.7) before it reaches any event, transcript, `lando info`, or readiness summary.

### EventService query functional requirements

- FR-6: `EventService` MUST expose typed `waitFor<E>` / `waitForAny<E>` / `query<E>` narrowing on `E["name"]`; `waitFor`/`waitForAny` MUST honor an optional `timeout` that fails with `EventError` (`reason: "timeout"`) through Effect's `Clock`.
- FR-7: The history buffer MUST hold only payloads already redacted through `RedactionService`; `query` and any host/guide snapshot MUST be unable to observe an un-redacted payload.
- FR-8: The buffer MUST be bounded (small fixed default, oldest-evicted-first) and MUST be a zero-allocation no-op when the cap is 0; `query` MUST never return evicted events.
- FR-9: Existing `subscribe` semantics and the zero-subscriber short-circuit MUST be preserved; `@lando/core/testing` `expectEvent` / `waitForEvent` / `recordedEvents` MUST be thin wrappers over the new members (one implementation).

### Plugin-abstraction contract kit functional requirements

- FR-10: `@lando/sdk/test` MUST export a contract suite for each of `tooling-engine`, `route-filter`, `secret-store`, `config-translator`, `plugin-source`, and `doctor-check`, each asserting that abstraction's enumerated §13.1 guarantees.
- FR-11: Every built-in implementation of a contracted abstraction MUST be run through its suite; the §13.1 layer-coverage rule MUST fail when a published suite has no built-in invocation.
- FR-12: The suites MUST run with in-memory / recording test doubles only — no real provider, network, or registry access — and MUST assert that a plugin implementation cannot satisfy the interface while weakening containment, checksum, redaction, or determinism guarantees.
- FR-13: Adding any `@lando/sdk/test` export MUST update `sdk/API_COMPATIBILITY.md`, the SDK export fixtures, and `exports.test.ts` in the same change, and MUST leave the §13.2 schema snapshot unchanged.

## Non-Goals

### Probe primitive non-goals

- Making the probe primitive a pluggable `Context.Tag` abstraction or adding a `provides.probes` manifest surface; it is contracts-only.
- Adding a circuit-breaker, bulkhead, or rate-limiter; the primitive is retry/backoff/timeout-to-verdict only. Effect's own combinators remain available for non-probe needs.
- Migrating the §12.5 hot-path caches or any non-probe `Schedule` use; only host/provider-shaped probe loops move onto `runProbe`.

### EventService query non-goals

- Making `EventService` a pluggable abstraction (it remains a fixed runtime primitive per §16.10).
- A durable / on-disk event log; the buffer is in-memory and bounded. Hosts that need the full log subscribe early.
- A query DSL beyond name + predicate `filter`; no SQL-like layer, no cross-event joins.

### Plugin-abstraction contract kit non-goals

- New pluggable abstractions or new contribution surfaces; the kit tests the existing §4.2 abstractions only.
- A provider contract suite change; the provider / file-sync / host-proxy / template-engine suites already ship and are out of scope here.
- Shipping plugin implementations of these abstractions beyond the built-ins; the kit is the harness, not new plugins.

## Technical Considerations

- The probe primitive belongs on the contracts-only SDK tier next to `@lando/sdk/secrets` and `@lando/sdk/expressions`; keep its imports to `effect` (`Schema`/`Schedule`/`Effect`/`Clock`) plus type-only schema imports so the import-boundary test stays green. The `ProbeError` placement off the frozen errors barrel mirrors the expressions-error precedent exactly.
- The healthcheck/scanner migration is behavior-preserving by construction: their existing `retry`/`delay`/`timeout` config already matches `RetryPolicy`'s fields, and their green/yellow/red verdict already matches `ProbeOutcome`. Keep the consumer's verdict-classification (which exit code or HTTP status is green/yellow/red) in the consumer; only the loop moves.
- The redaction dependency runs one direction: probe consumers and the event buffer call `RedactionService` (PRD-06); the probe primitive and the buffer never import the redactor themselves. This keeps `@lando/sdk/probe` pure and the buffer's redaction at the single canonical seam.
- The event history buffer must redact **before** buffering (not on read) so `query` cannot leak; reuse the same `RedactionService` seam the telemetry transport and transcript writer use rather than a second redaction path.
- The contract suites should follow the shipped Downloader/Redaction/Interaction suite pattern (`make<X>ContractSuite(impl, options)` returning a `bun test` block) so the kit is uniform; reuse existing test doubles (`TestRuntimeProvider`, in-memory `FileSystem`/`ProcessRunner`, the `BunSelfRunner` recording fixture) and add only the missing ones (`TestSecretStore`).
- The config-translator suite's round-trip assertion depends on PRD-04's `@lando/sdk/landofile` serializer; sequence US-319 after the serializer story (US-307..US-310) lands.

## Success Metrics

- Grepping core shows one probe/backoff implementation; healthcheck, scanner, doctor, downloader, and setup readiness delegate to `runProbe`, and the boundary gate rejects net-new ad-hoc retry loops.
- `@lando/sdk/probe` imports cleanly with no runtime/OCLIF leakage, and its `TestClock` tests assert attempt-count/backoff/timeout with zero wall-clock flake.
- Embedding hosts and guide assertions can `waitFor` an event with a timeout and `query` recent events; a `TestClock` test proves the timeout path, and a redaction test proves the buffer never holds an un-redacted payload.
- All six plugin-abstraction contract suites are published from `@lando/sdk/test`, every built-in implementation passes its suite, and the §13.1 layer-coverage gate fails if a suite or its built-in invocation is removed.
- SDK backward-compat fixtures and the schema snapshot stay green (every addition is additive; no `JSON_SCHEMA_REGISTRY` entry added).

## Guide Coverage

**None — internal/infra PRD.**

This PRD publishes an SDK runtime/test primitive trio (probe, event query, plugin-abstraction contract kit). It does not directly own user-facing guide surface; downstream CLI and library guides remain owned by the PRDs for the commands and embedding surfaces that consume these primitives.

## Open Questions

- Should `@lando/sdk/probe` expose a `ProbeOutcome`-aware convenience (`runProbeOrFail`) that fails the Effect on a non-`green` terminal outcome, or keep the resolve-with-result contract and leave fail/continue entirely to consumers? Default: resolve-with-result only for Alpha 4; a consumer that always fails on non-green writes one line. Revisit if three or more consumers duplicate the same fail wrapper.
- Should the `EventService` history cap be a `GlobalConfig` field or a `makeLandoRuntime` option only? Default: a `makeLandoRuntime` / runtime option (hosts opt into 0 or a larger cap) without a `GlobalConfig` field in Alpha 4, to keep the CLI default fixed and the schema unchanged.
- Should the six contract suites be one `@lando/sdk/test` aggregate export (`pluginAbstractionContractSuites`) in addition to the individual `make*ContractSuite` functions? Default: individual exports for Alpha 4 (a plugin author runs only the suite for the abstraction they ship); add an aggregate convenience only if the core test layer wants a single call site.
