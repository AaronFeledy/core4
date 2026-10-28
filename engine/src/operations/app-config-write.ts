import { parseLandofile } from "@lando/landofile/parser";
import { LandofileWriteValidationError } from "@lando/sdk/errors";
import { encodeLandofileSourceValue } from "@lando/sdk/landofile";
import { LandofileSourceValue, type ValidationIssue, validationIssue } from "@lando/sdk/schema";
import { Effect, Predicate, Result, Schema } from "effect";
import {
  readAppConfigFile,
  readMutableAppConfigFile,
  resolveAppConfigFile,
  writeAppConfigFile,
} from "../config-write/app-config-file.ts";
import type { EditorRunner } from "../config-write/editor.ts";
import { assertConfigReadable } from "../config-write/readiness.ts";
import { runEditVerb, runSetVerb, runUnsetVerb } from "../config-write/verbs.ts";
import {
  type ValueType,
  emitConfigYaml,
  writeValidationErrorFromIssues,
} from "../config-write/write-core.ts";
import { loadLandofileLayers, validateLandofileReplacement } from "../services/landofile-live.ts";

export interface AppConfigWriteOptions {
  readonly key?: string;
  readonly path?: string;
  readonly value?: string;
  readonly type?: ValueType;
  readonly dryRun?: boolean;
  readonly cwd?: string;
  readonly editorRunner?: EditorRunner;
}

const missingKey = (verb: string) =>
  new LandofileWriteValidationError({
    message: `\`app config ${verb}\` requires a <key.path>${verb === "set" ? " and a <value>" : ""}.`,
    file: "",
    issues: [validationIssue([], "Missing key path or value.")],
    remediation: `Usage: \`lando app config ${verb} <key.path>${verb === "set" ? " <value>" : ""}\`.`,
  });

const mutationIo = Effect.fnUntraced(function* (
  options: AppConfigWriteOptions,
  verb: "set" | "unset" | "edit",
) {
  const { appRoot, inputPath } = yield* resolveAppConfigFile(options.cwd, verb);
  const validateText = (content: string) =>
    validateLandofileReplacement({ appRoot, targetFile: inputPath, content }).pipe(
      Effect.map((): Result.Result<undefined, readonly ValidationIssue[]> => Result.succeed(undefined)),
      Effect.catchTag("LandofileWriteValidationError", (error) => Effect.succeed(Result.fail(error.issues))),
    );
  return {
    appRoot,
    file: inputPath,
    dryRun: options.dryRun === true,
    readText: assertConfigReadable(appRoot).pipe(
      Effect.andThen(
        verb === "edit" ? readAppConfigFile(inputPath) : readMutableAppConfigFile(inputPath, verb),
      ),
    ),
    editCommand: "lando app:config edit",
    parse: (content: string) =>
      parseLandofile({ file: inputPath, content, cwd: appRoot }).pipe(
        Effect.flatMap((value) =>
          Predicate.isObject(value) && !Array.isArray(value)
            ? Effect.succeed(value)
            : Effect.fail(
                writeValidationErrorFromIssues({
                  file: inputPath,
                  issues: [validationIssue([], "Expected a Landofile mapping.")],
                }),
              ),
        ),
      ),
    // A rejected candidate is a validation result; discovery, I/O, and sibling-layer
    // parse failures stay fatal so inference never mistakes them for a wrong type.
    decode: (next: unknown) =>
      Effect.fromResult(emitConfigYaml({ file: inputPath, value: next })).pipe(Effect.flatMap(validateText)),
    validateText,
    writeText: writeAppConfigFile,
  };
});

export const appConfigSet = Effect.fn("AppConfig.set")(function* (options: AppConfigWriteOptions) {
  const key = options.key ?? options.path;
  if (key === undefined || options.value === undefined) return yield* Effect.fail(missingKey("set"));
  const io = yield* mutationIo(options, "set");
  const outcome = yield* runSetVerb({ ...io, key, raw: options.value, type: options.type });
  const value = yield* Schema.decodeUnknownEffect(LandofileSourceValue)(
    encodeLandofileSourceValue(outcome.value),
  ).pipe(Effect.orDie);
  return {
    subcommand: "set" as const,
    key,
    value,
    filePath: io.file,
    changed: outcome.changed,
    dryRun: outcome.dryRun,
  };
});

export const appConfigUnset = Effect.fn("AppConfig.unset")(function* (options: AppConfigWriteOptions) {
  const key = options.key ?? options.path;
  if (key === undefined) return yield* Effect.fail(missingKey("unset"));
  const io = yield* mutationIo(options, "unset");
  const outcome = yield* runUnsetVerb({ ...io, key });
  return {
    subcommand: "unset" as const,
    key,
    filePath: io.file,
    changed: outcome.changed,
    dryRun: outcome.dryRun,
  };
});

export const appConfigValidate = Effect.fn("AppConfig.validate")(function* (options: AppConfigWriteOptions) {
  const { appRoot, inputPath } = yield* resolveAppConfigFile(options.cwd, "validate");
  yield* loadLandofileLayers(appRoot, inputPath).pipe(
    Effect.catchTag("LandofileValidationError", (error) =>
      Effect.fail(writeValidationErrorFromIssues({ file: error.file, issues: error.issues })),
    ),
  );
  return { subcommand: "validate" as const, filePath: inputPath, valid: true as const, issues: [] };
});

export const appConfigEdit = Effect.fn("AppConfig.edit")(function* (options: AppConfigWriteOptions) {
  const io = yield* mutationIo(options, "edit");
  const runner = options.editorRunner;
  const outcome = yield* runEditVerb({
    ...io,
    openEditor:
      runner === undefined
        ? undefined
        : (content) => Effect.promise(() => runner({ name: "lando-config", content, cwd: io.appRoot })),
  });
  return { subcommand: "edit" as const, filePath: io.file, ...outcome };
});
