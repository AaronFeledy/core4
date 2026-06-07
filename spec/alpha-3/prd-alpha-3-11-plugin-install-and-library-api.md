# PRD: ALPHA3-11 — Plugin install & library API

## Introduction

Alpha 3 lands two related surfaces. **Plugin install** moves beyond bundled-only: npm plugin install becomes real, postinstall trust gating gets a mechanism (UX finalized at Beta 1), and the three discovery sources (system / user / app) all work. **Library API** becomes usable: `EmbeddingPluginPolicy` is fully wired, every entry point in `package.json#exports` is published (`/schema`, `/errors`, `/events`, `/services`, `/testing`, `/cli`, `/oclif`), the import-boundary test enforces no OCLIF in the default entry, and library-mode defaults (silent logger, json renderer, no auto-discovery, no telemetry) are in place.

Depends on: **ALPHA3-09** (library API needs the renderer surface to be stable).

## Source References

- [`spec/09-embedding.md`](../09-embedding.md) §16 library API surface; `EmbeddingPluginPolicy`.
- [`spec/10-plugins.md`](../10-plugins.md) §9.6 plugin install; §9.7 plugin discovery sources.
- [`spec/13-testing-and-distribution.md`](../13-testing-and-distribution.md) library-API + import-boundary test layers.

## Goals

- Make `meta:plugin:add <name>` work end-to-end against npm.
- Enforce postinstall trust gating as a mechanism (the exact UX is Beta 1).
- Resolve plugin discovery from system / user / app paths in declared precedence.
- Ship `@lando/core/*` entry points; make library embedders first-class consumers.
- Lock the import boundary so library entry points never pull OCLIF or CLI code.

## User Stories

### US-165: `meta:plugin:add` against npm (full source)

**Description:** As a user, I can run `lando meta:plugin:add @lando/plugin-foo` and have it installed under the per-user plugin root with manifest validation.

**Acceptance Criteria:**
- [ ] Resolves npm package metadata, downloads tarball, extracts under `<userDataRoot>/plugins/<name>/<version>/`.
- [ ] Manifest validated against `@lando/sdk` plugin manifest schema (`name`, `lando.version`, `requires`).
- [ ] Re-runs are idempotent; version pinning supported (`@1.2.3` suffix).
- [ ] Tests pass; typecheck passes; lint passes.

### US-166: `meta:plugin:remove`

**Description:** As a user, I can run `lando meta:plugin:remove <name>` and the plugin is unloaded and removed from disk.

**Acceptance Criteria:**
- [ ] Plugin directory deleted; per-user plugin registry updated atomically.
- [ ] If the plugin is referenced by an active Landofile, command refuses with a remediation pointing at the referencing app.
- [ ] Tests pass; typecheck passes; lint passes.

### US-167: postinstall trust gating mechanism

**Description:** As the loader, plugins with declared postinstall scripts are gated behind a trust check; untrusted plugins are installed but inert until trust is granted.

**Acceptance Criteria:**
- [ ] `PluginTrustStore` Effect Service tag in `@lando/sdk`; default Live Layer reads `<userConfRoot>/plugin-trust.yml`.
- [ ] `meta:plugin:add` honors trust state; untrusted plugins with postinstalls skip the postinstall and log a remediation pointing at `meta:plugin:trust <name>` (UX finalized at Beta 1).
- [ ] `meta:plugin:trust <name>` writes the trust entry; `meta:plugin:trust-authoring-root <abs>` allows blanket trust for a developer authoring root.
- [ ] Tests pass; typecheck passes; lint passes.

### US-168: system / user / app plugin discovery sources

**Description:** As the loader, plugins are discovered from system (bundled), user (`<userDataRoot>/plugins/`), and app (`<appRoot>/.lando/plugins/`) sources, in declared precedence.

**Acceptance Criteria:**
- [ ] Discovery returns a merged plugin list; per-source precedence is `app > user > system`.
- [ ] Conflict on the same plugin id across sources resolves to the highest-precedence entry; warning emitted.
- [ ] Tests cover all three sources individually + combined.
- [ ] Tests pass; typecheck passes; lint passes.

### US-169: plugin command-index cache

**Description:** As the CLI, repeated `lando --help` after a plugin install hits the §12 plugin-command-index cache and does not re-scan plugin directories.

**Acceptance Criteria:**
- [ ] Cache encodes plugin-list SHA + per-plugin command id list.
- [ ] Invalidation on `meta:plugin:add` / `meta:plugin:remove` / `meta:plugin:trust`.
- [ ] Tests cover cold scan, warm hit, and post-add invalidation.
- [ ] Tests pass; typecheck passes; lint passes.

### US-170: `@lando/core/*` entry points published

**Description:** As a library embedder, I can import from `@lando/core/schema`, `/errors`, `/events`, `/services`, `/testing`, `/cli`, and `/oclif` and get the expected surface.

**Acceptance Criteria:**
- [ ] `package.json#exports` lists every entry point with TS types + ESM.
- [ ] Each entry is documented in `core/README.md` or a dedicated `docs/embedding.md` per §16.
- [ ] Tests in `core/test/library/` cover at least one symbol from each entry.
- [ ] Tests pass; typecheck passes; lint passes.

### US-171: `EmbeddingPluginPolicy` fully wired

**Description:** As an embedder, I can pass an `EmbeddingPluginPolicy` to `makeLandoRuntime` and control plugin discovery / loading per §16.

**Acceptance Criteria:**
- [ ] `EmbeddingPluginPolicy` schema published in `@lando/sdk`; modes per §16.4 (`none`, `bundled-only`, `explicit`, `discovery`).
- [ ] `makeLandoRuntime({ plugins: { policy: … } })` honors the policy; `none` mode loads no plugins at all.
- [ ] Library mode defaults: silent logger, json renderer, `policy: "explicit"`, no telemetry.
- [ ] Tests pass; typecheck passes; lint passes.

### US-172: import-boundary test enforces OCLIF-free default entry

**Description:** As a maintainer, the default `@lando/core` entry imports no OCLIF code path — OCLIF lives only under `@lando/core/oclif`.

**Acceptance Criteria:**
- [ ] Import-boundary test in `core/test/library/` resolves every symbol from `@lando/core` and asserts no OCLIF module is loaded transitively.
- [ ] Test also covers the four critical entry points (`/cli`, `/oclif`, `/testing`, default) and asserts their bundled module graph at compile-time.
- [ ] Failure messages name the offending import chain.
- [ ] Tests pass; typecheck passes; lint passes.

### US-173: library-mode defaults

**Description:** As an embedder, `makeLandoRuntime` in library mode uses silent logger, json renderer, no plugin auto-discovery, and no telemetry — unless I opt in.

**Acceptance Criteria:**
- [ ] Defaults applied at runtime construction; embedders can override per-field.
- [ ] Default-renderer choice in library mode does not pull TUI code paths (verified by the import-boundary test).
- [ ] Tests cover the default-set and the explicit-override path.
- [ ] Tests pass; typecheck passes; lint passes.

### US-174: plugin SDK contract test publishable

**Description:** As a plugin author, `@lando/sdk/test` publishes a runnable contract suite I can wire into my plugin's test script.

**Acceptance Criteria:**
- [ ] `@lando/sdk/test` exports the plugin-SDK contract suite (covering manifest, plugin layer, contribution surfaces, error contract).
- [ ] At least one external example plugin in `plugins/` (or a fixture under `core/test/library/`) imports + runs the suite green.
- [ ] Tests pass; typecheck passes; lint passes.

## Functional Requirements

- FR-1: `meta:plugin:add` against npm is full; `meta:plugin:remove` is full; system/user/app discovery works in declared precedence.
- FR-2: Postinstall trust is mechanism-only in Alpha 3 — the trust UX final shape is Beta 1.
- FR-3: `@lando/core/*` exports published per `package.json#exports`; library tests cover each entry.
- FR-4: `EmbeddingPluginPolicy` honored at `makeLandoRuntime`; library-mode defaults are silent logger, json renderer, no auto-discovery, no telemetry.
- FR-5: Import-boundary test asserts the default entry contains no OCLIF code; lint gate fails CI on violation.

## Non-Goals

- Plugin authoring toolkit (`meta:plugin:new`, `test`, `build`, `link`, `unlink`, `publish`) — Beta 1.
- Final plugin trust UX (interactive prompts, audit log, revoke flow) — Beta 1.
- Plugin discovery / search (`meta:plugin:search`) — Phase 7.
- Plugin signing / verification — Beta 1 (covered by broader supply-chain work).
- Custom `PluginSource` examples (S3, OCI artifact) — Phase 7.

## Technical Considerations

- The plugin-command-index cache encodes `(pluginList, perPluginManifestHash)`; invalidation must be cheap.
- Trust storage at `<userConfRoot>/plugin-trust.yml` is human-editable; schema published so users can hand-edit safely.
- Import-boundary test runs at build time, not just unit-test time — the failure should block any PR that adds an OCLIF import to the default entry.
- Library-mode `policy: "explicit"` means embedders pass an explicit plugin list; `discovery` activates system/user/app scan only if the embedder asked for it.

## Success Metrics

- Installing a community plugin via `meta:plugin:add @some/plugin` works on every Alpha 3 platform with one command.
- Library API embedders can boot `makeLandoRuntime` with the default policy and execute a CLI command without pulling OCLIF.
- Plugin command index cache hit rate >99% in interactive workflows.

## Guide Coverage

Per [PRD-12 US-198](./prd-alpha-3-12-executable-guides.md) (`## Guide Coverage` convention) and [US-199](./prd-alpha-3-12-executable-guides.md) (drift gate), this PRD owns the executable guides listed below. Each guide exercises the happy path of its mapped user story; failure modes remain covered by unit and integration tests in the named packages. PRs that touch the listed surface paths MUST also touch the corresponding guide(s), or use the `Guide-Coverage-Skip:` escape hatch.

**Guides owned by this PRD:**

| User Story | Feature | Guide Path | Acceptance |
|---|---|---|---|
| US-165 | `meta:plugin:add` against npm | `docs/guides/plugins/install-from-npm.mdx` | Required at story acceptance |
| US-167 | postinstall trust gating (incl. wildcards) | `docs/guides/plugins/trust-and-wildcards.mdx` | Required at story acceptance |
| US-168 | system / user / app plugin discovery scopes | `docs/guides/plugins/discovery-scopes.mdx` | Required at story acceptance |
| US-173 | library-mode defaults | `docs/guides/library/embedding-defaults.mdx` | Required at story acceptance |

**CLI / source surface paths covered (drift gate input):**

- `core/src/plugins/manifest.ts`
- `core/src/plugins/registry.ts`
- `core/src/plugins/source/**`
- `core/src/cli/commands/meta/plugin/**`
- `sdk/src/plugin-api/**`
- `core/src/library/**`

## Open Questions

- Should `meta:plugin:add` default to user-scope or app-scope when run inside an app directory? Default: user-scope; `--app` opts into app-scope.
- ~~Should the trust file allow wildcards (`@lando/*`)?~~ **Resolved:** allow npm-scope-style wildcards (`@lando/*`, `@my-org/*`). The trust file is the user's explicit-consent surface; wildcards make it ergonomic. Exact-name entries continue to work (security axis: permissive with warnings).
- Should library-mode embedders be able to override the import-boundary policy? Default: no — boundary is enforced by the runtime, not user-configurable.
