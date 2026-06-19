# PRD: BETA1-06 — Telemetry & redaction

## Introduction

Telemetry (§2.4, §3.4, §4.2, §16.3, §17.6.3, and §18.1 through §18.6) turns the existing `Telemetry` service contract into a real runtime capability. Beta 1 ships a fire-and-forget transport, a documented event inventory, redaction rules, retention policy, default-on CLI behavior, library-mode default-off behavior, user opt-out controls, and first wired events for update outcomes and deprecated surface use.

The canonical event inventory is published at [`docs/telemetry/events.md`](../../docs/telemetry/events.md), backed by the machine-readable source of truth in [`core/src/telemetry/inventory.ts`](../../core/src/telemetry/inventory.ts) and enforced by the `check:telemetry-inventory` gate.

Depends on: **BETA1-03** (deprecation governance publishes `deprecation-used` and the consumption path this PRD records). This PRD owns and closes the §14.2 telemetry decision (event inventory, redaction rules, retention, defaults, and disablement controls); PRD-02 closes the other §14.2 decisions (Bun floor, OCLIF, auto-setup, Compose subset, sshAgent, plugin trust).

This PRD also absorbs the canonical secret/PII redaction primitive. Redaction lives here because telemetry owns the machine-readable event inventory, the allowlist scrub, and the privacy contract that no sink observes raw payloads; the shared `@lando/sdk/secrets` primitive and core `RedactionService` make that contract reusable across logs, events, transcripts, and downloader events.

Redaction work keeps its external dependencies on **BETA1-04** (schema publication), **BETA1-07** (executable guides public-transcript redaction), and **BETA1-09** (Downloader events composing the canonical redactor). The downstream **BETA1-11** SDK/library acceptance suite validates the exported surface.

## Source References

- [`spec/02-toolchain.md`](../02-toolchain.md) §2.4 telemetry fire-and-forget rule.
- [`spec/03-architecture.md`](../03-architecture.md) §3.4 core Effect services table.
- [`spec/04-pluggability.md`](../04-pluggability.md) §4.2 replaceable service catalog.
- [`spec/09-embedding.md`](../09-embedding.md) §16.3 library-mode defaults and opt-out.
- [`spec/15-binary-build-and-release.md`](../15-binary-build-and-release.md) §17.6.3 update telemetry.
- [`spec/16-deprecation-and-surface-evolution.md`](../16-deprecation-and-surface-evolution.md) §18.1 through §18.4 and §18.6 deprecation telemetry eligibility.

### Redaction source references

- [`spec/03-architecture.md`](../03-architecture.md) §3.4 `RedactionService` service membership and §3.7 secret-redaction policy (value/pattern layers, profiles, sentinel, ordering, non-pluggability).
- [`spec/04-pluggability.md`](../04-pluggability.md) §4.2 redaction is a non-replaceable security invariant (no `redactors:` surface).
- [`spec/09-embedding.md`](../09-embedding.md) §16.2 `@lando/core/secrets` re-export and the `RedactionService` tag on the embedding surface.
- [`spec/02-toolchain.md`](../02-toolchain.md) §2.7 `./secrets` entry point.
- [`spec/13-testing-and-distribution.md`](../13-testing-and-distribution.md) §13.1 redaction contract suite and §13.4 redaction-boundary gate.
- [`spec/07-landofile-and-config.md`](../07-landofile-and-config.md) §7.3.1 `${secret:…}` redaction rules.
- [`spec/17-executable-tutorials.md`](../17-executable-tutorials.md) §19.6 transcript redaction list and golden frame.
- [`spec/beta-1/prd-beta-1-00-index.md`](./prd-beta-1-00-index.md) verification contract and SDK/schema rules.

## Goals

- Replace the current no-op telemetry runtime wiring with a fire-and-forget transport and sink.
- Flip CLI mode to telemetry default-on while keeping library mode default-off unless an embedding host opts in.
- Publish the canonical telemetry event inventory, allowed fields, redaction rules, retention policy, and disablement controls in-repo.
- Ensure plugins only contribute telemetry sinks through the `Telemetry` service and can never bypass disablement.
- Record update outcomes and `deprecation-used` events without paths, hostnames, user IDs, or other stable personal identifiers.

### Redaction goals

- Publish one canonical redaction primitive in `@lando/sdk/secrets`: a value layer, a fixed pattern-class catalog, three profiles (`secrets`, `telemetry`, `transcript`), the canonical `[redacted]` sentinel, and a deep `redactValue` walker — all pure and dependency-free.
- Ship a thin core `RedactionService` that supplies the live secret set (resolved `${secret:…}` values, token env, per-call tokens) and exposes `forProfile(profile)`.
- Wire every surface that emits potentially-sensitive output so it "observes redacted forms only", closing the §3.4 runner/event gap.
- Migrate all four existing redactors onto the primitive and reconcile the sentinel to `[redacted]`.
- Add a mandatory redaction contract suite and a merge-blocking redaction-boundary lint gate so no surface re-grows its own redaction.

## User Stories

### US-237: `Telemetry` transport and sink implementation

**Description:** As the runtime, I need `Telemetry.record(event, data)` to enqueue allowed telemetry without blocking command completion, process exit, or shutdown.

**Acceptance Criteria:**

- [ ] `core/src/**/telemetry*.ts` or an equivalent telemetry module implements the `Telemetry` Live Layer and replaces the minimal bootstrap no-op stub in CLI mode.
- [ ] `Telemetry.enabled` reflects the resolved runtime setting and `record(event, data)` returns immediately after local validation and enqueue.
- [ ] Endpoint failures, sink failures, DNS failures, timeouts, and process-exit races never change the command exit code.
- [ ] Pending telemetry is best-effort flushed only within a bounded budget and is dropped rather than delaying process shutdown.
- [ ] Plugin-contributed sinks are invoked only through the `Telemetry` service and receive no calls when telemetry is disabled.
- [ ] Tests pass.
- [ ] Typecheck passes.
- [ ] Lint passes.

### US-238: Documented telemetry event inventory

**Description:** As a maintainer or privacy reviewer, I need one in-repo inventory that lists every telemetry event, allowed field, source, and owner.

**Acceptance Criteria:**

- [ ] A canonical telemetry inventory document is published under `docs/` or `spec/` and linked from the generated reference docs where appropriate.
- [ ] The inventory lists event names, field names, field types, allowed values, owning package, source trigger, and whether the event is CLI-only or library-eligible.
- [ ] Initial inventory includes update outcomes and `deprecation-used` events, plus any always-on runtime health events needed by the transport.
- [ ] A lint or test gate fails when code records an event not present in the inventory.
- [ ] Event additions require an explicit inventory diff in the same PR.
- [ ] Tests pass.
- [ ] Typecheck passes.
- [ ] Lint passes.

### US-239: Redaction rules and retention policy

**Description:** As a user, I need telemetry to exclude sensitive identifiers and to have a written retention policy before emission is enabled by default.

**Acceptance Criteria:**

- [ ] A shared redaction layer rejects or removes paths, hostnames, usernames, user IDs, app names, project names, email addresses, tokens, secrets, raw command arguments, and raw error messages.
- [ ] Redaction tests cover POSIX paths, Windows paths, hostnames, URLs with credentials, UUID-like identifiers, home-directory aliases, and nested telemetry payloads.
- [ ] Update telemetry fields are constrained to version, target, channel, platform, and outcome category.
- [ ] The retention policy states what is retained, where it is retained, who can access it, and when aggregated and raw data are deleted.
- [ ] The policy is linked from telemetry docs, opt-out command output, and the event inventory.
- [ ] Tests pass.
- [ ] Typecheck passes.
- [ ] Lint passes.

### US-240: CLI default-on and library default-off precedence

**Description:** As a CLI user or embedding host, I need telemetry defaults to match the shell I am using and to resolve controls predictably.

**Acceptance Criteria:**

- [ ] CLI mode defaults telemetry to enabled when no flag, env var, config key, or runtime option overrides it.
- [ ] Library mode defaults telemetry to disabled unless `makeLandoRuntime` or equivalent runtime construction opts in.
- [ ] Precedence is `flag > env > config > default`, with runtime option `telemetry` treated as the library-mode host decision before default resolution.
- [ ] `GlobalConfig.telemetry.enabled` flips from its current `false` default to the CLI default-on behavior without changing the library-mode default-off contract.
- [ ] `LANDO_CONFIG__TELEMETRY__ENABLED=0` and equivalent false values disable emission before any sink is constructed.
- [ ] Tests pass.
- [ ] Typecheck passes.
- [ ] Lint passes.

### US-241: Opt-out controls

**Description:** As a user, I need first-class controls to disable telemetry through config, environment, and a documented CLI surface.

**Acceptance Criteria:**

- [ ] `telemetry.enabled` in `GlobalConfig` disables telemetry for future CLI runs when set to `false`.
- [ ] `LANDO_CONFIG__TELEMETRY__ENABLED=0` disables telemetry for the current process and takes precedence over config.
- [ ] A first-class CLI command or flag disables telemetry and writes the same `GlobalConfig` key; default command id is `meta:config telemetry off` until the Open Question is closed.
- [ ] The opt-out surface reports the current effective telemetry state and the source that selected it: flag, env, config, or default.
- [ ] Disabling telemetry prevents local buffering, plugin sink invocation, and outbound transport attempts.
- [ ] Tests pass.
- [ ] Typecheck passes.
- [ ] Lint passes.

### US-242: Update outcome and `deprecation-used` telemetry wiring

**Description:** As a maintainer, I need update outcomes and deprecated surface use to be visible through the same telemetry pipeline without adding a second reporting path.

**Acceptance Criteria:**

- [ ] `lando update` records outcome categories `success`, `signature_failure`, `launch_probe_failure`, `permission_failure`, and `network_failure`.
- [ ] Update telemetry includes only version, target version, channel, platform, and outcome category.
- [ ] Update telemetry never includes paths, hostnames, usernames, user IDs, app IDs, install directories, raw URLs, raw errors, or command arguments.
- [ ] `deprecation-used` events from `DeprecationService` are consumed through `Telemetry.record` with event data allowed by the inventory.
- [ ] Telemetry-disabled runs emit neither update outcome events nor deprecation telemetry, while normal deprecation renderer and doctor behavior remains unchanged.
- [ ] Tests pass.
- [ ] Typecheck passes.
- [ ] Lint passes.

The following stories are folded in from the Redaction primitive scope.

### US-298: Publish the canonical redaction primitive in `@lando/sdk/secrets`

**Description:** As a plugin author or embedding host, I can redact log/diagnostic output with exactly the coverage core uses, by importing one pure primitive instead of copying regexes.

**Acceptance Criteria:**

- [ ] `@lando/sdk/secrets` exports `createRedactor(profile, options)` returning `{ redactString, redactValue }`, the existing `createSecretRedactor(values)` as the value layer it composes, the `RedactionProfile` literal (`secrets | telemetry | transcript`), the canonical pattern-class catalog, and the `REDACTED` (`[redacted]`) sentinel.
- [ ] The value layer masks known values by literal match, longest-first, and `createRedactor` always applies it before the pattern layer; a registered secret split across a pattern boundary never survives.
- [ ] The `secrets` profile covers `secretAssignment`, `urlUserinfo`, `bearerToken`, `signedQueryParam`, and `secretKeyedField` (object key-name masking via `redactValue`) and emits the `[redacted]` sentinel.
- [ ] The `telemetry` profile additionally applies the normalizing classes with `[path]`/`[url]`/`[host]`/`[email]`/`[id]` placeholders; the `transcript` profile applies the deterministic `<HOME>`/`<TMP>`/`<PORT>`/`<CONTAINER_ID>`/`<DIGEST>`/`<PROVIDER_ID>`/`<USER>`/`<HOST>` placeholders.
- [ ] `redactValue` preserves array/object/`Error` shape, masks `secretKeyedField` keys, and never throws on cyclic or exotic input.
- [ ] The module stays pure and dependency-free (no `@lando/core`, no Effect runtime, no Node/Bun IO) so the telemetry hot-enqueue path and the docs build use it without constructing a runtime.
- [ ] `@lando/core/secrets` re-exports `@lando/sdk/secrets`; `sdk/API_COMPATIBILITY.md`, SDK export fixtures, and any schema/snapshot fixtures are updated in the same change.
- [ ] Tests pass.
- [ ] Typecheck passes.
- [ ] Lint passes.

### US-299: Implement `RedactionService` and wire the emitting surfaces

**Description:** As the runtime, every surface that writes to logs, events, telemetry, or transcripts observes redacted forms only, using one live secret set.

**Acceptance Criteria:**

- [ ] `core/src/**` implements `RedactionService` at bootstrap level `minimal`, backed by the pure `@lando/sdk/secrets` functions, exposing `forProfile(profile) → Redactor`.
- [ ] The service builds the live value set from the active `SecretStore` resolutions, known token env (`BUN_AUTH_TOKEN`, scoped `_authToken`, resolved proxy credentials), and per-call `redact:` tokens.
- [ ] `ProcessRunner`, `ShellRunner`, and `BunSelfRunner` redact command shape, env, and stdout/stderr summaries through the `secrets` profile before they reach the `Logger` or `EventService`; the `pre-/post-process-exec`, `pre-/post-shell-exec`, and `pre-/post-bun-self-exec` payloads observe redacted forms only.
- [ ] `BuildOrchestrator` and `HostProxyService` payloads and the CLI failure formatter route through the `secrets` profile.
- [ ] `RedactionService` construction touches no network, provider, or plugin module, and stays off the level-`none` first-byte path.
- [ ] A test proves a resolved `${secret:…}` value injected into a command does not appear in the published lifecycle event or the rendered log.
- [ ] Tests pass.
- [ ] Typecheck passes.
- [ ] Lint passes.

### US-300: Migrate existing redactors onto the primitive and reconcile the sentinel

**Description:** As a maintainer, I can reason about one redaction implementation instead of four near-duplicate ones with three sentinels.

**Acceptance Criteria:**

- [ ] `core/src/cli/redact.ts` delegates `redactString` / `redactDetails` / `redactedErrorDetails` to `@lando/sdk/secrets` `createRedactor("secrets")` (names may remain as thin shims for existing callers in `bug-report`, `doctor-subsystems`, `setup-readiness`, `scenario-context`).
- [ ] `core/src/telemetry/redaction.ts` `scrubTelemetryValue` delegates to `createRedactor("telemetry").redactString`; `redactTelemetryData` keeps the event-inventory allowlist in core and composes the shared scrub.
- [ ] `core/src/docs/render/redaction.ts` delegates path/secret classes to `createRedactor("transcript", { env })`, keeps the frame walker and env defaults, and drops the local regex copies and the redundant final `redactString` compose.
- [ ] `plugins/provider-lando/src/redact.ts` imports `redactString` / `redactDetails` from `@lando/sdk/secrets`; only `withApiReason` (provider-specific JSON-body parsing) remains, composing the shared function.
- [ ] The canonical sentinel is `[redacted]` everywhere; updated snapshots, golden frames, and bug-report/transcript fixtures reflect the reconciliation, and the `transcript` placeholder vocabulary stays byte-stable.
- [ ] No secret-matching regex or sentinel literal remains outside `@lando/sdk/secrets` (verified by US-301's gate).
- [ ] Tests pass.
- [ ] Typecheck passes.
- [ ] Lint passes.

### US-301: Redaction contract suite and merge-blocking redaction-boundary gate

**Description:** As a maintainer or security reviewer, I can prove every profile and every composing surface preserves the redaction guarantees, and that nobody re-grows ad-hoc redaction.

**Acceptance Criteria:**

- [ ] `@lando/sdk/test` exports a redaction contract suite that runs a canonical "secret soup" fixture (env assignments, `user:pass@` URLs, bearer tokens, signed-URL query params, POSIX/Windows/UNC paths, home aliases, container ids, UUIDs, high-entropy tokens, and a registered literal secret) and asserts byte-identical output per profile against golden frames.
- [ ] The suite asserts value-layer-before-pattern ordering, longest-first masking, structure-preserving `redactValue`, and that an audited/sandboxed `ShellRunner` / `BunSelfRunner` / `HostProxyService` / `FileSyncEngine` / `Downloader` cannot weaken the sentinel, value-set, or pattern coverage.
- [ ] `scripts/check-redaction-boundary.ts` (wired into CI static checks via `bun run check:redaction-boundary`) fails on new `[redacted]` / `[REDACTED]` string literals and ad-hoc secret-matching regexes under `core/src/**` and `plugins/**` outside `@lando/sdk/secrets`.
- [ ] The §19.6 transcript redaction gate is aligned to assert the `transcript` profile is the source of the published redaction list.
- [ ] The gates are wired into the merge-blocking §13.4 path.
- [ ] Tests pass.
- [ ] Typecheck passes.
- [ ] Lint passes.

## Functional Requirements

- FR-1: `Telemetry` MUST remain the only runtime API for recording telemetry; plugins MUST NOT bypass it with their own transport.
- FR-2: Telemetry emission MUST be fire-and-forget and MUST NOT block process exit, hang shutdown, or change exit code on transport failure.
- FR-3: CLI mode MUST default telemetry to enabled; library mode MUST default telemetry to disabled unless the host opts in.
- FR-4: Disablement controls MUST include `GlobalConfig.telemetry.enabled`, `LANDO_CONFIG__TELEMETRY__ENABLED`, and one first-class CLI command or flag.
- FR-5: Precedence MUST be `flag > env > config > default`.
- FR-6: A canonical event inventory MUST list every event and field before code can record it.
- FR-7: Redaction MUST reject or remove paths, hostnames, user IDs, usernames, app names, project names, secrets, raw errors, and raw command arguments.
- FR-8: Update telemetry MUST record only version, target, channel, platform, and outcome category.
- FR-9: `deprecation-used` telemetry MUST be recorded through the `Telemetry` service, not through a parallel deprecation reporter.

### Redaction functional requirements

- FR-1: There MUST be exactly one redaction implementation; it lives in `@lando/sdk/secrets` and is surfaced through the core `RedactionService`.
- FR-2: The value layer MUST run before the pattern layer and mask known values longest-first.
- FR-3: Every surface emitting to `Logger`, `EventService`, `Telemetry`, build/doctor/guide transcripts, or the CLI failure formatter MUST route through the canonical redactor.
- FR-4: `@lando/sdk/secrets` MUST stay pure and dependency-free so telemetry and the docs build redact without a runtime.
- FR-5: Redaction is NOT a plugin abstraction; there is no `redactors:` contribution surface, and composing surfaces MUST NOT weaken it.
- FR-6: The canonical sentinel MUST be `[redacted]`; the `transcript` placeholder vocabulary MUST be byte-stable and gated.
- FR-7: A merge-blocking lint gate MUST forbid ad-hoc redaction outside `@lando/sdk/secrets`.

## Non-Goals

- Building a public analytics dashboard in Beta 1.
- Persisting telemetry queues across process restarts.
- Adding telemetry to every command in the CLI surface during this PRD.
- Collecting per-user, per-host, per-app, or per-project stable identifiers.
- Allowing plugins to open independent network telemetry channels from Lando runtime hooks.

### Redaction non-goals

- Adding encryption, hashing-for-correlation, or reversible tokenization of secrets.
- Making redaction user-configurable beyond the per-call `redact:` token set and the existing `SecretStore` resolution.
- Redacting the alt-screen full-tail diagnostic view, which reads the unredacted local transcript file by design (§8.9.2).
- Introducing a `redactors:` plugin contribution surface.

## Technical Considerations

- Existing named identifiers already exist: `Telemetry` in `sdk/src/services/cli.ts`, the services barrel export, `GlobalConfig.telemetry.enabled`, the env overlay in `core/src/services/config.ts`, the runtime option in `core/src/runtime/layer.ts`, and the no-op library stub in `core/src/runtime/bootstrap-layer-support.ts`.
- The implementation should keep telemetry construction off the level-`none` first-byte path and should avoid static imports that violate the hot-path rules in `core/src/cli/index.ts` and the pre-renderer.
- The library-mode no-op stub remains valid when hosts do not opt in, but CLI bootstrap layers should provide the real service once default resolution enables it.
- Redaction should run before buffering and before plugin sink dispatch so no disabled or failed sink can observe raw payloads.
- The event inventory should be machine-readable enough for tests to compare recorded event names and fields against it.

### Redaction technical considerations

- Keep the telemetry event-inventory allowlist in `core/src/telemetry/redaction.ts`; the primitive owns string redaction, the inventory owns field allowlisting.
- Keep the public-transcript frame walker and `RedactionEnvironment` defaults in `core/src/docs/render/redaction.ts`; only the inner string scrub moves to the primitive.
- The sentinel reconciliation is the one behavior change with snapshot blast radius — isolate it to US-300 and sweep fixtures in the same PR.
- Order matters within the pattern layer (URLs and emails before bare hostnames, paths before the token sweep); preserve the existing ordering when consolidating.
- Provide a `RedactionService` test fixture so surface tests can assert redacted output without resolving real secrets.

## Success Metrics

- A telemetry endpoint outage during `lando update` produces the same user-visible output and exit code as the same update with telemetry disabled.
- `LANDO_CONFIG__TELEMETRY__ENABLED=0` results in zero sink calls and zero outbound transport attempts in transport tests.
- Privacy tests prove update outcome events contain no paths, hostnames, user IDs, raw URLs, or raw errors.

### Redaction success metrics

- Grepping `core/src` and `plugins` shows zero secret-matching regexes and zero `[redacted]`/`[REDACTED]` literals outside `@lando/sdk/secrets`.
- A single contract suite validates all three profiles and the composing surfaces.
- A resolved `${secret:…}` value never appears in any lifecycle event payload, rendered log, telemetry record, or transcript across the test matrix.

## Guide Coverage

Per [PRD-12 US-198](../alpha-3/prd-alpha-3-12-executable-guides.md) (`## Guide Coverage` convention) and [US-199](../alpha-3/prd-alpha-3-12-executable-guides.md) (drift gate), this PRD owns the executable guides listed below. Each guide exercises the happy path of its mapped user story; failure modes remain covered by unit and integration tests in the named packages. PRs that touch the listed surface paths MUST also touch the corresponding guide(s), or use the `Guide-Coverage-Skip:` escape hatch.

**Guides owned by this PRD:**

| User Story | Feature | Guide Path | Acceptance |
|---|---|---|---|
| US-240 | CLI default-on and library default-off telemetry behavior | `docs/guides/telemetry/defaults-and-precedence.mdx` | Required at story acceptance |
| US-241 | Telemetry opt-out controls | `docs/guides/telemetry/disable-telemetry.mdx` | Required at story acceptance |
| US-242 | Update outcome and deprecation telemetry visibility | `docs/guides/telemetry/update-and-deprecation-events.mdx` | Required at story acceptance |

**CLI / source surface paths covered (drift gate input):**

- `sdk/src/services/cli.ts`
- `sdk/src/services/index.ts`
- `sdk/src/schema/config.ts`
- `core/src/telemetry/**`
- `core/src/services/config.ts`
- `core/src/runtime/**`
- `core/src/cli/commands/**`
- `core/src/cli/deferred-commands.ts`
- `core/src/update/**`
- `core/src/deprecation/**`
- `plugins/*/src/**`
- `docs/telemetry/**`

## Open Questions

- What is the canonical opt-out command id: `meta:config telemetry off`, `meta:telemetry:disable`, or `telemetry off`? Default: `meta:config telemetry off`, because it writes a global config key and keeps config ownership clear.
- Should the telemetry inventory live under `docs/telemetry/` or `spec/`? Default: `docs/telemetry/events.md` with a `spec/` link, because users need to read it.
- Should the first Beta 1 sink target the production endpoint or a staging endpoint until `next` stabilizes? Default: staging for the first beta, promoted by release config when accepted.
- How long should raw telemetry be retained before aggregation only? Default: 30 days raw, 13 months aggregate.

### Redaction open questions

- Should `@lando/core` expose the redactor as `@lando/core/secrets` (re-export) or only via the `RedactionService` tag? Default: ship both — the pure re-export for hosts that want runtime-free redaction, the service for profile-driven redaction wired to the active `SecretStore`.
- Should the `transcript` profile's placeholder vocabulary be published as a separate named contract from the `secrets`/`telemetry` profiles? Default: keep all three profiles in `@lando/sdk/secrets`; the transcript redaction list referenced by §19.6 is derived from the `transcript` profile rather than maintained separately.
- Should per-call `redact:` tokens be normalized (trimmed/deduped) before masking? Default: yes, reuse `createSecretRedactor`'s empty/whitespace filtering so a stray empty token never masks the whole string.
