import { dirname } from "node:path";

import { Effect, Either, Schema } from "effect";

import type {
  AppIdReservedError,
  LandofileIncludeError,
  LandofileLockMismatchError,
  LandofileParseError,
  LandofileSandboxError,
  LandofileTimeoutError,
  LandofileValidationError,
  NotImplementedError,
} from "@lando/sdk/errors";
import { ConfigError, LandofileNotFoundError, LandofileWriteValidationError } from "@lando/sdk/errors";
import { emitLandofileYaml } from "@lando/sdk/landofile";
import { LandofileShape } from "@lando/sdk/schema";
import { LandofileService } from "@lando/sdk/services";

import { writeFileAtomicViaRename } from "../../cache/atomic.ts";
import { findLandofilePath } from "../../landofile/discovery.ts";
import { parseLandofile } from "../../landofile/parser.ts";
import { type EditorRunner, createDefaultEditorRunner } from "../../recipes/prompts/editor-command.ts";
import { loadUserLandofile } from "../app-resolution.ts";
import {
  ConfigWriteResultFields,
  type ValueType,
  applySetMutation,
  applyUnsetMutation,
  decodeIssues,
  writeValidationErrorFromIssues,
} from "../config-write/write-core.ts";

export type AppConfigSubcommand = "view" | "set" | "unset" | "edit" | "validate";

export interface AppConfigOptions {
  readonly subcommand?: AppConfigSubcommand;
  readonly key?: string;
  readonly value?: string;
  readonly type?: ValueType;
  readonly format?: "json" | "table";
  readonly path?: string;
  readonly dryRun?: boolean;
  readonly editor?: string;
  readonly cwd?: string;
  readonly editorRunner?: EditorRunner;
}

export interface AppConfigResult {
  readonly app?: string;
  readonly source?: "resolved";
  readonly landofile?: LandofileShape;
  readonly subcommand?: AppConfigSubcommand;
  readonly key?: string;
  readonly value?: unknown;
  readonly path?: string;
  readonly changed?: boolean;
  readonly dryRun?: boolean;
  readonly valid?: boolean;
  readonly issues?: ReadonlyArray<string>;
  readonly filePath?: string;
}

export const AppConfigResultSchema = Schema.Struct({
  app: Schema.optional(Schema.String),
  source: Schema.optional(Schema.Literal("resolved")),
  landofile: Schema.optional(LandofileShape),
  ...ConfigWriteResultFields,
});

type AppConfigError =
  | AppIdReservedError
  | LandofileNotFoundError
  | LandofileParseError
  | LandofileSandboxError
  | LandofileTimeoutError
  | LandofileValidationError
  | LandofileWriteValidationError
  | LandofileIncludeError
  | LandofileLockMismatchError
  | ConfigError
  | NotImplementedError;

type AppConfigServices = LandofileService;

const decodeLandofile = Schema.decodeUnknownEither(LandofileShape, { onExcessProperty: "error" });

const missingArgsError = (): LandofileWriteValidationError =>
  new LandofileWriteValidationError({
    message: "`app config set` requires a <key.path> and a <value>.",
    file: "",
    issues: ["Missing key path or value."],
    remediation: "Usage: `lando app config set <key.path> <value> [--type string|number|boolean|json|yaml]`.",
  });

const resolveLandofilePath = (
  cwd: string,
): Effect.Effect<{ readonly inputPath: string; readonly appRoot: string }, LandofileNotFoundError> =>
  Effect.gen(function* () {
    const inputPath = yield* Effect.promise(() => findLandofilePath(cwd));
    if (inputPath === undefined) {
      return yield* Effect.fail(
        new LandofileNotFoundError({
          message: "No Landofile is in scope for this command.",
          cwd,
        }),
      );
    }
    return { inputPath, appRoot: dirname(inputPath) };
  });

const readLandofileText = (inputPath: string): Effect.Effect<string, ConfigError> =>
  Effect.tryPromise({
    try: () => Bun.file(inputPath).text(),
    catch: (cause) => new ConfigError({ message: `Failed to read ${inputPath}`, path: inputPath, cause }),
  });

const writeLandofileText = (inputPath: string, content: string): Effect.Effect<void, ConfigError> =>
  Effect.tryPromise({
    try: () => writeFileAtomicViaRename(inputPath, content),
    catch: (cause) => new ConfigError({ message: `Failed to write ${inputPath}`, path: inputPath, cause }),
  });

const parseWriteValidationError = (
  inputPath: string,
  error: LandofileParseError,
): LandofileWriteValidationError =>
  new LandofileWriteValidationError({
    message: error.message,
    file: inputPath,
    issues: [error.message],
    remediation: "Fix the YAML syntax so the file parses, then retry. The file was left unchanged.",
  });

const appConfigSet = (options: AppConfigOptions): Effect.Effect<AppConfigResult, AppConfigError, never> =>
  Effect.gen(function* () {
    const key = options.key;
    const raw = options.value;
    if (key === undefined || raw === undefined) return yield* Effect.fail(missingArgsError());
    const { inputPath, appRoot } = yield* resolveLandofilePath(options.cwd ?? process.cwd());
    const content = yield* readLandofileText(inputPath);
    const tree = (yield* parseLandofile({ file: inputPath, content, cwd: appRoot })) as Record<
      string,
      unknown
    >;
    const mutation = applySetMutation({ tree, key, raw, type: options.type ?? "string", file: inputPath });
    if (Either.isLeft(mutation)) return yield* Effect.fail(mutation.left);
    const next = mutation.right.next;
    const issues = decodeIssues(decodeLandofile(next));
    if (issues.length > 0) {
      return yield* Effect.fail(writeValidationErrorFromIssues({ file: inputPath, issues, path: key }));
    }
    const dryRun = options.dryRun === true;
    if (!dryRun) yield* writeLandofileText(inputPath, emitLandofileYaml(next as Record<string, unknown>));
    return {
      subcommand: "set",
      key,
      value: mutation.right.value,
      filePath: inputPath,
      changed: true,
      dryRun,
    };
  });

const appConfigUnset = (options: AppConfigOptions): Effect.Effect<AppConfigResult, AppConfigError, never> =>
  Effect.gen(function* () {
    const key = options.key;
    if (key === undefined) {
      return yield* Effect.fail(
        new LandofileWriteValidationError({
          message: "`app config unset` requires a <key.path>.",
          file: "",
          issues: ["Missing key path."],
          remediation: "Usage: `lando app config unset <key.path>`.",
        }),
      );
    }
    const { inputPath, appRoot } = yield* resolveLandofilePath(options.cwd ?? process.cwd());
    const content = yield* readLandofileText(inputPath);
    const tree = (yield* parseLandofile({ file: inputPath, content, cwd: appRoot })) as Record<
      string,
      unknown
    >;
    const mutation = applyUnsetMutation({ tree, key, file: inputPath });
    if (Either.isLeft(mutation)) return yield* Effect.fail(mutation.left);
    const next = mutation.right.next;
    const issues = decodeIssues(decodeLandofile(next));
    if (issues.length > 0) {
      return yield* Effect.fail(writeValidationErrorFromIssues({ file: inputPath, issues, path: key }));
    }
    const dryRun = options.dryRun === true;
    if (!dryRun && mutation.right.changed) {
      yield* writeLandofileText(inputPath, emitLandofileYaml(next as Record<string, unknown>));
    }
    return { subcommand: "unset", key, filePath: inputPath, changed: mutation.right.changed, dryRun };
  });

const appConfigValidate = (
  options: AppConfigOptions,
): Effect.Effect<AppConfigResult, AppConfigError, never> =>
  Effect.gen(function* () {
    const { inputPath, appRoot } = yield* resolveLandofilePath(options.cwd ?? process.cwd());
    const content = yield* readLandofileText(inputPath);
    const tree = yield* parseLandofile({ file: inputPath, content, cwd: appRoot });
    const issues = decodeIssues(decodeLandofile(tree));
    if (issues.length > 0) {
      return yield* Effect.fail(writeValidationErrorFromIssues({ file: inputPath, issues }));
    }
    return { subcommand: "validate", filePath: inputPath, valid: true, issues: [] };
  });

const appConfigEdit = (options: AppConfigOptions): Effect.Effect<AppConfigResult, AppConfigError, never> =>
  Effect.gen(function* () {
    const { inputPath, appRoot } = yield* resolveLandofilePath(options.cwd ?? process.cwd());
    const content = yield* readLandofileText(inputPath);
    const runner =
      options.editorRunner ??
      createDefaultEditorRunner(
        options.editor === undefined
          ? {}
          : { env: { ...process.env, EDITOR: options.editor, VISUAL: options.editor } },
      );
    const edited = yield* Effect.promise(() => runner({ name: "lando-config", content, cwd: appRoot }));
    if (edited.kind === "no-editor") {
      return yield* Effect.fail(
        new LandofileWriteValidationError({
          message: "No editor is configured.",
          file: inputPath,
          issues: ["Neither $VISUAL nor $EDITOR is set."],
          remediation: "Set `$VISUAL` or `$EDITOR`, or pass `--editor <bin>`.",
        }),
      );
    }
    if (edited.kind === "failed") {
      return yield* Effect.fail(
        new LandofileWriteValidationError({
          message: `The editor session failed: ${edited.reason}`,
          file: inputPath,
          issues: [edited.reason],
          remediation:
            "Re-run `lando app config edit` after resolving the editor error. The file was left unchanged.",
        }),
      );
    }
    const parsed = yield* parseLandofile({ file: inputPath, content: edited.content, cwd: appRoot }).pipe(
      Effect.catchTag("LandofileParseError", (error) =>
        Effect.fail(parseWriteValidationError(inputPath, error)),
      ),
    );
    const issues = decodeIssues(decodeLandofile(parsed));
    if (issues.length > 0) {
      return yield* Effect.fail(writeValidationErrorFromIssues({ file: inputPath, issues }));
    }
    yield* writeLandofileText(inputPath, edited.content);
    return { subcommand: "edit", filePath: inputPath, changed: true, valid: true };
  });

const tableRender = (result: AppConfigResult): string => {
  const lines: string[] = [`app\t${result.app ?? ""}`];
  const services = Object.keys(result.landofile?.services ?? {});
  if (services.length === 0) lines.push("services\t(none)");
  else lines.push(`services\t${services.join(", ")}`);
  if (result.landofile?.recipe !== undefined) lines.push(`recipe\t${result.landofile.recipe}`);
  return lines.join("\n");
};

const writeRender = (result: AppConfigResult): string => {
  const file = result.filePath ?? "";
  switch (result.subcommand) {
    case "set":
      return result.dryRun === true
        ? `${file}: would set ${result.key} (dry run).`
        : `${file}: set ${result.key}.`;
    case "unset":
      if (result.changed !== true) return `${file}: ${result.key} was not present (no change).`;
      return result.dryRun === true
        ? `${file}: would unset ${result.key} (dry run).`
        : `${file}: unset ${result.key}.`;
    case "edit":
      return `${file}: saved edited Landofile.`;
    case "validate":
      return `${file}: valid.`;
    default:
      return tableRender(result);
  }
};

export const renderAppConfigResult = (
  result: AppConfigResult,
  _format: "json" | "table" = "table",
): string => {
  if (result.subcommand !== undefined && result.subcommand !== "view") return writeRender(result);
  return tableRender(result);
};

export const appConfig = (
  options: AppConfigOptions = {},
): Effect.Effect<AppConfigResult, AppConfigError, AppConfigServices> =>
  Effect.gen(function* () {
    const subcommand = options.subcommand ?? "view";
    if (subcommand === "set") return yield* appConfigSet(options);
    if (subcommand === "unset") return yield* appConfigUnset(options);
    if (subcommand === "edit") return yield* appConfigEdit(options);
    if (subcommand === "validate") return yield* appConfigValidate(options);

    const landofileService = yield* LandofileService;
    const landofile = yield* loadUserLandofile(landofileService);
    return {
      app: landofile.name ?? "",
      source: "resolved",
      landofile,
    };
  });
