# Lando v4 — Testing, Distribution, and Quality Gates

> **Part 13 of 18** · [Index](./README.md)
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
| Service composition contract | Every `ServiceType` declares a base and resolves through deterministic, provider-neutral core composition. |
| Service feature contract | Every `ServiceFeature` is deterministic, idempotent, priority-ordered, capability-declared, and conflict-safe. |
| App feature contract | Every `AppFeature` selects resolved drafts, runs after service features, remains idempotent, and rejects cycles. |
| Template engine contract | Every engine declares truthful capabilities, preserves context, is deterministic, and performs no undeclared side effects. |
| Host proxy contract | Authentication, exact request union, allowlists, recursion, backpressure, socket ownership, redaction, streaming, and cleanup are enforced. |
| TunnelService contract | Targets, egress, provisioning, scope ownership, detached state, probes, events, and redaction remain within the declared port. |
| File sync engine contract | Capabilities, setup, containment, content fidelity, conflicts, events, cancellation, and pinned-tool ownership are enforced. |
| HttpClient contract | Proxy/CA precedence, schemes, streaming, offline behavior, cancellation, events, and redaction are enforced. |
| Downloader contract | All egress uses `HttpClient`; cache, checksum, size, containment, atomicity, cancellation, and redaction are enforced. |
| Redaction contract | The canonical value and pattern layers produce byte-stable profile output and cannot be weakened by plugins. |
| Interaction contract | Answer precedence, mode selection, validation, secret handling, cancellation, dynamic choices, and renderer routing are enforced. |
| Renderer frames | Headless snapshots cover task trees, prompts, narrow terminals, and resize behavior without asserting machine renderers. |
| Renderer capability contract | Every renderer reports the complete immutable capability shape for TTY, non-TTY, degraded, and promoted states. |
| Renderer panel contract | Manifest validation precedes isolated loading; bounded, deterministic rendering fails only the offending panel and preserves last-good output. |
| Subscriber selector and config-projection contract | Selectors close over the canonical event registry; indexes are prebuilt, factories lazy, and config projections bounded. |
| Keymap schema and conflict-check split contract | Raw key syntax decodes independently from same-surface collision detection; cross-surface reuse remains legal. |
| Desktop notification bounds contract | Notification fields validate before publication and sanitization precedes presentation. |
| HostProxy exact-union contract | `HostProxyRequest` contains exactly `openUrl`, `openPath`, `runLando`, and `runBun`. |
| OpenTUI native one-of-eight pruning contract | Each release target embeds one matching native package and stubs the other seven without redirecting testing or relative imports. |
| SDK compatibility/schema-snapshot artifact-set contract | The additive SDK inventory and every schema-backed surface match `sdk/API_COMPATIBILITY.md` and generated artifacts. |
| Tooling engine contract | Engines execute dependency-ordered programs, cancel children, publish redacted events, honor up-to-date checks, and tag failures. |
| Route filter contract | Filters are pure, deterministic, idempotent, provider-neutral, capability-truthful, and stably ordered. |
| Secret store contract | Resolution is read-only, offline-safe when cached, tagged on failure, and registered with the canonical redactor. |
| Config translator contract | Translators are explicit, pure, deterministic, fragment-only, schema-valid, and round-trip when encoding is supported. |
| RecipeDecomposer contract | Option errors, recipe identity, fragment output, side-effect absence, port closure, and secret exclusion are enforced. |
| Managed-file transaction recovery | Failure injection covers every journal state, concurrent edits, cancellation, orphan stages, and dry-run immutability. |
| Side-by-side coexistence | Install, update, uninstall, and shellenv preserve hostile and valid Lando 3 binaries and state byte-for-byte. |
| Plugin source contract | Sources resolve contained package roots, honor network policy and locks, redact credentials, and fail with remediation. |
| Doctor check contract | Checks are read-only by default, return structured issues and solutions, use bounded ports, and redact transcripts. |
| RemoteSource contract | Remote capabilities, environment resolution, controlled egress, scoped transfers, dataset delegation, protection, probes, and redaction are enforced. |
| Dataset contract | Capture/apply round-trip through `DataMover`, destructive apply is declared, credentials avoid argv, and bindings stay contained. |
| Managed-file contract | Plan/apply parity, atomic replacement, containment, ownership markers, ledger integrity, adoption, release, and redaction are enforced. |
| Plugin SDK contract | Type and runtime tests protect the public plugin-author surface. |
| Machine-output conformance | Every non-interactive canonical command emits schema-valid envelopes or streams with correct ids, status, and redaction. |
| Scenario | Public library APIs run end-to-end against `TestRuntimeProvider` without real container, network, or host mutation. |
| Recipe | Every canonical recipe scaffolds with defaults and representative branches into schema-valid output. |
| Executable guides | §19 MDX generates source-mapped scenario tests and visibility-separated transcripts for every applicable variant. |
| Deprecation | Every notice records use, publishes `deprecation-used`, warns once, appears in doctor, and obeys `removeIn`. |
| Perf budget | Compiled-artifact tests enforce §2.1 end-to-end, first-paint, hot-path, concurrency, and runtime-reuse budgets. |
| End-to-end | The relocated compiled binary runs against real operating systems, providers, plugins, routes, files, and offline-after-build state. |

**Effect testing rules:** tests MUST inject mocks with Layers, provide them per test, use `TestClock` and `TestRandom` for nondeterminism, and feed stream services with deterministic Streams. Tests MUST NOT patch globals.

**Provider contract suite:** every provider plugin MUST prove capability truthfulness, idempotent `apply`, complete `destroy`, tagged missing-service errors, terminating log Streams, capability-correct mount/endpoint/storage/route behavior, actionable remediation, and rollback on interruption. Bundled providers MUST run the same suite; no provider-specific substitute is acceptable.

**Plugin-abstraction coverage:** every shared `@lando/sdk/test` contract kit in §4.2 MUST have a canonical built-in invocation in the owning package. Coverage MUST fail when a suite or invocation disappears. Reference transforms are permitted only where no bundled implementation exists.

**Library API contract suite:** the default entry MUST remain free of CLI-framework imports; documented entries and service tags MUST be exported; CLI and library paths MUST publish the same lifecycle sequence; discovery policy MUST honor each source independently; runtime instances MUST be isolated; `App` handles MUST remain root-bound; Scope ownership MUST finalize resources; retained runtimes MUST perform bootstrap work once and meet hot-path budgets; errors MUST retain typed payloads and remediation.

**Command registry contract:** implemented and deferred command ids MUST partition the canonical registry. Every implemented id is reachable, every deferred id yields the catalogued `NotImplementedError`, and relocated compiled smoke tests MUST validate representative exit codes, tagged errors, and machine envelopes. Dual-dispatch parity is not a test layer.

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
- Command, service, event, deprecation, export, and package-DAG registry drift checks pass.
- New CLI or library behavior has scenario coverage; new CLI behavior also has e2e coverage.
- New recipes have recipe and e2e smoke coverage; new schemas have annotations and round-trip coverage.
- Public `@lando/core` or `@lando/sdk` additions have documentation and the corresponding library/schema tests.
- Install/update/uninstall/shellenv changes pass side-by-side coexistence; network-sensitive changes pass offline-after-build coverage.

`bun run codegen:check` is pure drift only. Semantic gates remain separate: `check:guide-coverage`, `check:schema-compatibility`, `check:public-transcripts`, `check:package-dag`, and behavioral boundary rules.

### 13.5 Distribution

Lando ships two synchronized forms:

| Form | Audience | Contract |
|---|---|---|
| Compiled CLI | End users without prerequisites | One bytecode-enabled executable for `darwin-arm64`, `darwin-x64`, `linux-x64`, `linux-arm64`, and `windows-x64`, built through §17.3. |
| `@lando/core` library | Bun embedding hosts and package-manager CLI users | ESM entry points from §2.7 plus `package.json#bin`; Alpha/Beta installs the CLI as `lando4` beside untouched Lando 3. |

No OCLIF tarball or third distribution form ships. Both forms use the same native dispatcher, version, schemas, and public contracts.

Bundled plugins and renderer contributions are generated as static imports from the ship list. Bundled recipes are generated from the canonical recipe set; the target architecture embeds complete recipe trees, while the current implementation embeds the generated manifest records. Library consumers opt into bundled plugin and recipe discovery (§16.4).

Runtime bundles and native helpers are immutable, pinned, checksum-verified, on-demand downloads under Lando-owned data paths; they are not embedded in the main binary. CI MUST verify setup against a current-commit local bundle manifest without disabling checksum validation.

Releases include public schema and command-schema artifacts, declaration bundles, and `@lando/sdk`. The docs site combines authored guides with generated schema, API, command, event, and error references; executable-guide behavior follows §19.

### 13.6 CI matrix

| Cadence | Platforms/providers | Required scope |
|---|---|---|
| Per PR | macOS arm64, Linux x64/arm64, Windows x64 | All fast layers and quality gates; scenario guides everywhere; e2e smoke and gating perf on Linux x64. |
| Nightly | Linux x64/arm64, macOS arm64 | Full e2e against the default managed runtime, all generated e2e guides, release-shaped binaries, library publish rehearsal, and gating platform perf. |
| Weekly | Managed runtime, Docker Desktop/Engine, Podman Desktop/Podman, Lima, OrbStack on applicable hosts | Provider contracts plus full e2e and generated e2e guide scenarios across the provider matrix. |

Each cadence is a scope superset of the preceding cadence.

### 13.7 Release flow

- Channels are `stable`, `next`, and `dev`; plugins MAY use independent channels.
- Versioning is strict semver. Core API breaks require a major; plugin SDK compatibility tracks the core major.
- `lando update` follows the active channel and the signed atomic-update protocol in §17.6.
- Every release uses the signing and supply-chain policy in §17.4–§17.5.
- v4.0 installs through GitHub Releases and `get.lando.dev`; Homebrew, scoop, winget, and distro packages are deferred (§17.7).
- Plugins publish independently and declare their compatible `@lando/core` range.

### 13.8 Boundary gate substrate

Architecture boundaries run through one shared analysis substrate and the contributor-facing `bun run check:boundaries` command. Stable rule ids remain individually invocable for debugging. Package dependency seams are primary; a new scanner rule requires a documented reason that a seam cannot express the constraint, and every new private package seam MUST retire or shrink a scanner rule. Residual rules MAY enforce behavioral bans such as direct renderer bypass, ad hoc redaction, hand-rolled probes, generated-file ownership, or machine-output encoding outside canonical seams.
