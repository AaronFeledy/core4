# PRD: SERVICE-TRUST-02 — Leaf certs, boot scaffolding, language trust, doctor

## Introduction

PRD-01 closes corporate CA/proxy **inject** into services. This PRD completes the rest of the §6.8–§6.9 / §10.3 trust surface users hit day-to-day:

1. **Leaf TLS** — `certs: true|false|custom` + `@lando/ca-mkcert` Live + `lando.certs` feature.
2. **Boot scaffolding** — `lando.boot` materializes `/etc/lando/*` so env and certs are available on exec.
3. **Language CA env** — Python/Ruby/etc. beyond Node/OpenSSL defaults when corporate CAs inject.
4. **Doctor** — certs + network-trust diagnostics with remediation.
5. **Guides** — every user-facing path has executable-guide coverage and guide gates pass.

Tracking plan: `.omo/plans/host-global-ca-proxy-inject.md` (todos 8–14).

## Source References

- [`spec/06-services.md`](../06-services.md) §6.8 `certs:`, feature priorities `lando.boot` (100), `lando.certs` (1000), §6.9 env sourcing
- [`spec/11-subsystems.md`](../11-subsystems.md) §10.3 CertificateAuthority
- [`plugins/ca-mkcert/`](../../plugins/ca-mkcert/) — currently stub Live
- [`docs/guides/subsystems/certificates-mkcert.mdx`](../../docs/guides/subsystems/certificates-mkcert.mdx)
- [`docs/guides/subsystems/doctor-walkthrough.mdx`](../../docs/guides/subsystems/doctor-walkthrough.mdx)
- PRD-01 corporate inject conventions for shared bundle paths

## Goals

- After `lando setup`, `certs: true` yields working leaf certs and `LANDO_SERVICE_CERT`/`KEY` in lando-base services.
- `lando.boot` provides `/etc/lando` scaffold used by env, certs, and security features.
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
- [ ] Composition tests with fake CA; l337 does not get lando.certs by default.
- [ ] **Guide:** certificates-mkcert documents service env vars and SAN coverage; links from nginx/php TLS mentions if those guides claim certs.
- [ ] Guide gates green for touched guides.
- [ ] Tests pass
- [ ] Typecheck passes
- [ ] Lint passes

### US-493: lando.boot scaffolding feature

**Description:** As a user of `type: lando` services, `lando.boot` (priority 100) materializes `/etc/lando/environment`, `env.d/`, and `certs/` so later features and exec surfaces share a stable layout (spec §6.9).

**Acceptance Criteria:**

- [ ] `lando.boot` on `LANDO_BASE_DEFAULT_FEATURE_IDS`; priority 100.
- [ ] Plan includes mounts and/or build steps that create the scaffold paths.
- [ ] Compatible with `lando.env`, `lando.certs`, and `lando.security` dropping files into those paths (integration composition test).
- [ ] l337 does not include boot.
- [ ] **Guide:** document boot contract in `docs/guides/services/lando-boot-scaffold.mdx` **or** a dedicated section of corporate-network-trust + certificates-mkcert (choose one primary guide; link from the other). Scenario `render={false}` OK if unit-backed.
- [ ] Guide gates green.
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
- [ ] Boot + doctor + language links as required by US-493..495.
- [ ] `docs/guides/INDEX.md` (or repo index convention) lists new guides if required.
- [ ] `bun run lint:guides` passes.
- [ ] `bun run check:guide-coverage` passes.
- [ ] `bun run check:guide-drift` passes.
- [ ] `bun run check:public-transcripts` passes if transcripts changed.
- [ ] Tests pass
- [ ] Typecheck passes
- [ ] Lint passes

## Functional Requirements

- **FR-1** `certs: true` issues leaf certs via active CertificateAuthority with §6.8 SANs.
- **FR-2** mkcert Live downloads and installs with network-trust-aware egress and privilege-aware trust-store install.
- **FR-3** `lando.boot` creates `/etc/lando` scaffold for lando-base services only.
- **FR-4** Language features export additional CA env when corporate inject is active.
- **FR-5** Doctor reports CA and network-trust problems with remediation.
- **FR-6** Every user-facing FR has guide coverage and guide gates pass.

## Non-Goals

- Global Dockerfile directories.
- Replacing Traefik TLS termination design.
- Full Java service type if none exists in tree.

## Technical Considerations

- Feature priority order: boot (100) → … → env (700) → certs (1000) → security (1100).
- Reuse PRD-01 bundle path `/etc/lando/certs/ca-bundle.pem` where possible.
- ca-mkcert must not bypass HttpClient/Downloader for binary fetch.
- Guide scenarios stay host-safe (`render={false}`) when live mkcert/network is required; unit tests carry the proof.

## Guide Coverage

| Surface | Guide |
|---------|--------|
| Corporate inject | `docs/guides/config/corporate-network-trust.mdx` |
| Leaf certs / mkcert | `docs/guides/subsystems/certificates-mkcert.mdx` |
| Boot scaffold | services guide or section linked from corporate + certs |
| Doctor | subsystems + global doctor-walkthrough |
| Language env | table in corporate guide + deep links |

## Success Metrics

- `certs: true` + setup path works in tests with fakes; guide describes real user steps.
- Boot + certs + security compose without mount path collisions in tests.
- Doctor degraded paths are documented and tested.
- Guide coverage/drift gates green on the change set.

## Open Questions

None.
