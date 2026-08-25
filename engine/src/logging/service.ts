/**
 * Lando `Logger` service.
 *
 * Diagnostic side channel for Effect.log* / logger.debug|info|warn|error.
 * Command UX stays on Renderer. These pipes do not meet.
 *
 *   - **CLI default:** quiet (`none`) unless `--log-level` / `LANDO_LOG_LEVEL`
 *     / `config.logLevel` is set. Non-`none` levels write to stderr (pretty
 *     on a TTY, JSON when `structured: true` or stderr is not a TTY).
 *   - **Library default:** `silent`.
 *
 * `--debug` raises the floor to `debug`. `--verbose` only changes Renderer.
 */
import { type Context, Effect, Logger as EffectLogger, Layer, LogLevel, Option } from "effect";

import { RedactionService } from "@lando/redaction/service";
import type { LogLevel as DiagnosticLogLevel } from "@lando/sdk/schema";
import type { Redactor } from "@lando/sdk/secrets";
import { Logger } from "@lando/sdk/services";
import {
  type DiagnosticLineWriter,
  type LoggerMode,
  makeEffectLogger,
  makeStderrEffectLogger,
} from "./effect-logger.ts";

export { Logger };
export type { DiagnosticLineWriter, LoggerMode };

export interface LoggerLiveOptions {
  readonly mode?: LoggerMode;
  readonly logLevel?: DiagnosticLogLevel | undefined;
  readonly structured?: boolean;
  readonly writeLine?: DiagnosticLineWriter;
}

const assertNever = (value: never): never => {
  throw new Error(`Unexpected log level: ${String(value)}`);
};

const toEffectLogLevel = (level: Exclude<DiagnosticLogLevel, "none">): LogLevel.LogLevel => {
  switch (level) {
    case "error":
      return LogLevel.Error;
    case "warn":
      return LogLevel.Warning;
    case "info":
      return LogLevel.Info;
    case "debug":
      return LogLevel.Debug;
    case "trace":
      return LogLevel.Trace;
    default:
      return assertNever(level);
  }
};

const redactRecord = (
  redactor: Pick<Redactor, "redactValue">,
  data: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> => {
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    output[key] = redactor.redactValue(value);
  }
  return output;
};

const redactPayload = (
  message: string,
  data: Readonly<Record<string, unknown>> | undefined,
): Effect.Effect<{
  readonly message: string;
  readonly data: Readonly<Record<string, unknown>> | undefined;
}> =>
  Effect.gen(function* () {
    const redaction = yield* Effect.serviceOption(RedactionService);
    return yield* Option.match(redaction, {
      onNone: () => Effect.succeed({ message, data }),
      onSome: (service) =>
        service.forProfile("secrets", { sourceEnv: process.env }).pipe(
          Effect.map((redactor) => ({
            message: redactor.redactString(message),
            data: data === undefined ? undefined : redactRecord(redactor, data),
          })),
        ),
    });
  });

const log = (
  write: (message: string) => Effect.Effect<void>,
  message: string,
  data: Readonly<Record<string, unknown>> | undefined,
): Effect.Effect<void> =>
  redactPayload(message, data).pipe(
    Effect.flatMap((payload) =>
      payload.data === undefined
        ? write(payload.message)
        : Effect.annotateLogs(write(payload.message), payload.data),
    ),
  );

const makeLoggerService = (): Context.Tag.Service<typeof Logger> => ({
  debug: (message, data) => log(Effect.logDebug, message, data),
  info: (message, data) => log(Effect.logInfo, message, data),
  warn: (message, data) => log(Effect.logWarning, message, data),
  error: (message, data) => log(Effect.logError, message, data),
});

const loggerServiceLayer = (): Layer.Layer<Logger> => Layer.succeed(Logger, makeLoggerService());

const noopWriteLine: DiagnosticLineWriter = () => {};

export const LoggerLive = (options: LoggerLiveOptions = {}): Layer.Layer<Logger> => {
  const logLevel = options.logLevel;
  if (logLevel === "none" || (logLevel === undefined && options.mode === "silent")) {
    return Layer.mergeAll(
      loggerServiceLayer(),
      EffectLogger.replace(EffectLogger.defaultLogger, makeEffectLogger("silent")),
    );
  }
  if (logLevel === undefined) {
    return Layer.mergeAll(
      loggerServiceLayer(),
      EffectLogger.replace(EffectLogger.defaultLogger, makeEffectLogger(options.mode ?? "pretty")),
    );
  }
  return Layer.mergeAll(
    loggerServiceLayer(),
    EffectLogger.replace(
      EffectLogger.defaultLogger,
      makeStderrEffectLogger({
        structured: options.structured === true,
        stderrIsTTY: process.stderr.isTTY === true,
        writeLine: options.writeLine ?? noopWriteLine,
      }),
    ),
    EffectLogger.minimumLogLevel(toEffectLogLevel(logLevel)),
  );
};
