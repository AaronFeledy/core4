# PRD: BETA1-12 — Service log sources (`logs:`)

## Introduction

Beta 1 adds the last new SDK surface of the feature wave: **declared service log sources**. Today `lando logs <service>` only shows what `RuntimeProvider.logs` captures — the container's PID-1 stdout/stderr — because that is all the engine's native log API sees. Many services write their real logs to **files inside the container** (an Apache/nginx error log, a MySQL slow-query log, a Symfony/Laravel application log) that never reach stdout, so `lando logs` shows nothing useful for them. There is no way, anywhere in the service-type contract, the common service schema, or the Landofile, to tell Lando where those logs live.

This PRD implements the §6.14 primitive. A **log source** is a declarative statement — owned by a service type, or attached ad-hoc by a user — that a service also produces logs at an in-container path, plus how Lando should surface them. Core reifies each source by one of two capability-gated strategies: **`redirect`** (preferred, for Lando-built images: point the daemon's log path at `/dev/stdout`/`/dev/stderr` at build time so the lines flow through the existing console stream with zero runtime cost) or **`follow`** (fallback, for bring-your-own images and non-redirectable logs: the provider follows the file inside `RuntimeProvider.logs` with defined rotation/framing/finite-vs-follow semantics). The implicit `console` source is unchanged; declared sources are labeled by `LogChunk.source` and merged into the same `lando logs` stream.

The scope is deliberately narrow. The common infrastructure case is already covered by upstream images that redirect to stdout/stderr, so this primitive targets the real long tail (framework/app logs, enabled DB slow/general logs, legacy daemons) without a sidecar collector, without an in-core log parser, and without making raw container `tail -F` the semantic contract. The primitive was written into the normative spec first (§6.14, §5.3, §5.4, §10.9); when this PRD and a spec part disagree, the spec part wins.

## Source References

- [`spec/06-services.md`](../06-services.md) §6.14 the `LogSource` schema, `LogChunk.source`, the two reification strategies, follow semantics, redaction boundary, and catalog defaults; §6.2 the `services.<name>.logs:` (`LogSourceInput`) tuning surface; §6.11.0.1 the service-type conformance bullet for `logSources`; §6.11 `ServiceTypeResolution.logSources`; §6.13 build orchestration (redirect reification).
- [`spec/05-runtime-providers.md`](../05-runtime-providers.md) §5.3 `RuntimeProvider.logs`, the extended `LogOptions` (`sources`, `source`), and the follow-semantics contract; §5.4 the `serviceLogSources` capability; §5.5 validate-capability-before-plan.
- [`spec/11-subsystems.md`](../11-subsystems.md) §10.9 logs/diagnostics — unified sources, redirect fallback, capability degradation, `RedactionService` boundary.
- [`spec/03-architecture.md`](../03-architecture.md) §3.7 `RedactionService` single-implementation boundary; §3.6 cancellation budget; §3.4 `Renderer` output boundary.
- [`spec/08-cli-and-tooling.md`](../08-cli-and-tooling.md) §8.2.5 `app:logs` flags, §8.11 machine-output/StreamFrame seam for streaming commands.
- [`sdk/AGENTS.md`](../../sdk/AGENTS.md) additive-export discipline, `sdk/API_COMPATIBILITY.md`, and `codegen:schema-snapshot`; [`sdk/src/services/provider.ts`](../../sdk/src/services/provider.ts) current `LogChunk` / `LogOptions` / `ProviderCapabilities` / `RuntimeProviderShape`.
- [`core/AGENTS.md`](../../core/AGENTS.md) renderer, redaction, probe, and dual-dispatch boundary gates; [`core/src/cli/commands/logs.ts`](../../core/src/cli/commands/logs.ts) current `serviceLogs`-gated `logs` command.

## Goals

- Add the `LogSource` schema, `LogChunk.source`, the extended `LogOptions`, and the `serviceLogSources` capability to `@lando/sdk` as additive, snapshot-tracked surface.
- Let a service type declare `logSources` and a user declare `services.<name>.logs:` file sources, resolved into provider-neutral plan intent by the `AppPlanner`.
- Reify `redirect` sources at build/scaffold time so Lando-built web/DB service types surface file logs through the existing console stream with zero runtime cost.
- Reify `follow` sources inside `RuntimeProvider.logs` in the bundled providers, with correct finite/follow, missing-file, rotation, line-framing, bounding, per-source `since`/`tail`, ordering, and scope-reaping semantics — never a core `tail -F` shell-out.
- Surface declared sources through `lando logs` (with `--source` and per-source labeling) and report resolved/unavailable sources in `lando info`, redacting only at the boundary.
- Cover the whole surface with the SDK provider `logs` contract suite, the service-composition contract, dual-dispatch parity, and redaction tests.

## User Stories

### US-425: `LogSource` SDK surface — schema, `LogChunk.source`, `serviceLogSources` capability

**Description:** As an SDK consumer, `@lando/sdk` publishes the `LogSource` schema, the additive `LogChunk.source` field, the extended `LogOptions`, and the `serviceLogSources` provider capability, so providers and core share one typed contract for declared log sources.

**Acceptance Criteria:**

- [ ] `LogSource` and branded `LogSourceId` are exported from `@lando/sdk` per §6.14.1: `{ id, label?, path, stream, strategy, required, timestamps }` with `strategy: "redirect" | "follow"`, `stream: "stdout" | "stderr"`, `required`/`timestamps` defaulting to `false`; `console` is a reserved id and validation rejects a declared source using it.
- [ ] `LogSourceInput` (the Landofile-facing shape) is exported: `path` required; `label`, `stream` (default `stderr`), and `id` (defaulted from the path basename) optional; decoding a `LogSourceInput` yields a `strategy: "follow"`, `timestamps: false` `LogSource` (user-declared sources never choose `redirect`).
- [ ] `LogChunk` gains optional `source?: LogSourceId` (§6.14.2); the existing four-field shape still decodes and every current `LogChunk` construction site compiles unchanged.
- [ ] `LogOptions` gains optional `sources?: readonly LogSource[]` and `source?: LogSourceId` (§5.3); `follow`/`tail`/`since` are unchanged.
- [ ] `ProviderCapabilities` gains `serviceLogSources: boolean` (§5.4); the bundled `@lando/provider-lando`, `@lando/provider-docker`, and `@lando/provider-podman` capability matrices declare it, and the test/fake provider declares it too.
- [ ] `sdk/API_COMPATIBILITY.md` records the additive exports/fields; `bun run codegen:schema-snapshot` is refreshed and `git diff --exit-code` is clean on the snapshot after codegen; export/import-boundary tests updated.
- [ ] Tests pass
- [ ] Typecheck passes
- [ ] Lint passes

### US-426: Declared log sources become plan intent (service-type + Landofile)

**Description:** As a service author or user, the `logSources` a service type returns and the `services.<name>.logs:` a user writes are validated and carried onto the resolved plan as provider-neutral intent, with the bundled catalog service types declaring their known sources.

**Acceptance Criteria:**

- [ ] `ServiceTypeResolution` accepts `logSources?: readonly LogSource[]`; the `AppPlanner` per-service phase (§6.11.0) collects them onto the service draft and merges user `services.<name>.logs:` sources, precedence: user `logs:` > service-type `logSources` on a colliding `id`.
- [ ] The §13.1 `runServiceCompositionContract` suite enforces the §6.11.0.1 bullet: unique `id` per service, absolute `path`, and a `strategy` the `base` can honor — a `redirect` source on a non-Lando-built (`base: "l337"`/BYO, no build phase) service is rejected with a tagged error and remediation; a service type that tries to follow files or spawn a collector itself fails the boundary.
- [ ] Resolved `logSources` are part of the app-plan cache composition input (§12.1) so adding/removing a source invalidates the plan.
- [ ] Bundled §6.12 catalog service types declare sources per §6.14.6: `apache`/`nginx`/`php-fpm` access+error as `strategy: "redirect"`; `mysql`/`mariadb` slow/general query logs (when enabled) as `strategy: "follow"`; the error log stays on `console`.
- [ ] Landofile round-trips a `logs:` block through the §7.8.1 serializer without reformatting unrelated content.
- [ ] Tests pass
- [ ] Typecheck passes
- [ ] Lint passes

### US-427: `redirect`-strategy reification for Lando-built services

**Description:** As a user of a Lando-built web/DB service, my declared `redirect` log files appear in `lando logs` with no runtime follower, because Lando points the daemon's log path at `/dev/stdout`/`/dev/stderr` when it builds the image.

**Acceptance Criteria:**

- [ ] For every resolved `strategy: "redirect"` source on a Lando-built service, the planner emits a deterministic build/scaffold step (§6.13) that redirects the path to `/dev/stdout` (for `stream: "stdout"`) or `/dev/stderr` (for `stream: "stderr"`) — a symlink, or a daemon-config directive where a symlink is unsafe.
- [ ] After redirect, the source's lines arrive on the implicit `console` stream (verified against the test provider); no follower is started and `serviceLogSources` is not consulted for redirect sources.
- [ ] The redirect step is idempotent across rebuilds and is included in the `buildKey` up-to-date check (§6.13.5) so a changed source re-runs it.
- [ ] A `redirect` source declared on a service Lando does not build fails planning (shared with US-426's conformance check), never silently downgrades.
- [ ] Tests cover redirect emission for `stdout` and `stderr` sources and the console-stream round-trip on the test provider.
- [ ] Tests pass
- [ ] Typecheck passes
- [ ] Lint passes

### US-428: `follow`-strategy provider realization inside `RuntimeProvider.logs`

**Description:** As a user with a bring-your-own image or a non-redirectable log (MySQL slow log), `lando logs` follows the declared file with correct semantics, implemented by the provider — not a core `tail -F` shell-out.

**Acceptance Criteria:**

- [ ] `RuntimeProvider.logs` in `@lando/provider-lando` (and `@lando/provider-docker` / `@lando/provider-podman`) consumes `LogOptions.sources`, merges the `console` stream with a follower per `strategy: "follow"` source, and tags each `LogChunk` with its source `id`.
- [ ] Follow semantics from §6.14.4 are asserted by the SDK `logs` contract suite against the fake provider and, env-gated, against a live provider: **finite** (`follow:false`) snapshots up to `tail` lines then EOFs and the merged stream terminates; **follow** backfills then follows; a **missing** file yields a pending (follow) / unavailable (finite) diagnostic and never hangs; **rotation** (rename+create and copytruncate) is survived via inode/offset tracking with a rotation marker and no follower-diagnostic leakage into service chunks.
- [ ] **Line framing:** incremental UTF-8 decode never splits a multi-byte codepoint across chunks, handles CRLF, and flushes a final partial line at EOF; **bounds:** a per-source `maxLineBytes` truncates over-long/binary lines with a `truncated` marker and bounded buffering (a huge/binary line cannot exhaust memory).
- [ ] **`since`** is honored only for `timestamps: true` sources and `console`; a `timestamps: false` source reports `--since` unsupported (per-source diagnostic), never silently ignored. **`tail`** is applied per source (documented; no faked global total). **Ordering:** per-source order preserved, merged stream is arrival-order, no global-chronological guarantee is claimed.
- [ ] **Lifecycle:** every follower is acquired in the `logs` stream scope; a `TestClock`/interrupt test with ≥6 services × ≥3 sources asserts every follower is reaped on `Effect.interrupt` within the §3.6 budget and that a dropped, partially-consumed `logs` stream terminates its followers at scope close.
- [ ] **Capability degradation:** a provider with `serviceLogSources: false` still streams `console` and `redirect` sources; a `required` follow source fails planning up front with a tagged `CapabilityError` naming the redirect alternative, and a non-required follow source is reported unavailable (never silently dropped).
- [ ] `check:probe-boundary` stays green — the follower does not introduce a hand-rolled `Effect.retry`/`Schedule` readiness loop outside `runProbe` where §10.5 requires it.
- [ ] Tests pass
- [ ] Typecheck passes
- [ ] Lint passes

### US-429: `lando logs` source surface, redaction boundary, and `lando info` reporting

**Description:** As a user, `lando logs` shows my declared sources with clear labels, `--source` filters to one, secrets are redacted at the boundary, and `lando info` tells me which sources resolved or are unavailable.

**Acceptance Criteria:**

- [ ] `app:logs` resolves the target service's declared sources and passes them as `LogOptions.sources`; a new `--source <id>` restricts the stream to one source (unknown id fails with the known-source list); existing `--service`/`--follow`/`--tail`/`--since` compose with it.
- [ ] TTY rendering labels each line by `source` (console lines keep today's appearance); `--format json` emits per-line StreamFrames carrying `source` through the central §8.11 StreamFrame seam, not raw `JSON.stringify`.
- [ ] **Redaction at the boundary only:** providers emit raw `LogChunk`s; the renderer, lifecycle events, and `--format json` route every `line` through `RedactionService` (§3.7). A test proves a registered secret appearing in a followed file's line is masked in rendered/JSON output while the on-disk file stays raw; `check:redaction-boundary` covers the path.
- [ ] `lando info` (or `--deep` per §6.10) reports each service's resolved log sources with `id`, `path`, `strategy`, and availability (available / redirected-to-console / unavailable-with-reason).
- [ ] Provider log-streaming capability is validated before planning: a provider that cannot stream logs at all fails up front (existing US-393 behavior preserved); source-follow unavailability degrades per US-428, not mid-stream.
- [ ] Dual-dispatch parity: OCLIF and `runCompiledCli` behave identically for `--source`, labeling, and JSON output; the `app:logs` result/stream schema updates are snapshot-frozen.
- [ ] Tests pass
- [ ] Typecheck passes
- [ ] Lint passes

## Functional Requirements

- **FR-1:** Declared log sources MUST be provider-neutral plan intent produced by service types or user `logs:` config; a service type MUST NOT itself follow files or spawn a collector, and user config MUST NOT choose a collection strategy (it only tunes which files/labels are surfaced).
- **FR-2:** `redirect` sources MUST be reified at build/scaffold time and only for Lando-built images; they MUST surface through the existing `console` stream and MUST NOT start a runtime follower.
- **FR-3:** `follow` sources MUST be realized by the provider inside `RuntimeProvider.logs`, never by a core `execStream(tail -F …)` shim, and MUST honor the §6.14.4 finite/follow, missing-file, rotation, framing, bounding, `since`/`tail`, ordering, and scope-reaping semantics.
- **FR-4:** `serviceLogSources` MUST gate follow-source realization; a `required` follow source MUST fail planning with a tagged `CapabilityError` + remediation when unsupported, and a non-required source MUST be reported unavailable, never silently dropped.
- **FR-5:** `LogChunk.source` MUST be additive/optional; the SDK change MUST follow `sdk/AGENTS.md` (API_COMPATIBILITY + schema snapshot) and keep every existing `LogChunk` consumer valid.
- **FR-6:** Providers MUST emit raw `LogChunk`s; redaction MUST be applied exactly once at the renderer/event/machine-output boundary through the canonical `RedactionService`, with no mid-pipeline scrubber and no double-redaction.
- **FR-7:** `lando logs` MUST label lines by source and support `--source`; `lando info` MUST report resolved/unavailable sources; both MUST keep OCLIF and compiled dispatch in parity.

## Non-Goals

- No `console`/`exec`-command log-source variants and no arbitrary user-defined log commands in v4.0 (a source is a single file path).
- No globbing or multi-path sources (declare multiple sources for multiple files).
- No in-core parsing of Apache/MySQL/etc. log grammars into structured fields — line shipping is the contract; enrichment, if ever, is an opt-in plugin.
- No sidecar log-collector container and no engine log-driver reconfiguration.
- No global-total `--tail N` across sources and no merged global-chronological ordering guarantee.
- No new §4.2 pluggable `LogCollector` abstraction — log collection stays inside `RuntimeProvider` (which already owns `exec`/`logs`).

## Technical Considerations

- Mirror the existing capability-before-plan discipline: resolve sources and validate `strategy`/`serviceLogSources` during planner finalization (§6.11.0 stage 6), not at stream time.
- Keep the follower off the probe-boundary and renderer-boundary gates: no hand-rolled retry schedules where §10.5 requires `runProbe`; all display through the StreamFrame/renderer seam, never direct `process.std*.write`.
- `LogChunk.stream` stays `stdout | stderr` as a render/exit classification; provenance rides `source`. Do not add a third `stream` kind.
- Redirect reification shares the build-orchestration path (§6.13); reuse the `buildKey` up-to-date check rather than inventing a separate apply step.
- The follower's own diagnostics (rotation notices, "file truncated") are provider-internal and must not be emitted as service `LogChunk`s.
- Coordinate with US-393 (`app logs --follow/--since`): this PRD extends the same command; keep the scope/cancellation guarantees US-393 established.

## Success Metrics

- On a Lando-built `apache` service whose access log is declared `redirect`, `lando logs appserver` shows request lines with zero runtime followers (verified: no exec children spawned for logs).
- On a BYO MySQL image with a declared `follow` slow-query source, `lando logs db --source slow-query --follow` streams new slow-query entries, survives a `logrotate` of the file, and terminates cleanly on Ctrl+C with no leaked followers.
- `lando logs db --follow=false --tail=50` on a followed source terminates (does not hang) and returns at most 50 lines from that source.
- `lando logs --format json` emits schema-valid StreamFrames carrying `source` in both source and compiled dispatch; a registered secret in a followed line is masked while the on-disk file remains raw.
- `lando info --deep` lists each service's declared sources with strategy and availability.

## Guide Coverage

| Surface | Guide | Status |
| --- | --- | --- |
| `lando logs` with declared file sources and `--source` | `docs/guides/cli/service-logs.mdx` | Shipped |
| Declaring `services.<name>.logs:` in a Landofile | owned by the Landofile services guide surface | Update and re-run drift gate |
| Provider `logs` source-follow contract | owned by the provider contract-suite guide surface | Update and re-run drift gate |

## Open Questions

- What exact `maxLineBytes` default balances real DB blob lines against memory safety? Pick a concrete default during implementation (e.g. 64 KiB) and make it tunable per source only if a real case needs it.
- Should `lando logs` with no `--source` include every declared source by default, or only `console` unless `--source`/`--all` is given? Default to including all resolved sources (labeled) and add `--source`/`--console-only` as narrowing flags; revisit if the interleaved output proves noisy in practice.
- For `redirect` sources, is a symlink to `/dev/stdout` sufficient for the catalog daemons, or do any need a config-directive path (like php-fpm's `error_log`)? Resolve per daemon during US-427; the spec permits either.
