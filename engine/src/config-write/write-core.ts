import { LandofileWriteValidationError } from "@lando/sdk/errors";
import { emitLandofileYamlEither } from "@lando/sdk/landofile";
import {
  type ValidationIssue,
  type ValidationIssuePath,
  formatValidationIssuePath,
  validationIssue,
} from "@lando/sdk/schema";
import { Predicate, Result, Schema } from "effect";
import { listAddressedByKey, parsePathSegments, resolveSelector } from "./dot-path";
import { type ValueType, parseTypedValue } from "./value-parse";

export type { ValueType } from "./value-parse";

const pathRemediation =
  'Use dots for bare keys, `[n]` for array indices, and `["key.with.dots"]` for literal keys.';

export const parseConfigPath = (
  key: string,
  file: string,
): Result.Result<ValidationIssuePath, LandofileWriteValidationError> => {
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

/** The selector's segments for this document; a key segment cannot address an existing list. */
export const resolveConfigPath = (
  tree: unknown,
  key: string,
  file: string,
): Result.Result<ValidationIssuePath, LandofileWriteValidationError> => {
  const path = resolveSelector(tree, key);
  if (path === undefined) return parseConfigPath(key, file);
  const position = listAddressedByKey(tree, path);
  if (position === undefined) return Result.succeed(path);
  const list = formatValidationIssuePath(path.slice(0, position));
  return Result.fail(
    new LandofileWriteValidationError({
      message: `\`${list}\` is a list, so \`${key}\` cannot address it by key.`,
      file,
      path: key,
      issues: [validationIssue(path.slice(0, position + 1), "Expected a list index.")],
      remediation: `Address list items by index, for example \`${list}[0]\`.`,
    }),
  );
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

export const writeValidationErrorFromIssues = (input: {
  readonly file: string;
  readonly issues: readonly ValidationIssue[];
  readonly path?: string;
  readonly remediation?: string;
}): LandofileWriteValidationError =>
  new LandofileWriteValidationError({
    message: `The resulting config failed validation for ${input.file}.`,
    file: input.file,
    ...(input.path === undefined ? {} : { path: input.path }),
    issues: input.issues,
    remediation:
      input.remediation ?? "Fix the reported issue(s), then retry the write. The file was left unchanged.",
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
