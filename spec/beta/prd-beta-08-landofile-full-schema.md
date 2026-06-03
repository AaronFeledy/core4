# PRD: BETA-08 — Landofile (full schema)

## Introduction

Alpha shipped a minimal Compose subset plus `tooling:` parsing. Beta finishes the Landofile schema: `includes:` + `.lando.lock.yml`, the configuration-expressions language (§7.3.1), the bundled template engines, env overrides (§7.6), `secrets:` via `SecretStore`, the config-translation framework (§7.4.1), and the `app:includes:*` + `app:config:translate` commands.

Depends on: **BETA-04** (subsystems supply some of the env overlay sources).

## Source References

- [`spec/07-landofile-and-config.md`](../07-landofile-and-config.md) §7 entire part — includes, expressions, templates, env overrides, secrets, translation.
- [`spec/08-cli-and-tooling.md`](../08-cli-and-tooling.md) `app:includes:update`, `app:includes:verify`, `app:config:translate`.
- [`spec/12-caches-and-persistence.md`](../12-caches-and-persistence.md) lockfile + cache scope rules.

## Goals

- Finish the Landofile schema so users can model real projects without external config layers.
- Make `includes:` deterministic and verifiable via `.lando.lock.yml`.
- Ship the expression and template surfaces required by recipes and per-app config.
- Provide a stable `SecretStore` contract with an env-backed default.

## User Stories

### US-139: `includes:` + `.lando.lock.yml`

**Description:** As a user, my Landofile can `includes:` other YAML/Landofile fragments and the resolved tree is pinned by `.lando.lock.yml`.

**Acceptance Criteria:**
- [ ] `includes:` resolver supports relative paths, `git@…`/`https://…` URLs (reuse PRD-07 source surface where it makes sense), and npm packages.
- [ ] `.lando.lock.yml` records the resolved SHA + hash of every included fragment.
- [ ] Lock mismatch at load time produces `LandofileLockMismatchError` with remediation pointing at `lando app:includes:update`.
- [ ] Tests pass; typecheck passes; lint passes.

### US-140: `app:includes:update`

**Description:** As a user, I can run `lando app:includes:update` to refresh every included fragment to its latest source-resolved version and rewrite `.lando.lock.yml`.

**Acceptance Criteria:**
- [ ] Command re-resolves every `includes:` entry, recomputes SHAs, and writes the lockfile atomically.
- [ ] `--check` mode reports drift without writing.
- [ ] Compiled binary parity verified (or unified dispatch from PRD-09 covers it).
- [ ] Tests pass; typecheck passes; lint passes.

### US-141: `app:includes:verify`

**Description:** As CI, I can run `lando app:includes:verify` to confirm the lockfile matches the resolved tree without mutating anything.

**Acceptance Criteria:**
- [ ] Read-only command; exits non-zero on lock mismatch with the same `LandofileLockMismatchError` schema as US-139.
- [ ] JSON renderer output covers the per-fragment status.
- [ ] Tests pass; typecheck passes; lint passes.

### US-142: configuration expressions language (§7.3.1) — parser

**Description:** As a user, I can use `${{ … }}` expressions in Landofile values with pipes, filters, and the full operator set documented in §7.3.1.

**Acceptance Criteria:**
- [ ] Expression parser implemented; the full `pipe | filter | filter` syntax + comparators + ternary supported per §7.3.1.
- [ ] Parse errors emit `LandofileExpressionParseError` with file + line + column.
- [ ] Tests cover the documented operator surface (one assert per documented filter).
- [ ] Tests pass; typecheck passes; lint passes.

### US-143: expression evaluator + sandbox

**Description:** As a user, evaluating expressions only sees a sandboxed context (config values, env, service metadata, secrets) — no arbitrary code or filesystem reads.

**Acceptance Criteria:**
- [ ] Evaluator runs against a documented `ExpressionContext` published in `@lando/sdk`.
- [ ] No host FS / network / process access from inside an expression; attempt → `LandofileExpressionForbiddenError`.
- [ ] Tests cover happy path (config + env + secret) and forbidden access.
- [ ] Tests pass; typecheck passes; lint passes.

### US-144: bundled template engines — Handlebars + Mustache

**Description:** As a recipe / Landofile author, I can declare `template: handlebars` or `template: mustache` and have the Landofile rendered through the bundled engine before parsing.

**Acceptance Criteria:**
- [ ] `@lando/template-handlebars` and `@lando/template-mustache` shipped as bundled plugins; contributed to `bundled.ts` codegen.
- [ ] Template selection happens before YAML parse; template errors surface with template-source line numbers (not post-render line numbers).
- [ ] Default template engine is none (raw YAML); opt-in per Landofile.
- [ ] Tests pass; typecheck passes; lint passes.

### US-145: env overrides (§7.6)

**Description:** As a user, I can override any Landofile value via `LANDO_*` env vars with the precedence chain documented in §7.6.

**Acceptance Criteria:**
- [ ] Generic `LANDO_CONFIG__path__to__value=…` overlay implemented (uses `__` as delimiter); replaces MVP's hard-coded four-var overlay.
- [ ] Precedence: command flag > env > `.lando.local.yml` > main Landofile > defaults.
- [ ] Tests cover every level of the precedence chain.
- [ ] Tests pass; typecheck passes; lint passes.

### US-146: `SecretStore` contract + env-backed default

**Description:** As a user, I can reference `${{ secrets.MY_TOKEN }}` in Landofile and have it resolve via a pluggable `SecretStore`; the default reads from environment variables.

**Acceptance Criteria:**
- [ ] `SecretStore` Effect Service tag + contract in `@lando/sdk` (`get`, `has`, `list`).
- [ ] Default Live Layer reads from `process.env`; missing secret → `SecretNotFoundError` with the secret id.
- [ ] Secrets are redacted in renderer / log output by default; secret values never appear in `lando info` JSON.
- [ ] Tests pass; typecheck passes; lint passes.

### US-147: config-translation framework (§7.4.1)

**Description:** As a plugin author, I can register a `ConfigTranslator` that maps an external config format (e.g. a legacy `lando v3` `.lando.yml` style key) into the canonical v4 schema.

**Acceptance Criteria:**
- [ ] `ConfigTranslator` Effect Service tag + contract published in `@lando/sdk`.
- [ ] Translator resolution is deterministic; multiple translators run in declared order; conflicts produce `ConfigTranslatorConflictError`.
- [ ] No translators are shipped in Beta core (the framework is the deliverable; concrete translators come post-GA).
- [ ] Tests pass; typecheck passes; lint passes.

### US-148: `app:config:translate` command

**Description:** As a user with a non-canonical config file (e.g. v3 Landofile), I can run `lando app:config:translate` to produce a v4 canonical file via registered translators.

**Acceptance Criteria:**
- [ ] Command reads the input file, runs through registered translators, writes the canonical YAML next to it as `.lando.yml.canonical`.
- [ ] `--write` overwrites the input (with a `.bak` backup).
- [ ] With zero translators registered, the command exits with a remediation pointing at the plugin install path.
- [ ] Tests pass; typecheck passes; lint passes.

### US-149: Landofile schema gate

**Description:** As a maintainer, the full Landofile schema (`includes:`, `expressions`, `template:`, `secrets:`, `tooling:`, `services:`, …) round-trips through the §13.2 schema snapshot gate.

**Acceptance Criteria:**
- [ ] JSON Schema exports for every new key; snapshot test asserts no fixture drift on `bun run codegen`.
- [ ] `sdk/API_COMPATIBILITY.md` updated for Beta-added keys.
- [ ] Tests pass; typecheck passes; lint passes.

### US-195: `app:config:lint` command

> Numeric note: US-195 lives outside this PRD's normal 139–149 range because it was added during the paradigm review that resolved §Open Questions item #21. Story IDs elsewhere were preserved by appending rather than renumbering.

**Description:** As an IDE / editor integration (or a developer who wants fast schema feedback without paying for the full `doctor --app` sweep), I can run `lando app:config:lint` and get a canonical-schema-only validation of the Landofile in the current app directory.

**Acceptance Criteria:**
- [ ] `lando app:config:lint` validates the Landofile against the canonical JSON Schema (no translators, no doctor checks, no provider probes).
- [ ] Exit code is `0` on clean, non-zero on schema violation; renderer emits structured violations (path, message, suggested fix) so editors can surface inline diagnostics.
- [ ] `--format=json` emits a stable JSON shape suitable for LSP-style consumers; `--format=text` (default) is human-readable.
- [ ] `lando doctor --app` invokes the same lint pass internally (single source of truth — no forked logic between standalone and doctor paths).
- [ ] Command participates in the §13.1 layer coverage rules and the §13.4 renderer lint gate.
- [ ] Tests pass; typecheck passes; lint passes.

## Functional Requirements

- FR-1: `includes:` is resolved via the same source surface as PRD-07 (`cwd`, `git`, `tarball`, `npm`) and pinned by `.lando.lock.yml`.
- FR-2: Configuration expressions use the §7.3.1 syntax; evaluation runs in a sandboxed `ExpressionContext`.
- FR-3: Handlebars and Mustache template engines ship as bundled plugins.
- FR-4: Env overrides follow `flag > env > .lando.local.yml > Landofile > defaults`.
- FR-5: `SecretStore` is pluggable; env-backed default ships in core.
- FR-6: `ConfigTranslator` framework ships in `@lando/sdk`; concrete translators are post-GA.
- FR-7: Every Beta-added Landofile key has JSON Schema, runs through the §13.2 snapshot gate, and is documented in `sdk/API_COMPATIBILITY.md`.
- FR-8: `app:config:lint` and `doctor --app` share a single canonical-schema validation implementation; neither path forks the lint logic. The `--format=json` output shape is part of the §13.2 schema snapshot gate (editor integrations depend on its stability).

## Non-Goals

- Shipping a v3-to-v4 config translator (Phase 6+).
- Pluggable template engines beyond Handlebars + Mustache (post-GA).
- Expression-language extensibility (custom filters / functions) — Beta is the closed set in §7.3.1; extension hooks are post-GA.
- Cloud-secret backends (1Password CLI, `op`, `age`, AWS Secrets Manager) — Phase 7+.
- A migration path for un-locked Landofiles (lockfile is opt-in: present `.lando.lock.yml` enables verification, absent skips it).

## Technical Considerations

- Expression evaluation order matters when combined with `includes:` and templates; the canonical order is **template render → YAML parse → includes resolve → expression evaluate**. This must be tested explicitly.
- Lockfile atomic-write follows the §12 write-temp-then-rename pattern.
- Secret redaction must be consistent across renderer modes (`lando`, `json`, `plain`, `verbose` — PRD-09); a single redactor lives in `@lando/sdk`.
- Generic env overlay (`LANDO_CONFIG__a__b__c`) replaces MVP's hard-coded four-var overlay — see MVP progress.txt:1130-1134.

## Success Metrics

- A real-world Drupal project's `.lando.yml` from v3 can be rendered as v4 with at most one community translator and zero hand edits.
- Expression-language usage in canonical recipes (`${{ env.NODE_VERSION }}`-style) compiles deterministically and is covered by snapshot tests.
- `.lando.lock.yml` round-trip is reproducible byte-for-byte across platforms.

## Guide Coverage

Per [PRD-12 US-198](./prd-beta-12-executable-guides-beta.md) (`## Guide Coverage` convention) and [US-199](./prd-beta-12-executable-guides-beta.md) (drift gate), this PRD owns the executable guides listed below. Each guide exercises the happy path of its mapped user story; failure modes remain covered by unit and integration tests in the named packages. PRs that touch the listed surface paths MUST also touch the corresponding guide(s), or use the `Guide-Coverage-Skip:` escape hatch.

**Guides owned by this PRD:**

| User Story | Feature | Guide Path | Acceptance |
|---|---|---|---|
| US-139 | `includes:` + .lando.lock.yml | `docs/guides/landofile/includes-and-lockfile.mdx` | Required at story acceptance |
| US-142 | configuration expressions (parser + evaluator) | `docs/guides/landofile/expressions.mdx` | Required at story acceptance |
| US-144 | bundled template engines — Handlebars + Mustache | `docs/guides/landofile/template-engines.mdx` | Required at story acceptance |
| US-145 | env overrides | `docs/guides/landofile/env-overrides.mdx` | Required at story acceptance |
| US-148 | `app:config:translate` command | `docs/guides/landofile/config-translate.mdx` | Required at story acceptance |
| US-195 | `app:config:lint` command (IDE / standalone) | `docs/guides/landofile/config-lint.mdx` | Required at story acceptance |

**CLI / source surface paths covered (drift gate input):**

- `core/src/landofile/**`
- `core/src/plugins/bundled.ts`
- `plugins/template-*/**`
- `sdk/src/template/**`
- `core/src/cli/commands/app/config/**`
- `core/src/cli/commands/app/includes/**`
- `sdk/src/landofile/**`
- `sdk/src/expressions/**`

## Open Questions

- Should expression evaluation be eager (at Landofile load) or lazy (at use site)? Default: eager — predictable error surface; revisit if a recipe needs late binding.
- Should the lockfile be committed by recipe scaffolding? Default: yes — recipes generate it as part of scaffold output.
- ~~Should there be a `lando app:config:lint` command that validates only the canonical schema (no translators)?~~ **Resolved:** ship the standalone `lando app:config:lint` in Beta **and** invoke it as part of `lando doctor --app`. IDEs and editor integrations can call the standalone command for fast, focused schema feedback without paying for the full doctor sweep.
