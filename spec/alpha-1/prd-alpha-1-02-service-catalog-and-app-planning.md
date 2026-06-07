# PRD: ALPHA1-02 — Service catalog and app planning

## Introduction

This PRD covers Phase 2 Alpha 1 work for **Service catalog and app planning**. It translates the Alpha 1 section of [`spec/ROADMAP.md`](../ROADMAP.md) into implementation-sized stories while preserving the MVP rule that the detailed spec parts remain source of truth.

Depends on: **PRD-01**.


## Source References

- [`spec/06-services.md`](../06-services.md) — service model, catalog, mounts, storage, env, healthchecks.
- [`spec/07-landofile-and-config.md`](../07-landofile-and-config.md) — Landofile parse/config inputs.
- [`spec/05-runtime-providers.md`](../05-runtime-providers.md) — provider-neutral planning/capability negotiation.

## Goals

- Ship the Alpha 1 common-stack service catalog.
- Support Alpha 1 mount/storage/env/networking semantics in provider-neutral plans.
- Keep Alpha-3-only services and global-app-dependent features explicitly rejected with remediation.

## User Stories

### US-009: Ship PHP service types for common frameworks

**Description:** As a PHP user, I can define `php:8.2` or `php:8.3` with Drupal, WordPress, Laravel, Symfony, or no framework.

**Acceptance Criteria:**
- [ ] ServiceType tests cover normalized plans for php versions and framework options
- [ ] Generated service plans include app mounts from §6.4, `LANDO_*` env from §6.9, healthcheck intent from §6.7, and framework web server hints from §6.12.2
- [ ] Unsupported PHP versions fail during planning with remediation
- [ ] Tests pass
- [ ] Typecheck passes
- [ ] Lint passes

### US-010: Ship Node service types beyond MVP

**Description:** As a Node user, I can use `node:lts` or `node:22` in real app plans.

**Acceptance Criteria:**
- [ ] Node ServiceType tests cover both versions and app-root bind mounts
- [ ] Plans work with providerExec tooling as a default execution target
- [ ] Existing MVP Node+Postgres scenario remains green
- [ ] Tests pass
- [ ] Typecheck passes
- [ ] Lint passes

### US-011: Ship Python service types for Django/FastAPI/Flask

**Description:** As a Python user, I can define Python 3.12 apps with supported framework hints.

**Acceptance Criteria:**
- [ ] ServiceType tests cover django, fastapi, flask, and none framework options
- [ ] Plans expose default endpoint ports from §6.6 and command metadata from the selected framework preset in §6.12.2
- [ ] Unsupported framework values fail schema validation
- [ ] Tests pass
- [ ] Typecheck passes
- [ ] Lint passes

### US-012: Ship Ruby service types for Rails and generic Ruby

**Description:** As a Ruby user, I can define Ruby 3.3 services for Rails or generic workloads.

**Acceptance Criteria:**
- [ ] ServiceType tests cover rails and none framework options
- [ ] Rails default command/port metadata is represented as provider-neutral intent
- [ ] Planner output uses provider-neutral `ServicePlan` fields from §6.2 and §6.10, with provider-specific fields limited to `providerInfo` or `providers.<id>` extensions per §5.6
- [ ] Tests pass
- [ ] Typecheck passes
- [ ] Lint passes

### US-013: Ship common database/cache/web services

**Description:** As a team, we can compose apps with mysql, mariadb, postgres, redis, nginx, apache, static, and raw Compose passthrough.

**Acceptance Criteria:**
- [ ] Each listed service has schema and ServiceType plan tests
- [ ] Raw Compose passthrough accepts `image:` and Compose `build:` for `type: compose` per §6.12.1; fields without provider-neutral semantics must live under `providers.<id>` and are marked non-portable per §5.6. Tests exercise both `provider-lando` and `provider-docker` codepaths
- [ ] Compose-declared volumes follow the same destroy-preserves-volumes rule as Lando-managed volumes (per provider-lando lifecycle contract)
- [ ] Database services declare storage scope defaults and credentials/env contract
- [ ] Tests pass
- [ ] Typecheck passes
- [ ] Lint passes

### US-014: Support Alpha 1 mount and storage semantics

**Description:** As a user, I can use app-root bind mounts, bind/volume mounts, excludes, and app/service scoped storage.

**Acceptance Criteria:**
- [ ] Landofile parser tests cover `mounts:` bind and volume entries plus `excludes:` patterns
- [ ] Planner maps excludes to volume-shadow behavior only; Mutagen/file sync is not implemented
- [ ] Storage `scope: global` is rejected until the global app phase
- [ ] Landofile parser rejects Alpha-3-only sections (`includes:` per §7.7, configuration expressions per §7.3.1, `secrets:` per §4.2 SecretStore + §7.4 top-level key, env overrides per §7.6) with a tagged NotImplemented + Alpha 3 remediation; one test per rejected section
- [ ] Tests pass
- [ ] Typecheck passes
- [ ] Lint passes

### US-014b: Extend LandofileService to load `landofile.ts`

**Description:** As an advanced recipe author, I can author a programmatic Landofile (`landofile.ts`) and have `LandofileService` execute it deterministically. Unblocks PRD-04 US-029. (PRD-02 US-014b)

**Acceptance Criteria:**
- [ ] `LandofileService` loads `landofile.ts` files via Bun's TS loader and returns a parsed Landofile equivalent to the YAML form; YAML and TS forms produce identical `AppPlan` output
- [ ] Programmatic execution is sandboxed: no remote module fetch, no host shell-out, no filesystem access outside the app root; violations fail with a tagged `LandofileSandboxError` + remediation
- [ ] Execution timeout is bounded and configurable; default timeout fails with `LandofileTimeoutError`
- [ ] Schema validation runs on the returned object; failures surface the same `LandofileParseError` shape as the YAML path
- [ ] Tests pass
- [ ] Typecheck passes
- [ ] Lint passes

### US-015: Emit the basic `LANDO_*` environment contract

**Description:** As code running inside services, I can rely on basic app/service/host path environment variables.

**Acceptance Criteria:**
- [ ] Service plan tests assert app id, service id, and §6.9 host path env vars for every §6.12.1 catalog family shipped in Alpha 1
- [ ] Provider exec tests verify env reaches command execution
- [ ] Env var names are documented in the PRD/source docs touched by the implementation
- [ ] Tests pass
- [ ] Typecheck passes
- [ ] Lint passes

### US-016: Plan per-app networking and provider-exec healthchecks

**Description:** As an app user, services share a per-app bridge and basic healthchecks can gate readiness.

**Acceptance Criteria:**
- [ ] Planner tests assert per-app network intent for multi-service apps
- [ ] Healthcheck support is limited to provider-exec mode and rejects unsupported modes clearly
- [ ] `lando start` readiness output uses inspected provider state, not blind success
- [ ] Tests pass
- [ ] Typecheck passes
- [ ] Lint passes

## Functional Requirements

- Implement only the Phase 2 Alpha 1 surface assigned to this PRD.
- Preserve all accepted MVP behavior and regression coverage.
- Match existing Bun workspace conventions: `bun run typecheck`, `bun run lint`, `bun test`, and generated-file updates through `bun run codegen` where applicable.
- Source CLI behavior and compiled binary behavior must stay aligned for user-visible commands touched by this PRD.

## Non-Goals

- Do not implement features listed in the Alpha 1 index cross-cutting non-goals.
- Do not stabilize non-SDK library APIs beyond the `unstable`/dev-channel promise.
- Do not add new external dependencies unless the relevant spec part already requires them or a separate architecture decision approves them.

## Technical Considerations

- Use the spec part referenced by each story as the source of truth when details conflict with this PRD.
- Prefer fake-client/unit coverage for provider and CLI behavior; live runtime tests must be env-gated.
- Default runtime provider for tests in this PRD is `TestRuntimeProvider` from `@lando/sdk/test`; live `provider-lando`/`provider-docker` cases must be gated on `LANDO_TEST_PODMAN_SOCKET` / `LANDO_TEST_DOCKER_SOCKET` (or `DOCKER_HOST`).
- Keep tagged errors and remediation text consistent across source OCLIF and compiled `$bunfs` paths.
- Avoid broad refactors while implementing a story; each story should be reviewable independently.

## Success Metrics

- Every user story in this PRD is accepted with its tests merged.
- `bun run typecheck`, `bun run lint`, and `bun test` pass for the whole workspace.
- Alpha 1 roadmap exit criteria remain achievable without adding unplanned Alpha 3/Beta 1 scope.

## Open Questions

- None blocking; resolve story-level ambiguities by updating this PRD and the authoritative spec part together.
