import { Effect, Schema } from "effect";

import type { CommandWarning, DeprecationUse } from "@lando/sdk/schema";
import { CommandResultEnvelope, StreamFrame } from "@lando/sdk/schema";
import type { Redactor } from "@lando/sdk/secrets";

export type CommandResultOutcome =
  | { readonly _tag: "success"; readonly value: unknown }
  | { readonly _tag: "failure"; readonly error: unknown };

export interface EncodeCommandResultOptions {
  readonly command: string;
  readonly resultSchema: Schema.Schema.AnyNoContext;
  readonly outcome: CommandResultOutcome;
  readonly redactor: Redactor;
  readonly warnings?: ReadonlyArray<CommandWarning>;
  readonly deprecations?: ReadonlyArray<DeprecationUse>;
}

export interface EncodeStreamEventFrameOptions {
  readonly event: string;
  readonly payload: unknown;
  readonly redactor: Redactor;
}

export interface EncodeStreamChunkFrameOptions {
  readonly chunk: string;
  readonly service?: string;
  readonly source?: string;
  readonly redactor: Redactor;
}

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" ? (value as Record<string, unknown>) : undefined;

const nonEmptyString = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

const taggedErrorJson = (
  error: unknown,
): {
  readonly _tag: string;
  readonly message: string;
  readonly remediation?: string;
} => {
  const record = asRecord(error);
  const tag = nonEmptyString(record?._tag) ?? nonEmptyString(record?.name) ?? "UnknownError";
  const message = nonEmptyString(record?.message) ?? String(error);
  const remediation = nonEmptyString(record?.remediation);
  return remediation === undefined ? { _tag: tag, message } : { _tag: tag, message, remediation };
};

const encodeResult = (schema: Schema.Schema.AnyNoContext, value: unknown) =>
  Effect.try({
    try: () => Schema.encodeSync(schema)(value as never),
    catch: (error) => error,
  });

const encodeCommandEnvelope = (options: EncodeCommandResultOptions): Effect.Effect<unknown, unknown> =>
  Effect.gen(function* () {
    const base = {
      apiVersion: "v4" as const,
      command: options.command,
      warnings: [...(options.warnings ?? [])],
      deprecations: [...(options.deprecations ?? [])],
    };
    const envelope =
      options.outcome._tag === "success"
        ? {
            ...base,
            ok: true,
            result: yield* encodeResult(options.resultSchema, options.outcome.value),
          }
        : {
            ...base,
            ok: false,
            error: taggedErrorJson(options.outcome.error),
          };
    return Schema.encodeSync(CommandResultEnvelope)(envelope as never);
  });

const fallbackEnvelope = (command: string): unknown => ({
  apiVersion: "v4",
  command,
  ok: false,
  error: { _tag: "CommandResultEncodeError", message: "Failed to encode command result." },
  warnings: [],
  deprecations: [],
});

const encodeJsonLine = (value: unknown, redactor: Redactor): string =>
  redactor.redactString(JSON.stringify(value));

/**
 * No-op redactor for synchronous callers that carry no secret-bearing fields
 * (the doctor NDJSON renderers), letting a pure `=> string` helper route result
 * serialization through the encode seam without an Effect RedactionService lookup.
 */
export const identityRedactor: Redactor = {
  redactString: (text: string) => text,
  redactValue: (value: unknown) => value,
};

export const encodeCommandResult = (options: EncodeCommandResultOptions): Effect.Effect<string, never> =>
  encodeCommandEnvelope(options).pipe(
    Effect.map((envelope) => encodeJsonLine(envelope, options.redactor)),
    Effect.catchAll(() =>
      Effect.succeed(encodeJsonLine(fallbackEnvelope(options.command), options.redactor)),
    ),
  );

export const buildCommandResultEnvelope = (
  options: EncodeCommandResultOptions,
): Effect.Effect<CommandResultEnvelope, never> =>
  encodeCommandEnvelope(options).pipe(
    Effect.map((envelope) => Schema.decodeSync(CommandResultEnvelope)(envelope as never)),
    Effect.catchAll(() =>
      Effect.succeed(Schema.decodeSync(CommandResultEnvelope)(fallbackEnvelope(options.command) as never)),
    ),
  );

const encodeStreamFrame = (frame: unknown, redactor: Redactor): Effect.Effect<string, never> =>
  Effect.try({
    try: () => Schema.encodeSync(StreamFrame)(frame as never),
    catch: (error) => error,
  }).pipe(
    Effect.map((encoded) => encodeJsonLine(encoded, redactor)),
    Effect.catchAll(() =>
      Effect.succeed(
        encodeJsonLine(
          {
            _tag: "event",
            event: "stream-frame-encode-error",
            payload: { message: "Failed to encode stream frame." },
          },
          redactor,
        ),
      ),
    ),
  );

export const encodeStreamResultFrame = (options: EncodeCommandResultOptions): Effect.Effect<string, never> =>
  encodeCommandEnvelope(options).pipe(
    Effect.flatMap((envelope) => encodeStreamFrame({ _tag: "result", envelope }, options.redactor)),
    Effect.catchAll(() =>
      encodeStreamFrame({ _tag: "result", envelope: fallbackEnvelope(options.command) }, options.redactor),
    ),
  );

export const encodeStreamEventFrame = (
  options: EncodeStreamEventFrameOptions,
): Effect.Effect<string, never> =>
  encodeStreamFrame({ _tag: "event", event: options.event, payload: options.payload }, options.redactor);

export const encodeStreamStdoutFrame = (
  options: EncodeStreamChunkFrameOptions,
): Effect.Effect<string, never> =>
  encodeStreamFrame(
    {
      _tag: "stdout",
      chunk: options.chunk,
      ...(options.service === undefined ? {} : { service: options.service }),
      ...(options.source === undefined ? {} : { source: options.source }),
    },
    options.redactor,
  );

export const encodeStreamStderrFrame = (
  options: EncodeStreamChunkFrameOptions,
): Effect.Effect<string, never> =>
  encodeStreamFrame(
    {
      _tag: "stderr",
      chunk: options.chunk,
      ...(options.service === undefined ? {} : { service: options.service }),
      ...(options.source === undefined ? {} : { source: options.source }),
    },
    options.redactor,
  );
