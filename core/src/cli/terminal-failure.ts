import * as LandoLogger from "@lando/engine/logging/service";
import { activeLogLevel } from "@lando/engine/runtime/cli-options";
import { type RendererIO, createStdioRendererIO } from "@lando/renderer/io";
import { writeDiagnosticLine, writeResultLine } from "@lando/renderer/output";
import { layerPlainService } from "@lando/renderer/runtime";
import { encodeCommandResult, failureOutcomeFromCause } from "@lando/sdk/command-result";
import type { Redactor } from "@lando/sdk/secrets";
import { Cause, Effect, Schema } from "effect";
import { formatBugReport } from "./bug-report";
import { DEFAULT_RESULT_FORMAT, isEnvelopeResultFormat } from "./format-flags";
import type { RunWithRendererHandlingOptions } from "./renderer-boundary";

export const recordCliDefect = (cause: Cause.Cause<unknown>, redactor: Redactor, io: RendererIO) =>
  Cause.hasDies(cause)
    ? Effect.annotateLogs(Effect.logDebug("Command defect"), {
        cause: redactor.redactString(Cause.pretty(cause)),
      }).pipe(Effect.provide(LandoLogger.layer({
        logLevel: activeLogLevel,
        structured: true,
        writeLine: (line) => io.writeStderr(`${line}\n`),
      })))
    : Effect.void;

export const renderTerminalFailure = async <A, R, RE>(
  cause: Cause.Cause<unknown>,
  options: RunWithRendererHandlingOptions<A, R, RE>,
  redactor: Redactor,
): Promise<void> => {
  const io = options.io ?? createStdioRendererIO();
  const outcome = failureOutcomeFromCause(cause);
  const format = options.resultFormat ?? DEFAULT_RESULT_FORMAT;
  await Effect.runPromise(Effect.gen(function* () {
    yield* recordCliDefect(cause, redactor, io);
    if (isEnvelopeResultFormat(format)) {
      const line = yield* encodeCommandResult({
        command: options.command ?? "cli:unknown",
        resultSchema: Schema.Unknown,
        outcome,
        redactor,
        format,
      });
      yield* writeResultLine(line);
    } else {
      yield* writeDiagnosticLine(formatBugReport({
        ...outcome,
        context: { commandId: options.command ?? "cli:unknown" },
        rendererMode: "plain",
        redactor,
      }));
    }
  }).pipe(Effect.provide(layerPlainService(io))));
  (options.setExitCode ?? ((code) => { process.exitCode = code; }))(1);
};
