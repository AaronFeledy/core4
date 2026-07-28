# PRD Index — Service trust (corporate CA/proxy, leaf certs, boot, doctor)

> **Phase position:** Post–feature-freeze feature work. Normative contracts live in §6.8–§6.9, §7.5–§7.6, §10.3, and the service feature priority table. Spec wins over PRDs when they disagree.

## Introduction

Developers behind corporate TLS interception need containers to trust machine-local CAs without polluting shared Landofiles. Separately, local HTTPS for routes needs leaf certificates from a dev CA, and `type: lando` services need `/etc/lando/*` boot scaffolding so env and certs are available on every exec. Doctor and setup must explain failures. All of that is **user-facing** and therefore requires **executable guide coverage** as acceptance criteria (not a docs afterthought).

This set is two PRDs:

1. **Host-global CA/proxy inject** — close the service plane of §10.3.1 / §6.8 inject rules.
2. **Leaf certs, boot, language trust, doctor, Traefik TLS** — `certs:` + mkcert Live, `lando.boot`, language CA env, doctor checks, **Traefik HTTPS certs**, guide pack completion.

**SSH:** The `lando.ssh-agent` / `SshService` path is **agent-socket forwarding**, not CertificateAuthority TLS. It does **not** belong in this cert/trust set (track separately).

## Source References

- [`spec/06-services.md`](../06-services.md) §6.8 certificates/security, §6.9 env, feature priorities (`lando.boot` 100, `lando.certs` 1000, `lando.security` 1100)
- [`spec/07-landofile-and-config.md`](../07-landofile-and-config.md) §7.3 load/import, §7.5–§7.6 network + env
- [`spec/11-subsystems.md`](../11-subsystems.md) §10.3 CertificateAuthority + corporate proxies
- Work plan: `.omo/plans/host-global-ca-proxy-inject.md`
- Existing guide seed: [`docs/guides/subsystems/certificates-mkcert.mdx`](../../docs/guides/subsystems/certificates-mkcert.mdx)

## Goals

- Set-and-forget corporate CA/proxy on the host for lando-base services.
- Landofile `security.ca` / `certs:` remain clear, documented, and guided.
- mkcert-backed leaf certs work after `lando setup`.
- Traefik terminates HTTPS with CA-issued certificates (not empty `tls: {}`).
- `lando.boot` scaffolds `/etc/lando` for env and cert materialization.
- Doctor/setup remediate CA and network-trust problems.
- **Every user-facing story includes guide MDX + `lint:guides` / `check:guide-coverage` / `check:guide-drift` (and public transcripts when applicable).**

## Non-Goals

- DDEV-style host-global Dockerfile directories.
- Full SSH-agent Live / direct host agent mounts (not a TLS cert concern).
- Mutagen beyond network.ca on downloads.
- ACME/public CA for Traefik (dev mkcert only for v4.0 default).
- New trust models not in the spec.

## PRDs in this set

| #  | PRD | Subsystem | US range | Depends on |
| -- | --- | --------- | -------- | ---------- |
| 01 | [Host-global CA/proxy inject](./prd-service-trust-01-host-global-ca-proxy-inject.md) | security schema, env overlays, PEM load, `lando.security`, planner, derived-build, setup note, corporate guide | US-483..US-489 | Spec inject contract landed |
| 02 | [Leaf certs, boot, doctor, Traefik TLS](./prd-service-trust-02-certs-boot-doctor.md) | `certs:` + mkcert Live + `lando.certs` + `lando.boot` + language CA env + doctor + **Traefik edge TLS** + guide pack | US-490..US-498 | PRD-01; US-491 before Traefik TLS |

## Verification contract

1. TDD or tests-with-implementation; positive `bun test` counts on story path filters.
2. `bun run typecheck`, `bun run lint`.
3. SDK schema changes: `API_COMPATIBILITY.md` + `codegen:schema-snapshot`.
4. **User-facing stories:** guide updated/created; `bun run lint:guides`; `bun run check:guide-coverage`; `bun run check:guide-drift`; `check:public-transcripts` if transcripts change.
5. `render={false}` guide scenarios are acceptable when live CA/mkcert/network is unsafe in CI (match certificates-mkcert pattern) **if** unit/contract tests back the same claims.

## Open questions

None — defaults locked by spec and the approved expanded plan.
