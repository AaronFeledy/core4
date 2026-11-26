import * as LandoLogger from "@lando/engine/logging/service";
import { activeLogLevel } from "@lando/engine/runtime/cli-options";
import type { RendererIO } from "@lando/renderer/io";
import { encodeCommandResult, encodeStreamResultFrame } from "@lando/sdk/command-result";
import type { Redactor } from "@lando/sdk/secrets";
import { Cause, Effect, Schema } from "effect";
import { formatBugReport } from "./bug-report";
import { commandFailureOutcome, commandInterruptionExitCode } from "./command-interruption";
import { DEFAULT_RESULT_FORMAT } from "./format-flags";
import { resolveOutputRouting } from "./output-routing";
import type { RunWithRendererHandlingOptions } from "./renderer-boundary";
import { type TerminalDocument, diagnosticLine, resultLine } from "./terminal-document";

export const recordCliDefect = (cause: Cause.Cause<unknown>, redactor: Redactor, io: RendererIO) =>
  Cause.hasDies(cause)
    ? Effect.annotateLogs(Effect.logDebug("Command defect"), {
        cause: redactor.redactString(Cause.pretty(cause)),
      }).pipe(
        Effect.provide(
          LandoLogger.layer({
            logLevel: activeLogLevel,
            structured: true,
            writeLine: (line) => io.writeStderr(`${line}\n`),
          }),
        ),
      )
    : Effect.void;

/**
 * The failure document for a failure outside the run's own planning: a defect
 * in the boundary itself, or a planner that failed before anything was
 * committed. The run's committer writes it.
 */
export const planTerminalFailure = <A, R, RE>(
  cause: Cause.Cause<unknown>,
  options: RunWithRendererHandlingOptions<A, R, RE>,
  redactor: Redactor,
): Effect.Effect<TerminalDocument, unknown> => {
  const outcome = commandFailureOutcome(cause, options.signal);
  const routing = resolveOutputRouting({
    rendererMode: options.rendererMode,
    format: options.resultFormat ?? DEFAULT_RESULT_FORMAT,
    frames: options.streaming !== undefined,
    live: options.streamingMode === "live",
    report: options.ndjsonReport !== undefined,
  });
  const exitCode = Cause.hasInterruptsOnly(cause) ? commandInterruptionExitCode(options.signal) : 1;
  const result = {
    command: options.command ?? "cli:unknown",
    resultSchema: Schema.Unknown,
    outcome,
    redactor,
  };
  switch (routing.stdout) {
    case "envelope":
      return encodeCommandResult({ ...result, format: routing.serialization }).pipe(
        Effect.map((line): TerminalDocument => ({ writes: [resultLine(line)], exitCode })),
      );
    case "frames":
    case "report":
      return encodeStreamResultFrame(result).pipe(
        Effect.map((line): TerminalDocument => ({ writes: [resultLine(line)], exitCode })),
      );
    case "human": {
      const message = formatBugReport({
        ...outcome,
        context: { commandId: options.command ?? "cli:unknown" },
        rendererMode: "plain",
        redactor,
      });
      return Effect.succeed({ writes: [diagnosticLine(message)], exitCode });
    }
    default:
      return routing satisfies never;
  }
};
