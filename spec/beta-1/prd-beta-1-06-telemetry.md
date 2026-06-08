# PRD: BETA1-06 — Telemetry

## Introduction

Telemetry (§2.4, §3.4, §4.2, §16.3, §17.6.3, and §18.1 through §18.6) turns the existing `Telemetry` service contract into a real runtime capability. Beta 1 ships a fire-and-forget transport, a documented event inventory, redaction rules, retention policy, default-on CLI behavior, library-mode default-off behavior, user opt-out controls, and first wired events for update outcomes and deprecated surface use.

Depends on: **BETA1-03** (deprecation governance publishes `deprecation-used` and the consumption path this PRD records). PRD-02 closes the adjacent §14.2 telemetry decision; this PRD ships the inventory, redaction, transport, and controls.

## Source References

- [`spec/02-toolchain.md`](../02-toolchain.md) §2.4 telemetry fire-and-forget rule.
- [`spec/03-architecture.md`](../03-architecture.md) §3.4 core Effect services table.
- [`spec/04-pluggability.md`](../04-pluggability.md) §4.2 replaceable service catalog.
- [`spec/09-embedding.md`](../09-embedding.md) §16.3 library-mode defaults and opt-out.
- [`spec/15-binary-build-and-release.md`](../15-binary-build-and-release.md) §17.6.3 update telemetry.
- [`spec/16-deprecation-and-surface-evolution.md`](../16-deprecation-and-surface-evolution.md) §18.1 through §18.4 and §18.6 deprecation telemetry eligibility.

## Goals

- Replace the current no-op telemetry runtime wiring with a fire-and-forget transport and sink.
- Flip CLI mode to telemetry default-on while keeping library mode default-off unless an embedding host opts in.
- Publish the canonical telemetry event inventory, allowed fields, redaction rules, retention policy, and disablement controls in-repo.
- Ensure plugins only contribute telemetry sinks through the `Telemetry` service and can never bypass disablement.
- Record update outcomes and `deprecation-used` events without paths, hostnames, user IDs, or other stable personal identifiers.

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

## Non-Goals

- Building a public analytics dashboard in Beta 1.
- Persisting telemetry queues across process restarts.
- Adding telemetry to every command in the CLI surface during this PRD.
- Collecting per-user, per-host, per-app, or per-project stable identifiers.
- Allowing plugins to open independent network telemetry channels from Lando runtime hooks.

## Technical Considerations

- Existing named identifiers already exist: `Telemetry` in `sdk/src/services/cli.ts`, the services barrel export, `GlobalConfig.telemetry.enabled`, the env overlay in `core/src/services/config.ts`, the runtime option in `core/src/runtime/layer.ts`, and the no-op library stub in `core/src/runtime/bootstrap-layer-support.ts`.
- The implementation should keep telemetry construction off the level-`none` first-byte path and should avoid static imports that violate the hot-path rules in `core/src/cli/index.ts` and the pre-renderer.
- The library-mode no-op stub remains valid when hosts do not opt in, but CLI bootstrap layers should provide the real service once default resolution enables it.
- Redaction should run before buffering and before plugin sink dispatch so no disabled or failed sink can observe raw payloads.
- The event inventory should be machine-readable enough for tests to compare recorded event names and fields against it.

## Success Metrics

- A telemetry endpoint outage during `lando update` produces the same user-visible output and exit code as the same update with telemetry disabled.
- `LANDO_CONFIG__TELEMETRY__ENABLED=0` results in zero sink calls and zero outbound transport attempts in transport tests.
- Privacy tests prove update outcome events contain no paths, hostnames, user IDs, raw URLs, or raw errors.

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
