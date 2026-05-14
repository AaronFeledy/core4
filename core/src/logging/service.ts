/**
 * Lando `Logger` service.
 *
 * The active logger is selected at bootstrap time:
 *
 *   - **CLI default:** Effect `Logger.pretty` for TTY, `Logger.json` for
 *     non-TTY (TTY/CI auto-detect via `../platform/tty.ts`).
 *   - **Library default:** `silent`.
 *
 * Plugins contribute renderers via `provides.loggers`. Selection by global
 * `logger:` config or `--logger=` flag.
 *
 * **Effect Logger as the logging contract:**
 * Core never calls `console.log` outside the renderer plugin. Inside Effect,
 * logs flow through `Effect.log*` and `Effect.annotateLogs`. The active
 * logger is an Effect `Logger` provided by a Layer; swapping it changes
 * how lines render. Plugins contribute renderers; the active renderer
 * chooses which Effect Logger configuration to install.
 */
import { type Context, Effect, Logger as EffectLogger, Layer } from "effect";

import { Logger } from "@lando/sdk/services";
import { type LoggerMode, makeEffectLogger } from "./effect-logger.ts";

export { Logger };
export type { LoggerMode };

export interface LoggerLiveOptions {
  readonly mode?: LoggerMode;
}

const log = (
  effect: Effect.Effect<void>,
  data: Readonly<Record<string, unknown>> | undefined,
): Effect.Effect<void> => (data === undefined ? effect : Effect.annotateLogs(effect, data));

const makeLoggerService = (): Context.Tag.Service<typeof Logger> => ({
  debug: (message, data) => log(Effect.logDebug(message), data),
  info: (message, data) => log(Effect.logInfo(message), data),
  warn: (message, data) => log(Effect.logWarning(message), data),
  error: (message, data) => log(Effect.logError(message), data),
});

export const LoggerLive = (options: LoggerLiveOptions = {}): Layer.Layer<Logger> =>
  Layer.mergeAll(
    Layer.succeed(Logger, makeLoggerService()),
    EffectLogger.replace(EffectLogger.defaultLogger, makeEffectLogger(options.mode ?? "pretty")),
  );
