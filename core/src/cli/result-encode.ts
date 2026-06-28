import { Effect, Schema } from "effect";

import type { CommandWarning, DeprecationUse } from "@lando/sdk/schema";
import { CommandResultEnvelope } from "@lando/sdk/schema";
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

export const encodeCommandResult = (options: EncodeCommandResultOptions): Effect.Effect<string, never> =>
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
    const encoded = Schema.encodeSync(CommandResultEnvelope)(envelope);
    return options.redactor.redactString(JSON.stringify(encoded));
  }).pipe(
    Effect.catchAll(() =>
      Effect.succeed(
        options.redactor.redactString(
          JSON.stringify({
            apiVersion: "v4",
            command: options.command,
            ok: false,
            error: { _tag: "CommandResultEncodeError", message: "Failed to encode command result." },
            warnings: [],
            deprecations: [],
          }),
        ),
      ),
    ),
  );
