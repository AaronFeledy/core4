# PRD: BETA-04 — Subsystems

## Introduction

Alpha left every §11 subsystem deferred (proxy, certs, SSH, healthchecks, scanner, host proxy). Beta wires the full subsystem layer: `ProxyService` (Traefik, inside the global app — see PRD-05), `CertificateAuthority` (`@lando/ca-mkcert`), `SshService` (sidecar default), `HealthcheckService`, `ScannerService`, `HostProxyService`, the `sharedCrossAppNetwork` capability so the global app can reach per-app services, and the `lando doctor` checks that make these subsystems debuggable.

Depends on: **BETA-01** (provider capability surface), **BETA-02** (service catalog stable).

## Source References

- [`spec/11-subsystems.md`](../11-subsystems.md) §10 subsystem contracts.
- [`spec/05-runtime-providers.md`](../05-runtime-providers.md) `ProviderCapabilities.sharedCrossAppNetwork`.
- [`spec/08-cli-and-tooling.md`](../08-cli-and-tooling.md) `meta:doctor` depth, `lando ssh`.
- [`spec/18-global-app.md`](../18-global-app.md) §20.10 default proxy realization through Traefik inside the global app.

## Goals

- Ship Live Layers for every Beta-bound subsystem listed in §11.
- Make `lando doctor` produce actionable diagnostics per §10.9 across all subsystems.
- Land `sharedCrossAppNetwork` so global services can address per-app services in Beta.

## User Stories

### US-101: `ProxyService` contract + default Live Layer wired through global app

**Description:** As a user, an HTTPS-aware reverse proxy automatically routes `https://<app>.lndo.site` to the right service without manual Traefik config.

**Acceptance Criteria:**
- [ ] `ProxyService` Effect Service tag, contract, and tagged errors published in `@lando/sdk`.
- [ ] Default Live Layer routes through Traefik running inside the global app (per §20.10.1); contributed via `globalServices:` (PRD-05).
- [ ] Per-app config (hostname rules, port mappings) is derived from service endpoints — no `proxy:` Landofile block required for the default case.
- [ ] Scenario test starts two apps with overlapping default ports; both resolve via Traefik with no port conflict.
- [ ] Tests pass; typecheck passes; lint passes.

### US-102: `CertificateAuthority` via `@lando/ca-mkcert`

**Description:** As a user, local HTTPS works out of the box — Traefik gets a trusted certificate for `*.lndo.site` (or the configured base domain) without me running `mkcert -install`.

**Acceptance Criteria:**
- [ ] `CertificateAuthority` Effect Service tag + contract in `@lando/sdk`.
- [ ] `@lando/ca-mkcert` bundled plugin downloads mkcert via `lando setup`, runs `mkcert -install` once (with consent), and issues per-app wildcard certs.
- [ ] User can opt out via `lando setup --ca=none` (no trust install, HTTP only).
- [ ] Scenario test asserts the issued cert chain validates against the locally-installed root.
- [ ] Tests pass; typecheck passes; lint passes.

### US-103: `SshService` sidecar (default)

**Description:** As a user, services that need an SSH agent (e.g. Composer pulling from private git) get one via a sidecar container — no `ssh-agent` lifecycle on the host.

**Acceptance Criteria:**
- [ ] `SshService` contract published in `@lando/sdk`; default Live Layer is the sidecar implementation per §10.4.
- [ ] Sidecar forwards a Unix-socket SSH agent into the app network; opt-in per service via `sshAgent: true`.
- [ ] `lando ssh <service>` works for the sidecar path (provider-exec TTY still wraps the actual login).
- [ ] Scenario test runs `lando composer install` against a fake private package server with SSH-agent auth and asserts success.
- [ ] Tests pass; typecheck passes; lint passes.

### US-104: `HealthcheckService` against provider-exec semantics

**Description:** As a user, services declare healthchecks (`type: tcp|http|cmd`) and Lando waits for them before publishing `post-app-start`.

**Acceptance Criteria:**
- [ ] `HealthcheckService` contract + Effect tag in `@lando/sdk`.
- [ ] Live Layer drives provider-exec for `cmd:` healthchecks and TCP/HTTP probes from inside the per-app network.
- [ ] Healthcheck failure within timeout → `HealthcheckTimeoutError` with the failing service, probe, and last status.
- [ ] Tests pass; typecheck passes; lint passes.

### US-105: `ScannerService` for endpoint discovery and port-collision detection

**Description:** As a user, `lando info` reports the actual reachable endpoints and `lando start` errors clearly when two apps want the same host port.

**Acceptance Criteria:**
- [ ] `ScannerService` contract published; default Live Layer combines provider inspect output with proxy routing rules.
- [ ] Port-collision errors include all conflicting apps + service ids.
- [ ] `lando info --json` includes the scanner output verbatim.
- [ ] Tests pass; typecheck passes; lint passes.

### US-106: `HostProxyService` for `lndo.site`-style hostnames

**Description:** As a user, `*.lndo.site` resolves to `127.0.0.1` (or the configured loopback) without me editing `/etc/hosts`.

**Acceptance Criteria:**
- [ ] `HostProxyService` contract + default Live Layer (DNS sinkhole or `/etc/hosts` writer per platform).
- [ ] Privileged operations gated behind sudo/UAC prompt at `lando setup` time; never inline during `lando start`.
- [ ] `lando setup --host-proxy=none` opt-out for users managing their own DNS.
- [ ] Tests pass; typecheck passes; lint passes.

### US-107: `sharedCrossAppNetwork` capability + provider-side wiring

**Description:** As the global app, I can reach per-app services across networks without each user enabling host-only networking.

**Acceptance Criteria:**
- [ ] `ProviderCapabilities.sharedCrossAppNetwork: true` declared for `provider-lando` and `provider-docker` on every platform where it works; `false` where it does not, with remediation.
- [ ] Planner refuses to start a global service requiring `sharedCrossAppNetwork` on a provider without the capability — actionable error.
- [ ] Scenario test exercises global Traefik routing to a per-app web service across the shared network.
- [ ] Tests pass; typecheck passes; lint passes.

### US-108: `lando doctor` reports every subsystem status

**Description:** As an operator, `lando doctor` aggregates every subsystem's status (proxy reachable, CA installed, host proxy active, healthcheck engine ready, scanner cache age) and surfaces remediation per §10.9.

**Acceptance Criteria:**
- [ ] Per-subsystem doctor checks return a `{ status, severity, context, solution }` record per §10.9.
- [ ] JSON renderer snapshot (`meta-doctor.subsystems.ndjson`) covers every subsystem and at least one failing-state remediation.
- [ ] Doctor never requires app bootstrap unless `--app` is passed.
- [ ] Tests pass; typecheck passes; lint passes.

### US-109: networking intent — per-app bridge + shared cross-app network

**Description:** As the planner, I produce a `NetworkingPlan` per app that creates a per-app bridge network AND attaches the app to a shared network when a global service or another app needs to reach it.

**Acceptance Criteria:**
- [ ] `NetworkingPlan` schema in `@lando/sdk` covers `perAppBridge` + `sharedNetworkMembership`.
- [ ] Provider apply creates / joins both networks idempotently; destroy removes per-app bridge but leaves the shared network (which is owned by the global app).
- [ ] Scenario test verifies two apps + global Traefik all reach each other.
- [ ] Tests pass; typecheck passes; lint passes.

### US-110: subsystem failure-recovery + cleanup

**Description:** As an operator, partial subsystem failures (proxy down, CA expired, host proxy unreachable) leave the apps in a documented partial state and `lando doctor` explains how to recover.

**Acceptance Criteria:**
- [ ] Each subsystem's failure path produces a tagged error with `severity` + `solution` per §10.9.
- [ ] `meta:doctor --fix` (where safe) re-runs the subsystem's setup step; otherwise produces a `manual` remediation.
- [ ] Tests cover at least one degraded-subsystem scenario per subsystem.
- [ ] Tests pass; typecheck passes; lint passes.

## Functional Requirements

- FR-1: `ProxyService`, `CertificateAuthority`, `SshService`, `HealthcheckService`, `ScannerService`, `HostProxyService` each have a stable Effect Service tag + contract in `@lando/sdk`.
- FR-2: Default Live Layers ship from bundled plugins (`@lando/ca-mkcert` + global Traefik per PRD-05); user can swap via plugin contribution.
- FR-3: `ProviderCapabilities.sharedCrossAppNetwork` is declared per platform; planner enforces it.
- FR-4: `lando doctor` aggregates per-subsystem checks with §10.9-compliant solution records.
- FR-5: Privileged operations (CA root install, host-proxy DNS writes) happen at `lando setup` time, never inline in `lando start`.

## Non-Goals

- `sshAgent.sidecar: false` non-sidecar mode (§14.2 — RC).
- Pluggable cert authorities beyond mkcert in Beta (RC may add a fallback).
- TCP/UDP forwarding subsystem (post-4.0, §14.2).
- `lando doctor --fix` for non-trivial repairs (Beta ships `automatic` only for setup-style steps; deeper repair is RC).
- Proxy plugins beyond Traefik (post-GA).

## Technical Considerations

- The default proxy lives **inside** the global app per §20.10.1 — see PRD-05. The `ProxyService` Live Layer here is a thin client that talks to that global app's Traefik admin API.
- mkcert's CA install requires keychain / cert-store write — gate behind explicit consent (`lando setup` interactive prompt or `--yes`).
- Host-proxy implementation per platform: macOS = `/etc/resolver/lndo.site` (no `/etc/hosts` edit); Linux = `/etc/hosts` writer or `systemd-resolved` drop-in; Windows = HOSTS file edit. All three operations gated.
- `sharedCrossAppNetwork` on provider-docker requires a user-defined network the docker socket can join — Lando creates and owns this network through the global app.

## Success Metrics

- All §11 Beta-bound subsystems pass their contract tests against the Beta provider matrix.
- `lando doctor` covers every subsystem with an actionable solution record on at least one failure path.
- Cold-start `lando start` against a fresh `lando setup` (with CA + host proxy + proxy bootstrapped) takes under 30s on Linux x64 (excluding image pulls).

## Guide Coverage

Per [PRD-12 US-198](./prd-beta-12-executable-guides-beta.md) (`## Guide Coverage` convention) and [US-199](./prd-beta-12-executable-guides-beta.md) (drift gate), this PRD owns the executable guides listed below. Each guide exercises the happy path of its mapped user story; failure modes remain covered by unit and integration tests in the named packages. PRs that touch the listed surface paths MUST also touch the corresponding guide(s), or use the `Guide-Coverage-Skip:` escape hatch.

**Guides owned by this PRD:**

| User Story | Feature | Guide Path | Acceptance |
|---|---|---|---|
| US-101 | ProxyService + Traefik via global app | `docs/guides/subsystems/proxy-traefik.mdx` | Required at story acceptance |
| US-102 | CertificateAuthority via @lando/ca-mkcert | `docs/guides/subsystems/certificates-mkcert.mdx` | Required at story acceptance |
| US-103 | SshService sidecar (default) | `docs/guides/subsystems/ssh-sidecar.mdx` | Required at story acceptance |
| US-108 | `lando doctor` subsystem walkthrough | `docs/guides/subsystems/doctor-walkthrough.mdx` | Required at story acceptance |

**CLI / source surface paths covered (drift gate input):**

- `core/src/subsystems/proxy/**`
- `core/src/subsystems/certs/**`
- `core/src/subsystems/ssh/**`
- `core/src/subsystems/healthcheck/**`
- `core/src/subsystems/scanner/**`
- `core/src/subsystems/host-proxy/**`
- `core/src/cli/commands/doctor.ts`
- `plugins/ca-mkcert/**`

## Open Questions

- Should `HostProxyService` default to `lndo.site` as the base domain, or expose a `lando setup --base-domain=…` option in Beta? Default: `lndo.site` only; opt-in domain change is RC.
- Should `lando doctor` ever auto-elevate (sudo) for `--fix`? Default: no — manual remediation is always the fallback (matches §17.6 self-update prohibition on silent elevation).
- Should the SSH sidecar share its agent socket across apps (one sidecar per host) or be per-app? Default: per-app (matches scope-isolation principle); shared-sidecar is post-GA.
