# Lando v4 — Development Phases

> **Status:** Living document. Updated as phases close or scope shifts.
> **Audience:** Core maintainers and contributors.
> **Source of truth:** The nineteen spec parts in this directory. When this document and a spec part disagree, the spec part wins. Update both when scope changes.

---

## Phasing principles (what each boundary protects)

1. **MVP → Alpha 1**: prove the architecture works end-to-end on the *easiest* surface. One provider, one service, the happy path. No promises.
2. **Alpha 1 → Alpha 2 → Alpha 3**: breadth across the catalog (service types, providers, plugins) with the bundled set hardened, the executable-guides scenario engine, and the global app + scratch apps. Library API usable internally; docs not yet stable. Published on the `dev` channel as `4.0.0-alpha.N`.
3. **Alpha 3 → Beta 1**: the **last feature surface**. Governance contracts go live (deprecation, signing, supply chain, schema publication, executable-guides-as-scenarios), the plugin authoring toolkit and telemetry land, and the remaining `lando setup` / `lando uninstall` functionality is completed. Open decisions in §14.2 are closed. Published on the `next` channel as `4.0.0-beta.N`.
4. **Beta 1 → Beta 2**: **feature freeze**. No new feature surface — only bug fixes surfaced by Beta 1 field use. Still `4.0.0-beta.N` on `next`.
5. **Beta 2 → RC**: only fixes, plus the §17.9 binary acceptance criteria (signed, notarized, SBOM, self-update, curl-pipe installer all green on all platforms). Tagged `4.0.0-rc.N`.
6. **RC → 4.0 GA**: only the bug fixes found during RC. Tag bump to `4.0.0` on `stable`.
7. **4.x minors**: address things explicitly listed as "deferred to post-v4.0" in §14.2 and §6.12, in priority order.

The `@lando/sdk` (schemas, tagged errors, service tags, event payloads) crosses every phase. Anything that ends up in `@lando/sdk` is **API-stable from the moment it ships in MVP** — that is the entire point of the SDK boundary. Everything else can iterate.

---

## Phase 0 — Where we are today

**Status as of repo state:**

- Workspace structure exists (`@lando/core`, `@lando/sdk`, 6 bundled plugin packages).
- `BootstrapLevel` declared with strict ranking (`core/src/runtime/bootstrap.ts`).
- `makeLandoRuntime` schema declared; factory body is TODO (`core/src/runtime/layer.ts`).
- OCLIF command shells exist for ~25 commands (`core/src/cli/oclif/commands`); every `run()` body is `Effect.die("not yet implemented")`.
- Plugin packages contain only `PLUGIN_NAME` constants — no Layers yet.
- `bundled.ts` is an empty generated stub (`core/src/plugins/bundled.ts`).
- `tsc -b` clean; `bun test` runs (no real assertions yet).

**What "Phase 0" means here**: scaffolding is done — the type system says the right shapes; the bodies don't exist yet.

---

## Phase 1 — MVP ("walking skeleton")

> **One sentence**: One developer can run `lando start` against one app with one service on Linux x64 with system Docker installed, and see it work.
>
> **Audience**: core maintainers only. Not published anywhere.
> **Duration estimate**: largest single phase — everything comes from zero.

### Goal

Prove the architecture end-to-end on the *single easiest* path. No breadth, no polish, no Lando-managed runtime, no global app, no scratch apps.

### Why `@lando/provider-lando` must be prototyped at MVP

`@lando/provider-lando` is the most architecturally novel and highest-risk component in the entire system. It is prototyped at MVP — not deferred to Alpha 3 — for three reasons:

1. **It is the default.** Every user who installs Lando without a pre-existing Docker installation hits this provider. The `RuntimeProvider` contract must be shaped by the reference implementation, not retrofitted around Docker afterward.
2. **The key architectural bet lives here.** §5.2 principle 1: "Core never shells out to provider binaries." `@lando/provider-lando` implements this by talking directly to a private Podman API socket via `Bun.spawn`-driven RPC — not to a `podman` binary on `PATH`. If that model doesn't work as specced, the entire `RuntimeProvider` interface needs redesign. Discovering this in Alpha 3 would be catastrophic.
3. **Linux is actually not that complex.** On Linux, `@lando/provider-lando` declares `bindMountPerformance: "native"` and requires no VM — just a private Podman socket + a storage root. The hard parts (macOS Podman machine lifecycle, Windows WSL2 management, runtime bundle download + checksum verification) are explicitly deferred to Alpha 1/Alpha 3.

`@lando/provider-docker` is prototyped alongside as a developer escape hatch (for contributors who already have Docker Engine running), but it is a secondary validation path, not the primary target.

### Cuts that make this phase finishable

- **Provider (Lando-managed)**: Linux only — private Podman socket, no VM management, no runtime bundle download. Manual Podman install required on the dev machine. macOS/Windows VM lifecycle deferred to Alpha 1.
- **Provider (Docker)**: Linux Docker Engine only, as a parallel developer convenience — not the primary target.
- **Service types**: only `node:lts` + `postgres` (minimal). Skip framework-aware presets, skip the full canonical catalog.
- **Renderer**: plain text only. No concurrent task tree, no first-paint banner, no detail/expand/collapse.
- **Recipes**: hardcoded single built-in recipe. No `recipe.yml` parser, no remote sources, no prompts beyond `--name`.
- **Plugin loader**: bundled-only. No system/user/app discovery, no install/update, no manifest validation depth.
- **Cache**: in-memory only for MVP. Persistent caches per §12.1 come in Alpha 1.
- **Compose-subset input**: only the keys the two service types need.
- **Library API**: internal-only — used by `bun test`; not stable, not documented.

### Concrete deliverables

**Foundation (runtime + bootstrap):**
- `LandoRuntimeLive` Layer composes for bootstrap levels `none`, `minimal`, `commands`, `provider`, `app`. `plugins` and `tooling` levels can be skeleton-only.
- `makeLandoRuntime` factory implemented for the CLI shell. Library mode can throw `NotImplemented` for now.
- OCLIF `init` hook reads bootstrap level off resolved command and provides the matching layer (§3.2).
- Pre-OCLIF `none`-level fast path for `--version`, `-v`, `version`.

**Effect services (minimum set):**
- `ProcessRunner` (Bun.spawn-backed)
- `ShellRunner` (Bun.$-backed) — needed by `host` ToolingEngine
- `FileSystem` (Bun.file-backed)
- `ConfigService` — global config + env overlay only
- `LandofileService` — YAML parser + minimal Compose subset; no `includes:`, no `landofile.ts`, no expressions
- `EventService` — basic publish/subscribe; no priority bands yet, no payload schemas beyond what start/stop need
- `Logger` — Effect built-in `Logger.pretty`
- `CacheService` — in-memory only
- `PluginRegistry` — reads `BUNDLED_PLUGINS` array only
- `RuntimeProvider` + `RuntimeProviderRegistry` — single-implementation picker
- `AppPlanner` — produces a minimal `AppPlan` with services + one mount + endpoints
- `BuildOrchestrator` — sequential, no group weighting

**SDK contracts shipped (these become semver-stable on first ship — §16.9):**
- `AppRef`, `AppPlan`, `ServicePlan`, `ProviderCapabilities` (full schema, even if only one capability is exercised)
- `BootstrapLevel`
- `Logger`, `EventService`, `RuntimeProvider`, `ConfigService`, `LandofileService`, `PluginRegistry`, `CacheService`, `FileSystem`, `ProcessRunner`, `ShellRunner` Effect Service tags
- Tagged errors: `LandoRuntimeBootstrapError`, `ProviderCapabilityError`, `LandofileParseError`, `PluginLoadError`, `NoProviderInstalledError`
- The 8–10 lifecycle events that `app:start`/`app:stop` publishes (`pre-app-start`, `post-app-start`, `pre-service-start`, etc. — full set per §3.5)

**Bundled plugins (Layer bodies):**
- `@lando/provider-lando` — **primary target.** `RuntimeProvider` Live Layer for Linux (private Podman socket). Prototype scope: download + store a pinned Podman binary on first `lando setup`, start the Podman socket, emit a Compose file to a per-app temp dir (internal only), `Bun.spawn`-driven exec against the private socket, `docker logs`-equivalent via the Podman API, capability matrix population via API introspection (not `podman` on PATH). VM lifecycle skipped.
- `@lando/provider-docker` — secondary / developer escape hatch. `RuntimeProvider` Live Layer for Linux Docker Engine. Compose emission + `docker exec` + `docker logs --follow` + Bun.spawn. Exists to let contributors who already have Docker validate the same `RuntimeProvider` contract from a different adapter.
- `@lando/service-lando` — minimal `lando` service base + the `node` and `postgres` `ServiceType` impls.
- `@lando/logger-pretty` — bundled but empty (Effect's default `Logger.pretty` is good enough for MVP).

**CLI commands working end-to-end:**
- `lando start` / `app:start`
- `lando stop` / `app:stop`
- `lando info` / `app:info` (basic — service list + endpoints)
- `lando version`, `lando shellenv` (bootstrap `none` — no Effect runtime)
- `lando init` only with `--full` flag pointing at the single hardcoded recipe — no prompts

**Build / test:**
- `bun test` runs unit + Effect-service tests
- `bun build --compile` produces a Linux x64 binary that runs on the dev's machine
- `tsc -b` clean
- `biome check .` clean

**CI (per-PR, Linux x64 only — see PRD-07):**
- `static-checks` job: typecheck + lint + non-integration `bun test`
- `build-linux-x64` job: `bun build --compile` + `--version`/`--help` smoke + uploads `dist/lando` as the `lando-linux-x64` workflow artifact (7-day retention)
- `provider-integration-linux-x64` job: starts a private Podman socket in the runner, runs the full `*.integration.test.ts` suite + the MVP exit-criteria scenario test against the bundled `@lando/provider-lando`
- All three jobs are required for merge to `main`
- No GitHub Releases, no tagged binaries, no signing, no installer scripts, no `dev` channel, no nightly cron — those are Alpha 1+
- `.github/workflows/ci.yml` is generated by `scripts/build-ci-workflow.ts` (called from `scripts/codegen.ts`) — hand-edits forbidden

### Exit criteria for MVP

```bash
git clone … && bun install && bun run codegen && bun test && bun run build && \
  ./dist/lando init --full && cd <created-dir> && ../dist/lando start && ../dist/lando info
```

…produces a working Node + Postgres app on Linux via the Lando-managed runtime (private Podman). Docker path works too; the Lando-managed runtime is the primary assertion.

---

## Phase 2 — Alpha 1 ("happy path coverage")

> **One sentence**: A team can adopt Lando v4 for a real PHP/Drupal, Node, Python/Django, or Ruby/Rails project on Linux + macOS — using the Lando-managed runtime with no Docker prerequisite — and most things work most of the time.
>
> **Audience**: alpha testers willing to file bugs. Published on the `dev` channel only.

### Goal

Breadth that covers the most common stacks. Persistent caches. Tooling system real. Recipes real. Library API usable internally.

### Concrete deliverables

**Service catalog (the "common stack" subset):**
- `php:8.2`, `php:8.3` with `framework: drupal|wordpress|laravel|symfony|none`
- `node:lts`, `node:22`
- `python:3.12` with `framework: django|fastapi|flask|none`
- `ruby:3.3` with `framework: rails|none`
- `mysql`, `mariadb`, `postgres`
- `redis`
- `nginx`, `apache`
- `static` + raw Compose passthrough
- *Defer*: Go, MongoDB, Solr, Elastic, Opensearch, Meilisearch, Memcached, Valkey, Mailpit (Alpha 3)

**Tooling system (§8.5–8.7):**
- `tooling:` Landofile section parsed
- Both built-in `ToolingEngine`s: `providerExec` (default) + `host` (Bun.$)
- `cmds:` arrays, `service:`, `description:`, basic `vars:`
- Tooling compilation pipeline (cold path); hot path is Alpha 3
- `.bun.sh` script-backed tasks (§8.5.9)
- `lando exec`, `lando ssh`, `lando shell` (host mode only — service mode in Alpha 3)

**Recipes (§8.8):**
- `recipe.yml` parser (full schema)
- All built-in prompt types: text, select, multiselect, confirm, number, secret, path
- Built-in source only (`cwd`); `git`/`tarball`/`npm`/`registry` deferred to Alpha 3
- 6–8 canonical recipes shipped with the binary (one per common stack: drupal, wordpress, laravel, node, django, rails)
- Programmatic landofile (`landofile.ts`) supported
- `postInit:` actions: `bun: { verb: install }` only; `script`/`add`/`create`/`run`/`x` deferred
- *Defer*: dynamic `choicesFrom:`, `runs:` allowlist, `fetchAllowlist:`, programmatic `recipe.ts`

**Renderer:**
- Concurrent task tree: `task.tree.start`, `task.start`, `task.complete`, `task.fail` (§8.9)
- `message.info`/`warn`/`error`
- `paint.banner` first-paint contract (basic)
- `--renderer=plain|json|lando` selection
- *Defer*: `task.detail` streaming tail, expand/collapse, full first-paint contract (Beta 1)

**Provider:**
- `@lando/provider-lando` macOS — adds managed Podman machine lifecycle (create, start, stop, upgrade, teardown). `bindMountPerformance: "slow"` declared. `lando setup` downloads and verifies the runtime bundle; checksum verification per §5.8.1. This is the first real end-to-end test of the full managed-runtime path.
- `@lando/provider-lando` Linux — mature from MVP prototype: runtime bundle download + checksum verification, `lando setup` fully automated, capability matrix complete.
- `@lando/provider-docker` Linux + macOS (Docker Desktop, with `bindMountPerformance: "slow"` declared) — feature-complete as an alternative path.
- *Defer*: `@lando/provider-lando` Windows VM management (Alpha 3)
- *Defer*: `@lando/provider-podman` opt-in (Alpha 3)

**Mounts + storage:**
- App-root bind mount
- `mounts:` with `type: bind` and `type: volume`
- `excludes:` patterns (volume-shadow only — Mutagen sync is Alpha 3)
- Storage `scope: app`, `scope: service` (no `scope: global` until global app lands)
- `LANDO_*` env vars (basic set: app id, service id, host paths)

**Caches (§12):**
- Persistent `cwd-app-map` cache
- App plan cache
- Plugin command index cache
- Binary cache encoding rules (§12.2)
- Atomicity: write-temp-then-rename

**Subsystems (§10):**
- Networking intent (per-app bridge — no shared cross-app network yet)
- Healthchecks (provider-exec mode only)
- *Defer*: proxy, certs, SSH, scanner, host integration (Alpha 3 — they need the global app)

**Library API:**
- `makeLandoRuntime` works for `bootstrap: "app"` (smaller levels too)
- `@lando/core/testing` exists with `TestRuntimeProvider`
- `@lando/core/cli` lets a host invoke commands
- Stability: `unstable` (channel `next`/`dev` only)

**CLI commands working:**
- All `app:*` commands except `app:cache:refresh`'s deeper modes, `app:includes:*`, `app:config:translate`
- `apps:init` interactive (full prompt flow)
- `apps:list`
- `apps:poweroff`
- `meta:config`, `meta:plugin:add` (npm source only), `meta:plugin:remove`, `meta:setup` (basic), `meta:doctor` (basic), `meta:bun`, `meta:x`
- *Defer*: `apps:scratch:*`, `meta:global:*`, `meta:plugin:trust*`, `meta:plugin:new/test/build/link/unlink/publish`

**Test layers (§13.1):**
- Unit + Effect service + CLI + scenario + recipe layers green
- Library API layer green for the surface that exists
- Provider contract suite drafted in `@lando/sdk/test`; `TestRuntimeProvider` passes; Docker provider passes (Lando provider on Linux only)

**CI (extending the MVP baseline established in PRD-07):**
- MVP already provides: per-PR `static-checks` + `build-linux-x64` + `provider-integration-linux-x64` on Linux x64.
- Alpha 1 adds: schema gate (`spec/13` schema-snapshot diff), workflow-artifact promotion to a `dev`-channel GitHub pre-release (no signing yet), library-API + recipe test layers in CI.
- Alpha 1 defers: multi-platform matrix (Alpha 3), nightly cron (Alpha 3), weekly provider matrix (Alpha 3).

**Distribution:**
- Linux x64 binary promoted from MVP's per-PR workflow artifact to a GitHub pre-release (still no signing, no SBOM, no installer scripts, no self-update — those are Beta 1).
- `@lando/core` published to npm at version `4.0.0-alpha.N` on the `dev` tag
- (Note: MVP itself is private — the binary lives only as a per-run workflow artifact per PRD-07. Alpha 1 is the first phase that ships anything externally.)

### Exit criteria for Alpha 1

External alpha testers can scaffold a Drupal or Rails project, run `lando start`, run `lando drush`/`lando rails`, and have it work without touching internals. Bug rate is the gating signal — close the worst-N before tagging Alpha 3.


---

## Phase 2.5 — Alpha 2 ("guide scenario engine")

> **One sentence**: Lando's authored guides can generate and run scenario-layer tests, including hidden guide-local edge cases, without requiring the full docs site renderer.
>
> **Audience**: core maintainers and guide authors preparing the public Alpha 1 surface.

### Goal

Introduce the testing half of §19's Executable Guides model. Alpha 2 does **not** add broad product capability; it makes guides and scenario coverage share one source of truth before Alpha 3 expands the runtime surface.

### Concrete deliverables

**Executable Guides + Scenarios (§19):**
- Rename the docs-as-tests model from executable tutorials to **Executable Guides**: MDX-authored guides that define runnable **Scenarios**.
- Make **Scenario** the engine primitive: generated tests are per scenario variant, not per page.
- Support one rendered reader scenario per guide plus guide-local `render={false}` test-only scenarios for related edge cases and regressions.
- Keep Diátaxis as editorial metadata (`tutorial` / `how-to` / `explanation` / `reference`), not as the execution model. Public docs may group tutorials and how-tos under "Guides".
- Preserve the regular scenario suite for non-documentary coverage; broad regressions and shared invariants stay in standalone scenario fixtures rather than hidden guide blocks.

**Alpha 2 generator slice:**
- `scripts/build-guide-scenarios.ts` parses a minimal executable-guide subset and generates TypeScript tests under `test/scenarios/generated/guides/**`.
- A compatibility `scripts/build-doc-tests.ts` alias may exist during migration, but `build-guide-scenarios` is the spec-owned generator name.
- Initial component subset: `<Guide>`, `<Scenario>`, `<Step>`, `<Run>`, `<Verify>`, `<Cleanup>`, `<Variable>`, `<Hidden>`, and `<UseFixture>`.
- Scenario layer only at first: `layer: "scenario"` runs against `@lando/core/testing` / `TestRuntimeProvider`. Real-provider `layer: "e2e"` guide scenarios remain Alpha 3+/Beta 1 hardening.
- Generated tests carry `// @source`, `// @scenario`, and optional `// @variant` headers.

**Author/debug workflow:**
- Add a focused local command such as `bun run docs:scenario <guide-id>` with `--scenario`, `--variant`, `--keep`, `--debug`, and `--explain` behavior.
- Add source-mapped failure reporting so guide-sourced failures point at MDX or colocated case files before generated `.ts` files.
- Add fixture-copy discipline: guide fixtures are immutable inputs copied into temp scenario roots before mutation.

**Transcripts (test side only):**
- Write internal transcript artifacts for scenario runs.
- Public docs consume only visible reader-scenario frames later; hidden blocks, test-only scenarios, fixtures, and internal event traces are excluded from public transcript frames.
- Do **not** build Starlight rendering or transcript embedding in Alpha 2.

**CI / gates:**
- Add a focused generated-guide-scenario test gate: generator exits 0, generated TypeScript type-checks, and generated scenario tests pass.
- Add minimal lint for executable guides: valid frontmatter, unique scenario ids, required reasons for test-only scenarios, and no rendered executable components in explanation/reference pages.
- Defer full guide lint, full component schema publication, tabs/axes matrix breadth, public transcript rendering, and recipe README strip/flatten to later phases unless needed by an Alpha 1 recipe.

### Exit criteria for Alpha 2

At least one authored guide generates and runs a passing `layer: "scenario"` reader scenario against `TestRuntimeProvider`, at least one hidden guide-local test-only scenario runs without rendering, failures map back to guide source coordinates, and no docs-site render is required for the test gate.

---

## Phase 3 — Alpha 3 ("full breadth")

> **One sentence**: All the bundled plugins work, all canonical service types ship, both providers work on every platform, the global app and scratch apps are usable.
>
> **Audience**: alpha testers on the `dev` channel.

### Goal

Complete the breadth surface — every canonical service type, both providers on every platform, the global app, and scratch apps. The remaining feature work (governance, release engineering, and the `lando setup` / `lando uninstall` completion) is held for Beta 1; from there it is hardening only.

### Concrete deliverables

**Full canonical service-type catalog (§6.12):** every type in the §6.12.1 table:
- Languages: `php`, `node`, `python`, `ruby`, `go`
- HTTP: `nginx`, `apache`
- DBs: `mariadb`, `mysql`, `postgres`, `mongodb`
- Caches: `redis`, `memcached`, `valkey`
- Search: `solr`, `elasticsearch`, `opensearch`, `meilisearch`
- Mail: bundled mailpit (lives in the global app)
- Other: `static`, raw Compose passthrough

**Provider matrix complete:**
- `@lando/provider-lando` on macOS + Windows (managed Podman VM lifecycle, `lando setup` downloads runtime bundle, checksum verification per §5.8.1)
- `@lando/provider-docker` on macOS + Windows (Docker Desktop)
- `@lando/provider-podman` shipped (Linux + Podman Desktop on macOS/Windows)
- All three pass the provider contract suite

**File sync:**
- `@lando/file-sync-mutagen` bundled and active for `bindMountPerformance: "slow"` providers
- Auto-selection by planner — invisible to users
- Mutagen host CLI + per-platform agents downloaded by `lando setup` (not embedded — §17.9)
- File sync engine contract suite passes

**Subsystems (§10):**
- `ProxyService` — default Live Layer realizes through Traefik *inside the global app* (§20.10.1)
- `CertificateAuthority` — `@lando/ca-mkcert`
- `SshService` (sidecar default, §10.4)
- `HealthcheckService`, `ScannerService`
- `HostProxyService`
- Networking with `sharedCrossAppNetwork` capability for global-app discovery
- `lando doctor` actually does something

**Global app (§20):**
- `GlobalAppService` core service
- `globalServices:` plugin contribution surface
- Reserved id `global`; `AppIdReservedError` enforced
- `<userDataRoot>/global/.lando.yml` materialization
- `meta:global:*` CLI namespace (start, stop, status, install, uninstall, config, destroy)
- `Global` lifecycle event scope
- Auto-start via `AppFeature.requires.globalServices`
- Bundled global services: `traefik` (proxy) + `mailpit` (mail capture)

**Scratch apps (§21):**
- `ScratchAppService`, `scratch` bootstrap level
- `apps:scratch:*` CLI namespace (start, stop, destroy, list, info, logs, gc)
- Fork mode (copy from existing app)
- Scratch mode (from recipe)
- `--isolate=full` (content copy only — copy-on-write deferred to §14.2)
- Scope-bound lifetime + finalizer
- Registry + provider-label orphan reap
- `--mount-cwd`, `--share-global-storage`

**Recipes — full breadth:**
- All sources: `cwd`, `git`, `tarball`, `npm`, `registry`
- Dynamic `choicesFrom:` (call canonical commands for prompt choices)
- `runs:` allowlist + `ctx.run`
- `fetchAllowlist:` + `ctx.fetch`
- Programmatic `recipe.ts`
- All `postInit:` `bun:` verbs: `script`, `install`, `add`, `create`, `run`, `x`

**Landofile — full schema:**
- `includes:` + `.lando.lock.yml` (§7.7)
- `app:includes:update`, `app:includes:verify`
- Configuration expressions (§7.3.1) — full pipe + filter language
- Template engines: bundled `@lando/template-handlebars` + `@lando/template-mustache`
- Env overrides (§7.6)
- `secrets:` via `SecretStore` (env-backed default)
- Config-translation framework (§7.4.1) — no specific translators required
- `app:config:translate` command

**Renderer — full contract:**
- `task.detail` streaming tails (4-line ring buffer minimum)
- `task.detail.expand` / `task.detail.collapse` keyboard
- Full first-paint contract per §8.9.1
- Built-in renderers: `lando` (default), `json`, `plain`, `verbose`

**Tooling — hot path:**
- `tooling` bootstrap level cache-only app-plan read working
- Tooling compilation cached per Landofile content
- Performance budget enforced

**Plugin install:**
- npm source full
- Postinstall script trust gating (mechanism in place; trust UX resolved per §14.2 — non-expiring trust, `meta:plugin:trust list`/`revoke` shipped)
- System + user + app discovery sources working

**Library API:**
- `EmbeddingPluginPolicy` fully wired
- All entry points published from `package.json#exports`: `/schema`, `/errors`, `/events`, `/services`, `/testing`, `/cli`, `/oclif`
- Import-boundary test enforces no OCLIF in default entry
- Library mode defaults: silent logger, json renderer, no auto-discovery, no telemetry

**CLI dispatch unification (resolved — §14.2 closed as option (b)):**
- ~~Spike: can `@oclif/core`'s `execute()` dispatch reliably inside `bun build --compile`?~~ **Done.** The spike (§14 Appendix D.1) proved it cannot through any supported public API (`Config.load` → `findRoot` and the `module-loader` runtime `import()` both break inside `$bunfs`).
- **Outcome — option (b): dual dispatch is permanent.** §8.4.1's parity rules are now normative; the compiled-binary dispatch parity test layer ships in §13.1 (`core/test/cli/parity/`), covering every canonical command id in `MVP_COMMAND_IDS` plus the §17.1 stage-7 deferred-command set; §14.2 "Compiled-binary CLI dispatch unification" is closed; AGENTS.md's three dual-dispatch notes are promoted from interim to permanent.

**Renderer wiring at the CLI command boundary (closes §14.2 row + §2.4 lint-gate prohibition):**
- Wire the `Renderer` Live Layer at the CLI command boundary per §8.9; commands stop writing through `console.log`/`console.error` in `core/src/cli/run.ts` and per-command `render` helpers.
- Add `renderer` to `GlobalConfig` Schema so the `flag > env > config > default` precedence already exposed by `core/src/cli/renderer-selection.ts` resolves end-to-end.
- Ship the §13.4 lint gate that catches direct `process.stdout.write` / `console.*` calls outside the two §2.4 carve-outs (`bin/lando.ts`, `core/src/cli/oclif/pre-renderer.ts`).
- Closes §14.2 "Renderer wiring at the CLI command boundary" and converts the §2.4 interim caveats into the originally-specified prohibitions.

**Build / distribution:**
- All 5 platform binaries: `darwin-x64`, `darwin-arm64`, `linux-x64`, `linux-arm64`, `windows-x64`
- Codegen pipeline complete: `scripts/codegen.ts`, `scripts/build-bundled-plugins.ts`
- `bundled.ts` populated with real Layer references
- AOT bootstrap-layer codegen (§17.2)
- Asset embedding (recipes, schemas, OCLIF manifest)

**CI:**
- Per-PR matrix on all 5 platforms (§13.6)
- All test layers from §13.1 green per-PR
- Nightly: full e2e against `@lando/provider-lando`, distribution rehearsal
- Weekly provider matrix (Docker Desktop, Engine, Podman Desktop, Podman, Lima, OrbStack)

**Library publishing:**
- `@lando/core` `4.0.0-alpha.N` on the `dev` channel
- Plugin SDK contract tests published

### Exit criteria for Alpha 3

Every test layer green per-PR on every platform. Weekly provider matrix is green. The `@smoke` end-to-end suite passes on Linux x64. The breadth surface is complete; the remaining feature work (governance, release engineering, and `lando setup` / `lando uninstall` completion) moves to Beta 1, where feature freeze is entered.

---

## Phase 4 — Beta 1 ("governance + the last feature surface")

> **One sentence**: The governance contracts go live, the open decisions in §14.2 are closed, and the **remaining `lando setup` / `lando uninstall` functionality** is completed — this is the final phase that adds feature surface.
>
> **Audience**: production users on the `next` channel. Public `4.0.0-beta.N` binaries.

### Goal

Land the last feature surface — release engineering, governance, the plugin authoring toolkit, telemetry, and the full `setup`/`uninstall` command behavior — then **freeze**. Everything after Beta 1 is hardening only.

### Concrete deliverables

**Setup & uninstall — remaining functionality (closes the `lando setup` / `lando uninstall` surface):**
- `lando setup` completes its full §17 behavior across all platforms: provider runtime acquisition, Mutagen host CLI + agent download, CA trust-store install, host integration, and shell-env install — with actionable, per-platform remediation on every failure.
- `lando setup` is idempotent and re-entrant (safe to re-run; reports already-satisfied steps), and reports a complete readiness summary consumable by `lando doctor`.
- `lando uninstall` ships as a first-class command: removes managed provider runtimes/machines, downloaded Mutagen binaries, the CA root (with trust-store removal), global app state, caches, and the installed binary + shell-env entries — gated behind explicit confirmation (`--yes`) with a dry-run (`--dry-run`) preview.
- `uninstall` honors a `--keep-data` / `--purge` split so users can remove the toolchain while preserving (or deliberately destroying) per-app and global data; every destructive step is enumerated before execution.
- Both commands work identically across the OCLIF source path and the compiled `$bunfs` dispatcher, with parity tests.

**Open decisions resolved (§14.2) — all GA-blocking:**
- Bun version floor decided (currently `>=1.3.0` per `package.json` — confirm or bump)
- OCLIF major version locked (currently v4)
- Auto-setup level decided (aggressive vs guided opt-in)
- Telemetry: event inventory documented, redaction rules implemented, retention defined, disablement controls shipped
- Compose compatibility subset documented + every accepted/rejected key has a remediation message
- `sshAgent.sidecar: false` opt-out: ship-or-reject decided
- Plugin postinstall trust model: command surface shipped (`meta:plugin:trust <name>`, `meta:plugin:trust-authoring-root <abs>`, `meta:plugin:trust list`, `meta:plugin:trust revoke <name>`); trust is non-expiring until revoked and npm/registry trust keys on the requested package identity; `<userConfRoot>/plugin-trust.yml` schema published

**Plugin authoring toolkit (§9.10):**
- `meta:plugin:new` (scaffold)
- `meta:plugin:test` (run plugin SDK contract suite)
- `meta:plugin:build`
- `meta:plugin:link` / `unlink` (local dev workflow)
- `meta:plugin:publish` (login + npm publish)

**Deprecation governance (§18):**
- `DeprecationNotice` schema in `@lando/sdk`
- `DeprecationService`
- `deprecation-used` lifecycle event
- All four propagation mechanisms wired:
  - Schema annotations → JSON Schema `deprecated: true` + `x-deprecation`
  - Contract fields on every spec type
  - Manifest fields validated at plugin load
  - TSDoc `@deprecated` + `markDeprecated()` runtime wrap
- Renderer dedupes warnings per process
- Release pipeline reads every notice and fails the release if `removeIn` matches the version being released
- `lando doctor` reports per-app deprecation use

**Schema publication (§7.8):**
- Every Effect Schema in `@lando/sdk` exports JSON Schema
- Generated reference docs (Starlight) ship with deprecation callouts
- Schema gate (§13.2) enforced in CI
- Canonical Landofile serializer (`@lando/sdk/landofile` / `@lando/core/landofile`) ships with the §7.8.1 round-trip contract and call-site migration

**Executable guides and scenarios (§19):**
- MDX → generated scenario TypeScript pipeline
- Typed JSX component vocabulary for guides, scenarios, steps, actions, assertions, fixtures, and variants
- `ScenarioContext`, display vs execute, internal/public transcripts, source-location preservation
- Lint and quality gates for rendered reader scenarios and hidden test-only scenarios
- Recipe README integration (§19.13)
- Per-PR CI gate: scenario-layer guide scenarios on every platform; e2e guide-scenario `@smoke` subset on Linux x64

**Release engineering (§17):**
- `scripts/release.ts` orchestrator runs all 13 stages
- Code signing:
  - macOS Developer ID + `notarytool submit` + `stapler staple`
  - Windows Authenticode (`signtool`) + cosign
  - Linux: GPG-signed `SHA256SUMS` + cosign-signed `SHA256SUMS`
- Supply chain (§17.5):
  - CycloneDX SBOM per artifact
  - SLSA v1.0 provenance attestation
  - cosign signatures
  - `cosign verify-blob` succeeds in CI

**Self-update (§17.6):**
- Update manifest at `https://update.lando.dev/v4/<channel>.json` signed
- Write-alongside + atomic rename + re-exec
- Windows running-`.exe` rename strategy
- Failed-launch-probe rollback to `.bak`
- `EACCES` exits with `UpdatePermissionError` + sudo/UAC remediation (no silent elevation)

**Installers (§17.7):**
- GitHub Releases with all signed artifacts
- `https://get.lando.dev/install.sh` (POSIX) — vendored GPG trust root
- `https://get.lando.dev/install.ps1` (Windows) — vendored cosign trust root
- Both verify signatures before install
- Both install to `${LANDO_INSTALL_DIR:-<userDataRoot>/bin}` matching `lando shellenv`

**§17.9 release machinery (built here; final all-platform acceptance is the RC gate):**
- The §17.9 binary acceptance machinery is implemented and runs in CI: signing, notarization, SBOM, provenance, self-update, and installers all execute and pass on Linux x64 (the reference platform).
- Full pipeline runs in CI in <30 min single-platform / <60 min full matrix
- Import-boundary test confirms no runtime FS read of bundled plugins / recipes / OCLIF manifest / built-in schemas
- Mutagen binaries are NOT in the compiled binary; downloaded by `lando setup`

**Library:**
- `@lando/core/testing` declared stable on `next`
- Library API contract tests in `core/test/library/` cover the full §16.2 surface, including stable `App` handles, `AppSelector`, `openLandoRuntime`, and `resolveApp`
- Plugin SDK contract test for `requires."@lando/core": "^4.0.0"` enforcement
- Shared `Downloader` primitive for proxy/CA-aware verified artifact downloads lands with its SDK service, default implementation, manifest contribution, contract suite, and migrated Lando-owned download call sites
- Paths/Roots primitive (`@lando/core/paths` + `PathsService`) and durable `StateStore` primitive land as the paired filesystem/persistence foundation for roots, derived paths, scratch registry, include lockfile, and plugin/host state buckets

**Telemetry:**
- Default-on with documented inventory
- Opt-out command + global-config key
- Canonical redaction primitive (`@lando/sdk/secrets` + `RedactionService`) enforces all telemetry, event, log, transcript, and diagnostic redactions

**Terminal UI and interaction:**
- Default terminal UI moves behind the bundled `@lando/renderer-lando` plugin and receives the bounded spaceship-console polish pass
- Shared `InteractionService` primitive consolidates prompts behind `PromptSpec`, answer-source precedence, `editor` prompt type, and dispatch-parity-safe prompt call-site migration

**SDK runtime primitives & plugin contract kit:**
- `@lando/sdk/probe` retry/verdict primitive (`RetryPolicy`, `runProbe`, `ProbeOutcome`, contracts-only, `TestClock`-deterministic) ships and the healthcheck, scanner, doctor, `Downloader`, and `lando setup` readiness loops migrate onto it, with a §13.4 boundary gate banning net-new ad-hoc retry/backoff loops
- `EventService` gains typed `waitFor`/`waitForAll`/`query` with an `EventError` timeout contract and a bounded **redacted** in-memory history buffer; `@lando/core/testing` `expectEvent`/`waitForEvent`/`recordedEvents` become thin wrappers over them
- The §4.2 plugin-abstraction contract kit ships from `@lando/sdk/test` — `tooling-engine`, `route-filter`, `secret-store`, `config-translator`, `plugin-source`, and `doctor-check` suites — every built-in implementation runs through its suite, and the §13.1 layer-coverage gate fails if a suite or its built-in invocation is removed

### Exit criteria for Beta 1

Every Beta 1 deliverable above is accepted, including the completed `lando setup` / `lando uninstall` surface, schema publication plus the Landofile serializer, telemetry plus redaction, supply-chain/self-update plus the shared `Downloader`, terminal UI polish plus `InteractionService`, the paired Paths/Roots + durable `StateStore` primitives, the stable App-handle embedding primitive, and the remaining SDK primitive trio (`@lando/sdk/probe`, the `EventService` query/history surface, and the §4.2 plugin-abstraction contract kit), and the first signed `4.0.0-beta.N` pre-release ships from CI on the `next` channel. **Feature freeze is entered** — no spec section is being added from here on. The §17.9 release machinery runs green on the reference platform; the all-platform acceptance pass is the RC gate.

---

## Phase 5 — Beta 2 ("feature-freeze hardening")

> **One sentence**: No new features — only the bugs that Beta 1 field use surfaced get fixed, on the way to a release candidate.
>
> **Audience**: production users on the `next` channel. Continued `4.0.0-beta.N` binaries.

### Goal

Stabilize Beta 1. Burn down the bug backlog from real-world Beta 1 adoption with **zero new feature surface**, so that what graduates to RC is a known-good candidate.

### Concrete deliverables

- Triage and fix bugs reported against Beta 1 across providers, services, the global app, scratch apps, recipes, tooling, and the renderer.
- No new commands, flags, service types, schema fields, or events — only fixes and clarifying diagnostics. Any "new feature" request is pushed to a post-4.0 minor.
- Performance regressions found in Beta 1 (hot-path tooling latency, cold start) fixed against the §17.2 budget; the benchmark gate guards against re-regression.
- The §17.9 release machinery is exercised on every platform (not just the reference platform) and every failure that is not a genuine acceptance blocker is fixed.
- Documentation and guides brought in line with shipped behavior (executable-guide scenarios stay green per-PR).

### Exit criteria for Beta 2

The Beta 1 bug backlog is burned down to zero known blockers, the release machinery runs on all 5 platforms, and the candidate is ready to be promoted to RC. No new feature surface landed.

---

## Phase 6 — RC ("release-candidate acceptance")

> **One sentence**: The §17.9 binary acceptance criteria are all green on all platforms, and two RC iterations ship with zero blocker bugs.
>
> **Audience**: release rehearsal. Public `4.0.0-rc.N` binaries.

### Goal

Operational release-readiness. No new features and no behavior changes other than fixes for blocker bugs found during RC — prove the release is safe to ship.

### Concrete deliverables

- **§17.9 acceptance — all 13 enumerated criteria pass on all platforms** (signed, notarized, SBOM, SLSA provenance, cosign-verified, self-update, curl-pipe installers), not just the reference platform.
- Full release pipeline (`scripts/release.ts`, all 13 stages) runs end-to-end from CI and produces the complete signed artifact set.
- Self-update across channels verified (write-alongside, atomic rename, re-exec, failed-launch-probe rollback) on macOS, Windows, and Linux.
- Installers (`get.lando.dev/install.{sh,ps1}`) verified to install signed artifacts to `${LANDO_INSTALL_DIR:-<userDataRoot>/bin}` matching `lando shellenv`.
- Deprecation governance enforced: the release pipeline fails if any `removeIn` matches the version being released.
- Only blocker-bug fixes accepted; each fix re-verified against the full acceptance suite.

### Exit criteria for RC

Pre-release tag `4.0.0-rc.N` ships from CI and passes every §17.9 item on every platform. Two RC iterations with zero blocker bugs.

---

## Phase 7 — 4.0 GA

> **One sentence**: Public release. Library and binary co-versioned. Stable channel populated.

### Difference from RC

- Tag bump only — `4.0.0` from the last green RC, carrying only the bug fixes found during RC
- `stable` channel populated, update manifest pointed
- Public docs site (Starlight) live
- Library `@lando/core/testing` stable on `stable`
- Marketing/announce
- Schema artifacts cached to `https://schemas.lando.dev/v4/`
- Plugin SDK 4.0 frozen — community plugins can pin `^4.0.0` and trust it

No new features and no code changes from `4.0.0-rc.N` → `4.0.0` other than the RC bug fixes and version bumps.

---

## Phase 8 — 4.1 (first post-GA minor)

> **Theme**: Address the first wave of real-user pain.

- Distro packages: Homebrew formula (easiest), scoop bucket, winget manifest
- 5–10 additional canonical recipes based on adoption signal (Magento, Symfony stack variants, Astro, Next.js, etc.)
- Performance work driven by telemetry: hot-path latency on macOS Docker Desktop, cold-start on Windows
- More config translators contributed as plugins (legacy v3, ddev import, devbox import) — not in core, hosted by Lando Alliance
- Renderer plugins: a TUI-style `lando` renderer variant; a CI-friendly `github-actions` renderer
- Doctor depth: more checks driven by Beta 1 field reports
- Bun version floor bump if Bun shipped a meaningfully better release
- Hot-path tooling profiling fixes (real ~150ms target chasing)

---

## Phase 9 — 4.2

> **Theme**: Open up the plugin ecosystem.

- Plugin SDK polish from first wave of community plugin authors
- Plugin discovery UX (`meta:plugin:search` against the registry surface)
- Plugin trust UX iteration (refine whatever Beta 1 decision was made, based on use)
- Recipe registry beyond canonical built-ins — first-class support for community recipes via `@lando/recipe-*` npm convention
- Plugin authoring docs as full Diátaxis tutorials (executable per §19)
- Custom `ToolingEngine` examples (`processExec`, `dryRun`)
- More `SecretStore` backends (1Password CLI, `op`, `age`)
- Custom `PluginSource` examples (S3, OCI artifact)

---

## Phase 10 — 4.3+ (deferred-from-§14.2 work)

These were called out in §14.2 and the canonical surface non-goals as **architecturally preserved but not shipped at GA**. Each is a 4.x minor on its own merits. Order driven by telemetry + community demand.

| Deferred capability | §14.2 notes | Trigger |
|---|---|---|
| **Persistent local agent (`lando agent`)** | Hot-path latency from ~150ms to ~10ms. Daemon lifecycle, socket auth, state-drift on Landofile change, multi-tab concurrency, graceful upgrade. Unlocks VSCode extension + TUI control surface. | VSCode extension / TUI demand |
| **Copy-on-write scratch isolation** | `ProviderCapabilities.copyOnWriteAppRoot`; reflink/clonefile/overlay paths; replaces v4.0 content-copy `--isolate=full` | Provider adds capability |
| **Scratch fleets** | Matrix orchestration of N scratch apps; v4.0 users compose via repeated `apps:scratch:start --detach` | Community demand |
| **Hot reload from fork-mode scratch source** | Mtime-driven re-sync, likely as a `FileSyncEngine` plugin | Community demand |
| **Multi-provider apps** | Design preserved by `ProviderCapabilities`; not shipped at GA | Enterprise demand |
| **Kubernetes provider** | Likely lands as a community plugin first; may bundle in 4.x | Adoption justification |
| **TCP/UDP forwarding via `FileSyncEngine`** | Future `PortForwardingService` abstraction reusing Mutagen daemon | Community demand |
| **`dependsOn: ["global:<service>"]` in Landofile** | Deferred pending telemetry showing AppFeature path insufficient (§14.2) | Falsifiable telemetry trigger |

---

## Cross-cutting risks (track from MVP onward)

| Risk | Why it matters | When to act |
|---|---|---|
| **`@lando/sdk` premature stability** | Anything in `@lando/sdk` is API-stable on first ship. A wrong shape is `4.0.0` baggage forever. | MVP — every PR touching `sdk/src/` gets careful review |
| **OCLIF v4 vs v5 timing** | If OCLIF v5 lands during Alpha 3, the migration cost grows by phase | Decide at Alpha 1; revisit at Alpha 3 exit |
| **Provider contract drift** | `@lando/sdk/test` contract suite must catch every spec MUST/SHOULD | Add contract assertions as each provider feature lands; do not let the contract suite lag the impl |
| **Compose subset creep** | Each accepted Compose key is a permanent compatibility commitment | Maintain an explicit allowlist file from MVP; reject anything not on it with a remediation message |
| **`bundled.ts` codegen drift** | Bundled plugin set is bake-time only; a missing plugin breaks the binary silently | Ship `scripts/build-bundled-plugins.ts` in MVP even if hand-curated |
| **Hot-path latency** | The promised ~150ms on `tooling` bootstrap is the perceived performance number | Add a benchmark gate in CI starting Alpha 3; track regression by commit |
| **CI runner Podman drift** | MVP ships CI with Podman in the runner (PRD-07). GitHub-hosted runner image changes can break the private-socket setup silently. | Pin `ubuntu-24.04` (not `latest`); on every Bun/Podman bump, run the integration job manually before merging. |
| **Plugin trust UX** | Open decision at GA — wrong shape hurts plugin adoption | Don't ship plugin install (Alpha 3) without a stub; finalize at Beta 1 |
| **Telemetry default-on** | Privacy-sensitive default — wrong inventory becomes a public incident | Inventory must be reviewed at Beta 1 by someone outside core eng |

---

## Suggested cadence

Rough swag — tune to team velocity. The two phases that historically blow up are **MVP** (everything-from-zero) and **Beta 1** (open decisions tend to surface late). Allocate buffer accordingly.

| Phase | Relative size | Primary driver |
|---|---|---|
| 0 | done | scaffolding |
| 1 MVP | done | foundational breadth, walking skeleton |
| 2 Alpha 1 | done | top-N stack coverage |
| 2.5 Alpha 2 | done | guide scenario engine |
| 3 Alpha 3 | done | catalog breadth + global-app + scratch-app concepts |
| 4 Beta 1 (current) | medium | governance + signing + setup/uninstall completion + open-decision resolution |
| 5 Beta 2 | medium | feature-freeze hardening (bug burn-down) |
| 6 RC | medium | §17.9 all-platform acceptance + open-decision resolution |
| 7 4.0 GA | days | tag bump from RC |
| 8 4.1 | medium | post-GA reactive |
| 9 4.2+ | open-ended | ecosystem-driven |
