# PRD: L3P-04 — PHP depth + Compose `configs:` realization

## Introduction

PHP is the highest-traffic v3 migration path and currently ships a single shape: `php:<8.1..8.4>-apache-bookworm`, Composer pinned at one release, no Xdebug, no database client management. The new §6.12.5 makes serving modes, Composer selection, Xdebug, and `db_client:` normative; this PRD implements them plus PHP 8.5 (version additions need no spec amendment per §6.12.3) and closes the adjacent gap that Compose `configs:` entries — the natural home for custom `php.ini` — are accepted by the schema but never realized by the bundled providers.

Existing guides (`services/php*.mdx`, `tooling/xdebug-phpstorm.mdx`, `tooling/vscode.mdx`, `services/php-customization.mdx`) were written honestly around the missing features; each story updates the affected guides to exercise the real feature.

## Source References

- [`spec/06-services.md`](../06-services.md) §6.12.1 php row, §6.12.5 (normative for all four option families), §6.12.3 version rule.
- [`spec/06-services.md`](../06-services.md) §6.2 accepted `configs:` forms; [`spec/07-landofile-and-config.md`](../07-landofile-and-config.md) §7.4 Compose dispositions; provider capability gating (§5.5.1).
- [`spec/compose/prd-compose-04-rejection-and-conformance.md`](../compose/prd-compose-04-rejection-and-conformance.md) US-482 accepted-and-preserved contract.

## User Stories

### US-570: PHP 8.5 + Composer selection

**Description:** As a user, I can run `php:8.5` and choose my Composer version (or disable it) per §6.12.5.

**Acceptance Criteria:**

- [ ] `SUPPORTED_PHP_VERSIONS` gains 8.5 with a registered `php85ServiceType`; extension set parity verified for 8.5 images (build succeeds with the §6.12.1 extension list).
- [ ] `composer: "<major>" | "<exact>" | false` implemented: pinned-default unchanged; explicit versions fetched checksum-verified through the standard build-step path; `false` skips install; value participates in `buildKey`.
- [ ] Schema published + snapshots updated; invalid values fail at plan time with remediation.
- [ ] `docs/guides/services/php-version-matrix.mdx` and `docs/guides/tooling/php-composer-workflows.mdx` updated to exercise 8.5 and Composer selection; `services/php.mdx` version text updated; gates green.
- [ ] Tests pass; typecheck passes; lint passes.

### US-571: PHP serving modes (`via:`)

**Description:** As a user, I can choose `via: apache` (default), `via: fpm` (fronted by nginx), or `via: cli` (workers/tooling) per §6.12.5.

**Acceptance Criteria:**

- [ ] `via:` selects the image variant and service shape per §6.12.5; mode-invalid keys (`allowOverride:` under fpm/cli, HTTP route defaults under cli) fail closed at plan time with remediation.
- [ ] `via: fpm` exposes port 9000; the `nginx` service type's shared PHP presets can front a named FPM service (documented pairing works end-to-end).
- [ ] `via: cli` produces an idling container suitable for tooling/`command:` workers with no web server or HTTP route.
- [ ] All modes pass the composition contract; schemas + snapshots updated.
- [ ] `docs/guides/services/php.mdx` documents `via:` with a rendered fpm+nginx scenario replacing the "no fpm" caveat; gates green.
- [ ] Tests pass; typecheck passes; lint passes.

### US-572: Xdebug (`xdebug:`)

**Description:** As a user, I can enable Xdebug with `xdebug: true` (or a mode string) and toggle it with `lando xdebug on|off|status` — no manual image surgery.

**Acceptance Criteria:**

- [ ] `xdebug: true | "<modes>"` installs the extension as a checksum-pinned build step per PHP version (8.1–8.5) and enables it with `XDEBUG_MODE` from the option, `client_host` at the host gateway, port 9003; `false` (default) installs nothing.
- [ ] `lando xdebug on|off|status` service tooling toggles without rebuild (config toggle + server reload) across all `via:` modes.
- [ ] Value participates in `buildKey`; enabling emits nothing sensitive to events/transcripts.
- [ ] `docs/guides/tooling/xdebug-phpstorm.mdx` and `vscode.mdx` rewritten from "extension not installed" honesty text to real end-to-end flows (hidden scenario asserts the extension loads via `php -m`); `services/php-customization.mdx` updated; gates green.
- [ ] Tests pass; typecheck passes; lint passes.

### US-573: Database client auto-detection (`db_client:`)

**Description:** As a user, my PHP container automatically gets the right database client CLI for the databases in my app (`db_client: auto` default), or exactly what I ask for.

**Acceptance Criteria:**

- [ ] `auto` inspects resolved plan services with §6.12.4 creds opt-in and installs matching clients (mysql/mariadb client, postgresql-client, mongosh) as build steps; `false` installs none; explicit `"<family>:<version>"` forces; deterministic from the plan (no provider probing); participates in `buildKey`.
- [ ] Tooling invocations (`lando mysql`, `lando psql` style tasks from the DB service types) work from the PHP service against `services.<db>.creds.*`.
- [ ] Schema + snapshots updated; invalid values fail at plan time.
- [ ] Guide coverage: `docs/guides/services/switching-databases.mdx` or `php-customization.mdx` gains a rendered db_client scenario; gates green.
- [ ] Tests pass; typecheck passes; lint passes.

### US-574: Compose `configs:` provider realization

**Description:** As a user, `configs:` entries in my Landofile are actually materialized into containers by the bundled providers, so custom `php.ini` (and friends) need no bind-mount workaround.

**Acceptance Criteria:**

- [ ] Top-level `configs:` + service-level `configs` short/long forms realize as read-only file materializations in all three bundled providers (and `TestRuntimeProvider`), gated by a provider capability with fail-closed remediation when unsupported.
- [ ] Realization honors `source`/`target`/`mode`; content participates in plan identity so config changes trigger re-apply.
- [ ] Provider contract suite gains `configs:` realization assertions; all bundled providers pass.
- [ ] `docs/guides/config/compose-service-block.mdx` and `services/php-customization.mdx` updated to show `configs:`-based php.ini overrides; gates green.
- [ ] Tests pass; typecheck passes; lint passes.
