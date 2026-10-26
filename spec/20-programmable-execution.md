# Lando v4: Programmable Execution

> **Part 20 of 20** · [Index](./README.md)
> **Read next:** *(end of spec)*

**Programmable execution** lets a library host, plugin Effect, or agent retain an environment, run typed or interactive work in it, and collect bounded results. It composes the existing runtime (§16), App handle (§16.3), scratch apps (§21), runners (§3.4), and event bus (§11). It is authored design, not a shipped feature.

---

## 22. Programmable Execution

### 22.1 Purpose and limits

Local development is the primary product. Ordinary `start`, `exec`, `shell`, and tooling paths MUST keep their current UX, hook ordering, aliases, offline behavior, config snapshots, default provider, and §2.1 budgets, and MUST NOT gain a new concept, file format, service startup, provider probe, or background process because this chapter exists. Sessions are opt-in.

The existing runtime is the sole execution path: sessions compose `ProcessRunner`, `ShellRunner`, App operations, `ScratchAppService`, and `BuildOrchestrator` (§3.4, §6.13) with native Effect operators. This chapter adds no public scheduler AST, workflow language, or CI job model; no CLI command or `run` replacement (§21.10.3); no plugin manifest family or registry; no daemon, cross-process session, or automatic resume; no copied provider, parser, shell, or operation registry; and no sandbox, exactly-once, or replay claim. `ExecutionPolicy` (§22.6) is an admission contract, not a security boundary; Effects passed to a session are trusted code.

### 22.2 Public contracts and runtime requirements

`ExecutionSessionService` is a non-replaceable SDK service tag (§3.4, §4.2) whose `open(options)` requires the caller's `Scope` and returns an opaque `ExecutionSession`. It is composed lazily at `minimal` bootstrap (§3.2) by engine-owned services with no new package or dependency.

| Surface | Contract |
|---|---|
| `@lando/sdk/execution` | `ExecutionSessionService`, opaque handles, and schemas `ExecutionSessionOptions`, `ExecutionPolicy`, `ExecutionOperationMetadata`, `ExecutionObservation`, `ExecutionProcessRequest`, `ExecutionProcessResult`, `ExecutionArtifactRef`; these, the §22.11 errors, and §22.7 events enter the canonical SDK registries. |
| `@lando/core/execution` | Facade exporting `openExecutionSession(options)` and public types, used as `runtime.run(openExecutionSession(options))` (§16.3). |

`ExecutionSession`, `ExecutionEnvironment`, and `ExecutionProcess` are opaque, branded, function-bearing handles under the §16.3 `App` exception; consumers MUST NOT implement them structurally. Boundary data is Schema-derived. Plugins consume the SDK tag only (§2.7). Open creates no environment and makes zero app, provider, router, global-app, elevation, or network calls; it captures the caller's complete retained runtime context and overrides (runners, tracer, loggers, error reporter, plugins, config snapshot). A `minimal` runtime suffices for host-only work, and runtimes construct only the requested tier (scratch composition only in a scratch-providing tier, host `ShellRunner` lazy at `minimal`). App or scratch work requires its existing bootstrap tier; a missing tier fails before materialization with `ExecutionCapabilityUnavailableError` naming it, with no hidden escalation or stub provider. Handle provenance (§16.6) is preserved; a session never replans or rediscovers.

### 22.3 Environment ownership

| Method | Ownership | Contract |
|---|---|---|
| `borrow(app)` | Borrowed | Wraps the exact opaque `App` from the same retained runtime with its current source, plan, and hook snapshot; no discovery, start, replan, or hook replay. A handle from another runtime is rejected before delegation. |
| `acquire(input)` | Owned | Accepts a narrowed `ScratchAcquireInput` (§21.5) whose schema requires `detached: false` and creates a foreground scratch owned by the session, bound to its retained acquisition target (§22.4). `detached: true`, or a missing or non-`false` `detached`, fails with `ExecutionPolicyError` before any copy, materialization, provider action, or registry mutation and is never coerced; `ScratchAppService` detached behavior outside sessions is unchanged (§21.10.1). |

Exec, tooling, logs, and lifecycle methods delegate to the wrapped App or scratch operations with their existing typed errors; a stopped target fails as today and is never auto-started. Invocation completion or finalization MUST NOT implicitly stop, destroy, or mutate a borrowed app; only explicit operations may, under admission, with §16.3/§6.15 semantics, and §6.7/§16.6 retention is not redefined. Close cancels and drains tracked invocations and processes, waits for admitted artifact retention (§22.8), destroys owned environments exactly once through §21.6.3 and §21.10.1 (keep-on-failure is a scratch input, not a session default), and releases borrowed wrappers. A closed session or environment fails every method with `ExecutionSessionClosedError`. There is no detached session; an environment that must outlive it uses detached scratch or an ordinary app.

### 22.4 Programmatic environment inputs

`ScratchSource` gains `kind: "config"` beside the existing `fork` and `recipe` discriminants, which keep their spelling (§21.4). The form carries `config: Schema.Encoded<typeof LandofileAuthoringShapeWire>` and an authoritative `sourceRoot: AbsolutePath`; validation, one-time conversion, managed copy, canonical composition, retained-target provenance, and registry summaries follow §21.4.3, and session admission (§22.6) precedes materialization. Within a session, invalid wire input fails with existing Landofile errors before any copy or provider action, `sourceRoot` MUST be within `policy.sourceRoots` (§22.6.1), absolute mounts and shared global storage require affirmative admission, and persisted applied plans use safe environment descriptors (§5.5.2). There is no caller-supplied `AppPlan` and no temporary YAML reload.

### 22.5 Operations and process handles

`run(metadata, effect)` is the general operation; `metadata` is `ExecutionOperationMetadata` (safe name, optional source identity). `run` supplies correlation ids and an invocation child scope, records an observation (§22.7), and otherwise preserves the Effect exactly: success `A`, failure `E`, requirements, and interruption. It adds only `ExecutionPolicyError` and `ExecutionSessionClosedError` and MUST NOT serialize, redact, or infer failure from result fields; shell and MCP projections use the declared exit policy (§8.11.1). A handle acquired inside the child scope closes with it; a process that must outlive `run` is started with `startProcess` in session or caller scope.

`startProcess(request)` accepts `ExecutionProcessRequest`, an exact union:

| Variant | Adapter | Required fields |
|---|---|---|
| `host-argv` | `ProcessRunner` | binary, argv |
| `host-shell` | `ShellRunner` | explicit shell source |
| `service` | existing App exec operation | environment, service, argv |

Every variant uses captured or explicit cwd (§22.6.1) and environment descriptors, optional stdin `Stream`, optional deadline, and finite capture bounds; interactive work has no implicit deadline. A session MUST NOT read ambient stdin, mutate process cwd or env, or implicitly forward home mounts, sockets, or credentials. Omitted stdin closes immediately, a finite `Stream` sends EOF, and interruption closes stdin. Service variants are checked against declared provider capabilities (§5.4) before spawn. Host PTY and resize are unsupported and no host PTY backend is introduced: a `host-argv` or `host-shell` PTY request, like a missing provider capability, fails with `ExecutionCapabilityUnavailableError` before spawn. Service PTY and resize require declared provider support plus explicit dimensions and input; otherwise exec is non-TTY.

`ExecutionProcess` members:

| Member | Contract |
|---|---|
| `output` | Single-reader, bounded, scoped observation `Stream`. Dropped bytes appear as explicit gap records with counts; a second reader fails with `ExecutionProcessStateError`. A scoped drain starts once, so an unread stream never stalls the child. |
| `await` | Repeatable; returns the same `ExecutionProcessResult` without respawn, or the original typed spawn, provider, or timeout failure, or interruption. |
| `interrupt` | Idempotent; requests real child cancellation through the owning runner or provider. Closing `output` is not cancellation. |

`ExecutionProcessResult` is the await value for an observed exit (real exit code, bounded stdout/stderr capture, capture metadata), nonzero included. Terminal observations distinguish `exited`, `failed`, `timed-out`, and `cancelled` and never turn failure or interruption into successful awaits; a missing exit raises `ExecutionProcessStateError`, never a fabricated code. The output stream is lossy by design; the CLI unified sink (§3.7, §8.2), `app:exec` passthrough, and `DataMover` (§10.11) remain the exact-byte paths. One process scope has one idempotent release owner: caller scope and session both hold release access, whichever closes first releases the child exactly once, and one request starts at most one child.

### 22.6 Admission and credentials

`ExecutionSessionOptions` requires an explicit `workspaceRoot` and `ExecutionPolicy`; a nonsecret label and finite limits are optional. `ExecutionPolicy` constrains:

- permitted operation kinds: `host-argv`, `host-shell`, `service`, lifecycle, tooling, hooks, artifact collection, artifact retention, artifact read, artifact removal;
- mutable environment targets;
- `sourceRoots` and `mountRoots` (§22.6.1), plus whether absolute mounts and shared global storage are admitted;
- `artifactGrants`: array of `{ artifactId, operations: ("read" | "remove")[] }`, default empty (§22.8);
- explicit secret references the session may resolve;
- quotas (capture bytes, observation records, artifact bytes) and deadlines.

Host process execution and absolute mounts require affirmative grants. A derived child policy MAY narrow and MUST NOT widen its parent; an unenforceable restriction fails closed with `ExecutionPolicyError` at open.

Enforcement is invocation-local: a fiber-local admission context that runtime provision and captured `App` delegation preserve explicitly, as host observability references propagate today (§16.6.1). Wrapping an outer service is not enforcement because a captured handle replaces it on delegation. Authoritative checks live in the existing `ProcessRunner`, `ShellRunner`, provider exec, and `EnvironmentValueResolver` paths and run only when the context is present, so ordinary CLI and library paths are unchanged.

Before any workload action the session MUST preflight all known transitive managed intent (tooling steps, hooks, environment descriptors, mounts); dynamic leaves are reevaluated at dispatch and before secret resolution. Denying host hooks or a secret MUST prevent those calls even through an admitted tooling or start operation on a borrowed app. `run` does not preflight arbitrary code statically.

Secrets reuse §3.7 and §9.5.1: resolved values register with the runtime `RedactionService` before exposure, session-scoped credentials end with the session, and no second redactor exists. A ref, handle, or path is never authorization by itself.

#### 22.6.1 Roots and path resolution

| Root | Contract |
|---|---|
| `workspaceRoot` | Explicit existing absolute host directory, canonicalized at open, within `policy.sourceRoots`. Default host cwd and base for relative host paths; grants no mount authorization. |
| `policy.sourceRoots` | Explicit canonical host roots for read, copy, and cwd. Empty denies every host-source operation. |
| `policy.mountRoots` | Separately authorizes host bind-mount sources; `workspaceRoot` or `sourceRoots` membership grants none. Owned-scratch-relative mounts resolve within the acquired managed workspace, never the original host tree. |
| `config.sourceRoot` | Explicit absolute host directory within `sourceRoots`; MAY differ from `workspaceRoot`. The copy has its own managed root, and acquisition authorizes only that owned workspace. Session roots never rebase a borrowed App or its hooks. |
| Host cwd | Relative to `workspaceRoot`, within `sourceRoots`. Service cwd keeps container-path semantics and never resolves against host roots. |
| `collectArtifact` `sourcePath` | A host workspace path, never a container-only path. Relative to `workspaceRoot` without `environment`, else to that environment's authoritative host root; absolute paths must stay within the selected root. Borrowed or host reads also require `sourceRoots`; an owned scratch root is authorized by its acquisition. Container-only files first use the existing explicit provider copy / `DataMover` path (§10.11); no service is guessed and no new API shape is added. |

Roots are canonicalized and containment is revalidated at use; `process.cwd` has no effect.

### 22.7 Results, events, and output

A session keeps a bounded log of `ExecutionObservation` records (session, operation, and environment ids, safe label and source identity, timestamps, outcome, observed exit, truncation and drop counts, artifact refs) and MUST exclude Effect values, raw environment, credential-bearing argv, and file bytes. Defaults are 64 KiB captured per output stream and 256 retained records, adjustable within finite bounds; `observations` returns a snapshot plus the dropped-record count. Live metadata uses `EventService` (§11.1); the closed `@lando/sdk` registry (§3.5) gains the Execution scope:

| Event | When |
|---|---|
| `execution-session-opened` | After open; session id, label, policy summary |
| `execution-operation-started` | Before an invocation or process; metadata, environment id |
| `execution-operation-finished` | After the terminal observation; outcome, truncation counts |
| `execution-session-closing` | Close begins, before cancellation and drain |
| `execution-session-closed` | Close ends; `cleanup` is `complete` or `incomplete` |

Payloads are redacted metadata only (§11.2); plugins subscribe without publish authority. `cleanup: "incomplete"` means a finalizer failed or was interrupted; failures are preserved through the role-aware cause helpers (§8.11.1, §16.7) and orphan-recovery evidence stays in the scratch registry and ownership manifest (§21.11, §12.4.2). Interrupted Effects remain interrupted; session finalizers release resources even when caller post work fails, and caller cleanup is interruptible Effect code with an explicit deadline. Library values never pass through renderer envelopes (§8.9).

### 22.8 Local artifacts

`ExecutionArtifactRef` identifies a private file copied out of an environment or workspace; it is unrelated to build image artifacts (§6.3) and caches.

| Method | Contract |
|---|---|
| `collectArtifact({ sourcePath, environment?, mediaType? })` | Copies one authorized regular file (§22.6.1) to a private managed location before workspace cleanup; publishes id, digest, size, media type, and producer metadata only after the copy completes. |
| `retainArtifact(ref)` | Atomically moves ownership to a persistent local manifest and returns a serializable retained ref. |
| `readArtifact(ref)` | Streams exact bytes as `Stream<Uint8Array>`. |
| `removeArtifact(ref)` | Idempotently deletes only recorded owned data. |

Rules:

- Collection rejects traversal, symlink targets and symlinked ancestors, devices, root escapes, and path-swap races; no partially published artifact is readable.
- Defaults are 64 MiB per artifact and 256 MiB per session, configurable and finite. Unretained artifacts disappear at session close.
- Retention takes a session lease before closure begins; close waits for admitted retention, and later retention fails with `ExecutionSessionClosedError`.
- Active-session artifacts are authorized by current ownership plus the permitted operation kind. A retained ref from another session or a fresh runtime at the same Lando roots is readable or removable only when the permitted kinds include the operation, `policy.artifactGrants` names that exact `artifactId` with that operation, and recorded ownership matches. No wildcards; possession of a ref grants nothing.
- Interrupted publication leaves a private staging receipt reconciled, under a lock, only by the next explicit artifact operation in that namespace; session open, bootstrap, and any daemon MUST NOT reconcile.
- Storage uses `PathsService` paths, `StateStore` (§12.7) metadata, and existing byte-transfer ports. Bytes are private payload, never content-redacted or exposed as raw public paths. No upload server, expiry daemon, or global deduplication.

### 22.9 Composition and extensions

Plugin Effects consume `ExecutionSessionService` through the SDK; `LandoPluginContext` keeps its restricted views (§9.8) and plugins MUST NOT acquire sessions or scratches during install (§21.15). Builds go through `BuildOrchestrator` (§6.13), tooling restrictions (§8.5, §8.6) apply unchanged, canonical command ids come from `@lando/core/cli` (§16.7), and `App.events`/`EventService` remain the observer seam; a session duplicates none of these.

### 22.10 Developer experience and performance

Existing CLI budgets (§2.1) remain unchanged, and the cold entry MUST NOT import the facade. Execution bookkeeping MUST NOT add provider round-trips, repeat bootstrap/plan parsing, leak listeners/scopes, or grow history beyond its bounds. Concurrent operations isolate admission and correlation context. Library consumers reuse retained runtimes (§16.3); shipped usage guidance must state its package prerequisites.

### 22.11 Errors

Exactly five tagged errors are added, each with remediation; existing App (§16.3), scratch (§21.14), runner (§3.4), provider (§5.7), and Landofile (§7.8) errors pass through unchanged with `Cause` and interruption preserved and no universal wrapper.

| Error | Meaning |
|---|---|
| `ExecutionPolicyError` | Request exceeds the effective `ExecutionPolicy`, acquire input is not `detached: false`, a child grant widens, or a restriction cannot be enforced. |
| `ExecutionSessionClosedError` | Method called on a closed session, environment, or process handle, or retention requested after closing began. |
| `ExecutionCapabilityUnavailableError` | Required runtime tier, provider capability, or host feature (host PTY) is absent. |
| `ExecutionProcessStateError` | Invalid process protocol state (second reader, missing exit); separate from spawn and provider failures. |
| `ExecutionArtifactError` | Artifact validation, quota, ownership, or publication integrity failed; denied policy grants use `ExecutionPolicyError`. |

### 22.12 Acceptance

Conformance is proved by the programmable-execution contract suite in §13.1, using public library and SDK-only plugin consumers. Tests live with the implementation owner.

---
