# PRD Index — Lando v4 Phase 4 (Beta 1 / "governance + the last feature surface")

> **Phase position:** Beta 1 is the **fourth** shipped phase (**MVP → Alpha 1 → Alpha 2 → Alpha 3 → Beta 1**) and the **last phase that adds feature surface**. Everything after Beta 1 is hardening (Beta 2 + RC) and the GA tag bump. Alpha phases published `4.0.0-alpha.N` on the `dev` channel; Beta phases publish `4.0.0-beta.N` on the `next` channel. See [`spec/ROADMAP.md`](../ROADMAP.md) Phase 4 for the authoritative ladder.

## Introduction

Phase 4 of [`spec/ROADMAP.md`](../ROADMAP.md) turns the breadth-complete Alpha 3 surface into a governed, signed, self-updating product. The roadmap's one-sentence goal is:

> The governance contracts go live, the open decisions in §14.2 are closed, and the **remaining `lando setup` / `lando uninstall` functionality** is completed — this is the final phase that adds feature surface.

Alpha 3 closed the breadth surface (every canonical service type, both providers on every platform, the global app, scratch apps, full recipes, full Landofile schema, renderer wiring, tooling hot path, plugin install, 5-platform CI). **Beta 1 lands the last feature surface**: the full `lando setup` / `lando uninstall` lifecycle, the §14.2 open-decision closures (Bun floor, OCLIF lock, auto-setup level, Compose subset documentation, `sshAgent.sidecar` opt-out, plugin trust model), deprecation governance, schema publication plus the canonical Landofile serializer, the plugin authoring toolkit, telemetry plus the canonical redaction primitive, the full executable-guides pipeline, the §17 release machinery (signing, supply chain, self-update, installers) plus the shared `Downloader` primitive, the stable App-handle embedding primitive, terminal UI polish plus the shared `InteractionService` primitive, the paired Paths/Roots + durable `StateStore` foundational primitives, the remaining SDK primitive trio — the `@lando/sdk/probe` retry/verdict primitive, the `EventService` query/history surface, and the §4.2 plugin-abstraction contract kit — and the `DataMover` local/volume byte-movement primitive plus the `RuntimeProvider` data plane (§10.11). At the end of Beta 1 the first signed `4.0.0-beta.N` ships from CI on the `next` channel and **feature freeze is entered**.

This PRD set picks up at **US-200** (Alpha 3 ended at US-199) and runs through **US-341**.

## How to use this set of PRDs

- Each PRD is self-contained and follows the Alpha 3 convention: introduction, source references, goals, user stories, functional requirements, non-goals, technical considerations, success metrics, guide coverage, and open questions.
- The dependency graph below is strict: do not start a downstream PRD until its prerequisites are accepted.
- The spec parts in [`spec/`](../README.md) remain source of truth. When these PRDs and a spec part disagree, the spec part wins and both must be updated together.
- Every story follows the verification contract in this index.
- Beta 1 is the phase where the §17.9 binary acceptance machinery moves from "measured" (Alpha 3) to **implemented and green on the reference platform (linux-x64)**; the all-platform acceptance pass is the RC gate, not a Beta 1 gate.

## Spec-section → file map (Beta 1 sources)

The stable spec section numbers do **not** match their filenames. Beta 1 PRDs cite both. The authoritative mapping:

| Stable section | Topic | File |
| --- | --- | --- |
| §17 | Binary build, release engineering, signing, supply chain, self-update, installers, acceptance | [`spec/15-binary-build-and-release.md`](../15-binary-build-and-release.md) |
| §18 | Deprecation & surface evolution | [`spec/16-deprecation-and-surface-evolution.md`](../16-deprecation-and-surface-evolution.md) |
| §19 | Executable guides & scenarios | [`spec/17-executable-tutorials.md`](../17-executable-tutorials.md) |
| §7.8 | Schema publication | [`spec/07-landofile-and-config.md`](../07-landofile-and-config.md) |
| §7.5 / §7.5.1 | Global config roots + Paths/Roots primitive | [`spec/07-landofile-and-config.md`](../07-landofile-and-config.md) |
| §9.10 | Plugin authoring toolkit | [`spec/10-plugins.md`](../10-plugins.md) |
| §16 | Library/embedding API | [`spec/09-embedding.md`](../09-embedding.md) |
| §14.2 | Open decisions | [`spec/14-appendices.md`](../14-appendices.md) |
| §10.3 / §10.6 / §10.8 / §10.9 | CA / Downloader / file-sync / setup / doctor | [`spec/11-subsystems.md`](../11-subsystems.md) |
| §4.2 / §9.5 / §13.1 | Downloader pluggability, manifest contribution, contract suite | [`spec/04-pluggability.md`](../04-pluggability.md), [`spec/10-plugins.md`](../10-plugins.md), [`spec/13-testing-and-distribution.md`](../13-testing-and-distribution.md) |
| §10.5 / §10.5.1 | Healthcheck/scanner behaviors + the `@lando/sdk/probe` retry/verdict primitive | [`spec/11-subsystems.md`](../11-subsystems.md) |
| §11.1 | `EventService` interface — typed `waitFor`/`waitForAll`/`query` + bounded redacted history | [`spec/03-architecture.md`](../03-architecture.md) |
| §13.1 (plugin-SDK layer) | Plugin-abstraction contract kit (tooling-engine / route-filter / secret-store / config-translator / plugin-source / doctor-check) | [`spec/13-testing-and-distribution.md`](../13-testing-and-distribution.md), [`spec/04-pluggability.md`](../04-pluggability.md) |
| §13.2 / §13.4 | Schema gate / merge-blocking gates | [`spec/13-testing-and-distribution.md`](../13-testing-and-distribution.md) |
| §10.11 | `DataMover` local/volume byte-movement chokepoint, `DataEndpoint` model, snapshot store, data-plane contract suite | [`spec/11-subsystems.md`](../11-subsystems.md) |
| §5.3 / §5.4 / §5.7 | `RuntimeProvider` data plane (mount-aware `EphemeralRunSpec`/`runStream` + methods), data-plane `ProviderCapabilities`, provider errors | [`spec/05-runtime-providers.md`](../05-runtime-providers.md) |
| §6.5 | Cache-volume storage kind (`storage[].kind: cache`) | [`spec/06-services.md`](../06-services.md) |

## PRDs in this set

| #  | PRD                                                                                  | Subsystem                                                                                                                       | US range        | Depends on              |
| -- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- | --------------- | ----------------------- |
| 01 | [Setup & uninstall completion](./prd-beta-1-01-setup-and-uninstall.md)                  | full `lando setup` across platforms, idempotency/re-entrancy, readiness summary, first-class `lando uninstall`, dual-path parity | US-200..US-207  | —                       |
| 02 | [Open-decision resolution & plugin trust](./prd-beta-1-02-open-decisions-and-trust.md)  | §14.2 closures: Bun floor, OCLIF lock, auto-setup level, Compose subset doc, `sshAgent.sidecar` opt-out, plugin trust surface    | US-208..US-214  | PRD-01                  |
| 03 | [Deprecation governance](./prd-beta-1-03-deprecation-governance.md)                     | `DeprecationNotice`, `DeprecationService`, `deprecation-used` event, 4 propagation mechanisms, renderer dedupe, release gate     | US-215..US-223  | —                       |
| 04 | [Schema publication, reference docs & Landofile serialization](./prd-beta-1-04-schema-publication.md) | JSON Schema export, generated MDX reference, `x-deprecation`, `@lando/sdk/landofile` serializer, round-trip contract suite | US-224..US-229, US-307..US-310 | PRD-03 |
| 05 | [Plugin authoring toolkit](./prd-beta-1-05-plugin-authoring-toolkit.md)                 | `meta:plugin:new/test/build/link/unlink/publish`, bundled templates, `BunSelfRunner` routing, `plugin-auth.json`               | US-230..US-236  | PRD-02                  |
| 06 | [Telemetry & redaction](./prd-beta-1-06-telemetry.md)                                   | default-on telemetry inventory, canonical redaction primitive, `RedactionService`, retention, opt-out command + config key + env | US-237..US-242, US-298..US-301 | PRD-03, PRD-04, PRD-07, PRD-09 |
| 07 | [Executable guides & scenarios — full](./prd-beta-1-07-executable-guides-full.md)       | full component vocabulary, `ScenarioContext`, public transcripts, source-location, full lint gates, recipe README, e2e `@smoke` | US-243..US-250  | Alpha 3 PRD-12          |
| 08 | [Release engineering & code signing](./prd-beta-1-08-release-and-signing.md)            | `scripts/release.ts` 13-stage orchestrator, deprecation gate, macOS/Windows/Linux signing + notarization                       | US-251..US-257  | PRD-03, PRD-04          |
| 09 | [Supply chain, self-update & verified downloads](./prd-beta-1-09-supply-chain-and-self-update.md) | SBOM/SLSA/cosign release artifacts, signed update manifest, atomic re-exec/rollback, shared `Downloader` primitive and artifact download migration | US-258..US-265, US-285..US-288 | PRD-01, PRD-04, PRD-08 |
| 10 | [Installers & distribution channels](./prd-beta-1-10-installers-and-channels.md)        | GitHub Releases artifact set, `get.lando.dev/install.{sh,ps1}`, vendored trust roots, `LANDO_INSTALL_DIR`, signed installers    | US-266..US-271  | PRD-09                  |
| 11 | [Library API stability & §17.9 acceptance](./prd-beta-1-11-library-and-acceptance.md)   | `@lando/core/testing` stable on `next`, full §16.2 contract suite, stable App handles/runtime object, plugin SDK `^4.0.0`, §17.9 acceptance on linux-x64 | US-272..US-279, US-289..US-292 | PRD-01 through PRD-10    |
| 12 | [Terminal UI polish & interaction service](./prd-beta-1-12-terminal-ui-polish.md)       | bundled `@lando/renderer-lando` seam, spaceship-console renderer polish, OpenTUI-backed prompts, `InteractionService`, `PromptSpec`, `editor` prompt type | US-280..US-284, US-293..US-297 | PRD-01, PRD-04, PRD-05, PRD-07, PRD-11 |
| 13 | [Paths/Roots & durable StateStore](./prd-beta-1-13-paths-and-state-store.md)            | `@lando/core/paths` resolver, `PathsService`, `GlobalConfig` root fields, durable `StateStore`, scratch-registry/include-lockfile migration, contract suite | US-302..US-306, US-311..US-315 | PRD-01, PRD-04, PRD-11 |
| 14 | [Probe, EventService query & plugin contract kit](./prd-beta-1-14-probe-events-contract-kit.md) | `@lando/sdk/probe` retry/verdict primitive + consumer migration, `EventService` `waitFor`/`query` + bounded redacted history, the six §4.2 plugin-abstraction contract suites | US-316..US-321 | PRD-04, PRD-06, PRD-09, PRD-11 |
| 15 | [Universal `--format json` machine output](./prd-beta-1-15-universal-json-output.md) | `CommandResultEnvelope`/`StreamFrame` schemas, required `LandoCommandSpec.resultSchema`, universal `--format json` + `--json`/`-j` shorthand, single `encodeCommandResult` redaction-aware seam, conformance + boundary gates | US-322..US-329 | PRD-04, PRD-06, PRD-11, PRD-14 |
| 16 | [Data movement & volume primitives](./prd-beta-1-16-data-mover-and-volumes.md) | `DataMover` local/volume byte-movement chokepoint + `DataEndpoint` model, `RuntimeProvider` data plane (mount-aware `EphemeralRunSpec`/`runStream` + 8 methods + 5 capabilities), snapshot store on `PathsService`+`StateStore`, shared streaming-hash helper, scratch-copy/Downloader refactors, cache-volume `kind` | US-333..US-341 | PRD-04, PRD-09, PRD-11, PRD-13 |

## Dependency graph

```text
  ┌──────────────────────────┐        ┌──────────────────────────┐
  │ 01 Setup & uninstall     │        │ 03 Deprecation governance│
  └─────────┬────────────────┘        └─────────┬────────────────┘
            │                                   │
            ▼                          ┌─────────┴─────────┐
  ┌──────────────────────────┐         ▼                   ▼
  │ 02 Open decisions + trust│  ┌──────────────┐   ┌──────────────┐
  └─────────┬────────────────┘  │ 04 Schema +  │   │ 06 Telemetry │
            │                   │    landofile │   │ + redaction  │
            ▼                   └──────┬───────┘   └──────┬───────┘
  ┌──────────────────────────┐         │                  │
  │ 05 Plugin authoring kit  │         │                  │
  └──────────────────────────┘         │                  │
                                       │                  │
  ┌──────────────────────────┐         │                  │
  │ 07 Executable guides full│         │   (depends on Alpha 3 PRD-12)
  └──────────────────────────┘         │                  │
                                       ▼                  │
                            ┌────────────────────────┐    │
                            │ 08 Release & signing   │    │
                            └───────────┬────────────┘    │
                                        ▼                 │
                            ┌────────────────────────┐    │
                            │ 09 Supply chain +      │◄───┘
                            │    downloader/update   │
                            └───────────┬────────────┘
                                        ▼
                            ┌────────────────────────┐
                            │ 10 Installers + channels│
                            └───────────┬────────────┘
                                        ▼
                  ┌────────────────────────────────────────┐
                  │ 11 Library API + §17.9 acceptance      │
                  │    (depends on 01–10)                  │
                  └────────────────────────────────────────┘
                            │            │            │
                            ▼            ▼            ▼
                  ┌────────────────┐ ┌──────────────┐ ┌────────────────────┐
                  │ 12 Terminal UI │ │ 13 Paths/    │ │ 14 Probe + events  │
                  │  + interaction │ │  Roots +     │ │  + contract kit    │
                  │                │ │  StateStore  │ │  (also 04, 06, 09) │
                  └────────────────┘ └──────┬───────┘ └────────────────────┘
                            │                │                │
                            ▼                ▼                ▼
                  ┌────────────────┐ ┌──────────────────────────────────┐
                  │ 15 Universal   │ │ 16 Data movement & volumes       │
                  │  JSON output   │ │  DataMover + provider data plane │
                  │  (also 04,06,  │ │  (also 04, 09, 11; 13 for Paths/ │
                  │   11, 14)      │ │   StateStore)                    │
                  └────────────────┘ └──────────────────────────────────┘
```

## Verification contract (applies to every story in every PRD)

- [ ] Failing test exists before implementation and is part of the same PR series.
- [ ] After implementation, that specific test passes locally with `bun test <path>`.
- [ ] `bun run typecheck` passes.
- [ ] `bun run lint` passes.
- [ ] Whole-workspace `bun test` passes; no test removed or skipped to make this true.
- [ ] If the story changes generated files, `bun run codegen` is run and committed; generated guide-scenario tests remain gitignored per §19.7.
- [ ] If the story affects the compiled binary, source CLI and compiled `$bunfs` behavior are both verified (dual-dispatch parity per §8.4.1 / §13.1).
- [ ] Live provider, signing, notarization, and installer tests remain explicitly gated by environment variables / credentials and are skipped on machines lacking them (local rehearsal via `LOCAL_REHEARSAL=1`).
- [ ] If the story adds or changes Effect Schemas exposed by `@lando/sdk`, the §13.2 schema-snapshot gate runs cleanly and `sdk/API_COMPATIBILITY.md` plus relevant fixtures are updated.
- [ ] If the story adds a new public export to `@lando/core`, the §16/§9 import-boundary test is updated and the default entry stays OCLIF-free.
- [ ] If the story adds or removes a deprecation, `scripts/check-deprecations.ts` passes and test/docs/changelog are updated together (§18.7).
- [ ] If the story touches a CLI/source surface declared in any PRD's §Guide Coverage section, the PR also touches the listed guide(s) or carries a `Guide-Coverage-Skip:` reason ≥ 24 chars. `bun run check:guide-coverage` and `bun run check:guide-drift` pass.

## Carry-forward into Beta 1

The following items were explicitly deferred to Beta 1 by prior PRDs, the ROADMAP, and AGENTS.md. Each is ticketed inside one of the sub-PRDs below.

| Carry-forward                                                                                  | Source                | Picked up by              |
| ---------------------------------------------------------------------------------------------- | --------------------- | ------------------------- |
| `lando setup` full cross-platform behavior (provider, Mutagen, CA trust, host, shell-env)      | Alpha 1 PRD-07, §10.8 | PRD-01 US-200..US-203     |
| `lando setup` idempotency / re-entrancy + readiness summary for `lando doctor`                 | ROADMAP Beta 1, §10.9 | PRD-01 US-204             |
| First-class `lando uninstall` (`--yes`/`--dry-run`/`--keep-data`/`--purge`, enumerate steps)   | ROADMAP Beta 1, §8.2  | PRD-01 US-205..US-207     |
| §14.2 Bun version floor decision (confirm `>=1.3.14` or bump)                                   | §14.2                 | PRD-02 US-208             |
| §14.2 OCLIF major version lock (v4 vs v5)                                                       | §14.2                 | PRD-02 US-209             |
| §14.2 Auto-setup level (aggressive vs guided opt-in)                                            | §14.2                 | PRD-02 US-210             |
| §14.2 Compose compatibility subset documented + per-key remediation                            | §14.2, §7             | PRD-02 US-211             |
| §14.2 `sshAgent.sidecar: false` opt-out: ship-or-reject                                         | §14.2, §10.4          | PRD-02 US-212             |
| §14.2 Plugin postinstall trust model: command surface + `plugin-trust.yml` schema published    | §14.2, §9             | PRD-02 US-213..US-214     |
| Deprecation governance (§18) — notice schema, service, event, propagation, release gate, doctor | Alpha 3 (governance)  | PRD-03 US-215..US-223     |
| Schema publication (§7.8) — JSON Schema export, MDX reference, schema gate, GA cache prep       | Alpha 3 (governance)  | PRD-04 US-224..US-229     |
| Canonical Landofile serializer primitive (`@lando/sdk/landofile` / `@lando/core/landofile`) + round-trip law + emitter/parser consolidation | §7.8.1, §2.7, §16.2, §9.5 | PRD-04 US-307..US-310 |
| Plugin authoring toolkit (§9.10) — `meta:plugin:new/test/build/link/unlink/publish`            | Alpha 3 PRD-11        | PRD-05 US-230..US-236     |
| Telemetry — default-on inventory, retention, disablement, and canonical redaction primitive      | ROADMAP Beta 1, §3.7  | PRD-06 US-237..US-242, US-298..US-301 |
| Executable guides full pipeline (§19) — public transcripts, full vocabulary, lint, recipe READMEs | Alpha 2/3 PRD-12   | PRD-07 US-243..US-250     |
| Release engineering (§17.1–17.4) — `scripts/release.ts`, code signing on all platforms          | Alpha 3 (release-eng) | PRD-08 US-251..US-257     |
| Supply chain (§17.5), self-update (§17.6), and the layered outbound-network primitives (`HttpClient` egress chokepoint, `Downloader` verified-artifact wrapper, tool provisioning) | Alpha 3 (release-eng), §10.3.2–§10.3.4 | PRD-09 US-258..US-265, US-285..US-288, US-330..US-332 |
| Installers (§17.7) — GitHub Releases + curl-pipe installers                                     | Alpha 3 (release-eng) | PRD-10 US-266..US-271     |
| `@lando/core/testing` stable on `next` + full §16.2 library contract suite                      | Alpha 3 PRD-11        | PRD-11 US-272..US-275     |
| §17.9 binary acceptance machinery green on the reference platform (linux-x64)                   | ROADMAP Beta 1, §17.9 | PRD-11 US-276..US-279     |
| Bundled default renderer plugin, terminal UI polish, and shared `InteractionService` primitive    | §8.9/§8.10 renderer + interaction contracts | PRD-12 US-280..US-284, US-293..US-297 |
| Stable App/App-handle embedding primitive + retained runtime object                              | §16                  | PRD-11 US-289..US-292     |
| Public Paths/Roots primitive (`@lando/core/paths` + `PathsService`) + `GlobalConfig` `userCacheRoot`/`systemPluginRoot` + path-resolution consolidation | §7.5.1, §2.7, §16.2 | PRD-13 US-302..US-306 |
| Durable state-store primitive (`StateStore` core service) + scratch-registry/include-lockfile consolidation + plugin/host exposure | §12.7, §3.4, §4.2, §9.8 | PRD-13 US-311..US-315 |
| `@lando/sdk/probe` retry/verdict primitive + healthcheck/scanner/doctor/downloader/setup-readiness migration + retry-loop boundary gate | §10.5.1, §10.5, §13.4 | PRD-14 US-316..US-317 |
| `EventService` typed `waitFor`/`waitForAll`/`query` + bounded redacted history + `@lando/core/testing` helper rewire | §11.1, §16.8 | PRD-14 US-318 |
| §4.2 plugin-abstraction contract kit (tooling-engine / route-filter / secret-store / config-translator / plugin-source / doctor-check) + layer-coverage gate | §13.1, §4.2, §9.5 | PRD-14 US-319..US-321 |
| Universal machine-output contract (`CommandResultEnvelope`/`StreamFrame` schemas, required `LandoCommandSpec.resultSchema`, universal `--format json` + `--json`/`-j`, `encodeCommandResult` redaction seam) + conformance/boundary gates | §8.11, §8.3, §7.8, §13.1, §13.4 | PRD-15 US-322..US-329 |
| `DataMover` local/volume byte-movement primitive + `RuntimeProvider` data plane (capabilities/methods/mount-aware run) + snapshot store on Paths/StateStore + shared streaming-hash helper + scratch-copy/Downloader refactors + cache-volume `kind` | §10.11, §5.3–§5.4, §3.4/§3.5, §6.5, §12.4 | PRD-16 US-333..US-341 |

## Exit criteria for Beta 1

Every Beta 1 deliverable above is accepted, including the completed `lando setup` / `lando uninstall` surface, schema publication plus the Landofile serializer, telemetry plus redaction, supply-chain/self-update plus the shared `Downloader`, terminal UI polish plus `InteractionService`, the paired Paths/Roots + durable `StateStore` primitives, the stable App-handle embedding primitive, the remaining SDK primitive trio (`@lando/sdk/probe`, the `EventService` query/history surface, and the §4.2 plugin-abstraction contract kit), and the `DataMover` local/volume byte-movement primitive plus the `RuntimeProvider` data plane (§10.11), and the first signed `4.0.0-beta.N` pre-release ships from CI on the `next` channel. **Feature freeze is entered** — no spec section is being added from here on. The §17.9 release machinery runs green on the reference platform; the all-platform acceptance pass is the RC gate.

## Cross-cutting conventions

- **Dual-dispatch parity (§8.4.1):** every new canonical command (`meta:uninstall`, `meta:plugin:*`, `meta:update`, etc.) must dispatch identically in the OCLIF source path and the compiled `$bunfs` `runCompiledCli` dispatcher; add the `argv[0]` branch in the same change and keep the §13.1 parity layer green.
- **Renderer boundary (§13.4):** all command output flows through the `Renderer` service; no direct `console.*` / `process.std*.write` outside the two §2.4 carve-outs. The release/installer scripts under `scripts/` are tooling, not `core/src/**`, and are exempt from the boundary lint.
- **SDK freeze:** anything exported from `@lando/sdk` is compatibility-locked on first ship; follow `sdk/AGENTS.md` and update `sdk/API_COMPATIBILITY.md`, fixtures, and the schema snapshot together.
- **Destructive-confirmation rule:** every destructive command (`uninstall`, `meta:global:destroy`, `--purge`) is gated behind explicit `--yes` and offers `--dry-run`; every destructive step is enumerated before execution.
