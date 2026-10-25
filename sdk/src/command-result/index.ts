import { Effect, Result, Schema } from "effect";
import type { ProjectedFailure } from "./failure.ts";
export {
  resolveCommandCompletion,
  commandCompletionFromExitCode,
  type CompletedCommandResult,
} from "./completion.ts";
export {
  FailureRoleAnnotation,
  failureOutcomeFromCause,
  commandFailureCause,
  primaryFailureReason,
  type ProjectedFailure,
} from "./failure.ts";

import type { CommandTrace, CommandWarning, DeprecationUse } from "@lando/sdk/schema";
import { CommandResultEnvelope, ValidationIssue } from "@lando/sdk/schema";
import type { Redactor } from "@lando/sdk/secrets";
import { SqlConfirmRequiredError } from "../errors/sql.ts";

import { emitYamlDocument } from "../yaml/document.ts";
import { encodeStreamFrame } from "./frames.ts";
import { isJsonSafe } from "./json-safe.ts";
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

export type CommandResultOutcome<A = unknown> =
  | { readonly _tag: "success"; readonly value: A }
  | (ProjectedFailure & { readonly _tag: "failure"; readonly value?: A });

/** Serializations of the one command result envelope. Stream frames stay JSON. */
export type CommandResultEnvelopeFormat = "json" | "yaml";

export interface EncodeCommandResultOptions {
  readonly command: string;
  readonly resultSchema: Schema.Codec<unknown, unknown>;
  readonly outcome: CommandResultOutcome;
  readonly output?: import("../schema/machine-output.ts").CommandOutput;
  readonly redactor: Redactor;
  readonly warnings?: ReadonlyArray<CommandWarning>;
  readonly deprecations?: ReadonlyArray<DeprecationUse>;
  readonly projectResultKeys?: readonly string[];
  /** Optional command-invocation timing tree when tracing is enabled. */
  readonly trace?: CommandTrace;
  /** Envelope serialization. Defaults to `json`; the frame encoders ignore it. */
  readonly format?: CommandResultEnvelopeFormat;
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
  readonly service?: string;
  readonly steps?: ReadonlyArray<{
    readonly id: string;
    readonly label: string;
    readonly target: string;
    readonly destructive: boolean;
  }>;
  readonly reason?: string;
  readonly issues?: ReadonlyArray<ValidationIssue>;
  readonly [key: string]: unknown;
} => {
  const record = asRecord(error);
  const tag = nonEmptyString(record?._tag) ?? nonEmptyString(record?.name) ?? "UnknownError";
  const message = nonEmptyString(record?.message) ?? String(error);
  const remediation = nonEmptyString(record?.remediation);
  const reason = typeof record?.reason === "string" ? record.reason : undefined;
  const decodedIssues = Schema.decodeUnknownResult(Schema.Array(ValidationIssue))(record?.issues);
  const issues = Result.isSuccess(decodedIssues) ? decodedIssues.success : undefined;
  const reserved = new Set([
    "_tag",
    "name",
    "message",
    "stack",
    "cause",
    "remediation",
    "reason",
    "issues",
    "steps",
    "redactionTokens",
    "additionalErrors",
    "role",
  ]);
  const extra = Object.fromEntries(
    Object.keys(record ?? {}).flatMap((key) => {
      if (reserved.has(key) || record === undefined) return [];
      const descriptor = Object.getOwnPropertyDescriptor(record, key);
      if (descriptor === undefined || !("value" in descriptor) || !isJsonSafe(descriptor.value)) return [];
      if (key === "service" && nonEmptyString(descriptor.value) === undefined) return [];
      return [[key, descriptor.value]];
    }),
  );
  const base = {
    _tag: tag,
    message,
    ...(remediation === undefined ? {} : { remediation }),
    ...(reason === undefined ? {} : { reason }),
    ...(issues === undefined ? {} : { issues }),
  };
  if (error instanceof SqlConfirmRequiredError) {
    return { ...base, service: error.service, steps: error.steps, ...extra };
  }
  return { ...base, ...extra };
};

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

const isJsonProjectionError = (error: unknown): boolean => asRecord(error)?._tag === "JsonProjectionError";

const encodeCommandEnvelope = Effect.fnUntraced(function* (
  options: EncodeCommandResultOptions,
): Effect.fn.Return<unknown, unknown> {
  const base = {
    apiVersion: "v4" as const,
    command: options.command,
    warnings: [...(options.warnings ?? [])],
    deprecations: [...(options.deprecations ?? [])],
    ...(options.trace === undefined ? {} : { trace: options.trace }),
    ...(options.output === undefined ? {} : { output: options.output }),
  };
  const envelope =
    options.outcome._tag === "success"
      ? {
          ...base,
          ok: true,
          result: applyProjectResultKeys(
            options.resultSchema,
            yield* encodeResult(options.resultSchema, options.outcome.value),
            options.projectResultKeys,
          ),
        }
      : {
          ...base,
          ok: false,
          ...(Object.hasOwn(options.outcome, "value")
            ? {
                result: applyProjectResultKeys(
                  options.resultSchema,
                  yield* encodeResult(options.resultSchema, options.outcome.value),
                  options.projectResultKeys,
                ),
              }
            : {}),
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
  error: { _tag: "CommandResultEncodeError", message: "Failed to encode command result." },
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

export const encodeCommandResult = (options: EncodeCommandResultOptions): Effect.Effect<string, never> =>
  encodeCommandEnvelope(options).pipe(
    Effect.map((envelope) => encodeEnvelopeLine(envelope, options.redactor, options.format)),
    Effect.catch((error) =>
      isJsonProjectionError(error)
        ? Effect.die(error)
        : Effect.succeed(
            encodeEnvelopeLine(
              fallbackEnvelope(options.command, options.trace),
              options.redactor,
              options.format,
            ),
          ),
    ),
  );

export const buildCommandResultEnvelope = (
  options: EncodeCommandResultOptions,
): Effect.Effect<CommandResultEnvelope, never> =>
  encodeCommandEnvelope(options).pipe(
    Effect.map((envelope) => Schema.decodeSync(CommandResultEnvelope)(envelope as never)),
    Effect.catch((error) =>
      isJsonProjectionError(error)
        ? Effect.die(error)
        : Effect.succeed(
            Schema.decodeSync(CommandResultEnvelope)(
              fallbackEnvelope(options.command, options.trace) as never,
            ),
          ),
    ),
  );

export const encodeStreamResultFrame = (options: EncodeCommandResultOptions): Effect.Effect<string, never> =>
  encodeCommandEnvelope(options).pipe(
    Effect.flatMap((envelope) => encodeStreamFrame({ _tag: "result", envelope }, options.redactor)),
    Effect.catch((error) =>
      isJsonProjectionError(error)
        ? Effect.die(error)
        : encodeStreamFrame(
            { _tag: "result", envelope: fallbackEnvelope(options.command, options.trace) },
            options.redactor,
          ),
    ),
  );
