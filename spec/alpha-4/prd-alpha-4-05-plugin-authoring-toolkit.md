# PRD: ALPHA4-05 — Plugin authoring toolkit

## Introduction

Alpha 4 completes the core-owned plugin authoring toolkit from §9.10. The six `meta:plugin:*` commands move from stubs to working commands that scaffold, test, build, link, unlink, and publish plugins without giving plugins control over the authoring namespace.

Every child process in this PRD routes through `BunSelfRunner`, every command has source-mode and compiled `$bunfs` parity, and global mutation is limited to `<userDataRoot>/plugins/` plus documented plugin authoring state.

Depends on: **ALPHA4-02** (plugin trust and open-decision closure), because link, publish, and postinstall behavior must respect the finalized trust model.

## Source References

- [`spec/10-plugins.md`](../10-plugins.md) §9.10 plugin authoring toolkit.
- [`spec/10-plugins.md`](../10-plugins.md) §9.4 plugin manifest schema and §9.6 install/update flow.
- [`spec/08-cli-and-tooling.md`](../08-cli-and-tooling.md) §8.4.1 dual-dispatch parity.
- [`spec/03-architecture.md`](../03-architecture.md) §3.4 `BunSelfRunner` service and §11 lifecycle events.
- [`spec/12-caches-and-persistence.md`](../12-caches-and-persistence.md) §12 plugin and command cache invalidation.

## Goals

- Replace all six plugin-authoring stubs with working core-owned commands.
- Provide buildable, testable, linkable plugin scaffolds from bundled templates.
- Route test, build, publish, and script-like work through `BunSelfRunner` with lifecycle events.
- Keep linked plugin state deterministic and contained under `<userDataRoot>/plugins/`.
- Preserve compiled `$bunfs` parity for every new authoring command.

## User Stories

### US-230: `meta:plugin:new` scaffold + templates + prompts/answers

**Description:** As a plugin author, I can create a new plugin from a bundled template and get a project that is immediately buildable, testable, and linkable.

**Acceptance Criteria:**
- [ ] `meta:plugin:new <name> [<destination>]` scaffolds from codegen-embedded templates: `service-type`, `provider`, `tooling-engine`, `template-engine`, `route-filter`, `config-translator`, `recipe`, and `bare`.
- [ ] Interactive mode prompts for `name`, `template`, `cspace`, and `description`; `--no-interactive` requires all needed values through args, repeatable `--answer key=value`, or `--answers <file>`.
- [ ] The scaffold emits `package.json` with plugin metadata and `api: 4`, Effect-Schema config, a test fixture, strict `tsconfig.json`, and `README.md`.
- [ ] The generated plugin can run `meta:plugin:test`, `meta:plugin:build`, and `meta:plugin:link` without manual file edits.
- [ ] Tests pass.
- [ ] Typecheck passes.
- [ ] Lint passes.

### US-231: `meta:plugin:test` Bun test runner + arg forwarding + events

**Description:** As a plugin author, I can run the plugin test suite through Lando while keeping Bun arguments and lifecycle events intact.

**Acceptance Criteria:**
- [ ] `meta:plugin:test [<paths>...]` detects the current plugin root, validates its manifest, and runs `bun test` in that root through `BunSelfRunner`.
- [ ] Positional paths are passed to Bun as test targets, and arguments after `--` are forwarded unchanged.
- [ ] The command publishes `cli-meta:plugin:test-*` events plus `pre-bun-self-exec` and `post-bun-self-exec` events.
- [ ] Rendered output reports the plugin name, test command, and final result without touching raw stdio outside the renderer boundary.
- [ ] Tests pass.
- [ ] Typecheck passes.
- [ ] Lint passes.

### US-232: `meta:plugin:build` exports build + declarations + mixed-tree refusal

**Description:** As a plugin author, I can build publishable artifacts from `package.json#exports` and avoid accidentally publishing mixed source and dist trees.

**Acceptance Criteria:**
- [ ] `meta:plugin:build` validates the manifest, reads `package.json#exports`, and emits `dist/` artifacts with TypeScript declarations.
- [ ] The command refuses mixed `dist/` and source trees with a tagged error and remediation before writing publish artifacts.
- [ ] Build work routes through `BunSelfRunner` and publishes `cli-meta:plugin:build-*`, `pre-bun-self-exec`, and `post-bun-self-exec` events.
- [ ] Build outputs are deterministic enough for tests to compare expected files and package metadata.
- [ ] Tests pass.
- [ ] Typecheck passes.
- [ ] Lint passes.

### US-233: `meta:plugin:link` symlink + cache refresh + tracking

**Description:** As a plugin author, I can link a local plugin into my user plugin registry and have Lando refresh every cache that depends on plugin commands.

**Acceptance Criteria:**
- [ ] `meta:plugin:link [<path>]` defaults to `cwd`, resolves the absolute path, validates the plugin manifest, and symlinks it into `<userDataRoot>/plugins/<name>`.
- [ ] The linked registry entry tracks `source: "linked"` and `linkedPath: <abs>`.
- [ ] The command refreshes or invalidates the command index, OCLIF shim cache, plugin cache, and any compiled-dispatch metadata needed for parity.
- [ ] Linking refuses to mutate global state outside `<userDataRoot>/plugins/` and reports a tagged conflict if an existing entry cannot be safely replaced.
- [ ] Tests pass.
- [ ] Typecheck passes.
- [ ] Lint passes.

### US-234: `meta:plugin:unlink` restore/remove behavior

**Description:** As a plugin author, I can unlink a local plugin and either restore the prior registry copy or remove the linked entry cleanly.

**Acceptance Criteria:**
- [ ] `meta:plugin:unlink <name>` validates the plugin name and locates the linked registry entry under `<userDataRoot>/plugins/`.
- [ ] If the plugin lockfile recorded a prior registry copy, unlink restores that copy atomically.
- [ ] If no prior copy exists, unlink removes the linked symlink and registry metadata without touching the source authoring path.
- [ ] The command refreshes the same command and plugin caches as link, then renders the final restored or removed state.
- [ ] Tests pass.
- [ ] Typecheck passes.
- [ ] Lint passes.

### US-235: `meta:plugin:publish` rebuild/retest/validate/auth/`--dry-run`

**Description:** As a plugin publisher, I can publish a built plugin artifact with validation, optional retesting, and a dry-run package listing.

**Acceptance Criteria:**
- [ ] `meta:plugin:publish` runs from a built artifact directory, rebuilds if stale, and retests unless `--no-test` is set.
- [ ] The command validates manifest shape, `api: 4`, module containment, package contents, `tag`, and `registry` before publishing.
- [ ] Auth is read from `<userDataRoot>/plugin-auth.json`; missing auth produces a tagged remediation and never prompts in non-interactive mode.
- [ ] `--dry-run` prints package contents, planned registry, tag, and validation result, then exits 0 without network publish.
- [ ] Publish and build/test child operations route through `BunSelfRunner` and publish the relevant lifecycle events.
- [ ] Tests pass.
- [ ] Typecheck passes.
- [ ] Lint passes.

### US-236: Dual-dispatch parity + `BunSelfRunner` routing + plugin-root containment

**Description:** As a maintainer, I need all six plugin authoring commands to behave identically in source mode and compiled `$bunfs` mode while preserving process-routing and containment rules.

**Acceptance Criteria:**
- [ ] `runCompiledCli` has explicit branches for `meta:plugin:new`, `meta:plugin:test`, `meta:plugin:build`, `meta:plugin:link`, `meta:plugin:unlink`, and `meta:plugin:publish`.
- [ ] OCLIF command bodies and compiled branches share command logic instead of duplicating behavior.
- [ ] Every child process routes through `BunSelfRunner`; no command uses ad hoc Bun, shell, or Node process spawning.
- [ ] Tests prove no command mutates global state outside `<userDataRoot>/plugins/` except documented auth/trust files owned by the plugin management surface.
- [ ] Dispatch parity tests cover success, unknown flag, help, non-interactive failure, and renderer output for all six commands.
- [ ] Tests pass.
- [ ] Typecheck passes.
- [ ] Lint passes.

## Functional Requirements

- FR-1: `meta:plugin:*` authoring commands are core-owned; plugins must not contribute commands in that namespace.
- FR-2: Template scaffolding must be codegen-embedded so compiled binaries do not read template files from the runtime filesystem.
- FR-3: `meta:plugin:test`, `build`, and `publish` must route child work through `BunSelfRunner` and emit Bun self-exec lifecycle events.
- FR-4: `meta:plugin:link` and `unlink` must keep linked state under `<userDataRoot>/plugins/` and must not modify the source authoring directory except through user-requested builds.
- FR-5: `meta:plugin:publish` must validate artifact containment and auth before any publish attempt.
- FR-6: Source-mode OCLIF and compiled `$bunfs` dispatch must share behavior for every command in this PRD.
- FR-7: Cache refresh and invalidation must cover plugin discovery, plugin commands, OCLIF shims, and compiled-dispatch parity metadata.

## Non-Goals

- Allowing plugins to contribute or override `meta:plugin:*` commands.
- Building a marketplace, package search UI, or plugin review workflow.
- Supporting package managers other than Bun for plugin authoring commands.
- Publishing from unbuilt source trees without producing a validated artifact first.
- Mutating global state outside the plugin management roots named in this PRD.

## Technical Considerations

- Current OCLIF stubs live under `core/src/cli/oclif/commands/meta/plugin/{new,test,build,link,unlink,publish}.ts`; this PRD fills bodies and adds shared command helpers.
- Compiled parity branches belong in `runCompiledCli` in the same implementation change as the OCLIF command body.
- Template embedding should follow existing bundled asset codegen patterns so `bun build --compile` does not require runtime template reads.
- `package.json#exports` is the build source of truth; publish validation should reject modules that escape the package root.
- Link and unlink should use atomic writes where registry metadata changes, then invalidate caches after the new state is durable.

## Success Metrics

- A plugin author can scaffold, test, build, link, unlink, and dry-run publish a plugin in one documented flow.
- All six commands produce identical behavior in source and compiled modes in parity tests.
- No command in this toolkit runs child work outside `BunSelfRunner`.
- Linked plugin cache refreshes are visible on the next command invocation without manual cache clearing.

## Guide Coverage

Per [PRD-12 US-198](../alpha-3/prd-alpha-3-12-executable-guides.md) (`## Guide Coverage` convention) and [US-199](../alpha-3/prd-alpha-3-12-executable-guides.md) (drift gate), this PRD owns the executable guides listed below. Each guide exercises the happy path of its mapped user story; failure modes remain covered by unit and integration tests in the named packages. PRs that touch the listed surface paths MUST also touch the corresponding guide(s), or use the `Guide-Coverage-Skip:` escape hatch.

**Guides owned by this PRD:**

| User Story | Feature | Guide Path | Acceptance |
|---|---|---|---|
| US-230 | Scaffold a plugin from a bundled template | `docs/guides/plugins/authoring-new-plugin.mdx` | Required at story acceptance |
| US-231, US-232 | Test and build an authored plugin | `docs/guides/plugins/test-and-build-plugin.mdx` | Required at story acceptance |
| US-233, US-234 | Link and unlink a local plugin | `docs/guides/plugins/link-local-plugin.mdx` | Required at story acceptance |
| US-235 | Dry-run publish a plugin artifact | `docs/guides/plugins/publish-plugin.mdx` | Required at story acceptance |

**CLI / source surface paths covered (drift gate input):**

- `core/src/cli/oclif/commands/meta/plugin/**`
- `core/src/cli/commands/meta/plugin/**`
- `core/src/cli/run.ts`
- `core/src/plugins/authoring/**`
- `core/src/plugins/templates/**`
- `core/src/runtime/bun-self-runner.ts`
- `core/test/cli/parity/**`
- `core/test/plugins/**`

## Open Questions

- Should `meta:plugin:new` allow overwriting an existing destination with `--force`? Default: no, require an empty destination for Alpha 4.
- Should `meta:plugin:publish --dry-run` require auth? Default: no, dry-run validates package contents without requiring credentials.
- Should `meta:plugin:link` replace an installed registry plugin automatically? Default: only with an explicit confirmation or `--yes`, preserving the prior copy for unlink restore.
- Should publish support provenance attachment in Alpha 4? Default: defer to release supply-chain PRDs and keep plugin publish focused on package contents.
