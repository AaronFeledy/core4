import { Either, Schema } from "effect";

import { LandofileWriteValidationError } from "@lando/sdk/errors";

import { type PathSegment, parsePathSegments, setAtPath, unsetAtPath } from "./dot-path.ts";
import { type ValueType, parseTypedValue } from "./value-parse.ts";

export type { ValueType } from "./value-parse.ts";

const pathRemediation =
  "Use a dot-separated path (`services.web.type`) with `[n]` for array indices (`tooling.test.cmds[0]`).";

export const parseConfigPath = (
  key: string,
  file: string,
): Either.Either<ReadonlyArray<PathSegment>, LandofileWriteValidationError> => {
  const segments = parsePathSegments(key);
  if (segments === undefined) {
    return Either.left(
      new LandofileWriteValidationError({
        message: `\`${key}\` is not a valid config path.`,
        file,
        path: key,
        issues: [`Malformed path: \`${key}\``],
        remediation: pathRemediation,
      }),
    );
  }
  return Either.right(segments);
};

export const parseConfigValue = (
  raw: string,
  type: ValueType,
  file: string,
): Either.Either<unknown, LandofileWriteValidationError> => {
  const parsed = parseTypedValue(raw, type);
  if (Either.isLeft(parsed)) {
    return Either.left(
      new LandofileWriteValidationError({
        message: parsed.left.message,
        file,
        issues: [parsed.left.message],
        remediation: `Provide a valid \`${type}\` value, or choose a different \`--type\`.`,
      }),
    );
  }
  return Either.right(parsed.right);
};

export const decodeIssues = (decoded: Either.Either<unknown, unknown>): ReadonlyArray<string> => {
  if (Either.isRight(decoded)) return [];
  const cause = decoded.left;
  const rendered = cause instanceof Error ? cause.message : String(cause);
  return rendered
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
};

export interface SetMutationInput {
  readonly tree: Record<string, unknown>;
  readonly key: string;
  readonly raw: string;
  readonly type: ValueType;
  readonly file: string;
}

export const applySetMutation = (
  input: SetMutationInput,
): Either.Either<{ readonly next: unknown; readonly value: unknown }, LandofileWriteValidationError> => {
  const pathResult = parseConfigPath(input.key, input.file);
  if (Either.isLeft(pathResult)) return Either.left(pathResult.left);
  const valueResult = parseConfigValue(input.raw, input.type, input.file);
  if (Either.isLeft(valueResult)) return Either.left(valueResult.left);
  return Either.right({
    next: setAtPath(input.tree, input.key, valueResult.right),
    value: valueResult.right,
  });
};

export interface UnsetMutationInput {
  readonly tree: Record<string, unknown>;
  readonly key: string;
  readonly file: string;
}

export const applyUnsetMutation = (
  input: UnsetMutationInput,
): Either.Either<{ readonly next: unknown; readonly changed: boolean }, LandofileWriteValidationError> => {
  const pathResult = parseConfigPath(input.key, input.file);
  if (Either.isLeft(pathResult)) return Either.left(pathResult.left);
  return Either.right(unsetAtPath(input.tree, input.key));
};

export const writeValidationErrorFromIssues = (input: {
  readonly file: string;
  readonly issues: ReadonlyArray<string>;
  readonly path?: string;
}): LandofileWriteValidationError =>
  new LandofileWriteValidationError({
    message: `The resulting config failed validation for ${input.file}.`,
    file: input.file,
    ...(input.path === undefined ? {} : { path: input.path }),
    issues: input.issues,
    remediation: "Fix the reported issue(s), then retry the write. The file was left unchanged.",
  });

export const ConfigWriteResultFields = {
  subcommand: Schema.optional(Schema.String),
  key: Schema.optional(Schema.String),
  value: Schema.optional(Schema.Unknown),
  path: Schema.optional(Schema.String),
  changed: Schema.optional(Schema.Boolean),
  dryRun: Schema.optional(Schema.Boolean),
  valid: Schema.optional(Schema.Boolean),
  issues: Schema.optional(Schema.Array(Schema.String)),
  filePath: Schema.optional(Schema.String),
} as const;
