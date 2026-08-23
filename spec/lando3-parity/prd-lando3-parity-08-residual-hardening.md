# PRD: L3P-08 — Residual hardening

## Introduction

US-581 closed the planned Lando 3 parity wave. Compiled-CLI Verify and Review then recorded leftover defects that were correctly out of those stories' acceptance criteria. This PRD is the residual tranche: close holes in **shipped** functionality so the features we already tell users they have actually work well.

4.1 and rejected surfaces stay out. Everything else that is already on a user's path — catalog types, recipe options, CLI aliases, host inventory, doctor, docs, redaction — gets finished.

Source of the list: `spec/lando3-parity/progress.txt` Verify/Review findings plus a shipped-surface pass over catalog types, recipe prompts, and dispatcher aliases.

## Source References

- [`spec/08-cli-and-tooling.md`](../08-cli-and-tooling.md) §8.2 `apps:list`, §8.4 shipped parser taxonomy, §8.9 / §8.11 renderer and machine output.
- [`spec/19-scratch-apps.md`](../19-scratch-apps.md) §21.10 CLI surface and §21.10.2 bare `scratch` reservation.
- [`spec/06-services.md`](../06-services.md) §6.12.1 checklist (tooling + creds + healthchecks), §6.12.4 uniform `creds:` contract, §6.9 `LANDO_DB_*`, §6.12.5 Composer pins.
- [`spec/12-caches-and-persistence.md`](../12-caches-and-persistence.md) §12.1 app-plan cache identity.
- [`spec/11-subsystems.md`](../11-subsystems.md) §10.8 `lando uninstall --purge` / `lando doctor`, §10.11 DataMover / applied plan.
- [`spec/05-runtime-providers.md`](../05-runtime-providers.md) provider `resolvePlan` / applied-plan persistence.
- [`spec/07-landofile-and-config.md`](../07-landofile-and-config.md) §7.1.1 file-only cache freshness (do not fingerprint env/host/template inputs).
- [`spec/18-global-app.md`](../18-global-app.md) Traefik / global proxy ports.

## User Stories

### US-584: Space-separated CLI verbs

**Description:** As a user, `lando scratch list`, `lando recipes describe`, and `lando share list` dispatch to the matching canonical command instead of being swallowed by the bare topic alias.

**Acceptance Criteria:**

- [ ] §8.4 shipped parser taxonomy gains these compatibility forms alongside the existing `apps scratch run` / `meta recipes …` / `global …` forms:
  - `scratch <start|stop|destroy|list|info|logs|gc|run>`
  - `recipes <list|describe|validate>`
  - `share <list|stop>`
- [ ] Bare `scratch` with no verb (or only start flags) remains the `apps:scratch:start` shortcut. Bare `recipes` remains `meta:recipes:list`. Bare `share` remains `app:share`.
- [ ] Space-separated, colon-alias, and canonical forms share JSON command identity (`lando scratch list` ≡ `apps:scratch:list`, `lando recipes describe` ≡ `meta:recipes:describe`, `lando share list` ≡ `app:share:list`).
- [ ] `lando scratch list` no longer raises `InvalidCliInvocationError` / unexpected argument `list`. Same class of failure is gone for `recipes` and `share`.
- [ ] Dispatch tests cover every added verb in all three forms, including that the bare shortcuts still start/list/share.
- [ ] Tests pass; typecheck passes; lint passes.

### US-585: Catalog connect contract (`creds:`, client tooling, healthchecks)

**Description:** As a user, authored `creds:` on a bundled database actually provision those accounts, sibling admin UIs can log in, and the catalog's promised client CLIs work.

**Acceptance Criteria:**

- [ ] `mysql`, `mariadb`, `postgres`, `mongodb`, and `mssql` apply authored `creds.user` / `creds.password` / `creds.database` / `creds.rootPassword` to the family env vars and to `LANDO_DB_*`. Container `user:` is not a database username.
- [ ] When `creds:` is omitted, existing defaults stay (`lando` / `lando` / appName and the generated root password, `sa` + `SA_PASSWORD` for mssql). Do not switch to the unused §6.12.4 default-defaults of `{{ service.name }}`.
- [ ] Resolved creds appear on `normalizedConfig.creds` and `ServiceInfo.creds` so phpMyAdmin wiring, `@lando/sql`, and `services.<name>.creds.*` expressions see them.
- [ ] phpMyAdmin `hosts:` still resolves credentials: when a host name matches a MySQL-family sibling, use that sibling's creds; otherwise fail closed asking for explicit creds rather than silently using `lando`/`lando`.
- [ ] Each type contributes the catalog-promised client tooling targeting that service (`mysql`, `mariadb`, `psql`, `mongosh`, `sqlcmd`, `redis-cli`), with secret-shaped creds in the task env redacted.
- [ ] `mysql`, `mariadb`, and `postgres` ship a real healthcheck (mongodb already has one). Catalog types that already declare a probe keep it.
- [ ] `lando mysql --version` (and the family equivalents, including `lando redis-cli ping`) compile after start / `app:cache:refresh` on a single-target app. Partial authored creds fall through to env/defaults rather than inventing `lando` over a missing field.
- [ ] `docs/guides/services/{mysql,mariadb,postgres,mongodb,mssql,redis,phpmyadmin}.mdx` show authored `creds:` / the client command / `hosts:` creds behavior as applicable; guide gates green.
- [ ] Tests pass; typecheck passes; lint passes.

### US-586: Applied-plan inventory and reload

**Description:** As a user, after I start an app, `lando apps:list` shows it, and a later CLI process can still exec against the applied plan.

**Acceptance Criteria:**

- [ ] After `lando start`, `lando apps:list` and `lando apps:list --format=json` include that app (matching `appRoot`) while `lando info` reports it running, using the same `userDataRoot`.
- [ ] Applied-plan persistence is written where `apps:list` already knows to read (`readAppliedPlansFromUserData` and/or socket discovery). Do not invent a second inventory.
- [ ] `provider-docker` reloads the persisted applied plan after process restart so `exec` / DataMover `serviceCmd` work the way `provider-lando` already does. Do not attach `AppPlan` onto DataMover (US-579 Review rejected that).
- [ ] Focused tests cover list discovery after start and docker `resolvePlan` reload after a fresh process.
- [ ] Tests pass; typecheck passes; lint passes.

### US-587: App-plan cache identity includes the planning runtime

**Description:** As a user, rebuilding the Lando binary or changing a bundled service-type plugin does not reuse a stale `plan.bin` whose Dockerfile `RUN` already failed.

**Acceptance Criteria:**

- [ ] `deriveAppPlanCacheKey` includes a non-secret fingerprint of the planning implementation (binary version and/or bundled plugin/source identity). Landofile-only identity is insufficient.
- [ ] Do not fingerprint environment, host, or template-render inputs (§7.1.1 / US-564 adjudication).
- [ ] Changing the fingerprint forces a cache miss; the same fingerprint + same Landofile remains a hit.
- [ ] Tests pass; typecheck passes; lint passes.

### US-588: Uninstall purge of managed volume trees

**Description:** As a user, `lando uninstall --purge` removes Lando-managed runtime storage, including root-owned database volume files.

**Acceptance Criteria:**

- [ ] `--purge` deletes the managed runtime storage tree (including `runtime/storage/volumes/*`) even when files are root-owned, or fails closed with a tagged error naming the path and a remediation that can finish the delete.
- [ ] Focused uninstall/purge tests cover a root-owned file under a managed volume path.
- [ ] Tests pass; typecheck passes; lint passes.

### US-589: Residual docs + machine-output env-file redaction

**Description:** As a user, published docs name the real command ids, and JSON/MCP results do not leak env-file secrets.

**Acceptance Criteria:**

- [ ] README CLI sample lists `app:cache:refresh`, `app:includes:update`, and `app:includes:verify` — not bare `cache:refresh` / `includes:*` aliases (those aliases do not exist).
- [ ] `docs/guides/cli/output-streaming.mdx` does not group `--renderer=verbose` with the task tree; verbose is a payload dump, consistent with `verbosity-and-debug.mdx`.
- [ ] Secret-shaped values from top-level and service-level `env_file` are redacted in `--format=json` command results and MCP envelopes the same way events already redact them (US-562 Review deferred this as §8.11).
- [ ] Guide gates green for touched docs; focused redaction tests cover JSON + MCP.
- [ ] Tests pass; typecheck passes; lint passes.

### US-590: PHP × Composer compatibility

**Description:** As a user, I cannot init or plan a PHP + Composer pair that the pinned Composer release cannot run cleanly.

**Acceptance Criteria:**

- [ ] Plan time fails closed when an exact Composer pin is known-incompatible with the PHP version (the shipped case is `php:8.5` + `composer: "2.7.7"`), with tagged remediation pointing at `composer: "2"` (2.10.2) or a newer exact pin.
- [ ] Bundled recipe prompts that offer both PHP versions and Composer pins do not present the incompatible pair (hide `2.7.7` when PHP ≥ 8.5, or equivalent). Hand-written Landofiles still hit the plan-time gate.
- [ ] `composer: "2"` remains the 2.10.2 channel pin and stays valid on PHP 8.1–8.5. Do not silently rewrite an authored exact pin.
- [ ] php-composer-workflows and the affected recipe READMEs (lamp / drupal / laravel / etc.) stay true; guide gates green.
- [ ] Tests pass; typecheck passes; lint passes.

### US-591: Doctor leftover proxy ports

**Description:** As a user, a leftover host `rootlessport` on the Traefik loopback ports is a diagnosed, remediable problem — not an opaque `GlobalAutoStartError` / `ProviderUnavailableError`.

**Acceptance Criteria:**

- [ ] `lando doctor` probes the bundled proxy loopback ports (`127.0.0.1:38080` and the matching TLS port) and, when a leftover Lando/`rootlessport` holder is present, reports a tagged check with remediation (`global:stop`, reap, or `setup`).
- [ ] Start / `global:start` maps "address already in use" on those ports to that same tagged remediation instead of a generic bind / `ProviderUnavailableError`.
- [ ] Existing orphan-PID doctor checks stay; this is an additional port-bind check, not a replacement.
- [ ] Tests pass; typecheck passes; lint passes.

## Guide Coverage

| User Story | Feature | Guide Path |
|---|---|---|
| US-585 | authored `creds:`, client CLIs, phpMyAdmin `hosts:` | `docs/guides/services/{mysql,mariadb,postgres,mongodb,mssql,redis,phpmyadmin}.mdx` |
| US-589 | verbose is a payload dump | `docs/guides/cli/output-streaming.mdx` |
| US-590 | incompatible PHP × Composer pair | php-composer-workflows + affected recipe READMEs |

US-584, US-586, US-587, US-588, and US-591 are routing, inventory, cache-identity, uninstall, and doctor fixes. Existing pages stay unless a sentence becomes false.

## Non-goals

- Do not reopen hosters, SSH `sidecar: false`, staged recipes, image save/load, or the 4.1 deferred commands (`meta:events:follow`, `meta:plugin:login`, `meta:plugin:logout`).
- Do not change omitted-`creds:` defaults from `lando` / `lando` / appName to `{{ service.name }}`.
- Do not fingerprint env/host/template-render inputs for any cache.
- Do not attach `AppPlan` onto DataMover.
- Do not silently bump an authored exact Composer pin. Fail closed or hide the incompatible recipe choice instead.
- Do not add restore confirmation, live dump `<Run>`s under `provider: test`, RabbitMQ listen-port rewrite, Docker qemu detection on Linux, or Varnish `varnishadm` tooling (the varnish catalog row does not promise it).
- Do not invent client tooling the catalog row does not promise (mailpit, tomcat, nginx, apache, …).
