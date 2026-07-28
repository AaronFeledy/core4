# PRD Index — Service network trust inject (host-global CA/proxy → containers)

> **Phase position:** Post–feature-freeze feature work (same class as the Compose vocabulary wave). The normative contract was amended **first** in §6.8, §7.5, and §10.3.1 (commits introducing `network.ca.injectIntoServices` / `network.proxy.injectIntoServices` and the host-global inheritance rules). This set makes that contract true in the planner, `lando.security` feature, and derived image builds. When these PRDs and a spec part disagree, **the spec part wins** and both must be reconciled together.

## Introduction

Corporate TLS interception (Zscaler, GlobalProtect, custom MITM proxies) breaks HTTPS inside app containers: Composer, npm, curl, and language runtimes fail unless the corporate CA is trusted **in the service image/env**. That trust is **machine- and network-local**, not project-local — it must not live in the shared Landofile.

DDEV’s answer is host-global Dockerfile snippets (`~/.ddev/web-build/`). Lando’s answer is already specified and deliberately different:

1. **Lando-owned egress** uses global `network.ca` / `network.proxy` via the pure network-trust resolver and `HttpClient` (§10.3.1–§10.3.2) — largely implemented.
2. **In-service trust** installs the same CA material into `type: lando` services when `network.ca.injectIntoServices` is true (default), with per-service overrides and additive Landofile `security.ca:` (§6.8) — **not implemented**.

This wave closes the second plane so a user can set CA paths once in global config and every lando-base service works behind interception without per-project Dockerfiles or gitignored Landofile fragments.

## Source References

- [`spec/06-services.md`](../06-services.md) §6.8 — host-global CA/proxy inheritance, `security.*`, `lando.security` priority 1100, build-key digests, runtime env (`NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`, `LANDO_CA_*`)
- [`spec/07-landofile-and-config.md`](../07-landofile-and-config.md) §7.5–§7.6 — `network.ca` / `network.proxy` inject flags and env overrides
- [`spec/11-subsystems.md`](../11-subsystems.md) §10.3.1 — two-plane model; non-goal: host-global Dockerfile directories
- [`sdk/src/schema/config.ts`](../../sdk/src/schema/config.ts) — `NetworkCaConfig.injectIntoServices` (default `true`), `NetworkProxyConfig.injectIntoServices` (default `false`)
- [`sdk/src/network-trust/index.ts`](../../sdk/src/network-trust/index.ts) — pure path-level trust plan (no file IO)
- Work plan: `.omo/plans/host-global-ca-proxy-inject.md` (implementation sequencing)

## Goals

- Setting `network.ca.certs` (or `LANDO_NETWORK_CA_CERTS`) once injects those CAs into every `base: "lando"` service on the machine by default.
- Landofile `security.ca:` remains the additive, repo-shareable project-CA path; global certs never require Landofile edits.
- CA vs proxy inject are independent (CA default on; proxy default off).
- Artifact rebuilds when injected CA material changes (digest in build-key inputs).
- No open-ended host Dockerfile injection surface.

## Non-Goals

- DDEV-style `~/.lando/*-build/` or global Dockerfile fragment directories.
- `CertificateAuthority` leaf cert issuance / mkcert host trust / `certs: true` route leaves (existing subsystem; separate wave).
- Full `lando.boot` `/etc/lando/*` scaffolding framework (deferred; inject uses derived-build + plan env + mounts).
- Language-specific trust beyond Node/OpenSSL defaults (e.g. Java trust stores) — optional later on language types.
- Inject into `base: "l337"` or Compose-passthrough services that do not run `lando.security`.
- Teaching pure `@lando/sdk/network-trust` to read PEM files from disk.
- `packages:` feature or unrelated service customization.

## PRDs in this set

| #  | PRD | Subsystem | US range | Depends on |
| -- | --- | --------- | -------- | ---------- |
| 01 | [Host-global CA/proxy inject](./prd-service-trust-01-host-global-ca-proxy-inject.md) | `ServiceConfig.security` + aliases, env-overlay inject flags, shared PEM load, `lando.security`, planner + load/import CA material, derived-build CA pack, setup note, gates | US-483..US-489 | Spec §6.8/§7.5/§10.3.1 already landed |

## Verification contract

Every story carries TDD (or tests-with-implementation) acceptance criteria plus:

1. `bun test` on the story’s path filters with a **positive** test count
2. `bun run typecheck` and `bun run lint`
3. When `@lando/sdk` schemas change: `sdk/API_COMPATIBILITY.md` + `bun run codegen:schema-snapshot` with clean `git diff --exit-code` on generated paths
4. No hand-edit of generated schema MDX/JSON or CI workflows

## Open questions

None for this wave. Defaults are locked in the normative spec (CA inject on, proxy inject off, no global Dockerfiles).
