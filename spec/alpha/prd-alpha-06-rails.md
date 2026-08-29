# PRD: Alpha-06: Rails

## Introduction

Rails is not in `recipes/` today. A builtin stub exists under `core/src/recipes/builtin/rails`. Alpha 1 adds Rails in strict order: contract, then bundled recipe, then the all-six live journey. `recipes/` is public recipe SoT. Upgrade the stub. Do not duplicate it.

## Source References

- [`core/src/recipes/builtin/rails/manifest.ts`](../../core/src/recipes/builtin/rails/manifest.ts) (stub to upgrade)
- [`spec/08-cli-and-tooling.md`](../08-cli-and-tooling.md) section 8.8.10 (durable Rails contract US-597 edits; bundled vs staged)
- [`spec/17-executable-tutorials.md`](../17-executable-tutorials.md) §19.13
- Laravel/Symfony upgrade precedent: move the stub into `recipes/<id>/`, keep one runtime source

## User Stories

### US-597: Rails recipe contract

**Description:** As a recipe author, the Rails recipe contract is written before any public `recipes/rails` implementation.

**Acceptance Criteria:**

- [ ] US-597 edits `spec/08-cli-and-tooling.md` section 8.8.10 as the durable Rails contract. That edit moves Rails from staged to bundled for Alpha 1 and states that `recipes/rails/` is the public recipe source of truth, while the existing builtin stub is upgraded rather than duplicated.
- [ ] Contract names id `rails`, public SoT `recipes/rails/`, prompts, services (Ruby/Rails, PostgreSQL, Redis), tooling (`rails`, `bundle`), non-interactive defaults, and executable README.mdx requirements.
- [ ] Implementation order stays contract, then bundled recipe (US-598), then the all-six journey (US-599). This story does not ship `recipes/rails/` or the journey.
- [ ] Tests pass; typecheck passes; lint passes

**Failure path:** Implementing `recipes/rails` or the journey before this contract. Adding a second rails source. Leaving Rails staged in section 8.8.10.

**Verification:** `spec/08-cli-and-tooling.md` section 8.8.10 lists Rails as bundled for Alpha 1 and names `recipes/rails/` as public SoT. `recipes/rails` is not required yet. The builtin stub remains the only rails tree until US-598.

### US-598: Rails bundled recipe

**Description:** As a user, `lando init --recipe rails` scaffolds from `recipes/rails`, upgrading the builtin stub instead of adding a second source.

**Acceptance Criteria:**

- [ ] `recipes/rails/` exists with `recipe.yml` or `recipe.ts`, executable README.mdx, and bundled-recipe codegen registration.
- [ ] The existing builtin rails stub is upgraded into that tree. Do not keep two public rails recipes.
- [ ] Non-interactive defaults exist for every prompt. `meta recipes list/describe/validate` include `rails` through machine output.
- [ ] Tests pass; typecheck passes; lint passes

**Failure path:** Duplicate rails sources, a README that is not executable-guide-valid, or skipping bundled-recipe codegen.

**Verification:** `lando init --recipe rails --yes` in an isolated LANDO home. Recipe test layer with a positive test count. `codegen:check` for bundled recipes. Guide gates if README.mdx is touched.

### US-599: Rails canonical journey on every compile target

**Description:** As a user, the Rails canonical journey completes live on every compile target.

**Acceptance Criteria:**

- [ ] Requires US-595 live setup/doctor and US-598 bundled recipe. Do not run this story against the builtin stub alone.
- [ ] On every compile target, live: `lando init --recipe rails`, `lando start`, `lando info`, the recipe README verify path (`rails`/`bundle`), then `lando destroy -y`.
- [ ] `darwin-x64` uses provider-docker. Other targets use default provider `lando` unless setup already selected the supported Docker fallback after default setup failed.
- [ ] Compile-only evidence fails the story.
- [ ] Tests pass; typecheck passes; lint passes

**Failure path:** Skipped targets, running before US-598, compile smoke, or linux-only proof.

**Verification:** Per-target live evidence of init, start, info, README verify, and destroy on all six compile targets.
