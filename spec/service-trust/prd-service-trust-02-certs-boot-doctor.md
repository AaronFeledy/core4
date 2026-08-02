# PRD: SERVICE-TRUST-02 — Leaf certs, boot, language trust, doctor, Traefik TLS

## Introduction

PRD-01 closes corporate CA/proxy **inject** into services. This PRD completes the rest of the §6.8–§6.9 / §10.3 trust surface users hit day-to-day:

1. **Leaf TLS** — `certs: true|false|custom` + `@lando/ca-mkcert` Live + `lando.certs` feature.
2. **Boot scaffolding** — `lando.boot` emits the provider-neutral `/etc/lando/*` directory-scaffold intent that `lando.env`, `lando.certs`, and `lando.security` write into (US-493); a privileged artifact-step realizes that scaffold inside the built artifact for root and non-root parent artifacts and restores the parent's inherited effective user afterward (US-501).
3. **Language CA env** — Python/Ruby/etc. beyond Node/OpenSSL defaults when corporate CAs inject.
4. **Doctor** — certs + network-trust diagnostics with remediation.
5. **Traefik edge TLS** — global proxy presents CA-issued certs for HTTPS routes (today: bare `tls: {}`).
6. **Guides** — every user-facing path has executable-guide coverage and guide gates pass.

**SSH note:** `SshService` / `lando.ssh-agent` forward SSH agent sockets. They do **not** consume `CertificateAuthority` leaf TLS certs. Out of scope for this PRD.

Execution order is defined by `priority` in [`prd.json`](./prd.json); US-500 follows US-492, US-501 follows US-493, and US-496 closes the guide pack and therefore runs last.

## Source References

- [`spec/06-services.md`](../06-services.md) §6.8 `certs:`, feature priorities `lando.boot` (100), `lando.certs` (1000), §6.9 env sourcing, §6.3 user-scoped artifact groups, §6.13.1 artifact/app build phases
- [`spec/11-subsystems.md`](../11-subsystems.md) §10.3 CertificateAuthority
- [`plugins/ca-mkcert/`](../../plugins/ca-mkcert/) — currently stub Live
- [`docs/guides/subsystems/certificates-mkcert.mdx`](../../docs/guides/subsystems/certificates-mkcert.mdx)
- [`docs/guides/subsystems/doctor-walkthrough.mdx`](../../docs/guides/subsystems/doctor-walkthrough.mdx)
- [`docs/guides/subsystems/proxy-traefik.mdx`](../../docs/guides/subsystems/proxy-traefik.mdx)
- `plugins/proxy-traefik/src/proxy.ts` — current `tls: {}` gap
- `plugins/service-lando/src/features/env.ts` — existing `lando.env` feature (US-493 scope boundary)
- `sdk/src/services/platform.ts` — `CertificateAuthority` shape (`setup`, `issueCert`)
- PRD-01 corporate inject conventions for shared bundle paths (`/etc/lando/certs/ca-bundle.pem`)

## Goals

- After `lando setup`, `certs: true` yields working leaf certs and `LANDO_SERVICE_CERT`/`KEY` in lando-base services.
- `lando.boot` provides the provider-neutral `/etc/lando` directory-scaffold intent used by the `lando.env`, `lando.certs`, and `lando.security` features.
- A privileged artifact-step realizes that scaffold inside the built artifact for root and non-root parent artifacts and restores the parent's inherited effective user (US-501).
- Language runtimes get appropriate CA env when corporate CAs inject.
- Doctor surfaces CA plugin and network-trust config problems.
- Guides cover leaf certs, boot contract, language env table, and doctor checks; gates green.

## User Stories

### US-490: ServiceConfig.certs authoring surface

**Description:** As a Landofile author, I can set `certs: true|false`, a cert path, or `{ cert, key }` and have it decode into canonical service config distinct from `security.ca`.

**Acceptance Criteria:**

- [ ] `ServiceConfig` accepts the §6.8 `certs` shapes; invalid shapes fail with remediation.
- [ ] `certs` is not confused with `security.ca` under dual presence tests.
- [ ] Schema snapshot + `sdk/API_COMPATIBILITY.md` updated.
- [ ] Unit decode tests cover true/false/path/object.
- [ ] **Guide:** `docs/guides/subsystems/certificates-mkcert.mdx` documents each `certs:` shape with Landofile examples (`render={false}` OK).
- [ ] `bun run lint:guides` and `bun run check:guide-coverage` include the updated guide.
- [ ] Tests pass
- [ ] Typecheck passes
- [ ] Lint passes

### US-491: @lando/ca-mkcert Live implementation

**Description:** As a user running `lando setup`, mkcert is downloaded (via network-trust-aware Downloader), the local CA is installed (PrivilegeService-aware), and `issueCert` produces cert/key/ca paths. Opt-out via setup `--ca=none` / `skipTrustInstall` remains.

**Acceptance Criteria:**

- [ ] Live Layer replaces fail-stub for setup + issueCert when binary available; clear remediation when not.
- [ ] Binary fetch uses Downloader/HttpClient (honors `network.ca`/`network.proxy`).
- [ ] Host trust-store install is PrivilegeService-aware; skip paths tested.
- [ ] Unit tests with fake downloader/fs/privilege; contract suite still passes TestCertificateAuthority.
- [ ] **Guide:** certificates-mkcert setup / opt-out / programmatic skip scenarios stay accurate and gated.
- [ ] Guide gates green for touched MDX.
- [ ] Tests pass
- [ ] Typecheck passes
- [ ] Lint passes

### US-492: lando.certs feature + planner leaf issuance

**Description:** As a user with `certs: true`, the planner issues a leaf cert (SANs per §6.8) and `lando.certs` (priority 1000) mounts cert/key and sets `LANDO_SERVICE_CERT` / `LANDO_SERVICE_KEY`.

**Acceptance Criteria:**

- [ ] `lando.certs` registered on lando base default feature ids at priority 1000.
- [ ] `certs: true` → CA.issueCert with SANs: service name, `<service>.<app>.internal`, hostnames, route hosts, localhost, 127.0.0.1.
- [ ] Custom cert/key paths validated and mounted; `certs: false` no-op.
- [ ] Composition tests inject a fake CA through AppPlanner's `CertificateAuthorityResolver` seam; l337 does not get `lando.certs` by default. US-500 owns plugin contribution publication, §4.3 selection across CLI and embedding/discovery sources, bundled mkcert shipping, and bootstrap integration.
- [ ] **Guide:** certificates-mkcert documents service env vars and SAN coverage; links from nginx/php TLS mentions if those guides claim certs.
- [ ] Guide gates green for touched guides.
- [ ] Tests pass
- [ ] Typecheck passes
- [ ] Lint passes

### US-500: Active CertificateAuthority plugin selection and runtime integration

**Description:** As a CLI user or embedding host, certificate issuance uses the active `CertificateAuthority` selected from the complete plugin contribution graph, with bundled mkcert available by default in the CLI.

**Acceptance Criteria:**

- [ ] Publish a typed `LandoPluginModule` certificate-authority contribution matching `provides.certificateAuthorities`, index it with manifest/module id validation, and record any additive SDK surface in `sdk/API_COMPATIBILITY.md`.
- [ ] CLI and library runtimes treat embedding layers, pre-resolved manifests, and bundled/system/user/app discovery contributions as one eligible `CertificateAuthority` graph, honoring discovery policy and disable entries per §16.4; selection must not inspect bundled modules alone.
- [ ] Selection follows §4.3 across every applicable precedence tier. Multiple or absent unresolved implementations fail with a tagged error that preserves candidate context and actionable remediation, never `Layer.die` with a generic `Error`.
- [ ] `@lando/ca-mkcert` is present in the generated bundled ship list and bootstrap, with its pinned runtime manifest available, and is selected for the default CLI path when no higher-precedence authority replaces it.
- [ ] Production-path tests prove `certs: true` can issue through the selected bundled authority after setup, an explicitly disabled bundled mkcert is not used, an embedding-host authority remains usable, a discovered non-bundled authority can win by §4.3 precedence, and ambiguous multiple authorities produce the tagged selection failure.
- [ ] Schema/generated bootstrap artifacts and packaged-plugin fixtures are refreshed from their generators where the contribution surface requires them.
- [ ] **Guide:** certificates-mkcert documents the bundled CLI default, replacement/selection behavior, and remediation when no authority is selected.
- [ ] Guide gates green for touched MDX.
- [ ] Tests pass
- [ ] Typecheck passes
- [ ] Lint passes

### US-493: lando.boot scaffolding feature

**Description:** As a user of `type: lando` services, `lando.boot` (priority 100) emits the provider-neutral `/etc/lando/*` scaffold intent so the higher-priority features that write into it share a stable layout.

**Scope boundary (normative).** The §6.11 built-in feature table splits these responsibilities and this story must not merge them:

| Feature | Priority | Owns |
|---|---|---|
| `lando.boot` | 100 | `/etc/lando/*` **scaffolding** (the directory layout) |
| `lando.env` | 700 | `/etc/lando/environment` **content** + `env.d/`, the §6.9 per-exec sourcing, and the `LANDO_LINUX_*` distro exports |

`lando.env` already ships (`plugins/service-lando/src/features/env.ts`). US-493 declares directory scaffold intent only; it must not author `/etc/lando/environment`, add `env.d/*.sh` sourcing, or emit distro-detection exports — those are `lando.env`'s and are out of scope for this story. `lando.boot` (US-493) owns the provider-neutral scaffold intent; privileged realization for root and non-root parent artifacts and restoration of the inherited effective user is owned by `US-501`, not by this story.

**Acceptance Criteria:**

- [ ] `lando.boot` on `LANDO_BASE_DEFAULT_FEATURE_IDS`; priority 100.
- [ ] US-493 owns the provider-neutral plan seam: `lando.boot` emits one **ARTIFACT-PHASE** scaffold intent, not mounts (spec 6.13.1), whose idempotent command is `mkdir -p /etc/lando /etc/lando/env.d /etc/lando/certs`. Composition and compiled-plan proof of that exact intent satisfy this story. US-501 owns privileged realization when a parent artifact inherits a non-root effective user and restoration of that inherited user afterward.
- [ ] Does **not** write `/etc/lando/environment`, add `env.d/*.sh` sourcing, or export `LANDO_LINUX_*` — spec 6.11 assigns those to `lando.env` (priority 700), which already ships; a test asserts `lando.env` stays their only producer. Composition test asserts boot(100) → env(700) → certs(1000) → security(1100) order and that `/etc/lando/certs/ca-bundle.pem` from PRD-01 is not shadowed or clobbered.
- [ ] l337 does not include boot.
- [ ] **Guide:** `docs/guides/services/lando-boot-scaffold.mdx` documents the boot contract and the `lando.boot` / `lando.env` ownership split (the primary guide, per this PRD's Guide Coverage table); link to it from corporate-network-trust and certificates-mkcert. Scenario `render={false}` OK if unit-backed. Its `docs/guides/INDEX.md` row flips `Planned` → `Shipped` in this story.
- [ ] Executable guide coverage updated for this user-facing behavior (`render={false}` OK if unit-backed).
- [ ] `bun run lint:guides` and `bun run check:guide-coverage` pass for touched guides (final pack may complete in US-496).
- [ ] Tests pass
- [ ] Typecheck passes
- [ ] Lint passes

### US-501: Artifact-step privilege and inherited-user preservation

**Description:** As the artifact builder, I can run `lando.boot`'s system scaffold with sufficient privilege without changing the parent artifact's inherited effective user for later steps or runtime.

**Acceptance Criteria:**

- [ ] Define a provider-neutral artifact-step privilege/effective-user contract sufficient for system-owned feature steps such as `lando.boot`; the feature must not embed provider-specific user-switch syntax.
- [ ] `lando.boot` creates `/etc/lando`, `/etc/lando/env.d`, and `/etc/lando/certs` inside the built artifact for supported `type: lando` parent artifacts whose inherited effective user is either root or non-root.
- [ ] A temporary privileged scaffold step restores the parent artifact's exact inherited effective user before later artifact groups and in the final artifact; it must not leave a non-root image running as root or override an explicitly authored final user.
- [ ] Production-path artifact rendering/build tests cover root and non-root inherited-user parents, directory creation, exact user restoration, repeated planning/build-key stability, and later user-group ordering.
- [ ] The existing l337 exclusion, `lando.env` ownership boundary, and `lando.security` CA-bundle path remain unchanged.
- [ ] **Guide:** `docs/guides/services/lando-boot-scaffold.mdx` documents the non-root parent-image guarantee and effective-user preservation.
- [ ] Executable guide coverage updated for this user-facing behavior (`render={false}` OK if production-path artifact tests carry the privileged-build proof).
- [ ] `bun run lint:guides` and `bun run check:guide-coverage` pass for the touched guide.
- [ ] Tests pass
- [ ] Typecheck passes
- [ ] Lint passes

### US-494: Language-runtime CA environment equivalents

**Description:** As a user of language runtimes behind corporate TLS, services set the right process env when corporate CAs inject (beyond Node/OpenSSL defaults).

**Acceptance Criteria:**

- [ ] When injected CA material is present, touched language features set: Python `REQUESTS_CA_BUNDLE` (and `SSL_CERT_FILE` if unset); Ruby relies on OpenSSL env already set by security; Go relies on trust-store install; Node via `NODE_EXTRA_CA_CERTS`; PHP via OpenSSL env. Only modify service types that exist in `plugins/service-lando`.
- [ ] Unit tests per modified language feature.
- [ ] **Guide:** corporate-network-trust includes a runtime env compatibility table; language guides (node/php/python/ruby/go) get a one-line link if they discuss HTTPS clients.
- [ ] Guide gates green for all touched guides.
- [ ] Tests pass
- [ ] Typecheck passes
- [ ] Lint passes

### US-495: Doctor CA and network-trust diagnostics

**Description:** As a user running `lando doctor`, I see certs plugin status and network-trust/CA config problems with remediation (unreadable cert paths, CA unavailable, inject disabled while certs configured as info).

**Acceptance Criteria:**

- [ ] Doctor certs check reflects CA plugin availability/remediation (`lando setup`).
- [ ] Network-trust or setup-readiness check covers unreadable `network.ca.certs` and useful inject status context without leaking secrets.
- [ ] Unit/scenario tests for degraded paths; redaction verified.
- [ ] **Guide:** `docs/guides/subsystems/doctor-walkthrough.mdx` and `docs/guides/global/doctor-walkthrough.mdx` (if both maintained) document new/updated check names, order, and remediation strings.
- [ ] Guide gates green.
- [ ] Tests pass
- [ ] Typecheck passes
- [ ] Lint passes

### US-496: Guide coverage pack and drift gates

**Description:** As a docs consumer, every user-facing behavior in PRD-01 and PRD-02 is covered by executable guides and the guide coverage/drift gates pass.

**Acceptance Criteria:**

- [ ] `docs/guides/config/corporate-network-trust.mdx` exists and covers: global `network.ca`/`proxy`, inject flags + env vars, Landofile `security.*`, rebuild, runtime env table, links to setup/doctor/certs guides.
- [ ] `certificates-mkcert.mdx` covers leaf certs user path end-to-end at contract level.
- [ ] Boot + doctor + language + **proxy HTTPS** links as required by US-493..495, US-497..498, and US-501.
- [ ] `docs/guides/INDEX.md` carries a row for **every** guide path declared in the `## Guide Coverage` table of PRD-01 and PRD-02, and no service-trust row is left at `Status: Planned` — every one reads `Shipped` and resolves to a file on disk. This is the criterion that gives the per-story `check:guide-coverage` ACs teeth: `Planned` rows are deliberately exempt from the on-disk existence check, so the gate only proves the guides exist once the rows are flipped.
- [ ] `bun run lint:guides` passes.
- [ ] `bun run check:guide-coverage` passes **with `spec/service-trust/` in its scanned spec directories**, so a declared-but-unindexed guide fails the gate (`coverage.missing-index-row`) and a user-facing service-trust PRD with an empty `## Guide Coverage` section fails it (`coverage.empty-user-facing-section`).
- [ ] `bun run check:guide-drift` passes.
- [ ] `bun run check:public-transcripts` passes if transcripts changed.
- [ ] Tests pass
- [ ] Typecheck passes
- [ ] Lint passes


### US-497: Traefik edge TLS certificates from CertificateAuthority

**Description:** As a user opening `https://*.lndo.site` routes, Traefik terminates TLS with certificates issued by the active CertificateAuthority (mkcert), not an empty `tls: {}` block.

**Acceptance Criteria:**

- [ ] Proxy setup and/or first HTTPS `applyRoutes` ensures a default proxy cert exists via `CertificateAuthority.issueCert` (the only issuance method on the shape in `sdk/src/services/platform.ts`; no new SDK surface is added by this story) covering default domain wildcards (e.g. `*.lndo.site`, apex, `traefik.lndo.site`) and is refreshed when new HTTPS route hostnames need SANs (re-issue or additional certs — choose one approach, document, test).
- [ ] Cert/key files live under a Lando-managed path and are bind-mounted into the Traefik global service.
- [ ] Dynamic and/or static Traefik config references those files (`tls.certificates` and/or default certificate); rendered config tests **fail** if they only contain bare `tls: {}` with no cert paths.
- [ ] Unit tests with fake CA + filesystem; existing Traefik proxy contract tests updated.
- [ ] Depends on US-491 (CA Live). Coordinates with US-492 (service leaf certs remain separate from proxy edge cert).
- [ ] **Guide:** `docs/guides/subsystems/proxy-traefik.mdx` documents HTTPS cert dependency on `lando setup` / mkcert; links to certificates-mkcert.
- [ ] `bun run lint:guides` and `bun run check:guide-coverage` for touched guides.
- [ ] Tests pass
- [ ] Typecheck passes
- [ ] Lint passes

### US-498: Doctor proxy TLS readiness + proxy HTTPS guide pack

**Description:** As a user running doctor or reading docs, missing proxy TLS material is visible with remediation, and the proxy HTTPS guide is complete.

**Acceptance Criteria:**

- [ ] Doctor proxy (or dedicated) check warns/degrades when HTTPS routing is expected but proxy cert files are missing; remediation cites `lando setup` / CA plugin.
- [ ] Unit/scenario test for the degraded path; no secret leakage.
- [ ] Guide pack: proxy-traefik HTTPS section complete; cross-links from certificates-mkcert and corporate-network-trust (browser trust = host CA install).
- [ ] Guide gates green (`lint:guides`, `check:guide-coverage`, `check:guide-drift` as applicable).
- [ ] Explicitly documents that SSH agent forwarding is unrelated to this TLS path.
- [ ] Tests pass
- [ ] Typecheck passes
- [ ] Lint passes

## Functional Requirements

- **FR-1** `certs: true` issues leaf certs via active CertificateAuthority with §6.8 SANs.
- **FR-2** mkcert Live downloads and installs with network-trust-aware egress and privilege-aware trust-store install.
- **FR-3** `lando.boot` emits the provider-neutral `/etc/lando` directory-scaffold intent for lando-base services only, as one artifact-phase build step; `/etc/lando/environment` and `env.d/` content remain owned by `lando.env` (§6.11 feature table).
- **FR-4** Language features export additional CA env when corporate inject is active.
- **FR-5** Doctor reports CA and network-trust problems with remediation.
- **FR-6** Every user-facing FR has guide coverage and guide gates pass.
- **FR-7** Traefik HTTPS termination uses CA-issued cert files mounted into the global Traefik service.
- **FR-8** SSH agent is out of scope (not a CertificateAuthority consumer).
- **FR-9** A privileged artifact-step realizes the `lando.boot` scaffold inside the built artifact for root and non-root parent artifacts, and restores the parent artifact's exact inherited effective user before later artifact groups and in the final artifact.

## Non-Goals

- Global Dockerfile directories.
- ACME/Let's Encrypt public CA for local proxy (dev mkcert only).
- Full `lando.ssh-agent` / SshService Live implementation (agent sockets ≠ TLS certs).
- Full Java service type if none exists in tree.

## Technical Considerations

- Feature priority order: boot (100) → … → env (700) → certs (1000) → security (1100).
- Reuse PRD-01 bundle path `/etc/lando/certs/ca-bundle.pem` where possible.
- ca-mkcert must not bypass HttpClient/Downloader for binary fetch.
- Guide scenarios stay host-safe (`render={false}`) when live mkcert/network is required; unit tests carry the proof.

## Guide Coverage

Every path below is a concrete guide file so `bun run check:guide-coverage` can resolve it against `docs/guides/INDEX.md`. `docs/guides/services/lando-boot-scaffold.mdx` is new in this wave and is registered as `Planned` until US-493 lands it; `docs/guides/config/corporate-network-trust.mdx` is created by PRD-01 US-488. The rest already exist.

**Guides owned by this PRD:**

| User Story | Feature | Guide Path | Acceptance |
|---|---|---|---|
| US-490 | `certs:` authoring shapes | `docs/guides/subsystems/certificates-mkcert.mdx` | Required at story acceptance |
| US-491 | mkcert Live setup / opt-out | `docs/guides/subsystems/certificates-mkcert.mdx` | Required at story acceptance |
| US-492 | `lando.certs` service env and SAN coverage | `docs/guides/subsystems/certificates-mkcert.mdx` | Required at story acceptance |
| US-500 | active CA selection and bundled runtime integration | `docs/guides/subsystems/certificates-mkcert.mdx` | Required at story acceptance |
| US-493 | `lando.boot` `/etc/lando` scaffold contract | `docs/guides/services/lando-boot-scaffold.mdx` | Required at story acceptance |
| US-501 | artifact-step privilege + inherited-user restoration | `docs/guides/services/lando-boot-scaffold.mdx` | Required at story acceptance |
| US-494 | language-runtime CA env table | `docs/guides/config/corporate-network-trust.mdx` | Required at story acceptance |
| US-495 | doctor certs + network-trust checks | `docs/guides/subsystems/doctor-walkthrough.mdx` | Required at story acceptance |
| US-495 | global-app doctor certs surface | `docs/guides/global/doctor-walkthrough.mdx` | Required at story acceptance |
| US-497 | Traefik HTTPS certs from the CA | `docs/guides/subsystems/proxy-traefik.mdx` | Required at story acceptance |
| US-498 | doctor proxy TLS readiness | `docs/guides/subsystems/doctor-walkthrough.mdx` | Required at story acceptance |
| US-496 | guide pack closure across every path above | `docs/guides/config/corporate-network-trust.mdx` | Required at story acceptance |

## Success Metrics

- `certs: true` + setup path works in tests with fakes; guide describes real user steps.
- Boot + certs + security compose without mount path collisions in tests.
- Doctor degraded paths are documented and tested.
- Guide coverage/drift gates green on the change set.

## Open Questions

None.
