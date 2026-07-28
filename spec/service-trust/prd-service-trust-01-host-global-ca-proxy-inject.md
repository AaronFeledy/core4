# PRD: SERVICE-TRUST-01 — Host-global CA/proxy inject into services

## Introduction

This PRD implements §6.8 host-global CA/proxy inheritance and the service half of §10.3.1. Global config already carries `network.ca.injectIntoServices` (default `true`) and `network.proxy.injectIntoServices` (default `false`). The pure egress plane (`HttpClient` + network-trust resolver) already honors `network.ca` / `network.proxy` for Lando-owned fetches. What is missing is the path from those settings into **container** trust stores and runtime env so in-service package managers work behind corporate TLS interception without per-project Dockerfiles.

Implementation shape (locked):

1. **Schema** — Landofile `services.<name>.security` authoring surface.
2. **Resolve** — shared PEM loader + effective inject flags (global + per-service overrides).
3. **Feature** — bundled `lando.security` (priority 1100) on the lando base default stack.
4. **Planner** — resolve network once per `planApp`, seed feature config, write app-cache CA bundle when needed.
5. **Derived build** — pack CA PEMs into image context and run multi-distro trust-store install; digests participate in the artifact build key.
6. **Setup** — informational note when certs will inject.

Tracking plan: `.omo/plans/host-global-ca-proxy-inject.md`.

## Source References

- [`spec/06-services.md`](../06-services.md) §6.8, §6.9 (`LANDO_CA_*`), §6.13.5 (build keys)
- [`spec/07-landofile-and-config.md`](../07-landofile-and-config.md) §7.5 `network.ca` / `network.proxy`, §7.6 env overrides
- [`spec/11-subsystems.md`](../11-subsystems.md) §10.3.1
- `core/src/services/base/lando.ts` — `LANDO_BASE_DEFAULT_FEATURE_IDS` (add `lando.security`)
- `core/src/services/planner.ts` — `planApp` composition
- `core/src/services/build-key.ts` — artifact key inputs
- `container-runtime/src/image-build.ts` — derived `FROM` + `RUN` builds
- `plugins/service-lando/src/features/*` — feature registration pattern
- `plugins/service-lando/src/services/php-prerequisites.ts` — `buildKeyInputs` precedent
- `core/src/cli/commands/setup-network-trust.ts` — PEM load + setup preflight
- `core/src/http-client/live.ts` — existing `loadCaPems`
- `sdk/src/schema/landofile.ts` — `ServiceConfig` (no `security` field yet)
- `sdk/src/schema/config.ts` — inject flags already shipped

## Goals

- Default-on CA inject for lando-base services from global `network.ca.certs`.
- Default-off proxy inject; independent of CA.
- Per-service `security.inheritNetworkCa` / `security.inheritNetworkProxy` overrides.
- Additive Landofile `security.ca:` unioned after global PEMs (content-digest de-dupe).
- Rebuild when CA PEM bytes change; proxy URLs never key the image and are redacted as secrets in logs.
- Setup surfaces that inject is active when certs are configured.

## User Stories

### US-483: ServiceConfig.security authoring surface

**Description:** As a Landofile author, I can declare `security.ca`, `security.inheritNetworkCa`, and `security.inheritNetworkProxy` on a service so project CAs and per-service inject overrides decode into the canonical service config.

**Acceptance Criteria:**

- [ ] `ServiceConfig` / `ServiceConfigInput` accept optional `security: { ca?: string[], inheritNetworkCa?: boolean, inheritNetworkProxy?: boolean }`.
- [ ] Omitted `security` decodes unchanged (backward compatible).
- [ ] Excess properties under `security` fail closed under the Landofile decode options used in production.
- [ ] Public JSON Schema inventory and `bun run codegen:schema-snapshot` refreshed; generated docs list the new fields.
- [ ] `sdk/API_COMPATIBILITY.md` records the additive fields.
- [ ] Unit decode tests cover present/absent/override booleans.
- [ ] Tests pass
- [ ] Typecheck passes
- [ ] Lint passes

### US-484: Shared CA PEM load and service inject resolution

**Description:** As core, one helper loads CA PEMs from paths and one resolver computes effective inject flags and path lists so setup, HttpClient, and the planner do not fork PEM-read logic.

**Acceptance Criteria:**

- [ ] A shared core helper (e.g. `core/src/network/load-ca-pems.ts`) loads PEM files and returns `{ path, pem, digest }` with stable sha256 digests of UTF-8 bytes.
- [ ] `HttpClientLive` and setup network trust consume the shared loader (no duplicated `readFile` CA paths with divergent errors).
- [ ] `resolveServiceNetworkInject({ network, env, security })` returns `injectCa`, `injectProxy`, global `caPaths` (from `resolveNetworkTrustPlan` when injectCa), `landofileCaPaths` (from `security.ca` only), and resolved `proxy`.
- [ ] Defaults: `injectCa = security.inheritNetworkCa ?? network.ca.injectIntoServices ?? true`; `injectProxy = security.inheritNetworkProxy ?? network.proxy.injectIntoServices ?? false`.
- [ ] Unreadable path fails with a tagged error naming the path and remediation pointing at `network.ca.certs` / `LANDO_NETWORK_CA_CERTS` / Landofile `security.ca`.
- [ ] Pure `@lando/sdk/network-trust` remains file-IO-free.
- [ ] Unit tests cover defaults, overrides, empty cert lists, and missing files.
- [ ] Tests pass
- [ ] Typecheck passes
- [ ] Lint passes

### US-485: `lando.security` feature on the lando base stack

**Description:** As a user of `type: lando` / lando-base services, the `lando.security` feature materializes mounts, trust env, optional proxy env, and an artifact build step from planner-seeded config—without the feature reading `ConfigService` itself.

**Acceptance Criteria:**

- [ ] Feature id `lando.security`, priority **1100**, registered in `@lando/service-lando` feature map and plugin discovery (`features/index.ts`, `plugin.yaml` if required).
- [ ] `"lando.security"` is listed in `LANDO_BASE_DEFAULT_FEATURE_IDS` (`core/src/services/base/lando.ts`).
- [ ] Feature config schema carries pre-resolved `{ injectCa, injectProxy, cas: [{ path, digest }], proxy? }` (planner-supplied).
- [ ] Empty cas and `injectProxy: false` → apply is a no-op.
- [ ] Non-empty cas → bind-mount each host PEM; set `NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`, `LANDO_CA_BUNDLE`, `LANDO_CA_DIR`, `LANDO_CA_CERT` per §6.8/§6.9 (bundle path convention documented in feature module).
- [ ] `injectProxy: true` → set `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY` from payload when defined.
- [ ] Artifact `phase: "build"` step `lando.security:trust-store` with `buildKeyInputs.caDigests` (sorted digests).
- [ ] Feature does not import or yield `ConfigService` / `FileSystem`.
- [ ] Composition unit tests mirror `env-feature.test.ts` / php prerequisite patterns.
- [ ] Base-composition tests that enumerate default feature ids are updated.
- [ ] Tests pass
- [ ] Typecheck passes
- [ ] Lint passes

### US-486: AppPlanner wires global inject into lando-base services

**Description:** As `AppPlanner`, each plan resolves global network trust once, loads PEMs, applies per-service security overrides, resolves Landofile CA paths against the app root, seeds `lando.security` feature config, and keeps proxy URLs out of the artifact build-key environment hash.

**Acceptance Criteria:**

- [ ] `planApp` loads `ConfigService` global config when available; resolves inject via US-484 helpers.
- [ ] Only `resolution.base === "lando"` services receive security inject seeding; `l337` does not.
- [ ] Landofile `security.ca` entries resolve relative to app root; paths escaping the app root fail with remediation (same containment spirit as includes/load unless an existing allow-outside flag applies).
- [ ] Global + landofile PEMs are unioned with content-digest de-duplication (global first).
- [ ] When cas non-empty, planner may write a stable app-cache CA bundle file used for first-start mounts (path under app cache; content digest in name or sidecar).
- [ ] Feature config for `lando.security` is merged into the composed feature list for each lando-base service.
- [ ] `build-key.ts` excludes `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, and `NO_PROXY` from the environment portion of the artifact key.
- [ ] Changing CA PEM bytes changes the artifact build key via `buildKeyInputs.caDigests`; proxy env changes do not.
- [ ] Unreadable global CA fails the plan with actionable remediation.
- [ ] Planner/unit tests cover inject on, opt-out via `inheritNetworkCa: false`, and l337 skip.
- [ ] Tests pass
- [ ] Typecheck passes
- [ ] Lint passes

### US-487: Derived image build packs injected CAs

**Description:** As the container image builder, derived builds (`artifact.kind === "ref"` + build steps, or build + steps) pack injected CA files into the build context and install them into the image trust store so tools that only consult the OS store succeed after rebuild.

**Acceptance Criteria:**

- [ ] `container-runtime` derived-build path accepts CA file descriptors from the service-features extension (host path + digest + archive name) set by `lando.security`.
- [ ] Packed context includes CA files and a Dockerfile that `COPY`s them and runs a multi-distro trust-store update (Debian/Ubuntu `update-ca-certificates`, RHEL-family `update-ca-trust` when present, Alpine `update-ca-certificates`), and writes `/etc/lando/certs/ca-bundle.pem`.
- [ ] Host file missing or digest mismatch fails with `ProviderInternalError` before `/build` succeeds.
- [ ] Existing image-build tests remain green; new tests assert tar entries and failure modes (fake HTTP API pattern already used in `image-build.test.ts`).
- [ ] Tests pass
- [ ] Typecheck passes
- [ ] Lint passes

### US-488: Setup messaging and verification gates

**Description:** As a user running `lando setup`, I am told when configured CAs will inject into services; as a maintainer, the cross-package gates for this wave stay green.

**Acceptance Criteria:**

- [ ] When setup resolves non-empty `network.ca` certs and CA inject is not disabled, setup output/report includes an informational note that those CAs inject into `type: lando` services (does not fail setup).
- [ ] Focused tests updated under `core/test/cli/setup*.test.ts` (or adjacent) for the note.
- [ ] Story-level path filters green: sdk network-trust + backward-compat; core build-key, app-planner inject cases, setup; service-lando security feature; container-runtime image-build.
- [ ] `bun run typecheck` and `bun run lint` pass for the change set.
- [ ] No global-Dockerfile feature, no mkcert scope creep in the diff.
- [ ] Tests pass
- [ ] Typecheck passes
- [ ] Lint passes

## Functional Requirements

- **FR-1** Effective CA inject defaults to on for lando-base services; proxy inject defaults to off.
- **FR-2** Per-service `security.inheritNetworkCa` / `security.inheritNetworkProxy` override global inject flags when set.
- **FR-3** Resolved CA set = ordered union of global PEMs (if CA inject) then Landofile `security.ca`, de-duplicated by content digest.
- **FR-4** Install mechanism is feature intent (mounts + env + artifact build step), not host Dockerfile directories.
- **FR-5** Artifact build keys include sorted CA content digests; exclude proxy environment variables from the environment hash.
- **FR-6** Proxy credentials remain secrets: redacted from logs/telemetry; not written cleartext into build transcripts.
- **FR-7** `l337` and non-security stacks never auto-inject.
- **FR-8** Setup classifies TLS interception as today and additionally notes service inject when certs are configured.

## Non-Goals

See index. Explicitly: no `~/.lando/web-build`-style surfaces; no CertificateAuthority leaf work in this PRD.

## Technical Considerations

- **Planner seeds feature config** — `ServiceFeatureContext` stays free of `ConfigService`; matches existing composition purity.
- **ConfigService is live** at `core/src/services/config.ts` (`loadGlobalConfigSync`); do not treat `core/src/config/service.ts` stub comment as truth.
- **Derived build today packs only Dockerfile** — US-487 extends packing; PEMs must not be embedded only as giant `RUN echo` lines.
- **App-cache bundle** — optional first-start path so env vars resolve before the first rebuild; must not write secrets into the project working tree (use app cache dir via PathsService).
- **Multi-distro install script** — follow fail-soft patterns (`command -v` / `|| true` only where a secondary path is valid); primary path must fail the build step if no installer succeeds and cas were non-empty.
- **setCerts / CertificatePlan** — leaf TLS for routes; do not overload for corporate CA PEMs.

## Success Metrics

- A developer with only global `network.ca.certs` set gets working Composer/npm HTTPS inside a stock lando-base service after plan + rebuild, with no Landofile CA entries.
- Opt-out and proxy opt-in behave as specified in unit tests.
- Zero regressions in existing image-build and network-trust suites.

## Guide Coverage

- Prefer a short addition to any existing corporate-network / setup guide if one exists; otherwise doctor/setup messaging in US-488 is sufficient for this wave.
- No new executable guide required unless a guide already documents `network.ca` and would drift.

## Open Questions

None — locked by §6.8 / §10.3.1 and the approved work plan.
