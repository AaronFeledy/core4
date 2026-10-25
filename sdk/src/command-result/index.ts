import { Effect, Schema } from "effect";
import type { ProjectedFailure } from "./failure.ts";
export {
  FailureRoleAnnotation,
  failureOutcomeFromCause,
  commandFailureCause,
  primaryFailureReason,
  type ProjectedFailure,
} from "./failure.ts";

import type { CommandTrace, CommandWarning, DeprecationUse } from "@lando/sdk/schema";
import { CommandResultEnvelope } from "@lando/sdk/schema";
import type { Redactor } from "@lando/sdk/secrets";
import { internalErrorRemediation, taggedErrorJson } from "./diagnostic.ts";
export { internalError, internalErrorRemediation, taggedErrorJson } from "./diagnostic.ts";

import { JsonProjectionError } from "../errors/command.ts";
import { emitYamlDocument } from "../yaml/document.ts";
import { encodeStreamFrame } from "./frames.ts";
import { applyProjectResultKeys } from "./project-result.ts";

export {
  identityRedactor,
  encodeStreamEventFrame,
  encodeStreamStdoutFrame,
  encodeStreamStderrFrame,
  type EncodeStreamEventFrameOptions,
  type EncodeStreamChunkFrameOptions,
} from "./frames.ts";

export { listSelectableResultKeys, projectEncodedResult } from "./project-result.ts";

export type CommandResultOutcome =
  | { readonly _tag: "success"; readonly value: unknown }
  | (ProjectedFailure & { readonly _tag: "failure" });

/** Serializations of the one command result envelope. Stream frames stay JSON. */
export type CommandResultEnvelopeFormat = "json" | "yaml";

export interface EncodeCommandResultOptions {
  readonly command: string;
  readonly resultSchema: Schema.Codec<unknown, unknown>;
  readonly outcome: CommandResultOutcome;
  readonly redactor: Redactor;
  readonly warnings?: ReadonlyArray<CommandWarning>;
  readonly deprecations?: ReadonlyArray<DeprecationUse>;
  readonly projectResultKeys?: readonly string[];
  /** Optional command-invocation timing tree when tracing is enabled. */
  readonly trace?: CommandTrace;
  /** Envelope serialization. Defaults to `json`; the frame encoders ignore it. */
  readonly format?: CommandResultEnvelopeFormat;
}

const encodeResult = (schema: Schema.Codec<unknown, unknown>, value: unknown) =>
  Effect.try({
    try: () => {
      const encoded = Schema.encodeSync(schema)(value as never);
      // Command implementations may carry this private field so the output
      // boundary can redact their data. It is never part of a public result.
      if (
        encoded === null ||
        typeof encoded !== "object" ||
        Array.isArray(encoded) ||
        !Object.hasOwn(encoded, "redactionTokens")
      )
        return encoded;
      const { redactionTokens: _redactionTokens, ...result } = encoded as Record<string, unknown>;
      return result;
    },
    catch: (error) => error,
  });

const isJsonProjectionError = (error: unknown): error is JsonProjectionError =>
  error instanceof JsonProjectionError;

const encodeCommandEnvelope = Effect.fnUntraced(function* (
  options: EncodeCommandResultOptions,
): Effect.fn.Return<unknown, unknown> {
  const base = {
    apiVersion: "v4" as const,
    command: options.command,
    warnings: [...(options.warnings ?? [])],
    deprecations: [...(options.deprecations ?? [])],
    ...(options.trace === undefined ? {} : { trace: options.trace }),
  };
  const envelope =
    options.outcome._tag === "success"
      ? {
          ...base,
          ok: true,
          result: yield* Effect.flatMap(
            encodeResult(options.resultSchema, options.outcome.value),
            (encoded) =>
              Effect.try({
                try: () => applyProjectResultKeys(options.resultSchema, encoded, options.projectResultKeys),
                catch: (error) => error,
              }),
          ),
        }
      : {
          ...base,
          ok: false,
          error: {
            ...taggedErrorJson(options.outcome.error),
            ...(options.outcome.additionalErrors.length
              ? {
                  additionalErrors: options.outcome.additionalErrors.map(({ role, error }) => ({
                    ...taggedErrorJson(error),
                    role,
                  })),
                }
              : {}),
          },
        };
  return Schema.encodeSync(CommandResultEnvelope)(envelope as never);
});

const fallbackEnvelope = (command: string, trace?: CommandTrace): unknown => ({
  apiVersion: "v4",
  command,
  ok: false,
  error: {
    _tag: "CommandResultEncodeError",
    message: "Failed to encode command result.",
    remediation: internalErrorRemediation,
  },
  warnings: [],
  deprecations: [],
  ...(trace === undefined ? {} : { trace }),
});

const encodeJsonLine = (value: unknown, redactor: Redactor): string =>
  redactor.redactString(JSON.stringify(value));

/**
 * Serialize one envelope in the requested format. YAML is emitted from the
 * already-redacted JSON document, so both formats carry the identical model and
 * the identical redaction. `writeResultLine` supplies the trailing newline.
 */
const encodeEnvelopeLine = (
  value: unknown,
  redactor: Redactor,
  format: CommandResultEnvelopeFormat | undefined,
): string => {
  const json = encodeJsonLine(value, redactor);
  if (format !== "yaml") return json;
  const yaml = emitYamlDocument(JSON.parse(json) as unknown);
  return yaml.endsWith("\n") ? yaml.slice(0, -1) : yaml;
};

export const encodeCommandResult = (
  options: EncodeCommandResultOptions,
): Effect.Effect<string, JsonProjectionError> =>
  encodeCommandEnvelope(options).pipe(
    Effect.map((envelope) => encodeEnvelopeLine(envelope, options.redactor, options.format)),
    Effect.catch((error) =>
      isJsonProjectionError(error)
        ? Effect.fail(error)
        : Effect.succeed(
            encodeEnvelopeLine(
              fallbackEnvelope(options.command, options.trace),
              options.redactor,
              options.format,
            ),
          ),
    ),
  );

export function buildCommandResultEnvelope(
  options: EncodeCommandResultOptions & { readonly projectResultKeys?: undefined },
): Effect.Effect<CommandResultEnvelope>;
export function buildCommandResultEnvelope(
  options: EncodeCommandResultOptions,
): Effect.Effect<CommandResultEnvelope, JsonProjectionError>;
export function buildCommandResultEnvelope(
  options: EncodeCommandResultOptions,
): Effect.Effect<CommandResultEnvelope, JsonProjectionError> {
  return encodeCommandEnvelope(options).pipe(
    Effect.map((envelope) => Schema.decodeSync(CommandResultEnvelope)(envelope as never)),
    Effect.catch((error) =>
      isJsonProjectionError(error)
        ? Effect.fail(error)
        : Effect.succeed(
            Schema.decodeSync(CommandResultEnvelope)(
              fallbackEnvelope(options.command, options.trace) as never,
            ),
          ),
    ),
  );
}

export const encodeStreamResultFrame = (
  options: EncodeCommandResultOptions,
): Effect.Effect<string, JsonProjectionError> =>
  encodeCommandEnvelope(options).pipe(
    Effect.flatMap((envelope) => encodeStreamFrame({ _tag: "result", envelope }, options.redactor)),
    Effect.catch((error) =>
      isJsonProjectionError(error)
        ? Effect.fail(error)
        : encodeStreamFrame(
            { _tag: "result", envelope: fallbackEnvelope(options.command, options.trace) },
            options.redactor,
          ),
    ),
  );
