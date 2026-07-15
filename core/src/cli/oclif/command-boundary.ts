import { Effect, Layer, type Schema } from "effect";

import type { RendererMode } from "../bug-report.ts";
import { formatBugReport } from "../bug-report.ts";
import { validateCommandFlagValues } from "../flag-value-validation.ts";
import type { ResultFormat } from "../format-flags.ts";
import { runWithRendererHandling } from "../renderer-boundary.ts";

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
  await runWithRendererHandling(Effect.fail(error), {
    runtime: Layer.empty,
    rendererMode: input.rendererMode,
    resultFormat: input.resultFormat,
    command: input.commandId,
    resultSchema: input.resultSchema,
    ...(input.deprecationWarnings === undefined ? {} : { deprecationWarnings: input.deprecationWarnings }),
    failureExitCode: () => 2,
    formatError: (failure) =>
      formatBugReport({
        error: failure,
        context: { commandId: input.commandId },
        rendererMode: input.rendererMode,
      }),
  });
  return true;
};
