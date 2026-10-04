/**
 * Effect Logger glue.
 *
 * Inside Effect, logs flow through `Effect.log*` and `Effect.annotateLogs`.
 * The active logger is an Effect `Logger` provided by a Layer; swapping it
 * changes how lines render.
 *
 * This file builds the Effect `Logger` that `LandoLogger.layer` installs via
 * `Logger.layer`. Diagnostic lines are a side channel, not command UX.
 */
import { Logger as EffectLogger } from "effect";

export type LoggerMode = "pretty" | "silent";

export type DiagnosticLineWriter = (line: string) => void;

export type StderrLoggerOptions = {
  readonly structured: boolean;
  readonly stderrIsTTY: boolean;
  readonly writeLine: DiagnosticLineWriter;
};

/**
 * Build an Effect `Logger.Logger<unknown, unknown>` from a Lando logger
 * mode. The returned logger is wired into the runtime via `Logger.layer`.
 */
export const makeEffectLogger = (mode: LoggerMode = "pretty"): EffectLogger.Logger<unknown, void> =>
  mode === "silent" ? EffectLogger.make(() => {}) : EffectLogger.consolePretty();

/**
 * Diagnostic Effect logger that writes to stderr through a renderer-owned
 * writer. Pretty when stderr is a TTY and structured JSON is not requested;
 * otherwise JSON lines.
 */
export const makeStderrEffectLogger = (options: StderrLoggerOptions): EffectLogger.Logger<unknown, void> => {
  if (!options.structured && options.stderrIsTTY) {
    return EffectLogger.consolePretty();
  }
  return EffectLogger.make((opts) => {
    options.writeLine(EffectLogger.formatJson.log(opts));
  });
};
