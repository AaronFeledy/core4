# Lando v4: Testing, Distribution, and Quality Gates

> **Part 13 of 19** · [Index](./README.md)
> **Read next:** [14 Appendices](./14-appendices.md)

This part defines the release quality bar, test architecture, distribution forms, CI cadences, and release channels.

---

## 13. Testing, Distribution, and Quality Gates

### 13.1 Test layers

All tests run under `bun test` unless a gate names another tool.

| Layer | Contract |
|---|---|
| Unit | Pure functions, schemas, merges, expressions, and planners are deterministic and isolated. |
| Effect service | Services run with test Layers, `TestClock`, `TestRandom`, and deterministic Streams rather than patched globals. |
| CLI | The native registry and dispatcher own parsing, routing, exit codes, help, and source/compiled conformance. |
| Library API | `@lando/core/testing` exercises embedding surfaces, service availability, lifecycle events, isolation, and finalization. |
| Provider contract | Every `RuntimeProvider` plugin passes the shared `@lando/sdk/test` suite. |
| Service composition contract | Every `ServiceType` declares a base and resolves through deterministic, provider-neutral core composition. Verify per-kind `sync` inheritance, child Dataset-id replacement, whole-list postApply replacement/empty-list clearing, explicit binding precedence, and no ancestor task duplication (§6.11.1). |
| Service feature contract | Every `ServiceFeature` is deterministic, idempotent, priority-ordered, capability-declared, and conflict-safe. Optional endpoint declarations consume immutable original decoded facts, return typed endpoint intent, and expose no apply mutators (§6.11). |
| App feature contract | Every `AppFeature` shares immutable resolved selection facts between declaration and application, remains idempotent, and rejects application cycles. App declarations follow service declarations; app application follows service application (§6.11.4). |
| Template engine contract | Every engine declares truthful capabilities, preserves context, is deterministic, and performs no undeclared side effects. |
| Host proxy contract | Authentication, exact request union, allowlists, recursion, backpressure, socket ownership, redaction, streaming, and cleanup are enforced. |
| TunnelService contract | Targets, egress, provisioning, scope ownership, detached state, probes, events, and redaction remain within the declared port. |
| File sync engine contract | Capabilities, setup, containment, content fidelity, conflicts, events, cancellation, and pinned-tool ownership are enforced. |
| HttpClient contract | `runHttpClientContract` from `@lando/sdk/test` runs against any Effect `effect/http` `HttpClient` (the `@lando/http-client` layer, the in-memory test client, or an `httpClients:` plugin): proxy/CA precedence, scheme policy, streaming, offline behavior, cancellation, events, and redaction are enforced (§10.3.2). |
| Downloader contract | All egress uses `HttpClient`; cache, checksum, size, containment, atomicity, cancellation, and redaction are enforced. |
| Redaction contract | The canonical value and pattern layers produce byte-stable profile output and cannot be weakened by plugins. |
| Interaction contract | Answer precedence, mode selection, validation, secret handling, cancellation, dynamic choices, and renderer routing are enforced. |
| Renderer frames | Headless snapshots cover task trees, prompts, narrow terminals, and resize behavior without asserting machine renderers. |
| Renderer stream and capability contract | `makeRendererContractSuite` / `runRendererContract` MUST exercise every built-in event family and imperative message with buffered narration-TTY and non-TTY IO. Narration MUST NOT write stdout; output channels MUST preserve multiline and partial payload bytes. Capabilities MUST describe the stderr narration terminal independently of stdout. All four built-ins MUST run the suite in their owning package. A core boundary matrix MUST cover renderer mode × stdout TTY × stderr TTY × live tooling/text result/JSON envelope (§8.9). |
| Renderer panel contract | Manifest validation precedes isolated loading; bounded, deterministic rendering fails only the offending panel and preserves last-good output. |
| Subscriber selector and config-projection contract | Selectors close over the canonical event registry; indexes are prebuilt, factories lazy, and config projections bounded. |
| Keymap schema and conflict-check split contract | Raw key syntax decodes independently from same-surface collision detection; cross-surface reuse remains legal. |
| Desktop notification bounds contract | Notification fields validate before publication and sanitization precedes capability-gated presentation. Default TTY notifications use query-free OSC 99 without loading OpenTUI (§8.9.7). |
| HostProxy exact-union contract | `HostProxyRequest` contains exactly `openUrl`, `openPath`, `runLando`, and `runBun`. |
| OpenTUI native one-of-eight pruning contract | Each release target embeds one matching native package and stubs the other seven without redirecting testing or relative imports. |
| SDK compatibility/schema-snapshot artifact-set contract | The SDK public surface and every schema-backed surface match `sdk/test/fixtures/sdk-public-surface.json` and generated artifacts. |
| Tooling engine contract | Engines execute dependency-ordered programs, cancel children, publish redacted events, honor up-to-date checks, and tag failures. |
| Route filter contract | Filters are pure, deterministic, idempotent, provider-neutral, capability-truthful, and stably ordered. |
| Authored route binding | Lint and planning MUST share indexed HTTP binding findings for service routes and top-level proxy entries. Cover primary/named/numeric selection, non-HTTP primaries, logical facets, missing/non-HTTP/ambiguous/unmatched targets, late app declarations, explicit empty endpoint authority, incomplete facts, invalid declarations, and independent findings with retained provenance after malformed or blocked entries. Preserve the first-expression-error limit (§7.8). |
| Endpoint declaration isolation | Service and app declaration contract tests MUST check deterministic, schema-valid output and absence of mutations to input facts. Engine tests MUST trap general feature apply, certificate resolution, provider access, and cache operations during lint, and prove planning consumes declarations once. Cover shared default/ref/config/priority handling, original versus planner-materialized config, selector/activation parity, and unchanged §6.6 normalization of declarations, ports, and expose. |
| Prepared feature execution | Prove occurrence-preserving preparation and captured app selections are reused by application, original declaration decoding is reused, explicit materialized replacements are decoded deliberately, and application-only schemas stay deferred on lint and cache hits. Distinguish available empty endpoints from reason-carrying unavailable states, retain known selector facts after declaration failure, and avoid duplicate propagated diagnostics. |
| Routed listener smoke | A focused real-binary smoke MUST start bundled nginx on a non-default container port and reach a unique response through the managed router, without substituting an authored launcher or direct host-port publication. Discover the actual routed URL, namespace app resources per run, and tear down only that app. Listener-policy tests cover declaration, launcher, and probe agreement for nontrivial serving modes. |
| Route application convergence | Prove immediate acceptance has no wait, partial or stale app-owned graphs cannot pass, warm HTTP/HTTPS applies do not rewrite or reissue current material, and missing prerequisites fail before mutation. Timeout, hung HTTP, cancellation, and Windows digest/ack ordering remain bounded and private. The real routed smoke makes its first app request immediately after successful start, before info, without retries. Withdrawal still works with the router stopped. |
| Secret store contract | Test `env`, fake-runner `1password`, durable `lando`, and scoped `lando-session`: exclusive scheme ownership, grammar/namespace injectivity, cross-session/closed-scope refusal, ids-only list, metadata-only describe, exact read/write errors, unavailable `has`, no CLI backend enumeration, insecure POSIX/Windows storage refusal, locked atomic rotation, and redaction before use (§9.5.1). |
| Config translator contract | Explicit conversion and declared snapshot refresh are pure, deterministic, fragment-only, schema-valid, IO-free, and round-trip when encoding is supported. |
| RecipeDecomposer contract | Option errors, recipe identity, fragment output, side-effect absence, port closure, and secret exclusion are enforced. |
| Managed-file transaction recovery | Failure injection covers every journal state, concurrent edits, cancellation, orphan stages, and dry-run immutability. |
| Side-by-side coexistence | Install, update, uninstall, and shellenv preserve hostile and valid Lando 3 binaries and state byte-for-byte. |
| Plugin source contract | Sources resolve contained package roots, honor network policy and locks, redact credentials, and fail with remediation. |
| Doctor check contract | Checks are read-only by default, return structured issues and solutions, use bounded ports, and redact transcripts. |
| RemoteSource contract | Test exact named-unit/branch resolution, source preference and explicit access, per-unit push authorization, equivalent alternates, producer/consumer scope, freshness and approval changes, start-once/poll-only preparation, expiring additive exposure, cleanup failure receipts, effective protection across entry points, and no guessed targets (§10.12). Validate all four reserved remote hooks before connector selection and reject tooling-event collisions regardless of alias remapping (§8.5.7). |
| Remote auth/tool contract | Test long-operation renewal before expiry with skew, concurrent atomic grant rotation, scope claims versus verified permission/unknown results, setup side-effect receipts, interactive-only OAuth code display, protocol-specific egress, TLS identity through forwarding, safe bounded HTTP retries, streaming/cancellation, and no nested runtime socket. |
| Dataset contract | Test capture/apply round-trip, network client capture, no inferred remote writes, files versus blob metadata semantics, snapshot opt-outs/failures, containment, and redaction. Assert serial kind/service postApply groups before post-pull, then post-switch when applicable; no local postApply on push or no-pull switch, no duplicate hooks, and failure stops later success hooks while retaining the applied-data receipt. |
| Config dataset contract | Test tracked/unignored targets and unsafe sibling stages/backups/snapshots, private ACLs, adoption/user-edit conflicts, comment/local-key preservation, unreadable keys without sendable placeholders, topology omission/local mapping, explicit outbound key allowlists, no implicit deletion/bulk secret export, and no next-process overlay (§10.12.7). |
| Tether and tunnel contract | Test actual-resource production/staging/unknown/protected/unlisted refusal; CLI-only typed confirmation; stopped-app precondition; provider/container reachability; TLS identity; direct-endpoint forwarding without credential bypass; crash/lease revocation; disconnect-before-consumer cleanup; race blocking; no local-volume purge (§10.12.5). |
| CodeSync contract | Exercise pull-with-code and switch through the same refresh/hook/revalidation sequence, including an already-current ref. Test exact branches/tags, source/artifact consent, FF-only updates, ignored/untracked collisions, dirty/in-progress trees, no reset/push, fresh target hook context, no implicit second metadata fetch, final binding re-resolution, noPull invalidation, and truthful code-only failure receipts against doubles and real host Git. |
| InitSource contract | Test credential-free local/public sources, HTTPS without SSH, missing-auth refusal, ordered prompts/choices, locator-only resolution, acquisition-only staging, canonical preview, destination conflicts/rechecks, final-root transactions with no relocated journals/ledgers, metadata publication before post-init/start, and honest receipts after placement or commit failure (§8.8.13). |
| Translation refresh contract | Test zero API calls during automatic refresh, complete fingerprint/plan keys, unchanged-input no-op, explicit fetch failure without stale fallback, missing metadata remediation, environment/branch cache isolation on switch, local-only check, blocking diagnostics, and managed-file conflicts (§7.4.2). |
| Remote integration profiles | Exercise the same contracts with six capability fixtures: hosted-Git/SSH CMS, API-backup enterprise CMS, certificate/branch PaaS, Git-deployed branch config, marketplace-backed app hosting, and managed database/object storage. Cover multisite units, deploy-only refs, source/build refs, write-only config, unavailable exports, and direct/tunneled clients; fixtures MUST NOT assert unverified live-vendor support. |
| Managed-file contract | Plan/apply parity, atomic replacement, containment, ownership markers, ledger integrity, adoption, release, and redaction are enforced. |
| Plugin SDK contract | Type and runtime tests protect the public plugin-author surface. |
| Machine-output conformance | Every non-interactive canonical command emits schema-valid envelopes or streams with correct ids, status, and redaction. |
| Agent command completion | Prove one-time completion policy resolution across CLI, lifecycle, and MCP; nonzero process failure with retained typed result/diagnostics; successful negative reports with format-independent exit codes; bounded final output with and without progress tokens; stream owner finalization; and quiet-read cancellation through real local transport and the relocated compiled CLI against an explicitly selected live provider. |
| Scenario | Public library APIs run end-to-end against `TestRuntimeProvider` without real container, network, or host mutation. |
| Recipe | Every canonical recipe scaffolds with defaults and representative branches into schema-valid output. |
| Executable guides | §19 MDX generates source-mapped scenario tests and visibility-separated transcripts for every applicable variant. |
| Deprecation | Every notice records use, publishes `deprecation-used`, warns once, appears in doctor, and obeys `removeIn`. |
| Perf budget | Compiled-artifact tests enforce §2.1 end-to-end, first-paint, hot-path, concurrency, and runtime-reuse budgets, plus the TTY renderer process-exit overhead gate in §13.6. |
| Compiled decoder parity | Interpreted and compiled decoding of the shared Landofile corpus (guide and recipe fixtures plus curated valid and invalid inputs) run in separate processes and MUST produce identical verdicts, values, and issue paths and messages (§2.5, §12.5.1). |
| End-to-end | The relocated compiled binary runs against real operating systems, providers, plugins, routes, files, and offline-after-build state. |

**Effect testing rules:** tests MUST inject mocks with Layers, provide them per test, use `TestClock` from `effect/testing` (provided with `TestClock.layer()`) and `TestRandom` for nondeterminism, and feed stream services with deterministic Streams. Tests MUST NOT patch globals.

**Provider contract suite:** every provider plugin MUST prove capability truthfulness, idempotent `apply`, complete `destroy`, tagged missing-service errors, terminating log Streams that return a console line written in pieces or longer than the engine's message split as one chunk, capability-correct mount/endpoint/storage/route behavior, actionable remediation, and retention plus convergence on retry (`runProviderStartRetentionContract`: a second-service start failure and an interruption leave containers and networks in place, and a retry reuses them with unchanged container identity). Dependency-cycle, blocked-gate, and volume-phase retention are required coverage too; adjacent container tests cover those phases, not that helper. Bundled providers MUST run the same suite; no provider-specific substitute is acceptable. Providers supporting persistent storage MUST pass `runProviderVolumeCreationContract`, proving exactly-once callbacks for verified creation, awaited asynchronous completion before service startup, failure propagation, and no callbacks for existing or adopted volumes. These requirements are independent of data-plane capabilities.

Start-failure coverage MUST prove retention at every phase (apply, dependency gate, app build, routes, GPG preparation, readiness, and cancellation) with finalized temporary probes and build children, convergence on retry with unchanged container identity for undrifted services, and the failure warning inventory (running, created/stopped, unverified rows under the one-second observation budget, the `No app resources changed.` form before any mutation, and no warning in machine output). Accelerated-start coverage MUST prove resume from each unfinished journal phase reusing every established session with no re-creation, termination, or reseed (including retained containers beside an `apply-intent` journal), stop and destroy from every phase whose ownership and data-preservation checks pass, destroy refusal of a post-apply-intent target with no matching session, the version 1 journal migration on read with version 2 persisted on the next mutation, and fail-closed refusal of identity drift, foreign ownership, unknown sessions, mismatched prepared targets, and a missing session whose history cannot be recovered (§10.6.3). Scratch coverage MUST prove apply and readiness failure and interruption cleanup with and without `--keep-on-failure`. A live-socket-gated regression MUST prove an immediate PostgreSQL 18 query after fresh-volume start returns, an Apache runtime startup failure with `ServiceNotReadyError`, terminal exit code, log tail, and retained container, and start convergence: fault an app-owned certificate path so start fails after apply, change a hostname, and retry with the same container id. The regression MUST skip cleanly without a reachable live socket. A live-socket-gated MongoDB regression MUST hold the official image's initialization hook on a FIFO after root-user creation and prove that authenticated loopback access succeeds while both targeted default probes fail, then that both succeed after release, for a private-network plan and an aliasless shared-only plan. Unit coverage MUST prove effective-readiness selection at every gate, canonical shared-alias realization, probe-compiler agreement across native create, Compose output, and fingerprints, authored-healthcheck replacement and `false` disabling of both probes, bounded redacted probe evidence, and a non-Mongo TCP listener whose cheap health passes while protocol readiness fails. The MongoDB guide MUST carry two non-smoke e2e scenarios, fresh default port and fresh custom port, each driving the compiled CLI through start, an immediate authenticated write and read, stop, start, and an immediate persisted read with isolated roots, explicit cleanup, no sleeps, and no client retry loops. Probe cost is guarded by command selection, invocation counts, and outcomes, not absolute millisecond thresholds.

`runProviderStartRetentionContract` is exported from `@lando/sdk/test`; providers MUST use this shared contract rather than a provider-specific rollback-on-interruption test.

**Plugin-abstraction coverage:** every shared `@lando/sdk/test` contract kit in §4.2 MUST have a canonical built-in invocation in the owning package. Coverage MUST fail when a suite or invocation disappears. Reference transforms are permitted only where no bundled implementation exists.

**Library API contract suite:** the default entry MUST remain free of CLI-framework imports; documented entries and service tags MUST be exported; CLI and library paths MUST publish the same lifecycle sequence; discovery policy MUST honor each source independently; runtime instances MUST be isolated; `App` handles MUST remain root-bound; Scope ownership MUST finalize resources; retained runtimes MUST perform bootstrap work once and meet hot-path budgets; errors MUST retain typed payloads and remediation.

**Command registry contract:** implemented and deferred command ids MUST partition the canonical registry. Every implemented id is reachable, every deferred id yields the catalogued `NotImplementedError`, and relocated compiled smoke tests MUST validate representative exit codes, tagged errors, and machine envelopes. Dual-dispatch parity is not a test layer.

The compiled MCP completion journey MUST cover real container stdout/stderr, split Unicode and registered secrets, final unterminated output, no-token final capture, nonzero process status, truthful truncation, and a quiet log follower released by cancellation, EOF, and SIGTERM without another log line. Each process shutdown has a bounded test deadline and unconditional owned-resource teardown. A synthetic `Effect.never` producer is useful unit coverage but MUST NOT substitute for the real provider-read acceptance. Live runs require an explicit answering provider socket and preserve installed roots; missing prerequisites skip local runs and fail explicitly requested end-to-end runs.

**Scenario, recipe, and e2e conventions:** scenarios live as TypeScript under `test/scenarios/`, use public APIs and isolated fixtures, and rely on Scope finalizers. Recipe tests scaffold every `recipes/<id>/` source but do not start apps. E2E tests use the compiled binary, real providers, structured assertions, isolated working directories, and unconditional cleanup. User-facing flows belong in recipes or executable guides; internal regressions belong in test fixtures. The Lando 3 Leia format, bash-block parsing, grep assertions, and its heading grammar are retired with no conversion path.

### 13.2 Schema and documentation gates

The schema snapshot is the complete generated set: public SDK JSON Schemas and index, command-result Schemas and index, and decoded bundled-plugin manifest fixtures. Generated schema and command trees are derived build outputs, not Git sources of truth; committed fixtures receive pure drift checks, while gitignored outputs receive deterministic regeneration and consumer validation.

`check:schema-compatibility` MUST compare head artifacts with artifacts regenerated from the configured base ref in an isolated checkout using that ref's own source and lockfile. A failed baseline materialization fails closed; a base predating a generator is reported as an explicit skipped family. CI MAY cache a verified base regeneration but MUST fall back to regeneration on a miss.

Changes are classified as `compatible`, `breaking`, or `unknown` using explicit input/output polarity. Unaccepted `breaking` and `unknown` changes fail. Exceptions MUST name an exact surface, change kind, JSON path, and justification; wildcards and whole-schema exceptions are forbidden.

Every public schema MUST have canonical annotations, stable JSON Schema output, successful examples, and round-trip tests. Generated schema, command, API, event, service, recipe-action, and error references MUST build without hand edits. The Starlight site MUST build authored Markdown/MDX together with generated references and required public guide transcripts.

### 13.3 Type gates

`tsc --noEmit` MUST pass on every PR. Type-only tests under `test/types/` use `expectTypeOf` to protect inferred schema types, public exports, and Effect requirement narrowing.

### 13.4 Quality gates

A PR cannot merge unless:

- `bun test`, `tsc --noEmit`, and Biome checks pass.
- Codegen pure drift, schema compatibility, schema/docs generation, and the Starlight build pass.
- Provider, plugin-abstraction, library API, machine-output, deprecation, redaction, managed-file, coexistence, scenario, recipe, executable-guide, and applicable renderer/OpenTUI contracts pass.
- `lint:guides`, guide coverage, public transcript, source-mapper, and guide component-schema gates pass (§19).
- The Linux x64 perf suite and e2e smoke pass; per-PR macOS and Windows perf results are advisory but nightly failures block release.
- Scenario and recipe suites pass on every per-PR platform.
- Boundary gates pass through the shared `check:boundaries` surface, with package seams primary and residual AST rules limited to behavior package edges cannot express.
- The `effect-idioms` boundary rule keeps retired Effect forms out of the shared shipped-runtime tier (core, primitive packages, engine, renderer, data-mover, MCP, telemetry, and bundled plugins): `Data.TaggedError` and `Data.Error`; `Date.now()` and `new Date(` in modules that import `effect`; named functions or methods whose body only returns `Effect.gen(...)`; local definitions named `isRecord`, `isPlainObject`, or `isObject`; exports named `*Live`; and imports from `@effect/*`. Those bans have no carve-outs. Cause assembly (`Cause.combine`, `Cause.fromReasons`) is restricted to the engine compensation and SDK command-failure owners; consumers MUST use role-aware helpers.
- Command, service, event, deprecation, export, and package-DAG registry drift checks pass.
- The compiled-decoder parity suite passes whenever the compiled target list, a listed schema, the decoder generator, or the Effect version changes (§12.5.1).
- New CLI or library behavior has scenario coverage; new CLI behavior also has e2e coverage.
- New recipes have recipe and e2e smoke coverage; new schemas have annotations and round-trip coverage.
- Public `@lando/core` or `@lando/sdk` additions have documentation and the corresponding library/schema tests.
- Install/update/uninstall/shellenv changes pass side-by-side coexistence; network-sensitive changes pass offline-after-build coverage.

`bun run codegen:check` is pure drift only. Semantic gates remain separate: `check:guide-coverage`, `check:schema-compatibility`, `check:public-transcripts`, `check:package-dag`, and behavioral boundary rules.

### 13.5 Distribution

Lando ships two synchronized forms:

| Form | Audience | Contract |
|---|---|---|
| Compiled CLI | End users without prerequisites | One bytecode-enabled executable for each of the six targets `darwin-arm64`, `darwin-x64`, `linux-x64`, `linux-arm64`, `windows-x64`, and `windows-arm64` (§2.1), built through §17.3. |
| `@lando/core` library | Bun embedding hosts and package-manager CLI users | ESM entry points from §2.7 plus `package.json#bin`; the bin installs under the side-by-side name `lando4` so an existing Lando 3 `lando` stays untouched (§17.7). |

No OCLIF tarball or third distribution form ships. Both forms use the same native dispatcher, version, schemas, and public contracts.

Bundled plugins and renderer contributions are generated as static imports from the ship list. Bundled recipes are generated from the canonical recipe set; the target architecture embeds complete recipe trees, while the current implementation embeds the generated manifest records. Library consumers opt into bundled plugin and recipe discovery (§16.4).

Runtime bundles and native host helpers are immutable, pinned, checksum-verified, on-demand downloads under Lando-owned data paths; they are not embedded in the main binary. The in-container helper is a build-known asset embedded per Linux architecture (§17.3). CI MUST verify setup against a current-commit local bundle manifest without disabling checksum validation.

Releases include public schema and command-schema artifacts, declaration bundles, and `@lando/sdk`. The docs site combines authored guides with generated schema, API, command, event, and error references; executable-guide behavior follows §19.

### 13.6 CI matrix

| Cadence | Platforms/providers | Required scope |
|---|---|---|
| Per PR: platform matrix | All six compile targets: macOS arm64/x64, Linux x64/arm64, Windows x64/arm64 | Portable static gates, builds, relocated-binary smoke, and scenario guides. Compilation alone is not evidence of live-provider readiness. |
| Per PR: unit and runtime gates | Linux x64 | Sharded unit tests, e2e smoke, and gating performance tests. The platform matrix MUST NOT be reported as full native unit-suite coverage on every target. |
| Nightly | Linux x64/arm64, macOS arm64 | Full e2e against the default managed runtime, all generated e2e guides, release-shaped binaries, library publish rehearsal, and gating platform perf. |
| Weekly | Managed runtime, Docker Desktop/Engine, Podman Desktop/Podman, Lima, OrbStack on applicable hosts | Provider contracts plus full e2e and generated e2e guide scenarios across the provider matrix. |

Scheduled cadences add provider and runtime coverage to the PR gates; a broader compile matrix does not substitute for that live coverage.

The per-PR Linux x64 perf gate MUST also bound TTY renderer process-exit overhead on the compiled artifact: it runs a command that constructs the default renderer both piped and under a PTY, measures whole-process duration through exit, and fails when the TTY median exceeds the piped median by more than 150 ms. This gate adds to the §2.1 startup and first-paint budgets and MUST NOT replace or relax them.

### 13.7 Release flow

- Channels are `stable`, `next`, and `dev`; plugins MAY use independent channels.
- Versioning is strict semver. Core API breaks require a major; plugin SDK compatibility tracks the core major.
- `lando update` follows the active channel and the signed atomic-update protocol in §17.6.
- Every release uses the signing and supply-chain policy in §17.4–§17.5.
- The install surfaces are signed GitHub Release artifacts and the `get.lando.dev` installers (§17.7). Homebrew, scoop, winget, and distro packages are outside this contract; adding one is a §17.7 change, not a channel.
- Plugins publish independently and declare their compatible `@lando/core` range.

### 13.8 Boundary gate substrate

Architecture boundaries run through one shared analysis substrate and the contributor-facing `bun run check:boundaries` command. Stable rule ids remain individually invocable for debugging. Package dependency seams are primary; a new scanner rule requires a documented reason that a seam cannot express the constraint, and every new private package seam MUST retire or shrink a scanner rule. Residual rules MAY enforce behavioral bans such as direct renderer bypass, ad hoc redaction, hand-rolled probes, generated-file ownership, or machine-output encoding outside canonical seams.
