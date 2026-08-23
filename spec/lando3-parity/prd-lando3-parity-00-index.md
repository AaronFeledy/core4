# PRD set: Lando 3 Parity

## Introduction

A 2026-08 parity audit (`.local/LANDO3-PARITY.md` plus the plugin-parity scout) compared every Lando 3 CLI command, config surface, service, recipe, and guide against this repository. Most documentation gaps have since been closed by the executable-guide backlog. What remains are **functionality** gaps in three classes:

1. **Spec'd-but-rejected surface (contract gaps).** The Landofile keys `events:`, `toolingDefaults:`, `commandAliases:`, and top-level `env_file:` are fully specified 4.0 surface (§7.5, §8.1, §8.5, §7.6) but rejected at parse time by the `BETA_TOP_LEVEL_KEYS` gate in `landofile/src/service.ts`. The §6.12.1 canonical catalog requires `rabbitmq`, `minio`, `localstack`, `mailpit`, and `mailhog` service types that are absent from the runtime registry. The §8.8.10 recipe table promised recipes that never shipped while omitting recipes that did.
2. **L3 functionality with no v4 spec home (now amended in).** PHP depth (Xdebug, serving modes, Composer options, PHP 8.5, `db_client` auto-detection — new §6.12.5), the L3 service types `tomcat`, `varnish`, `dotnet`, `mssql`, `phpmyadmin` (catalog amendment), recipe composition (`extends:` — new §8.8.15), recipe option parity (§8.8.16), and Compose `configs:` provider realization.
3. **Deliberately staged work pulled forward.** The bundled `@lando/sql` helpers (`db:import`/`db:export`/`db:snapshot`/`db:restore`/`db:reset`) move from the 4.1 roadmap into this wave, built entirely on the shipped `DataMover` primitive and provider data plane (§10.7, §10.11).

This wave lands concurrently with Beta 1 as **feature-surface completion before freeze**: every item either implements already-normative spec text or implements the spec amendments recorded by this set.

US-581 closed the original planned wave. PRD-08 is a residual tranche for holes in **shipped** functionality — Verify leftovers plus catalog/CLI/recipe/doctor gaps users can already reach.

## How to use this set of PRDs

1. Spec parts are normative; these PRDs sequence implementation.
2. Execute stories in `prd.json` **priority** order (strict). Ordering guarantees no story depends on a later story.
3. US-561 is contract/scaffolding (spec text) and lands with the PRD set.
4. Every story that adds user-visible surface ships its executable guide(s) in the same story — guides are docs-as-tests, not follow-up work. Load the `lando-write-docs` skill before authoring any guide or README.
5. New service types MUST satisfy the full §6.12.1 per-service-type implementation checklist in the same change (resolution shape, contract suites, tooling, creds where applicable).
6. Full-suite lock is always `bun test` (or explicit shard `--run` commands) with positive test counts.

## PRDs in this set

| # | PRD | Subsystem | Depends on |
|---|-----|-----------|------------|
| 00 | this index | wave map | — |
| 01 | Contract | spec text amendments (§6.12.1, §6.12.5, §8.8.10, §8.8.15, §8.8.16, §10.7, ROADMAP) | — |
| 02 | Landofile keys | un-gate + implement `env_file`, `toolingDefaults`, `commandAliases`, `events` | 01 |
| 03 | Service catalog completion | rabbitmq, minio, localstack, mailpit, mailhog, tomcat, varnish, dotnet, mssql, phpmyadmin | 01 |
| 04 | PHP depth + configs realization | PHP 8.5, Composer options, serving modes, Xdebug, `db_client`, Compose `configs:` | 01 |
| 05 | Recipes | `extends:`, option parity (drupal/drupal-cms/lamp), laravel, symfony, backdrop, joomla, mean | 01, 04 (05 stories in listed order) |
| 06 | SQL helpers | bundled `@lando/sql` plugin on `DataMover` | 01 (03 for `mssql` coverage) |
| 07 | Docs closure | residual guides (cache-refresh, verbosity, DNS rebind), parity-audit refresh, wave closure | all prior |
| 08 | Residual hardening | shipped-feature holes: CLI verbs, catalog connect, inventory, cache identity, purge, docs/redaction, PHP×Composer, doctor ports | 07 |

## Dependency graph

```
US-561 (contract; spec text lands with PRD set)
    → US-562..565 (Landofile keys: env_file → toolingDefaults → commandAliases → events)
    → US-566..569 (service catalog: required trio → mail types → tomcat/varnish → dotnet/mssql/phpmyadmin)
    → US-570..574 (PHP depth: 8.5+composer → serving modes → xdebug → db_client → configs realization)
    → US-575..578 (recipes: extends → option parity → laravel/symfony → backdrop/joomla/mean)
    → US-579 (@lando/sql)
    → US-580..581 (docs residue → original-wave closure)
    → US-584..591 (residual hardening)
```

Parallelism notes: PRD-02, PRD-03, and PRD-04 are mutually independent after US-561 and MAY be worked in parallel by separate agents; the strict priority order above is the safe serial order. PRD-05 depends on PRD-04 (serving modes, Composer options feed §8.8.16 option parity) and its own US-575 (backdrop/joomla extend lamp). US-579 depends only on shipped primitives plus US-569 for the optional `mssql` coverage. US-580..581 closed the original wave. PRD-08 (US-584..US-591) is the residual tranche and MAY run in parallel except US-585 should land before anything that assumes `ServiceInfo.creds` is populated, and US-590 should land before recipe-README edits that mention Composer pins.

## Verification contract

Every story ends with tests/typecheck/lint plus the touched semantic gates:

- `bun run typecheck` and `bun test` (root `tsc -b` does not typecheck `sdk/test/`; run both)
- `bun run lint`; `bun run codegen:check` when generated outputs are touched (schema snapshots, bundled recipes/plugins, command registry)
- `bun run check:boundaries` (notably `renderer-boundary`, `probe`, `paths`, `package-dag`, `spec-reference`)
- `bun run check:guide-coverage`, `bun run check:guide-drift`, `bun run lint:guides` for every story that adds or edits guides/READMEs; focused guide passes via `bun run dev:guides <guide> --once` with positive test counts
- SDK/schema changes follow `sdk/AGENTS.md`: update `sdk/API_COMPATIBILITY.md` where required and refresh snapshots via `bun run codegen:schema-snapshot`
- New `plugins/*` workspace packages require `bun install` and test-shard inclusion

## Cross-cutting non-goals

- Hoster connectors (`acquia`, `lagoon`, `pantheon`, `platformsh`) and any `RemoteSource`/`Dataset` implementation — contract-frozen, 4.1 (§10.12; PRD-17 precedent).
- Custom SSH-key mounts / `sshAgent.sidecar: false` — explicitly rejected (§10.4, mission-and-tenets decision log); this wave does not reopen it.
- The §8.8.10 **staged** recipes (`node-api`, `astro`, `sveltekit`, `nextjs`, `django`, `fastapi`, `rails`, `jekyll`, `hugo`, `eleventy`, `empty`) — 4.x growth by adoption signal.
- `image save`/`load` DataMover consumers — remains 4.1.
- 4.1 deferred commands (`meta:events:follow`, `meta:plugin:login`, `meta:plugin:logout`).
- v3 compatibility shims, `experimental:` toggles, or orchestrator keys — dropped by design.
- A "Lando 101" course sequence — optional editorial work, not parity.
- Changing omitted-`creds:` defaults from `lando`/`lando`/appName to `{{ service.name }}`.
- Fingerprinting environment, host, or template-render inputs for cache identity.
- Client tooling the catalog row does not promise (varnishadm, mailpit CLIs, …).

## Exit criteria

All US-561..US-591 `passes: true` with green verification. The four Landofile keys parse, plan, and execute per spec with guides. Every §6.12.1 catalog row has a registered runtime service type passing the composition contract. PHP supports 8.5, `via:`, `composer:`, `xdebug:`, and `db_client:` per §6.12.5. `configs:` entries are realized by the bundled providers. `extends:` works per §8.8.15; the §8.8.10 bundled recipe table matches `recipes/` exactly; drupal/drupal-cms/lamp meet §8.8.16. `lando db:import`/`db:export` and friends work against the creds-bearing database types. `.local/LANDO3-PARITY.md` is refreshed to show no ❌ rows without a recorded decision.

Residual tranche: space-separated `scratch` / `recipes` / `share` verbs route; bundled databases honor authored `creds:`, emit `LANDO_DB_*`, ship healthchecks and client tooling (including `redis-cli` and phpMyAdmin `hosts:` creds); `apps:list` shows started apps; plan cache invalidates across binary/plugin rebuilds; `uninstall --purge` clears managed volume trees; JSON/MCP envelopes redact env-file secrets; incompatible PHP × Composer pairs fail closed; leftover proxy ports are a doctor/start remediation.

## Spec parts that remain authoritative

§6.9 (env contract), §6.12 (catalog + checklist + creds + §6.12.5), §7.5–§7.6 (Landofile keys, env overrides), §8.1 (aliases), §8.4 (parser taxonomy), §8.5 (tooling schema), §8.8 (recipes incl. §8.8.15–§8.8.16), §8.11 (machine output), §10.7 (SQL helpers), §10.8 (uninstall / doctor), §10.11 (DataMover), §11 (events), §12 (caches), §18 (deprecation — mailhog), §19 (executable guides), §21.10 (scratch CLI).
