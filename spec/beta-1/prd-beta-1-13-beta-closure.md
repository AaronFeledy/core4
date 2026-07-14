# PRD: BETA1-13 — Beta closure wave

## Introduction

Beta 1 cannot close on the green story ledger alone. The progress log records several residual gaps after US-429: the published Linux runtime bundle was checksum-valid but remote-only; independent review lanes were inconclusive in this harness; live Podman 6 acceptance and several provider seams still need real or explicitly env-gated coverage; and multiple §8/§10/§12/§16 closure items remain documented as deferred gaps.

This PRD makes those residuals explicit Beta 1 closure work rather than silently deferring them past feature freeze. It does not mark any implementation complete. Every story in this PRD starts with `passes: false` and exists to preserve the hierarchy: normative spec is source of truth, these PRDs define Beta 1 acceptance, and `progress.txt` remains historical evidence.

## Source References

- [`progress.txt`](./progress.txt) — unresolved runtime asset, review-lane, host-proxy transport, shell REPL, MCP projection/startup, version-constraint, global rebuild, tooling-router, and live-provider notes.
- [`prd-beta-1-10-runtime-bundle-publishing.md`](./prd-beta-1-10-runtime-bundle-publishing.md) US-410..US-412 — runtime-bundle publishing and committed-manifest invariant context for the later Linux remote-only Podman asset defect.
- [`prd-beta-1-11-podman-6.md`](./prd-beta-1-11-podman-6.md) — Podman 6 provider/runtime contract stories that require live or env-gated acceptance.
- [`prd-beta-1-12-service-log-sources.md`](./prd-beta-1-12-service-log-sources.md) — service log sources, provider-owned `follow`, and `buildKey` adjacency.
- [`spec/08-cli-and-tooling.md`](../08-cli-and-tooling.md) §8.2.3 shell semantics, §8.2.6 MCP, §8.4 global commands, §8.8 tooling, and §8.11 machine output.
- [`spec/11-subsystems.md`](../11-subsystems.md) §10.10 host-proxy behavior and runLando notes in progress — production transport beyond the logical in-process dispatcher.
- [`spec/12-caches-and-persistence.md`](../12-caches-and-persistence.md) cache correctness and command-derived generated allowlists.
- [`spec/14-appendices.md`](../14-appendices.md) tooling-router dispatch and policy inheritance notes, alongside the tooling command surface in §8.

## Goals

- Assign the remote-only Linux runtime-bundle defect to its own closure story without reopening previously completed PRD-10 stories.
- Encode every documented residual gap as a concrete, machine-readable story with ordered priority.
- Keep closure work inside Beta 1 scope and block feature-freeze claims until the stories pass.
- Preserve historical progress evidence while making the current acceptance state unambiguous.
- Require validation evidence that distinguishes a real pass from an environment skip, timeout, empty review result, or instruction-only review lane.

## User Stories

### US-430: Republish local-engine Linux runtime bundle

**Description:** As a Linux user installing Lando from the committed manifest, the published runtime bundle contains a local-engine-capable Podman, not a remote-only client, so managed setup can launch the bundled service with Lando-owned roots.

**Acceptance Criteria:**

- [ ] A new immutable `runtime-v<version>` asset set is published or the existing failed version is superseded by a new version; release assets are never overwritten in place.
- [ ] Linux `linux-x64` and `linux-arm64` bundles include a Podman 6 local engine plus required rootless helpers, not a remote-only client artifact.
- [ ] Bundle verification runs the bundled Linux `podman` and proves `--root`, `--runroot`, and `system service` are accepted in the managed-service argv shape Lando uses.
- [ ] `runtime-bundle-versions.json` is repinned to the corrected published assets with real HTTPS URLs, sizes, and SHA-256 values.
- [ ] A zero-override published-manifest setup run downloads the repinned Linux bundle, checksum-verifies it, starts the managed service, and reaches provider readiness without `LANDO_RUNTIME_BUNDLE_MANIFEST` or paired override flags.
- [ ] The defect and all corrective verification evidence are tracked under US-430; completing or failing this story does not change the recorded completion state of US-410 or US-411.
- [ ] Tests pass
- [ ] Typecheck passes
- [ ] Lint passes

### US-431: Independent closure review lanes

**Description:** As a release owner, Beta 1 closure is reviewed by independent goal, QA, code-quality, security, and context/history lanes, and an inconclusive tool invocation cannot be counted as approval.

**Acceptance Criteria:**

- [ ] Five terminal review results are retained: goal/constraint verification, hands-on QA, code quality, security, and context/history mining.
- [ ] A lane that times out, returns empty output, returns only workflow instructions, or cannot inspect the repository is recorded as inconclusive and does not count as approval.
- [ ] Each lane includes scope, inputs, commands or tools run, findings, disposition, and residual risks.
- [ ] Any blocker found by a lane is either fixed and re-reviewed or linked to a still-failing Beta 1 story; no blocker is dismissed without a source-backed rationale.
- [ ] The final closure note names every lane result and stores enough evidence for a later maintainer to audit the decision without rerunning the tools.
- [ ] Tests pass
- [ ] Typecheck passes
- [ ] Lint passes

### US-432: Live Podman 6 end-to-end acceptance

**Description:** As a maintainer, Beta 1 proves the Podman 6 runtime contract on supported live provider surfaces, including managed setup after US-430, and reports unsupported environments as skips rather than passes.

**Acceptance Criteria:**

- [ ] Live acceptance covers `@lando/provider-lando` managed setup using the repinned bundle from US-430 and reaches a usable provider socket/service.
- [ ] Live or explicitly env-gated acceptance covers supported `@lando/provider-podman` and Docker-compatible provider surfaces that Beta 1 claims.
- [ ] The suite exercises start, exec, logs, stop/destroy, image pull, health/readiness, and volume cleanup on Podman 6 where the provider claims support.
- [ ] Environment prerequisites are detected before execution; missing socket, unsupported OS, missing privileges, or unavailable live runtime produces a structured skip with reason, not a passing result.
- [ ] CI/release reporting distinguishes pass, fail, and skip for every provider/host cell, and Beta closure requires the cells documented as release-blocking to pass.
- [ ] Tests pass
- [ ] Typecheck passes
- [ ] Lint passes

### US-433: Production host-proxy runLando transport

**Description:** As a user running `lando` inside a container, runLando requests use the production host-proxy transport with the same behavior as the already-proven logical dispatcher.

**Acceptance Criteria:**

- [ ] A compiled in-container shim is built and installed into the container feature path without importing source-only modules at runtime.
- [ ] The host exposes a scoped Unix-socket or platform-equivalent transport into eligible containers with least-privilege mount semantics.
- [ ] Requests authenticate with an unguessable token scoped to the app/session and reject missing, stale, or cross-app tokens with tagged failures.
- [ ] The dispatcher enforces the generated host-proxy allowlist, cwd remapping, env filtering, retained-runtime dispatch, exit-code parity, and CommandResultEnvelope parity already proven by the logical tests.
- [ ] A concurrency cap and recursion guard prevent nested runLando loops and unbounded request fan-out.
- [ ] Socket, token, shim, and mount state are cleaned up on stop/destroy/uninstall and on failed setup.
- [ ] Events, transcripts, and errors preserve existing redaction parity and renderer/event-boundary compliance.
- [ ] Tests pass
- [ ] Typecheck passes
- [ ] Lint passes

### US-434: Real provider log-follow file access

**Description:** As a user following declared service log files, provider `logs` reads real container files and proves the full follow contract end-to-end instead of relying only on fake-provider semantics.

**Acceptance Criteria:**

- [ ] Provider implementations access in-container log files through a provider-owned file-read/follow seam, not a core `tail -F` shell-out.
- [ ] Live or env-gated provider coverage proves finite snapshot, follow mode, `tail`, `since` handling, missing files, copytruncate, rename-create rotation, truncation, oversized/binary line bounding, UTF-8 framing, and final partial-line flushing.
- [ ] Every emitted `LogChunk` carries the correct `source`, stream, and redaction-boundary behavior; provider diagnostics do not leak as service log lines.
- [ ] Follower scopes are interrupted and cleaned up on Ctrl+C, dropped streams, service stop, and provider failure.
- [ ] Tests distinguish fake-provider contract coverage from live-provider/container-file coverage in their names and reports.
- [ ] Tests pass
- [ ] Typecheck passes
- [ ] Lint passes

### US-435: buildKey build-results short-circuit

**Description:** As a user running the same disposable tool twice, the second `lando run` avoids rebuilding when §6.13.5 says the build is current while still creating a fresh scratch app identity.

**Acceptance Criteria:**

- [ ] Build orchestration persists and reads spec §6.13.5 build results keyed by `buildKey` for scratch/toolbox builds.
- [ ] The second identical `lando run` short-circuits the build phase and proves no provider image build or redirect step re-runs.
- [ ] Each non-kept run still allocates a fresh scratch app id, root, network/volume namespace, and cleanup scope; only the build artifact is reused.
- [ ] Changes to recipe inputs, log-source redirect inputs, base image, build args, or provider-relevant environment invalidate the key and rebuild.
- [ ] The short-circuit is observable in structured events/output without exposing host paths or secrets.
- [ ] Tests pass
- [ ] Typecheck passes
- [ ] Lint passes

### US-436: Live-wire remaining Podman 6 seams

**Description:** As a Podman 6 user, image-pull, volume-prune, doctor-OOM, and machine-trust behavior are wired to real provider surfaces with ownership, safety, and redaction guarantees.

**Acceptance Criteria:**

- [ ] Image pulls request and render Podman 6 progress, map non-200 failures to tagged provider errors, and redact registry details before events/transcripts/output.
- [ ] Volume prune/cleanup uses Podman 6 anonymous/named/filter semantics safely, never deleting outside the current app/provider labels and requiring explicit destructive intent for named volumes.
- [ ] Doctor consumes Podman 6 died events with `OOMKilled`, correlates them to services where possible, and reports remediation without leaking raw event payloads.
- [ ] Managed-machine trust changes apply only to Lando-owned machines; Windows Hyper-V prep remains explicit manual remediation, never auto-elevated.
- [ ] Each seam has real or env-gated integration coverage; unsupported environments are structured skips, not passes.
- [ ] Tests pass
- [ ] Typecheck passes
- [ ] Lint passes

### US-437: meta:global:rebuild lifecycle command

**Description:** As a global-app user, `meta:global:rebuild` is a real command with global lifecycle semantics and dispatch parity, not a `NotImplementedError` stub.

**Acceptance Criteria:**

- [ ] The deferred stub is removed from every source and compiled dispatch registry location required by the dual-dispatch parity contract.
- [ ] OCLIF/source and compiled `runCompiledCli` dispatch execute the same rebuild operation and expose the same help, flags, result schema, and exit-code behavior.
- [ ] Rebuild uses global app lifecycle semantics, not app-local restart shortcuts: it resolves the global plan, tears down/rebuilds/apply-starts the global app as specified, and publishes global lifecycle events.
- [ ] Idempotency and failure behavior are covered for disabled global app, missing provider, partial rebuild failure, and successful rebuild.
- [ ] Not-implemented/deferred-command fixtures and parity probes are updated so a regression back to `NotImplementedError` fails.
- [ ] Tests pass
- [ ] Typecheck passes
- [ ] Lint passes

### US-438: MCP read-only app config projection

**Description:** As an agent using MCP, I can read app config through `app:config get/view` without exposing config writes or umbrella-command mutations.

**Acceptance Criteria:**

- [ ] MCP projects read-only `app:config get` and `app:config view` as allowed tools without exposing `set`, `unset`, `edit`, `validate`, or other write-capable config paths.
- [ ] Generated MCP allowlist/registration logic rejects unsafe umbrella-command exposure and detects conflicts where a write-capable variant would become reachable.
- [ ] Tool input schemas constrain the verb/path shape so a crafted request cannot select a write verb through args or aliases.
- [ ] Results use the standard CommandResultEnvelope/StreamFrame seams with redaction and non-interactive behavior.
- [ ] Tests prove default MCP catalog includes only the read-only config tools and rejects attempted writes with tagged failures.
- [ ] Tests pass
- [ ] Typecheck passes
- [ ] Lint passes

### US-439: Bun.$ host REPL shell semantics

**Description:** As a user in `lando shell` host mode, the spec §8.2.3 Bun.$ REPL semantics are complete, with safe history, redaction, interruption, and exit behavior.

**Acceptance Criteria:**

- [ ] Host shell interactive mode uses the Bun.$-backed ShellRunner/REPL path required by spec, not a raw `$SHELL` spawn except where the spec explicitly permits service mode.
- [ ] Every accepted line emits structured pre/post shell-command events with command text redacted through `RedactionService` before output, events, transcripts, or history.
- [ ] History persistence is per-line, opt-out via `--no-history`, bounded, and redacted before write; failed validation or secret-bearing lines do not leak raw text.
- [ ] Ctrl+C interrupts the running line without corrupting the REPL; Ctrl+D/exit terminates with the correct status and restores terminal state.
- [ ] `--no-interactive` follows the spec-required non-TTY behavior with deterministic tagged failure or execution semantics, and dual-dispatch parity holds.
- [ ] Tests pass
- [ ] Typecheck passes
- [ ] Lint passes

### US-440: MCP serve startup refusal and bounded stdio

**Description:** As a user or adversarial MCP client, `lando mcp` refuses invalid startup modes consistently and cannot be forced into unbounded memory growth through stdio.

**Acceptance Criteria:**

- [ ] Source and compiled dispatch have identical startup-refusal behavior for missing stdio, TTY-only invocation where serve is impossible, incompatible flags, and invalid config.
- [ ] The stdio transport enforces bounded frame size, bounded buffered bytes, and bounded pending requests before JSON parse and during response/progress writes.
- [ ] Malformed, partial, oversized, slow-loris, and never-reading clients fail or are disconnected with tagged transport errors and no unbounded memory use.
- [ ] Backpressure from stdout/stderr is respected; progress notifications cannot accumulate without limit behind a blocked client.
- [ ] Tests include adversarial stdio clients and assert memory/buffer caps through deterministic seams rather than wall-clock sleeps.
- [ ] Tests pass
- [ ] Typecheck passes
- [ ] Lint passes

### US-441: Version-constraint gap closure

**Description:** As a team relying on `lando:` constraints, Landofile provenance, semver grammar, schema validation, machine warnings, and cache invalidation all match the contract.

**Acceptance Criteria:**

- [ ] Constraint provenance includes all six Landofile layers/sources with ordered source metadata in errors, warnings, doctor output, and cache keys.
- [ ] Range parsing supports the full npm-semver grammar required by the contract, including unions, hyphen ranges, x-ranges, prerelease handling, and build metadata rules.
- [ ] Schema-level validation rejects malformed ranges at parse time where the contract requires it, and runtime predicates evaluate every accumulated range without loosening by lower-precedence layers.
- [ ] `LANDO_SKIP_VERSION_CONSTRAINT=1` emits structured machine-warning output, not prose-only warnings, and still records the skipped constraints.
- [ ] App-plan/cache correctness is proven: changing any constraint or source layer invalidates relevant cache entries, while unchanged constraints keep hot-path behavior.
- [ ] Tests pass
- [ ] Typecheck passes
- [ ] Lint passes

### US-442: Generic CLI command lifecycle events

**Description:** As an observability consumer, every CLI command publishes generic lifecycle events consistently across source and compiled dispatch, with redaction and renderer/event-boundary compliance.

**Acceptance Criteria:**

- [ ] Source OCLIF dispatch and compiled `runCompiledCli` publish generic pre/post command lifecycle events for every canonical command, alias, success, tagged failure, and unexpected failure path.
- [ ] Event payloads include canonical id, argv/args/flags summary, cwd/app context where available, exit code, duration, and failure tag without leaking raw secrets.
- [ ] Redaction runs through `RedactionService`; no command body writes events or output directly around the renderer/event boundary.
- [ ] Existing command-specific events remain intact and are ordered relative to generic events in a documented, tested sequence.
- [ ] Contract tests cover representative bootstrap levels (`none`, `provider`, `app`, `plugins`), streaming commands, interactive carve-outs, and compiled/source parity.
- [ ] Tests pass
- [ ] Typecheck passes
- [ ] Lint passes

### US-443: Real tooling-router command dispatch

**Description:** As a user invoking tooling through the command-not-found path, Lando dispatches real tooling tasks with the same policies as explicit tooling execution instead of returning the `command_not_found` stub.

**Acceptance Criteria:**

- [x] The `command_not_found` tooling-router stub is replaced with dispatch that resolves eligible tooling tasks from the active app/recipe/tooling registry.
- [x] Dispatch preserves Landofile version-constraint checks, cache invalidation behavior, network/no-network policy, provider selection, and tooling task environment rules.
- [x] Unknown commands, ambiguous matches, disabled tooling, missing providers, network-policy violations, and task failures return tagged failures with remediation and correct exit codes.
- [x] Source and compiled dispatch behave identically, including top-level aliases and machine-output envelopes.
- [x] Tests prove the router cannot bypass version constraints, cache correctness, or network restrictions by entering through command-not-found.
- [x] Tests pass
- [x] Typecheck passes
- [x] Lint passes

## Functional Requirements

- **FR-1:** PRD-13 stories are Beta 1 closure work. They MUST NOT be treated as post-Beta backlog or omitted from Beta 1 traceability.
- **FR-2:** US-430 owns the corrected published-manifest setup evidence for the remote-only Linux runtime-bundle defect without changing the completion state of US-410 or US-411.
- **FR-3:** A review lane is approval only when it returns a terminal, repository-specific result; timeout, empty output, or instruction-only output is inconclusive.
- **FR-4:** Live-provider acceptance MUST separate environment skips from passes in machine-readable output.
- **FR-5:** New closure work MUST keep the existing boundary rules: Renderer for output, RedactionService for secrets, StateStore for durable state, `runProbe` for retry/probe loops, generated allowlists from generators, and dual-dispatch parity for CLI behavior.

## Non-Goals

- No normative spec edits in this PRD-only closure update.
- No runtime/source implementation in this documentation change.
- No compatibility shims or legacy paths for the remote-only Linux runtime artifact.
- No weakening of already-shipped Beta 1 acceptance criteria.
- No erasure of material historical outcomes, blockers, or verification conclusions; `progress.txt` may condense redundant build/review/sync chronology because Git remains the detailed change record.

## Technical Considerations

- Keep new implementation stories small enough to land independently, but do not mark Beta 1 closed until their aggregate acceptance is true.
- Host-proxy production transport should reuse the logical dispatcher and generated allowlist work already recorded in progress rather than forking policy.
- MCP read-only config projection should avoid a broad command-level boolean for umbrella commands; project safe subcommands or constrained tool schemas instead.
- Version-constraint completion should prefer a standard npm-semver-compatible parser rather than extending the partial parser case by case.
- Live Podman 6 coverage should be explicit about which provider/host cells are release-blocking and which are advisory.

## Success Metrics

- `spec/beta-1/prd.json` contains unique ordered US-430..US-443 entries with priorities continuing after US-429 and all `passes: false`.
- US-430 explicitly owns corrected local-engine Linux bundle publishing, manifest repinning, and zero-override managed setup evidence.
- The Beta 1 index traces every residual progress gap to a closure story.
- Validation scripts confirm JSON parses, story IDs/priorities are unique and ordered, new story statuses are false, and Markdown/JSON story IDs/titles match.

## Guide Coverage

| Surface | Guide | Status |
| --- | --- | --- |
| Published runtime bundle and zero-override setup | setup/release runbook surfaces | Update when US-430 lands |
| Production runLando host-proxy transport | host-proxy subsystem guide | Update when US-433 lands |
| Log source follow semantics | `docs/guides/cli/service-logs.mdx` | Shipped for US-434 |
| Host shell REPL | shell/CLI guide | Update when US-439 lands |
| MCP config read projection and stdio hardening | MCP guide | Update when US-438/US-440 land |
| Tooling-router dispatch | tooling guide | Update when US-443 lands |

## Open Questions

- Which live provider/host cells are mandatory for the first Beta 1 tag versus nightly-only evidence?
- Should review-lane terminal reports live only in `progress.txt`, or should Beta closure also gain a short retained review artifact under `spec/beta-1/`?
- What exact memory limits should MCP stdio buffering enforce for request frames, progress notifications, and pending responses?
