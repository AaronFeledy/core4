# github-actions-plugin - Work Plan

## TL;DR (For humans)
**Who this is for and what changes for them:** Developers run their GitHub workflows locally, while maintainers can register a Lando-backed runner for real GitHub jobs. Ordinary Lando development remains unchanged.

**What you'll get:** An optional plugin with native local workflow execution and event simulation, plus remote execution through GitHub's official runner. Both use Lando-owned environments, explicit credentials and truthful results.

**Why this approach:** Reuse the completed execution foundation and upstream language libraries, not act or a second container runtime. Add two narrow generic contracts where the foundation deliberately stops: exact process payloads and containers attached to an owned environment.

**What it will NOT do:** No plugin implementation in this planning change; no automatic runner registration, hosted-VM parity, fabricated cloud credentials, permanent core daemon or hostile-code sandbox promise.

**Effort:** XL
**Risk:** High - byte protocols, dynamic masking, container ownership and multi-process cancellation must compose correctly.
**Decisions to sanity-check:** Native local interpretation; official runner only for remote mode; runner itself inside an owned container; explicit local cache/artifact adapters; optional installation and Linux capability profiles.

This plan is evaluated against the completed prerequisite contracts. Implementation remains gated on their merge evidence and the two generic follow-ons.

---

> TL;DR (machine): XL; high risk; 22 implementation-and-test tasks in four waves, two generic follow-ons, four final verification tasks; one planning PR, no product implementation.

## Scope
### Affected user and ideal state
**Affected user:** Developers run their existing GitHub workflow files locally; repository maintainers dispatch real GitHub jobs to a Lando-backed runner; agents inspect structured plans/results. Developers who do not install this plugin retain their current commands, startup cost, provider defaults and app lifetimes.

This is an implementation plan, not evidence that the plugin ships. It assumes the completed execution-foundation issues below. Publication of this plan does not implement, close or release those prerequisites, register a runner, assign a release, or authorize workloads. No dependency on `act` is permitted.

| Row | Statement | Reason |
| --- | --- | --- |
| IS-1 | Execute selected workflows/jobs from existing YAML with native Actions semantics | No duplicate pipeline authoring or act wrapper |
| IS-2 | Select or simulate an event explicitly and explain matching jobs | Reproduction must not publish a commit or pretend an event was delivered by GitHub |
| IS-3 | Accept real GitHub jobs through the official runner and execute in Lando-owned environments | Remote execution is part of the deliverable, not a later substitute |
| IS-4 | Local and remote paths share provider-neutral environment/process ownership | Avoid another runtime, provider client or lifecycle engine |
| IS-5 | Preserve truthful outcomes, exact protocol bytes and bounded observations | A truncated stream cannot drive workflow commands or runner handshakes |
| IS-6 | Explicit trust, secret grants, cleanup and failure evidence | Admission is not a sandbox and cleanup must not target unrelated apps |
| IS-7 | Optional installation leaves ordinary Lando behavior unchanged | Local development remains the primary product |
| GAP-1 | Actions language, contexts, events and action lifecycle are plugin-specific | Generic execution intentionally does not interpret a CI dialect |
| GAP-2 | Exact protocol payloads and owner-network one-shot containers need explicit follow-on contracts | The foundation promises lossy observation and service exec, not these additions |
| GAP-3 | Remote hooks are separate processes and do not cover every job shape | One outer owner must outlive callbacks without a core daemon |
| GAP-4 | Action acquisition, local cache/artifact behavior and upstream pins need defined boundaries | Upstream services and hosted VM images are not locally interchangeable |
| GAP-5 | Optional packaging, machine output and differential/live evidence need delivery work | A parser or mocked hook alone is not a functioning integration |

### Future baseline and dependency ledger

Review this plan against these completed contracts, not against their current absence in source. Before executing a dependent task, verify its prerequisite implementations and transitive prerequisites are merged and their acceptance passes; an issue being open or closed alone is not proof. Existing foundation work is not re-owned here.

| Future issue | Assumed guarantee | Explicit limit retained by this plan |
| --- | --- | --- |
| [#1734](https://github.com/AaronFeledy/core4/issues/1734) | SDK `ExecutionSessionService`, opaque handles, schema-backed boundary data and tagged errors | Handles are in-process; no public workflow AST |
| [#1735](https://github.com/AaronFeledy/core4/issues/1735) | One retained runtime, caller-context capture, tier-correct Scope-owned sessions | No hidden tier escalation or detached session |
| [#1736](https://github.com/AaronFeledy/core4/issues/1736) | Config-backed scratch from authoring-wire data and an authoritative source root; retained managed-root provenance | No caller-supplied AppPlan or YAML round trip |
| [#1737](https://github.com/AaronFeledy/core4/issues/1737) | Invocation-local admission, explicit roots/mounts/secret references, narrowing child policy | Not a filesystem/network sandbox or implicit engine-socket grant |
| [#1738](https://github.com/AaronFeledy/core4/issues/1738) | Borrowed apps survive; session-acquired scratch is foreground, owned and destroyed exactly once | Session acquire requires literal `detached: false` |
| [#1739](https://github.com/AaronFeledy/core4/issues/1739) | Host argv/shell and service processes, stdin/EOF, cancellation, repeatable real terminal results | `ExecutionProcess.output` is bounded, single-reader and lossy; no inferred owner-network attachment |
| [#1740](https://github.com/AaronFeledy/core4/issues/1740) | Private local artifacts, exact-byte reads, explicit retention and exact-id cross-session grants | Not a GitHub artifact/cache service; possession alone is not authorization |
| [#1741](https://github.com/AaronFeledy/core4/issues/1741) | Public host facade and SDK-only plugin service access, existing command-completion semantics | Plugin code does not import core or private engine modules |
| [#1742](https://github.com/AaronFeledy/core4/issues/1742), [#1743](https://github.com/AaronFeledy/core4/issues/1743) | Documented usage and local-development performance/lifecycle proof | Installed-but-unused plugin must preserve those budgets |

The foundation merge gate is [#1733](https://github.com/AaronFeledy/core4/issues/1733); the tracker is [#1732](https://github.com/AaronFeledy/core4/issues/1732). Its transitive cancellation, redaction, scratch-provenance and completion dependencies remain authoritative. This plan adds only the residual contracts explicitly named below.

### Evidence baseline and upstream pins

Repository source baseline: `3022c0b08b270dcbbf0c2d295bf5d8e3e0ac0f0f`. Current references establish existing seams; proposed paths below are additions unless explicitly identified as existing.

- `sdk/src/services/provider.ts:187` has service exec user/cwd/env/byte streams. `EphemeralRunSpec` at line 213 lacks a network target, cwd and user; its `owner` is not network authorization.
- `sdk/src/services/process.ts:100` exposes byte-streaming `ProcessRunner`; `sdk/src/app/index.ts:391` exposes buffered App exec. Neither proves a future policy-preserving process-payload API by implication.
- `plugins/sql/src/index.ts:30` and `sdk/src/plugins/command.ts:69` establish optional command contribution, explicit completion and lazy loading. `engine/src/tooling/step-program.ts` is a Lando-specific private representation, not an Actions scheduler API.
- Official runner pin: **v2.338.1**, commit [`e78522a9a7b01c3bcd7ac0da6e3a9bb6cd513a76`](https://github.com/actions/runner/tree/e78522a9a7b01c3bcd7ac0da6e3a9bb6cd513a76). `src/Runner.Worker/JobExtension.cs:318` schedules container preparation only when job/service containers exist. Host-only jobs therefore cannot depend on `prepare_job` or `cleanup_job` for ownership.
- [Container customization](https://docs.github.com/en/actions/how-tos/manage-runners/self-hosted-runners/customize-containers) is Linux-only and public preview. The pinned `ContainerHookManager.cs` under `src/Runner.Worker/Container/ContainerHooks/` defines stdin JSON, response-file data, opaque state and cancellation. Test pinned source behavior when prose/ADR differ; do not rely on the ADR's older always-called claim.
- Reuse MIT `@actions/expressions@0.3.61` and `@actions/workflow-parser@0.3.61`, from languageservices [`b71ac284fc6a7382c22ecbf3e0009a6ae216823b`](https://github.com/actions/languageservices/tree/b71ac284fc6a7382c22ecbf3e0009a6ae216823b), behind plugin-local adapters and Bun compatibility tests. They supply parsing/pure evaluation, not running jobs, IO, contexts, status functions or `hashFiles`. Pin exact dependencies and lockfile integrity; no copied evaluator or broad Landofile parser change.
- Semantics references: [workflows](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax), [expressions](https://docs.github.com/en/actions/reference/workflows-and-actions/expressions), [action metadata](https://docs.github.com/en/actions/reference/workflows-and-actions/metadata-syntax), [workflow commands](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-commands), [runner registration/JIT REST](https://docs.github.com/en/rest/actions/self-hosted-runners).

Pins are the conformance baseline, not a promise that GitHub accepts an obsolete runner forever. Runner upgrades are an explicit verified provisioning operation with conformance tests, not an unverified self-update inside the packaged installation.

### Must have

#### Package and user surface

Create optional workspace package `plugins/github-actions` published as `@lando/github-actions`. Do not add it to the bundled-plugin list. Production imports use public SDK contracts plus the two pinned Actions language packages; no `@lando/core`, private engine/container-runtime imports, `act`, or direct Docker/Podman client. Provide four lazy command contributions and matching exported Effect operations:

| Command | Behavior and inputs | Structured result |
| --- | --- | --- |
| `github-actions:list` | Discover `.github/workflows/*.yml` and `*.yaml` within explicit/captured root; optional workflow selector | Workflow/job identities and parse diagnostics; no provider or network calls |
| `github-actions:plan` | Select workflow, event, supplied event JSON, job and matrix filters; inputs, vars, runner-image mappings and offline policy | Redacted expanded job intent, dependency graph, supported/unsupported features and known required grants; no workload execution |
| `github-actions:run` | Same selection plus explicit trusted-workflow acknowledgment, secret references, finite concurrency and execution policy | Workflow/job/step outcomes, real exit codes, diagnostic/artifact references and compatibility profile |
| `github-actions:runner` | Explicit repository/organization target and secret reference for JIT configuration or authorized registration; one ephemeral runner assignment per invocation | Registration/assignment/completion outcome and cleanup evidence; no ambient token discovery or automatic fleet/service install |

Use canonical names above, not a replacement for bare `run`. No new mandatory Landofile or parallel pipeline YAML. Host roots, API options and image mappings belong to command inputs/plugin-library options; secrets are references, never literal CLI arguments or result fields. `list` is offline/pure acquisition; remote resolution required by `plan` obeys an explicit policy and reports unresolved offline references rather than guessing. `run` maps workflow failure to exit 1 and cancellation to the existing interruption projection; parse/unsupported/preflight failures use tagged failures. Successful negative reports remain successful data. Declare `completion` on executable specs, not field-name heuristics. Use the Renderer service for user-facing output and the canonical machine-output envelope. No automatic MCP write-tool publication.

Selection flags are `--root` (captured cwd by default), `--workflow` (repository-relative workflow path), required `--event` for plan/run, optional `--event-path` JSON, repeatable `--changed-file`, `--input name=value`, `--var name=value`, `--secret NAME=<secret-reference>`, `--runner-image label=image@sha256:<digest>`, and `--offline`. `--job` selects an exact job ID; repeatable `--matrix axis=value` requires that selection. `run` requires `--trust-workflow` and accepts `--concurrency` in 1..256 (default 4). No implicit token/environment forwarding occurs. Remote runner uses exactly one of `--repository owner/name` or `--organization name`, exactly one of `--jit-config-ref` or `--github-token-ref`, repeatable `--label`, `--idle-timeout` (default 600 seconds, positive finite), and `--trust-workflow`. Standard renderer/format/help flags remain core-owned. Library exports are `listWorkflows`, `planWorkflow`, `runWorkflow`, and `runRegisteredRunner`, returning Effects with explicit SDK requirements.

Plugin-owned schemas include WorkflowSelection, WorkflowPlan, WorkflowRunResult, RunnerOptions, RunnerRunResult and CompatibilityProfile. Boundary errors are GithubActionsWorkflowError, GithubActionsUnsupportedFeatureError, GithubActionsActionSourceError, GithubActionsProtocolError and GithubActionsRunnerError, with safe source location/remediation and no raw secret-bearing payload. Existing execution/provider/build failures retain their typed causes rather than being universally wrapped. Schema-backed `line`/`column` fields follow SDK Error property conventions.

These are end-state contract names, not a requirement to publish speculative shapes before their consumers exist. Each delivery exposes only schemas and errors exercised by its implemented operations. The early inspection slice uses concrete list options and workflow-inspection reports; planning, process outcomes, runner admission/results and artifacts are modeled with their owning execution implementations. Authored input shapes and admitted request types must be distinguishable, and mutually exclusive alternatives or lifecycle states must be enforced at the public admission boundary rather than only by an optional helper.

#### Early offline inspection (#1856)

Publish `github-actions:list` and `listWorkflows` independently of local execution. Packaging and the necessary bounded parsing subset may land together in one dependency-coherent PR after the reviewed-plan gate. This slice does not claim completion of task 4's expression/alias conformance, task 15's planning/execution, or any execution-foundation prerequisite.

The CLI accepts `--root` (captured invocation cwd by default) and an exact repository-relative `--workflow` path directly under `.github/workflows/`. It requires no Landofile, provider, secret resolution, network access, expression evaluation or workload execution. Missing default workflow directories produce a useful empty inventory; invalid roots and unmatched explicit selectors fail with tagged diagnostics. Individual malformed files remain visible with source-located diagnostics while other files are inspected. A completed report containing negative findings is successful data, not an execution result.

Project literal trigger/job/dependency identities and observable requirements only. Dynamic expressions, matrix expansion and reusable-workflow bodies remain explicitly unresolved or unassessed; absence of a known restriction is never admission. Diagnostics carry fixed codes, known source locations, allowlisted field/rule details and relevant remediation, never raw upstream messages, authored values, scripts or exception causes. Terminal output must safely render source metadata and distinguish discovery, successful inspection, failed files, uninspected files and truncated diagnostics.

Acquisition has one scoped owner: establish the canonical selected root, reject symlinked discovery directories/candidates and nonregular files, bound actual reads and directory enumeration, and close handles on cancellation. The initial profile admits at most 100 workflow candidates, 256 KiB per file and 8 MiB aggregate. Inventory overflow fails explicitly rather than sampling; exhausted aggregate budgets expose incomplete coverage. The pinned JavaScript Actions parser has no native structural limits, so use the same exactly pinned YAML library's unexpanded AST for an iterative depth-64/node-50,000 structural preflight before authoritative Actions parsing. Reject aliases explicitly in this initial profile; full bounded alias semantics remain task 4. Scalar script contents are opaque leaves. Limit diagnostics to 50 per file with visible truncation. These are admitted-input/work bounds, not a hard CPU/memory isolation guarantee.

Keep the package descriptor and command help free of parser/acquisition imports. The supported distribution is a split ESM plugin artifact built by the shared plugin builder: bundle private implementation dependencies, retain SDK/Effect and their subpaths as host-resolved peers, and link the generated distribution package. Test the emitted static import graph as well as source isolation, separately from same-binary startup timing. This read-only slice ships its own guide, real compiled external-plugin verification and focused adversarial tests rather than waiting for task 22's execution guides.

Local workloads are Linux containers on provider/host combinations proved by acceptance. Mapping `ubuntu-*` labels to pinned Linux images does not claim a GitHub-hosted VM or identical preinstalled tools. Windows/macOS job labels, nested virtualization, privileged containers, implicit engine sockets and cloud-only services fail with specific remediation unless a separately proven capability explicitly exists. Nothing implicitly executes a workflow step on the developer host.

#### Actions compatibility contract

| Area | Required local behavior | Remote boundary |
| --- | --- | --- |
| Source and expressions | Preserve YAML source locations, duplicate-key errors, `on` as a string, multiline scripts and bounded aliases; use pinned Actions parser/evaluator, not Landofile syntax or JavaScript eval | Official runner evaluates GitHub's dispatched job; hook adapter never reparses the workflow |
| Contexts | Typed phase-aware `github`, `env`, `vars`, `inputs`, `secrets`, `runner`, `job`, `steps`, `needs`, `matrix`, `strategy`; Actions coercion, comparison, projection and string semantics | Forward the runner-provided context/args without inventing absent service data |
| Graph and outcomes | Job `if` before matrix expansion, `needs`, include/exclude, bounded max-parallel, fail-fast, step/job continue-on-error, timeout, cancellation, status functions, outputs and skipped states | Do not implement another remote scheduler or broker client |
| Reuse and actions | Local and remote action refs, JS node20/node24, composite and image/Dockerfile actions; reusable workflows with caller inputs/secrets, bounded nesting/cycle diagnostics; per-action pre/main/post state and reverse post registration order | Official runner resolves actions and Node runtimes; hooks perform admitted container execution only |
| Shell and workspace | GitHub shell defaults/arguments, explicit custom shell, scoped working directory/env precedence, `INPUT_*`, `GITHUB_*`, runner paths and workspace persistence across steps | Preserve runner-supplied executable and argv as delivered; never repair upstream space splitting by guessing a shell command |
| Commands and files | Incremental command decoding on both stdout and stderr with separate stream framing and shared per-step command/stop-token state; `add-mask`, groups, annotations; exact multiline ENV/OUTPUT/PATH/STATE/SUMMARY files, private action state and bounded diagnostics | Exact child bytes go back to the official runner; plugin diagnostics never masquerade as `::` workflow commands |
| Events | Supplied payload or labeled simulation for push, pull_request, workflow_dispatch, workflow_call and schedule selection; branch/tag/path/activity filters, explicit clock/changed-file data | Real delivery, scheduling, environments, approvals, token permissions and concurrency coordination belong to GitHub |
| Cache and artifacts | Explicit native local adapters for immutable allowlisted official cache/upload/download action revisions; repository/branch/key/version scoped private storage, restore/save ordering, cross-job artifact reads and real retention grants | Official actions use their real GitHub service endpoints/tokens; no local interception in remote mode |

Local concurrency groups coordinate only within this plugin's local scope, never with GitHub's global queue. Simulation does not send webhooks, publish statuses or emulate environment approval services. Local OIDC issuance is unsupported; requesting GitHub-issued credentials fails rather than fabricating a token. Local artifact URLs, IDs and cache hits must be labeled local; adapters cannot advertise GitHub URLs or server identities. Unknown official action versions are not silently intercepted. Third-party actions execute as explicitly trusted workload code, not as a sandboxed language; permissions fields do not restrict arbitrary network/filesystem behavior.

The compatibility registry maps every supported field/action kind to its evaluator, conformance fixtures and explicit unsupported cases. Known unsupported intent is rejected before workload side effects. Inputs that can only become known after earlier steps are validated immediately before their own action; do not promise static preflight of arbitrary code. Defaults are finite: four concurrent local jobs, at most 256 expanded matrix jobs, bounded expression/nesting/file-command budgets and inherited execution quotas. Host authors may narrow these limits; widening requires explicit finite configuration and tests.

Local workflow interpretation and official-runner integration remain distinct semantic owners. They share generic resource ownership, exact process transport, cancellation and cleanup, not a common scheduler that reinterprets dispatched remote jobs. Inspection observations do not authorize either execution path.

#### Acquisition, secrets and service-specific behavior

Resolve action refs to immutable commits; key an owner-private source cache by canonical repository and resolved commit, verify downloaded bytes/extraction paths, and record ref-to-commit provenance. Local paths stay within the selected workspace after canonicalization. Never execute downloaded metadata while planning. Offline misses fail clearly. Pins, licenses, runner archives and image digests are catalogued in the plugin; installation does not download runners, probe providers or register with GitHub. Images use existing provider artifact acquisition through execution/build services; upstream archives use Downloader/network-trust verification. No global fetch, direct provider client or second installer is added to the plugin.

Supply the actual requested Node runtime, not Bun masquerading as Node or whatever `node` is on PATH. Local image profiles must prove runtime/architecture compatibility; remote mode uses runner externals with their documented mount layout. Pull/build Dockerfile actions through Lando's canonical build machinery, including dynamically discovered workspace actions, rather than making them long-lived idle services.

Resolve only explicit secret references under the invocation policy; a missing GITHUB_TOKEN remains missing. Register values through the canonical RedactionService before any narration, envelope or retained observation. Dynamic `add-mask` values are decoded in protocol order and registered with that same service; there is no second general redactor. Exact raw control/payload data stays on the authorized private transport, not the renderer/event bus. Local cache/artifact adapters obtain exact-id grants from an authorized plugin manifest lookup before a new session reads retained bytes; a manifest ref alone is not permission. Archive extraction rejects traversal, links escaping the target, devices and quota breaches. Cleanup failures retain tagged cause and owned-resource receipts rather than hiding the primary result.

#### Generic follow-ons: exact payloads and attached containers

These are proposed additions AFTER the foundation, not capabilities silently attributed to #1734-#1743. They remain platform-neutral in SDK/engine/provider owners; GitHub wire formats stay in the plugin. The generic changes require their own contract/API review before dependent plugin execution merges.

**G1: process payload consumer.** Extend `startProcess` with an optional, explicitly installed trusted payload consumer and add service-process `user` propagation to existing `ExecTarget.user`. With no consumer, preserve the foundation behavior exactly. With one, install it before spawn and deliver ordered per-stream stdout/stderr `Uint8Array` data and stream EOF, without redaction or loss, through one bounded backpressured consumer. The consumer is a function-bearing in-process port, not serialized schema data. Its controls register dynamic redaction values with the canonical RedactionService and submit display bytes for ordinary redaction/capture/observations. Disable automatic raw-derived display/capture on this path: `add-mask` must be interpreted before any derived display is retained. There is no second redactor and no reinterpretation of the lossy `output` stream.

Use one child launch and one release owner. Completion waits for payload EOF/drain; sink failure, queue/deadline exhaustion or cancellation interrupts the real child and preserves a typed failure. Add `ExecutionPayloadError` for transport/consumer failures with safe stage/remediation, preserving original child failures and cause roles. Do not convert a broken consumer into success or drop bytes to satisfy a timeout. Bound frames to 64 KiB and queued payload to 1 MiB by default; split chunks without changing bytes, use backpressure and an explicit drain deadline, and never append raw bytes to errors. Existing observations remain bounded and may still contain gaps. Type tests must preserve the caller's Effect requirements and the process's failure union.

**G2: owned-environment container leases.** Add SDK `acquireAttachedContainer({ environment, spec, payloadConsumer? })` on the execution session, returning an opaque `ExecutionContainerLease`. The optional trusted G1 consumer is separate from the schema-derived spec and is installed before the image's primary process starts. Accept only the same session's owned environment; a borrowed app or another session's handle fails before build/pull/create. The lease exposes that single primary process as an `ExecutionProcess`, status/readiness and realized port metadata, idempotent release, and an opaque target for subsequent service exec. Primary await waits for payload EOF/drain; primary cancellation and lease release share one idempotent ownership path. Later service exec never substitutes for attachment to the original primary process. The lease is not an AppSelector or a public AppPlan. Caller Scope and environment/session closure share release ownership; the environment tracks leases even after partial creation.

The schema-derived spec accepts an image or canonical build descriptor, entrypoint/argv, cwd, user, environment descriptors, explicit readiness, network aliases, ports and admitted workspace/system mounts. The engine derives the network from the retained environment's private per-app bridge and authorizes every mount against its policy/provenance; callers cannot submit arbitrary network IDs or fabricated ownership labels. Missing attachment/build/port/cancellation capability fails before provider mutation. Publish an `attachedContainers` provider capability with explicit false values for unsupported implementations and contract tests; extend the existing provider data-plane inputs with retained owner-network selection, entrypoint/cwd/user/alias/port fields rather than adding another container client. Resolve the owner network internally from the verified selected provider and plan; never join the shared global bridge as a substitute.

Compile build descriptors through the existing canonical authoring/planner and BuildOrchestrator paths without changing/replanning the owning environment, then create the lease. Dockerfile/local actions discovered after checkout are valid consumers; do not start an image as a fake idle service or require a shell/tail binary. A missing entrypoint means preserve image ENTRYPOINT/CMD semantics; an explicit argv override is exact. Record child ownership in the existing scratch/ownership receipts so normal release and explicit orphan recovery identify partially created resources. Provider implementations stay under their existing owners, with shared contract coverage on managed Podman and Docker. Reuse existing provider/build/admission errors; closed leases use the existing closed-handle error. Registry metadata never stores resolved credentials.

#### Concrete remote ownership and transport

The `github-actions:runner` command is a foreground SDK-consuming supervisor. Before any registration/listening it acquires an owned config-backed scratch with the pinned unprivileged Linux runner/toolchain image, managed workspace and plugin protocol companion. Run one official JIT/ephemeral runner assignment inside that container. A no-container workflow therefore executes its shell/JS steps inside the owned runner container, not on the developer host. No engine socket, host home, privileged mode or automatic global network is available. Labels advertise the actual image/architecture, not hosted VM parity.

The companion and supported-extension hook shim are plugin assets, not another Lando CLI/runtime. They import neither core nor engine, never perform provider operations, and own only process/pipe/socket protocol adapters. All user-facing Lando narration stays renderer-owned. Start the companion with G1 over a service process: supervisor-to-companion frames travel on stdin, companion-to-supervisor frames on exact stdout; stderr is private diagnostic payload, not a control channel. The companion exposes an owner-private Unix socket inside the runner container for short-lived hook clients and launches the official runner as its child. This avoids a developer-host listening socket, arbitrary host gateway routing, or a public cross-process session API.

Bootstrap a fresh per-run key over stdin; never persist it in workflow-visible env, runner state JSON, argv or logs. Versioned frames include run/request/lease IDs, monotonically increasing sequence numbers and authenticated length-delimited content. Metadata frames are capped at 1 MiB, byte payload frames at 64 KiB, in-flight requests at 16 and queues at 1 MiB per direction. Separate priority/control processing reserves capacity for cancellation and heartbeat under output flooding. A five-second heartbeat and fifteen-second expiry bound parent loss; callback deadlines are explicit and bounded by the remaining job/step deadline. Hook disconnect interrupts its owned in-flight process rather than merely closing an observer.

The supervisor owns authoritative policy, canonical path mappings and lease IDs. Every frame is decoded and checked against that run and admitted operation; possession of a token, path or lease ID cannot widen policy. Hook response paths are pre-created runner-owned files under the configured hook-response directory: validate containment/no symlink swaps, write complete JSON atomically, and never accept an arbitrary callback path. Opaque hook state contains version/run/lease identities only, not serialized Lando handles, secrets or host paths. Retry after a lost response is not permission to spawn a duplicate workload: reject duplicate in-flight/completed request IDs within the bounded run registry; there is no cross-crash exactly-once claim.

Acquire retained job/service leases in the supervisor's job Scope, never a short-lived `session.run` invocation child scope. Only one-step action leases belong to a hook request's Scope. A persistent job-container keepalive command mirrors the pinned runner's job-container semantics explicitly; never inject that command into a container action or alter its image entrypoint. Runner control credentials are sent privately to the companion; use the verified `ACTIONS_RUNNER_INPUT_JITCONFIG` environment input consumed and removed by the pinned runner's `CommandSettings`, not secret-bearing shell interpolation or process argv. Do not propagate that bootstrap environment into workflow steps.

| Hook/job shape | Mapping and lifetime rule |
| --- | --- |
| `prepare_job` with job container | Acquire attached job/service leases under the outer owned environment; apply verified mounts, health and service aliases; return real context/ports and correct Alpine status |
| Services-only job | Keep ordinary steps inside the outer runner container; companion-owned loopback forwarders map declared localhost ports to service aliases on the private job bridge, without publishing developer-host ports |
| `run_script_step` | Execute the runner-provided shell/Node entrypoint in the retained job lease with cwd/env/path/user, returning its real exit and original bytes through the hook; do not re-tokenize or re-evaluate expressions |
| `run_container_step` | Acquire a fresh attached action lease from image or Dockerfile at dispatch, share only admitted workspace/network data, await exit and release; valid even if preparation never occurred |
| `cleanup_job` | Release only inner job/service/action leases and forwarders; outer supervisor remains owner of runner lifetime |
| No-container or Docker-only job | Outer ownership already exists; missing prepare/cleanup is expected, not a lifecycle leak or reason to run on the developer host |

Maintain a validated mapping from runner-container paths to the outer managed host workspace, runner externals, actions, temp, tools and GitHub home/workflow directories. Map only those roots, preserving read-only flags. Drop exactly the known upstream-injected engine-socket system mount; reject authored socket/privilege requests and unknown unsafe mounts. Parse only supported `createOptions` into canonical fields (resource/user and supported health options); never shell-concatenate them. Reject unknown options with their source location and remediation. Container entrypoint and network selection cannot be overridden through option text. Populate service ports/IDs from actual lease metadata, never assumed port numbers.

Set and prove the upstream feature flag/hook path behavior against the pin. A missing/disabled hook capability must not fall back to a Docker CLI or developer-host execution: the runner image carries no engine socket, and any fallback container command fails closed with an actionable diagnostic. Treat the runner's existing space-split script argv as the upstream contract and add a quoted-path conformance case; do not guess how to repair it.

On user/remote cancellation, notify the official runner, allow bounded authored post-work, then interrupt payload processes and close the owning session. Runner exit/setup failure/missing cleanup also closes it. If the supervisor is SIGKILLed, no finalizer can run: heartbeat expiry stops the companion/runner process tree, and the next explicit plugin invocation reconciles only its proven orphan ownership through existing scratch cleanup. Do not promise immediate provider deletion after host death or attach to a previous in-process session. Same-container repository code shares the runner's trust domain; this design supports explicitly trusted/private execution, not a multi-tenant hostile-code sandbox.

### Must NOT have (guardrails, anti-slop, scope boundaries)

- No act subprocess, copied runner broker protocol, core GitHub vocabulary, public scheduler AST, duplicate provider/parser/redactor, or private engine imports from the plugin.
- No implementation in this planning PR, live runner registration, token capture, issue reassignment/closure, PR auto-merge or release assignment.
- No detached/public cross-process ExecutionSession, permanent core daemon, implicit borrowed-app mutation, global-network fallback, unbounded buffers, or guessed successful exits.
- No automatic home/SSH/agent-credential/engine-socket forwarding, privileged fallback, or claim that admission/containerization safely sandboxes hostile workflows. Shared untrusted/public runner hosting needs a separately reviewed isolation/deployment policy.
- No passing a caller-created AppPlan, serializing a fake Landofile to rediscover it, or using ConfigTranslator as a workflow executor.

## Verification strategy
TDD with Bun; implementation and owner-package tests land together. Evidence lives under `.omo/evidence/github-actions-plugin/`. Every command below must exit successfully and report a positive test count; skipped live runs are not conformance. Proposed test paths are created by their task before invocation. Runtime contracts use Schema-derived data, type tests, existing shared provider suites and public SDK-only plugin fixtures. New generic SDK signatures update the public-surface fixture, schema artifacts, error channels and owning package tests.

Each implementation slice runs changed-file LSP, its focused tests, root typecheck/lint and affected boundary/codegen/guide gates. Before each implementation PR, run `bun run gate:pr`; schema changes also run compatibility checks. New package installation uses `bun install`; clean-checkout generation/helper preparation follows repository instructions. The plugin's integration harness takes an explicit compiled binary path and isolated Lando roots; plugin tests do not import core just to get a test runtime.

Conformance is three-layered: checked-in upstream-language fixtures; pinned official-runner hook transcripts/codecs; and real provider + real GitHub test-repository acceptance. Mocked hook calls do not prove real runner dispatch. Live jobs use explicitly provisioned test-only credentials and disposable repositories/resources, never the developer's installed roots. Missing credentials/sockets may skip ordinary local suites but an explicitly requested acceptance run fails rather than claiming support. Planning-stage QA checks this artifact's structure, references, dependency graph and preservation of the future contracts; it does not claim the future runtime tests have already run.

## Execution strategy
### Parallel execution waves
One planning PR publishes this plan and its index link. Later implementation uses the following waves, with the dependency matrix authoritative inside each wave; unrelated ready tasks may run concurrently. Do not wait for an entire wave if its unrelated tasks do not block the next task.

1. Contracts and pure compatibility: tasks 1, 3-8. Task 1 requires the future foundation; pure plugin work does not fake it.
2. Container/runtime adapters and protocol building blocks: tasks 2, 9-12, 14, 16-17.
3. Local/remote composition: tasks 13, 15, 18-20.
4. Acceptance and guidance: tasks 21-22; then F1-F4.

Implement G1 and G2 in separate generic follow-on PRs before plugin runtime consumers merge. Keep the rest in dependency-coherent plugin PRs, each containing its tests. Never publish command stubs as working functionality. No release is inferred from this sequence.

### Dependency matrix
| Todo | Depends on | Blocks | Can parallelize with |
| --- | --- | --- | --- |
| 1 | Future foundation | 2, 10, 17 | 3-8 |
| 2 | 1; future environment/build/provider contracts | 10, 12, 18-19 | 4-9, 17 |
| 3 | None | 4, 7-9, 16-17 | 1 |
| Early inspection (#1856) | 3 and the bounded parsing subset of 4; may land together | Independent read-only delivery | 1-2, 5-22 |
| 4 | 3 | 5-8 | 1, 9 |
| 5 | 4 | 6, 13 | 7-9 |
| 6 | 5, 7 | 13, 15 | 8-12, 14, 16-18 |
| 7 | 3, 4 | 6, 11-14 | 5, 8-10 |
| 8 | 3, 4 | 10-15, 19 | 5-7, 9 |
| 9 | 3 | 10-12, 16 | 4-8, 17 |
| 10 | 1, 2, 8, 9; future foundation | 11-14, 16, 18 | 6-7, 17 |
| 11 | 7-10 | 12-13 | 14, 16-18 |
| 12 | 2, 7-11 | 13 | 14, 16-18 |
| 13 | 5-8, 10-12 | 15 | 14, 16-19 |
| 14 | 7-8, 10; future artifact contracts | 15 | 11-13, 16-19 |
| 15 | 6, 13-14 | 21-22 | 16-20 |
| 16 | 3, 9-10 | 18, 20 | 11-15, 17 |
| 17 | 1, 3 | 18-20 | 2, 4-16 |
| 18 | 2, 10, 16-17 | 19-20 | 11-15 |
| 19 | 2, 8, 10, 17-18 | 20 | 13-15 |
| 20 | 16-19 | 21-22 | 15 |
| 21 | 15, 20 | F1-F4 | 22 |
| 22 | 15, 20 | F1-F4 | 21 |

## Todos
> Implementation + Test = ONE todo. Never separate.

All `plugins/github-actions/**` files and specifically named execution-extension tests below are proposed additions. Task-local `src/` and `test/` paths in tasks 3-22 are relative to `plugins/github-actions`; tasks 1-2 name their SDK/engine/provider owners explicitly. References to existing owners are repository-root-relative. Each task consumes the detailed contracts above rather than inventing a new shape. Evidence filenames below live under `.omo/evidence/github-actions-plugin/`; commits require the implementation session's ordinary authorization.

- [ ] 1. Add exact process payload delivery without changing observations
  - Recommended task executor category: deep-high; public failure/IO/context contracts cross SDK and engine.
  - Deliver G1 in `sdk/src/execution/` and `engine/src/execution/`; preserve existing process launch, admission, overrides and release; update public fixture/schema/error channels. Existing refs: `sdk/src/services/process.ts`, `sdk/src/services/provider.ts`, `engine/src/operations/exec-stream.ts`, `redaction/src/`, future #1734/#1737/#1739/#1741.
  - Depends: future foundation. Closes GAP-2. Do not add a second redactor, CLI writer or lossless-observation mode.
  - QA: `bun test engine/test/execution/payload.test.ts sdk/test/execution/payload-contract.test.ts`; happy: binary stdout/stderr and EOF delivered once, await waits for drain, dynamic masks precede display capture; failure: stalled/throwing sink and cancellation terminate real child, bounded queues never drop or fabricate success. Add type tests for the new error/requirements.
  - Evidence: `task-01-payload.txt`. Commit: `Add scoped exact-byte process payload consumers`.

- [ ] 2. Add owned-environment attached container leases
  - Recommended task executor category: deep-high; ownership, provider capability, build and networking invariants cross packages.
  - Deliver G2 in SDK/engine plus existing container-runtime/provider owners; add capability and shared provider contract coverage. Existing refs: `sdk/src/services/provider.ts`, `container-runtime/src/data-plane.ts`, `container-runtime/src/volume-ownership.ts`, `sdk/src/schema/app-plan.ts`, `sdk/src/test/provider-data-plane.ts`, `core/test/contract/plugin-abstraction-coverage.test.ts`.
  - Depends: 1 and future environment/build contracts. Closes GAP-2. Do not accept raw network IDs, borrowed-app ownership or a caller AppPlan; do not replan the parent or invent an idle entrypoint.
  - QA: `bun test engine/test/execution/attached-container.test.ts container-runtime/test/attached-container.test.ts`; happy: image and Dockerfile primary processes, cwd/user/env/entrypoint, workspace bytes, alias DNS and realized ports, plus an immediately exiting shell-free image emitting fragmented binary stdout/stderr beyond capture limits and a dynamic mask; prove one primary launch, exact delivery and drain before await. failure: cross-session/borrowed targets, unsupported capability, partial create, late build failure, broken sink and interrupt preserve typed failures and owner-only cleanup. Live provider proof is completed in 21.
  - Evidence: `task-02-attached.txt`. Commit: `Add scoped containers on owned environment networks`.

- [ ] 3. Establish the optional plugin and compatibility contracts
  - Recommended task executor category: deep-low; follow the existing command-plugin pattern.
  - Add package/manifest/explicit exports and consumer-driven Schema data/errors under `plugins/github-actions`. Packaging may land with early inspection (#1856), contributing only the implemented `github-actions:list` and `listWorkflows` surface. Defer unused execution contracts to their real consumers. Tasks 15 and 20 publish the remaining complete lazy command loaders and Effect operations; executable specs retain explicit bootstrap/completion/result-schema metadata. Do not bundle or advertise incomplete commands. Existing refs: `plugins/sql/src/index.ts`, `plugins/sql/package.json`, `sdk/src/plugins/command.ts`, `sdk/src/plugins/module.ts`, `scripts/boundary/rules/package-dag-policy.ts`.
  - Depends: none. Establishes the packaging portion of GAP-5; machine output and live evidence remain with their downstream tasks. Run `bun install` after adding the workspace package. Add exact Actions package pins, not core dependencies.
  - QA: `bun test plugins/github-actions/test/plugin-descriptor.test.ts plugins/github-actions/test/import-boundary.test.ts`; happy: real third-party-shaped plugin registration, consumer-driven schema round trips and only implemented command publication; failure: forbidden core/engine imports, malformed manifests and invalid input contracts are rejected. Duplicate-command tests accompany real publication in #1856 and tasks 15/20. Run package-dag boundary and typecheck.
  - Evidence: `task-03-package.txt`. Commit: `Define optional GitHub Actions plugin contracts`.

- [ ] 4. Adapt upstream workflow parsing and pure expressions
  - Recommended task executor category: deep-low; bounded adapter and conformance work against pinned libraries.
  - Add `src/language/` adapters and source-located workflow/action data. Reuse the pinned public parser/evaluator APIs, including YAML/reference semantics; retain source spans and quotas. Do not use Landofile expressions, JavaScript eval or private upstream imports.
  - Depends: 3. Closes GAP-1. Reference upstream languageservices pin and `sdk/AGENTS.md` for Schema/error conventions.
  - Early inspection (#1856) may deliver its bounded parsing subset together with task 3. Complete pure-expression conformance, bounded alias semantics and the remaining upstream corpus still gate this task's completion; an inspection-only implementation must not close it.
  - QA: `bun test plugins/github-actions/test/workflow-parse.test.ts plugins/github-actions/test/expressions.test.ts`; happy: upstream cross-language corpus, truthiness/coercion/object filters and multiline YAML; failure: duplicate keys, `on` mis-coercion, alias/nesting exhaustion, malformed expressions and unsupported parser-version features produce bounded source diagnostics. Prove Bun ESM compatibility.
  - Evidence: `task-04-language.txt`. Commit: `Parse Actions workflows with pinned upstream semantics`.

- [ ] 5. Build phase-aware contexts and event selection
  - Recommended task executor category: deep-low; pure semantics plus scoped filesystem access for hashFiles.
  - Add `src/contexts/`, `src/events/`, status functions and `hashFiles` using captured roots, explicit clock/event/change data and authorized IO. Model supplied versus simulated delivery, workflow_dispatch/workflow_call inputs and branch/tag/path/type filters. Do not emulate GitHub delivery, approvals or OIDC.
  - Depends: 4. Closes GAP-1. References: official expressions/workflow syntax and SDK filesystem/process boundary rules.
  - QA: `bun test plugins/github-actions/test/contexts.test.ts plugins/github-actions/test/event-match.test.ts`; happy: push/PR/manual/call/schedule fixtures, hashes and phase-valid contexts; failure: missing event fields, unavailable context, escaping hash patterns and invalid inputs fail with source location and zero workload calls.
  - Evidence: `task-05-contexts.txt`. Commit: `Model Actions contexts and explicit event simulation`.

- [ ] 6. Plan job graphs and matrix execution
  - Recommended task executor category: deep-low; deterministic Actions-specific graph semantics using Effect concurrency.
  - Add `src/planning/` for needs, conditions-before-matrix, include/exclude, outputs, max-parallel/fail-fast and bounded local concurrency groups. Discovery/list and dry planning return redacted Schema results. Do not import the private tooling scheduler/AST or mutate providers while planning.
  - Depends: 5, 7. Closes GAP-1. Reference pinned workflow schema and resolved action metadata; model outcome versus conclusion and unavailable dynamic values explicitly.
  - QA: `bun test plugins/github-actions/test/job-graph.test.ts plugins/github-actions/test/matrix.test.ts`; happy: three-leg matrix with fail-fast disabled, needs outputs and always() dependent; failure: cycles, unknown needs, 257 expansions, invalid filters and unsupported known intent cause zero workload side effects. Deterministic scheduler tests distinguish skip/failure/cancel.
  - Evidence: `task-06-graph.txt`. Commit: `Plan Actions jobs and bounded matrix execution`.

- [ ] 7. Resolve actions and immutable source caches
  - Recommended task executor category: deep-low; remote acquisition and path boundaries need focused tests.
  - Add `src/actions/source/` for local/remote/docker refs, action metadata, immutable commit resolution and owner-private source caching. Use existing HttpClient/Downloader/verified-stream and scoped StateStore services; retain licenses and provenance. Local actions generated by prior steps are resolved when available, not guessed during initial planning.
  - Depends: 3, 4. Closes GAP-4. Existing refs: `sdk/src/services/downloader.ts`, `sdk/src/services/state-store.ts`, `sdk/src/verified-stream/index.ts`; new code imports their public SDK equivalents, not implementation owners.
  - QA: `bun test plugins/github-actions/test/action-source.test.ts plugins/github-actions/test/action-cache.test.ts`; happy: tag-to-SHA resolution and offline cache hit; failure: changed bytes, traversal/symlink archives, wrong credential origin, network policy denial and offline miss fail without executing source. Pin-only policy refuses mutable refs when requested.
  - Evidence: `task-07-actions.txt`. Commit: `Resolve and verify immutable Actions sources`.

- [ ] 8. Implement workflow commands, environment files and secret projection
  - Recommended task executor category: deep-high; ordering, exact bytes and masking form a correctness boundary.
  - Add `src/protocol/` for incremental commands on both stdout and stderr and ENV/OUTPUT/PATH/STATE/SUMMARY files, multiline delimiters/CRLF, action-local state and stop-commands tokens. Keep separate stream framing with shared per-step command/stop-token state; process commands and register dynamic masks before submitting derived display from that stream. Use canonical redaction registration and the G1 display channel; raw data never enters plan/results or observations implicitly.
  - Depends: 3, 4; live adapter consumption waits for 1. Closes GAP-1/GAP-2. Reject retired set-env/add-path and escape plugin diagnostics instead of executing them as commands.
  - QA: `bun test plugins/github-actions/test/workflow-commands.test.ts plugins/github-actions/test/file-commands.test.ts plugins/github-actions/test/secrets.test.ts`; happy: split UTF-8/control lines, masks following more than 64 KiB on either stream, fragmented stderr add-mask/stop/resume/annotation commands, and correct step outputs/private post state; failure: huge/unterminated commands, delimiter collisions, malicious paths, forged stop tokens and secret-bearing errors remain bounded and never leak. Remote forwarding retains original stdout/stderr bytes for the official runner.
  - Evidence: `task-08-protocol.txt`. Commit: `Interpret Actions protocols before rendering output`.

- [ ] 9. Pin runner images and actual Node runtimes
  - Recommended task executor category: deep-low; provisioning/catalog work follows existing verified-download patterns.
  - Add plugin image/runtime catalog and generators, MIT notices and source/digest provenance for upstream image profiles, official runner archives and Node20/24 runtimes. Resolve and review immutable per-platform digests/checksums before any shipping default; commit pins, not generated helper binaries. Follow `scripts/codegen-catalog.ts` ownership and `_codegen-output.ts` formatting if root generators are added.
  - Depends: 3. Closes GAP-4. Pin runner v2.338.1/source above; supported Linux x64/arm64 and Alpine combinations require real evidence. Unsupported runtime/architecture fails before workload execution; no Bun-as-Node or PATH guessing.
  - QA: `bun test plugins/github-actions/test/image-pins.test.ts plugins/github-actions/test/node-runtime-pins.test.ts`; happy: verified cached image/runtime selection; failure: checksum mismatch, unsupported architecture/Alpine runtime, missing offline artifact and unreviewed mutable default. Run relevant codegen drift tests with positive counts.
  - Evidence: `task-09-pins.txt`. Commit: `Pin Actions runner images and Node toolchains`.

- [ ] 10. Map job environments onto the future Lando substrate
  - Recommended task executor category: deep-high; retained workspace, mounts, services and policy must compose correctly.
  - Add `src/runtime/job-environment.ts` and narrow adapters using SDK ExecutionSessionService, config scratch, G1/G2, delegated info and canonical build/readiness services. Generate authoring-wire data; retain managed-root target; map runner/workspace paths, user/env, service aliases/ports and supported options. No raw provider calls or reconstructed AppPlan.
  - Depends: 1, 2, 8, 9 and future foundation. Closes GAP-2/GAP-3. Job teardown destroys only owned scratch/leases; implicit host mounts/global storage remain denied.
  - QA: `bun test plugins/github-actions/test/runtime-adapter.test.ts plugins/github-actions/test/mount-map.test.ts`; happy: conflicting copied .lando file ignored, service readiness and real context mappings; failure: path swap, unknown option, denied secret/mount, missing capability or cross-owner handle refuses before offending effects. Repeat operations preserve one target/runtime.
  - Evidence: `task-10-environment.txt`. Commit: `Bind Actions jobs to retained Lando environments`.

- [ ] 11. Execute shell, JavaScript and composite actions
  - Recommended task executor category: deep-low; explicit adapters over the approved runtime/protocol contracts.
  - Add `src/actions/execute/` for run/custom-shell scripts, real Node actions and nested composite actions with env/input/output scopes, default working directory and pre/main/post behavior. Track post registration and reverse order independently from main success; allow bounded cleanup after cancellation without unbounded uninterruptible user code.
  - Depends: 7-10. Closes GAP-1. The executor never reads ambient stdin/cwd or executes a host step outside the owned Linux environment.
  - QA: `bun test plugins/github-actions/test/step-run.test.ts plugins/github-actions/test/action-js.test.ts plugins/github-actions/test/action-composite.test.ts plugins/github-actions/test/lifecycle.test.ts`; happy: outputs feed a later step and nested posts run in correct order; failure: spawn/exit/timeout/cancel/post failure preserve distinct outcomes and cause roles, with no duplicate child launch.
  - Evidence: `task-11-steps.txt`. Commit: `Execute native Actions steps and lifecycle hooks`.

- [ ] 12. Execute image and Dockerfile actions as attached leases
  - Recommended task executor category: deep-low; use the generic lease without another container implementation.
  - Add `src/actions/execute/container.ts`; map docker:// and Dockerfile action metadata, pre/main/post entrypoints, args/env/cwd and shared workspace/private-network semantics to G2. Install G1's consumer at lease acquisition and consume that same primary process without respawn, later-exec substitution, lossy observation or provider bypass. Resolve late local Dockerfiles after checkout and use canonical build orchestration. Preserve images with no shell or idle command.
  - Depends: 2, 7-11. Closes GAP-1/GAP-2.
  - QA: `bun test plugins/github-actions/test/action-docker.test.ts`; happy: image ENTRYPOINT plus args, dynamic local Dockerfile and service DNS/HTTP; failure: rejected network/privilege/socket options, failed build, nonzero primary exit and interrupted action release only that lease and leave job services alive until job close.
  - Evidence: `task-12-containers.txt`. Commit: `Run container actions on owned job networks`.

- [ ] 13. Compose workflow calls and full local execution
  - Recommended task executor category: deep-high; nested scopes, outputs and cancellation must match Actions semantics.
  - Add `src/workflow/run.ts` and reusable-workflow adapters. Connect planned jobs to step executors; implement typed workflow_call inputs/secrets narrowing and outputs, local/pinned remote reusable refs, bounded cycles/nesting, per-job isolation, concurrency/fail-fast and post-failure propagation.
  - Depends: 5-8, 10-12. Closes GAP-1. Do not widen inherited secret grants or treat a nonzero step as a successful workflow because its result object exists.
  - QA: `bun test plugins/github-actions/test/workflow-run.test.ts plugins/github-actions/test/reusable.test.ts plugins/github-actions/test/cancel.test.ts`; happy: dependent matrix/reusable jobs share declared outputs only; failure: recursive call, job timeout, failed dependency and cancellation mid-post produce truthful statuses and exactly-once owned release.
  - Evidence: `task-13-workflows.txt`. Commit: `Compose local workflows with truthful job outcomes`.

- [ ] 14. Add explicit local cache and artifact action adapters
  - Recommended task executor category: deep-high; private persistence, ownership grants and archive safety are load-bearing.
  - Add `src/actions/local-services/` with adapters keyed by verified canonical repository plus immutable supported revision, never a matching display name alone. Implement branch/key/version cache lookup and post-save semantics, artifact upload/download manifests and cross-job reads through future private artifact services and exact grants. Keep local adaptation visible in plans/results; never invent GitHub URLs, cache tokens or OIDC.
  - Depends: 7, 8, 10 and future #1740. Closes GAP-4. No local service-protocol impersonation or interception in remote mode. Document exactly supported official action revisions/inputs and reject unsupported options before that action.
  - QA: `bun test plugins/github-actions/test/local-cache-adapter.test.ts plugins/github-actions/test/local-artifact-adapter.test.ts plugins/github-actions/test/oidc-refusal.test.ts`; happy: cache miss/save/hit and cross-job artifact bytes across authorized sessions; failure: poisoned archives, wrong repo/branch/ID grant, quota/race, lookalike action, unsupported revision and local id-token request fail without unsafe read/write.
  - Evidence: `task-14-local-services.txt`. Commit: `Provide explicit local cache and artifact adapters`.

- [ ] 15. Publish local planning/execution commands and structured results
  - Recommended task executor category: deep-low; command integration follows existing SDK contribution/completion patterns.
  - Complete plan/run loaders and public Effect exports, argument schemas, trust acknowledgment, explicit secret refs, dry-run capabilities and truthful Renderer/JSON projection. The independent list command belongs to early inspection (#1856), not this task's runtime prerequisites. Return references and redacted intent, not raw authored secrets, full protocol payloads or provider paths. Add black-box compiled CLI tests using a supplied test-binary path.
  - Depends: 6, 13, 14. Closes GAP-5. No core registry command additions or implicit MCP write exposure.
  - QA: `bun test plugins/github-actions/test/commands/local.test.ts plugins/github-actions/test/machine-output.test.ts`; happy: explicit event plan, successful/failed workflow envelopes and retained list behavior; failure: missing trust, unknown args/job, unsupported intent and cancellation return declared exit/tag semantics consistently across formats.
  - Evidence: `task-15-cli.txt`. Commit: `Expose optional local Actions commands`.

- [ ] 16. Provision one verified ephemeral official runner
  - Recommended task executor category: deep-low; external credentials and installation are explicit service boundaries.
  - Add `src/remote/provision.ts` for pinned archives/image verification, explicit target registration/JIT secret refs, required scopes, target/label validation, runner update/deprecation handling and owner-only staging. Default to one assignment per invocation, with a bounded idle deadline; no daemon/fleet or implicit public-repository authorization. API requests use the existing HTTP trust/policy service.
  - Depends: 3, 9, 10. Closes GAP-3/GAP-4. Registration happens only on the explicit runner command and after execution prerequisites pass. Never pass long-lived tokens as CLI argv or write them to observations.
  - QA: `bun test plugins/github-actions/test/runner-provision.test.ts`; happy: verified cached runner and redacted mocked JIT flow; failure: wrong origin/target, missing scopes, expired token, rejected version, checksum/offline miss and interruption remove only owned staging and report cleanup failures.
  - Evidence: `task-16-provision.txt`. Commit: `Provision explicit ephemeral GitHub runners`.

- [ ] 17. Build the protocol companion and hook client
  - Recommended task executor category: deep-high; full-duplex flow control and callback authority need invariant tests.
  - Add `src/companion/`, `src/remote/protocol/` and a supported-extension hook shim asset. Implement the concrete pipe/Unix-socket framing, bootstrap key, identities, bounded queues, priority heartbeat/cancel, deadlines and validated response-file writes above. Compile/package Linux companion assets as derived outputs with source/license pins; no provider or core imports in the companion.
  - Depends: 1, 3. Closes GAP-3. Protocol transport is separate from human CLI output; never use lossy observation or shell-interpolated request data.
  - QA: `bun test plugins/github-actions/test/bridge-framing.test.ts plugins/github-actions/test/hook-client.test.ts`; happy: fragmented binary multiplex and exact responses under simultaneous output; failure: forged run/lease IDs, replay, oversized/truncated frames, socket/path swaps, output flooding, dropped client and stalled peer reject/cancel within bounded memory/deadlines.
  - Evidence: `task-17-bridge.txt`. Commit: `Add a scoped runner hook protocol companion`.

- [ ] 18. Own remote runner lifetime outside hook callbacks
  - Recommended task executor category: deep-high; resource lifetime must hold when upstream omits callbacks.
  - Add `src/remote/supervisor.ts`: outer owned scratch before registration, pinned official runner child inside it, exact companion channel, authoritative policy/lease map, readiness handshake and cleanup on every exit. Heartbeat expiry stops the in-container process tree; explicit subsequent recovery uses existing owner receipts and does not attach to a dead session.
  - Depends: 2, 10, 16, 17. Closes GAP-3. No host-argv workflow steps, engine socket or permanent listener. Declare incomplete cleanup truthfully after hard host death.
  - QA: `bun test plugins/github-actions/test/runner-lifetime.test.ts`; happy: no-container job lifetime with no prepare/cleanup; failure: registration failure, no assignment, feature-disabled hooks, companion/runner death and supervisor loss preserve owner-only cleanup/recovery and no implicit developer-host workload.
  - Evidence: `task-18-lifetime.txt`. Commit: `Own remote runner resources outside container hooks`.

- [ ] 19. Implement all four runner hooks against pinned semantics
  - Recommended task executor category: deep-high; mount translation, services-only behavior and step outcomes cross boundaries.
  - Add `src/remote/hooks/` codecs/handlers for prepare_job, run_script_step, run_container_step and cleanup_job. For run_container_step, install G1's consumer before G2 starts the primary process and forward that same process's original bytes; never respawn or substitute a later exec. Apply the hook table above, opaque state and true context/ports/Alpine values. Implement companion-owned services-only loopback forwarding, strict createOptions, known injected-socket omission and authored-socket refusal.
  - Depends: 2, 8, 10, 17, 18. Closes GAP-3. Do not repair upstream argv tokenization by guessing, publish developer-host ports, or use a raw provider fallback.
  - QA: `bun test plugins/github-actions/test/hooks.test.ts plugins/github-actions/test/hook-conformance.test.ts plugins/github-actions/test/service-forwarding.test.ts`; happy: pinned transcripts for job-container/services-only/no-container/Docker-only shapes and original stdout command bytes; failure: missing Alpine/status data, unsafe system/user mount, wrong lease, quoted path incompatibility, missing cleanup and client cancellation preserve truthful failure and containment.
  - Evidence: `task-19-hooks.txt`. Commit: `Map GitHub container hooks onto Lando leases`.

- [ ] 20. Publish the explicit remote runner command
  - Recommended task executor category: deep-low; glue approved supervisor/protocol services into the SDK command surface.
  - Complete github-actions:runner and library export with explicit target/secret-reference/timeout/labels, diagnostics, version capability checks and completion policy. Do not require container: in the user's workflow as a workaround for unsafe host ownership; the outer runner container provides that boundary.
  - Depends: 16-19. Closes GAP-5. Command help/plan paths do not register or download anything; no auto-service installation or issue mutation.
  - QA: `bun test plugins/github-actions/test/commands/runner.test.ts`; happy: mocked one-assignment flow reports real success/failure and cleanup; failure: denied target, unsupported backend, cancellation and no-assignment timeout fail before/after the correct effects with redacted machine output. Real registration proof belongs to 21, not the mock.
  - Evidence: `task-20-runner-cli.txt`. Commit: `Expose explicit Lando-backed GitHub runner execution`.

- [ ] 21. Prove local and real remote execution on supported providers
  - Recommended task executor category: deep-high; cross-process/live evidence must distinguish real support from mocks.
  - Add `test/conformance/` and `test/integration/` with a pinned local corpus and disposable private GitHub test-repository workflow. Harness automation creates/deletes its own labeled branch/run/runner resources only after explicit test opt-in and scoped credentials. Supply compiled binary and answering provider sockets; record provider/OS/architecture/image/runner pins and upstream run/job IDs.
  - Depends: 15, 20. Closes GAP-5. Run `LANDO_GHA_E2E=1 bun test plugins/github-actions/test/integration/` with `LANDO_GHA_TEST_BINARY`, `LANDO_GHA_TEST_REPOSITORY`, explicit credential references and provider socket fixtures; fail when explicitly requested prerequisites are missing. No runtime acceptance is claimed by this planning PR.
  - QA: happy: real managed-Podman and Docker runs cover local matrix/reusable/JS/composite/Dockerfile/service/cache/artifact workflows and each remote job shape; failure: failed exit, split Unicode and late masks, denied mounts, child cancellation/absence, no prepare/cleanup, missing hooks, runner loss and explicit orphan recovery. Inspect actual provider resources and GitHub run conclusions; no synthetic never-ending stream substitute.
  - Evidence: `task-21-local.json`, `task-21-remote.json`, `task-21-cleanup.txt`. Commit: `Prove native and registered Actions execution end to end`.

- [ ] 22. Document compatibility and protect ordinary Lando performance
  - Recommended task executor category: writing; reader-facing guides and their fixtures are authored together.
  - Add executable local list/plan/run guidance and explicit opt-in remote setup/limits under `docs/guides/plugins/github-actions/`, plus a supported-feature/pin matrix generated from the plugin registry. Load lando-write-docs for these future reader-facing artifacts only. Include trust limits, real Node prerequisites, local adapter differences, cancellation/recovery and provider support evidence.
  - Depends: 15, 20 for execution guidance. Early inspection (#1856) ships its own read-only guide and import/startup proof independently. Closes GAP-5. Extend `plugins/github-actions/test/idle-imports.test.ts` and owner-appropriate CLI budget checks; do not change ordinary startup defaults or add live registration to routine guides.
  - QA: `bun test plugins/github-actions/test/idle-imports.test.ts`; run each new guide with `bun run dev:guides <guide-path> --once`, positive scenario counts, lint:guides, guide coverage/public transcripts/drift and gate:pr. happy: installed-but-unused plugin causes zero provider/network/session starts and preserves the foundation's same-toolchain budgets; failure: negative fixtures with an eager provider call or uncovered command fail the corresponding budget/coverage assertion, and unsupported-feature guide scenarios assert structured refusal.
  - Evidence: `task-22-guides.txt`, `task-22-performance.json`. Commit: `Document and guard the optional Actions integration`.

## Final verification wave
Run after implementation tasks, not during this planning PR. Every row must pass before implementation delivery; absence of credentials/provider evidence is a blocked row, not approval.
- [ ] F1. Audit contracts, dependency receipts and package boundaries against the future baseline and G1/G2, including public fixture/schema compatibility and no unapproved scope expansion.
- [ ] F2. Run typecheck, owning tests, lint, codegen drift, all boundaries and guide gates; review changed public/error channels and fail on new errors, zero-test matches or silent skips.
- [ ] F3. The lead drives the compiled local/remote surfaces and riskiest failure/cleanup cases from task 21; record actual bytes, exit/status and resource inventories in an evidence matrix.
- [ ] F4. One independent gate reviewer checks the full implementation against IS-1 through IS-7, the constraint ledger and F1-F3 artifacts. Approve only when every required outcome is evidenced; no panel of redundant reviewers.

## Commit strategy

This delivery is one planning PR with this plan and a specification-index link, no implementation or prerequisite issue closure. Later code commits follow the repository's short plain-English style, with tests and generated committed pins alongside their owning change. G1 and G2 precede plugin execution PRs; pure parser/conformance work can proceed independently after its contracts are accepted. Use isolated task worktrees, never force-push or amend without authorization, and run gate:pr before pushing. Each PR states its exact implemented support profile and remaining dependency gates rather than claiming the full plan is already shipped.

## Success criteria
| IS | Delivering todo(s) | Proving QA scenario | Evidence |
| --- | --- | --- | --- |
| IS-1 | 3-4, 6-15 | Existing YAML with all supported action families, needs/matrix/reuse and true failure results | task-04, task-06, task-11 through task-15, task-21-local |
| IS-2 | 5-6, 15 | Supplied/simulated event selection, filters and invalid input without workload calls | task-05, task-06, task-15 |
| IS-3 | 16-21 | Real registered job/run IDs and conclusions for all four job shapes | task-16 through task-21-remote |
| IS-4 | 1-2, 10-12, 18-19 | SDK-only adapters, shared owned network/workspace and owner-only cleanup | task-01, task-02, task-10, task-12, task-18, task-19 |
| IS-5 | 1, 8, 13, 15, 17, 19-21 | Split/large payloads, late masks, flooded/stalled channels and real exit/cancel truth | task-01, task-08, task-13, task-17, task-19, task-21 |
| IS-6 | 7-8, 10, 14, 16-19, 21 | Secret/ID/path/permission denial, crash recovery and no unrelated resource deletion | task-07, task-08, task-10, task-14, task-16 through task-21-cleanup |
| IS-7 | 3, 15, 20, 22 | Optional loading, no implicit setup/registration and unchanged ordinary-command budgets | task-03, task-15, task-20, task-22 |
