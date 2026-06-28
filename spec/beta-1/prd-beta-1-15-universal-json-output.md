# PRD: BETA1-15 — Universal `--format json` machine-output contract

## Introduction

Beta 1 ships the **Agent-native** tenet (§1.2), whose "machine-legibility" half asserts that every command is consumable by an agent or script without parsing prose. Today that is half-true and inconsistent: only ~16 of 57 command modules emit JSON at all, each hand-rolling its own `JSON.stringify(result, …)` inside its `render*` helper, with no stable envelope, no published schema, and no snapshot gate. The two output surfaces — `--renderer` (global output mode) and `--format` (per-command result encoding) — overlap with no contract between them, and roughly 40 commands have no JSON path whatsoever. An agent therefore cannot rely on `lando <anything> --format json` returning a predictable, parseable shape.

This PRD makes the tenet's assertion true and testable. It defines one universal, schema-backed result envelope (`CommandResultEnvelope`), makes `--format json` (plus the `--json` / `-j` shorthand) mandatory and uniform on every non-interactive command, routes all JSON through a single redaction-aware serialization seam (`encodeCommandResult`), and locks the shape with the §13.2 schema snapshot plus a §13.4 boundary gate and a §13.1 conformance layer. It is the output-side dual of the env-passthrough work (BETA1-16) that realizes the tenet's "context-continuity" half.

This is the last feature-surface phase, so the contract lands now rather than being deferred. The work consolidates duplication that already exists in shipped code (the per-command `JSON.stringify` calls in `info`, `list`, `doctor`, `app-config*`, `scratch`, `meta/global-status`, and the one-off NDJSON paths in `doctor-ndjson.ts` and the deprecation-event line) onto one contract.

Depends on: **BETA1-04** (the `@lando/sdk` schema-publication discipline and the §7.8 registry the envelope joins), **BETA1-06** (the canonical `RedactionService` §3.7 that every envelope is masked through), **BETA1-11** (`@lando/core/testing` `TestRuntime`, the library-API contract gates, and the §13.1 dispatch-parity layer the conformance gate cross-checks), and **BETA1-14** (the `EventService` bounded redacted history that feeds streaming `event` frames). It must stay in lockstep with the deferred-command set (§17.1 stage 7) so deferred stubs also satisfy the conformance gate.

## Source References

- [`spec/01-mission-and-tenets.md`](../01-mission-and-tenets.md) §1.2 the Agent-native tenet (machine-legibility half) this PRD realizes.
- [`spec/08-cli-and-tooling.md`](../08-cli-and-tooling.md) §8.11 the normative machine-output contract (the `--format`/`--renderer` split, `--format json` / `--json` / `-j`, `CommandResultEnvelope`, `CommandWarning`, `CommandResultFormat`, `StreamFrame`, the `encodeCommandResult` seam, required behaviors); §8.3 the `LandoCommandSpec.resultSchema` / `streaming` fields and the registration rule; §8.9 the `Renderer` modes the `--renderer json` bridge cooperates with; §8.4.1 the dual-dispatch single-source-of-truth rule the `--format` parser obeys.
- [`spec/07-landofile-and-config.md`](../07-landofile-and-config.md) §7.8 schema publication (the envelope/frame schemas join the `@lando/sdk` registry and the §13.2 snapshot).
- [`spec/13-testing-and-distribution.md`](../13-testing-and-distribution.md) §13.1 the machine-output conformance test layer and the dispatch-parity layer; §13.2 the schema snapshot; §13.4 the `check:machine-output` boundary gate.
- [`spec/03-architecture.md`](../03-architecture.md) §3.7 the canonical `RedactionService` every envelope is masked through.
- [`spec/09-embedding.md`](../09-embedding.md) §16 embedding hosts and agents as the consumers of the stable envelope.
- [`spec/beta-1/prd-beta-1-00-index.md`](./prd-beta-1-00-index.md) verification contract, SDK/schema lockstep, and dual-dispatch rules.

## Goals

- Make `lando <command> --format json` (and the `--json` / `-j` shorthand) accepted by **every** non-interactive canonical command, emitting a schema-valid `CommandResultEnvelope` with zero exceptions outside the enumerated interactive carve-outs.
- Produce all JSON through **one** `encodeCommandResult` seam (`Schema.encode` → `RedactionService`), never per-command `JSON.stringify`.
- Make every command's JSON shape a published, snapshot-gated contract (§13.2) so agents can pin it and it cannot silently drift; this is why `LandoCommandSpec.resultSchema` is required rather than `Schema.Unknown`.
- Define the `--format` (per-command result encoding) vs `--renderer` (global output mode) relationship, document it, and hold it at dual-dispatch parity.
- Define and ship the NDJSON `StreamFrame` contract for streaming commands (`app:logs`, `app:exec`, build progress), subsuming the existing one-off NDJSON paths.
- Guarantee JSON output is redaction-safe by construction and never swallows a non-zero exit code.

## User Stories

### US-322: Publish the machine-output schemas in `@lando/sdk`
As a plugin author or embedding host, I can import `CommandResultEnvelope`, `CommandWarning`, `CommandResultFormat`, and `StreamFrame` from the published schema surface and decode any command's JSON against them.

Acceptance criteria:
- `CommandResultEnvelope`, `CommandWarning`, `CommandResultFormat`, and `StreamFrame` are defined in `@lando/sdk` (§8.11.1/§8.11.3), re-exported from `@lando/core/schema`, registered in the central schema registry, `SDK_SCHEMA_NAMES`, and the JSON-schema registry.
- `bun run codegen:schema-snapshot` captures all four; `sdk/test/fixtures/schema-snapshot.json` updates and `git diff --exit-code` is clean afterward.
- `sdk/API_COMPATIBILITY.md` records the additions.
- Round-trip encode/decode tests pass for each schema (§13.2).
- Tests pass; Typecheck passes; Lint passes.

### US-323: Require `resultSchema` (and optional `streaming`) on `LandoCommandSpec`
As the runtime, I reject any command that does not declare the machine shape of its result.

Acceptance criteria:
- `LandoCommandSpec` carries a required `resultSchema: Schema.Schema<A>` and an optional `streaming?: StreamFrameSchema` (§8.3).
- Registration rejects a spec missing `resultSchema` with `CommandRegistrationError`; a command with no payload registers `Schema.Struct({})`.
- Every built-in command (and every deferred-command stub) declares a `resultSchema`.
- A registry-level test enumerates all canonical ids and fails if any lacks `resultSchema`.
- Tests pass; Typecheck passes; Lint passes.

### US-324: Implement the single `encodeCommandResult` serialization seam
As a maintainer, all JSON output flows through one redaction-aware function.

Acceptance criteria:
- `encodeCommandResult` (`core/src/cli/result-encode.ts`) encodes success via `Schema.encode(spec.resultSchema)` and failure via the §7.8 tagged-error schema with `ok: false`, wrapping both in `CommandResultEnvelope`.
- The encoded string is passed through `RedactionService` (§3.7) before emission; a test asserts a known secret value never appears in the envelope.
- The process exit code is preserved on failure (JSON output does not zero a non-zero exit).
- `renderer-boundary.ts`'s `json` branch routes command-result JSON through `encodeCommandResult` and bypasses per-command `render()` helpers in json renderer mode; the physical migration of legacy per-command result `JSON.stringify` producers happens in US-327 as each command receives a faithful `resultSchema`, event/deprecation NDJSON migrates in US-326, and the static enforcement gate lands in US-328.
- Tests pass; Typecheck passes; Lint passes.

### US-325: Universalize the `--format` flag plus the `--json` / `-j` shorthand across both dispatch paths
As an agent, `--format json` (or `--json` / `-j`) works identically on every command in source and compiled binary.

Acceptance criteria:
- The OCLIF command base and the compiled `runCompiledCli` parser both inject and parse `--format <value>` and the `--json` / `-j` shorthand (≡ `--format json`) from one shared module (§8.4.1 single-source-of-truth).
- The `--renderer json ⇒ default --format json` bridge is implemented; an explicit `--format` always wins.
- The OCLIF manifest regenerates to include the universal flags; `bun run scripts/build-oclif-manifest.ts` leaves a clean diff.
- The §13.1 dispatch-parity layer covers `--format json` for representative MVP commands and the deferred set.
- Tests pass; Typecheck passes; Lint passes.

### US-326: Define and emit the NDJSON streaming contract
As an agent tailing logs or exec output, I receive typed frames terminated by a result frame.

Acceptance criteria:
- `app:logs`, `app:exec`, and build-progress commands declare `streaming` and, under `--format json`, emit newline-delimited `StreamFrame`s terminated by a `result` frame carrying the envelope.
- `event` frames reuse the §11.1 `EventService` bounded redacted history (no second event tap).
- The prior one-off `doctor-ndjson` renderer, `core/src/cli/renderer/format.ts`'s json event-line renderer, and the deprecation-event JSON line are migrated onto `StreamFrame`.
- Tests assert frame ordering, the terminal `result` frame, and redaction of `event` payloads.
- Tests pass; Typecheck passes; Lint passes.

### US-327: Author result schemas for all commands and migrate the ad-hoc JSON commands
As a user, every command's JSON shape is stable and documented.

Acceptance criteria:
- Every command module declares a `resultSchema` describing its result; the ~16 commands that previously hand-rolled JSON (`info`, `list`, `doctor`, `app-config*`, `scratch`, `meta/global-status`, `plugin-*`, `update`, `uninstall`, `setup-readiness`, `includes-*`) emit through the envelope with no behavior regression (locked by snapshot).
- The legacy per-command result JSON producers are removed or migrated through `encodeCommandResult`, including the current `format === "json"` / `ctx?.mode === "json"` paths in `core/src/cli/commands/{app-config-lint,remote,config,share,app-includes-update,app-includes-verify,app-config,app-config-translate,list,scratch,meta/global-config,meta/global-status}.ts` and `renderDoctorReportAsJson` in `core/src/cli/commands/doctor-report.ts`.
- Each command's per-id result shape is present in `sdk/test/fixtures/schema-snapshot.json`.
- Tests pass; Typecheck passes; Lint passes.

### US-328: Ship the conformance and boundary gates
As a maintainer, the universal guarantee cannot regress.

Acceptance criteria:
- The §13.1 machine-output conformance layer drives **every** canonical command id (and deferred stubs) with `--format json` against `TestRuntime`, decodes the output as a `CommandResultEnvelope`, and asserts `command`/`ok` for a success and a failure case.
- `bun run check:machine-output` (§13.4) fails on any result `JSON.stringify` outside `encodeCommandResult` and on any spec missing `resultSchema`; it is wired into CI static checks.
- Tests pass; Typecheck passes; Lint passes.

### US-329: Document and guide the machine-output contract
As an agent author, I can read how to drive Lando from JSON.

Acceptance criteria:
- An executable guide ("scripting Lando / driving Lando from an agent") demonstrates `--format json` / `--json` on representative commands and is covered per §19/the guide-coverage gate.
- The generated command-reference docs note the universal `--format json` flag.
- Tests pass; Typecheck passes; Lint passes.

## Functional Requirements

- Every non-interactive canonical command MUST accept `--format json` / `--json` / `-j` and emit exactly one `CommandResultEnvelope` (or, for streaming commands, `StreamFrame`s terminated by a `result` frame).
- JSON MUST be produced only by `encodeCommandResult`; any other result `JSON.stringify` is a lint failure.
- Every envelope MUST pass through `RedactionService` (§3.7) before emission.
- The envelope and every per-command `resultSchema` MUST be in the §13.2 snapshot; a shape change MUST require an intentional snapshot regen.
- Failures MUST serialize as `{ ok: false, error: <tagged-error-json> }` with the exit code preserved.
- `--format json` MUST behave identically in source (OCLIF) and compiled (`runCompiledCli`) dispatch.

## Non-Goals

- Universal `--format yaml` / `--format table` — only `json` is the tenet guarantee; yaml/table stay per-command opt-ins.
- Changing the `--renderer` modes or the §8.9 first-paint/task-tree contract.
- A general RPC/GraphQL surface — that is the library/embedding API (§16); this is CLI stdout shape only.
- JSON output for the interactive carve-outs (`meta:setup`, `apps:init`, `meta:events:follow`, `app:shell`) **in their interactive mode**; their non-interactive results still emit an envelope.

## Technical Considerations

- **Reuses, does not reinvent:** the canonical `RedactionService` (§3.7, BETA1-06) is the only redactor; the §13.2 snapshot is the freeze mechanism; the §13.1 dispatch-parity layer (BETA1-11) is extended, not duplicated; the `EventService` redacted history (BETA1-14) feeds streaming `event` frames.
- **Primary risk — dual dispatch:** the `--format` parser exists twice (OCLIF + `runCompiledCli`); the single-source-of-truth rule (§8.4.1) and the parity layer are mandatory.
- **`apiVersion`:** one global `"v4"` envelope version; per-command shape stability is enforced by the snapshot, not per-command versioning.
- **`--json` shorthand:** `--json` and `-j` are global aliases for `--format json`, injected by the adapter, mirroring the `-j` convention agents/scripts expect (matching tools like DDEV/act).

## Success Metrics

- 57/57 non-interactive commands emit a schema-valid envelope under `--format json` (conformance gate green).
- Zero `JSON.stringify(<command result>)` call sites outside `encodeCommandResult` (boundary gate green).
- Every command's JSON shape present in `schema-snapshot.json`.
- The scripting/agent executable guide passes per-PR on every platform.

## Guide Coverage

| Guide | Path | Status |
|---|---|---|
| Driving Lando from JSON / an agent | `docs/guides/scripting-with-json.mdx` | Planned |

**CLI / source surface paths covered (drift gate input):**

- `core/src/cli/result-encode.ts`
- `core/src/cli/renderer-boundary.ts`
- `core/src/cli/oclif/command-base.ts`
- `core/src/cli/run.ts`

## Open Questions

- Should the envelope always wrap (uniform for agents) or emit the bare result on success? **Resolved: always envelope** — uniformity is the point.
- Per-command `apiVersion` vs one global envelope version? **Resolved: global envelope version + snapshot for per-command shape.**
