# PRD: ALPHA4-02 — Open-decision resolution & plugin trust

## Introduction

Alpha 4 closes the remaining §14.2 decisions that affect runtime trust, CLI dispatch assumptions, setup behavior, Compose compatibility, and SSH agent realization. This PRD records those decisions as implementation stories so the final answer is not just prose: package metadata, schemas, CLI behavior, generated docs, tests, and user-facing guides must all reflect the chosen direction.

Compiled-binary CLI dispatch unification is already resolved as permanent dual dispatch per §8.4.1 and Appendix D.1. This PRD treats that as fixed context, not a decision to reopen.

Depends on: **ALPHA4-01** (`lando setup` and `lando uninstall` completion), because provider auto-setup defaults and trust prompts must align with the finished setup surface.

## Source References

- [`spec/14-appendices.md`](../14-appendices.md) §14.2 open decisions and Appendix D.1 compiled-dispatch rationale.
- [`spec/10-plugins.md`](../10-plugins.md) §9 plugin discovery, install, and postinstall trust policy.
- [`spec/07-landofile-and-config.md`](../07-landofile-and-config.md) §7 Compose subset and schema publication.
- [`spec/11-subsystems.md`](../11-subsystems.md) §10.4 SSH and host identity.
- [`spec/08-cli-and-tooling.md`](../08-cli-and-tooling.md) §8.4.1 dual-dispatch parity.

## Goals

- Close every remaining §14.2 decision that blocks Alpha 4 feature freeze.
- Keep current hard facts explicit: Bun floor is `>=1.3.14`, OCLIF is v4 today, and compiled dispatch remains permanently dual path.
- Publish schema-backed compatibility and trust surfaces instead of relying on narrative docs alone.
- Make untrusted plugin postinstall behavior safe by default while preserving a deliberate trust path for users and authoring workflows.

## User Stories

### US-208: Bun floor decision + `--bytecode` validation

**Description:** As a release engineer, I need the Alpha 4 Bun version floor confirmed or bumped so every cross-compiled binary can use `--bytecode` consistently.

**Acceptance Criteria:**
- [ ] A Alpha 4 decision note confirms `>=1.3.14` or records the bumped minimum with rationale and affected release targets.
- [ ] Root `package.json`, `core/package.json`, `.bun-version`, release docs, and any generated install docs all show the same minimum Bun version.
- [ ] The release validation suite proves `bun build --compile --bytecode` works for every configured cross-compile target or fails with a documented blocker tied to the decision.
- [ ] Tests pass.
- [ ] Typecheck passes.
- [ ] Lint passes.

### US-209: OCLIF major lock decision

**Description:** As a CLI maintainer, I need the OCLIF v4 versus v5 decision closed so source-mode CLI behavior, manifest generation, and dual-dispatch parity tests have a stable target.

**Acceptance Criteria:**
- [ ] A Alpha 4 decision note chooses either stay on OCLIF v4 or move to OCLIF v5, with the current `@oclif/core ^4.11.2` and `oclif ^4.23.0` state cited.
- [ ] If staying on v4, dependency ranges, compatibility notes, and dispatch parity assumptions are preserved and documented.
- [ ] If moving to v5, source-mode command loading, manifest generation, hooks, and parity tests are updated in the same story and no compiled-dispatch unification is attempted.
- [ ] Tests pass.
- [ ] Typecheck passes.
- [ ] Lint passes.

### US-210: Provider auto-setup level decision + setup-default alignment

**Description:** As a first-time user, I need `lando setup` and first-run provider preparation to follow one documented UX, either aggressive auto-setup or guided opt-in.

**Acceptance Criteria:**
- [ ] A Alpha 4 decision note chooses aggressive auto-setup or guided opt-in and defines the default for interactive, non-interactive, and CI contexts.
- [ ] `lando setup` defaults, prompts, `--yes`, `--no-interactive`, and provider readiness checks align with the chosen UX.
- [ ] User docs and setup tests cover the selected default and the rejected alternative's remediation path.
- [ ] Tests pass.
- [ ] Typecheck passes.
- [ ] Lint passes.

### US-211: Compose subset key matrix + per-key remediation

**Description:** As a user importing Compose-shaped config, I need a published key matrix that clearly shows which keys Lando accepts and what to do when a key is rejected.

**Acceptance Criteria:**
- [ ] The supported top-level Compose subset is frozen as `services`, `volumes`, `networks`, `configs`, `secrets`, `include`, and `x-*`; `version:` is accepted as deprecated.
- [ ] Unsupported top-level keys fail closed with a specific remediation message for each accepted, deprecated, and rejected key class.
- [ ] The matrix is schema-backed, generated or checked by tests, and published in user docs so docs cannot drift from validation behavior.
- [ ] Tests pass.
- [ ] Typecheck passes.
- [ ] Lint passes.

### US-212: `sshAgent.sidecar: false` ship-or-reject decision

**Description:** As a security-conscious operator, I need the reserved `sshAgent.sidecar: false` setting either shipped with a safe direct-mount fallback or rejected with a clear warning.

**Acceptance Criteria:**
- [ ] A Alpha 4 decision note chooses whether `sshAgent.sidecar: false` ships or remains rejected, with sidecar default `true` preserved.
- [ ] If shipped, the direct-mount fallback has schema, docs, tests, platform constraints, and security remediation text.
- [ ] If rejected, config validation and docs explain that `false` is reserved and identify the supported sidecar path.
- [ ] Tests pass.
- [ ] Typecheck passes.
- [ ] Lint passes.

### US-213: Plugin trust surface + postinstall gating finalized

**Description:** As a user installing plugins, I need an explicit trust surface that prevents arbitrary postinstall scripts unless I trust the plugin, session, or authoring root.

**Acceptance Criteria:**
- [ ] `<userConfRoot>/plugin-trust.yml` is published as an Effect Schema with sorted-unique `trustedPlugins: []` and `trustedAuthoringRoots: []`.
- [ ] `meta:plugin:trust <name>` validates an npm-ish plugin name, persists it, invalidates plugin command cache, and renders `trusted-plugin: <name>`.
- [ ] `meta:plugin:trust-authoring-root <abs>` requires an absolute path, persists the resolved absolute path, invalidates cache, and renders `trusted-authoring-root: <abs>`.
- [ ] `BunSelfRunner.add` and `.install` disable arbitrary postinstall scripts for untrusted plugins, then allow trusted scripts only in a recursion-guarded BunSelfRunner child that emits `pre-bun-self-exec` and `post-bun-self-exec` with `verb: "install"`.
- [ ] Gating recognizes session trust, persistent plugin trust, persistent authoring-root trust, explicit `--trust`, and non-interactive rejection as untrusted.
- [ ] Tests pass.
- [ ] Typecheck passes.
- [ ] Lint passes.

### US-214: Trust list/revoke, scope, expiry, and flag-model decision

**Description:** As a maintainer, I need the remaining trust-model sub-questions closed so the command surface, persistence policy, and install flags are not left ambiguous at feature freeze.

**Acceptance Criteria:**
- [ ] A Alpha 4 decision note chooses whether `meta:plugin:trust list` and `meta:plugin:trust revoke` ship now or are explicitly deferred with rationale; if shipped, the existing `untrustPlugin` service path has CLI coverage.
- [ ] Trust expiry is either rejected as non-expiring Alpha 4 state or implemented with schema, migration, and renderer coverage.
- [ ] Trust scope is defined for npm/registry, git, and local plugin sources, including how authoring-root trust applies to linked plugins.
- [ ] The exact flag model is published, including `--trust`, non-interactive behavior, and any prompt wording for interactive installs.
- [ ] Tests pass.
- [ ] Typecheck passes.
- [ ] Lint passes.

## Functional Requirements

- FR-1: The Bun version floor must be one value across package metadata, docs, installers, and release validation.
- FR-2: The OCLIF major decision must preserve the permanent dual-dispatch model and keep source CLI and compiled `$bunfs` parity tests authoritative.
- FR-3: Provider auto-setup must have one default UX across `lando setup`, first-run prompts, non-interactive mode, and docs.
- FR-4: Compose top-level key handling must be schema-backed and must include remediation for accepted, deprecated, and rejected keys.
- FR-5: `sshAgent.sidecar: false` must be either implemented safely or rejected explicitly; silent partial support is forbidden.
- FR-6: Plugin trust must persist under `<userConfRoot>/plugin-trust.yml` with deterministic ordering and schema publication.
- FR-7: Untrusted plugin postinstall scripts must not run by default; trusted execution must route through `BunSelfRunner` and lifecycle events.

## Non-Goals

- Reopening compiled-binary CLI dispatch unification.
- Adding plugin-owned `meta:plugin:*` commands.
- Shipping a web UI for trust management.
- Supporting arbitrary Compose behavior beyond the frozen top-level key subset.
- Adding time-based trust expiry unless US-214 explicitly chooses it.

## Technical Considerations

- The compiled binary dispatch decision is already permanent: OCLIF remains source-mode only, and `runCompiledCli` remains the compiled dispatcher.
- Trust storage belongs under `<userConfRoot>`, while plugin install state and authoring links remain under the existing plugin roots.
- Cache invalidation for trust changes must cover plugin command cache, OCLIF shim cache where applicable, and plugin discovery cache.
- The Compose key matrix should be generated from, or mechanically checked against, the schema layer so docs cannot drift.
- Non-interactive plugin installation should fail safe by treating untrusted postinstall scripts as disabled, not by prompting or running scripts.

## Success Metrics

- Every §14.2 Alpha 4 decision has a linked decision note and matching implementation test.
- A user can identify why a Compose key was rejected from the CLI error alone.
- Installing an untrusted plugin never runs an arbitrary postinstall script.
- Trusting a plugin or authoring root updates cache state immediately and makes the next install behavior predictable.

## Guide Coverage

Per [PRD-12 US-198](../alpha-3/prd-alpha-3-12-executable-guides.md) (`## Guide Coverage` convention) and [US-199](../alpha-3/prd-alpha-3-12-executable-guides.md) (drift gate), this PRD owns the executable guides listed below. Each guide exercises the happy path of its mapped user story; failure modes remain covered by unit and integration tests in the named packages. PRs that touch the listed surface paths MUST also touch the corresponding guide(s), or use the `Guide-Coverage-Skip:` escape hatch.

**Guides owned by this PRD:**

| User Story | Feature | Guide Path | Acceptance |
|---|---|---|---|
| US-210 | Provider setup default UX | `docs/guides/setup/provider-auto-setup.mdx` | Required at story acceptance |
| US-211 | Compose subset compatibility matrix | `docs/guides/config/compose-compatibility.mdx` | Required at story acceptance |
| US-213 | Plugin trust commands and postinstall gating | `docs/guides/plugins/trust-postinstall.mdx` | Required at story acceptance |
| US-214 | Trust list/revoke and scope decision | `docs/guides/plugins/trust-management.mdx` | Required at story acceptance |

**CLI / source surface paths covered (drift gate input):**

- `package.json`
- `core/package.json`
- `core/src/cli/commands/meta/plugin/**`
- `core/src/plugins/trust-store.ts`
- `core/src/plugins/**`
- `core/src/landofile/**`
- `core/src/cli/commands/setup.ts`
- `core/src/cli/run.ts`
- `spec/14-appendices.md`

## Open Questions

- Should the Bun floor stay at `>=1.3.14` if one target needs a newer `--bytecode` fix? Default: bump the floor rather than special-case one target.
- Should `meta:plugin:trust revoke` ship in Alpha 4 even if list output is minimal? Default: ship revoke because the service already supports untrusting plugins.
- Should git plugin trust be tied to package name, resolved URL, or authoring root? Default: package name for registry/npm, resolved absolute authoring root for local, and explicit trust required for git.
- Should `sshAgent.sidecar: false` warn or hard-fail if rejected? Default: hard-fail at schema validation with remediation.
