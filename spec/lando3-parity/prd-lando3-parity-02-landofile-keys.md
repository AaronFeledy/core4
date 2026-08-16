# PRD: L3P-02 — Landofile keys (`env_file`, `toolingDefaults`, `commandAliases`, `events`)

## Introduction

The four keys in `BETA_TOP_LEVEL_KEYS` (`landofile/src/service.ts`) are fully specified 4.0 surface with no spec deferral. Rejecting them is a contract gap — and `events:` is the single largest Lando 3 behavioral gap (v3 `events:` pre/post lifecycle hooks have no shipped analog). This PRD removes the gate one key at a time, implementing each per its existing spec section, ordered simplest-first so the tooling machinery `events:` reuses is proven before events land.

Landofile schema changes flow through `@lando/sdk` (`sdk/src/schema/landofile.ts`) with snapshot/compat updates per `sdk/AGENTS.md`; parsing/merge lives in `@lando/landofile`; tooling compilation in `core/src/tooling/`; CLI dispatch in `core/src/cli/`.

## Source References

- [`spec/07-landofile-and-config.md`](../07-landofile-and-config.md) §7.5 top-level keys (`events:`, `toolingDefaults:`, `commandAliases:`, `env_file:`), §7.6 env overrides.
- [`spec/08-cli-and-tooling.md`](../08-cli-and-tooling.md) §8.1 `commandAliases` behavior/overrides/disablement, §8.5 tooling schema + `toolingDefaults` precedence, §8.5 events-as-tasks (`events:` entries accept the same step types as `cmds:`), §8.7 hot-path compilation cache.
- [`spec/03-architecture.md`](../03-architecture.md) §3 lifecycle event taxonomy and standard start sequence (`pre-start` → user-defined subscribers).
- [`spec/11-subsystems.md`](../11-subsystems.md) event publication and redaction requirements.

## User Stories

### US-562: Top-level `env_file`

**Description:** As a user, I can declare top-level `env_file:` in my Landofile and have those files apply to every service, matching v3 semantics and the §7.6 override/merge order.

**Acceptance Criteria:**

- [ ] `env_file` is removed from `BETA_TOP_LEVEL_KEYS`; the Landofile schema accepts `env_file: string | string[]` at top level with SDK schema + snapshot updates.
- [ ] Top-level entries resolve app-root-relative, apply to every service, and merge below service-level `envFile`/`environment` (service wins) per §7.6 precedence; missing files fail with a tagged error naming the path and remediation.
- [ ] Values pass through the standard redaction path before appearing in events, transcripts, or `lando info`.
- [ ] Plan cache invalidates when a referenced env file changes (content participates in the plan/tooling cache key).
- [ ] `docs/guides/landofile/env-overrides.mdx` gains a rendered top-level `env_file` scenario; guide gates green.
- [ ] Tests pass; typecheck passes; lint passes.

### US-563: `toolingDefaults`

**Description:** As a user, I can set app-wide tooling defaults (`toolingDefaults.vars`, `toolingDefaults.env`, service/dir defaults) that every tooling task inherits unless it overrides them, per §8.5.

**Acceptance Criteria:**

- [ ] `toolingDefaults` is removed from `BETA_TOP_LEVEL_KEYS`; schema per §8.5 with SDK snapshot updates.
- [ ] The tooling compiler applies defaults with spec precedence (task > recipe > defaults) for `vars`, `env`, `service`, and `dir`; compiled output is byte-stable for the hot-path cache and the cache key includes the defaults.
- [ ] Interaction with service-type-contributed tooling (§6.11.3) follows the same precedence; conflicts resolve deterministically with tests.
- [ ] Executable guide coverage: a `docs/guides/tooling/defaults-and-aliases.mdx` guide (shared with US-564) shows defaults applied and overridden; guide gates green.
- [ ] Tests pass; typecheck passes; lint passes.

### US-564: `commandAliases`

**Description:** As a user, I can define per-app command aliases (including remapping and disabling) that resolve in the CLI dispatcher per §8.1, without colliding with canonical ids.

**Acceptance Criteria:**

- [ ] `commandAliases` is removed from `BETA_TOP_LEVEL_KEYS`; schema per §8.1 with SDK snapshot updates.
- [ ] The native dispatcher resolves app-scoped aliases after canonical ids and registered aliases; an alias shadowing a canonical id is rejected with `CommandAliasConflictError` and remediation; alias disablement works.
- [ ] Alias resolution works identically in source and compiled dispatch and on the tooling hot path (aliases resolve from the cached app plan without a full bootstrap) for Landofiles fully determined by file inputs (declarative YAML at any merge layer, no template-engine rendering). Dynamic forms (`.lando.ts`, template-rendered Landofiles) serve aliases from the last full decode per §7.1.1 and are excluded from freshness parity; no environment, host, or template-input fingerprints may be introduced as cache invalidation triggers (adjudicated 2026-08-15; dynamic-form provenance deferred to a dedicated spec story).
- [ ] Machine output (`--format json`) reports the resolved canonical id; help output lists active app aliases in app context.
- [ ] Guide coverage in `docs/guides/tooling/defaults-and-aliases.mdx`; guide gates green.
- [ ] Tests pass; typecheck passes; lint passes.

### US-565: `events:` (events-as-tasks)

**Description:** As a user, I can declare `events:` entries (e.g. `pre-start`, `post-start`, `post-rebuild`) whose steps run as tooling-style tasks at the matching lifecycle points — the v4 analog of v3 build/start hooks.

**Acceptance Criteria:**

- [ ] `events` is removed from `BETA_TOP_LEVEL_KEYS`; schema accepts the §8.5 events map (event name → steps accepting the same step types as `cmds:`, incl. service targeting and canonical-command calls).
- [ ] Event names validate against the §3/§11 lifecycle taxonomy scoped to app events; unknown names fail closed at plan time listing valid names.
- [ ] Subscribers execute at the correct points in the §3 standard sequences (start/stop/restart/rebuild/destroy), in declaration order, through the tooling engine (provider exec default, host via ShellRunner) — no new execution path.
- [ ] Failure policy per spec: a failing `pre-*` subscriber aborts the operation with a tagged error carrying step identity and output tail; `post-*` failures surface as warnings without rolling back the completed operation (or per §8.5 text if stricter).
- [ ] Step output routes through the Renderer as task detail; events publish on the event bus with redaction applied.
- [ ] Recipe-contributed and service-type-contributed event tasks merge below user entries with the §6.11.3 precedence.
- [ ] New executable guide `docs/guides/landofile/events.mdx` covers pre-start/post-start with a failure-path hidden scenario; guide coverage/INDEX updated; guide gates green.
- [ ] Tests pass; typecheck passes; lint passes.
