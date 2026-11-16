import { StreamFrame } from "@lando/sdk/schema";
import type { Redactor } from "@lando/sdk/secrets";
import { Effect, Schema } from "effect";
import { eventFramePolicy, streamFramePolicy } from "./output-policies.ts";
import { encodeRedactedJson } from "./redacted-json.ts";
import type { StructuralRedactionNode } from "./structural-redaction.ts";

export interface EncodeStreamEventFrameOptions {
  readonly event: string;
  readonly payload: unknown;
  readonly redactor: Redactor;
  /**
   * The schema the payload was published with. Real lifecycle events pass the
   * event schema so literal discriminants and declared keys survive redaction;
   * custom payloads leave it out and keep ordinary redaction.
   */
  readonly payloadSchema?: Schema.Top;
}

export interface EncodeStreamChunkFrameOptions {
  readonly chunk: string;
  readonly service?: string;
  readonly source?: string;
  readonly redactor: Redactor;
}

export const identityRedactor: Redactor = {
  redactString: (text) => text,
  redactPrefix: (text) => text,
  redactValue: (value) => value,
};

export const encodeStreamFrame = (
  frame: unknown,
  redactor: Redactor,
  policy: StructuralRedactionNode | undefined = streamFramePolicy,
): Effect.Effect<string, never> =>
  Effect.try({
    try: () => encodeRedactedJson(Schema.encodeUnknownSync(StreamFrame)(frame), redactor, policy),
    catch: (error) => error,
  }).pipe(
    Effect.catch(() =>
      Effect.succeed(
        encodeRedactedJson(
          {
            _tag: "event",
            event: "stream-frame-encode-error",
            payload: { message: "Failed to encode stream frame." },
          },
          redactor,
          streamFramePolicy,
        ),
      ),
    ),
  );

export const encodeStreamEventFrame = (
  options: EncodeStreamEventFrameOptions,
): Effect.Effect<string, never> =>
  encodeStreamFrame(
    { _tag: "event", event: options.event, payload: options.payload },
    options.redactor,
    options.payloadSchema === undefined ? undefined : eventFramePolicy(options.event, options.payloadSchema),
  );

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
