# Lando v4 release roadmap

No public Lando v4 release has shipped. This file is the canonical planning ladder for maintainers. When this document and an Alpha PRD disagree, the PRD wins.

Current stage: **Alpha 1**. Ordered Alpha stories live in [`spec/alpha/prd-alpha-00-index.md`](./alpha/prd-alpha-00-index.md) (US-592 through US-600).

## Cadence

| Stage | Status | Version / channel |
| --- | --- | --- |
| Pre-alpha | historical; never publicly released | none |
| Alpha 1 | current | `4.0.0-dev.N` on `dev` |
| Beta 1 | next; hardening only | first `4.0.0-beta.N` on `next` |
| RC | later | `4.0.0-rc.N`; first production distribution |
| 4.0 GA | later | `4.0.0` on `stable` |
| 4.1+ | deferred | post-GA minors |

## Pre-alpha (historical)

Private-repo phases built this tree and never left the lab. That work stays on the record. It is not a public release, and those phase names are not a forward plan.

What is already in the working tree:

- MVP walking skeleton: Effect runtime, SDK contracts, `lando start` on Linux.
- Catalog and runtime breadth: common service types, recipes, tooling, global app, scratch apps, providers, Mutagen, proxy, CA, doctor, setup, uninstall.
- Governance and agent-native surfaces: schemas, telemetry, machine output, MCP, `lando open`, Landofile version constraint, `lando run`, architecture-simplicity, Lando 3 parity.

The old ladder (MVP, four Alphas, a contract-completion Beta, then a hardening Beta) is retired. Do not schedule new 4.0 work as a later Alpha.

## Alpha 1 (current)

Ship a public Alpha that testers can run. Public Alpha binaries and npm packages use `4.0.0-dev.N` on the `dev` channel. Alpha artifacts are not production-signed.

Six-platform support is an **exit target**, not a claim about today.

### Alpha exit targets

| Target | Provider path required at exit |
| --- | --- |
| `linux-x64` | `lando` (managed Podman) |
| `linux-arm64` | `lando` (managed Podman) |
| `darwin-arm64` | `lando` (managed Podman) |
| `darwin-x64` | `provider-docker` / Docker Desktop. `provider-lando` stays tagged fail-closed. |
| `windows-x64` | `lando` (managed Podman) |
| `windows-arm64` | `lando` (managed Podman) |

Feature freeze begins only after every Alpha PRD story passes. No new 4.0 feature surface after that.

### Alpha 1 exit criteria

1. Every story in [`spec/alpha/prd-alpha-00-index.md`](./alpha/prd-alpha-00-index.md) is accepted (US-592 through US-600).
2. Live `lando setup` and `lando doctor` succeed on all six targets.
3. Drupal and Rails journeys succeed on all six targets (start the app, run recipe tooling, `lando info`).
4. Public Alpha artifacts are `4.0.0-dev.N` on `dev`. Production signing, notarization, SBOM, provenance, installers, and self-update wait for RC.
5. On `darwin-x64`, the supported path is Docker Desktop via `provider-docker`. `provider-lando` remains tagged fail-closed.
6. Feature freeze is entered.

## Beta 1 (hardening)

Hardening only. This is the old hardening Beta, renamed. No new commands, flags, service types, schema fields, or events. Fix bugs, diagnostics, docs drift, and performance regressions against shipped budgets.

First public `4.0.0-beta.N` ships on `next`.

### Beta 1 exit criteria

Known Alpha blockers are burned down. The candidate is ready for RC. No new feature surface landed.

## RC

Production distribution rehearsal. Tag `4.0.0-rc.N`.

RC is the first stage that requires production signing, notarization, SBOM, SLSA provenance, curl-pipe installers, and self-update on the release matrix. Alpha and Beta do not.

### RC exit criteria

Every §17.9 binary-shipping item is green on the release platforms. Two RC iterations with zero blocker bugs.

## 4.0 GA

Tag `4.0.0` from the last green RC onto `stable`. Version bumps and RC bug fixes only.

## 4.1+

Post-GA minors. Out of 4.0:

- `TunnelService` / `lando share` (contract frozen; no bundled tunnel)
- `RemoteSource` / `Dataset` pull and push (contract frozen; no hoster wiring)
- Renderer 4.1: rich render events, panel slots, keymap remapping, interactive `app:logs --follow` viewer
- Deferred meta commands: `meta:plugin:login`, `meta:plugin:logout`, `meta:events:follow`

Later 4.x work (distro packages, persistent agent, multi-provider apps, and the rest of the §14.2 deferrals) stays post-GA.
