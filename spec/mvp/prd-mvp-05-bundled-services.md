# PRD: MVP-05 — Bundled services (`@lando/service-lando` + `@lando/logger-pretty`)

## Introduction

PRD-04 ships the *runtime providers* (`provider-lando`, `provider-docker`). This PRD ships the *bundled service plugins* — the things that decide what a `node` or `postgres` service actually looks like inside the plan.

Per [`spec/ROADMAP.md`](../../spec/ROADMAP.md) Phase 1 "Bundled plugins (Layer bodies)":

- **`@lando/service-lando`** — the opinionated `lando` service base + the `node` and `postgres` `ServiceType` impls (minimal — no framework presets, no canonical catalog).
- **`@lando/logger-pretty`** — bundled but empty (Effect's default `Logger.pretty` is good enough for MVP). Exists so the `BUNDLED_PLUGINS` codegen path is exercised.

Today (Phase 0):
- [`plugins/service-lando/src/index.ts`](../../plugins/service-lando/src/index.ts) is a stub with only `PLUGIN_NAME`. `plugin.yaml` may or may not be present.
- [`plugins/logger-pretty/src/index.ts`](../../plugins/logger-pretty/src/index.ts) is a similar stub.

Depends on: **PRD-01 (SDK contracts)**, **PRD-02 (Foundation — `BUNDLED_PLUGINS`)**, **PRD-03 (Effect services — `LandofileService`, `AppPlanner`)**.

## Goals

- `@lando/service-lando` registers two `ServiceType`s: `node:lts` and `postgres`. They are recognized by `LandofileService` validation and `AppPlanner` planning.
- Each `ServiceType` produces the right `ServicePlan` fields (image, default ports, default environment, default volumes) so the providers don't need service-specific knowledge.
- `@lando/logger-pretty` ships a real plugin manifest but an empty Live Layer — its purpose is to prove `BUNDLED_PLUGINS` works for non-provider plugin `kind`s.
- Both plugins pass any plugin-SDK contract assertions that exist at MVP (PRD-01 only ships the `RuntimeProvider` contract suite at MVP — service-plugin contract assertions are Alpha 3, but lint-level shape checks must hold).

## User Stories

### US-001: `@lando/service-lando` package skeleton

**Description:** As `BUNDLED_PLUGINS`, I need `@lando/service-lando` to be a real workspace package with a manifest, types, and a Live Layer entry point.

**Acceptance Criteria:**
- [ ] Failing test in `plugins/service-lando/test/package.test.ts` asserts `import("@lando/service-lando")` resolves and exports `PLUGIN_NAME`, `serviceTypes` (a `ReadonlyMap<string, ServiceType>`), `manifest`.
- [ ] `plugins/service-lando/package.json` declares `name: "@lando/service-lando"`, `type: "module"`, `exports`, `peerDependencies` on `@lando/sdk` and `@lando/core`.
- [ ] `plugins/service-lando/plugin.yaml` exists with the manifest fields PRD-01's `PluginManifest` schema requires (`name`, `version`, `kind: services`, `landoCompat`, `contributes.serviceTypes: [{ id: "node:lts" }, { id: "postgres" }]`).
- [ ] `plugins/service-lando/src/index.ts` exports a `services` Layer (stub at this story; US-002 + US-003 fill it).
- [ ] `BUNDLED_PLUGINS` (PRD-02 US-005) lists `@lando/service-lando` after this story.
- [ ] Test passes after the package skeleton lands.
- [ ] Typecheck/lint/whole-workspace tests pass.

### US-002: `node:lts` `ServiceType` implementation

**Description:** As `AppPlanner`, when I see `serviceType: node:lts` in a Landofile, I need `service-lando` to provide a `ServiceType` that emits a complete `ServicePlan` with image, command, env, ports, volumes appropriate for an LTS Node app.

**Acceptance Criteria:**
- [ ] Failing test in `plugins/service-lando/test/node.test.ts` constructs a `LandofileService` block of `{ serviceType: "node:lts", image?: undefined, command?: undefined }`, runs it through the `node:lts` `ServiceType.toServicePlan`, and asserts the plan contains:
  - `image: "node:lts"` (or a pinned LTS digest documented in `spec/06-services.md` if specified there).
  - A default `workdir: "/app"`.
  - The bind-mount of the app root → `/app`.
  - A default `command` of `["sh", "-c", "tail -f /dev/null"]` (or whatever spec specifies for "no app code yet" — we don't auto-run anything for MVP).
  - `expose: [3000]` or `ports: ["3000:3000"]` — exact shape per `spec/06-services.md`.
- [ ] Test asserts user overrides win: setting `image: "node:22"` in the Landofile produces `image: "node:22"` in the plan (no opinionated rewrite).
- [ ] Test asserts `framework:` is not accepted at MVP (`framework: drupal` in a `node:lts` Landofile entry fails `LandofileService.discover` validation — framework presets are Alpha 1).
- [ ] Live impl lives at `plugins/service-lando/src/services/node.ts`; test passes after impl lands.
- [ ] Typecheck/lint/whole-workspace tests pass.

### US-003: `postgres` `ServiceType` implementation

**Description:** As `AppPlanner`, when I see `serviceType: postgres` in a Landofile, I need `service-lando` to emit a `ServicePlan` with the conventional Postgres image, default port 5432, default env (POSTGRES_USER/POSTGRES_PASSWORD/POSTGRES_DB), and a named volume for `/var/lib/postgresql/data`.

**Acceptance Criteria:**
- [ ] Failing test in `plugins/service-lando/test/postgres.test.ts` plans a Landofile entry of `{ serviceType: "postgres" }` and asserts the resulting `ServicePlan` contains:
  - `image: "postgres:16"` (or whatever pinned version `spec/06-services.md` specifies for MVP).
  - `ports: ["5432:5432"]` (host-published).
  - `environment.POSTGRES_USER`, `environment.POSTGRES_PASSWORD`, `environment.POSTGRES_DB` populated with sensible defaults (e.g. `lando` / a generated password / `<appId>`).
  - A named volume mounted at `/var/lib/postgresql/data` so data survives `app:stop`.
- [ ] Test asserts setting `database:` and `user:` keys on the Landofile entry maps them to `POSTGRES_DB` and `POSTGRES_USER` respectively.
- [ ] Test asserts the password default is *generated* per app (deterministic from `appId` so it's stable; not stored in plaintext in code).
- [ ] Test asserts the published port is configurable via the Landofile entry (`port:` key) — important for users running multiple apps.
- [ ] Live impl lives at `plugins/service-lando/src/services/postgres.ts`; test passes after impl lands.
- [ ] Typecheck/lint/whole-workspace tests pass.

### US-004: `service-lando` Layer wires both `ServiceType`s into core's registry

**Description:** As `AppPlanner`, I need both `ServiceType`s to be discoverable through `PluginRegistry` so I can resolve them by id.

**Acceptance Criteria:**
- [ ] Failing test in `plugins/service-lando/test/registration.test.ts` provides the `service-lando` Layer to a test runtime, asks `PluginRegistry.load("@lando/service-lando")`, asks for `contributes.serviceTypes`, and asserts both `node:lts` and `postgres` are listed.
- [ ] Test asserts `AppPlanner.plan(...)` against a Landofile referencing both service types resolves both `ServiceType`s through the registry — not via direct import in `AppPlanner` (no cross-package import).
- [ ] Test passes after registration is wired.
- [ ] Typecheck/lint/whole-workspace tests pass.

### US-005: `service-lando` does not import `@oclif/core`

**Description:** As release engineering, service plugins must be CLI-agnostic.

**Acceptance Criteria:**
- [ ] Failing test in `plugins/service-lando/test/import-boundary.test.ts` parses every file under `plugins/service-lando/src/**` and asserts none import `@oclif/core`, `@oclif/...`, or any `core/src/cli/` path.
- [ ] Test passes once impl is structured to avoid those imports.
- [ ] Typecheck/lint/whole-workspace tests pass.

### US-006: `@lando/logger-pretty` package skeleton (empty body)

**Description:** As `BUNDLED_PLUGINS`, I need `@lando/logger-pretty` to be a real workspace package with a manifest and an empty Layer — its purpose is to exercise the codegen path for `kind: logger` plugins.

**Acceptance Criteria:**
- [ ] Failing test in `plugins/logger-pretty/test/package.test.ts` asserts `import("@lando/logger-pretty")` resolves and exports `PLUGIN_NAME`, `logger` (a Layer that adds nothing — it's a no-op Layer), `manifest`.
- [ ] `plugins/logger-pretty/package.json` declares `name: "@lando/logger-pretty"`, `type: "module"`, `exports`, `peerDependencies`.
- [ ] `plugins/logger-pretty/plugin.yaml` exists with `kind: logger`, `name`, `version`, `landoCompat`.
- [ ] The exported `logger` Layer is `Layer.empty` (or a no-op equivalent) and is documented as such.
- [ ] `BUNDLED_PLUGINS` lists `@lando/logger-pretty` after this story.
- [ ] Test passes after the package skeleton lands.
- [ ] Typecheck/lint/whole-workspace tests pass.

### US-007: `BUNDLED_PLUGINS` codegen handles all four MVP plugins

**Description:** As `bun build --compile`, I rely on `core/src/plugins/bundled.ts` being statically analyzable; the codegen must enumerate the right four plugins.

**Acceptance Criteria:**
- [ ] Failing test in `core/test/plugins/bundled-codegen.test.ts` runs `scripts/build-bundled-plugins.ts` against a fresh checkout, then imports `@lando/core/plugins/bundled` (or whatever path `bundled.ts` lives at), and asserts:
  - `BUNDLED_PLUGINS.length === 4`.
  - The four entries are `@lando/provider-lando`, `@lando/provider-docker`, `@lando/service-lando`, `@lando/logger-pretty`.
  - Each entry has `name`, `manifest`, `layer` (a real Layer reference, not a stub function).
- [ ] Test asserts running the script twice produces no diff (idempotent).
- [ ] Test passes after this PRD's two skeletons + PRD-04's two skeletons all populate `bundled.ts`.
- [ ] Typecheck/lint/whole-workspace tests pass.

## Functional Requirements

- FR-1: `@lando/service-lando` exports `services: Layer` plus a registry-side contribution that registers `node:lts` and `postgres` `ServiceType`s into `PluginRegistry.contributes.serviceTypes`.
- FR-2: `node:lts` `ServiceType.toServicePlan(landofileEntry, config)` returns a typed `ServicePlan` with the defaults above and accepts user overrides for `image`, `command`, `ports`, `environment`, `volumes`.
- FR-3: `postgres` `ServiceType.toServicePlan` returns a typed `ServicePlan` with the defaults above and accepts user overrides for `image`, `port`, `database`, `user`, `password`.
- FR-4: Neither `ServiceType` accepts `framework:` keys at MVP (validation rejection in PRD-01's `LandofileShape` schema).
- FR-5: Both `ServiceType`s' Postgres password / generated secrets are derived deterministically from `appId` (so re-planning the same app produces the same secrets) — they are *not* stored in plaintext in the schema or in any committed file.
- FR-6: `@lando/logger-pretty` exports a no-op Layer named `logger` and a populated manifest. The manifest is enough to prove the `kind: logger` codegen path works.
- FR-7: `BUNDLED_PLUGINS` enumerates exactly four MVP plugins; adding a fifth requires a new PRD.
- FR-8: No service plugin imports `@oclif/core` or `core/src/cli/*`.

## Non-Goals

- **No framework presets.** `framework: drupal | wordpress | laravel | symfony | django | rails | …` is Alpha 1 (`spec/06-services.md` framework awareness).
- **No PHP, Python, Ruby, Go service types.** Alpha 1+.
- **No HTTP/web server services** (`nginx`, `apache`). Alpha 1.
- **No additional databases** (`mysql`, `mariadb`, `mongodb`). Alpha 1 (mysql/mariadb), Alpha 3 (mongodb).
- **No caches** (`redis`, `memcached`, `valkey`). Alpha 1 (redis), Alpha 3 (memcached/valkey).
- **No search** (`solr`, `elasticsearch`, `opensearch`, `meilisearch`). Alpha 3.
- **No mailpit / mail capture.** Alpha 3 (lives in the global app).
- **No `static`-type service.** Alpha 1.
- **No raw Compose passthrough.** Alpha 1.
- **No `@lando/logger-pretty` actual rendering work.** That ships when there's a reason to deviate from Effect's `Logger.pretty` — Alpha 3 or Phase 6+.

## Technical Considerations

- The `ServiceType` interface lives in `@lando/sdk/services` (or wherever PRD-01 settled it). Service plugins implement it; they do *not* re-declare it.
- `ServicePlan` shape is owned by PRD-01. Add fields here only by going back to PRD-01 first.
- For Postgres password generation: HMAC-SHA256(`appId`, secret) where `secret` is a constant baked into core (not a per-install secret — that's Beta 1's secrets management). Document the limitation in code.
- The bind mount for `node:lts` is the *app root*; for `postgres` we use a named volume (data isn't on the host). This split is per `spec/06-services.md`.
- Image versions are pinned by *tag* at MVP, not by digest. Tag pinning vs digest pinning is a Alpha 3 question (`spec/06-services.md`).
- `@lando/logger-pretty`'s empty status is documented in its `src/index.ts` so it doesn't look like a TODO.

## Success Metrics

- `LandofileService.discover` accepts a fixture Landofile with one node and one postgres service and produces a typed value with no errors.
- `AppPlanner.plan` against that value produces an `AppPlan` whose two `ServicePlan` entries match the defaults documented in this PRD.
- `BUNDLED_PLUGINS` has length 4, contains all four plugins, and `bun build --compile` succeeds.
- Zero hand-edits to `core/src/plugins/bundled.ts` — the file is regenerated by `scripts/build-bundled-plugins.ts`.

## Open Questions

- Postgres image: `postgres:16` vs `postgres:17` for MVP? Default: whichever `spec/06-services.md` pins; if neither, `postgres:16` (current LTS). Document the version in the `node`/`postgres` `ServiceType` source files.
- Should the deterministic Postgres password be visible in `lando info`? Default: yes, with a redaction toggle for production-style use cases (Alpha 1).
- `node:lts` "default command" — at MVP we don't run user app code, so the container just stays alive. Alpha 3 will add a `start: ["bun", "run", "dev"]` convention. Confirm `tail -f /dev/null` is the right placeholder vs `node --version && sleep infinity`.
- Should `@lando/logger-pretty` have *any* code at all, or is `Layer.empty` sufficient? Default: a single comment-only file plus a populated manifest. Sufficient to prove codegen.
