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

Leaf certs, `lando.boot`, language CA env, doctor, and Traefik edge TLS live in [PRD-02](./prd-service-trust-02-certs-boot-doctor.md) (US-490..US-498).

**Guide rule:** every user-facing story below includes executable-guide acceptance criteria naming `docs/guides/config/corporate-network-trust.mdx` (new), plus links from setup/doctor guides. `render={false}` is OK when backed by unit tests. The authoritative list is the [Guide Coverage](#guide-coverage) table at the end of this PRD, which `bun run check:guide-coverage` reads.

### Spec reconciliation — "boot scaffolding" and the artifact phase

§6.8.4 says the `lando.security` feature materializes "mounts + trust-store registration **through boot scaffolding**", and §6.8.5 places trust-store install "in boot scaffolding" before any `build.app:` / tooling / exec. That is **not** a runtime-only mechanism: §6.13.1 states that "the `lando.boot` scaffolding lives inside the built artifact". Boot scaffolding is therefore the artifact-baked `/etc/lando` layer, which is why §6.8.5 additionally requires the resolved CA digest to participate in the artifact `buildKey` (§6.13.5). The split this PRD implements is consequently spec-conformant:

- **Artifact phase** — the trust-store install and the concatenated bundle at `/etc/lando/certs/ca-bundle.pem` are baked into the derived image (US-487), and their digests key the artifact (US-486).
- **Plan/runtime** — host PEMs are additionally bind-mounted at a CA-distro-appropriate path and the `LANDO_CA_*` / OpenSSL / Node env vars are set (US-485), so a service is usable before its first rebuild.

`/etc/lando/*` is owned by the `lando.boot` feature (priority 100), which lands in PRD-02 US-493. Until it does, PRD-01 creates only the single directory it writes (`/etc/lando/certs/`) as part of its own artifact build step, and the `LANDO_CA_BUNDLE` path contract does not change when `lando.boot` takes ownership.

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

**Description:** As a Landofile author, I can declare `security.ca`, `security.inheritNetworkCa`, and `security.inheritNetworkProxy` on a service so project CAs and per-service inject overrides decode into the canonical service config. Authoring aliases from §6.8 canonicalize to `ca`.

**Acceptance Criteria:**

- [ ] `ServiceConfig` / `ServiceConfigInput` accept optional `security: { ca?: string[], inheritNetworkCa?: boolean, inheritNetworkProxy?: boolean }`.
- [ ] Authoring aliases `cas`, `certificate-authority`, and `certificate-authorities` (scalar or array) canonicalize to `ca: string[]`.
- [ ] Omitted `security` decodes unchanged (backward compatible).
- [ ] Excess properties under `security` fail closed under the Landofile decode options used in production.
- [ ] `certs:` (leaf TLS) is not treated as an alias of `security.ca`.
- [ ] Public JSON Schema inventory and `bun run codegen:schema-snapshot` refreshed; generated docs list the new fields.
- [ ] `sdk/API_COMPATIBILITY.md` records the additive fields.
- [ ] Unit decode tests cover present/absent/override booleans and aliases.
- [ ] **Guide:** `docs/guides/config/corporate-network-trust.mdx` documents Landofile `security.ca` / aliases / inherit flags (scenario may be `render={false}`).
- [ ] `bun run lint:guides` and `bun run check:guide-coverage` pass for touched guides (final green may land with US-488/US-496 guide pack if draft is stubbed here).
- [ ] Tests pass
- [ ] Typecheck passes
- [ ] Lint passes

### US-484: Shared CA PEM load and service inject resolution

**Description:** As core, one helper loads CA PEMs from paths and one resolver computes effective inject flags and path lists so setup, HttpClient, and the planner do not fork PEM-read logic.

**Acceptance Criteria:**

- [ ] A shared core helper (e.g. `core/src/network/load-ca-pems.ts`) loads PEM files and returns `{ path, pem, digest }` with stable sha256 digests of UTF-8 bytes.
- [ ] `HttpClientLive` and setup network trust consume the shared loader (no duplicated `readFile` CA paths with divergent errors).
- [ ] `resolveServiceNetworkInject({ network, env, security })` returns `injectCa`, `injectProxy`, global `caPaths` (from `resolveNetworkTrustPlan` when injectCa), `landofileCaPaths` (from `security.ca` only), and resolved `proxy`.
- [ ] Defaults: `injectCa = security.inheritNetworkCa ?? network.ca?.injectIntoServices ?? true`; `injectProxy = security.inheritNetworkProxy ?? network.proxy?.injectIntoServices ?? false`. The optional chain on the **parent** is required: `NetworkConfig.ca` / `.proxy` are `Schema.optional` (`sdk/src/schema/config.ts`), so a config with no `network.ca:` block leaves the parent `undefined`; `injectIntoServices` itself is `Schema.optionalWith(..., { default })` and is always present once the parent decodes.
- [ ] Unit test covers a decoded global config with **no** `network.ca` / `network.proxy` block and asserts the documented defaults (`injectCa: true`, `injectProxy: false`) rather than throwing.
- [ ] Unreadable path fails with a tagged error naming the path and remediation pointing at `network.ca.certs` / `LANDO_NETWORK_CA_CERTS` / Landofile `security.ca`.
- [ ] Pure `@lando/sdk/network-trust` remains file-IO-free.
- [ ] Unit tests cover defaults, overrides, empty cert lists, and missing files.
- [ ] **Guide:** corporate-network-trust documents global cert path resolution and failure remediation (unit-backed).
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
- [ ] Non-empty cas → bind-mount each host PEM at the **CA-distro-appropriate path** per §6.8 (e.g. `/usr/local/share/ca-certificates/` on Debian-family), never under `/etc/lando/certs/`; set `NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`, `SSL_CERT_DIR` when applicable, `LANDO_CA_BUNDLE`, `LANDO_CA_DIR`, `LANDO_CA_CERT` per §6.8/§6.9.
- [ ] **Single bundle contract.** `LANDO_CA_BUNDLE` is always `/etc/lando/certs/ca-bundle.pem` and `LANDO_CA_DIR` is always `/etc/lando/certs`, for every service and both before and after the first rebuild. The three CA materializations have a fixed precedence and non-overlapping targets, so none can shadow another: (1) per-PEM bind mounts land at the distro trust-store input path, (2) the optional planner-written app-cache bundle (US-486) is a **host-side** file that is mounted **to** `/etc/lando/certs/ca-bundle.pem` only when the image has not yet been rebuilt with the baked bundle, and (3) the baked bundle (US-487) is written to that same in-container path by the artifact build. A test asserts the env var values are identical across the pre-rebuild and post-rebuild plans.
- [ ] `injectProxy: true` → set `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY` from payload when defined.
- [ ] Artifact `phase: "build"` step `lando.security:trust-store` with `buildKeyInputs.caDigests` (sorted digests).
- [ ] Feature does not import or yield `ConfigService` / `FileSystem`.
- [ ] Composition unit tests mirror `env-feature.test.ts` / php prerequisite patterns.
- [ ] Base-composition tests that enumerate default feature ids are updated.
- [ ] **Guide:** corporate-network-trust documents runtime env vars (`NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`, `SSL_CERT_DIR`, `LANDO_CA_*`) and rebuild expectation.
- [ ] Tests pass
- [ ] Typecheck passes
- [ ] Lint passes

### US-486: AppPlanner wires global inject into lando-base services

**Description:** As `AppPlanner`, each plan resolves global network trust once, loads PEMs, applies per-service security overrides, materializes Landofile `security.ca` paths and inline/`load`/`import` PEM bodies, seeds `lando.security` feature config, and keeps proxy URLs out of the artifact build-key environment hash.

**Acceptance Criteria:**

- [ ] `planApp` loads `ConfigService` global config when available; resolves inject via US-484 helpers (including US-489 env overlays).
- [ ] Only `resolution.base === "lando"` services receive security inject seeding; `l337` does not.
- [ ] Landofile `security.ca` path entries resolve relative to app root; paths escaping the app root fail with remediation (same containment spirit as includes/load unless an existing allow-outside flag applies).
- [ ] Inline PEM text and `load`/`import`-produced PEM bodies are accepted (digest from content; synthetic path labels for packing); non-PEM garbage fails with remediation.
- [ ] `inheritNetworkCa: false` suppresses global PEMs but still applies Landofile `security.ca`.
- [ ] Global + landofile PEMs are unioned with content-digest de-duplication (global first).
- [ ] When cas non-empty, the planner writes a stable app-cache CA bundle file (path under the app cache via `PathsService`; content digest in the name or a sidecar) and mounts it at `/etc/lando/certs/ca-bundle.pem` so `LANDO_CA_BUNDLE` resolves before the first rebuild. Once the artifact carries the baked bundle (US-487) the mount is dropped, and the in-container path is unchanged either way.
- [ ] Feature config for `lando.security` is merged into the composed feature list for each lando-base service.
- [ ] `build-key.ts` excludes `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, and `NO_PROXY` from the environment portion of the artifact key, **matched case-insensitively** so the conventional lowercase spellings (`http_proxy`, `https_proxy`, `all_proxy`, `no_proxy`) are excluded too. The rest of the codebase already treats both casings as first-class (`firstEnv` in `sdk/src/network-trust/index.ts`, `core/src/subsystems/host-proxy/proxy-bypass.ts`); a case-sensitive list would let a Linux/macOS user's lowercase `http_proxy` bust artifact keys on every proxy change, which is exactly what FR-5 forbids.
- [ ] Build-key unit test asserts that flipping `http_proxy` (lowercase) leaves the artifact key unchanged, alongside the uppercase case.
- [ ] Changing CA PEM bytes changes the artifact build key via `buildKeyInputs.caDigests`; proxy env changes do not.
- [ ] Unreadable global CA fails the plan with actionable remediation.
- [ ] Planner/unit tests cover inject on, opt-out via `inheritNetworkCa: false`, inline PEM, and l337 skip.
- [ ] **Guide:** corporate-network-trust documents set-and-forget global config + per-service opt-out + setup note.
- [ ] Tests pass
- [ ] Typecheck passes
- [ ] Lint passes

### US-487: Derived image build packs injected CAs

**Description:** As the container image builder, derived builds (`artifact.kind === "ref"` + build steps, or build + steps) pack injected CA files into the build context and install them into the image trust store so tools that only consult the OS store succeed after rebuild.

**Acceptance Criteria:**

- [ ] `container-runtime` derived-build path accepts CA file descriptors from the service-features extension (host path + digest + archive name) set by `lando.security`.
- [ ] Packed context includes CA files and a Dockerfile that `COPY`s them and runs a multi-distro trust-store update (Debian/Ubuntu `update-ca-certificates`, RHEL-family `update-ca-trust` when present, Alpine `update-ca-certificates`), then `mkdir -p /etc/lando/certs` and writes `/etc/lando/certs/ca-bundle.pem`.
- [ ] The build step creates `/etc/lando/certs` itself (idempotent `mkdir -p`) rather than assuming `lando.boot` exists, and remains correct once `lando.boot` (PRD-02 US-493) takes ownership of `/etc/lando/*` — both are artifact build steps in the same image and `lando.boot` (priority 100) runs before `lando.security` (1100), so the directory is created at most twice and never shadowed.
- [ ] Host file missing or digest mismatch fails with `ProviderInternalError` before `/build` succeeds.
- [ ] Existing image-build tests remain green; new tests assert tar entries and failure modes (fake HTTP API pattern already used in `image-build.test.ts`).
- [ ] **Guide:** corporate-network-trust notes that CA changes require service image rebuild / `lando rebuild` when trust-store layers change.
- [ ] Tests pass
- [ ] Typecheck passes
- [ ] Lint passes

### US-488: Setup messaging and verification gates

**Description:** As a user running `lando setup`, I am told when configured CAs will inject into services; as a maintainer, the cross-package gates for this wave stay green.

**Acceptance Criteria:**

- [ ] When setup resolves non-empty `network.ca` certs and CA inject is not disabled, setup output/report includes an informational note that those CAs inject into `type: lando` services (does not fail setup).
- [ ] Focused tests updated under `core/test/cli/setup*.test.ts` (or adjacent) for the note.
- [ ] Story-level path filters green: sdk network-trust + backward-compat; paths overlay (US-489); core build-key, app-planner inject cases, setup; service-lando security feature; container-runtime image-build.
- [ ] `bun run typecheck` and `bun run lint` pass for the change set.
- [ ] No global-Dockerfile feature, and no mkcert / `lando.boot` feature / leaf-`certs:` scope creep in the diff. Creating the `/etc/lando/certs` directory from the US-487 build step is **in** scope and is not `lando.boot`; registering a `lando.boot` feature id or `/etc/lando/environment` / `env.d/` handling is **out** of scope here.
- [ ] `bun run check:guide-coverage` passes with `docs/guides/config/corporate-network-trust.mdx` present on disk and its `docs/guides/INDEX.md` rows flipped from `Planned` to `Shipped`.
- [ ] Tests pass
- [ ] Typecheck passes
- [ ] Lint passes

### US-489: Friendly env overrides for inject flags

**Description:** As an operator, I can set `LANDO_NETWORK_CA_INJECT_INTO_SERVICES` and `LANDO_NETWORK_PROXY_INJECT_INTO_SERVICES` per §7.6 without hand-writing `LANDO_CONFIG__network__…` paths, matching the notify env overlay pattern.

**Acceptance Criteria:**

- [ ] `paths/src/overlay.ts` maps `LANDO_NETWORK_CA_INJECT_INTO_SERVICES` → `network.ca.injectIntoServices` and `LANDO_NETWORK_PROXY_INJECT_INTO_SERVICES` → `network.proxy.injectIntoServices` (boolean parse consistent with other boolean overlays).
- [ ] `LANDO_NETWORK_CA_CERTS` remains owned by `resolveNetworkTrustPlan` (not duplicated in overlay).
- [ ] `loadGlobalConfigSync` / `ConfigService` decode reflects these overlays.
- [ ] Garbage non-boolean values fail closed or are rejected at GlobalConfig decode with remediation (chosen behavior tested).
- [ ] Unit tests under paths (or existing overlay test file) cover true/false/absent.
- [ ] **Guide:** corporate-network-trust documents `LANDO_NETWORK_CA_INJECT_INTO_SERVICES` and `LANDO_NETWORK_PROXY_INJECT_INTO_SERVICES`.
- [ ] Tests pass
- [ ] Typecheck passes
- [ ] Lint passes

## Functional Requirements

- **FR-1** Effective CA inject defaults to on for lando-base services; proxy inject defaults to off.
- **FR-2** Per-service `security.inheritNetworkCa` / `security.inheritNetworkProxy` override global inject flags when set.
- **FR-3** Resolved CA set = ordered union of global PEMs (if CA inject) then Landofile `security.ca` (paths + inline/`load`/`import` PEM bodies), de-duplicated by content digest.
- **FR-4** Install mechanism is feature intent (mounts + env + artifact build step), not host Dockerfile directories.
- **FR-5** Artifact build keys include sorted CA content digests; exclude proxy environment variables from the environment hash.
- **FR-6** Proxy credentials remain secrets: redacted from logs/telemetry; not written cleartext into build transcripts.
- **FR-7** `l337` and non-security stacks never auto-inject.
- **FR-8** Setup classifies TLS interception as today and additionally notes service inject when certs are configured.
- **FR-9** §7.6 `LANDO_NETWORK_CA_INJECT_INTO_SERVICES` / `LANDO_NETWORK_PROXY_INJECT_INTO_SERVICES` are honored via config overlay.
- **FR-10** Authoring aliases for `security.ca` decode to the canonical field.

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

Every user-facing story in this PRD carries executable-guide acceptance criteria. `docs/guides/config/corporate-network-trust.mdx` is new in this wave and is the primary guide for the whole inject path; it is registered in `docs/guides/INDEX.md` as `Planned` until US-488 lands it. Scenarios may be `render={false}` where live CA/proxy material is unsafe in CI, provided unit tests carry the same claims.

**Guides owned by this PRD:**

| User Story | Feature | Guide Path | Acceptance |
|---|---|---|---|
| US-483 | Landofile `security.ca` / aliases / inherit flags | `docs/guides/config/corporate-network-trust.mdx` | Required at story acceptance |
| US-484 | global cert path resolution and failure remediation | `docs/guides/config/corporate-network-trust.mdx` | Required at story acceptance |
| US-485 | runtime CA env vars (`NODE_EXTRA_CA_CERTS`, `SSL_CERT_*`, `LANDO_CA_*`) | `docs/guides/config/corporate-network-trust.mdx` | Required at story acceptance |
| US-486 | set-and-forget global config + per-service opt-out | `docs/guides/config/corporate-network-trust.mdx` | Required at story acceptance |
| US-487 | rebuild expectation when CA material changes | `docs/guides/config/corporate-network-trust.mdx` | Required at story acceptance |
| US-488 | setup inject note and inject-path guide completion | `docs/guides/config/corporate-network-trust.mdx` | Required at story acceptance |
| US-489 | `LANDO_NETWORK_*_INJECT_INTO_SERVICES` env overrides | `docs/guides/config/corporate-network-trust.mdx` | Required at story acceptance |

## Open Questions

None — locked by §6.8 / §10.3.1 and the spec-reconciliation note above.
