/**
 * Deprecation-warning resolution and end-of-command diagnostics rendering.
 *
 * `resolveCliDeprecationWarnings` strips the `--no-deprecation-warnings` flag and
 * decides whether warnings are enabled. `renderDeprecationDiagnostics` emits deprecation
 * records through the renderer at command end: as byte-stable `deprecation-used`
 * stream frames for the JSON renderer, or as warn/info messages otherwise.
 *
 * The fiber-scoped `DeprecationRecorder` captures invocation-local uses.
 * The CLI boundary provides a fresh recorder around the command effect and reads
 * the records once the command finishes.
 */

import { RedactionService } from "@lando/redaction/service";
import { encodeStreamEventFrame } from "@lando/sdk/command-result";

import { type DeprecationUse, formatDeprecationNotice } from "@lando/sdk/schema";
import {
  DeprecationRecorder,
  DeprecationService,
  type DeprecationSummaryEntry,
  Renderer,
} from "@lando/sdk/services";
import { Effect, Option } from "effect";
import { CliInvocation } from "../runtime/invocation-context";

import { scanLandoFlags } from "./lando-flags";

export interface ResolveCliDeprecationWarningsOptions {
  readonly argv: ReadonlyArray<string>;
  readonly env: Readonly<Record<string, string | undefined>>;
}

export interface ResolveCliDeprecationWarningsResult {
  readonly enabled: boolean;
  readonly remainingArgv: ReadonlyArray<string>;
}

export const resolveCliDeprecationWarnings = (
  options: ResolveCliDeprecationWarningsOptions,
): ResolveCliDeprecationWarningsResult => {
  let disabledByFlag = false;
  const remainingArgv = scanLandoFlags(options.argv, {
    "--no-deprecation-warnings": () => {
      disabledByFlag = true;
    },
  });
  return {
    enabled: !disabledByFlag && options.env.LANDO_DEPRECATION_WARNINGS !== "0",
    remainingArgv,
  };
};

const surfaceLabel = (use: DeprecationUse): string => `${use.kind} ${use.id}`;

const useCountText = (count: number): string => (count === 1 ? "once" : `${count} times`);

const warnTextForEntry = (entry: DeprecationSummaryEntry): string =>
  `${surfaceLabel(entry)} (used ${useCountText(entry.count)}): ${formatDeprecationNotice(entry.notice)}`;

const infoSummaryTextForEntries = (entries: ReadonlyArray<DeprecationSummaryEntry>): string => {
  const surfaces = entries.map(
    (entry) => `${surfaceLabel(entry)} (${entry.count} ${entry.count === 1 ? "use" : "uses"})`,
  );
  return `Deprecated surfaces used: ${surfaces.join(", ")}.`;
};

const jsonDeprecationEventLine = Effect.fnUntraced(function* (
  use: DeprecationUse,
): Effect.fn.Return<string, never, RedactionService> {
  const redaction = yield* RedactionService;
  const redactor = yield* redaction.forProfile("secrets", { sourceEnv: (yield* CliInvocation).env });
  return yield* encodeStreamEventFrame({
    event: "deprecation-used",
    payload: { _tag: "deprecation-used", use },
    redactor,
  });
});

/**
 * End-of-command deprecation diagnostics. The `json` renderer writes one
 * structured record per surface whatever the suppression setting. Human
 * renderers warn once per surface per service-instance lifetime and summarize
 * `info` notices; suppression silences every human line and leaves the
 * claim allowance unspent. `uses` comes from the invocation's recorder; the
 * human warning takes its counts from the recorder's summary and claims each
 * surface with `DeprecationService.claimWarning`.
 */
export const renderDeprecationDiagnostics = Effect.fnUntraced(function* (
  uses: ReadonlyArray<DeprecationUse>,
  enabled: boolean,
): Effect.fn.Return<void, never, Renderer | RedactionService> {
  if (uses.length === 0) return;
  const renderer = yield* Renderer;
  if (renderer.id === "json") {
    for (const use of uses) {
      const line = yield* jsonDeprecationEventLine(use);
      yield* renderer.output.stderr(`${line}\n`);
    }
    return;
  }
  if (!enabled) return;
  const service = yield* Effect.serviceOption(DeprecationService);
  if (Option.isNone(service)) return;
  const deprecations = service.value;
  const recorder = yield* DeprecationRecorder;
  const invocationSummary = yield* recorder.summary();
  const freshEntries: DeprecationSummaryEntry[] = [];
  for (const entry of invocationSummary) {
    const claimed = yield* deprecations.claimWarning(entry.kind, entry.id);
    if (claimed) freshEntries.push(entry);
  }
  for (const entry of freshEntries) {
    if (entry.notice.severity === "warn") {
      yield* renderer.message.warn(warnTextForEntry(entry)).pipe(Effect.catch(() => Effect.void));
    }
  }
  const infoEntries = freshEntries.filter((entry) => entry.notice.severity === "info");
  if (infoEntries.length > 0) {
    yield* renderer.message
      .info(infoSummaryTextForEntries(infoEntries))
      .pipe(Effect.catch(() => Effect.void));
  }
});

/**
 * Collect invocation-scoped deprecation uses from the fiber-scoped recorder.
 * Call after the command effect completes; yields the first-use-per-surface list.
 */
export const collectInvocationDeprecations: Effect.Effect<ReadonlyArray<DeprecationUse>> =
  DeprecationRecorder.pipe(Effect.flatMap((recorder) => recorder.records()));
