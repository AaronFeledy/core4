# PRD: ALPHA4-09 — Supply chain, self-update & the outbound-network primitives (HttpClient / Downloader / tool provisioning)

## Introduction

Alpha 4 adds verifiable release artifacts and a safe self-update path. Every published artifact gets SBOM coverage, keyless provenance, and signature checks. `lando update` then consumes the signed update manifest, verifies downloaded artifacts before trusting them, replaces binaries atomically, and rolls back when launch probes fail.

This PRD depends on PRD-08's release pipeline. It fills §17.5 supply-chain requirements and §17.6 self-update behavior for the Alpha 4 release train.

This PRD also absorbs the layered **outbound-network primitives**. These are folded here because self-update and supply-chain verification are the trust-root consumers of network behavior, and the same proxy/CA/redaction stack serves every Lando-owned fetch. The layering is:

- **`HttpClient`** — the single outbound-egress chokepoint for all Lando-owned network access (streaming request/response, upload, the canonical network-trust resolver, redaction, `pre-/post-http-call` events). Consumed by `Downloader` and by every request/response caller (hosting push/pull, telemetry delivery, the update-manifest fetch, plugin-registry queries, tunnel/share control planes, the MCP surface, the `UrlScanner`).
- **`Downloader`** — the verified-artifact specialization that wraps `HttpClient`: checksum/size verification, atomic persistence, cache/offline short-circuiting, and download progress. It issues its byte-fetch through `HttpClient.stream` and never opens its own socket.
- **Tool provisioning** — a pure `@lando/sdk` helper over `Downloader` that resolves a multi-platform `ToolManifest`, extracts an archive member, and installs a pinned host binary under `<userDataRoot>/bin/` with idempotent version markers.

Network-primitive work keeps its external dependencies on **ALPHA4-01** (setup/download call sites; the network-trust resolver also backs setup preflight) and **ALPHA4-04** (schema publication); self-update verification is now internal to this PRD. The probe primitive (**ALPHA4-14**) supplies the `HttpClient`/`Downloader` retry semantics, and the downstream **ALPHA4-11** SDK/library acceptance suite validates the exported surface.

## Source References

- [`spec/15-binary-build-and-release.md`](../15-binary-build-and-release.md) §17.5 supply-chain artifacts.
- [`spec/15-binary-build-and-release.md`](../15-binary-build-and-release.md) §17.6 self-update flow.
- [`spec/15-binary-build-and-release.md`](../15-binary-build-and-release.md) §17.6.1 update manifest schema and channel URLs.
- [`spec/15-binary-build-and-release.md`](../15-binary-build-and-release.md) §17.6.2 POSIX and Windows replacement behavior.
- [`spec/alpha-4/prd-alpha-4-00-index.md`](./prd-alpha-4-00-index.md) PRD-09 range, dependency on PRD-08, and verification contract.

### Network-primitive source references

- [`spec/04-pluggability.md`](../04-pluggability.md) §4.2 `HttpClient` and `Downloader` catalog entries and the `httpClients:` / `downloaders:` manifest contributions.
- [`spec/03-architecture.md`](../03-architecture.md) §3.4 `HttpClient` / `Downloader` service membership and §3.5 `http-call` / download lifecycle events.
- [`spec/11-subsystems.md`](../11-subsystems.md) §10.3.1 corporate proxy/custom CA handling, §10.3.2 outbound HTTP (`HttpClient`), §10.3.3 verified downloads (`Downloader`), §10.3.4 tool provisioning.
- [`spec/11-subsystems.md`](../11-subsystems.md) §10.2.2 public tunnels and app sharing (`TunnelService`) — the downstream tunnel contract that consumes `HttpClient`, tool provisioning, `ProcessRunner`, `StateStore`, the probe primitive, `InteractionService`, and `RedactionService`.
- [`spec/02-toolchain.md`](../02-toolchain.md) §2.1 egress-boundary rule and the `check:network-boundary` gate; §2.6 forbidden HTTP libraries.
- [`spec/13-testing-and-distribution.md`](../13-testing-and-distribution.md) §13.1 `HttpClient`, `Downloader`, and `TunnelService` contract suites.
- [`spec/05-runtime-providers.md`](../05-runtime-providers.md) §5.8.1 runtime-bundle source resolution.
- [`spec/12-caches-and-persistence.md`](../12-caches-and-persistence.md) §12.1 `tool-downloads` cache and §12.4 `bin/` provisioning artifacts/markers.
- [`spec/15-binary-build-and-release.md`](../15-binary-build-and-release.md) §17.2 `ToolManifest` codegen.
- [`spec/10-plugins.md`](../10-plugins.md) §9.5 contribution surfaces.
- [`spec/alpha-4/prd-alpha-4-00-index.md`](./prd-alpha-4-00-index.md) verification contract and SDK/schema rules.

## Goals

- Publish a CycloneDX SBOM for every release artifact.
- Publish SLSA v1.0 provenance attestations signed keylessly through GitHub Actions OIDC.
- Make every binary cosign-verifiable through published identity and issuer details.
- Add signed update manifests for `stable`, `next`, and `dev` channels.
- Replace POSIX binaries atomically with launch-probe and rollback safety.
- Handle Windows running-exe replacement without corrupting the current binary.
- Report update telemetry only as redacted success and failure categories.

### Network-primitive goals

- Publish `HttpClient` as the single outbound-egress chokepoint for all Lando-owned network access, with the canonical network-trust resolver (proxy/CA/`NO_PROXY`) promoted to a pure `@lando/sdk` module that both `HttpClient` and `lando setup` preflight consume.
- Rewrite `Downloader` as the verified-artifact specialization that wraps `HttpClient` (checksum/size verification, atomic persistence, scheme gating, path containment, cache/offline behavior, download progress), routing every byte of egress through `HttpClient`.
- Ship the tool-provisioning helper (`ToolManifest` + archive extraction + `bin/` install + idempotent version markers) over `Downloader`, replacing the per-plugin extract/install code.
- Freeze the downstream `TunnelService` contract shape now — SDK schemas/errors/events, `tunnelServices:` manifest surface, contract suite, App-handle/CLI result schemas, and detached-session state seam — so the 4.1 `lando share` feature can plug in without inventing new primitives after feature freeze.
- Expose SDK-safe contracts and `httpClients:` / `downloaders:` manifest surfaces for audited, mirrored, sandboxed, air-gapped, and corporate-gateway implementations.
- Migrate existing runtime-bundle, Mutagen/helper, recipe/include tarball, and self-update artifact fetches onto these primitives, and enforce the `check:network-boundary` gate banning direct `fetch` outside the `HttpClient` adapter.
- Add mandatory contract suites so plugin-contributed `HttpClient` and `Downloader` implementations cannot weaken security or reliability guarantees, including the egress-fence (a contributed `Downloader` cannot open its own socket).

## User Stories

### US-258: Each release artifact includes a CycloneDX SBOM

**Description:** As a security reviewer, I can inspect a CycloneDX SBOM for every published Lando artifact.

**Acceptance Criteria:**
- [ ] The release pipeline emits `dist/lando-${V}-sbom.cdx.json` for each binary artifact and the library archive.
- [ ] SBOM files use CycloneDX JSON format and include artifact name, version, checksum, component list, and tool metadata.
- [ ] Stage 12 fails if any publishable artifact lacks a matching SBOM.
- [ ] Release manifest entries link each artifact to its SBOM path and checksum.
- [ ] Tests cover SBOM naming, required fields, missing-SBOM failure, and manifest linkage.
- [ ] Tests pass
- [ ] Typecheck passes
- [ ] Lint passes

### US-259: Release provenance uses SLSA v1.0 keyless cosign through OIDC

**Description:** As a downstream verifier, I can confirm that published artifacts came from the official GitHub Actions release workflow.

**Acceptance Criteria:**
- [ ] Stage 12 emits SLSA v1.0 provenance attestations for every published artifact.
- [ ] Provenance attestations are keyless-signed with cosign using GitHub Actions OIDC.
- [ ] Attestations include builder identity, source ref, commit SHA, artifact digest, workflow path, and release version.
- [ ] CI fails release mode if OIDC identity or issuer does not match the configured release workflow.
- [ ] Tests cover attestation payload shape, OIDC issuer configuration, and missing-attestation failure without requiring live OIDC.
- [ ] Tests pass
- [ ] Typecheck passes
- [ ] Lint passes

### US-260: Binary signatures are verified in CI and documented in release notes

**Description:** As a user downloading a binary, I can run the published verification command and get the same success CI proved before publish.

**Acceptance Criteria:**
- [ ] Every binary gets a keyless cosign signature before publish.
- [ ] CI runs `cosign verify-blob` for every published binary using the configured OIDC identity and issuer.
- [ ] Release notes publish each binary's signature, certificate, and exact verification command.
- [ ] Publish fails if any binary cannot be verified with the published command.
- [ ] Tests cover release-note command rendering, identity / issuer mismatch, and missing-signature failure.
- [ ] Tests pass
- [ ] Typecheck passes
- [ ] Lint passes

### US-261: `lando update` resolves a channel and verifies a signed manifest before trusting it

**Description:** As a user, I can run `lando update` and know the update metadata was verified before Lando downloads or replaces anything.

**Acceptance Criteria:**
- [ ] `meta:update` and top-level `lando update` resolve channels `stable`, `next`, and `dev`.
- [ ] Manifest URLs are `https://update.lando.dev/v4/{stable,next,dev}.json`.
- [ ] `UpdateManifestSchema` validates channel, version, minimum, artifact URLs, checksums, signatures, and platform entries.
- [ ] The manifest sibling `.sig` is verified before any manifest fields are trusted.
- [ ] A signed manifest older than the newest signed manifest previously observed for that channel is refused as possible replay.
- [ ] The `minimum` field blocks auto-update for binaries that are too old and prints manual update remediation.
- [ ] Tests pass
- [ ] Typecheck passes
- [ ] Lint passes

### US-262: POSIX self-update replaces the binary atomically and re-execs

**Description:** As a POSIX user, a successful update downloads, verifies, probes, atomically swaps the binary, and restarts into the new version.

**Acceptance Criteria:**
- [ ] POSIX update downloads to a temp file in the target filesystem and verifies checksum plus signature before execution.
- [ ] A launch probe runs the downloaded binary before replacement.
- [ ] Replacement uses `rename(2)` and preserves a `.bak` rollback file.
- [ ] Successful replacement runs `execve(2)` into the updated binary with the expected argv and environment.
- [ ] Tests cover temp-file placement, checksum failure, signature failure, launch probe success, rename behavior, and re-exec argument preservation.
- [ ] Tests pass
- [ ] Typecheck passes
- [ ] Lint passes

### US-263: Failed launch probes restore `.bak` and raise `UpdateLaunchProbeError`

**Description:** As a user, if the downloaded binary cannot start, Lando restores the previous binary and tells me what failed.

**Acceptance Criteria:**
- [ ] Failed launch probe restores the `.bak` binary before returning control to the user.
- [ ] Launch probe failures surface `UpdateLaunchProbeError` with platform, attempted version, probe command, and redacted output summary.
- [ ] Rollback failure is reported separately and never hides the original probe error.
- [ ] The update cache records the failed category without storing paths, hostnames, or user identifiers.
- [ ] Tests cover probe failure, successful rollback, rollback failure, and redacted error rendering.
- [ ] Tests pass
- [ ] Typecheck passes
- [ ] Lint passes

### US-264: Windows self-update handles running `.exe` replacement safely

**Description:** As a Windows user, updating a running Lando executable uses a delayed swap or spawn-and-exit flow instead of trying to overwrite the locked executable.

**Acceptance Criteria:**
- [ ] Windows update detects the running `.exe` lock and avoids direct overwrite.
- [ ] The update flow supports delayed swap or spawn-and-exit replacement with a verified downloaded binary.
- [ ] If the delayed swap cannot be scheduled, Lando prints exact manual fallback instructions.
- [ ] Windows replacement preserves rollback behavior where the platform permits it.
- [ ] Tests cover locked-exe detection, swap helper invocation, fallback instruction rendering, and failure mapping.
- [ ] Tests pass
- [ ] Typecheck passes
- [ ] Lint passes

### US-265: Update permission errors and telemetry are safe and actionable

**Description:** As a user without write permission to the install path, I get exact manual remediation and Lando never silently elevates.

**Acceptance Criteria:**
- [ ] EACCES during download placement, replacement, backup, or rollback surfaces `UpdatePermissionError`.
- [ ] `UpdatePermissionError` includes exact manual sudo or UAC remediation for the detected install path without running elevation itself.
- [ ] Update never invokes sudo, UAC, or `PrivilegeService` silently.
- [ ] Update telemetry reports success and failure categories only.
- [ ] Telemetry payloads do not include paths, hostnames, user IDs, full URLs with tokens, or raw command output.
- [ ] Tests pass
- [ ] Typecheck passes
- [ ] Lint passes

The following stories are folded in from the Downloader primitive scope.

### US-285: Publish the `Downloader` SDK service, schemas, errors, and manifest surface

**Description:** As a plugin author or embedding host, I can replace Lando's verified artifact acquisition path through a stable `Downloader` service contract instead of patching individual setup/update call sites.

**Acceptance Criteria:**

- [ ] `@lando/sdk/services` exports the `Downloader` service tag and typed interface with `download(request)` returning an Effect; the interface and `DownloaderLive` are defined as a wrapper over `HttpClient` (US-330/US-331) and the `Downloader` value depends on the `HttpClient` tag.
- [ ] `@lando/sdk/schema` exports `ArtifactManifestEntry`, `DownloadRequest`, `DownloadResult`, `DownloaderCapabilities`, and download lifecycle event payload schemas.
- [ ] `@lando/sdk/errors` exports tagged download errors: `DownloadFetchError`, `DownloadChecksumError`, `DownloadSizeMismatchError`, `DownloadPersistError`, `DownloadOfflineError`, `DownloadSourceForbiddenError`, and `DownloaderUnavailableError`.
- [ ] Plugin manifests accept `provides.downloaders[]` with capability metadata, module path containment, deprecation metadata, and standard §4.3 selection behavior.
- [ ] `sdk/API_COMPATIBILITY.md`, SDK export fixtures, schema registry entries, and schema snapshots are updated in the same change.
- [ ] Tests pass.
- [ ] Typecheck passes.
- [ ] Lint passes.

### US-286: Implement `DownloaderLive` as a verified wrapper over `HttpClient`

**Description:** As a user behind a proxy or custom CA, every Lando-owned artifact download inherits one canonical outbound-trust implementation (from `HttpClient`) and adds verified, atomic, cache-aware persistence on top.

**Acceptance Criteria:**

- [ ] `DownloaderLive` is available at bootstrap `minimal`, depends on the `HttpClient` tag, and issues its byte-fetch through `HttpClient.stream`. It does NOT call `fetch` directly or resolve proxy/CA itself — that lives entirely in `HttpClient` (US-331), so overriding `HttpClient` governs downloads too.
- [ ] File downloads pipe the `HttpClient.stream` body through SHA-256 hashing into a unique temp file on the destination filesystem, then atomically rename on success.
- [ ] Temp files are removed on fetch failure, checksum mismatch, size mismatch, persistence failure, and `Effect.interrupt`.
- [ ] `memory` downloads buffer only when explicitly requested by the caller.
- [ ] Existing verified destination artifacts short-circuit without network access; offline cache misses fail before opening a connection.
- [ ] `https://` is the default production scheme; `file://` is rejected unless the request explicitly allows local sources.
- [ ] Tests pass.
- [ ] Typecheck passes.
- [ ] Lint passes.

### US-287: Migrate existing Lando-owned download call sites to `Downloader`

**Description:** As a maintainer, I can reason about one verified-download path instead of auditing near-duplicate helpers across provider, file-sync, recipe/include, and update code.

**Acceptance Criteria:**

- [ ] `@lando/provider-lando` runtime-bundle fetch/verify/persist delegates to `Downloader` after it resolves the active manifest entry and override precedence.
- [ ] `@lando/file-sync-mutagen` host CLI and agent binary acquisition delegates to the tool-provisioning helper (US-332) — which provisions through `Downloader`, extracts the archive member, and installs under `<userDataRoot>/bin/` — so only daemon/session logic remains a file-sync concern. The plugin's bespoke download/extract/verify/install code (including its private `fetchInitForNetwork` copy and tar/zip extractor) is removed.
- [ ] Core recipe tarball and include tarball materialization delegate tarball fetch/verify/persist to `Downloader` while git/npm/registry paths remain with their existing Git/BunSelfRunner seams.
- [ ] Self-update binary/checksum/signature artifact fetches delegate byte acquisition to `Downloader`; signature/cosign/GPG verification remains in the release/update primitive after download.
- [ ] Plugin install/update paths that are package-manager operations remain on `BunSelfRunner` and are explicitly documented as out of `Downloader` scope.
- [ ] Local copies of `fetchInitForNetwork`, `shouldBypassProxy`, proxy/CA fetch wiring, SHA-256 buffer loops, and unsafe file persistence are removed from migrated call sites.
- [ ] Source-mode and compiled `$bunfs` dispatch paths continue to use the same shared helpers for setup and update downloads.
- [ ] Tests pass.
- [ ] Typecheck passes.
- [ ] Lint passes.

> **Scope resolution (Mutagen acquisition → US-332):** Criterion 2 (the `@lando/file-sync-mutagen` host-CLI/agent migration) is the headline deliverable of US-332 — *"Ship the tool-provisioning helper and migrate Mutagen onto it"*, whose AC4 already owns this exact migration and marks it *"(paired with US-287)"*. That migration cannot land without the helper US-332 ships: the canonical `ToolManifest`/`ToolArtifactEntry` SDK schemas, the `ToolExtractError`/`ToolInstallPathError`/`ToolManifestError` errors, the §17.2 `ToolManifest` codegen staleness gate, and the idempotent `bin/` version/fingerprint markers. US-287 owns and completes the direct `Downloader` call-site migrations (provider-lando runtime bundle, recipe/include tarballs, self-update byte fetches), the `BunSelfRunner` package-manager carve-out, and removing the bespoke proxy/SHA/persistence copies from those migrated sites. The file-sync bespoke download/extract/verify/install path is therefore the paired US-332 deliverable, not a US-287 omission — implementing it here would mean building most of US-332 as a second story.

### US-288: Enforce the Downloader contract suite, events, redaction, and acceptance coverage

**Description:** As a maintainer or security reviewer, I can prove every built-in or plugin-contributed Downloader preserves the security and reliability guarantees required by the spec.

**Acceptance Criteria:**

- [ ] `@lando/sdk/test` exports a Downloader contract suite that runs against `DownloaderLive`, `TestDownloader`, and any plugin-contributed downloader.
- [ ] The suite covers capability declaration, `https://`/`file://` gating, proxy/CA precedence, `NO_PROXY`, cache hit, offline cache miss, checksum mismatch, size mismatch, path escape rejection, atomic rename, interruption cleanup, and event publication.
- [ ] `pre-download`, `download-progress`, and `post-download` events are emitted with stable payload schemas and deterministic redaction.
- [ ] Proxy credentials, URL userinfo, bearer tokens, signed-URL query params, and caller-supplied redaction tokens never appear in events, telemetry, readiness summaries, support diagnostics, lockfiles, cache metadata, or normal logs.
- [ ] Linux-x64 acceptance coverage proves runtime-bundle and Mutagen downloads route through `Downloader`, while installer script downloads remain outside runtime scope.
- [ ] Contract tests prove a plugin-contributed downloader cannot weaken checksum verification, path containment, or redaction, and cannot open its own socket — every byte of egress is asserted to flow through the resolved `HttpClient` — while still satisfying the service interface.
- [ ] Tests pass.
- [ ] Typecheck passes.
- [ ] Lint passes.

### US-330: Publish the `HttpClient` SDK service, schemas, errors, events, and manifest surface

**Description:** As a plugin author or embedding host (hosting push/pull, a tunnel control plane, an MCP surface), I can perform Lando-governed outbound HTTP — request/response, streaming, and upload — through one stable `HttpClient` contract instead of calling `fetch` and re-implementing proxy/CA/redaction.

**Acceptance Criteria:**

- [ ] `@lando/sdk/services` exports the `HttpClient` service tag and typed interface: `request(req)`, `stream(req)` (a non-buffering `Stream<Uint8Array>` response body), and `upload(req)`, each returning a `Scope`-bearing Effect, plus a `capabilities` field.
- [ ] `@lando/sdk/schema` exports `HttpRequest`, `HttpResponse`, `HttpStreamResponse`, `HttpUploadRequest`, `HttpClientCapabilities`, and the `pre-http-call` / `post-http-call` event payload schemas.
- [ ] `@lando/sdk/errors` exports tagged errors: `HttpRequestError`, `HttpUploadError`, `HttpTrustError` (with the classified kinds `proxy-authentication` / `tls-interception` / `missing-custom-ca` / `blocked-endpoint`), and `HttpClientUnavailableError`.
- [ ] Plugin manifests accept `provides.httpClients[]` with capability metadata, module-path containment, deprecation metadata, and standard §4.3 selection behavior.
- [ ] `sdk/API_COMPATIBILITY.md`, SDK export fixtures, the schema registry/`SDK_SCHEMA_NAMES`, and schema snapshots are updated in the same change.
- [ ] Tests pass.
- [ ] Typecheck passes.
- [ ] Lint passes.

### US-331: Implement `HttpClientLive`, the canonical network-trust resolver, and the egress-boundary gate

**Description:** As a user behind a proxy or custom CA, every Lando-owned fetch — downloads and request/response traffic alike — honors one canonical outbound-trust implementation that I configure once.

**Acceptance Criteria:**

- [ ] The proxy/CA helper currently embodied by setup network-trust code (`fetchInitForNetwork`, `shouldBypassProxy`, trust resolution) is extracted to a canonical pure module exported from `@lando/sdk`; `HttpClientLive` and `lando setup` preflight both consume it, and the duplicated copies in `provider-lando` and `file-sync-mutagen` are deleted.
- [ ] `HttpClientLive` is available at bootstrap `minimal`, uses Bun `fetch`, honors `network.proxy` before env proxy variables, honors `NO_PROXY`, loads configured CA PEMs, and accepts an already-resolved trust object from setup preflight.
- [ ] `stream` exposes a non-buffering `Stream<Uint8Array>` response body; `Effect.interrupt` closes the connection and reaps in-flight transfers; an offline-only request fails before opening a connection.
- [ ] `pre-http-call` / `post-http-call` events are emitted with redaction of proxy credentials, URL userinfo, bearer tokens, and signed-URL query params; an `HttpClient` call issued on behalf of a `Downloader` request is tagged so it is not double-counted as an independent `http-call`.
- [ ] `@lando/sdk/test` exports an `HttpClient` contract suite (trust precedence + `NO_PROXY`; `request`/`stream`/`upload` apply resolved trust; non-buffering stream body; scheme rejection; interruption cleanup; offline fail-fast; event redaction) that runs against `HttpClientLive`, `TestHttpClient`, and any contributed implementation.
- [ ] A `check:network-boundary` gate (CI static-checks) scans `core/src/**` and `plugins/**` and fails on direct `fetch` for Lando-owned network access outside the `HttpClient` adapter, with carve-outs only for `BunSelfRunner` package-manager ops and the standalone installer scripts.
- [ ] Tests pass.
- [ ] Typecheck passes.
- [ ] Lint passes.

### US-332: Ship the tool-provisioning helper and migrate Mutagen onto it

**Description:** As a maintainer, every bundled tool that installs a pinned host binary (Mutagen today; tunnel/mkcert/profiler/hosting CLIs later) uses one shared verify-extract-install helper instead of hand-rolled per-plugin code.

**Acceptance Criteria:**

- [ ] `@lando/sdk/schema` exports the canonical `ToolManifest` and `ToolArtifactEntry` schemas (multi-platform-keyed); `@lando/sdk/errors` exports `ToolExtractError`, `ToolInstallPathError`, and `ToolManifestError`.
- [ ] A pure `@lando/sdk` provisioning helper resolves the active host entry by `${platform}-${arch}`, fetches+verifies bytes through `Downloader` (never directly), extracts the named `tar.gz`/`zip` member, and installs it under a realpath-contained `<userDataRoot>/bin/` path with the declared mode.
- [ ] The helper writes an installed-version marker plus a per-binary `.sha256` fingerprint; a re-run whose pinned `toolVersion` and fingerprints already match is an idempotent no-op with no network access (offline contract).
- [ ] `@lando/file-sync-mutagen` ships its `mutagen-versions.json` as a `ToolManifest` asset and provisions the host CLI + agents through the helper; its bespoke fetch/extract/verify/install code is removed (paired with US-287).
- [ ] The §17.2 codegen emits/validates the Mutagen `ToolManifest` against the canonical schema with a `git diff --exit-code` staleness gate; the `tool-downloads` cache (§12.1) and `bin/` markers (§12.4) behave as specified.
- [ ] Tests pass.
- [ ] Typecheck passes.
- [ ] Lint passes.

### US-342: Freeze the `TunnelService` SDK contract surface

**Description:** As a plugin author or embedding host, I can build a public-sharing provider against a stable, frozen `TunnelService` contract — service tag, schemas, tagged errors, lifecycle events, `tunnelServices:` manifest surface, and contract suite — so the 4.1 `lando share` feature plugs in without new SDK surface after feature freeze.

**Acceptance Criteria:**
- [ ] `@lando/sdk/services` publishes the `TunnelService` `Context.Service` tag (`@lando/core/TunnelService`) with `start` / `stop` / `status` / `list` per §10.2.2, re-exported from `@lando/core/services`.
- [ ] `@lando/sdk/schema` publishes `TunnelCapabilities`, `TunnelTarget` (tagged union over a resolved `RoutePlan` id/hostname, a service endpoint, and a core-created loopback URL), `TunnelStartRequest` / `TunnelStopRequest` / `TunnelStatusRequest`, `TunnelSession`, `TunnelStatus`, and `TunnelSessionFilter`; the schema snapshot round-trips them and `bun run codegen:schema-snapshot` + `git diff --exit-code` is clean.
- [ ] `@lando/sdk/errors` publishes the seven §10.2.2 tagged errors (`TunnelProviderUnavailableError`, `TunnelTargetUnresolvedError`, `TunnelAuthRequiredError`, `TunnelStartError`, `TunnelReadyTimeoutError`, `TunnelDetachedStateError`, `TunnelStopError`), each carrying redacted detail + remediation, on the additive errors barrel (not a frozen sub-barrel).
- [ ] The `Tunnel` lifecycle event scope (`pre-/post-tunnel-start`, `tunnel-ready`, `pre-/post-tunnel-stop`, `tunnel-status`; §3.5) ships with redacted payload schemas registered in the event inventory used by the §13.x gates.
- [ ] The `tunnelServices:` manifest contribution surface (§4.2/§9.5) is added to the `PluginManifest` schema (`id`/`module`/`capabilities`), validated at plugin load, and the manifest-schema snapshot is updated.
- [ ] The §13.1 `TunnelService` contract suite ships from `@lando/sdk/test` (target resolution, `HttpClient` egress, tool-provisioning, scope finalization, detached `StateStore` reconciliation, redaction, probe-based readiness, no `DataMover` use), and `@lando/core/testing` ships an in-memory `TestTunnelService`.
- [ ] `sdk/API_COMPATIBILITY.md` records every new export as additive and the SDK export fixtures are updated in the same change.
- [ ] Contract-only: no bundled tunnel provider and no real `app:share` connector wiring ship here; a runtime with no installed `TunnelService` resolves none.
- [ ] Tests pass.
- [ ] Typecheck passes.
- [ ] Lint passes.

### US-343: Wire `app:share*` commands and `App.share*` handle methods as provider-aware skeletons

**Description:** As a CLI user or embedding host, `lando share` / `App.share()` resolve a `TunnelService` through the registry and either dispatch to it or fail with actionable `TunnelProviderUnavailableError` remediation when none is installed — freezing the command, handle, result, and detached-state surface before feature freeze while the bundled provider ships in 4.1.

**Acceptance Criteria:**
- [ ] `app:share`, `app:share:list`, and `app:share:stop` register in the canonical `LandoCommandSpec` registry (§8.2) at bootstrap `app` with the documented flags (`--target`, `--provider`, `--detach`, `--format json`), top-level alias `share` for `app:share`, and source/compiled dispatch parity (§8.4.1, the §13.1 parity layer).
- [ ] `App.share` / `App.shareList` / `App.shareStop` are present on the published `App` handle (§16.3) with the §16 scope semantics (foreground `share` keeps `Scope.Scope`; `shareList` / `shareStop` are `R = never`).
- [ ] With no `TunnelService` installed, every path fails with `TunnelProviderUnavailableError` carrying install remediation that lists bundled/community options; with a `TestTunnelService` injected, the commands and handle round-trip a session.
- [ ] `--format json` and the `App.share*` methods return the universal machine-output/session schemas (§8.11) — never provider-specific text — and a foreground share emits `StreamFrame`s terminating in a result frame.
- [ ] The `tunnel-registry` `StateStore` bucket (§12.1) and the `<userDataRoot>/run/tunnels/` artifact layout (§12.4) are created/read by `app:share:list` / `app:share:stop` and reconcile stale PID/socket entries without treating orphans as active exposure.
- [ ] Results and diagnostics route through the `Renderer` seam (§13.4) with no direct `console.*` / `process.std*` writes.
- [ ] No bundled connector provider ships here; the Cloudflare/ngrok `TunnelService` plugin and end-to-end `lando share` wiring are 4.1.
- [ ] Tests pass.
- [ ] Typecheck passes.
- [ ] Lint passes.

### US-368: Honor `HttpRequest.timeoutMs` in `HttpClientLive`

**Description:** As a plugin author, when I set `timeoutMs` on an `HttpRequest`, the live HttpClient enforces the deadline, so the published schema field is not a silent no-op that every caller must work around.

**Acceptance Criteria:**

- [ ] `HttpClientLive` (`core/src/http-client/live.ts`) honors `HttpRequest.timeoutMs` on `request`, `stream`, and `upload`: a transfer that exceeds the deadline fails with a tagged timeout error and reaps the in-flight connection under `Scope`.
- [ ] A `0` or unset `timeoutMs` preserves the current unbounded behavior; the timeout composes correctly with `Effect.interrupt` and the offline fail-fast path, with no leaked sockets and no double-fire.
- [ ] The plain-async bridge `core/src/http-client/json-fetch.ts` no longer needs its caller-side `AbortSignal.timeout` workaround for correctness; it is removed or retained only as documented defense-in-depth without a double-timeout regression.
- [ ] The `HttpClient` contract suite in `@lando/sdk/test` gains a timeout case asserting enforcement against `HttpClientLive` and `TestHttpClient`.
- [ ] Tests pass.
- [ ] Typecheck passes.
- [ ] Lint passes.

**Notes:** Backlog hardening surfaced in `spec/alpha-4/progress.txt` (US-331 learnings): `HttpRequest.timeoutMs` is declared in the schema but not honored by `live.ts`, forcing each caller (e.g. the recipe/npm/registry metadata bridge) to wrap its own `AbortSignal.timeout`. No owning story existed before this entry.

### US-369: Implement `network.ca.trustHost` host-store + custom-CA merge semantics

**Description:** As a user behind TLS interception, `network.ca.trustHost` augments the system CA store with my configured CAs instead of replacing it, so Lando trusts both default roots and my corporate CA.

**Acceptance Criteria:**

- [ ] `network.ca.trustHost` semantics are defined against Bun's `tls.ca` behavior (which overrides the default CA list): enabling host trust merges the system roots with configured `network.ca.certs` / `LANDO_NETWORK_CA_CERTS` PEMs rather than dropping system roots.
- [ ] `HttpClientLive` and the canonical `@lando/sdk/network-trust` resolver apply the merged CA set; a test proves a request succeeds against both a system-rooted host and a custom-CA host when `trustHost` is enabled, and fails closed against an untrusted host.
- [ ] The `lando setup` network-trust preflight reports `trustHost` resolution consistently with the runtime client, with no setup/runtime divergence.
- [ ] Any schema or enum change is reflected in `API_COMPATIBILITY.md` and the schema snapshot is regenerated; if no public shape changes, the snapshot stays clean.
- [ ] Tests pass.
- [ ] Typecheck passes.
- [ ] Lint passes.

**Notes:** Backlog hardening surfaced in `spec/alpha-4/progress.txt` (US-331/US-332 review notes): trustHost host-store + custom-CA semantics were deferred past US-332 as needing a dedicated Bun TLS design, with no successor story.

### US-370: Cap untrusted decompression and Landofile parser inputs (DoS hardening)

**Description:** As a maintainer, untrusted or compressed inputs enforce size and depth caps so a malicious or malformed artifact cannot exhaust memory before validation completes.

**Acceptance Criteria:**

- [ ] Runtime-bundle decompression/extraction enforces a configurable maximum decompressed-size cap and rejects an over-cap archive with a tagged remediation error before exhausting memory, layered on top of the existing checksum gate.
- [ ] The Landofile subset parser (`@lando/sdk/landofile` `parser.ts`) enforces a maximum input size and maximum nesting depth, rejecting over-limit input with a tagged parse error instead of unbounded recursion or allocation.
- [ ] Any other host-side untrusted-archive unpack path (e.g. the Data-Mover `tar` helper) inherits the same cap or documents why it is exempt.
- [ ] Caps are covered by tests proving rejection at the boundary and acceptance just under the cap; normal-sized inputs are byte-for-byte unchanged.
- [ ] Tests pass.
- [ ] Typecheck passes.
- [ ] Lint passes.

**Notes:** Backlog hardening surfaced in `spec/alpha-4/progress.txt` (US-363 and US-308 review notes): decompression size caps and parser depth/size limits were each flagged as nonblocking supply-chain / DoS follow-ups with no owning story.

## Functional Requirements

- FR-1: Every release artifact MUST have a CycloneDX SBOM named `dist/lando-${V}-sbom.cdx.json` or an artifact-specific equivalent linked from the release manifest.
- FR-2: Every release artifact MUST have SLSA v1.0 provenance keyless-signed with cosign through GitHub Actions OIDC.
- FR-3: Every binary MUST have a keyless cosign signature.
- FR-4: CI MUST run `cosign verify-blob` for every published binary using the published OIDC identity and issuer.
- FR-5: Release notes MUST publish signature, certificate, and verification command details.
- FR-6: `lando update` MUST resolve `stable`, `next`, and `dev` to `https://update.lando.dev/v4/{stable,next,dev}.json`.
- FR-7: Update manifests MUST be validated by `UpdateManifestSchema` and verified through a sibling `.sig` before fields are trusted.
- FR-8: The manifest `minimum` field MUST block auto-update for too-old binaries.
- FR-8a: A signed update manifest MUST NOT move a channel below the newest signed version previously observed by that local install.
- FR-9: POSIX update MUST use temp download, launch probe, checksum and signature verification, `rename(2)`, `.bak` rollback, and `execve(2)`.
- FR-10: Failed launch probes MUST restore `.bak` and surface `UpdateLaunchProbeError`.
- FR-11: Windows update MUST use delayed swap or spawn-and-exit replacement for running `.exe` files.
- FR-12: EACCES MUST surface `UpdatePermissionError` with manual sudo or UAC remediation and no silent elevation.
- FR-13: Update telemetry MUST contain only redacted success and failure categories.

### Network-primitive functional requirements

- FR-N1: All Lando-owned network access MUST flow through `HttpClient`; direct `fetch` is forbidden in `core/src/**` and bundled plugins outside the `HttpClient` adapter, except `BunSelfRunner` package-manager operations and the standalone installer scripts. The `check:network-boundary` gate enforces this.
- FR-N2: All Lando-owned artifact downloads MUST flow through `Downloader`, which issues its byte-fetch through `HttpClient.stream` and MUST NOT open its own socket; a contributed `Downloader` is held to the same egress fence by the contract suite.
- FR-N3: The canonical network-trust resolver (proxy/CA/`NO_PROXY`) MUST exist in exactly one exported `@lando/sdk` module consumed by `HttpClient` and `lando setup` preflight; per-plugin proxy/CA copies MUST be removed.
- FR-N4: `HttpClient.stream` MUST expose a non-buffering `Stream<Uint8Array>` response body; `request` / `stream` / `upload` MUST honor `network.proxy` before env proxy variables, honor `NO_PROXY`, and load configured CA PEMs.
- FR-N5: Runtime-bundle, Mutagen/helper, recipe/include tarball, and self-update artifact downloads MUST provide an expected SHA-256 whenever executable or provider/helper bytes are involved.
- FR-N6: Production manifests MUST use `https://`; `file://` is allowed only through explicit dev/CI override paths.
- FR-N7: Download file persistence MUST be temp-write plus atomic rename, with temp cleanup on every failure/interruption path; offline/cache mode MUST never open a network connection on cache miss.
- FR-N8: Proxy credentials, URL userinfo, bearer tokens, and signed-URL query params MUST be redacted from logs, telemetry, events, support diagnostics, lockfiles, and cache metadata everywhere outside debug-only protected internals.
- FR-N9: `httpClients:` and `downloaders:` plugins MUST pass their SDK contract suites before they are considered compatible.
- FR-N10: Signature verification remains a release/update primitive layered after `Downloader`; the network primitives own SHA-256 and size verification only.
- FR-N11: Tool provisioning MUST resolve a `ToolManifest` host entry, fetch+verify via `Downloader`, extract the named archive member, install under a realpath-contained `<userDataRoot>/bin/` path, write version/fingerprint markers, and be an idempotent no-op when the pinned version already matches.

## Non-Goals

- Implementing installer scripts or installer trust roots in this PRD.
- Supporting package-manager updates through Homebrew, scoop, winget, distro packages, or OCI images.
- Auto-elevating update permissions.
- Adding downgrade or arbitrary version selection beyond channel-based update.
- Publishing host-specific paths, hostnames, or user identifiers in telemetry or release notes.

### Network-primitive non-goals

- Replacing `BunSelfRunner` for registry/npm/plugin install operations.
- Implementing cosign, GPG, or Authenticode verification inside `HttpClient`/`Downloader`.
- Making installer shell scripts use the runtime `HttpClient`/`Downloader` services.
- Building a general REST/client-SDK framework, retry engine, or auth manager inside `HttpClient`; it stays a thin trust-aware request/response/stream/upload primitive (retry comes from `@lando/sdk/probe`).
- Building hosting push/pull, tunnel/share, or MCP features in this PRD; they are downstream consumers of `HttpClient`.
- Adding automatic mirror discovery or a public mirror registry in this PRD.
- Changing runtime-bundle or update-manifest source selection precedence beyond routing the resolved artifact through `Downloader`.
- Making the runtime provider bundle a `ToolManifest`/bin-installed tool; it stays artifact-mode (fetched+verified via `Downloader`, unpacked by the provider).

## Technical Considerations

- Treat manifest verification as the trust root for update metadata; no URL from the manifest should be used before signature verification.
- Keep platform replacement code split behind a shared verified-download and launch-probe pipeline.
- Make launch probes cheap and deterministic, such as invoking the downloaded binary with a version command.
- Keep telemetry fire-and-forget and category-only so update failure handling never depends on network telemetry.
- Store update cache entries with stable schemas so doctor can report recent update failures later without exposing sensitive host data.

### Downloader technical considerations

- Keep manifest/source selection outside `Downloader`; callers resolve one artifact entry and hand it to the service.
- Preserve setup preflight's ability to classify proxy/CA failures before long downloads begin, while preventing setup-only helpers from becoming the only place proxy/CA options are constructed.
- Provide `TestDownloader` so tests can assert requested URLs/checksums without touching the network.
- Ensure plugin packages can depend only on `@lando/sdk` surface for the service contract; plugin code must not import `@lando/core` internals to download artifacts.
- Keep event payloads small and redacted. Progress events should be throttled or byte-thresholded so large downloads do not flood the renderer or telemetry sinks.

## Success Metrics

- CI proves `cosign verify-blob` succeeds for every binary before publish.
- A tampered update manifest is rejected before any artifact download starts.
- A POSIX launch-probe failure restores `.bak` in tests and reports `UpdateLaunchProbeError`.
- Windows locked-exe tests prove direct overwrite is never attempted.

### Network-primitive success metrics

- Grepping migrated runtime code shows one canonical network-trust implementation and no plugin-local `fetchInitForNetwork` / `shouldBypassProxy` copies; `check:network-boundary` finds no direct `fetch` for Lando-owned network access outside the `HttpClient` adapter.
- Single shared contract suites validate the default and any contributed `HttpClient` and `Downloader`, including the egress fence (a contributed `Downloader` cannot open its own socket).
- Setup, self-update, file-sync, and runtime-bundle tests inject `TestHttpClient` / `TestDownloader` and verify behavior without real network access.
- Corporate-proxy and custom-CA tests prove every migrated fetch — downloads and request/response alike — receives the same resolved trust settings.
- The `@lando/file-sync-mutagen` plugin contains no bespoke download/extract/install code; the Mutagen host CLI + agents are provisioned through the shared tool-provisioning helper against a `ToolManifest`.

## Guide Coverage

Per [Alpha 4 index verification](./prd-alpha-4-00-index.md) and the §19 guide convention, this PRD owns the executable guides listed below. Each guide exercises the happy path of its mapped user story; failure modes remain covered by unit and integration tests in the named packages. PRs that touch the listed surface paths MUST also touch the corresponding guide(s), or use the `Guide-Coverage-Skip:` escape hatch.

**Guides owned by this PRD:**

| User Story | Feature | Guide Path | Acceptance |
|---|---|---|---|
| US-258, US-259, US-260 | Verifying release artifacts | `docs/guides/release/verify-supply-chain-artifacts.mdx` | Required at story acceptance |
| US-261 | Update channels and signed manifests | `docs/guides/update/channels-and-manifests.mdx` | Required at story acceptance |
| US-262, US-263 | POSIX update and rollback | `docs/guides/update/posix-atomic-update.mdx` | Required at story acceptance |
| US-264 | Windows update flow | `docs/guides/update/windows-update-flow.mdx` | Required at story acceptance |
| US-265 | Update permission remediation | `docs/guides/update/permission-errors.mdx` | Required at story acceptance |

**CLI / source surface paths covered (drift gate input):**

- `scripts/release.ts`
- `scripts/release/**`
- `core/src/self-update/**`
- `core/src/cli/commands/update.ts`
- `core/src/cli/commands/meta/update*`
- `core/src/cli/run.ts`
- `sdk/src/schema/update-manifest.ts`
- `core/src/telemetry/**`
- `sdk/src/**/update*`
- `sdk/src/**/supply*`
- `.github/workflows/ci.yml`

## Open Questions

- Should `lando update` default to the binary's current channel or always `stable` when no channel is passed? Default: current channel.
- What is the exact GitHub Actions OIDC subject string for release verification? Default: the release workflow on protected release tags.
- Should failed update telemetry be sent before rollback or after rollback completes? Default: after rollback completes or fails, so category reflects final outcome.
- Should `minimum` block print installer guidance or GitHub Releases guidance first? Default: installer guidance for supported platforms, GitHub Releases as fallback.

### Downloader open questions

- Should `Downloader` expose resume/range-download support in v4.0, or reserve it as a future capability? Default: reserve it; atomic full-file downloads are sufficient for Alpha 4.
- Should progress events publish raw byte counts only or include human-readable labels? Default: raw schema fields only; renderers format labels.
- Should mirror selection be caller config or a downloader implementation detail? Default: implementation detail for contributed mirror-aware downloaders, with callers still passing the canonical artifact entry.
