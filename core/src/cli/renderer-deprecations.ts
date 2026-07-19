/**
 * Deprecation-warning resolution and end-of-command diagnostics rendering.
 *
 * `resolveCliDeprecationWarnings` strips the `--no-deprecation-warnings` flag and
 * decides whether warnings are enabled; `renderDeprecationDiagnostics` drains the
 * `DeprecationService` summary at command end and emits it through the renderer —
 * as byte-stable `deprecation-used` stream frames for the JSON renderer, or as
 * warn/info messages otherwise.
 */
import { Effect, Option } from "effect";

import type { DeprecationUse } from "@lando/sdk/schema";
import { DeprecationService, Renderer } from "@lando/sdk/services";

import { RedactionService } from "../redaction/service.ts";
import { encodeStreamEventFrame } from "./result-encode.ts";

export interface ResolveCliDeprecationWarningsOptions {
  readonly argv: ReadonlyArray<string>;
  readonly env: Readonly<Record<string, string | undefined>>;
}

export interface ResolveCliDeprecationWarningsResult {
  readonly enabled: boolean;
  readonly remainingArgv: ReadonlyArray<string>;
}

const NO_DEPRECATION_WARNINGS_FLAG = "--no-deprecation-warnings";

export const resolveCliDeprecationWarnings = (
  options: ResolveCliDeprecationWarningsOptions,
): ResolveCliDeprecationWarningsResult => {
  let disabledByFlag = false;
  let afterDoubleDash = false;
  const remainingArgv: string[] = [];
  for (const arg of options.argv) {
    if (afterDoubleDash) {
      remainingArgv.push(arg);
      continue;
    }
    if (arg === "--") {
      afterDoubleDash = true;
      remainingArgv.push(arg);
      continue;
    }
    if (arg === NO_DEPRECATION_WARNINGS_FLAG) {
      disabledByFlag = true;
      continue;
    }
    remainingArgv.push(arg);
  }
  return {
    enabled: !disabledByFlag && options.env.LANDO_DEPRECATION_WARNINGS !== "0",
    remainingArgv,
  };
};

const useCountText = (count: number): string => (count === 1 ? "once" : `${count} times`);

const surfaceLabel = (use: DeprecationUse): string => `${use.kind} ${use.id}`;

const warningText = (entry: DeprecationUse & { readonly count: number }): string => {
  const replacement =
    entry.notice.replacement === undefined ? "" : ` Replacement: ${entry.notice.replacement}.`;
  return `Deprecated ${surfaceLabel(entry)} (used ${useCountText(entry.count)}): ${entry.notice.note}${replacement}`;
};

const infoSummaryText = (entries: ReadonlyArray<DeprecationUse & { readonly count: number }>): string => {
  const surfaces = entries.map(
    (entry) => `${surfaceLabel(entry)} (${entry.count} ${entry.count === 1 ? "use" : "uses"})`,
  );
  return `Deprecated surfaces used: ${surfaces.join(", ")}.`;
};

const jsonDeprecationEventLine = (
  entry: DeprecationUse & { readonly count: number },
): Effect.Effect<string, never, RedactionService> => {
  const { count: _count, ...use } = entry;
  return Effect.gen(function* () {
    const redaction = yield* RedactionService;
    const redactor = yield* redaction.forProfile("secrets", { sourceEnv: process.env });
    return yield* encodeStreamEventFrame({
      event: "deprecation-used",
      payload: { _tag: "deprecation-used", use },
      redactor,
    });
  });
};

type DeprecationServiceShape = typeof DeprecationService.Service;

const optionalDeprecationService = Effect.serviceOption(DeprecationService) as Effect.Effect<
  Option.Option<DeprecationServiceShape>,
  never,
  never
>;

export const renderDeprecationDiagnostics = (
  enabled: boolean,
): Effect.Effect<void, never, Renderer | RedactionService> =>
  Effect.gen(function* () {
    const deprecations = yield* optionalDeprecationService;
    if (Option.isNone(deprecations)) return;
    const renderer = yield* Renderer;
    const summary = yield* deprecations.value.summary();
    if (summary.length === 0) return;

    if (renderer.id === "json") {
      for (const entry of summary) {
        const line = yield* jsonDeprecationEventLine(entry);
        yield* renderer.output.stderr(`${line}\n`);
      }
      return;
    }

    if (enabled) {
      for (const entry of summary) {
        if (entry.notice.severity === "warn") {
          yield* renderer.message.warn(warningText(entry)).pipe(Effect.catchAll(() => Effect.void));
        }
      }
    }

    const infoEntries = summary.filter((entry) => entry.notice.severity === "info");
    if (infoEntries.length > 0) {
      yield* renderer.message.info(infoSummaryText(infoEntries)).pipe(Effect.catchAll(() => Effect.void));
    }
  });
