# PRD: L3P-05 — Recipe composition + L3-parity recipes

## Introduction

This PRD lands recipe-to-recipe composition (`extends:`, §8.8.15), brings the existing bundled recipes up to the §8.8.16 option-parity floor, and adds the five L3-parity recipes (`laravel`, `symfony`, `backdrop`, `joomla`, `mean`). Stories are ordered so the composition mechanism exists before the recipes that use it, and option-parity machinery (which the new recipes reuse) lands before the new recipes.

Every recipe ships `recipes/<id>/README.mdx` as an executable guide (§19.13) feeding both scenario generation and scaffold README generation, plus registration in `scripts/build-bundled-recipes.ts` with clean codegen. Recipe work MUST load the `lando-write-docs` skill for README authoring.

## Guide Coverage

| User Story | Feature | Guide Path |
|---|---|---|
| US-575 | Recipe composition (extends) | `docs/guides/recipes/extending-recipes.mdx` |

## Source References

- [`spec/08-cli-and-tooling.md`](../08-cli-and-tooling.md) §8.8.2 layout, §8.8.10 amended bundle, §8.8.15 `extends:`, §8.8.16 option parity, §8.8.12 constraints.
- [`spec/06-services.md`](../06-services.md) §6.12.5 (PHP options recipes now expose), §6.12.1 (node/mongodb rows for `mean`).
- [`spec/13-testing-and-distribution.md`](../13-testing-and-distribution.md) recipe test layer + bundled-recipe drift gates.

## User Stories

### US-575: Recipe composition (`extends:`)

**Description:** As a recipe author, I can declare `extends: <recipe-ref>` and ship only my deltas, per §8.8.15.

**Acceptance Criteria:**

- [ ] `RecipeManifest` schema gains `extends:` (+ prompt `drop: true`); SDK snapshots updated.
- [ ] Resolution flattens single-inheritance chains (depth ≤ 3, acyclic; violations are tagged errors naming the chain) before validation; downstream consumers see only flattened manifests.
- [ ] Merge semantics per §8.8.15: prompts by id (override/append/drop), `files:` by path (child wins), `postInit:` concatenated parent-then-child, scalars from child.
- [ ] Non-bundled parents resolve through the standard source registry with lockfile pinning; `meta recipes describe` shows the flattened result; `meta recipes validate` validates a child with a resolvable parent.
- [ ] `recipe.ts` manifests may return `extends:`; merge runs post-factory.
- [ ] `docs/guides/recipes/extending-recipes.mdx` executable guide (authoring a child recipe over `lamp`); coverage/INDEX gates green.
- [ ] Tests pass; typecheck passes; lint passes.

### US-576: Option parity for `drupal`, `drupal-cms`, `lamp`

**Description:** As a user initializing drupal/drupal-cms/lamp, I get real stack choices (PHP version, webserver, DB engine+version, Composer version, webroot) instead of fixed pins, per §8.8.16.

**Acceptance Criteria:**

- [ ] `drupal`: Drupal major choice, PHP 8.1–8.5 choice, `apache` | `nginx`+FPM webserver choice (via §6.12.5 `via:`), MariaDB/MySQL/PostgreSQL choice with versions, `webroot:` prompt, Composer version option; every prompt has a non-interactive default.
- [ ] `drupal-cms`: inherits the drupal surface; generated app serves the scaffold's real docroot (`/app/web`); README exercises scaffold + project-local Drush end-to-end (Drush via the project's Composer manifest, not a bare global binary).
- [ ] `lamp`: MariaDB/MySQL choice with versions, PHP version choice, Composer option, `webroot:` prompt.
- [ ] Each README.mdx exercises at least one non-default variant; recipe test layer + guide gates green; bundled-recipe codegen clean.
- [ ] Tests pass; typecheck passes; lint passes.

### US-577: `laravel` + `symfony` recipes

**Description:** As a user, I can `lando init --recipe laravel` or `--recipe symfony` and get the §8.8.10 promised stacks.

**Acceptance Criteria:**

- [ ] `laravel`: PHP with Composer, MariaDB-or-PostgreSQL choice, Redis, optional queue-worker service (`via: cli` PHP worker); artisan/composer tooling wired.
- [ ] `symfony`: PHP with Composer, PostgreSQL-or-MariaDB choice, Redis; console/composer tooling wired.
- [ ] Both use §6.12.5 options where the prompts call for them, have non-interactive defaults for every prompt, register in bundled-recipe codegen, and ship executable README.mdx guides with at least one non-default variant.
- [ ] Recipe test layer + guide gates green; `meta recipes list/describe/validate` pass through machine output.
- [ ] Tests pass; typecheck passes; lint passes.

### US-578: `backdrop`, `joomla`, `mean` recipes

**Description:** As a user, I can initialize Backdrop, Joomla, and MEAN-style stacks, completing the L3 recipe parity set.

**Acceptance Criteria:**

- [ ] `backdrop` and `joomla` extend `lamp` per §8.8.15 (proving `extends:` on real bundled recipes), overriding prompts/files for CMS-specific scaffolding and tooling.
- [ ] `mean`: Node service with MongoDB and optional Redis; npm-script tooling; framework-agnostic Express-style default scaffold.
- [ ] All three: non-interactive defaults, bundled-recipe codegen registration, executable README.mdx with a non-default variant, recipe test layer + guide gates green.
- [ ] `.local` parity rows for backdrop/joomla/mean flip to ✅ in the US-581 refresh (no action here beyond making it true).
- [ ] Tests pass; typecheck passes; lint passes.
