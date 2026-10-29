# Provider failure fidelity and error-swallow audit

Contributor reference for the P4 items 1 and 3 changes on `fix/p4a`. The audit baseline is `f9c320b16`; site line numbers in the audit tables refer to that baseline so the inventory remains reproducible after formatting and fixes. No zero-argument `Effect.catch` handler was edited.

## Provider matrix

`engine/test/operations/provider-fault-matrix.test.ts` executes the actual operation entry points in process with the existing start harness and real provider registry/output policy from `registryLayer`. Each case has an ownership-matched, serialized applied plan. Injection replaces only the first mutating provider member. Each assertion checks that member was called exactly once, the operation failed, the primary error retained its tag/message/remediation, and no additional failure replaced it.

The fixture record is exhaustive over `ProviderError["_tag"]`, including all three members of the nested `SecretStoreError` union. A new tag therefore requires a fixture at typecheck time. The test is an ordinary engine test discovered by the PR test shards; it has no live-provider or environment opt-in.

| Primary tag | start/apply | stop/destroy | destroy/destroy | rebuild/destroy | restart/destroy | selected rebuild/stop | selected restart/stop |
| --- | --- | --- | --- | --- | --- | --- | --- |
| PlanReplanRequiredError | pass | pass | pass | pass | pass | pass | pass |
| EnvironmentValueResolutionError | pass | pass | pass | pass | pass | pass | pass |
| SecretNotFoundError | pass | pass | pass | pass | pass | pass | pass |
| SecretStoreUnavailableError | pass | pass | pass | pass | pass | pass | pass |
| SecretReferenceInvalidError | pass | pass | pass | pass | pass | pass | pass |
| ArtifactBuildError | pass | pass | pass | pass | pass | pass | pass |
| ProviderCapabilityError | pass | pass | pass | pass | pass | pass | pass |
| ProviderConfigError | pass | pass | pass | pass | pass | pass | pass |
| ProviderInternalError | pass | pass | pass | pass | pass | pass | pass |
| ProviderSetupConsentDeniedError | pass | pass | pass | pass | pass | pass | pass |
| ProviderSetupPrivilegeUnavailableError | pass | pass | pass | pass | pass | pass | pass |
| ProviderSetupProvisioningError | pass | pass | pass | pass | pass | pass | pass |
| ProviderSetupUnsupportedHostError | pass | pass | pass | pass | pass | pass | pass |
| ProviderUnavailableError | pass | pass | pass | pass | pass | pass | pass |
| ServiceExecError | pass | pass | pass | pass | pass | pass | pass |
| ServiceNotFoundError | pass | pass | pass | pass | pass | pass | pass |
| ServiceRestartWouldRecreateError | pass | pass | pass | pass | pass | pass | pass |
| ServiceStartError | pass | pass | pass | pass | pass | pass | pass |
| VolumeOperationError | pass | pass | pass | pass | pass | pass | pass |
| ServiceCopyError | pass | pass | pass | pass | pass | pass | pass |
| ArtifactTransferError | pass | pass | pass | pass | pass | pass | pass |

Initial execution: 145 pass, 2 fail. Both failures swallowed `ServiceNotFoundError` in selected-service `stop` calls in `engine/src/operations/rebuild.ts` and `restart.ts`. Removing those catches makes a vanished service fail rather than reporting a completed stop and continuing to apply. The two matrix cases are the regressions. Final focused matrix execution: **147 pass, 0 fail, 588 assertions, 2.63 seconds** before final formatting.

## Audit scope and searches

The scope is exactly `CORE_AND_PLUGIN_SOURCE_ROOTS` in `workspace-roots.ts`, excluding tests, generated output, and dependencies. It does not silently add `sdk/src` or `container-runtime/src`. SDK changes add optional cause fields required by the audited consumers; no public exports or service-tag signatures change.

AST searches used `ast-grep` (`/home/aaron/.omo/runtime/ast-grep/linux-x64/sg`, and the same CLI via `bunx --package @ast-grep/cli ast-grep`). Patterns:

```text
Effect.mapError(() => $BODY)
Effect.mapError($E, () => $BODY)
$RECV.catch(() => $BODY)
$RECV?.catch(() => $BODY)
Effect.catch(() => $BODY)
```

Promise results were restricted to `undefined`, `null`, `[]`, `{}`, and `false`, including parenthesized/block returns. `Effect.catch` and `Stream.catch` are not promise handlers. Ripgrep cross-checks included multiline handlers and optional chaining. There were **48 zero-argument mapError sites in 25 files**, and **14 promise-swallow sites in 11 files**. Data-first zero-argument mapError handlers had no matches.

### Effect.mapError decisions

`preserve` means the error wrapper now retains the original cause; its existing user-facing message and specific remediation remain intact. `keep` means a deliberate safe diagnostic or failure-classification boundary, not successful completion after an operational failure. Repeated line numbers in a row enumerate every matching site in that file.

| Baseline site | Sites | Decision | Reason |
| --- | ---: | --- | --- |
| engine/src/install/record.ts:48, :54 | 2 | keep | Fixed JSON/schema explanations do not retain arbitrary install-record bytes in schema failures. The file and invalid-json/schema reason remain available. |
| engine/src/install/record.ts:100, :112, :128, :137 | 4 | preserve | Inspection/read errors retain the underlying filesystem tag, message, remediation, and cause in an optional local error field. ENOENT is already handled separately. |
| managed-file/src/transaction-journal.ts:91, :105, :108, :123, :131, :136 | 6 | keep | Transaction journals/errors/receipts deliberately carry paths, modes and digests only, never file bytes or state-store codec payloads. The journal phase/reason and recovery remediation are the safe diagnostic. |
| managed-file/src/transaction.ts:84, :93 | 2 | keep | Invalid transaction payloads and advisory-lock internals are normalized to path/lock preparation failures without retaining transaction file contents. |
| managed-file/src/transaction-recovery.ts:111 | 1 | keep | Same payload-free transaction lock contract during recovery. |
| data-mover/src/command-failure.ts:25 | 1 | keep | The execution failure can contain private dump bytes. Existing command-failure tests require no raw provider error/stdout, no manufactured exit code, and preserved interruption; stderr diagnostics are separately bounded/redacted. |
| landofile/src/pipeline/legacy.ts:20 | 1 | keep | This is secondary classification after an existing parse/validation failure. A failed reread must preserve that original primary error rather than replace it. |
| engine/src/subsystems/host-proxy/worker-state-file.ts:81 | 1 | keep | Encoding errors can retain the worker record's controlToken/token. The safe state-path failure intentionally excludes that record and still fails the write. |
| engine/src/planner/connection-client-task.ts:38, :40, :62 | 3 | preserve | Root, applied-plan lookup, and plugin-load failures now remain the cause of the replan refusal rather than becoming indistinguishable from missing applied facts. |
| engine/src/services/service-certs.ts:107, :112 | 2 | preserve | Custom certificate stat/read failures retain the filesystem cause, while keeping the authored-path validation issue and remediation. Certificate contents are not attached. |
| engine/src/operations/start-agent-intent.ts:36 | 1 | preserve | SSH/GPG broker configuration failures retain the original Landofile failure in the existing transport-error cause field. |
| core/src/recipes/config-translator.ts:88 | 1 | keep | This validator checks only whether the decomposed fragment is a mapping. The fixed explanation and action are complete; retaining schema input could expose recipe secrets. |
| engine/src/services/host-opener.ts:62 | 1 | preserve | Local opener errors retain process failures, including timeout versus executable/permission problems, in an optional local cause field. |
| engine/src/subsystems/gpg-agent/discovery.ts:56 | 1 | preserve | Failure to launch gpgconf retains the process error under the unavailable diagnostic instead of discarding its explanation/remediation. |
| core/src/recipes/init-pipeline.ts:163, :185, :198, :211, :214, :224 | 6 | keep | The pipeline explicitly checks secret-bearing answers/fragments and refuses to write them. Stage-specific safe failures intentionally avoid storing input-bearing schema/translator failures; public diagnostics are redacted separately. |
| plugins/provider-docker/src/agent-socket-relay.ts:104, :199 | 2 | preserve | API and image-pull errors retain their tagged transport/provider causes under the relay wrapper. |
| plugins/provider-docker/src/agent-socket-relay.ts:206 | 1 | keep | A malformed container-identifier response gets a fixed safe diagnostic, without retaining arbitrary response bytes. |
| plugins/provider-docker/src/agent-socket-relay.ts:246 | 1 | keep | runProbe has no recoverable error channel here; failed samples become probe verdicts. This mapping is not hiding a provider error from the operation. |
| plugins/sql/src/checked-execution.ts:27 | 1 | keep | Same explicit private-output boundary as data mover. Existing SQL diagnostic tests require that raw provider errors and dump stdout never enter errors; exit/stderr diagnostics follow a separate redacted path. |
| plugins/sql/src/runtime-observation.ts:127, :147 | 2 | keep | Recovery refuses to proceed when it cannot return the inspected database to stopped. The safe state-restoration reason and logical-export remediation are intentional; arbitrary observation/execution payloads are excluded. |
| plugins/sql/src/compression.ts:110 | 1 | keep | Compression errors can originate in a plaintext dump stream. The safe operation/path/compression diagnostic intentionally excludes raw stream error payloads and still fails the transfer. |
| plugins/service-lando/src/services/mailpit.ts:76 | 1 | keep | A single service-name pattern check is replaced by a precise grammar issue and rename remediation, not a generic loss of an operational failure. |
| core/src/cli/commands/doctor-plugin-checks.ts:138 | 1 | keep | A plugin report may contain malformed or secret-bearing payloads. The safe invalid-payload/budget explanation intentionally replaces input-bearing schema details. |
| plugins/proxy-traefik/src/route-acceptance.ts:75 | 1 | keep | Probe samples become verdicts; runProbe has no recoverable error channel here. Non-convergence remains an explicit ProxyApplyError. |
| core/src/cli/commands/app-config-migrate-write.ts:76 | 1 | keep | Failed lossless encoding has a fixed diagnostic and writes nothing. Retaining arbitrary authored values in the encoder failure would expose Landofile material. |
| plugins/provider-lando/src/windows-sync-recovery.ts:84 | 1 | preserve | Retained-writer inventory errors retain the provider API cause before any destructive action. |
| plugins/provider-lando/src/windows-sync-helper.ts:209 | 1 | preserve | Image-inspection failure retains the original tagged provider cause under the image-verification wrapper. |

Result: **16 preserved, 32 kept**. No blanket mapError ban: legitimate validation, payload-safety, and primary-error-preservation uses remain.

### Promise decisions

| Baseline site | Return | Decision | Reason |
| --- | --- | --- | --- |
| state-store/src/paths.ts:56 | null | narrow | Only ENOENT permits climbing to the deepest existing ancestor. EACCES, ELOOP and ENOTDIR propagate into StateStoreError with the original cause. |
| data-mover/src/service.ts:392 | null | narrow | Only ENOENT permits the endpoint ancestor walk. Other errors reach the existing endpoint-validation failure boundary. |
| landofile/src/bun-sh-discovery.ts:318 | undefined | narrow | Only ENOENT means no scripts directory. Other inspection errors become BunShellScriptFrontMatterError with cause, not an empty successful discovery. |
| landofile/src/bun-sh-script.ts:18 | undefined | narrow | Only ENOENT means an absent segment. Other lstat errors become a tagged script-path failure with cause and specific remediation. |
| engine/src/operations/plugin-link.ts:83 | undefined | narrow | Only ENOENT means there is no registry symlink to remove. Other errors propagate to the owning plugin operation. |
| engine/src/operations/plugin-link.ts:217 | undefined | narrow | Only ENOENT means a missing unlink target. Failed inspection cannot authorize restoring/removing registry state. |
| state-store/src/service.ts:68 | undefined | keep | Best-effort quarantine of already-corrupt state; rename failure must not replace the corrupt-state handling path. |
| data-mover/src/staged-stream.ts:30 | undefined | keep | Scope cleanup of a temporary stage that may already have moved or disappeared; it must not replace the transfer failure. |
| engine/src/services/process-runner.ts:235 | undefined | keep | Existing comment assigns completion to child exit; iterator-close failure must not mask it. |
| engine/src/services/process-runner.ts:446 | undefined | keep | Interruption waits for child exit without replacing cancellation with an exit-promise rejection. Optional-chain form is included. |
| engine/src/subsystems/host-proxy/worker-ownership.ts:95 | [] | keep | This entire bulk worker cleanup is best-effort (the enclosing Effect.catch already says so). Narrowing only the inner readdir catch would not change that contract and would cross into the excluded Effect.catch audit. |
| plugins/provider-lando/src/nft-provision.ts:257 | undefined | keep | Rejection sink for a concurrently observed stdin promise. The original promise is still awaited/raced; expected EPIPE is already narrowed upstream. |
| plugins/renderer-lando/src/opentui/live-region-spool.ts:83 | undefined | keep | Disposal must continue removing the spool after an earlier queued write failure. |
| plugins/renderer-lando/src/opentui/live-region-spool.ts:88 | undefined | keep | Best-effort temporary scrollback directory removal during renderer disposal. |

Result: **6 narrowed, 8 kept**. The baseline return counts were undefined 11, null 2, empty array 1, empty object 0, false 0. The two null handlers were both ancestor-probe bugs; neither had a legitimate full-swallow use.

## Boundary ban decision

Extend the existing `effect-idioms` rule, not the registry count, to reject **zero-argument `.catch` arrow handlers returning null**. Parenthesized expressions, optional chaining and a single block return are covered. A handler that inspects an error and returns null only for ENOENT remains allowed. Tests also retain legitimate undefined/empty-array cleanup handlers. The registry justification and inventory row record why package dependency direction cannot enforce this behavior.

Do not ban all zero-argument mapError handlers or all promise swallows. The audit above supplies their remaining legitimate uses. Do not add a blanket false/empty-object ban just because those forms were never found.

## Effect.catch follow-up hotspots

**172 sites in 108 files**, counted with `Effect.catch(() => $BODY)` over the same shipped roots. These are inventory only. This task records the issue-ready list rather than creating a remote issue. Counts exclude catchTag/catchIf, Stream.catch, and promise.catch.

```text
plugins/provider-lando/src/managed-runtime-service.ts: 7
plugins/proxy-traefik/src/socket-proxy-install.ts: 6
core/src/cli/commands/doctor-ssh-agent.ts: 5
engine/src/subsystems/host-proxy/worker-control.ts: 5
core/src/cli/commands/doctor-global-app.ts: 4
engine/src/subsystems/host-proxy/worker-ownership.ts: 4
core/src/cli/commands/doctor-report.ts: 3
core/src/cli/commands/update-plugins.ts: 3
engine/src/planner/assemble.ts: 3
engine/src/services/command-registry.ts: 3
plugins/proxy-traefik/src/doctor-tls.ts: 3
core/src/cli/command-specs/meta/setup-steps.ts: 2
core/src/cli/commands/doctor-plugin-context.ts: 2
core/src/cli/commands/doctor-proxy-check.ts: 2
core/src/cli/commands/setup-readiness.ts: 2
core/src/cli/renderer-deprecations.ts: 2
core/src/recipes/init-pipeline.ts: 2
engine/src/cache/command-index-writer.ts: 2
engine/src/lifecycle/subscribers.ts: 2
engine/src/operations/file-sync-plan.ts: 2
engine/src/operations/start-ssh-agent.ts: 2
engine/src/plugins/plugin-discovery.ts: 2
engine/src/scratch-app/startup.ts: 2
engine/src/services/build-app-gates.ts: 2
engine/src/services/build-orchestrator.ts: 2
engine/src/subsystems/host-proxy/worker-state-file.ts: 2
engine/src/subsystems/ssh-agent/host-agent-discovery.ts: 2
engine/src/subsystems/ssh-agent/session.ts: 2
engine/src/update/manifest.ts: 2
engine/src/update/operation.ts: 2
plugins/provider-lando/src/exec-conmon.ts: 2
plugins/provider-podman/src/index.ts: 2
plugins/proxy-traefik/src/global-services/traefik.ts: 2
plugins/proxy-traefik/src/live-route-snapshot.ts: 2
plugins/proxy-traefik/src/observe-routes.ts: 2
plugins/proxy-traefik/src/port-acquisition-bind.ts: 2
plugins/proxy-traefik/src/proxy-setup.ts: 2
plugins/proxy-traefik/src/proxy.ts: 2
plugins/proxy-traefik/src/socket-proxy-setup.ts: 2
plugins/sql/src/recovery.ts: 2
core/src/cli/command-lifecycle.ts: 1
core/src/cli/commands/app-cache-refresh.ts: 1
core/src/cli/commands/doctor-host-proxy-container-probe.ts: 1
core/src/cli/commands/doctor-runtime-service.ts: 1
core/src/cli/commands/doctor.ts: 1
core/src/cli/commands/list-path-filter.ts: 1
core/src/cli/commands/list.ts: 1
core/src/cli/commands/meta/global-status.ts: 1
core/src/cli/require-confirmation.ts: 1
data-mover/src/service.ts: 1
engine/src/cache/app-plan.ts: 1
engine/src/deprecation/plugin-registry.ts: 1
engine/src/deprecation/service.ts: 1
engine/src/deprecation/telemetry.ts: 1
engine/src/landofile/app-resolution.ts: 1
engine/src/lifecycle/routes.ts: 1
engine/src/operations/app-mutation-lock.ts: 1
engine/src/operations/destroy-plan.ts: 1
engine/src/operations/destroy-provider.ts: 1
engine/src/operations/global-routes.ts: 1
engine/src/operations/global-teardown.ts: 1
engine/src/operations/landofile-events.ts: 1
engine/src/operations/missing-app-roots.ts: 1
engine/src/operations/service-readiness-supervision.ts: 1
engine/src/operations/share.ts: 1
engine/src/operations/start-file-sync.ts: 1
engine/src/operations/start-internal.ts: 1
engine/src/planner/app-identity.ts: 1
engine/src/planner/git-host-checks.ts: 1
engine/src/providers/registry-evidence.ts: 1
engine/src/runtime/bootstrap-lifecycle.ts: 1
engine/src/scratch-app/service.ts: 1
engine/src/subsystems/detached-worker/state-file.ts: 1
engine/src/subsystems/host-proxy/transport-dispatch.ts: 1
engine/src/subsystems/host-proxy/transport-lifecycle.ts: 1
engine/src/subsystems/host-proxy/transport.ts: 1
engine/src/subsystems/host-proxy/worker-reuse.ts: 1
engine/src/subsystems/ssh-agent/cleanup.ts: 1
engine/src/subsystems/ssh-agent/worker-reuse.ts: 1
engine/src/update/handoff.ts: 1
engine/src/update/self-update.ts: 1
engine/src/update/verify.ts: 1
engine/src/update/windows-helper.ts: 1
landofile/src/pipeline/compose.ts: 1
landofile/src/pipeline/finalize.ts: 1
landofile/src/source.ts: 1
mcp/src/confirmation.ts: 1
mcp/src/dispatch.ts: 1
plugins/file-sync-mutagen/src/index.ts: 1
plugins/file-sync-mutagen/src/mutagen-process-client.ts: 1
plugins/provider-docker/src/iptables-forward-check.ts: 1
plugins/provider-lando/src/applied-file-sync.ts: 1
plugins/provider-lando/src/applied-state.ts: 1
plugins/provider-lando/src/ensure-runtime.ts: 1
plugins/provider-lando/src/index.ts: 1
plugins/provider-lando/src/linux-runtime-health.ts: 1
plugins/provider-lando/src/podman-service-runner.ts: 1
plugins/provider-lando/src/wsl-mount-propagation.ts: 1
plugins/proxy-traefik/src/advertised-proxy-ports.ts: 1
plugins/proxy-traefik/src/apply-routes.ts: 1
plugins/proxy-traefik/src/doctor-watcher.ts: 1
plugins/proxy-traefik/src/leftover-proxy-ports.ts: 1
plugins/proxy-traefik/src/port-acquisition-ownership.ts: 1
plugins/proxy-traefik/src/port-acquisition-state.ts: 1
plugins/proxy-traefik/src/preferred-host-ports.ts: 1
plugins/proxy-traefik/src/watcher-diagnostic-state.ts: 1
plugins/service-lando/src/services/mailhog.ts: 1
plugins/sql/src/progress.ts: 1
```

## Verification results

Runtime: Bun 1.4.3, Effect 4. All runs below used explicit paths or package filters, never the full test suite.

| Spot run | Passed | Failed | Files | Duration |
| --- | ---: | ---: | ---: | --- |
| Provider matrix alone | 147 | 0 | 1 | 2.63 s |
| `engine/test/operations/start*.test.ts` plus provider matrix | 360 | 0 | 21 | 4.24 s |
| `engine/test/operations/stop*.test.ts` plus `applied-state-teardown.test.ts` | 92 | 0 | 2 | 2.05 s |
| `engine/test/operations/destroy*.test.ts` | 27 | 0 | 2 | 1.106 s |
| `engine/test/operations/rebuild*.test.ts` | 13 | 0 | 4 | 1.98 s |
| `engine/test/operations/restart*.test.ts` | 40 | 0 | 5 | 22.36 s |
| `engine/test/providers/` | 183 | 0 | 13 | 0.654 s |
| `core/test/scripts/check-effect-idioms-boundary.test.ts` | 56 | 0 | 1 | 0.852 s |
| Additional touched/adjacent tests listed below | 602 | 0 | 21 | 5.03 s |

The matrix-alone row is included in the start-group row, not additional coverage. The other eight grouped rows total **1,373 passed, 0 failed**. The extra test paths were:

```text
engine/test/install/record.test.ts
engine/test/services/host-opener.test.ts
engine/test/services/service-certs.test.ts
engine/test/services/service-certs-routes.test.ts
engine/test/planner/connection-client-task.test.ts
engine/test/subsystems/gpg-agent/discovery.test.ts
engine/test/operations/applied-connection-clients.test.ts
engine/test/operations/plugin-link.test.ts
landofile/test/bun-sh-discovery.test.ts
landofile/test/bun-sh-script.test.ts
landofile/test/script-probe-failure.test.ts
state-store/test/state/paths.test.ts
state-store/test/state/path-containment.test.ts
data-mover/test/path-containment.test.ts
data-mover/test/service.test.ts
plugins/provider-docker/test/agent-socket-relay.test.ts
plugins/provider-docker/test/agent-relay-failure-cause.test.ts
plugins/provider-lando/test/windows-sync-recovery.test.ts
plugins/provider-lando/test/windows-sync-helper.test.ts
sdk/test/library/sdk-public-surface.test.ts
sdk/test/errors/diagnostic-shape.test.ts
```

The containment run initially exposed three old tests explicitly asserting that EACCES should be ignored. Those tests now require failure and prove that lookup stops at the inaccessible path, instead of authorizing an unverifiable path or transfer. The ENOENT/missing-ancestor happy paths remain covered and passing.

| Gate | Exact result |
| --- | --- |
| Package-filtered `typecheck` | Exit 0 for `@lando/sdk`, `@lando/engine`, `@lando/core`, `@lando/landofile`, `@lando/data-mover`, `@lando/state-store`, `@lando/provider-docker`, `@lando/provider-lando` |
| `bun run --filter='@lando/sdk' build` | Exit 0 |
| `bun run typecheck` | Exit 0, including aggregate test types |
| `bun run lint` | Exit 0; 4,795 files checked; deprecation check passed |
| `bun run check:boundaries` | Exit 0; all 14 registered rules passed |
| `bun run codegen:schema-snapshot` | Exit 0; 477 SDK schemas, 91 command schemas |
| `bun run codegen:check` | Exit 0; codegen catalog clean |
| `bun run check:schema-compatibility` | Exit 1 against origin/main: compatible=2, breaking=5, unknown=0, accepted=31, skipped=0 |
| `LANDO_SCHEMA_COMPATIBILITY_BASE_REF=HEAD bun run check:schema-compatibility` before these commits | Exit 0 against integrated baseline `f9c320b16`: compatible=1, breaking=0, unknown=0, accepted=0, skipped=0 |
| `git diff --check` | Exit 0 |

The five default compatibility findings predate this work: removed `CommandCompletion`, `CommandOutput`, and `CommandOutputChunk` surfaces; removed `CommandResultEnvelope.output`; removed `VerifyProps.expectExit`. No compatibility exceptions were added to conceal them. The incremental optional `PlanReplanRequiredError.cause` property is compatible. GPG and Landofile validation error classes are not standalone JSON-schema registry entries. Public-surface conformance passed without a fixture change because no export or service signature changed.

LSP checks report no errors on changed TypeScript files. Markdown has no configured language server. Existing Bun assertion-type hints in the plugin-link tests are not type errors.

Manual library/API QA used an isolated-root Bun driver with `scripts/test-preload.ts`, not a test runner: `startAppForTarget` successfully started `web`; selected `restartApp` injected a missing service and returned the identical `ServiceNotFoundError` primary object with its specific remediation. Observed output:

```json
{"scenario":"start happy path","services":["web"]}
{"scenario":"selected restart missing service","primary":"ServiceNotFoundError","remediation":"Inspect the selected service before restarting it."}
```

A separate read-only gate reviewer approved the matrix seam, inventory counts, cause safety, errno narrowing, and forbidden-file compliance. Live container/provider execution was not run; the requested matrix is intentionally in-process.

Guide-Coverage-Skip: Fault-injection coverage, diagnostic cause retention, and errno narrowing do not change the documented CLI syntax or successful app workflow.
