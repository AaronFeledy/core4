import { Effect, Layer, Schema } from "effect";

import type { RendererMode } from "../bug-report.ts";
import { formatBugReport } from "../bug-report.ts";
import { validateCommandFlagValues } from "../flag-value-validation.ts";
import type { ResultFormat } from "../format-flags.ts";
import { runWithRendererHandling } from "../renderer-boundary.ts";
import type { RendererIO } from "../renderer/io.ts";

const EmptyPreCommandResultSchema = Schema.Struct({});

export const extractSpecFlags = (input: unknown): Readonly<Record<string, unknown>> => {
  if (
    typeof input !== "object" ||
    input === null ||
    !("flags" in input) ||
    typeof input.flags !== "object" ||
    input.flags === null ||
    Array.isArray(input.flags)
  )
    return {};
  return Object.fromEntries(Object.entries(input.flags));
};

export const extractSpecParsedArgv = (input: unknown): ReadonlyArray<string> =>
  typeof input === "object" && input !== null && "parsedArgv" in input && Array.isArray(input.parsedArgv)
    ? input.parsedArgv.filter((arg): arg is string => typeof arg === "string")
    : [];

/**
 * User-facing failures that occur before a resolved command lifecycle
 * (pre-parse validation, runtime-layer construction) share this seam:
 * standard machine result envelope or text bug-report, non-zero exit, and
 * deliberately **no** `cli-<id>-init`/`-run`/`-error` lifecycle events.
 */
export interface PreCommandFailureInput {
  readonly commandId: string;
  readonly error: unknown;
  readonly rendererMode: RendererMode;
  readonly resultFormat: ResultFormat;
  readonly resultSchema?: Schema.Schema.AnyNoContext;
  readonly failureExitCode?: number;
  readonly deprecationWarnings?: boolean;
  readonly io?: RendererIO;
  readonly setExitCode?: (code: number) => void;
}

export const renderPreCommandFailure = async (input: PreCommandFailureInput): Promise<void> => {
  const exitCode = input.failureExitCode ?? 1;
  await runWithRendererHandling(Effect.fail(input.error), {
    runtime: Layer.empty,
    rendererMode: input.rendererMode,
    resultFormat: input.resultFormat,
    command: input.commandId,
    resultSchema: input.resultSchema ?? EmptyPreCommandResultSchema,
    ...(input.deprecationWarnings === undefined ? {} : { deprecationWarnings: input.deprecationWarnings }),
    ...(input.io === undefined ? {} : { io: input.io }),
    ...(input.setExitCode === undefined ? {} : { setExitCode: input.setExitCode }),
    failureExitCode: () => exitCode,
    formatError: (failure) =>
      formatBugReport({
        error: failure,
        context: { commandId: input.commandId },
        rendererMode: input.rendererMode,
      }),
  });
};

interface CommandFlagValueValidationInput {
  readonly commandId: string;
  readonly argv: ReadonlyArray<string>;
  readonly definitions: Readonly<Record<string, unknown>>;
  readonly rendererMode: RendererMode;
  readonly resultFormat: ResultFormat;
  readonly resultSchema: Schema.Schema.AnyNoContext;
  readonly deprecationWarnings?: boolean;
}

export const renderCommandFlagValueValidation = async (
  input: CommandFlagValueValidationInput,
): Promise<boolean> => {
  const error = validateCommandFlagValues(input.commandId, input.argv, input.definitions);
  if (error === undefined) return false;
  await renderPreCommandFailure({
    commandId: input.commandId,
    error,
    rendererMode: input.rendererMode,
    resultFormat: input.resultFormat,
    resultSchema: input.resultSchema,
    failureExitCode: 2,
    ...(input.deprecationWarnings === undefined ? {} : { deprecationWarnings: input.deprecationWarnings }),
  });
  return true;
};
