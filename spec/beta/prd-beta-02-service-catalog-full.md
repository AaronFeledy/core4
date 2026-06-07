# PRD: BETA-02 — Canonical service-type catalog (full breadth)

## Introduction

Alpha shipped `php`, `node`, `python`, `ruby`, `mariadb`, `mysql`, `postgres`, `redis`, `nginx`, and `apache`. Beta finishes the §6.12.1 canonical catalog: `go`, `mongodb`, `memcached`, `valkey`, `solr`, `elasticsearch`, `opensearch`, `meilisearch`, `static`, and a raw Compose passthrough. Mailpit ships as part of the global app (see PRD-05); it is referenced here only because it shares the same §6.12.1 inventory.

Depends on: **BETA-01** (every new service needs the provider matrix to back it on every platform).

## Source References

- [`spec/06-services.md`](../06-services.md) §6.12 canonical service-type table; §6.2 service contract; §6.4 framework presets; §6.6 healthchecks; §6.10 endpoints/ports.
- [`spec/07-landofile-and-config.md`](../07-landofile-and-config.md) `services:` block, framework variants.
- [`spec/13-testing-and-distribution.md`](../13-testing-and-distribution.md) service contract test layer.

## Goals

- Ship `@lando/service-lando` `ServiceType` implementations for every remaining §6.12.1 entry except `mailpit` (PRD-05).
- Keep each new service covered by the §13.1 service-contract layer with at least one scenario test and one provider-integration test.
- Surface framework-aware presets where §6.12.1 says they exist (none added in Beta beyond Alpha's set — Beta only adds the new base types).

## User Stories

### US-083: `go` service type (compiled and module-based projects)

**Description:** As a user with a Go app, I can declare `type: go` (`go:1.22`, `go:1.23`) and `lando start` brings up a service with the Go toolchain available for `go run` / `go build` / `go mod`.

**Acceptance Criteria:**
- [ ] `go` `ServiceType` shipped from `@lando/service-lando` with image tags pinned per §6.12.1.
- [ ] Scenario test starts a minimal Go HTTP server, verifies endpoint, and runs `lando go version` through tooling.
- [ ] Service contract test passes (capabilities, healthcheck schema, endpoints).
- [ ] Tests pass; typecheck passes; lint passes.

### US-084: `mongodb` service type

**Description:** As a user, I can declare `type: mongodb` (e.g. `mongodb:7`) and connect via `mongodb://lando@…` from sibling services.

**Acceptance Criteria:**
- [ ] `mongodb` `ServiceType` with healthcheck and `mongodb://` endpoint emission.
- [ ] Default credential generation per §6.6 redaction rules.
- [ ] Scenario test brings up Mongo, runs `lando mongosh --eval "db.runCommand('ping')"` through tooling, asserts success.
- [ ] Tests pass; typecheck passes; lint passes.

### US-085: `memcached` service type

**Description:** As a user, I can declare `type: memcached` and connect via `memcached://…` from sibling services.

**Acceptance Criteria:**
- [ ] `memcached` `ServiceType` with telnet/binary protocol healthcheck.
- [ ] Endpoint emission per §6.10.
- [ ] Scenario test sets and gets a key via `lando memcached-tool` (or equivalent shipped tooling alias).
- [ ] Tests pass; typecheck passes; lint passes.

### US-086: `valkey` service type

**Description:** As a user, I can declare `type: valkey` and use it as a drop-in replacement for `redis` (Valkey is the OSS Redis fork).

**Acceptance Criteria:**
- [ ] `valkey` `ServiceType` shares schema with `redis`; endpoint emission emits **both** `valkey://` (primary) and `redis://` (alias for client-compat) per §6.12.1.
- [ ] Scenario test ping/set/get; tooling alias `lando valkey-cli` works.
- [ ] Service description documents the dual-scheme emission and recommends `valkey://` for new apps that want protocol awareness; `redis://` alias keeps existing client libraries working.
- [ ] Tests pass; typecheck passes; lint passes.

### US-087: `solr` service type

**Description:** As a user, I can declare `type: solr` (e.g. `solr:9`) and post documents / run admin queries through tooling.

**Acceptance Criteria:**
- [ ] `solr` `ServiceType` with HTTP healthcheck on the admin ping endpoint.
- [ ] Default core/collection creation is opt-in via service-level `cores:` config (deferred to RC if expressions-language ergonomics conflict — PRD-08).
- [ ] Scenario test creates a default core and runs `lando solr-admin status`.
- [ ] Tests pass; typecheck passes; lint passes.

### US-088: `elasticsearch` service type

**Description:** As a user, I can declare `type: elasticsearch` (Elastic License v2 image) and run cluster-health / index operations through tooling.

**Acceptance Criteria:**
- [ ] `elasticsearch` `ServiceType` with HTTP healthcheck on `/_cluster/health`.
- [ ] Defaults to single-node, security-disabled local dev config; service description warns this is not production-suitable.
- [ ] Scenario test starts the service, asserts `green` or `yellow` cluster health, runs `lando es-cli` (or equivalent tooling alias) against `/_cat/indices`.
- [ ] Tests pass; typecheck passes; lint passes.

### US-089: `opensearch` service type

**Description:** As a user, I can declare `type: opensearch` (Apache 2.0 image) and use the same query surface as `elasticsearch` against an Apache-licensed fork.

**Acceptance Criteria:**
- [ ] `opensearch` `ServiceType` with HTTP healthcheck on `/_cluster/health`.
- [ ] Service description notes the licensing distinction vs Elasticsearch.
- [ ] Scenario test mirrors US-088 with the OpenSearch endpoint.
- [ ] Tests pass; typecheck passes; lint passes.

### US-090: `meilisearch` service type

**Description:** As a user, I can declare `type: meilisearch` and use the Meilisearch HTTP API through tooling.

**Acceptance Criteria:**
- [ ] `meilisearch` `ServiceType` with HTTP healthcheck on `/health`.
- [ ] Default master key generation per §6.6 redaction rules.
- [ ] Scenario test creates an index, posts a document, queries it via `lando meili` tooling alias.
- [ ] Tests pass; typecheck passes; lint passes.

### US-091: framework-preset coverage extends to Go (if §6.12.1 grows)

**Description:** As maintainers, we keep the Beta cut of framework presets aligned with §6.12.1 — Beta does not add Drupal/Laravel/Symfony beyond Alpha but documents the Go framework slot as currently empty.

**Acceptance Criteria:**
- [ ] `go` `ServiceType` declares `framework: "none"` only; future entries (Echo, Fiber, Gin, Chi, etc.) deferred to post-GA with §6.12.1 cross-reference.
- [ ] Documentation table in `@lando/service-lando` README lists supported `framework:` values per language; Beta adds the `go` row.
- [ ] Tests pass; typecheck passes; lint passes.

### US-092: service contract suite covers every new type

**Description:** As a service-type maintainer, every new Beta service passes the `@lando/sdk/test` service-contract suite.

**Acceptance Criteria:**
- [ ] Contract-suite runner is matrix-driven over service type × provider × platform.
- [ ] Each new service type from US-083..090 has a contract-test entry; capabilities, endpoint emission, healthcheck schema, default-credential redaction, and `LANDO_*` env contract are exercised.
- [ ] Tests pass; typecheck passes; lint passes.

### US-093: `static` service type

**Description:** As a user, I can declare `type: static` (built-in nginx-backed) to serve a built artifact directory without writing a separate web-server service.

**Acceptance Criteria:**
- [ ] `static` `ServiceType` accepts `root:` (path within the service) and emits an HTTP endpoint.
- [ ] No special framework integration; behaves like a minimal nginx serving `root:`.
- [ ] Scenario test mounts a `dist/` directory, starts the service, fetches a known file.
- [ ] Tests pass; typecheck passes; lint passes.

### US-094: raw Compose passthrough service

**Description:** As a power user, I can declare `type: compose` with a `compose:` block that the planner passes through verbatim to the provider, while still respecting the Compose allowlist from §7.4.

**Acceptance Criteria:**
- [ ] `compose` `ServiceType` accepts only keys in the documented Compose subset; rejected keys produce a tagged remediation per the cross-cutting Compose allowlist.
- [ ] The passthrough still emits `LANDO_*` env vars, app-root bind mount (unless explicitly opted out per service), and per-app network membership.
- [ ] Scenario test exercises a representative passthrough (e.g. a third-party image not in the canonical catalog) and asserts the service starts and gets a default endpoint.
- [ ] Tests pass; typecheck passes; lint passes.

## Functional Requirements

- FR-1: Every §6.12.1 entry except `mailpit` is shipped by `@lando/service-lando` in Beta.
- FR-2: Each new service has a service-contract test, a scenario test, and at least one provider-integration test on Linux x64.
- FR-3: New services share the existing default-credential redaction rules from §6.6.
- FR-4: `compose:` passthrough rejects any key outside the documented allowlist with a remediation that names the rejected key and links to the spec section.
- FR-5: New services emit endpoints per §6.10; `lando info` displays them.

## Non-Goals

- New framework presets beyond what §6.12.1 already lists (post-GA additions per Phase 6).
- Mailpit as a project-level service — Mailpit ships only as a global service (PRD-05 US-115).
- Service-mode `lando shell` for any of the new services (PRD-10).
- Production-grade hardening of search-engine defaults (single-node, security-off is acceptable for local dev; warned in service description).

## Technical Considerations

- Image tag pinning: every new service pins a specific minor and SHA in `@lando/service-lando`; the codegen pipeline keeps the pin manifest consistent across services.
- Endpoint scheme rules: `mongodb://`, `memcached://`, `redis://`, `valkey://` (`valkey` emits both `valkey://` primary and `redis://` alias), and `http://` for HTTP-based services. `solr` uses `http://` with the admin path appended.
- Healthcheck protocol: HTTP-based services use the §6.6 HTTP healthcheck; binary protocols use `tcp:port`.
- The Compose passthrough is the documented escape hatch for service types we have not blessed; the allowlist is intentionally narrow to keep our maintenance surface predictable.

## Success Metrics

- Every §6.12.1 row in `@lando/service-lando` is implemented, contract-tested, scenario-tested, and integration-tested on Linux x64.
- `lando init` recipe catalog (PRD-07) can compose any §6.12.1 service without bespoke patches.
- Adding a new service type does not require changes outside `@lando/service-lando` and the relevant test fixtures.

## Guide Coverage

Per [PRD-12 US-198](./prd-beta-12-executable-guides-beta.md) (`## Guide Coverage` convention) and [US-199](./prd-beta-12-executable-guides-beta.md) (drift gate), this PRD owns the executable guides listed below. Each guide exercises the happy path of its mapped user story; failure modes remain covered by unit and integration tests in the named packages. PRs that touch the listed surface paths MUST also touch the corresponding guide(s), or use the `Guide-Coverage-Skip:` escape hatch.

**Guides owned by this PRD:**

| User Story | Feature | Guide Path | Acceptance |
|---|---|---|---|
| US-083 | go service type | `docs/guides/services/go.mdx` | Required at story acceptance |
| US-084 | mongodb service type | `docs/guides/services/mongodb.mdx` | Required at story acceptance |
| US-085 | memcached service type | `docs/guides/services/memcached.mdx` | Required at story acceptance |
| US-086 | valkey service type (dual-scheme emission) | `docs/guides/services/valkey.mdx` | Required at story acceptance |
| US-087 | solr service type | `docs/guides/services/solr.mdx` | Required at story acceptance |
| US-088 | elasticsearch service type | `docs/guides/services/elasticsearch.mdx` | Required at story acceptance |
| US-089 | opensearch service type | `docs/guides/services/opensearch.mdx` | Required at story acceptance |
| US-090 | meilisearch service type | `docs/guides/services/meilisearch.mdx` | Required at story acceptance |
| US-093 | static service type | `docs/guides/services/static.mdx` | Required at story acceptance |
| US-094 | raw Compose passthrough service | `docs/guides/services/compose-passthrough.mdx` | Required at story acceptance |

**CLI / source surface paths covered (drift gate input):**

- `plugins/service-mongodb/**`
- `plugins/service-memcached/**`
- `plugins/service-valkey/**`
- `plugins/service-solr/**`
- `plugins/service-elasticsearch/**`
- `plugins/service-opensearch/**`
- `plugins/service-meilisearch/**`
- `plugins/service-go/**`
- `plugins/service-static/**`
- `plugins/service-compose/**`

## Open Questions

- ~~Should `valkey` emit a `valkey://` scheme alongside `redis://` so apps can opt into protocol awareness?~~ **Resolved:** emit both — `valkey://` primary, `redis://` alias for client-compat (v3 compat axis: break when better).
- Should `elasticsearch` and `opensearch` share a single base class? Default: yes, with two `ServiceType` instances; the §6.10 endpoint scheme decides the surface.
- Should `compose:` passthrough services participate in the `LANDO_*` env contract by default? Default: yes; opting out requires explicit Landofile config.
