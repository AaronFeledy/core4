/**
 * Renderer limitations for Phase 2 Alpha.
 *
 * Alpha intentionally defers parts of the spec §8.9 renderer contract so the
 * Phase 2 Alpha milestone (`spec/ROADMAP.md` Phase 2 "happy path coverage")
 * ships a stable, minimal renderer surface. This module is the single source
 * of truth for the user-facing flags / mode values that touch those deferred
 * features. Every guard MUST raise a tagged `NotImplementedError` with the
 * target-phase remediation, not a silent no-op or a generic
 * `RendererSelectionError`.
 *
 * Deferred features (per §8.9.1 first-paint contract and §8.9.2 concurrent
 * task tree contract):
 *
 *   - `task.detail` streaming tail — the per-task in-memory ring buffer
 *     and dimmed indented panel under each running task line. The
 *     `task.detail` event itself is emitted and rendered in Alpha
 *     (`core/src/cli/renderer/format.ts`); only the ring-buffer / tail
 *     UX is deferred.
 *
 *   - Expand / collapse — TTY input handling that lets the user focus a
 *     task and drop into the alt-screen full-tail view, with the
 *     accompanying `task.detail.expand` / `task.detail.collapse` events
 *     emitted by the renderer.
 *
 *   - Full first-paint contract — spinner threshold, completion-line
 *     latency, skeleton-first tables, and the rest of the §8.9.1
 *     perceived-performance budget. Alpha ships the pre-bootstrap
 *     banner and the renderer Layers; the timing-budget guarantees
 *     land with the §13.1 perf-budget suite in a later phase.
 *
 * The `verbose` renderer mode listed in spec §8.9 is also not shipped in
 * Alpha; that mode rolls in with the broader renderer plugin work, so it
 * is mapped to Phase 3 Beta.
 *
 * Wiring:
 *   - `core/src/cli/renderer-selection.ts` consults this module from
 *     both `extractRendererFlag` (for argv-borne deferred flags) and
 *     `validate` (for deferred mode values from --renderer / env /
 *     global config).
 *   - The thrown `NotImplementedError` propagates through the same
 *     catch blocks in `core/src/cli/run.ts`, `core/src/cli/oclif/
 *     command-base.ts`, and `core/src/cli/oclif/commands/apps/init.ts`
 *     that handle `RendererSelectionError`, so source OCLIF and the
 *     compiled `$bunfs` path stay bit-identical.
 */

import { NotImplementedError } from "@lando/sdk/errors";

export const RENDERER_DEFERRED_SPEC_SECTION = "spec/08-cli-and-tooling.md" as const;

interface DeferredRendererSurface {
  readonly feature: string;
  readonly phase: "Phase 3 Beta" | "Phase 4 RC";
  readonly roadmapDescriptor: string;
  readonly remediation: string;
}

const PHASE_3_BETA_DESCRIPTOR = '"full breadth"';
const PHASE_4_RC_DESCRIPTOR = '"hardening + governance"';

/**
 * Deferred renderer mode values. Passing one of these to `--renderer=`,
 * `LANDO_RENDERER`, or the global `renderer:` config field MUST raise a
 * tagged `NotImplementedError` instead of falling through to the generic
 * `RendererSelectionError` ("Unsupported renderer value") path.
 */
export const DEFERRED_RENDERER_MODES: ReadonlyMap<string, DeferredRendererSurface> = new Map([
  [
    "verbose",
    {
      feature: "renderer mode 'verbose' (full debug output inline with task progress)",
      phase: "Phase 3 Beta",
      roadmapDescriptor: PHASE_3_BETA_DESCRIPTOR,
      remediation:
        "Renderer mode 'verbose' lands in Phase 3 Beta with the broader renderer plugin surface (spec/ROADMAP.md Phase 3 \"full breadth\" and spec/08-cli-and-tooling.md §8.9). Alpha ships `--renderer=lando|json|plain`; use `--renderer=json` for structured NDJSON debugging.",
    },
  ],
]);

/**
 * Deferred renderer-related top-level flags. These are surfaces a user
 * might reach for to control the §8.9.2 task-tree expand/collapse UX or
 * the `task.detail` streaming tail. Alpha intercepts each of them at the
 * top-level pre-parse so the user sees the deferred remediation instead
 * of OCLIF's generic "unknown flag" message or a silent pass-through.
 */
export const DEFERRED_RENDERER_FLAGS: ReadonlyMap<string, DeferredRendererSurface> = new Map(
  (
    [
      ["--expand", "expand"],
      ["--no-expand", "expand"],
      ["--collapse", "collapse"],
      ["--no-collapse", "collapse"],
      ["--tail", "tail"],
      ["--no-tail", "tail"],
    ] as ReadonlyArray<readonly [string, "expand" | "collapse" | "tail"]>
  ).map(([flag, kind]) => {
    if (kind === "tail") {
      return [
        flag,
        {
          feature: "renderer `task.detail` streaming-tail control flag",
          phase: "Phase 4 RC",
          roadmapDescriptor: PHASE_4_RC_DESCRIPTOR,
          remediation:
            'The renderer `task.detail` streaming tail (per-task ring buffer with dimmed indented panel) is deferred to Phase 4 RC (spec/ROADMAP.md Phase 4 "hardening + governance" and spec/08-cli-and-tooling.md §8.9.2). Alpha emits `task.detail` events per line; use `--renderer=json` for structured NDJSON or `--renderer=plain` for line-per-event output.',
        },
      ];
    }
    return [
      flag,
      {
        feature: `renderer task tree ${kind} control flag`,
        phase: "Phase 4 RC",
        roadmapDescriptor: PHASE_4_RC_DESCRIPTOR,
        remediation:
          'Renderer task-tree expand/collapse (interactive TTY input with the alt-screen full-tail view and `task.detail.expand` / `task.detail.collapse` events) is deferred to Phase 4 RC (spec/ROADMAP.md Phase 4 "hardening + governance" and spec/08-cli-and-tooling.md §8.9.2). Alpha does not provide TTY input handling for the task tree; use `--renderer=json` for structured NDJSON or `--renderer=plain` for non-interactive output.',
      },
    ];
  }) as ReadonlyArray<readonly [string, DeferredRendererSurface]>,
);

const surfaceMessage = (surface: DeferredRendererSurface, prefix: string): string =>
  `${prefix}: ${surface.feature} is deferred to ${surface.phase}.`;

/**
 * Build a tagged `NotImplementedError` for a deferred renderer mode value
 * (e.g. `--renderer=verbose`, `LANDO_RENDERER=verbose`, global config
 * `renderer: verbose`). The error carries the canonical
 * `cli:renderer-selection` command id so the bug-report formatter prints
 * `commandId: cli:renderer-selection` on the diagnostic block.
 */
export const deferredRendererModeError = (
  value: string,
  source: "flag" | "env" | "config",
): NotImplementedError => {
  const surface = DEFERRED_RENDERER_MODES.get(value);
  if (surface === undefined) {
    throw new Error(`renderer-deferred: no deferred surface registered for mode "${value}"`);
  }
  const prefix = `Renderer mode "${value}" from ${source}`;
  return new NotImplementedError({
    message: surfaceMessage(surface, prefix),
    commandId: "cli:renderer-selection",
    specSection: RENDERER_DEFERRED_SPEC_SECTION,
    remediation: surface.remediation,
  });
};

/**
 * Build a tagged `NotImplementedError` for a deferred renderer-related
 * top-level flag (e.g. `--no-expand`, `--collapse`, `--tail`).
 */
export const deferredRendererFlagError = (flag: string): NotImplementedError => {
  const surface = DEFERRED_RENDERER_FLAGS.get(flag);
  if (surface === undefined) {
    throw new Error(`renderer-deferred: no deferred surface registered for flag "${flag}"`);
  }
  const prefix = `Renderer flag ${flag}`;
  return new NotImplementedError({
    message: surfaceMessage(surface, prefix),
    commandId: "cli:renderer-selection",
    specSection: RENDERER_DEFERRED_SPEC_SECTION,
    remediation: surface.remediation,
  });
};

/**
 * Scan `argv` for a deferred renderer-related flag. Returns the first
 * deferred flag found before the POSIX `--` argument terminator, or
 * `undefined` if none is present. Tokens after `--` are forwarded
 * verbatim to embedded commands and MUST NOT be intercepted (mirroring
 * `extractRendererFlag`'s `--` handling).
 *
 * The check matches both bare (`--no-expand`) and `--flag=value` forms
 * so users typing `--no-expand=true` still get the deferred remediation.
 */
export const findDeferredRendererFlag = (argv: ReadonlyArray<string>): string | undefined => {
  let afterDoubleDash = false;
  for (const arg of argv) {
    if (arg === undefined) continue;
    if (afterDoubleDash) continue;
    if (arg === "--") {
      afterDoubleDash = true;
      continue;
    }
    if (DEFERRED_RENDERER_FLAGS.has(arg)) return arg;
    const eqIndex = arg.indexOf("=");
    if (eqIndex > 0) {
      const head = arg.slice(0, eqIndex);
      if (DEFERRED_RENDERER_FLAGS.has(head)) return head;
    }
  }
  return undefined;
};

export const isDeferredRendererMode = (value: string): boolean => DEFERRED_RENDERER_MODES.has(value);
