# PRD: ALPHA3-07 — Recipes (full breadth)

## Introduction

Alpha 1 shipped `recipe.yml` parsing, built-in prompt types, the `cwd` source, 6–8 canonical recipes, programmatic `landofile.ts`, and `postInit: { bun: { verb: install } }`. Alpha 3 finishes the recipe surface: remote sources (`git`, `tarball`, `npm`, `registry`), dynamic `choicesFrom:`, the `runs:` allowlist + `ctx.run`, the `fetchAllowlist:` + `ctx.fetch`, programmatic `recipe.ts`, and the remaining `postInit:` `bun:` verbs (`script`, `add`, `create`, `run`, `x`).

Depends on: **Alpha 1 PRD-04** (recipe parser + cwd source) — listed as Alpha 1 dep, not a Alpha 3 sub-PRD.

## Source References

- [`spec/08-cli-and-tooling.md`](../08-cli-and-tooling.md) §8.8 recipes.
- [`spec/07-landofile-and-config.md`](../07-landofile-and-config.md) Landofile rendering.
- [`spec/12-caches-and-persistence.md`](../12-caches-and-persistence.md) remote-recipe cache scope.
- [`spec/14-appendices.md`](../14-appendices.md) prompt-type appendices.

## Goals

- Make every documented recipe source available without internal patches.
- Let recipes call back into Lando (`ctx.run`) and the network (`ctx.fetch`) safely via allowlists.
- Support programmatic recipes (`recipe.ts`) in addition to declarative `recipe.yml`.
- Cover every `postInit:` `bun:` verb so recipes can express their full toolchain bootstrap.

## User Stories

### US-129: `git` recipe source

**Description:** As a user, I can run `lando init --source=git --url=…` and Lando clones the repo, locates `recipe.yml`, and proceeds with prompts.

**Acceptance Criteria:**
- [ ] `git` source resolver clones to `<userDataRoot>/recipe-cache/git/<sha>/`; SHA-pinned per-Landofile lock.
- [ ] Subpath (`--path=<dir>`) resolves the recipe inside a monorepo.
- [ ] Failure modes (auth, missing recipe.yml, dirty subpath) produce tagged remediation.
- [ ] Tests pass; typecheck passes; lint passes.

### US-130: `tarball` recipe source

**Description:** As a user, I can run `lando init --source=tarball --url=…` and Lando downloads, verifies, and extracts the tarball before resolving `recipe.yml`.

**Acceptance Criteria:**
- [ ] `tarball` source downloads to `<userDataRoot>/recipe-cache/tarball/<sha256>/`.
- [ ] SHA-256 verification required when `--checksum=<hash>` is passed; warn-only otherwise (with a per-init prompt unless `--yes`).
- [ ] Tests cover successful extract, checksum mismatch, and missing `recipe.yml` at top-level / subpath.
- [ ] Tests pass; typecheck passes; lint passes.

### US-131: `npm` recipe source

**Description:** As a user, I can run `lando init --source=npm --package=@lando/recipe-…` and Lando fetches the npm tarball, extracts it, and proceeds.

**Acceptance Criteria:**
- [ ] Resolves npm package metadata via the registry, downloads the published tarball, and reuses the `tarball` extractor.
- [ ] Honors `@version` suffix; defaults to latest stable.
- [ ] Tests pass; typecheck passes; lint passes.

### US-132: `registry` recipe source

**Description:** As a user, I can run `lando init --source=registry --id=drupal-10` and Lando resolves the recipe id through the registry surface (e.g. `https://registry.lando.dev/recipes/`).

**Acceptance Criteria:**
- [ ] `registry` source resolver hits the configured registry URL (default `https://registry.lando.dev/recipes/`) and follows the resolution result to a `git`/`tarball` underlying source.
- [ ] Registry response schema published in `@lando/sdk`.
- [ ] Tests use a fake registry; live integration test gated by env var.
- [ ] Tests pass; typecheck passes; lint passes.

### US-133: dynamic `choicesFrom:` for prompts

**Description:** As a recipe author, I can declare a `select` prompt whose choices come from running a canonical Lando command (e.g. `lando services:list --type=php`).

**Acceptance Criteria:**
- [ ] `choicesFrom: { command: "<id>", args: […], parse: "json" | "lines" }` schema published in `@lando/sdk`.
- [ ] Command runs in a sandboxed bootstrap that does not require an app; output parsed per `parse:`.
- [ ] Failure (command exit ≠ 0 or unparseable output) falls back to a remediation prompt asking the user for manual choice.
- [ ] Tests pass; typecheck passes; lint passes.

### US-134: `runs:` allowlist + `ctx.run`

**Description:** As a recipe author, I can declare a `runs:` allowlist (command ids the recipe may invoke during `postInit:`) and call `ctx.run('<id>', args)` from declarative recipes or `recipe.ts`.

**Acceptance Criteria:**
- [ ] `runs:` allowlist parsed from `recipe.yml` / `recipe.ts`; runtime check rejects any `ctx.run('…')` not in the allowlist with a tagged error.
- [ ] Allowlisted commands run under the same bootstrap as the recipe's own command.
- [ ] Tests cover allowlisted + non-allowlisted call paths.
- [ ] Tests pass; typecheck passes; lint passes.

### US-135: `fetchAllowlist:` + `ctx.fetch`

**Description:** As a recipe author, I can declare a `fetchAllowlist:` (URL globs) and call `ctx.fetch(url)` from a recipe — calls outside the allowlist fail with a tagged remediation.

**Acceptance Criteria:**
- [ ] `fetchAllowlist:` parsed; URL match is glob-based (e.g. `https://api.example.com/**`).
- [ ] `ctx.fetch` is a thin wrapper over the platform `fetch`; redirect targets must also match the allowlist.
- [ ] Tests cover allowed, denied, and redirect-out-of-allowlist cases.
- [ ] Tests pass; typecheck passes; lint passes.

### US-136: programmatic `recipe.ts`

**Description:** As a recipe author, I can write a recipe as a TypeScript module exporting a default `Recipe` object instead of `recipe.yml`.

**Acceptance Criteria:**
- [ ] `Recipe` type exported from `@lando/sdk`; a recipe TypeScript file is compiled and loaded under the recipe bootstrap.
- [ ] Compilation uses Bun's native TS support; no `tsc` step required at recipe-load time.
- [ ] Tests cover a fixture recipe.ts with prompts, `runs:`, `fetchAllowlist:`, and `postInit:` declarations.
- [ ] Tests pass; typecheck passes; lint passes.

### US-137: remaining `postInit:` `bun:` verbs — `script`, `add`, `create`, `run`

**Description:** As a recipe author, I can declare `postInit:` steps that run `bun script`, `bun add`, `bun create`, and `bun run` (in addition to Alpha 1's `bun install`).

**Acceptance Criteria:**
- [ ] `script` runs an arbitrary bun script from the recipe's `scripts/` directory.
- [ ] `add` installs additional packages with optional `--dev` semantics.
- [ ] `create` runs `bun create <template>`; the template arg supports recipe-substituted variables.
- [ ] `run` runs an entry from `package.json#scripts`.
- [ ] Tests pass; typecheck passes; lint passes.

### US-138: `postInit:` `bun: { verb: x }` (arbitrary `bunx` invocation)

**Description:** As a recipe author, I can declare `postInit: { bun: { verb: x, args: ["...", "..."] } }` to run a one-off `bunx` command.

**Acceptance Criteria:**
- [ ] `x` verb runs the equivalent of `bunx <args>`; output streams into the renderer's task tree.
- [ ] Allowlist enforcement: `x` is gated by `runs:` if a recipe declares one; recipes without `runs:` allow `x` by default (recipes opt into stricter sandboxing).
- [ ] Tests pass; typecheck passes; lint passes.

## Functional Requirements

- FR-1: Recipe source resolvers cover `cwd` (Alpha 1), `git`, `tarball`, `npm`, and `registry`; each source resolves to a local directory containing `recipe.yml` or `recipe.ts`.
- FR-2: Dynamic `choicesFrom:` is gated by the same `runs:` allowlist that protects `ctx.run`.
- FR-3: `ctx.fetch` enforces the `fetchAllowlist:` glob match including redirects.
- FR-4: `recipe.ts` is a peer to `recipe.yml`; the two forms are mutually exclusive within a recipe directory (a recipe ships one or the other, never both), matching the §8.8.14 contract and the `.lando.ts`/`.lando.yml` precedent (§7.1.1). A directory carrying both is rejected at resolution.
- FR-5: Every `postInit:` `bun:` verb (`install`, `script`, `add`, `create`, `run`, `x`) is supported and runs through the renderer task tree.

## Non-Goals

- Plugin-contributed recipe sources beyond the five blessed ones (post-GA).
- Recipe-level signature verification (Beta 1; covered by the broader supply-chain work).
- A registry implementation — Alpha 3 only ships the client; the registry surface itself is a separate Lando Alliance effort.
- Recipe-time write to the global app (recipes target a single per-app scaffold; global app touches go through `meta:global:*`).
- Recipe-driven migrations from `lando v3` projects (Phase 6+).

## Technical Considerations

- Remote sources should reuse the §12 cache encoding rules; cache invalidation is by source SHA / hash.
- `ctx.run` must produce a deterministic exec that does not require the recipe to know about the current Effect Runtime — implementation re-enters the Lando CLI in a child Effect scope.
- `recipe.ts` compilation uses Bun's TS loader; ensure the recipe sandbox has access only to the `Recipe` schema, `ctx`, and Node builtins explicitly allowed by the recipe sandbox.
- `bunx`-style `x` verb is a thin wrapper; do not duplicate the bun resolver.

## Success Metrics

- Every Alpha 1 canonical recipe (Drupal / WordPress / Laravel / Node / Django / Rails) still works in Alpha 3; at least two additional recipes (e.g. Astro, Next.js stub) are sourced via `npm` or `registry`.
- `lando init --source=…` works end-to-end against a fake registry in CI.
- `ctx.fetch` allowlist denials produce remediation that names the denied URL and the configured globs.

## Guide Coverage

Per [PRD-12 US-198](./prd-alpha-3-12-executable-guides.md) (`## Guide Coverage` convention) and [US-199](./prd-alpha-3-12-executable-guides.md) (drift gate), this PRD owns the executable guides listed below. Each guide exercises the happy path of its mapped user story; failure modes remain covered by unit and integration tests in the named packages. PRs that touch the listed surface paths MUST also touch the corresponding guide(s), or use the `Guide-Coverage-Skip:` escape hatch.

**Guides owned by this PRD:**

| User Story | Feature | Guide Path | Acceptance |
|---|---|---|---|
| US-129 | remote recipe sources (git, tarball, npm, registry) | `docs/guides/recipes/remote-sources.mdx` | Required at story acceptance |
| US-134 | `runs:` allowlist + ctx.run | `docs/guides/recipes/authoring-runs-allowlist.mdx` | Required at story acceptance |
| US-135 | `fetchAllowlist:` + ctx.fetch | `docs/guides/recipes/authoring-fetch-allowlist.mdx` | Required at story acceptance |
| US-136 | programmatic recipe.ts | `docs/guides/recipes/programmatic-recipe.mdx` | Required at story acceptance |

**CLI / source surface paths covered (drift gate input):**

- `core/src/recipes/**`
- `sdk/src/recipes/**`
- `plugins/recipe-*/src/**`

## Open Questions

- ~~Should `fetchAllowlist:` default to `[]` (deny by default) or to `*` (allow by default with a warning)?~~ **Resolved:** default `*` allow-by-default; `meta:doctor` / `meta:setup` emits a warning listing unverified fetch hosts the recipe touches. Recipes can still pin `fetchAllowlist:` for tighter scope (security axis: permissive with warnings).
- ~~Should `runs:` default to `[]` or to a small built-in allowlist?~~ **Resolved:** default is a small built-in allowlist (`git`, `composer`, `npm`, `bun`, `yarn`, `pnpm`, `pip`, `bundle`, `make`); anything outside emits a warning at recipe-load time and proceeds. Recipes can still declare an explicit `runs:` to tighten scope (security axis: permissive with warnings).
- Should the npm source verify package signatures (npm 11+ provenance)? Default: warn-only in Alpha 3; mandatory at Beta 1 alongside the broader supply-chain work.
