# PRD: Lando 3 compatibility user stories

Spec: [`spec-lando3-compat.md`](./spec-lando3-compat.md). Global priorities, dependencies, and standard gates are recorded in the index and `prd.json`.

## Guide Coverage

| Story | Feature | Guide |
|---|---|---|
| US-619B1 | executable, package, install, and shellenv coexistence | `docs/guides/tutorial/from-lando-3.mdx` |
| US-619B3 | update, uninstall, and complete coexistence | `docs/guides/tutorial/from-lando-3.mdx` |
| US-621D | explicit layered conversion | `docs/guides/landofile/convert-from-lando-3.mdx` |
| US-622B | closure and supported matrix | both guides and `docs/guides/INDEX.md` |

### US-619B1: Ship isolated executable, package, installer, and shellenv ownership

**Description:** As a Lando 3 user, every Lando 4 entry and installation mutation remains under the `lando4` identity.

**Acceptance Criteria:**
- [ ] Keep npm bin and installed executable `lando4`/`lando4.exe`, retain platform release asset names, and use the one native registry for source and every relocated compiled target.
- [ ] Source, compiled, npm-package, release-archive, Windows-basename, first-surface guide, and applicable standard gates pass without touching a seeded `lando` executable.
- [ ] Installer and shellenv use only the v4 install record, reject foreign-owned destinations, and never rename, replace, chmod, shim, remove, or rewrite `lando`, v3 state, or unrelated PATH entries.
- [ ] Hostile preinstalled-v3 byte/mode/link/path fixtures, repeat install/shellenv, platform installers, operation-specific guide, and applicable standard gates pass.

### US-619B3: Isolate update, Windows replacement, and uninstall

**Description:** As a Lando 3 user, update and uninstall mutate only v4-owned artifacts on every platform.

**Acceptance Criteria:**
- [ ] Update resolves the v4 install record and replaces only `lando4`; Windows running-executable rename/rollback touches only `lando4.exe` and rejects any foreign owner or target.
- [ ] Success, verification failure, rollback, interruption, Windows, hostile `lando.exe`, operation-specific guide, release, and applicable standard gates pass with v3 bytes/metadata unchanged.
- [ ] Uninstall removes only entries in the v4 install record, leaves `lando`, v3 state/resources, foreign files, and PATH ownership untouched, and is idempotent.
- [ ] End-to-end install/shellenv/update/uninstall hostile-v3 preservation, complete coexistence guide, release-package, platform, and applicable standard gates pass.

### US-620A: Add the source-preserving LEGACY parser

**Description:** As a translator, I can read the pinned kitchen-sink dialect without weakening v4 parsing.

**Acceptance Criteria:**
- [ ] Add explicit `LEGACY` mode for quotes, block scalars, populated flow collections, anchors, bounded aliases, and arbitrary tags as data, with duplicate-key, byte, depth, alias, and source-span contracts.
- [ ] Copy the checksum-pinned licensed corpus to owning test fixtures; normal v4 restrictions remain unchanged, no production/test reads `spec/**`, and parser/applicable standard gates pass.

### US-620B: Model document sets and bundle the conservative translator

**Description:** As a conversion caller, I can model seven ordered layers and load the decode-only translator through the standard graph.

**Acceptance Criteria:**
- [ ] Model API-3/API-4 services, recipe/config, tooling, events, proxy, Compose, tags, unknown keys, source ids/spans, and legacy mapping/array merge over one core-ordered bounded set.
- [ ] Detection consumes supplied snapshots only, automatic signals remain conservative, explicit `--from lando3` handles ambiguous input, custom basenames are diagnostic-only, and deterministic applicable standard gates pass.
- [ ] Create `@lando/lando3` with only SDK/paths dependencies, root export, `configTranslators: [lando3]`, generated lazy bundling, stable producer identity, and duplicate-id collision coverage; contribute no doctor check yet.
- [ ] Close over injected `RecipeDecomposer` while keeping public `R = never`; plugin DAG, clean install, codegen, cold-start, contract, and applicable standard gates pass.

### US-621A: Lower recipes while preserving final layered semantics

**Description:** As a layered recipe-app user, foreign-merged options lower through the shared path without inventing delete behavior.

**Acceptance Criteria:**
- [ ] Map every supported legacy recipe/config option, invoke the injected decomposer once per required effective option view, emit mandatory producer provenance, and never persist raw secret answers.
- [ ] Permit safe bundled declarative evaluation but reject unknown/hoster recipes, arbitrary `recipe.ts`, remote/app code, files, postInit, provider action, and unmapped options with exact diagnostics; applicable standard gates pass.
- [ ] Require final effective-config equivalence over the representable subset and prefix equality where algebra permits; for an unrepresentable removal, hoist the smallest merge-identity unit to its last-transition layer, omit lower copies, preserve unrelated source-owned fields, and emit the exact relocation diagnostic.
- [ ] Cover dist-redis/local-false, nested removal, scalar and identity arrays, recipe-layer interval, no nonexistent prefix, live structural-option regeneration, and single-layer fail-closed dependency closure; applicable standard gates pass.

### US-621C1: Lower services, build phases, and catalog options

**Description:** As a hand-authored app user, representable service, build, Compose, and catalog intent has an explicit native target.

**Acceptance Criteria:**
- [ ] Lower catalog, API-3 nested, API-4 lando/l337, unknown-image, portforward, overrides, SSL, compose include, excludes, env/file/volume/network/extension/anchor, and derived-type rows exactly as §6.3 and the residual table specify.
- [ ] Block execution-shaping rejected Compose fields and services without required images; emit one diagnostic per unsupported image/mount subfield; core validates literal include target metadata and blocks missing/unsafe targets without dropping them or reading contents; golden and applicable standard gates pass.
- [ ] Lower `build_as_root`, `build_internal`, `build`, `run_as_root`, `run_internal`, and `run` to ordered artifact/app steps with resolved explicit users and correct internal/external semantics.
- [ ] Preserve command order and build-key identity, reject unsafe remote context/build-ssh variants, and pass provider/build/runtime plus applicable standard gates.
- [ ] Lower US-618A/B/C/E fields and every `target` or mixed `target/drop` residual catalog row, including exact config destinations, Composer/Node packages, Redis, Mailpit, Apache, Node, and generated version metadata.
- [ ] Separate supported real-runtime fixtures from unavailable-version and unsupported-option rejections; do not manufacture images; README/provider and applicable standard gates pass.

### US-621C3: Lower tooling, tags, and lifecycle events

**Description:** As a tooling user, supported commands, data tags, and event hooks convert without residual syntax or changed failure behavior.

**Acceptance Criteria:**
- [ ] Lower tooling metadata and ordered service/host/user/dir steps through the normalized schema; rewrite `!load`/`!import` and decoder suffixes to authoring expression AST without reading referenced files.
- [ ] Diagnose level/usage/examples/interactive/background and plugin/key variants exactly once with native/manual alternatives; golden, CLI/MCP, and applicable standard gates pass.
- [ ] Lower app, pre/post restart, and pre/post tooling events after dynamic task-name validation, generating the documented primary service when omitted and preserving exact ordering.
- [ ] Cover nested command cycles/depth, pre/body/post failures, fatal post-step tails, unknown events, and applicable standard gates.

### US-621C5: Lower routes, home, host, router, and scanner behavior

**Description:** As an app user, supported routing, persistence, host reachability, and scanner settings survive conversion.

**Acceptance Criteria:**
- [ ] Lower string/object/wildcard/port/path/secured routes, pathname strip behavior, headers, and supported middleware to ordered route/filter objects with layer identity merge.
- [ ] Diagnose every unsupported middleware by name; golden plans, real Traefik routing, and applicable standard gates pass.
- [ ] Emit default home intent with explicit unknown-image remediation, map host alias/IP capability, map proxy OFF to router disablement, and lower bounded scanner false/object settings.
- [ ] Add no legacy `/lando`, `/helpers`, user-state mounts, `LANDO_MOUNT`, or fabricated host address; real home/route/scan and applicable standard gates pass.

### US-621C8: Enforce all remaining dispositions

**Description:** As a migrating user, every remaining source variant is targeted, dropped with remediation, or rejected without hidden scope.

**Acceptance Criteria:**
- [ ] Implement every residual-table and global/CLI row not owned by US-621C1, US-621C3, or US-621C5, including scoped-command guidance, global-map nonimport, no CLI-history lowering, environment reference guidance, custom basenames, plugin/private registry, hoster, pull/push/share, and legacy output flags.
- [ ] Assert every inventory path has exactly one `target`, `drop`, or `unsupported` owner and one golden diagnostic/output case; no residual bag, fallback, runtime emulation, or unspecified variant remains; applicable standard gates pass.

### US-621D: Commit and guide the complete lowered output set safely

**Description:** As a user, explicit conversion commits through the shared transaction or preserves my originals with actionable remediation.

**Acceptance Criteria:**
- [ ] Integrate every recipe/service/build/tooling/event/route/home/catalog/residual lowerer into one set result, validate final authoring equivalence and allowed outputs, and commit through US-608C/US-608D with immutable digest backups and source deletion intents.
- [ ] Failure injection covers every commit/recovery boundary, concurrent edits, original absence, recipe-layer removal, single-layer refusal, byte-identical repeat, and all lowerer goldens plus applicable standard gates.
- [ ] Keep bounded raw-key remediation only after ordinary v4 failure, never load a translator, and make ambiguous valid-v4-shaped input explicit-only; pending transactions recover or block before native loading.
- [ ] Ship layered conversion and side-by-side guides covering detect/explicit, diagnostics, relocation, immutable backups, recipe folding, external settings checks, rejection fixtures, and real provider evidence where meaningful; applicable standard gates pass.

### US-622A: Add bounded doctor ports and checks

**Description:** As a user, doctor reports leftovers and potential PATH shadowing without executing arbitrary binaries or reading uncontrolled state.

**Acceptance Criteria:**
- [ ] Add SDK app-identity, selected-provider name/label inspector, and executable-path locator contracts plus core implementations before adding plugin doctor contributions; locator normalizes `lando4`/`lando4.exe`, performs bounded filesystem/PATH checks only, and never executes or reads candidate contents/state.
- [ ] Leftovers inspect only selected `docker` or actual provider id `podman`, skip informationally without app context, and skip managed `lando` before daemon access; shadow is unverified informational only; no proxy duplicate/container-runtime import; fake-home/path/provider/platform and applicable standard gates pass.

### US-622B: Close the compatibility wave

**Description:** As a maintainer, every supported and rejected surface has indexed evidence and completed predecessors.

**Acceptance Criteria:**
- [ ] Require every terminal predecessor, including US-611B and US-622A, to have `passes: true` with recorded positive-count evidence before changing this story from its initial `passes: false` to true; verify all capabilities, residual rows, ids, priorities, references, and dependencies.
- [ ] Run all named root, SDK, plugin, transaction, release, guide, transcript, real-provider, codegen, and boundary gates; update gap analysis, version matrix docs, and guide index without claiming unsupported fixtures convert.
