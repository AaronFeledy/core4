# PRD: COMPOSE-02 — Service-key vocabulary normalization

## Introduction

This PRD makes ordinary Compose service blocks parse and plan. Today `ServiceConfig` (`sdk/src/schema/landofile.ts`) accepts only Lando spellings and short syntax, so a real-world block using `depends_on` with `condition: service_healthy`, list-form `environment`, long-form `ports`, or a Compose-shaped `healthcheck` fails at decode. Each story lands one normalization family end-to-end: schema shape (both Compose forms), canonicalization to the long form, normalization into the provider-neutral plan per §6.2, and the Lando-key-wins conflict rule.

One deliberate contract change rides here: **`build:` shape discrimination** (§6.2) replaces the unreleased `composeBuild:` spelling. Compose build keys and Lando build-script keys share `build:`, discriminated by shape; mixing families is a tagged error. `composeBuild` predates first ship, so it is gut-and-replaced without a compatibility shim (root `AGENTS.md` policy), with the schema snapshot and `sdk/API_COMPATIBILITY.md` moved in the same change.

## Source References

- [`spec/06-services.md`](../06-services.md) §6.2 (normalization contract — normative for every story here), §6.4 mounts, §6.5 storage, §6.6 endpoints, §6.7 healthchecks, §6.13 orchestration DAG.
- [`spec/07-landofile-and-config.md`](../07-landofile-and-config.md) §7.4 — Lando-key-wins rule, disposition matrix.
- `sdk/src/schema/landofile.ts` — current `ServiceConfig`, `HealthcheckInput`, `BuildBlock`.
- `core/src/services/planner.ts`, `core/src/services/base/*.ts` — normalization/planning seams.

## Goals

- Every Tier-A key from §6.2 accepts both its Compose spelling and both syntaxes, canonicalized before planning.
- `depends_on` conditions are real orchestration semantics, not decoration.
- Conflicts resolve deterministically: the more specific Lando key wins, and `lando config` shows the resolved value.

## User Stories

### US-468: Compose spellings and alternate scalar/list forms

**Description:** As a user pasting a Compose service block, `depends_on` (list and condition-map forms), `working_dir`, `env_file` (string and list), `environment` (map and `KEY=value` list), and `labels` (map and list) all decode and normalize, alongside the existing Lando aliases.

**Acceptance Criteria:**

- [ ] `ServiceConfig` accepts `depends_on` (string-list and `{<svc>: {condition, restart?, required?}}` map), `working_dir`, `env_file` (string | string-list), `environment` list form, and `labels` map+list forms; all canonicalize to one internal long form before normalization.
- [ ] Compose spelling and Lando alias may coexist; the Lando key wins per §6.2/§7.4, covered by tests for `working_dir` vs `workingDirectory` and `depends_on` vs `dependsOn`.
- [ ] `environment` list entries without `=` resolve from the host environment per Compose semantics or fail with remediation — behavior chosen, documented in the schema annotation, and tested.
- [ ] `lando config --format yaml` renders the post-normalization resolved values.
- [ ] Schema snapshot refreshed (`codegen:schema-snapshot`); `sdk/API_COMPATIBILITY.md` updated (additive).
- [ ] Tests pass
- [ ] Typecheck passes
- [ ] Lint passes

### US-469: `ports`, `expose`, and `volumes` long syntax

**Description:** As a user, `ports` in long-object form (`target`, `published`, `host_ip`, `protocol`, `name`, `app_protocol`), `expose`, and long-form `volumes` entries (`type: bind | volume | tmpfs`, `source`, `target`, `read_only`, `bind.*`, `volume.subpath`/`nocopy`, `tmpfs.size`/`mode`) all decode and normalize into `endpoints` and Lando's mount model exactly as short strings do.

**Acceptance Criteria:**

- [ ] Long-form port entries decode; short strings (`"8080:80"`, `"127.0.0.1:8080:80/udp"`, container-only `"80"`) parse per the Compose port grammar into the same long form; invalid grammar fails with position-carrying remediation.
- [ ] `ports` and `expose` normalize into `endpoints`; host bindings require the provider host-port capability per §6.2 (existing check extended to long form).
- [ ] `services.<name>.endpoints:` continues to win over `ports:`-inferred intent, tested.
- [ ] Published ranges (`"8000-8010:8000-8010"`) either normalize or reject with remediation — decided in the disposition matrix, not silently dropped.
- [ ] Long-form volume entries decode; short strings (`./src:/app`, `named:/data:ro`, anonymous `/data`) parse into the same long form.
- [ ] Classification per §6.2: host-path sources → `mounts`, named volumes → `storage`, anonymous volumes → `storage` auto-naming (§6.5), `type: tmpfs` → the preserved `tmpfs` runtime knob (PRD-03 shape).
- [ ] `read_only`, `volume.subpath`, and `bind.create_host_path` map to their mount-model equivalents; unsupported sub-fields follow their matrix disposition with tests proving no silent drop.
- [ ] Lando `mounts:`/`storage:`/`appMount:` win over overlapping `volumes:` intent, tested.
- [ ] Schema snapshot refreshed.
- [ ] Tests pass
- [ ] Typecheck passes
- [ ] Lint passes

### US-470: Compose `healthcheck` shape

**Description:** As a user, a Compose-shaped `healthcheck` (`test` string or `CMD`/`CMD-SHELL`/`NONE` array, duration strings, `retries`, `disable`) normalizes into the §6.7 healthcheck model.

**Acceptance Criteria:**

- [ ] `test: "curl -f localhost"` (shell form), `test: ["CMD", "curl", "-f", "localhost"]`, `test: ["CMD-SHELL", "..."]`, and `test: ["NONE"]` / `disable: true` all decode; the latter two normalize to `kind: none`.
- [ ] `interval`, `timeout`, `start_period` accept Compose duration strings (`"30s"`, `"1m30s"`, `"1h2m3s"`) parsed to seconds; invalid durations fail with remediation. `start_interval` follows its matrix disposition.
- [ ] The Lando-shaped `HealthcheckInput` remains valid and wins when both shapes appear.
- [ ] Normalized checks execute through the existing `HealthcheckRunner` path unchanged (probe-boundary gate untouched).
- [ ] Schema snapshot refreshed.
- [ ] Tests pass
- [ ] Typecheck passes
- [ ] Lint passes

### US-471: `build:` shape discrimination

**Description:** As a user, `build:` with Compose keys (`context`, `dockerfile`, `dockerfile_inline`, `args`, `target`) is a Compose build normalizing into the artifact model; `build:` with `artifact:`/`app:` is the Lando build-script block; mixing families is a tagged error. `composeBuild:` is removed.

**Acceptance Criteria:**

- [ ] The `build:` schema is a shape-discriminated union; family detection is total over the vendored schema's build keys (every Compose build key belongs to the Compose family per the matrix, normalized or preserved or rejected).
- [ ] Mixed-family blocks fail with a tagged error naming both families and the split remediation (`build.artifact`/`build.app` vs Compose keys).
- [ ] Compose builds normalize into the §6.3 artifact model (`context`/`dockerfile`/`args`/`target`; `dockerfile_inline` per its matrix disposition); provider build capability is checked at planning.
- [ ] `composeBuild:` is deleted from `ServiceConfig` (pre-release gut-and-replace); all in-repo references (recipes, fixtures, guides) migrate in the same change; schema snapshot and `sdk/API_COMPATIBILITY.md` record the replacement.
- [ ] Planner/`l337` base consume the discriminated result; parity between `image:`+`build:` interactions and current behavior covered by tests.
- [ ] Tests pass
- [ ] Typecheck passes
- [ ] Lint passes

### US-472: `depends_on` conditions drive orchestration

**Description:** As a user, `condition: service_healthy` and `service_completed_successfully` actually gate start/build ordering per §6.13, not just parse.

**Acceptance Criteria:**

- [ ] The plan's dependency edges carry the condition; `service_started` remains the default for list-form and Lando `dependsOn`.
- [ ] `service_healthy`: dependents' start/app-build steps wait on the dependency's healthcheck success (the §6.13 `<db>:running` synthetic node gains a healthy variant); a dependency with no healthcheck and a `service_healthy` edge fails planning with remediation.
- [ ] `service_completed_successfully`: dependents wait on the dependency's successful exit; a non-zero exit fails the waiting steps with the §6.13 continue-all aggregation.
- [ ] `required: false` tolerates an absent/failed optional dependency per Compose semantics; `restart: true` follows its matrix disposition.
- [ ] Orchestrator tests cover all three conditions deterministically via the test provider (no live provider needed).
- [ ] Tests pass
- [ ] Typecheck passes
- [ ] Lint passes

## Functional Requirements

- FR-1: Canonicalization (short → long) happens before normalization; normalization consumes only long forms.
- FR-2: Every story's keys are classified `normalized` in the PRD-01 matrix in the same change (gate stays green and truthful).
- FR-3: No compatibility shims for pre-release spellings (`composeBuild`).

## Non-Goals

- No interpolation-engine changes; Compose `${VAR}` forms already ride the expression system's shell-param segments (edge-semantics parity is tracked as an open question, not this wave's scope).
- No `extends`, no multi-file merge (rejected dispositions; PRD-04 owns the errors).

## Success Metrics

- The corpus check: representative real-world service blocks (appwrite, n8n, netdata, vitess styles — `depends_on` condition maps, long-form ports/volumes, list envs, Compose healthchecks) decode and plan without edits, as a committed fixture test.

## Open Questions

- Compose `$$` escaping vs the expression system's `$${` — parity decision deferred to a doc note unless fixtures surface a real conflict.
