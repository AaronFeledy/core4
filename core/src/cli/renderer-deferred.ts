/**
 * Deferred renderer surfaces.
 *
 * This module is the single source of truth for renderer flags and mode
 * values that are not yet shipped. Guards raise tagged
 * `NotImplementedError` objects so callers see the deferred remediation
 * instead of a silent no-op or a generic `RendererSelectionError`.
 *
 * Deferred surfaces include the `task.detail` tail control flag, expand and
 * collapse controls for the task tree, and the `verbose` renderer mode.
 *
 * Wiring:
 *   - `core/src/cli/renderer-selection.ts` consults this module from
 *     both `extractRendererFlag` and `validate`.
 *   - The thrown `NotImplementedError` follows the same catch blocks in
 *     the CLI entry points that handle `RendererSelectionError`.
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
 * might reach for to control task-tree expand/collapse behavior or the
 * bare `task.detail` streaming-tail toggle. Each is intercepted at the
 * top level so the user sees the deferred remediation instead of OCLIF's
 * generic "unknown flag" message or a silent pass-through.
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
            'The TTY `lando` renderer now shows the fixed Beta 4-line `task.detail` tail. The `--tail` / `--no-tail` control flag is deferred to Phase 4 RC (spec/ROADMAP.md Phase 4 "hardening + governance" and spec/08-cli-and-tooling.md §8.9.2); use `--renderer=json` for structured NDJSON or `--renderer=plain` for line-per-event output.',
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
 * top-level flag (e.g. `--no-expand`, `--collapse`, bare `--tail`).
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
 * verbatim to embedded commands and must not be intercepted.
 *
 * The check matches both bare (`--no-expand`) and `--flag=value` forms so
 * users typing `--no-expand=true` still get the deferred remediation.
 * `--tail` is special: `app:logs` already owns `--tail <N>` / `--tail=N`
 * for finite log snapshots, so only bare boolean `--tail` is treated as the
 * deferred renderer task-detail tail surface.
 */
export const findDeferredRendererFlag = (argv: ReadonlyArray<string>): string | undefined => {
  let afterDoubleDash = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) continue;
    if (afterDoubleDash) continue;
    if (arg === "--") {
      afterDoubleDash = true;
      continue;
    }
    if (arg === "--tail") {
      const next = argv[index + 1];
      if (next !== undefined && !next.startsWith("-")) continue;
    }
    if (DEFERRED_RENDERER_FLAGS.has(arg)) return arg;
    const eqIndex = arg.indexOf("=");
    if (eqIndex > 0) {
      const head = arg.slice(0, eqIndex);
      if (head === "--tail") continue;
      if (DEFERRED_RENDERER_FLAGS.has(head)) return head;
    }
  }
  return undefined;
};

export const isDeferredRendererMode = (value: string): boolean => DEFERRED_RENDERER_MODES.has(value);
