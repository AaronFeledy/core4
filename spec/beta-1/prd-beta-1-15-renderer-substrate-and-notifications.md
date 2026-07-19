# PRD: BETA1-15 — Renderer substrate, notifications, and the 4.1 renderer contract freeze

## Introduction

Beta 1 closes the renderer's last unspecified seam: **what the bundled default renderer is actually built on**. PRD-ALPHA4-12 allowed OpenTUI as an implementation dependency for bounded TTY surfaces and PRD-BETA1-03 moved renderer ownership behind `@lando/renderer-lando`, but the TTY substrate itself — how the §8.9.2 task-tree live region is painted, what happens when the substrate cannot initialize, and how frames are tested — remained an accident of implementation. Today the plugin hand-rolls a whole-frame repaint painter (cursor rewind + erase + repaint in `task-tree-tail.ts`) that duplicates, less robustly, what the substrate's split-footer mode does natively: a pinned live region, scrollback-committed passthrough lines, atomic frames, and resize replay.

This PRD implements the §8.9.3 default-renderer implementation contract on `@opentui/core` `^0.4.3` (the `package.json`/lockfile version bump for `plugins/renderer-lando` is in place; the substrate behaviors this PRD specifies — import discipline, degradation, the split-footer live region, and frame-snapshot coverage — are not), adds the desktop-notification pipeline (§8.9.7: the `notify.desktop` render event, the `notifications` renderer capability, and the bundled `@lando/notify-lando` policy plugin), and executes the **contract-only freeze** of the 4.1 renderer surfaces (§8.9.4 rich render events, §8.9.5 renderer panel slots, §8.9.6 keymap, §8.9.8 interactive log viewer) following the `TunnelService`/`RemoteSource` precedent: schemas, manifest surface, and contract suites ship now; implementations land in 4.1.

The surfaces were written into the normative spec first (§8.9.3–§8.9.8, §9.5, §1.4, §10.10.2, §11.3.1, §13.1, §17.3.1); when this PRD and a spec part disagree, the spec part wins.

## Source References

- [`spec/08-cli-and-tooling.md`](../08-cli-and-tooling.md) §8.9 `RendererCapabilities` (the renderer-neutral public capability surface; raw OpenTUI terminal capability probing stays an internal `@lando/renderer-lando` detail); §8.9.3 the default-renderer implementation contract (substrate version floor, import discipline, degradation, split-footer live region, animation, prompt chrome, frame-snapshot testing); §8.9.4 rich render events; §8.9.5 renderer panel slots (`RendererPanelSlot`, `RendererPanelId`, `StyledSpan`, `PanelView`, `RendererPanelWatch`, non-blocking enforcement); §8.9.6 the frozen keymap schemas (`RendererActionId`, `RendererKeyName`, `RendererKeyChord`, `RendererKeyBinding`, `KeymapConfig`); §8.9.7 desktop notifications + `NotifyConfig` (foreground-only, realized via OpenTUI's `triggerNotification`); §8.9.8 the spec-frozen interactive log viewer; §8.9.1–§8.9.2 the unchanged behavioral contracts.
- [`spec/03-architecture.md`](../03-architecture.md) §11.3.1 bounded subscriber selectors, the `cli-command-terminal` family, and subscriber factories; §11.1 `LandoPluginContext.events.publishRender`.
- [`spec/10-plugins.md`](../10-plugins.md) §9.5 the `rendererPanels:` and frozen `subscribers:` contribution surfaces (100..999 priority band); §9.8 `LandoPluginContext.events`.
- [`spec/01-mission-and-tenets.md`](../01-mission-and-tenets.md) §1.4 the `@lando/notify-lando` bundle row.
- [`spec/11-subsystems.md`](../11-subsystems.md) §10.10.2 the explicit non-goal statement that container-initiated `notify`/`clipboardCopy` relay through `HostProxyService` is unsupported/deferred (a PTY-attached container can already emit terminal protocols directly; a detached worker owns no renderer/TTY to relay through).
- [`spec/13-testing-and-distribution.md`](../13-testing-and-distribution.md) §13.1 the "Renderer frames", "Renderer capability contract", and "Renderer panel contract" layers.
- [`spec/15-binary-build-and-release.md`](../15-binary-build-and-release.md) §17.3.1 `scripts/build-compiled-binary.ts`'s `onResolve` build plugin and the generated 8-root/5-mapping OpenTUI native-package catalog + 35 stubs (§17.2).
- [`spec/02-toolchain.md`](../02-toolchain.md) §2.1 cold-start budgets that the import-discipline rules protect.
- [`sdk/AGENTS.md`](../../sdk/AGENTS.md) additive-export discipline, `sdk/API_COMPATIBILITY.md`, `codegen:schema-snapshot`.
- [`core/AGENTS.md`](../../core/AGENTS.md) renderer boundary gate, OpenTUI dynamic-import boundary; [`plugins/renderer-lando/`](../../plugins/renderer-lando/) the current painter (`task-tree-tail.ts`), prompt driver (`src/opentui/prompt-driver.ts`), and keybindings.

## Goals

- Pin the bundled renderer's TTY substrate to `@opentui/core` `^0.4.3` with the §8.9.3 import-discipline and degradation contract enforced by tests and boundary gates.
- Replace the hand-rolled task-tree repaint painter with the substrate's split-footer live region (captured stdout, scrollback-committed passthrough, atomic frames, resize replay) while keeping every §8.9.1/§8.9.2 behavioral requirement and perf budget green.
- Polish prompt chrome (titled panels, selection indicators) and stand up the headless frame-snapshot harness on `@opentui/core/testing`.
- Ship the desktop-notification pipeline end-to-end: SDK event + capability, renderer OSC realization, and the bundled `@lando/notify-lando` policy plugin.
- Freeze the 4.1 renderer surfaces as contract-only SDK exports with their contract suites, so GA ships stable schemas without implementations.

## User Stories

### US-455: OpenTUI 0.4.x baseline, import discipline, and degradation

**Description:** As a user on any terminal, the bundled renderer either runs on its specified substrate or degrades to line mode — it never crashes a command, slows cold start, or contaminates machine output because of the TUI layer.

**Acceptance Criteria:**

- [ ] `@lando/renderer-lando` depends on `@opentui/core` `^0.4.3`; no other workspace package depends on it, and no static import of `@opentui/core` exists in any production module — production code loads it only via a Bun-traceable literal `import("@opentui/core")` inside the renderer plugin (no constructed or aliased specifier); `plugins/renderer-lando/test/**` MAY statically import `@opentui/core/testing` — asserted by a boundary test that encodes the production/test glob distinction and additionally rejects a constructed-specifier fixture (§8.9.3 "Import discipline").
- [ ] OpenTUI is not loaded for level-`none` commands, the pre-renderer fast path, non-TTY runs, or `--renderer=plain|json` runs, asserted by an import-graph/spy test on both dispatch paths.
- [ ] A forced substrate load/init failure (missing native binding fixture, unsupported-terminal fixture) degrades to the non-TTY line-mode path for the remainder of the process with a debug-level notice; the command completes successfully and `json`/`plain` output is byte-identical to a run without the substrate.
- [ ] §2.1 cold-start and first-paint perf-budget suites stay green after the substrate lands.
- [ ] `scripts/build-compiled-binary.ts` (§17.3.1) wraps programmatic `Bun.build({ compile, plugins })` with an `onResolve` plugin that matches exactly the 8 catalog `@opentui/core-*` native-package roots, lets the one root matching the current release target resolve normally, and redirects the other 7 to generated import-free throwing stubs (never redirecting `@opentui/core/testing` or a relative/non-root import); `scripts/build-opentui-native-stubs.ts` (§17.2) generates the 8-root/5-mapping catalog plus the 35 stub modules (5 release targets × 7 redirected roots), with a deterministic re-run + `git diff --exit-code` drift gate and a focused `bun run codegen:opentui-native-stubs` command.
- [ ] Stage 7 of the §17.1 release pipeline, the local rehearsal path, and every other release-shaped main-binary compile call site are migrated to call `scripts/build-compiled-binary.ts`'s wrapper — asserted by a source-grep gate that no bare `bun build --compile`/`Bun.build({ compile })` call for the main binary exists outside the wrapper; the §10.10.3 in-container shim and other small helper binaries are explicitly unaffected and keep their plain, plugin-free compile call.
- [ ] Each of the five release targets' compiled binary embeds exactly one native shared library (the one matching its own target) with no sidecar `node_modules` or loose native library file; a relocated binary driven through a PTY harness initializes the substrate and renders successfully, proves the other 7 catalog roots are unreachable (each would throw its stub's fixed error), and proves the native asset is unreachable from any level-`none`/`json`/non-TTY invocation.
- [ ] Tests pass
- [ ] Typecheck passes
- [ ] Lint passes

### US-456: Split-footer task-tree live region

**Description:** As a user watching a multi-service build, the task tree renders in a bottom-pinned live region while completed output scrolls into native terminal scrollback — no torn frames, no repaint artifacts, and resize just works.

**Acceptance Criteria:**

- [ ] The §8.9.2 task tree renders through the substrate's split-footer screen mode with captured stdout; the hand-rolled repaint painter (`task-tree-tail.ts` whole-frame rewind/erase/repaint) is removed, not kept as a parallel path (its non-TTY line-mode formatting survives as the degradation/line path).
- [ ] Passthrough lines (`log.line`, `message.*`, completed-tree summaries) are committed to terminal scrollback above the live region in arrival order, interleaved deterministically with tree updates (no lost or duplicated lines under concurrent writes).
- [ ] Terminal resize mid-build triggers the substrate's split-footer replay reset; committed scrollback and the live region survive without corruption, covered by a resize frame-snapshot fixture.
- [ ] The §8.9.2 alt-screen full-tail expand is realized as a runtime screen-mode transition and back; `task.detail.expand`/`task.detail.collapse` publication and state restoration behave per contract.
- [ ] Continuous rendering (live mode) is enabled only while an animated affordance is on screen, dropped when static, and capped at 30 fps, asserted via the substrate's render-loop instrumentation.
- [ ] The §8.9.2 perf-budget fixture (three sleeping services) and the §13.1 first-paint suite pass unchanged.
- [ ] Tests pass
- [ ] Typecheck passes
- [ ] Lint passes

### US-457: Prompt chrome polish and the frame-snapshot harness

**Description:** As a user answering prompts, panels carry titles and explicit selection indicators; as a maintainer, every rendered surface has headless frame-snapshot coverage.

**Acceptance Criteria:**

- [ ] Prompt panels render a border title with accent color (replacing the separate message row where appropriate) and select/multiselect controls show an explicit selection indicator; `InteractionService` seams, prompt schemas, and answer semantics are untouched.
- [ ] A frame-snapshot harness on `@opentui/core/testing` (`createTestRenderer`, memory-buffered output) covers: task-tree frames across start/detail/complete/fail, prompt chrome for every §8.10.1 prompt type the renderer draws, a ≤ 40-column narrow-terminal fixture, and the US-456 resize case; the harness runs headless in CI with no PTY.
- [ ] The harness joins the §13.1 "Renderer frames" layer; snapshots are deterministic across repeated runs.
- [ ] Tests pass
- [ ] Typecheck passes
- [ ] Lint passes

### US-458: `RendererCapabilities`, `notify.desktop` SDK surface, foreground renderer realization, and HostProxy union cleanup

**Description:** As an SDK consumer, the complete renderer capability surface and the notification event/config are typed contract surface; as a user on a supporting terminal (including over SSH), a `notify.desktop` event raises a real desktop notification from the **foreground** command that published it — there is no container-initiated notification/clipboard path in 4.0, and the accidental `HostProxyRequest` verbs that briefly implied one are deleted.

**Acceptance Criteria:**

- [ ] This story owns publishing and wiring the **complete** `RendererCapabilities` struct — all four fields (`color`, `interactive`, `animation`, `notifications`), not `notifications` alone — from `@lando/sdk`, and owns every renderer implementation computing it correctly per the §8.9 default/false table: the default renderer's TTY, substrate-initialized path before/after the async probe resolves (initial snapshot `interactive`/`animation` `true`, `color`/`notifications` `false`; a promoted snapshot may flip `color`/`notifications` `false → true`, never demoting), the default renderer degraded, non-TTY, `--renderer=plain`, `--renderer=json`, and `--renderer=verbose` — explicitly `{ color: true, interactive: false, animation: false, notifications: false }` on a TTY and all false on a non-TTY — and any third-party renderer (computes the same four fields against its own substrate, with no shared internal shape to conform to). `Renderer.capabilities` is a getter returning one of at most two immutable snapshot objects per run (initial, then at most one monotonic promotion at probe resolution); it is never mutated in place and the promotion never demotes a field. `NotifyDesktopEvent` (`{ title, body?, urgency? }`, `title` 1..256 chars, `body` optional up to 4096 chars) and the `NotifyConfig` schema are also exported from `@lando/sdk`. Raw OpenTUI terminal capability probing stays an internal `@lando/renderer-lando` detail and is never published from `@lando/sdk`. `RendererCapabilities`/`NotifyDesktopEvent`/`NotifyConfig` are additive, recorded in `sdk/API_COMPATIBILITY.md`, and the schema snapshot is refreshed with `git diff --exit-code` clean — asserted by a test matrix covering every run shape in the §8.9 table (including both `verbose` rows) on all bundled renderer ids, plus a fake-clock test proving delayed-success, timeout, and no-response probe outcomes each resolve to the correct permanent/promoted snapshot without a real wall-clock wait, and a test proving a `notify.desktop` event evaluated against the initial (pre-promotion) snapshot is dropped rather than buffered for replay after promotion.
- [ ] Every `cli-<canonical-id>-init`/`-run`/`-error` payload carries `CommandInvocationCorrelation`: a fresh `invocationId` and optional `parentInvocationId`, with one stable pair shared across an invocation's lifecycle triplet. Only the parentless outer invocation resolved from user/embedding-host argv is notification-eligible; nested `command:` invocations receive their own id plus the enclosing id as parent and still publish their normal lifecycle events to exact and `cli-command-terminal` subscribers, but never independently drive foreground notification presentation.
- [ ] When `renderer.capabilities.notifications` is `true`, and only then, the default renderer calls the verified OpenTUI 0.4.3 `triggerNotification(body ?? title, body === undefined ? undefined : title)` directly — Lando does not hand-frame OSC 9/777 or select a notification protocol; OpenTUI owns protocol selection, tmux/multiplexer handling, and output routing. When the capability is `false`, `triggerNotification` is never called and the event is dropped silently. `json` passes the event through as a structured stderr event regardless of capability; `plain`/non-TTY drop it.
- [ ] Title and body are redacted at the publisher boundary (§3.7), asserted by a secret-bearing fixture, and the renderer applies its fixed sanitizer (CR/LF/TAB → space, strip C0/C1/`ESC`/`BEL`/`DEL`, strip bidi-override characters, NFC-normalize) before calling `triggerNotification`; an empty sanitized title suppresses the call entirely (with or without a body); a title/body exceeding the schema's 256/4096-character bound fails `NotifyDesktopEvent` decode before publication.
- [ ] The current, unreleased `HostProxyRequest` union carries an accidental `notify`/`clipboardCopy` pair left over from an earlier draft of this same patch; this story deletes both variants — plus any dispatcher handling, allowlist entries, and contract-suite tests that assumed them — leaving `HostProxyRequest`'s tagged union with exactly four members: `openUrl`, `openPath`, `runLando`, `runBun`. Nothing is deprecated, aliased, or shimmed — since nothing has shipped, the two accidental variants are simply removed. Asserted by a schema-surface test confirming the union's exact membership.
- [ ] Tests pass
- [ ] Typecheck passes
- [ ] Lint passes

### US-459: The `@lando/notify-lando` bundled policy plugin

**Description:** As a user who kicked off a long rebuild and switched windows, I get one desktop notification when it finishes or fails — and I can turn the whole thing off.

**Acceptance Criteria:**

- [ ] A new bundled `@lando/notify-lando` workspace plugin contributes its subscriber through the §11.3.1/§9.5 schema-derived `SubscriberManifestEntry` (`id`, `selectors: [{ family: "cli-command-terminal" }]` decoding against the `SubscriberSelector` Effect Schema union, `module`, explicit `priority: 900` in the allowed plugin `default` band `100..999`, default `abortOnError`, and `configKey: notify`) whose default-export `SubscriberFactory<NotifyConfig>` factory receives `LandoPluginContext` **and only** the already-decoded `NotifyConfig` projected by the loader (never the full `GlobalConfig`), and publishes exactly one `notify.desktop` per qualifying run through `ctx.events.publishRender` — never a raw `EventService` — for the parentless outer foreground invocation in the resolved eligible family (default family unioned with `notify.commands`, deduplicated, registry-validated against the cwd-independent global built-in/global-plugin command registry per §7.5) whose wall-clock `durationMs` is `>= notify.thresholdMs` (default 15000, unified eligibility rule), `urgency: "success"` on completion and `"failure"` on tagged failure. MCP tool dispatch is the production Beta 1 producer of nested canonical invocations, proving the suppression rule below. Nested invocations remain published to lifecycle subscribers but are never notification-eligible.
- [ ] The CLI terminal lifecycle events consumed by the subscriber carry `invocationId` and optional `parentInvocationId`, stable across each invocation's `init`/`run`/`error` triplet. The subscriber accepts only a terminal event with no `parentInvocationId` as the outer foreground candidate; nested terminal events (produced in Beta 1 primarily by MCP tool dispatch) still publish and reach subscribers normally but are ignored for notification eligibility.
- [ ] Global config `notify:` (`enabled` default `true`, `thresholdMs` bounded `0..3_600_000`, `commands` additive allowlist deduplicated against the default family) decodes against the published `NotifyConfig` schema; `notify.enabled: false` and disabling the plugin both silence the surface; `thresholdMs: 0` qualifies every eligible completed command; `notify` is asserted as the only `PublishedGlobalConfigKey` in Beta 1.
- [ ] Non-TTY/CI runs never notify (capability gating at the renderer; the plugin remains presentation-agnostic).
- [ ] The subscriber's selector semantics are validated once, at the end of plugin registration, after the command registry is complete: exact selectors must belong to the closed built-in `LandoEvent` taxonomy plus generated canonical-command lifecycle names (`PluginManifestError` otherwise), plugins cannot register arbitrary events, and `cli-command-terminal` expands to the `run`/`error` pair for every canonical command. A test asserts that the subscriber's expanded event set is empty/absent until registration finishes and correct immediately after, never partially populated mid-registration (§11.3.1's two-phase timing).
- [ ] `SubscriberManifestEntry`, `SubscriberSelector`, `PublishedGlobalConfigKey`, and `SubscriberFactory` are exported from `@lando/sdk`, recorded in `sdk/API_COMPATIBILITY.md`, and (for the schema-derived exports) schema-snapshot-tracked; this story owns that publication, not just the plugin consuming it.
- [ ] The plugin appears in the §1.4 reference bundle and the generated bundled-plugin tables (`bun run codegen` clean); `bun install` resolves the new workspace package; this plugin doubles as the reference example for the §11.3.1/§9.5 subscriber-factory and `configKey` contribution surfaces.
- [ ] Tests pass
- [ ] Typecheck passes
- [ ] Lint passes

### US-460: Contract-only freeze of the 4.1 renderer surfaces

**Description:** As a plugin author targeting 4.0, the panel-slot, keymap, and rich-render-event schemas are frozen, snapshot-tracked SDK surface I can build against — while the interactive log viewer's contract is frozen as spec-frozen prose only, with no schema of its own — even though core renders none of these until 4.1.

**Acceptance Criteria:**

- [ ] The authoritative additive SDK inventory from §16.2 is exported from its documented subpaths with JSDoc/TSDoc and inferred schema types: `@lando/sdk/renderer` adds `RendererCapabilities`, `RendererPanelSlot`, `RendererPanelId`, `RendererPanelWatch`, `RendererPanelManifestEntry`, `RendererPanelSize`, `RendererPanelContext`, `RendererPanel`, `StyledSpanTone`, `StyledSpan`, `PanelView`, `RendererActionId`, `RendererKeyName`, `RendererKeyChordPattern`, `RendererKeyChord`, `RendererKeyBinding`, and `KeymapConfig`; `@lando/sdk/events` adds `RenderEvent`, `CodeSnippetEvent`, `DiffRenderEvent`, `MarkdownBlockEvent`, `NotifyDesktopEvent`, `CommandInvocationCorrelation`, and the closed `LandoEvent` union; `@lando/sdk/schema` adds `NotifyConfig`, `SubscriberManifestEntry`, `SubscriberSelector`, `PublishedGlobalConfigKey`, and the canonical renderer/event schema exports; `@lando/sdk/plugins` adds `SubscriberFactory`, `PluginManifest.rendererPanels`, `PluginManifest.subscribers`, and `LandoPluginContext.events.publishRender` restricted to the closed `RenderEvent` union; `@lando/sdk/errors` adds the public schema-backed `KeymapConflictError`, while existing `PluginManifestError`, `PluginLoadError`, and `ConfigError` own panel/selector/notify failures with no panel-, selector-, or notify-specific replacements. `sdk/API_COMPATIBILITY.md` records named exports plus the manifest/context additions, backward-compatibility import tests cover them, every schema-backed value (including `CommandInvocationCorrelation` and `KeymapConflictError`) is in the generated schema snapshot, and `bun run codegen:schema-snapshot` leaves a clean diff. The §8.9.8 interactive log viewer remains prose-only and absent from both inventories. The separate `RemoteSource`/`Dataset` Beta-1 freeze remains contract-only, never syncs application code, and stays a 4.1 implementation.
- [ ] The plugin manifest schema accepts `rendererPanels:` entries (`id`, `slot`, `watch`, `module`) decoded against `RendererPanelManifestEntry`, including the frozen 4.0 slot vocabulary (`status-bar`, `task-tree:footer`, `doctor:summary`), the `RendererPanelId` pattern, and a unique 1..32-entry `RendererPanelWatch`. Manifest shape/id/slot/path validation and, after all plugins register, `watch` membership validation occur without importing panel code; the closed registry is exactly the built-in `LandoEvent` taxonomy plus generated `cli-<canonical-id>-{init,run,error}` lifecycle names, and plugins cannot register arbitrary events. Every malformed entry, duplicate plugin-local id, unknown slot/event, or escaping module path is `PluginManifestError`. A never-visible slot never imports its panel. On first visibility the host starts one persistent isolated worker with only the validated module URL and manifest id; the host never imports/evaluates/inspects the module, the worker alone imports it, validates the default export and id, and returns the decoded id during a 1000ms ready handshake before registration or rendering. Import/export/load/id failure or mismatch is `PluginLoadError`; only that worker is terminated and panel dropped.
- [ ] `KeymapConfig` is exported as a plain struct (no root-level `Schema.filter`, per the SDK schema-snapshot rule against filtering exported snapshotted structs); every per-value schema failure — malformed chord/case, unknown key name, literal punctuation, reserved `ctrl+c`, duplicate chord, or out-of-range cardinality — is ordinary `ConfigError` with the offending path and schema diagnostic. Same-surface chord-conflict detection is a separate config-boundary validation step, run once after a successful `KeymapConfig` decode, that raises the public schema-backed `KeymapConflictError`; a well-formed colliding config decodes first and fails only there, while cross-surface chord reuse passes. `RendererPanelWatch` similarly stays schema-checkable on shape/uniqueness alone; known-event membership belongs to plugin-loader validation, not the exported schema.
- [ ] The §13.1 "Renderer panel contract" suite ships from `@lando/sdk/test` as a standalone reference harness, deliberately absent from the §4.2 six-abstraction `plugin-abstraction-coverage.test.ts` manifest. At first fixture-slot visibility it starts a persistent isolated worker, and only that worker imports the module; the decoded id must return in the 1000ms ready handshake. Host/worker IPC uses transferable binary frames capped at 65,542 bytes per complete request (65,536-byte payload) and 5,129 bytes per encoded response. Each post-ready render round trip, including transfer and decode, has an 8ms wall-clock deadline. Any load/id/decode/limit/timeout/throw/worker failure terminates and permanently drops only that panel; timeout preserves its last-good `PanelView`, invalid output is never clipped/truncated, and the fixture covers purity, determinism, the 8-row/32-span/4096-text-byte bounds, and last-good/coalescing behavior. It is never an in-process synchronous call.
- [ ] Every 4.0 renderer honors the plain-text fallback matrix for the rich render events (`code.snippet`/`diff.render`/`markdown.block` emit verbatim content in TTY/plain/non-TTY; `json` passes events through), asserted against the bundled renderers; `startLine`/`highlightLines` decode only positive integers.
- [ ] No 4.0 implementation ships for: rich TTY presentation, panel rendering, keymap remapping / the `keymap:` global-config key, the `keymap.help` (`question-mark`) overlay, or the interactive log viewer — each is documented as landing in 4.1 (ROADMAP Phase 9), and `app:logs --follow` behavior is unchanged in 4.0 apart from the reserved `--no-viewer` flag being accepted as a no-op; the §8.9.8 log-viewer contract is spec-frozen prose only and adds no schema to the §13.2 snapshot.
- [ ] Tests pass
- [ ] Typecheck passes
- [ ] Lint passes

## Non-Goals

- Implementing panel-slot rendering, keymap remapping, the bindings overlay, rich render-event presentation, rich-event core emitters, or the interactive log viewer — all 4.1 (ROADMAP Phase 9).
- New prompt types, `InteractionService` changes, or mid-build prompting (unchanged §8.10 non-goals).
- Changing render-event semantics for pre-existing events, or the machine-output contract (`json`/`plain`/non-TTY output stays byte-stable except where a story explicitly asserts equivalence). This does **not** forbid the intentional, additive `Renderer`-surface changes this PRD itself specifies — the complete four-field `RendererCapabilities` contract and the new render events/panel/keymap contract-only exports are in scope by design; what stays out of scope is any *other*, unplanned change to the `Renderer` interface or existing event payloads. Raw OpenTUI terminal capability probing is never promoted to public SDK surface by this PRD — it stays an internal `@lando/renderer-lando` implementation detail.
- A generic notification service or OS-native notification backends (`osascript`, `notify-send`); OpenTUI's `triggerNotification` path is the only 4.0 presentation, and Lando never hand-frames the underlying escape sequence.
- **Container-initiated terminal notification and clipboard relay through `HostProxyService`.** A container process already attached to a PTY can use terminal protocols directly without any host round-trip; a container process with no PTY has no terminal for a host-side response to write to either. No detached-worker notification/clipboard broker ships in 4.0, and none is planned — see §10.10.2's non-goal statement.
- Adopting `@opentui/react`/`@opentui/solid` or alternate-screen-first rendering.
- Implementing the §8.5.2.1 tooling `command:` step compiler/executor — a frozen producer contract governed by the same nested-invocation correlation rules, independently scoped from this PRD; US-459 proves nested correlation and notification suppression through the existing `meta:mcp` dispatch of registered canonical command programs.

## Technical Considerations

- The split-footer migration is the riskiest story: it must preserve the §8.9.1 hand-off from the pre-renderer banner, the §8.9.2 state machine, Ctrl+C routing from inside the live region, and the non-TTY line mode (which doubles as the degradation path). Land it behind the frame-snapshot harness (US-457 can start first).
- OpenTUI 0.3.0 changed custom-stream routing (`NativeSpanFeed`) and 0.4.x changed `Renderable.remove` semantics to identity-based child management; the current prompt driver's structural typing already compiles against 0.4.3 (verified at the dependency bump), but the new live-region code should use identity-based child APIs from the start.
- Frame snapshots must normalize timing-dependent affordances (spinner glyph phase) before comparison, or pin the substrate's clock via its test renderer controls.
- `@lando/notify-lando` is the first real consumer of the newly frozen §11.3.1/§9.5 `subscribers:` manifest surface (`id`/`selectors`/`module`/`priority`/`abortOnError`, the `cli-command-terminal` family selector, and lazy-loaded/cached `SubscriberFactory` invocation) — this story owns implementing that plugin-loader machinery, not just consuming an already-built one, plus a config schema and docs; it stays small enough to double as the reference example for event-subscriber plugins once built.

## Success Metrics

- `plugins/renderer-lando` contains no hand-rolled cursor-rewind repaint path for the TTY tree; the substrate owns the live region.
- Every §8.9.3 MUST is covered by a test or boundary gate; the §13.1 "Renderer frames" layer runs in CI headless.
- A 20-second `lando start` on a supporting terminal raises exactly one desktop notification; `notify.enabled: false` raises zero.
- The 4.1 renderer surfaces are buildable-against today: a fixture plugin with a `rendererPanels:` contribution validates, loads nothing at runtime, and passes the panel contract suite.
- Every compiled release target's binary passes its relocated PTY smoke test with exactly one matching OpenTUI native package embedded.

## Functional Requirements

- **Substrate contract (§8.9.3).** `@lando/renderer-lando` runs its TTY path on `@opentui/core` `^0.4.3`, dynamically imported in production code only (statically importable from test files), never loaded outside TTY/interactive runs, and degrades to line mode with a debug notice on init failure without failing the command or touching `json`/`plain` output.
- **Split-footer live region (§8.9.3).** The task tree, passthrough scrollback, resize handling, and the alt-screen expand/collapse all move onto the substrate's split-footer mode, replacing the hand-rolled repaint painter, with animation bounded to on-screen affordances at ≤ 30 fps.
- **Capability surface (§8.9).** `RendererCapabilities` — the sole public, renderer-neutral capability schema — is schema-derived, owned by the resolved `Renderer`, and computes exact `false` defaults for degraded/non-TTY/`plain`/`json` runs and probed values only when the substrate is TTY-initialized; raw OpenTUI terminal capability probing stays an internal `@lando/renderer-lando` detail, never published from `@lando/sdk`.
- **Desktop notifications (§8.9.7).** `notify.desktop` + `NotifyConfig` ship as SDK surface with unified `durationMs >= thresholdMs` eligibility, realized exactly one way: the foreground renderer calling OpenTUI's `triggerNotification` directly for self-triggered notifications, gated on `renderer.capabilities.notifications` and the renderer's fixed sanitizer. There is no container-initiated variant (§10.10.2 non-goal).
- **Subscriber manifest/context (§11.3.1, §9.5).** `@lando/notify-lando`'s subscriber is the reference invocation of the frozen bounded-selector manifest shape and the `LandoPluginContext.events.publishRender` seam.
- **Contract-only 4.1 freeze (§8.9.4–§8.9.6, §8.9.8, §9.5).** Rich render events, renderer panel slots (schema-derived `RendererPanelSlot`/`StyledSpan`/`PanelView`, the standalone reference contract suite, and the non-blocking 4.1 runtime obligation), the fully frozen keymap action/chord/conflict vocabulary, and the spec-frozen (non-schema) log viewer all ship as buildable-against contract with zero 4.0 rendering.
- **Compiled native packaging (§17.3.1).** `scripts/build-compiled-binary.ts`'s `onResolve` build plugin prunes 7 of the 8 catalog `@opentui/core-*` native-package roots to generated throwing stubs and lets the one root matching each release target resolve normally, embedding exactly that one native asset with no sidecars, verified by a relocated per-target PTY smoke test.

## Guide Coverage

| Surface | Guide | Status |
| --- | --- | --- |
| OpenTUI substrate, split-footer live region, degradation (US-455, US-456) | `docs/guides/cli/terminal-ui-polish.mdx` | Update when US-455/US-456 land |
| Desktop notifications, foreground renderer realization (US-458) | `docs/guides/cli/terminal-ui-polish.mdx` | Update when US-458 lands |
| Desktop notification policy and `notify:` configuration (US-459) | `docs/guides/cli/terminal-ui-polish.mdx` | Update when US-459 lands |
| Prompt chrome + frame-snapshot harness (US-457) | `docs/guides/cli/interactive-prompts.mdx` | Update when US-457 lands |
| Frame-snapshot / visual-QA coverage (US-457) | `docs/guides/contributing/terminal-renderer-visual-qa.mdx` | Update when US-457 lands |
| Contract-only 4.1 freeze (US-460) | — | No guide impact; nothing renders in 4.0 |

There is no host-proxy guide row: `HostProxyService` (§10.10) gains no new surface from this PRD — `notify`/`clipboardCopy` container-initiated relay is explicitly out of scope (see Non-Goals) — so `docs/guides/subsystems/host-proxy.mdx` is unaffected.

Guide bodies are not edited by this PRD — they update when their owning story actually lands its implementation, per the existing PRD-14 precedent (`spec/beta-1/prd-beta-1-14-residual-hardening.md`'s "## Guide Coverage" section).

## Open Questions

None. The following were raised during review and are resolved here rather than left open:

- **Should container-initiated `notify`/`clipboardCopy` route through `HostProxyService`, and if so, how does a detached worker with no terminal realize them?** Resolved: it doesn't. A container process with a PTY already attached can emit terminal protocols directly without any host round-trip; a container process with no PTY has no terminal for a host-side response to write to either — so a cooperative host-decides relay would not be a real security boundary in either case. `HostProxyRequest` carries no `notify`/`clipboardCopy` verb, and this is deferred/unsupported for 4.0 rather than half-built around a broker that cannot actually own a terminal.
- **Does Lando hand-frame the OSC escape sequence for desktop notifications?** Resolved: no. The foreground renderer sanitizes (`title`/`body`) and then calls the verified OpenTUI 0.4.3 `renderer.triggerNotification(body ?? title, body === undefined ? undefined : title)` API directly; OpenTUI owns protocol selection (OSC 9/777 or otherwise), tmux/multiplexer handling, and output routing — there is no Lando-owned framing/encoder module.
- **Is the renderer-panel contract one of the six §4.2 plugin-abstraction kit suites?** Resolved: no. It is a standalone §13.1 shared-contract-suite row, deliberately absent from `plugin-abstraction-coverage.test.ts`.
- **Does the interactive log viewer need a schema-snapshot entry now?** Resolved: no — §8.9.8 is spec-frozen prose only; it introduces no schema and is out of scope for `codegen:schema-snapshot`.
- **How does the 4.0 panel contract suite prove an 8ms timeout without a runtime that can actually interrupt a hang?** Resolved: when the fixture slot first becomes visible, the harness starts a real, terminable persistent per-panel `Worker`; only that worker imports the module and its decoded id must pass the separate 1000ms ready handshake before post-ready render requests use the 8ms round-trip deadline. It is never an in-process synchronous call, which could not interrupt a hang.
