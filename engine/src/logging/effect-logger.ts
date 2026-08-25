/**
 * Effect Logger glue.
 *
 * Inside Effect, logs flow through `Effect.log*` and `Effect.annotateLogs`.
 * The active logger is an Effect `Logger` provided by a Layer; swapping it
 * changes how lines render.
 *
 * This file builds the actual Effect `Logger` from the Lando `Logger`
 * service tag (`./service.ts`). It's the bridge between the Lando-level
 * "which logger plugin is selected" decision and Effect's `Logger.replace`
 * Layer that swaps in the chosen implementation.
 *
 */
import { Logger as EffectLogger } from "effect";

export type LoggerMode = "pretty" | "silent";

export type StderrLoggerOptions = {
  readonly structured: boolean;
  readonly stderrIsTTY: boolean;
};

/**
 * Build an Effect `Logger.Logger<unknown, unknown>` from a Lando logger
 * implementation. The returned logger is wired into the runtime via
 * `Logger.replace`.
 *
 */
export const makeEffectLogger = (mode: LoggerMode = "pretty"): EffectLogger.Logger<unknown, void> =>
  mode === "silent" ? EffectLogger.none : EffectLogger.prettyLoggerDefault;

/**
 * Diagnostic Effect logger that writes to stderr. Pretty when stderr is a TTY
 * and structured JSON is not requested; otherwise JSON lines on stderr.
 */
export const makeStderrEffectLogger = (options: StderrLoggerOptions): EffectLogger.Logger<unknown, void> => {
  if (!options.structured && options.stderrIsTTY) {
    return EffectLogger.prettyLogger({ stderr: true });
  }
  return EffectLogger.make((opts) => {
    process.stderr.write(`${EffectLogger.jsonLogger.log(opts)}\n`);
  });
};
