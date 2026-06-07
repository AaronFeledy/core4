# PRD Index — Lando v4 Phase 3 (Alpha 3 / "full breadth")

> **Phase naming (reframed):** This phase was previously labeled "Beta"; it is now **Alpha 3**, the final shipped phase of the completed alpha line (**MVP → Alpha 1 → Alpha 2 → Alpha 3**). Remaining work is **Beta 1 (last feature surface, incl. `setup`/`uninstall`) → Beta 2 → RC → 4.0 GA**. Alpha phases publish `4.0.0-alpha.N` on the `dev` channel; Beta phases publish `4.0.0-beta.N` on the `next` channel. See [`spec/ROADMAP.md`](../ROADMAP.md) for the authoritative ladder.

## Introduction

Phase 3 of [`spec/ROADMAP.md`](../ROADMAP.md) turns the Alpha 1 "common-stack happy path" into a full-breadth Alpha 3. The roadmap's one-sentence goal is:

> All the bundled plugins work, all canonical service types ship, both providers work on every platform, the global app and scratch apps are usable.

Alpha 1 proved the common stacks on Linux + macOS with the Lando-managed runtime. Alpha 2 introduced the executable-guides scenario engine. **Alpha 3 closes the breadth surface**: the remaining feature work (governance, release engineering, and the `lando setup` / `lando uninstall` completion) lands in Beta 1, the last phase to add feature surface; everything after that is hardening (Beta 2 + RC) and the GA tag bump.

This PRD set picks up at **US-074** (Alpha 2 ended at US-073) and runs through **US-194**.

## How to use this set of PRDs

- Each PRD is self-contained and follows the Alpha 1 convention: introduction, source references, goals, user stories, functional requirements, non-goals, technical considerations, success metrics, and open questions.
- The dependency graph below is strict: do not start a downstream PRD until its prerequisites are accepted.
- The spec parts in [`spec/`](../README.md) remain source of truth. When these PRDs and a spec part disagree, the spec part wins and both must be updated together.
- Every story follows the verification contract in this index.
- Alpha 3 is the first phase where `@lando/core` ships as a real `4.0.0-alpha.N` pre-release on the `dev` channel and where the §17.9 binary acceptance criteria start being measured (final pass at Beta 1).

## PRDs in this set

| #  | PRD                                                                                  | Subsystem                                                                                                                            | Depends on              |
| -- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ | ----------------------- |
| 01 | [Provider matrix complete](./prd-alpha-3-01-provider-matrix.md)                         | provider-lando Windows, provider-docker Windows, provider-podman, shared contract suite                                              | —                       |
| 02 | [Canonical service-type catalog](./prd-alpha-3-02-service-catalog-full.md)              | Go, MongoDB, Redis/Memcached/Valkey, Solr/Elasticsearch/Opensearch/Meilisearch, static, raw Compose passthrough                      | PRD-01                  |
| 03 | [File sync (Mutagen)](./prd-alpha-3-03-file-sync-mutagen.md)                            | `@lando/file-sync-mutagen`, FileSyncEngine contract, host CLI + agent download, planner auto-selection                               | PRD-01                  |
| 04 | [Subsystems](./prd-alpha-3-04-subsystems.md)                                            | Proxy (Traefik), CA (mkcert), SSH sidecar, healthchecks, scanner, host-proxy, shared cross-app network, `lando doctor`               | PRD-01, PRD-02          |
| 05 | [Global app](./prd-alpha-3-05-global-app.md)                                            | `GlobalAppService`, `globalServices:` contribution, `meta:global:*`, reserved `global` id, bundled Traefik + Mailpit                 | PRD-02, PRD-04          |
| 06 | [Scratch apps](./prd-alpha-3-06-scratch-apps.md)                                        | `ScratchAppService`, scratch bootstrap level, `apps:scratch:*`, fork mode, scratch mode, content-copy isolation, orphan reap         | PRD-05                  |
| 07 | [Recipes — full breadth](./prd-alpha-3-07-recipes-full-breadth.md)                      | git/tarball/npm/registry sources, `choicesFrom:`, `runs:`, `fetchAllowlist:`, programmatic `recipe.ts`, all `postInit:` `bun:` verbs | PRD-04 (Alpha 1 PRD-04)   |
| 08 | [Landofile — full schema](./prd-alpha-3-08-landofile-full-schema.md)                    | `includes:`, `.lando.lock.yml`, expressions language, template engines, env overrides, secrets, config-translation                   | PRD-04                  |
| 09 | [Renderer & CLI dispatch](./prd-alpha-3-09-renderer-and-cli-dispatch.md)                | `task.detail` tails, expand/collapse, full first-paint, CLI dispatch unification spike, renderer wiring at the CLI boundary          | —                       |
| 10 | [Tooling hot path](./prd-alpha-3-10-tooling-hot-path.md)                                | `tooling` bootstrap level, cache-only app-plan read, tooling compilation cached, service-mode `lando shell`, perf budget             | PRD-09                  |
| 11 | [Plugin install & library API](./prd-alpha-3-11-plugin-install-and-library-api.md)      | npm plugin install full, postinstall trust gating, system/user/app discovery, library API surface, import boundary                   | PRD-09                  |
| 12 | [Executable guides — Alpha 3 expansion](./prd-alpha-3-12-executable-guides.md)        | `<Inspect>`, `<Tabs>`/`<Tab>`, `<Inline>`, `<Skip>`, `<Hidden>` codegen, multi-axis variants, fuller lint, recipe README strip       | Alpha 2 (all)            |
| 13 | [Build, distribution & CI matrix](./prd-alpha-3-13-build-distribution-and-ci.md)        | 5-platform binaries, AOT bootstrap-layer codegen, asset embedding, nightly e2e, weekly provider matrix, npm `dev` channel publish   | PRD-01 through PRD-12   |

## Dependency graph

```text
                ┌────────────────────────────┐
                │ 01 Provider matrix         │
                └─────┬───────────────┬──────┘
                      │               │
                      ▼               ▼
            ┌──────────────┐   ┌──────────────┐
            │ 02 Catalog   │   │ 03 File sync │
            └──────┬───────┘   └───────┬──────┘
                   │                   │
                   ▼                   │
            ┌──────────────────────────┴──┐
            │ 04 Subsystems               │
            └────────────┬────────────────┘
                         │
                         ▼
                  ┌─────────────┐
                  │ 05 Global   │
                  └──────┬──────┘
                         │
                         ▼
                  ┌─────────────┐
                  │ 06 Scratch  │
                  └─────────────┘

  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐
  │ 07 Recipes   │  │ 08 Landofile │  │ 09 Renderer  │  │ 12 Ex-guides │
  └──────────────┘  └──────────────┘  └──────┬───────┘  └──────────────┘
                                             │
                                  ┌──────────┴──────────┐
                                  ▼                     ▼
                          ┌──────────────┐      ┌──────────────┐
                          │ 10 Tooling   │      │ 11 Plugin +  │
                          │    hot path  │      │    library   │
                          └──────────────┘      └──────────────┘

                          ┌─────────────────────────────────────┐
                          │ 13 Build, distribution & CI matrix  │
                          │   (depends on 01–12)                │
                          └─────────────────────────────────────┘
```

## Verification contract (applies to every story in every PRD)

- [ ] Failing test exists before implementation and is part of the same PR series.
- [ ] After implementation, that specific test passes locally with `bun test <path>`.
- [ ] `bun run typecheck` passes.
- [ ] `bun run lint` passes.
- [ ] Whole-workspace `bun test` passes; no test removed or skipped to make this true.
- [ ] If the story changes generated files, `bun run codegen` is run and committed; generated guide-scenario tests remain gitignored per §19.7.
- [ ] If the story affects the compiled binary, source CLI and compiled `$bunfs` behavior are both verified (or, if PRD-09's dispatch spike succeeds and removes `runCompiledCli`, the unified path is verified).
- [ ] Live provider tests remain explicitly gated by environment variables and are not required on machines lacking the runtime.
- [ ] If the story adds or changes Effect Schemas exposed by `@lando/sdk`, the §13.2 schema-snapshot gate runs cleanly and `sdk/API_COMPATIBILITY.md` plus relevant fixtures are updated.
- [ ] If the story adds a new public export to `@lando/core`, the §16/§9 import-boundary test is updated.
- [ ] If the story touches a CLI/source surface declared in any PRD's §Guide Coverage section (PRD-12 US-198), the PR also touches the listed guide(s) or carries a `Guide-Coverage-Skip:` reason ≥ 24 chars. `bun run check:guide-coverage` and `bun run check:guide-drift` (PRD-12 US-197, US-199) pass.

## Carry-forward from MVP, Alpha 1, and Alpha 2

The following items were explicitly deferred to Alpha 3 by prior PRDs and progress logs. Each is ticketed inside one of the sub-PRDs below. Cross-reference column shows which PRD picks it up.

| Carry-forward                                                                            | Source phase | Picked up by              |
| ---------------------------------------------------------------------------------------- | ------------ | ------------------------- |
| `@lando/provider-lando` Windows VM lifecycle                                             | Alpha 1 PRD-01 | PRD-01 US-074..076        |
| `@lando/provider-docker` Windows (Docker Desktop)                                        | Alpha 1 PRD-01 | PRD-01 US-077             |
| `@lando/provider-podman` opt-in                                                          | Alpha 1 PRD-01 | PRD-01 US-078..079        |
| Full provider contract suite across all three providers + Windows                        | Alpha 1 PRD-01 | PRD-01 US-080..082        |
| Go, MongoDB, Solr, Elasticsearch, Opensearch, Meilisearch, Memcached, Valkey services    | Alpha 1 PRD-02 | PRD-02 US-083..094        |
| Mailpit (capture as a global service)                                                    | Alpha 1 PRD-02 | PRD-05 US-115             |
| `static` service + raw Compose passthrough                                               | Alpha 1 PRD-02 | PRD-02 US-093..094        |
| `@lando/file-sync-mutagen` + host CLI/agent download + planner auto-selection            | Alpha 1 PRD-01 | PRD-03 US-095..100        |
| `ProxyService` (Traefik) + `CertificateAuthority` (mkcert) + `SshService` sidecar        | Alpha 1 PRD-03 | PRD-04 US-101..105        |
| `HealthcheckService`, `ScannerService`, `HostProxyService`, shared cross-app network     | Alpha 1 PRD-03 | PRD-04 US-106..110        |
| Global app: `GlobalAppService`, `globalServices:`, reserved id `global`                  | Alpha 1 PRD-03 | PRD-05 US-111..119        |
| Scratch apps: `ScratchAppService`, `apps:scratch:*`, fork + scratch modes                | Alpha 1 PRD-03 | PRD-06 US-120..128        |
| Remote recipe sources (`git`, `tarball`, `npm`, `registry`)                              | Alpha 1 PRD-04 | PRD-07 US-129..132        |
| Dynamic `choicesFrom:`, `runs:` allowlist, `fetchAllowlist:`, programmatic `recipe.ts`   | Alpha 1 PRD-04 | PRD-07 US-133..136        |
| All remaining `postInit:` `bun:` verbs (`script`, `add`, `create`, `run`, `x`)           | Alpha 1 PRD-04 | PRD-07 US-137..138        |
| `includes:` + `.lando.lock.yml`, `app:includes:update`, `app:includes:verify`            | Alpha 1 PRD-03 | PRD-08 US-139..141        |
| Configuration expressions language (§7.3.1) + template engines                           | Alpha 1 PRD-02 | PRD-08 US-142..145        |
| Env overrides (§7.6), `SecretStore`, config-translation framework + `app:config:translate` | Alpha 1 PRD-03 | PRD-08 US-146..149        |
| Renderer streaming tails, expand/collapse, full first-paint, `verbose` renderer          | Alpha 1 PRD-05 | PRD-09 US-150..154        |
| CLI dispatch unification spike + decision (closes §14.2)                                 | AGENTS interim | PRD-09 US-155..157      |
| `Renderer` Live Layer wired at CLI command boundary + §13.4 lint gate                    | AGENTS interim + §14.2 | PRD-09 US-158    |
| Tooling bootstrap level + cache-only app-plan + perf budget + service-mode `lando shell` | Alpha 1 PRD-03 | PRD-10 US-159..164        |
| Plugin install (npm full) + postinstall trust gating + system/user/app discovery         | Alpha 1 PRD-03 | PRD-11 US-165..169        |
| Library API: `EmbeddingPluginPolicy`, exports surface, import-boundary test              | Alpha 1 PRD-06 | PRD-11 US-170..174        |
| Alpha 3 executable-guide vocabulary: `<Inspect>`, `<Tabs>`, `<Tab>`, `<Inline>`, `<Skip>`   | Alpha 2 PRD-01 | PRD-12 US-175..177       |
| `<Hidden>` code-emission, multi-axis variants, fuller lint, recipe README strip          | Alpha 2 PRD-01/04 | PRD-12 US-178..182    |
| `ScenarioContext.runCli` real-CLI path                                                   | Alpha 2 progress | PRD-12 US-176          |
| 5-platform binaries + AOT bootstrap-layer codegen + asset embedding                      | MVP PRD-02, Alpha 1 PRD-07 | PRD-13 US-183..188 |
| Per-PR matrix on all 5 platforms, nightly e2e, weekly provider matrix                    | Alpha 1 PRD-07 | PRD-13 US-189..192        |
| `@lando/core` `4.0.0-alpha.N` publish on `dev` channel + plugin SDK contract tests       | Alpha 1 PRD-07 | PRD-13 US-193..194        |

## Cross-cutting non-goals (out of scope for the entire Alpha 3 set)

The following are explicitly **not** in Alpha 3. If a story below sneaks them in, push them back to Beta 1 or post-GA:

- Code signing (macOS Developer ID + notarytool, Windows Authenticode, Linux cosign). Beta 1.
- Notarization, SBOM (CycloneDX), SLSA v1.0 provenance, supply-chain attestation. Beta 1.
- Self-update (write-alongside, atomic rename, re-exec, failed-launch-probe rollback). Beta 1.
- Curl-pipe installer scripts (`https://get.lando.dev/install.{sh,ps1}`). Beta 1.
- Telemetry default-on with inventory, retention rules, redaction wiring. Beta 1.
- `DeprecationNotice` schema + `DeprecationService` + propagation through schemas, contracts, manifests, TSDoc. Beta 1.
- Public docs site (Starlight) and any HTML/Astro consumer of guide artifacts. Beta 1 (rendering) and GA (live site).
- Plugin authoring toolkit: `meta:plugin:new`, `meta:plugin:test`, `meta:plugin:build`, `meta:plugin:link`/`unlink`, `meta:plugin:publish`. Beta 1.
- Resolution of remaining §14.2 GA-blocking open decisions (Bun floor, OCLIF major lock, auto-setup level, telemetry inventory, Compose subset, `sshAgent.sidecar: false`, plugin postinstall trust UX). Beta 1.
- Persistent local agent (`lando agent`), copy-on-write scratch isolation, scratch fleets, hot reload from fork-mode source, multi-provider apps, Kubernetes provider, TCP/UDP forwarding, `dependsOn: ["global:<service>"]`. Post-4.0 (§14.2 §6.12 deferrals).
- Distribution-channel packaging (Homebrew, scoop, winget). Phase 6 (v4.1).
- Schema artifact CDN (`https://schemas.lando.dev/v4/`). GA.
- Stable channel population, update manifest pointed at `stable`. GA.
- Real-provider `layer: "e2e"` executable-guide scenarios as a per-PR gate; Alpha 3 keeps `layer: "scenario"` per-PR and adds nightly `@smoke` e2e on Linux x64 only.

## Exit criteria for the whole Alpha 3 set

All of the following must be true to tag `4.0.0-alpha.N`:

- Every story in every Alpha 3 PRD accepted, with the verification contract above met.
- The full canonical service-type catalog from §6.12.1 ships and the contract suite covers every service type.
- `@lando/provider-lando`, `@lando/provider-docker`, and `@lando/provider-podman` pass the provider contract suite on every platform they declare support for.
- `@lando/file-sync-mutagen` is bundled; auto-selection is invisible to users; the file-sync engine contract suite passes.
- Global app and scratch apps work end-to-end on Linux x64 (the canonical reference platform) and on at least one of macOS arm64 / macOS x64 / Windows x64.
- The §13.6 per-PR CI matrix runs on all 5 platforms (`darwin-x64`, `darwin-arm64`, `linux-x64`, `linux-arm64`, `windows-x64`); all test layers from §13.1 are green per-PR on every platform.
- The nightly full e2e suite against `@lando/provider-lando` and the distribution rehearsal both pass on Linux x64; the weekly provider matrix (Docker Desktop, Docker Engine, Podman Desktop, Podman, Lima, OrbStack) is green.
- The `@smoke` end-to-end suite passes on Linux x64.
- `@lando/core` `4.0.0-alpha.N` is published on the npm `dev` tag; the Alpha 3 plugin SDK contract tests are published.
- `bundled.ts` is populated by codegen (not hand-edited); the AOT bootstrap-layer codegen (§17.2) is shipping; asset embedding for recipes, schemas, and the OCLIF manifest passes the import-boundary test (no runtime FS read of bundled assets).
- Every user-facing Alpha 3 PRD has a populated `## Guide Coverage` section (PRD-12 US-198); `docs/guides/INDEX.md` lists at least one row per user-facing PRD; `bun run check:guide-coverage` exits 0 on the cutover commit (PRD-12 US-197).
- `bun run dev:guides` (PRD-12 US-196) is the documented dev-time test driver in `AGENTS.md` and `core/AGENTS.md`; at least one Alpha 3 user story landed test-first via a guide.
- No spec section is being added — feature freeze entered.

Spec parts that remain authoritative for Alpha 3: [`spec/05-runtime-providers.md`](../05-runtime-providers.md), [`spec/06-services.md`](../06-services.md), [`spec/07-landofile-and-config.md`](../07-landofile-and-config.md), [`spec/08-cli-and-tooling.md`](../08-cli-and-tooling.md), [`spec/09-embedding.md`](../09-embedding.md), [`spec/10-plugins.md`](../10-plugins.md), [`spec/11-subsystems.md`](../11-subsystems.md), [`spec/12-caches-and-persistence.md`](../12-caches-and-persistence.md), [`spec/13-testing-and-distribution.md`](../13-testing-and-distribution.md), [`spec/15-binary-build-and-release.md`](../15-binary-build-and-release.md), [`spec/17-executable-tutorials.md`](../17-executable-tutorials.md), [`spec/18-global-app.md`](../18-global-app.md), and [`spec/19-scratch-apps.md`](../19-scratch-apps.md).
