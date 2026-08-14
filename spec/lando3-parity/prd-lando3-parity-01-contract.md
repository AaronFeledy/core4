# PRD: L3P-01 — Contract (spec amendments)

## Introduction

This PRD records the normative spec changes the rest of the wave implements. The text lands together with the PRD set so every later story implements written spec, never folklore.

## Source References

- [`spec/06-services.md`](../06-services.md) §6.12.1 (amended php row + tomcat/varnish/dotnet/mssql/phpmyadmin rows), new §6.12.5 (PHP depth), §6.12.3 (membership rules authorizing the amendment).
- [`spec/08-cli-and-tooling.md`](../08-cli-and-tooling.md) §8.8.10 (reconciled bundled recipe table + staged list), new §8.8.15 (recipe composition), new §8.8.16 (recipe option parity).
- [`spec/11-subsystems.md`](../11-subsystems.md) §10.7 (bundled `@lando/sql` reference plugin).
- [`spec/ROADMAP.md`](../ROADMAP.md) Phase 5 concurrent-wave note; Phase 9 supersession strikethroughs.
- [`spec/07-landofile-and-config.md`](../07-landofile-and-config.md) §7.5/§7.6 and [`spec/08-cli-and-tooling.md`](../08-cli-and-tooling.md) §8.1/§8.5 — unchanged; already normative for the Landofile keys this wave un-gates.

## User Stories

### US-561: Spec contract for the Lando 3 parity wave

**Description:** As a maintainer, the spec authorizes every implementation story in this wave: the amended service catalog, PHP depth options, recipe composition and option parity, the reconciled recipe bundle, and the pulled-forward `@lando/sql` plugin — without weakening any recorded rejection (SSH mounts, hosters, staged recipes).

**Acceptance Criteria:**

- [ ] §6.12.1 php row lists 8.5 and references §6.12.5; catalog gains `tomcat`, `varnish`, `dotnet`, `mssql`, `phpmyadmin` rows with base/version/behavior columns.
- [ ] §6.12.5 normatively defines `via:`, `composer:`, `xdebug:`, and `db_client:` including defaults, fail-closed invalid combinations, and buildKey participation.
- [ ] §8.8.10 bundled table matches the target bundle (wordpress, drupal, drupal-cms, laravel, symfony, backdrop, joomla, mean, lamp, lemp, toolbox); staged additions and hoster/compat exclusions are explicit; the stale "Drupal out of scope" sentence is gone.
- [ ] §8.8.15 defines `extends:` (single inheritance, depth ≤ 3, id-keyed prompt merge, path-keyed file merge, concatenated postInit, flattened-manifest validation).
- [ ] §8.8.16 defines option parity floors for `drupal`, `drupal-cms`, `lamp`.
- [ ] §10.7 names bundled `@lando/sql` as the reference SQL-helper plugin built on `DataMover` (§10.11) with its command surface.
- [ ] ROADMAP Phase 5 carries the lando3-parity concurrent-wave note; Phase 9 `@lando/sql` and recipe lines are marked superseded.
- [ ] No change to §10.4 SSH rejection, §10.12 RemoteSource freeze, or §7.4 Compose rejected-key list.
- [ ] Tests pass; typecheck passes; lint passes (spec-only change; gates prove no accidental source drift).
