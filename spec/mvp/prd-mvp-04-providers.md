# PRD: MVP-04 — Runtime providers

## Introduction

The runtime provider is the architectural bet of Lando v4: core never shells out to provider binaries on `PATH`. The reference provider — `@lando/provider-lando` — proves that bet by talking to a *private* Podman API socket via `Bun.spawn`-driven RPC. Per [`spec/ROADMAP.md`](../../spec/ROADMAP.md) "Why `@lando/provider-lando` must be prototyped at MVP", deferring this to Alpha 3 would risk catastrophic interface redesign.

This PRD ships the two MVP-bundled providers:

- **`@lando/provider-lando` (must-ship, primary):** Linux x64 only, private Podman socket, no VM lifecycle, manual Podman install on the dev box. macOS/Windows is Alpha 1/Alpha 3.
- **`@lando/provider-docker` (stretch):** Linux x64 Docker Engine only, as a parallel cross-validator of the `RuntimeProvider` contract. Optional for MVP exit but recommended.

Today (Phase 0):
- [`plugins/provider-docker/src/index.ts`](../../plugins/provider-docker/src/index.ts) is a stub with only `PLUGIN_NAME`.
- `plugins/provider-lando/` does not yet exist as a workspace package.

Depends on: **PRD-01 (SDK contracts)**, **PRD-02 (Foundation)**, **PRD-03 (Effect services — `ProcessRunner`, `FileSystem`, `EventService`, `Logger`)**.

## Goals

- `@lando/provider-lando` Live Layer brings up + tears down a Node + Postgres app on Linux x64 via a private Podman socket.
- `@lando/provider-docker` Live Layer (stretch) does the same against a system Docker Engine.
- Both providers pass the `runProviderContract` suite from `@lando/sdk/test` (PRD-01 US-008).
- The `RuntimeProvider` interface is shape-correct for the contract — no method we wish we'd added later.
- A pinned Podman binary is downloaded + checksum-verified on first `lando setup` *as a stretch goal* — manual install is acceptable for MVP exit.

## User Stories

### US-001: Create `@lando/provider-lando` workspace package

**Description:** As `BUNDLED_PLUGINS`, I need `@lando/provider-lando` to be a real workspace package with a manifest, types, and a Live Layer entry point.

**Acceptance Criteria:**
- [ ] Failing test in `plugins/provider-lando/test/package.test.ts` asserts `import("@lando/provider-lando")` resolves and exports `PLUGIN_NAME`, `provider`, `manifest`.
- [ ] `plugins/provider-lando/package.json` declares `name: "@lando/provider-lando"`, `type: "module"`, `exports`, and `peerDependencies` on `@lando/sdk` and `@lando/core`.
- [ ] `plugins/provider-lando/plugin.yaml` exists with the manifest fields PRD-01's `PluginManifest` schema requires (`name`, `version`, `kind: provider`, `landoCompat`).
- [ ] `plugins/provider-lando/src/index.ts` exports a `provider` Layer (stub at this story; US-002+ fill the body).
- [ ] Test passes after the package skeleton lands.
- [ ] `BUNDLED_PLUGINS` (PRD-02 US-005) lists `@lando/provider-lando` after this story.
- [ ] Typecheck/lint/whole-workspace tests pass.

### US-002: `provider-lando` capability matrix introspection

**Description:** As `RuntimeProviderRegistry`, I ask the active provider for its capabilities. `provider-lando` introspects the running Podman daemon via the API socket and populates a `ProviderCapabilities` value — it does not shell out to `podman version` on PATH.

**Acceptance Criteria:**
- [ ] Failing test in `plugins/provider-lando/test/capabilities.test.ts` (gated on `LANDO_TEST_PODMAN_SOCKET` env var being set; otherwise xfail) connects to a private Podman socket and asserts the returned `ProviderCapabilities` declares:
  - `bindMountPerformance: "native"` on Linux.
  - `sharedCrossAppNetwork: false` (Alpha 3 capability).
  - `copyOnWriteAppRoot: false` (post-GA).
  - All other capabilities populated to their MVP defaults.
- [ ] Test asserts the introspection uses `Bun.spawn` with `unix:///path/to/socket` HTTP-over-UNIX requests — not `Bun.spawn("podman", ...)`.
- [ ] Test asserts capability decode goes through the SDK `ProviderCapabilities` schema; mismatch fails with `ProviderCapabilityError`.
- [ ] Test passes after the impl lands.
- [ ] Typecheck/lint/whole-workspace tests pass.

### US-003: `provider-lando` Compose file emission to per-app temp dir

**Description:** As `provider-lando.bringUp(plan)`, I render the `AppPlan` to a Compose file in a per-app temp directory (the file is an internal implementation detail; users never see it).

**Acceptance Criteria:**
- [ ] Failing test in `plugins/provider-lando/test/compose-emit.test.ts` runs `provider.emitCompose(plan)` against a fixture `AppPlan` (one node service, one postgres service, one bind mount, two endpoints) and asserts:
  - The output is a valid Compose v3 YAML document.
  - It includes both services with `image`, `ports`, `environment`, `volumes`, `depends_on`.
  - It includes the bind mount and the per-app bridge network.
  - The file is written to `<userDataRoot>/apps/<appId>/compose.yml` (or another per-app temp path documented in `spec/05-runtime-providers.md`).
- [ ] Test asserts the Compose file contains *only* keys in the MVP allowlist (no `deploy:`, `secrets:`, `configs:`, etc.).
- [ ] Compose emission uses `FileSystem` (PRD-03 US-003), not raw `Bun.write`.
- [ ] Test passes after the impl lands.
- [ ] Typecheck/lint/whole-workspace tests pass.

### US-004: `provider-lando` `bringUp` brings services to running

**Description:** As `app:start`, I call `provider.bringUp(plan, { signal })` and expect it to start every service in the plan against the private Podman socket and resolve when all are running.

**Acceptance Criteria:**
- [ ] Failing integration test in `plugins/provider-lando/test/bring-up.integration.test.ts` (gated on `LANDO_TEST_PODMAN_SOCKET`; otherwise xfail) runs `bringUp` against a fixture `AppPlan` and asserts:
  - Both services reach `Running` state (verified via API introspection, not `docker ps`).
  - Endpoints are reachable from the test process (`fetch("http://localhost:<port>")` returns the expected response for the node service; Postgres TCP-accepts on its port).
  - Lifecycle events `pre-service-start` and `post-service-start` were published for each service.
  - Cancellation via the supplied `AbortSignal` cleanly stops the partially-up services.
- [ ] `bringUp` uses `compose up`-equivalent behavior implemented over the Podman API — *no* `Bun.spawn("podman", ...)`.
- [ ] Test passes after the impl lands.
- [ ] Typecheck/lint/whole-workspace tests pass.

### US-005: `provider-lando` `bringDown` stops + removes containers

**Description:** As `app:stop`, I call `provider.bringDown(plan)` and expect every service to stop and the per-app network to be removed (volumes preserved).

**Acceptance Criteria:**
- [ ] Failing integration test in `plugins/provider-lando/test/bring-down.integration.test.ts` (gated on `LANDO_TEST_PODMAN_SOCKET`; otherwise xfail) brings up the fixture app, calls `bringDown`, and asserts:
  - Both containers are removed.
  - The per-app network is removed.
  - Volumes declared in the plan are *not* removed (they survive `app:stop`; only `app:destroy` removes them — Alpha 3).
  - Lifecycle events `pre-service-stop` and `post-service-stop` were published.
- [ ] Test passes after the impl lands.
- [ ] Typecheck/lint/whole-workspace tests pass.

### US-006: `provider-lando` `exec` returns Stream of stdio chunks

**Description:** As future `lando exec`, I need `provider.exec({ serviceName, cmd, args, stdin?, tty? })` to return a `Stream<{ stream: "stdout" | "stderr"; chunk: Uint8Array }>` plus a final exit code.

**Acceptance Criteria:**
- [ ] Failing integration test in `plugins/provider-lando/test/exec.integration.test.ts` (gated on `LANDO_TEST_PODMAN_SOCKET`; otherwise xfail) runs `exec({ serviceName: "node", cmd: "node", args: ["-e", "console.log('hi')"] })` against a brought-up app and asserts:
  - Stream emits at least one `stdout` chunk containing `"hi\n"`.
  - Stream completes with `exitCode: 0`.
- [ ] Test asserts `cmd: "false"` resolves with `exitCode: 1` and no `stderr`.
- [ ] `exec` uses the Podman API attach endpoint — not `Bun.spawn("podman", ["exec", ...])`.
- [ ] No TTY support required at MVP; `tty: true` may throw `NotImplemented` if PRD-06's `lando init` doesn't need it.
- [ ] Test passes after the impl lands.
- [ ] Typecheck/lint/whole-workspace tests pass.

### US-007: `provider-lando` `logs` returns follow Stream

**Description:** As future `lando logs`, I need `provider.logs({ serviceName, follow })` to return a `Stream<LogChunk>` that follows by default.

**Acceptance Criteria:**
- [ ] Failing integration test in `plugins/provider-lando/test/logs.integration.test.ts` (gated on `LANDO_TEST_PODMAN_SOCKET`; otherwise xfail) brings up the node service, runs `logs({ serviceName: "node", follow: true })` for 2 seconds, and asserts at least one chunk was emitted with the service's startup output.
- [ ] Test asserts `follow: false` returns a finite stream that completes after the historical log block.
- [ ] `logs` uses the Podman API logs endpoint with the appropriate framing.
- [ ] Test passes after the impl lands.
- [ ] Typecheck/lint/whole-workspace tests pass.

### US-008: `provider-lando` `inspect` returns structured snapshot

**Description:** As `lando info`, I need `provider.inspect(plan)` to return a `Stream<ServiceInfo>` with one entry per service: `{ serviceName, state, endpoints, lastStartedAt }`.

**Acceptance Criteria:**
- [ ] Failing integration test in `plugins/provider-lando/test/inspect.integration.test.ts` (gated on `LANDO_TEST_PODMAN_SOCKET`; otherwise xfail) brings up the fixture app, calls `inspect`, and asserts:
  - One `ServiceInfo` per service.
  - Each `state` is `"running"`.
  - Each `endpoints` array matches the Compose ports declared in the plan.
- [ ] Test asserts a stopped service reports `state: "stopped"`.
- [ ] Test passes after the impl lands.
- [ ] Typecheck/lint/whole-workspace tests pass.

### US-009: `provider-lando` passes the SDK provider contract suite

**Description:** As release engineering, I need `provider-lando` to pass `runProviderContract(provider)` from `@lando/sdk/test` so we have one suite that proves all providers conform.

**Acceptance Criteria:**
- [ ] Failing integration test in `plugins/provider-lando/test/contract.integration.test.ts` (gated on `LANDO_TEST_PODMAN_SOCKET`; otherwise xfail) runs `runProviderContract(provider)` and asserts every assertion passes.
- [ ] Failures from the contract suite carry a `ContractFailure` with the assertion id, so the failure mode is debuggable.
- [ ] Test passes after the contract suite is satisfied.
- [ ] Typecheck/lint/whole-workspace tests pass.

### US-010: `@lando/provider-docker` Live Layer (Linux Docker Engine, stretch)

**Description:** *Stretch goal — recommended but not gating MVP exit.* As contributor with Docker already installed, I want the Docker provider so I can validate the same `RuntimeProvider` contract from a different adapter.

**Acceptance Criteria:**
- [ ] Failing integration test in `plugins/provider-docker/test/contract.integration.test.ts` (gated on `LANDO_TEST_DOCKER_SOCKET=/var/run/docker.sock` or `DOCKER_HOST`; otherwise xfail) runs `runProviderContract(provider)` against the Docker provider and asserts every assertion passes.
- [ ] Compose emission, `bringUp`, `bringDown`, `exec`, `logs`, `inspect` all use the Docker Engine HTTP API (Unix socket or TCP), not `Bun.spawn("docker", ...)`.
- [ ] `bindMountPerformance: "slow"` is *not* declared on Linux Docker Engine (it's `"native"` — Docker Desktop on macOS would declare `"slow"`, but that's Alpha 1).
- [ ] At MVP, this story may xfail in CI without blocking PRD-04 acceptance, *as long as* the architectural assertions (no PATH-shellout, contract-suite parameterization works) are satisfied locally on a developer machine.
- [ ] Typecheck/lint passes for `plugins/provider-docker/` even if the integration test xfails.
- [ ] Whole-workspace `bun test` passes (xfailed integration test does not regress the suite).

### US-011: `lando setup` (`provider-lando`) — manual-install acceptance

**Description:** As MVP exit, I accept that `provider-lando` requires a manually-installed Podman binary on the dev box. The future automated `lando setup` (Alpha 1) downloads + verifies a pinned Podman bundle; at MVP, the provider's `setup` Effect just verifies the dev box has Podman ≥ a pinned version on PATH and that the API socket is reachable.

**Acceptance Criteria:**
- [ ] Failing integration test in `plugins/provider-lando/test/setup.integration.test.ts` runs `provider.setup()` and asserts:
  - Success on a box with Podman installed and the socket reachable.
  - Failure with `ProviderUnavailableError` (specifically a `PodmanNotInstalledError` subtype) on a box without Podman.
  - Failure with `ProviderUnavailableError` (`PodmanSocketUnreachableError`) when Podman is installed but the socket is not running.
- [ ] Each error carries a remediation message naming the next step (e.g. "install Podman ≥ X.Y", "run `systemctl --user start podman.socket`").
- [ ] At MVP, `setup` does *not* download a runtime bundle — that's Alpha 1. Document the deferral in code comments + the PRD's "Open Questions".
- [ ] Test passes after `setup` is implemented.
- [ ] Typecheck/lint/whole-workspace tests pass.

### US-012: Provider-lando does not import `@oclif/core`

**Description:** As release engineering, I need provider plugins to be CLI-agnostic so they work in library mode too.

**Acceptance Criteria:**
- [ ] Failing test in `plugins/provider-lando/test/import-boundary.test.ts` parses every file under `plugins/provider-lando/src/**` (using TypeScript or `ast-grep`), asserts none import `@oclif/core`, `@oclif/...`, or any `core/src/cli/` path.
- [ ] Test passes once the impl is structured to avoid those imports.
- [ ] Typecheck/lint/whole-workspace tests pass.

## Functional Requirements

- FR-1: `@lando/provider-lando` exports `provider: Layer<RuntimeProvider, ProviderInternalError>` from `plugins/provider-lando/src/index.ts`.
- FR-2: All Podman API calls go through `Bun.spawn` (HTTP-over-UNIX socket) or `fetch` against a Unix socket URL — *never* by spawning the `podman` CLI.
- FR-3: Compose-file rendering for both providers uses the same emitter module (extract a shared helper into `core/src/services/compose-emit.ts` or `@lando/sdk/compose` — implementer's call). The Compose subset allowlist owned by PRD-01 US-004 is the single source of truth.
- FR-4: Both providers use `ProcessRunner` (PRD-03 US-001) for any auxiliary spawns (e.g. checksum tools); they do *not* re-implement spawn handling.
- FR-5: Lifecycle events (`pre-service-start`, `post-service-start`, `pre-service-stop`, `post-service-stop`, `pre-build`, `post-build`) are published by the providers via `EventService`.
- FR-6: `provider.setup()` is idempotent — calling it on an already-set-up box succeeds without changes.
- FR-7: All provider failure channels use `@lando/sdk/errors` tagged errors — no anonymous throws.
- FR-8: `runProviderContract(provider)` from `@lando/sdk/test` passes for `provider-lando` on Linux x64. (Pass for `provider-docker` is the stretch goal.)
- FR-9: Both providers list themselves in `BUNDLED_PLUGINS` via `scripts/build-bundled-plugins.ts`.

## Non-Goals

- **No macOS/Windows for `provider-lando`.** VM lifecycle (Podman machine create/start/stop), runtime bundle download, checksum verification per `spec/05-runtime-providers.md` §5.8.1 — all Alpha 1.
- **No Docker Desktop support.** Linux Docker Engine only at MVP for the stretch path.
- **No Podman Desktop support.** Alpha 3 (`@lando/provider-podman`).
- **No automated `lando setup` runtime bundle.** Manual Podman install at MVP. Document the deferral.
- **No file sync (Mutagen).** Alpha 3 — `bindMountPerformance: "slow"` providers don't exist at MVP.
- **No shared cross-app network.** Per-app bridge only (Alpha 1+ for shared discovery).
- **No build-secret / SSH-forwarding support.** Alpha 3.
- **No native Compose passthrough.** Alpha 3 — MVP planner emits the canonical subset only.
- **No registry credential support.** Alpha 3.

## Technical Considerations

- The Podman API uses the same Docker-compatible HTTP API surface — that simplifies sharing a single API client. Implementer's call whether to ship one client (with adapters) or two; either is OK.
- HTTP-over-UNIX-socket via `Bun.spawn`: use `fetch(url, { unix: "/path/to/socket" })` if Bun's `fetch` supports it in 1.3.x; otherwise wrap a low-level UNIX socket client around `Bun.connect`.
- Compose emission: the canonical doc shape is owned by `spec/05-runtime-providers.md`. Refer to it; do not invent new keys.
- The MVP "manual Podman install" path means `setup`'s job is verification + remediation messaging, not installation. The Alpha 1 path swaps the implementation; the contract stays the same.
- Provider tests that touch real Podman/Docker are gated on env vars and run in a separate `*.integration.test.ts` suffix — vanilla `bun test` (no env vars set) skips them. **CI runs the full integration suite at MVP** — see [PRD-07](./prd-mvp-07-ci-and-binaries.md). The `provider-integration-linux-x64` job exports `LANDO_TEST_PODMAN_SOCKET` and runs every `*.integration.test.ts`. Docker integration tests stay opportunistic (xfail when no Docker socket) so contributors who enable Docker locally still get coverage without changing CI.

## Success Metrics

- `runProviderContract(provider-lando)` passes 100% of assertions on Linux x64 with Podman installed.
- Zero references to `Bun.spawn("podman"` or `Bun.spawn("docker"` in `plugins/provider-{lando,docker}/src/` (verified by an explicit grep test).
- The exit-criteria command from PRD-00 (`./dist/lando init --full && cd <dir> && ../dist/lando start`) brings up Node + Postgres on Linux x64 via `provider-lando` end-to-end.
- Provider-lando's `bringUp` → `inspect` → `bringDown` cycle works repeatedly on the same app id without state corruption.

## Open Questions

- The "download + verify a pinned Podman binary on first `lando setup`" path was discussed in the roadmap as a stretch even within MVP. Default for this PRD: defer to Alpha 1 (PRD's `setup` does verification only). If the implementer wants to ship the download now, the trust-root and checksum source must be locked first — `spec/05-runtime-providers.md §5.8.1` is the spec gate, Beta 1 is the policy gate.
- Should the Compose emitter live in `@lando/sdk` (so plugins can share it) or `@lando/core` (so plugins reach back through a service tag)? Default: `core`, exposed via a `ComposeEmitter` Effect Service tag declared in the SDK. Decide in implementation; document the choice.
- `ServiceInfo.endpoints` shape: do we report container-internal addresses, host-published ports, or both? Default per `spec/06-services.md`: host-published ports for `lando info`'s consumption. Container-internal addresses are a Alpha 3 thing.
- Are integration tests allowed to leave Podman containers behind on failure, or must we always teardown? Default: always teardown via `Effect.acquireRelease` so a panic doesn't pollute the dev box.
