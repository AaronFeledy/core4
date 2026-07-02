# PRD: BETA1-05 — CLI spec parity (§8)

## Introduction

Spec §8 (CLI & tooling) is the compatibility contract for the command surface. The gap audit compared §8's normative command contracts against the shipped commands and found drift that no later phase owns. Alpha 4 was "the last feature surface" phase, so none of this may slide silently into post-freeze releases: each drift is either **implemented now** or **explicitly re-scoped in the spec text** (spec wins over code, but the spec can be amended deliberately — never by omission).

Found drift:

1. **Config surfaces are read-only.** §8.2.1 gives `app config` read *and write* of the app Landofile (get/set/unset/edit/validate); §8.2.2 gives `meta config` the same for global config; the global-app stack config is likewise writable. Shipped commands only read (plus a telemetry toggle); write verbs reject with `NotImplemented`-shaped failures.
2. **`app config translate` is partial.** The spec'd detect/list/from/file flow is absent; only cwd + `--write` exists.
3. **`app includes update` is coarse.** Spec allows source-scoped refresh and `--no-network`; code always refreshes everything and only exposes `--check`.
4. **`app shell` diverges.** Spec: host-mode default, Bun-Shell-backed host execution (the `ShellRunner` service), `--no-history` / `--no-interactive`. Code: service-mode default, `child_process.spawn` host path, neither flag.
5. **`app logs` is partial.** `--follow` / `--since` are spec'd but deferred in code.
6. **Global-app commands are stubs.** `meta global list/info/logs/restart` are deferred stubs despite spec §18 (global app) shipping in Alpha 3.
7. **Version is a placeholder.** `lando version` and `CORE_VERSION` both return hardcoded `0.0.0`; no build-time injection exists.

## Source References

- [`spec/08-cli-and-tooling.md`](../08-cli-and-tooling.md) §8.1, §8.2.x, §8.4 command contracts.
- [`spec/18-global-app.md`](../18-global-app.md) global-app command surface.
- [`spec/07-landofile-and-config.md`](../07-landofile-and-config.md) §7.8.1 canonical Landofile serializer (write-path substrate).
- [`spec/12-caches-and-persistence.md`](../12-caches-and-persistence.md) — atomic persistence rules backing config writes.
- [`core/AGENTS.md`](../../core/AGENTS.md) — dual-dispatch parity, cold-start rules.

## Goals

- Every §8 command contract in scope is either green against the spec text or the spec text is amended in the same change.
- Config writes go through the canonical Landofile serializer and the atomic write path — no bespoke YAML emission.
- The compiled and OCLIF dispatch paths stay in parity for every touched command.

## User Stories

### US-389: Config write surfaces (`app config` / `meta config` / `meta global config`)

**Description:** As a user, I can `set`, `unset`, `edit`, and `validate` configuration at all three scopes — app Landofile, global config, global-app stack — exactly as §8.2 specifies, with writes that are atomic and serializer-canonical.

**Acceptance Criteria:**

- [ ] `app config set/unset/edit/validate` operate on the app Landofile: set/unset accept the spec'd path grammar, `edit` opens `$EDITOR` with post-edit validation, `validate` reports schema errors with remediation.
- [ ] `meta config set/unset/edit/validate` operate on global config with the same semantics.
- [ ] `meta global config` gains the spec'd write verbs for the global-app stack.
- [ ] Writes round-trip through the canonical `@lando/sdk/landofile` serializer (comment/format preservation per §7.8.1) and land via the atomic write helper (US-372).
- [ ] Every write emits its result through the universal machine-output contract (faithful `resultSchema`, `--json` envelope) and honors `--dry-run` where the spec requires it.
- [ ] Rejecting writes (invalid path, schema violation) fail with tagged errors + remediation, exit non-zero, and leave the file untouched.
- [ ] Dual-dispatch parity tests cover the new verbs; command result schemas are frozen in the snapshot.
- [ ] Tests pass
- [ ] Typecheck passes
- [ ] Lint passes

### US-390: `app config translate` detect/list/from/file flow

**Description:** As a migrating user, `lando config translate` can detect the foreign config in my working tree, list supported translators, and translate from an explicit format or file — not just the cwd happy path.

**Acceptance Criteria:**

- [ ] Autodetection: with no args, the command probes registered `ConfigTranslator`s' detect surfaces against the cwd and picks the unambiguous match; ambiguity fails with a list + remediation.
- [ ] `--list` enumerates registered translators (id, source format) through the machine-output contract.
- [ ] `--from=<id>` forces a translator; `--file=<path>` translates an explicit file.
- [ ] Output composes with the existing `--write` flag and the §7.8.1 serializer; non-write mode prints the translated Landofile through the renderer/JSON seam.
- [ ] Contract-suite coverage: the translate command paths are exercised against the config-translator contract suite fixtures.
- [ ] Tests pass
- [ ] Typecheck passes
- [ ] Lint passes

### US-391: Source-scoped `app includes update` with `--no-network`

**Description:** As a user with many includes, I can refresh a single include source and run include updates offline against the lockfile/cache, per §8.2.3.

**Acceptance Criteria:**

- [ ] `app includes update [source]` accepts an optional source identifier and refreshes only that include; unknown sources fail with the known-source list.
- [ ] `--no-network` performs the update strictly from cache/lock state, failing with remediation when a required artifact is absent — it never touches the network (asserted via the network-boundary test seam).
- [ ] Default behavior (all sources, network allowed) is unchanged; `--check` composes with both new options.
- [ ] Result schema extends faithfully (per-source outcomes) and is snapshot-frozen.
- [ ] Tests pass
- [ ] Typecheck passes
- [ ] Lint passes

### US-392: `app shell` spec parity (host default, ShellRunner, history/interactive flags)

**Description:** As a user, `lando shell` behaves as §8.2.4 specifies: host mode is the default, host execution runs through the Bun-Shell-backed `ShellRunner` service, and `--no-history` / `--no-interactive` are honored.

**Acceptance Criteria:**

- [ ] Default mode is host; `--service <name>` selects service mode explicitly (spec §8.2.4 precedence). The behavior change is called out in the changelog/deprecation surface since it flips an existing default.
- [ ] Host execution routes through the `ShellRunner` service (`core/src/services/shell-runner.ts`), not `child_process.spawn` in the command body — command bodies stay side-effect-free per spec §1.2.
- [ ] `--no-history` prevents host shell-history persistence for the session; `--no-interactive` runs non-TTY (suitable for agents/CI) with deterministic exit-code propagation.
- [ ] Interactive TTY behavior (signal forwarding, exit codes, terminal restore) is covered by a tmux-driven integration test or an equivalent PTY harness.
- [ ] Dual-dispatch parity holds; renderer boundary passes (no direct std stream writes).
- [ ] Tests pass
- [ ] Typecheck passes
- [ ] Lint passes

### US-393: `app logs --follow` and `--since`

**Description:** As a user debugging a service, I can stream logs live (`--follow`) and bound them by time (`--since`), per §8.2.5.

**Acceptance Criteria:**

- [ ] `--follow` streams provider logs until interrupt, through the renderer in TTY mode and as `StreamFrame` NDJSON under `--format json`; cancellation cleans up the provider log stream under `Scope`.
- [ ] `--since` accepts the spec'd duration/timestamp grammar and filters accordingly; invalid grammar fails with remediation.
- [ ] Both compose with existing `--service` / `--tail`.
- [ ] Provider capability is validated before planning: providers that cannot stream fail up front with a tagged error, not mid-stream.
- [ ] Deterministic tests via the test provider's log source; live provider stream behavior covered in the env-gated integration suite.
- [ ] Tests pass
- [ ] Typecheck passes
- [ ] Lint passes

### US-394: Real implementations for `meta global list/info/logs/restart`

**Description:** As a user of the global app (shipped in Alpha 3), the global-app management commands actually work instead of returning deferred-stub errors.

**Acceptance Criteria:**

- [ ] `meta global list` enumerates global-app services with status through the machine-output contract.
- [ ] `meta global info` reports the global app's resolved config/urls/services (parity with `app info` shape where §8.4 says so).
- [ ] `meta global logs` supports the same surface as `app logs` (including US-393 flags) scoped to the global app.
- [ ] `meta global restart` restarts the global app deterministically (stop+start semantics per §8.4).
- [ ] The deferred-stub helper is no longer referenced by these four commands; compiled-dispatch branches exist and parity tests cover them.
- [ ] Result schemas are added to the frozen snapshot; `--json` envelopes verified by the conformance suite.
- [ ] Tests pass
- [ ] Typecheck passes
- [ ] Lint passes

### US-395: Real version reporting

**Description:** As a user (or installer, or self-update flow), `lando version` and `lando --version` report the actual build version, embedded at build time — never `0.0.0`.

**Acceptance Criteria:**

- [ ] `CORE_VERSION` (`core/src/version.ts`) and the `version` command result derive from the package version at build time: compiled binaries embed it via the build's define/injection step, and source dispatch reads the workspace package version.
- [ ] `lando version` reports core, Bun, and platform truthfully in both dispatch modes; `lando --version` fast path stays within the cold-start budget (< 80ms cold per the command's contract) — no Effect/OCLIF import creep.
- [ ] The release pipeline's version stamping (scripts/release.ts) and this embedding agree — one source of truth for the version string; a release-stage test asserts the built binary prints the stamped version.
- [ ] A guard test fails if `CORE_VERSION` regresses to the `0.0.0` placeholder in a built artifact.
- [ ] Tests pass
- [ ] Typecheck passes
- [ ] Lint passes

## Functional Requirements

- **FR-1:** Every touched command keeps dual-dispatch parity and the universal machine-output contract.
- **FR-2:** All config writes are serializer-canonical and atomic; no command hand-emits YAML.
- **FR-3:** No spec'd verb remains a silent stub: it works, or the spec text is amended in the same change with the deferral recorded.
- **FR-4:** New/changed result schemas are frozen in the snapshot with the conformance suite green.

## Non-Goals

- No new commands beyond the spec'd surface; no flag surface invented beyond §8.
- No provider log-driver feature work beyond what `--follow`/`--since` require.
- No interactive TUI redesign for shell/logs (renderer polish shipped in Alpha 4).

## Technical Considerations

- The `app shell` host-mode default flip is user-visible; if any pre-release channel users depend on service-default, route the change through the deprecation governance surface (PRD-ALPHA4-03 machinery) even though pre-1.0 guarantees are soft.
- `--follow` under `--format json` must emit heartbeat-free, well-formed NDJSON frames; reuse the US-383 seam.
- Version embedding in compiled mode must respect the compiled-binary constraints in `core/AGENTS.md` (no `import.meta.url` tricks; use build-time define).
- `meta global logs/restart` should share implementation with the app-scoped commands via the global `AppRef`, not fork logic.

## Success Metrics

- Zero deferred-stub commands remain for spec'd §8 verbs in scope.
- `rg "NotImplemented" core/src/cli/commands/{config,app-config}*` returns nothing for the write verbs.
- A compiled binary prints its real semver for `--version` within budget.

## Guide Coverage

| Surface | Guide | Status |
| --- | --- | --- |
| Config editing (`app config set/edit/validate`) | `docs/guides/cli/config-editing.mdx` | Planned (new guide, this PRD) |
| Logs streaming (`app logs --follow`) | owned by the existing logs guide surface | Update — re-run drift gate |
| Global app management | owned by the Alpha 3 global-app guide | Update — re-run drift gate |

## Open Questions

- Does §8.2.4's host-mode default hold for `lando shell` with zero args inside an app directory, or is service-mode-with-primary-service the spec'd behavior there? The implementing engineer must read §8.2.4 verbatim before flipping the default; if the spec is ambiguous, amend the spec first.
- `--since` grammar: duration-only (`1h`, `30m`) or also RFC3339 timestamps? Follow §8.2.5's literal text; extend the spec explicitly if it under-specifies.
