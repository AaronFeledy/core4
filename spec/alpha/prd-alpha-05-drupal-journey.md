# PRD: Alpha-05: Drupal journey

## Introduction

Drupal already ships under `recipes/drupal`. This PRD proves the canonical journey live on every compile target. It does not add a second Drupal recipe.

## Source References

- [`recipes/drupal/README.mdx`](../../recipes/drupal/README.mdx)
- [`spec/08-cli-and-tooling.md`](../08-cli-and-tooling.md) §8.8.10 bundled recipes
- [`spec/17-executable-tutorials.md`](../17-executable-tutorials.md) §19.13 recipe READMEs

## User Stories

### US-596: Drupal canonical journey on every compile target

**Description:** As a user, the existing Drupal recipe completes its canonical journey live on every compile target.

**Acceptance Criteria:**

- [ ] Uses the existing `recipes/drupal` recipe. Do not invent a second Drupal recipe.
- [ ] On every compile target, live: `lando init --recipe drupal`, `lando start`, `lando info`, the recipe README scaffold/Drush path, then `lando destroy -y`.
- [ ] `darwin-x64` uses provider-docker. Other targets use default provider `lando` unless setup already selected the supported Docker fallback after default setup failed.
- [ ] Compile-only or linux-only evidence fails the story.
- [ ] Tests pass; typecheck passes; lint passes

**Failure path:** A new Drupal recipe, skipped targets, compile smoke, or claiming Drupal is unavailable.

**Verification:** Per-target live evidence of init, start, info URL, scaffold/Drush, and destroy on all six compile targets.
