import type { RendererIO } from "@lando/renderer/io";
import { Effect, Layer, Schema } from "effect";
import type { CliInvocationContext } from "../../runtime/invocation-context";
import { type RendererMode, formatBugReport } from "../bug-report";
import { type ResultFormat, isEnvelopeResultFormat } from "../format-flags";
import { scanLandoFlags } from "../lando-flags";
import { runWithRendererHandling } from "../renderer-boundary";

const EmptyPreCommandResultSchema = Schema.Struct({});

export { specFlagsOf as extractSpecFlags } from "./input-coercion";

export const extractSpecParsedArgv = (input: unknown): ReadonlyArray<string> => {
  if (typeof input !== "object" || input === null) return [];
  if ("parsedArgv" in input && Array.isArray(input.parsedArgv)) {
    return input.parsedArgv.filter((arg): arg is string => typeof arg === "string");
  }
  return "argv" in input && Array.isArray(input.argv)
    ? input.argv.filter((arg): arg is string => typeof arg === "string")
    : [];
};

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
  readonly resultSchema?: Schema.Codec<unknown, unknown>;
  readonly failureExitCode?: number;
  readonly deprecationWarnings?: boolean;
  readonly io?: RendererIO;
  readonly context?: CliInvocationContext;
  /** A dash argument reserved stdout for the payload, so a machine failure goes to stderr. */
  readonly payloadStdout?: boolean;
  readonly setExitCode?: (code: number) => void;
  /** The CLI was called wrong (unknown command, bad flag): exits 2 and the human report omits log locations. */
  readonly usage?: boolean;
}

export const renderPreCommandFailure = async (input: PreCommandFailureInput): Promise<void> => {
  const exitCode = input.failureExitCode ?? (input.usage === true ? 2 : 1);
  await runWithRendererHandling(Effect.fail(input.error), {
    ...(input.context === undefined ? {} : { context: input.context }),
    runtime: Layer.empty,
    rendererMode: input.rendererMode,
    resultFormat: input.resultFormat,
    command: input.commandId,
    resultSchema: input.resultSchema ?? EmptyPreCommandResultSchema,
    ...(input.deprecationWarnings === undefined ? {} : { deprecationWarnings: input.deprecationWarnings }),
    ...(input.io === undefined ? {} : { io: input.io }),
    ...(input.payloadStdout === true ? { payloadStdout: true } : {}),
    ...(input.setExitCode === undefined ? {} : { setExitCode: input.setExitCode }),
    failureExitCode: () => exitCode,
    formatError: (failure, redactor) =>
      formatBugReport({
        ...failure,
        ...(input.context === undefined ? {} : { sourceEnv: input.context.env }),
        redactor,
        context: { commandId: input.commandId },
        rendererMode: input.rendererMode,
        ...(input.usage === true ? { usage: true } : {}),
      }),
  });
};

export const preCommandOutputMode = (input: {
  readonly argv: ReadonlyArray<string>;
  readonly env: Readonly<Record<string, string | undefined>>;
}): { readonly rendererMode: RendererMode; readonly resultFormat: ResultFormat } => {
  // An explicit --format wins, last spelling first, so a pre-command failure is
  // serialized in the format the user asked for rather than always as JSON.
  let explicitFormat: ResultFormat | undefined;
  let machineRequested = false;
  scanLandoFlags(input.argv, {
    "--format": (match) => {
      const value = match.value;
      if (value !== undefined && isEnvelopeResultFormat(value)) explicitFormat = value;
    },
    "--json": () => {
      machineRequested = true;
    },
    "-j": () => {
      machineRequested = true;
    },
    "--jq": () => {
      machineRequested = true;
    },
    "--renderer": (match) => {
      if (match.value === "json") machineRequested = true;
    },
  });
  if (explicitFormat !== undefined) return { rendererMode: "json", resultFormat: explicitFormat };
  if (machineRequested || input.env.LANDO_RENDERER === "json") {
    return { rendererMode: "json", resultFormat: "json" };
  }
  return { rendererMode: "plain", resultFormat: "text" };
};
