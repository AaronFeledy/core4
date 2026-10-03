import { Predicate, Result, Schema } from "effect";

import { LandofileWriteValidationError } from "@lando/sdk/errors";
import { emitLandofileYamlEither } from "@lando/sdk/landofile";

import { type ValidationIssue, validationIssue, validationIssuesFromCause } from "@lando/sdk/schema";
import { type PathSegment, parsePathSegments, setAtPath, unsetAtPath } from "./dot-path";
import { type ValueType, parseTypedValue } from "./value-parse";

export type { ValueType } from "./value-parse";

const pathRemediation =
  "Use a dot-separated path (`services.web.type`) with `[n]` for array indices (`tooling.test.cmds[0]`).";

export const parseConfigPath = (
  key: string,
  file: string,
): Result.Result<ReadonlyArray<PathSegment>, LandofileWriteValidationError> => {
  const segments = parsePathSegments(key);
  if (segments === undefined) {
    return Result.fail(
      new LandofileWriteValidationError({
        message: `\`${key}\` is not a valid config path.`,
        file,
        path: key,
        issues: [validationIssue([], `Malformed path: \`${key}\``)],
        remediation: pathRemediation,
      }),
    );
  }
  return Result.succeed(segments);
};

export const parseConfigValue = (
  raw: string,
  type: ValueType,
  file: string,
): Result.Result<unknown, LandofileWriteValidationError> => {
  const parsed = parseTypedValue(raw, type);
  if (Result.isFailure(parsed)) {
    return Result.fail(
      new LandofileWriteValidationError({
        message: parsed.failure.message,
        file,
        issues: [validationIssue([], parsed.failure.message)],
        remediation: `Provide a valid \`${type}\` value, or choose a different \`--type\`.`,
      }),
    );
  }
  return Result.succeed(parsed.success);
};

export const decodeIssues = (decoded: Result.Result<unknown, unknown>): readonly ValidationIssue[] => {
  if (Result.isSuccess(decoded)) return [];
  return validationIssuesFromCause(decoded.failure, { fallback: "Invalid config." });
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
): Result.Result<{ readonly next: unknown; readonly value: unknown }, LandofileWriteValidationError> => {
  const pathResult = parseConfigPath(input.key, input.file);
  if (Result.isFailure(pathResult)) return Result.fail(pathResult.failure);
  const valueResult = parseConfigValue(input.raw, input.type, input.file);
  if (Result.isFailure(valueResult)) return Result.fail(valueResult.failure);
  return Result.succeed({
    next: setAtPath(input.tree, input.key, valueResult.success),
    value: valueResult.success,
  });
};

export interface UnsetMutationInput {
  readonly tree: Record<string, unknown>;
  readonly key: string;
  readonly file: string;
}

export const applyUnsetMutation = (
  input: UnsetMutationInput,
): Result.Result<{ readonly next: unknown; readonly changed: boolean }, LandofileWriteValidationError> => {
  const pathResult = parseConfigPath(input.key, input.file);
  if (Result.isFailure(pathResult)) return Result.fail(pathResult.failure);
  return Result.succeed(unsetAtPath(input.tree, input.key));
};

export const writeValidationErrorFromIssues = (input: {
  readonly file: string;
  readonly issues: readonly ValidationIssue[];
  readonly path?: string;
}): LandofileWriteValidationError =>
  new LandofileWriteValidationError({
    message: `The resulting config failed validation for ${input.file}.`,
    file: input.file,
    ...(input.path === undefined ? {} : { path: input.path }),
    issues: input.issues,
    remediation: "Fix the reported issue(s), then retry the write. The file was left unchanged.",
  });

export const emitConfigYaml = (input: {
  readonly file: string;
  readonly value: unknown;
  readonly path?: string;
}): Result.Result<string, LandofileWriteValidationError> => {
  if (!Predicate.isObject(input.value)) {
    return Result.fail(
      writeValidationErrorFromIssues({
        file: input.file,
        issues: [validationIssue([], "The resulting config root must be a YAML map.")],
        ...(input.path === undefined ? {} : { path: input.path }),
      }),
    );
  }
  const emitted = emitLandofileYamlEither(input.value);
  if (Result.isSuccess(emitted)) return Result.succeed(emitted.success);
  return Result.fail(
    writeValidationErrorFromIssues({
      file: input.file,
      issues: [validationIssue([], emitted.failure.message)],
      ...(input.path === undefined ? {} : { path: input.path }),
    }),
  );
};

export const ConfigWriteResultFields = {
  subcommand: Schema.optionalKey(Schema.String),
  key: Schema.optionalKey(Schema.String),
  value: Schema.optionalKey(Schema.Unknown),
  path: Schema.optionalKey(Schema.String),
  changed: Schema.optionalKey(Schema.Boolean),
  dryRun: Schema.optionalKey(Schema.Boolean),
  valid: Schema.optionalKey(Schema.Boolean),
  issues: Schema.optionalKey(Schema.Array(Schema.String)),
  filePath: Schema.optionalKey(Schema.String),
} as const;
