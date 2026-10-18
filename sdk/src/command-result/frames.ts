import { StreamFrame } from "@lando/sdk/schema";
import type { Redactor } from "@lando/sdk/secrets";
import { Effect, Schema } from "effect";

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

export const identityRedactor: Redactor = {
  redactString: (text) => text,
  redactValue: (value) => value,
};

export const encodeStreamFrame = (frame: unknown, redactor: Redactor): Effect.Effect<string, never> =>
  Effect.try({
    try: () => Schema.encodeUnknownSync(StreamFrame)(frame),
    catch: (error) => error,
  }).pipe(
    Effect.map((encoded) => redactor.redactString(JSON.stringify(encoded))),
    Effect.catch(() =>
      Effect.succeed(
        redactor.redactString(
          JSON.stringify({
            _tag: "event",
            event: "stream-frame-encode-error",
            payload: { message: "Failed to encode stream frame." },
          }),
        ),
      ),
    ),
  );

export const encodeStreamEventFrame = (
  options: EncodeStreamEventFrameOptions,
): Effect.Effect<string, never> =>
  encodeStreamFrame({ _tag: "event", event: options.event, payload: options.payload }, options.redactor);

const encodeStreamChunkFrame = (
  tag: "stdout" | "stderr",
  options: EncodeStreamChunkFrameOptions,
): Effect.Effect<string, never> =>
  encodeStreamFrame(
    {
      _tag: tag,
      chunk: options.redactor.redactString(options.chunk),
      ...(options.service === undefined ? {} : { service: options.redactor.redactString(options.service) }),
      ...(options.source === undefined ? {} : { source: options.redactor.redactString(options.source) }),
    },
    identityRedactor,
  );

export const encodeStreamStdoutFrame = (
  options: EncodeStreamChunkFrameOptions,
): Effect.Effect<string, never> => encodeStreamChunkFrame("stdout", options);

export const encodeStreamStderrFrame = (
  options: EncodeStreamChunkFrameOptions,
): Effect.Effect<string, never> => encodeStreamChunkFrame("stderr", options);
