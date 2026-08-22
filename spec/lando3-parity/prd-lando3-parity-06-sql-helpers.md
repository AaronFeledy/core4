# PRD: L3P-06 — Bundled `@lando/sql` helpers

## Introduction

Lando 3's `db-import`/`db-export` workflow is the most-used data workflow with no v4 analog. The `DataMover` primitive and provider data plane shipped in Alpha 4 precisely to host this consumer; the 4.1 staging was scheduling, not architecture. This PRD pulls the bundled `@lando/sql` plugin forward per the amended §10.7.

The plugin is a new `plugins/sql` workspace package (plugins may not depend on `@lando/core`; command contribution flows through the generated composition root, and byte movement flows through `DataMover` — the `state-store`/`probe`/`paths` boundary rules apply).

## Source References

- [`spec/11-subsystems.md`](../11-subsystems.md) §10.7 (amended: `@lando/sql` reference plugin + required behaviors), §10.11 DataMover + provider data plane.
- [`spec/06-services.md`](../06-services.md) §6.12.4 creds contract (target discovery), §6.10 service info discovery metadata.
- [`spec/08-cli-and-tooling.md`](../08-cli-and-tooling.md) §8.11 machine output; renderer progress frames.

## User Stories

### US-579: `@lando/sql` plugin (`db:import`/`db:export`/`db:snapshot`/`db:restore`/`db:reset`)

**Description:** As a user, I can import and export databases (`lando db:import dump.sql.gz`, `lando db:export`), and snapshot/restore/reset them, against any creds-bearing bundled database type.

**Acceptance Criteria:**

- [ ] New bundled `plugins/sql` package contributing the five commands; wired through bundled-plugin codegen + composition root; `bun install` run; test shards include it.
- [ ] Engine support per DB family: MySQL-family (mysql/mariadb), PostgreSQL, MongoDB, and `mssql` (via `sqlcmd`); family resolved from the target service's type + §6.12.4 creds; single-DB apps need no flag, multi-DB apps require `--service` (ambiguity is a tagged error listing candidates).
- [ ] All byte movement rides `DataMover`/provider data plane (host file ↔ service command endpoints); no bespoke tar/stream code; gzip transparently supported both directions; snapshots land in the DataMover snapshot store indexed via StateStore.
- [ ] `db:import` into a non-empty database requires confirmation (`--yes` bypass); `db:reset` likewise; destructive steps are enumerated before execution.
- [ ] Credentials route through `RedactionService` everywhere; progress renders as renderer task frames; `--format json` emits the §8.11 envelope/stream frames for all five commands with machine-output conformance coverage.
- [ ] Executable guide `docs/guides/tooling/db-import-export.mdx` (import, export, gzip, snapshot/restore, reset, multi-DB `--service`); coverage/INDEX gates green.
- [ ] Tests pass; typecheck passes; lint passes.

## Guide Coverage

| User Story | Feature | Guide Path | Status |
|---|---|---|---|
| US-579 | database import, export, snapshot, restore, and reset | `docs/guides/tooling/db-import-export.mdx` | Shipped |
