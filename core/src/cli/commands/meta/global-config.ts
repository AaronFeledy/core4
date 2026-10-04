import { dirname } from "node:path";

import { Effect, Result, Schema } from "effect";

import type { GlobalAppError, LandofileParseError, LandofileValidationError } from "@lando/sdk/errors";
import { ConfigError, LandofileWriteValidationError } from "@lando/sdk/errors";
import { LandofileShape, type LandofileShape as LandofileShapeType } from "@lando/sdk/schema";
import { FileSystem, type FileSystemError, type GlobalAppPaths, GlobalAppService } from "@lando/sdk/services";

import { writeFileAtomicViaRename } from "@lando/engine/cache/atomic";
import {
  type ValueType,
  applySetMutation,
  applyUnsetMutation,
  decodeIssues,
  emitConfigYaml,
  writeValidationErrorFromIssues,
} from "@lando/engine/config-write/write-core";
import { decodeGlobalLandofile } from "@lando/engine/operations/global-plan";
import { parseLandofile } from "@lando/landofile/parser";
import { validationIssue } from "@lando/sdk/schema";
import { type EditorRunner, createDefaultEditorRunner } from "../../../recipes/prompts/editor-command";

export type GlobalConfigSubcommand = "view" | "set" | "unset" | "edit" | "validate";

export interface GlobalConfigOptions {
  readonly subcommand?: GlobalConfigSubcommand;
  readonly key?: string;
  readonly value?: string;
  readonly type?: ValueType;
  readonly format?: "json" | "table";
  readonly path?: string;
  readonly dryRun?: boolean;
  readonly editor?: string;
  readonly userLandofilePath?: string;
  readonly editorRunner?: EditorRunner;
}

export interface GlobalConfigResult {
  readonly app?: string;
  readonly source?: "global";
  readonly materialized?: boolean;
  readonly distLandofile?: string;
  readonly userLandofile?: string;
  readonly paths?: GlobalAppPaths;
  readonly landofile?: LandofileShapeType;
  readonly subcommand?: GlobalConfigSubcommand;
  readonly key?: string;
  readonly value?: unknown;
  readonly changed?: boolean;
  readonly dryRun?: boolean;
  readonly valid?: boolean;
  readonly issues?: ReadonlyArray<string>;
  readonly filePath?: string;
}

export const GlobalAppPathsSchema = Schema.Struct({
  root: Schema.String,
  distLandofile: Schema.String,
  userLandofile: Schema.String,
});

export const GlobalConfigResultSchema = Schema.Struct({
  app: Schema.optionalKey(Schema.String),
  source: Schema.optionalKey(Schema.Literal("global")),
  materialized: Schema.optionalKey(Schema.Boolean),
  distLandofile: Schema.optionalKey(Schema.String),
  userLandofile: Schema.optionalKey(Schema.String),
  paths: Schema.optionalKey(GlobalAppPathsSchema),
  landofile: Schema.optionalKey(LandofileShape),
  subcommand: Schema.optionalKey(Schema.Literals(["view", "set", "unset", "edit", "validate"])),
  key: Schema.optionalKey(Schema.String),
  value: Schema.optionalKey(Schema.Unknown),
  changed: Schema.optionalKey(Schema.Boolean),
  dryRun: Schema.optionalKey(Schema.Boolean),
  valid: Schema.optionalKey(Schema.Boolean),
  issues: Schema.optionalKey(Schema.Array(Schema.String)),
  filePath: Schema.optionalKey(Schema.String),
});

type GlobalConfigReadError =
  | GlobalAppError
  | FileSystemError
  | LandofileParseError
  | LandofileValidationError;
type GlobalConfigWriteError = ConfigError | LandofileParseError | LandofileWriteValidationError;

type GlobalConfigServices = FileSystem | GlobalAppService;

const emptyGlobalLandofile: LandofileShapeType = { name: "global", runtime: 4, services: {} };

const decodeLandofile = Schema.decodeUnknownResult(LandofileShape, {
  onExcessProperty: "error",
  errors: "all",
});

const readGlobalText = (filePath: string): Effect.Effect<string, ConfigError> =>
  Effect.tryPromise({
    try: async () => ((await Bun.file(filePath).exists()) ? Bun.file(filePath).text() : ""),
    catch: (cause) => new ConfigError({ message: `Failed to read ${filePath}`, path: filePath, cause }),
  });

const writeGlobalText = (filePath: string, content: string): Effect.Effect<void, ConfigError> =>
  Effect.tryPromise({
    try: () => writeFileAtomicViaRename(filePath, content),
    catch: (cause) => new ConfigError({ message: `Failed to write ${filePath}`, path: filePath, cause }),
  });

const readGlobalTree = Effect.fnUntraced(function* (
  filePath: string,
): Effect.fn.Return<Record<string, unknown>, GlobalConfigWriteError> {
  const content = yield* readGlobalText(filePath);
  if (content.trim() === "") return { name: "global", runtime: 4 } as Record<string, unknown>;
  return (yield* parseLandofile({ file: filePath, content, cwd: filePath })) as Record<string, unknown>;
});

export const globalConfigSet = Effect.fn("GlobalConfig.set")(function* (
  options: GlobalConfigOptions,
  filePath: string,
): Effect.fn.Return<GlobalConfigResult, GlobalConfigWriteError, never> {
  const key = options.key ?? options.path;
  const raw = options.value;
  if (key === undefined || raw === undefined) {
    return yield* Effect.fail(
      new LandofileWriteValidationError({
        message: "`meta global config set` requires a <key.path> and a <value>.",
        file: filePath,
        issues: [validationIssue([], "Missing key path or value.")],
        remediation: "Usage: `lando meta global config set <key.path> <value> [--type ...]`.",
      }),
    );
  }
  const tree = yield* readGlobalTree(filePath);
  const mutation = applySetMutation({ tree, key, raw, type: options.type ?? "string", file: filePath });
  if (Result.isFailure(mutation)) return yield* Effect.fail(mutation.failure);
  const next = mutation.success.next;
  const issues = decodeIssues(decodeLandofile(next));
  if (issues.length > 0) {
    return yield* Effect.fail(writeValidationErrorFromIssues({ file: filePath, issues, path: key }));
  }
  const dryRun = options.dryRun === true;
  if (!dryRun) {
    const emitted = emitConfigYaml({ file: filePath, value: next, path: key });
    if (Result.isFailure(emitted)) return yield* Effect.fail(emitted.failure);
    yield* writeGlobalText(filePath, emitted.success);
  }
  return { subcommand: "set", key, value: mutation.success.value, changed: true, dryRun, filePath };
});

export const globalConfigUnset = Effect.fn("GlobalConfig.unset")(function* (
  options: GlobalConfigOptions,
  filePath: string,
): Effect.fn.Return<GlobalConfigResult, GlobalConfigWriteError, never> {
  const key = options.key ?? options.path;
  if (key === undefined) {
    return yield* Effect.fail(
      new LandofileWriteValidationError({
        message: "`meta global config unset` requires a <key.path>.",
        file: filePath,
        issues: [validationIssue([], "Missing key path.")],
        remediation: "Usage: `lando meta global config unset <key.path>`.",
      }),
    );
  }
  const tree = yield* readGlobalTree(filePath);
  const mutation = applyUnsetMutation({ tree, key, file: filePath });
  if (Result.isFailure(mutation)) return yield* Effect.fail(mutation.failure);
  const next = mutation.success.next;
  const issues = decodeIssues(decodeLandofile(next));
  if (issues.length > 0) {
    return yield* Effect.fail(writeValidationErrorFromIssues({ file: filePath, issues, path: key }));
  }
  const dryRun = options.dryRun === true;
  if (!dryRun && mutation.success.changed) {
    const emitted = emitConfigYaml({ file: filePath, value: next, path: key });
    if (Result.isFailure(emitted)) return yield* Effect.fail(emitted.failure);
    yield* writeGlobalText(filePath, emitted.success);
  }
  return { subcommand: "unset", key, changed: mutation.success.changed, dryRun, filePath };
});

export const globalConfigValidate = Effect.fn("GlobalConfig.validate")(function* (
  filePath: string,
): Effect.fn.Return<GlobalConfigResult, GlobalConfigWriteError, never> {
  const tree = yield* readGlobalTree(filePath);
  const issues = decodeIssues(decodeLandofile(tree));
  if (issues.length > 0)
    return yield* Effect.fail(writeValidationErrorFromIssues({ file: filePath, issues }));
  return { subcommand: "validate", valid: true, issues: [], filePath };
});

export const globalConfigEdit = Effect.fn("GlobalConfig.edit")(function* (
  options: GlobalConfigOptions,
  filePath: string,
): Effect.fn.Return<GlobalConfigResult, GlobalConfigWriteError, never> {
  const content = yield* readGlobalText(filePath);
  const seeded = content.trim() === "" ? "name: global\nruntime: 4\n" : content;
  const runner =
    options.editorRunner ??
    createDefaultEditorRunner(
      options.editor === undefined
        ? {}
        : { env: { ...process.env, EDITOR: options.editor, VISUAL: options.editor } },
    );
  const edited = yield* Effect.promise(() =>
    runner({ name: "lando-global-config", content: seeded, cwd: dirname(filePath) }),
  );
  if (edited.kind === "no-editor") {
    return yield* Effect.fail(
      new LandofileWriteValidationError({
        message: "No editor is configured.",
        file: filePath,
        issues: [validationIssue([], "Neither $VISUAL nor $EDITOR is set.")],
        remediation: "Set `$VISUAL` or `$EDITOR`, or pass `--editor <bin>`.",
      }),
    );
  }
  if (edited.kind === "failed") {
    return yield* Effect.fail(
      new LandofileWriteValidationError({
        message: `The editor session failed: ${edited.reason}`,
        file: filePath,
        issues: [validationIssue([], edited.reason)],
        remediation: "Re-run `lando meta global config edit` after resolving the editor error.",
      }),
    );
  }
  const parsed = yield* parseLandofile({ file: filePath, content: edited.content, cwd: filePath }).pipe(
    Effect.catchTag("LandofileParseError", (error) =>
      Effect.fail(
        new LandofileWriteValidationError({
          message: error.message,
          file: filePath,
          issues: [validationIssue([], error.message)],
          remediation: "Fix the YAML syntax so the file parses, then retry. The file was left unchanged.",
        }),
      ),
    ),
  );
  const issues = decodeIssues(decodeLandofile(parsed));
  if (issues.length > 0)
    return yield* Effect.fail(writeValidationErrorFromIssues({ file: filePath, issues }));
  yield* writeGlobalText(filePath, edited.content);
  return { subcommand: "edit", changed: true, valid: true, filePath };
});

export const renderGlobalConfigResult = (
  result: GlobalConfigResult,
  _format: "json" | "table" = "table",
): string => {
  void _format;
  switch (result.subcommand) {
    case "set":
      return result.dryRun === true
        ? `${result.filePath ?? ""}: would set ${result.key} (dry run).`
        : `${result.filePath ?? ""}: set ${result.key}.`;
    case "unset":
      if (result.changed !== true)
        return `${result.filePath ?? ""}: ${result.key} was not present (no change).`;
      return result.dryRun === true
        ? `${result.filePath ?? ""}: would unset ${result.key} (dry run).`
        : `${result.filePath ?? ""}: unset ${result.key}.`;
    case "edit":
      return `${result.filePath ?? ""}: saved edited global-app Landofile.`;
    case "validate":
      return `${result.filePath ?? ""}: valid.`;
    default: {
      const services = Object.keys(result.landofile?.services ?? {});
      return [
        `app\t${result.app ?? ""}`,
        `source\t${result.materialized === true ? "generated" : "not installed"}`,
        `dist\t${result.distLandofile ?? ""}`,
        `overlay\t${result.userLandofile ?? ""}`,
        `services\t${services.length === 0 ? "(none)" : services.join(", ")}`,
      ].join("\n");
    }
  }
};

const globalConfigView = Effect.fnUntraced(function* (): Effect.fn.Return<
  GlobalConfigResult,
  GlobalConfigReadError,
  GlobalConfigServices
> {
  const globalApp = yield* GlobalAppService;
  const fileSystem = yield* FileSystem;
  const paths = yield* globalApp.paths;
  const exists = yield* fileSystem.exists(paths.distLandofile);
  const landofile = exists
    ? yield* fileSystem
        .readText(paths.distLandofile)
        .pipe(
          Effect.flatMap((content) =>
            decodeGlobalLandofile({ file: paths.distLandofile, content, cwd: paths.root }),
          ),
        )
    : emptyGlobalLandofile;

  return {
    app: landofile.name ?? "global",
    source: "global",
    materialized: exists,
    distLandofile: paths.distLandofile,
    userLandofile: paths.userLandofile,
    paths,
    landofile,
  };
});

export const globalConfig = Effect.fn("GlobalConfig.run")(function* (
  options: GlobalConfigOptions = {},
): Effect.fn.Return<
  GlobalConfigResult,
  GlobalConfigReadError | GlobalConfigWriteError,
  GlobalConfigServices
> {
  const subcommand = options.subcommand ?? "view";
  if (subcommand === "view") return yield* globalConfigView();
  let filePath = options.userLandofilePath;
  if (filePath === undefined) {
    const globalApp = yield* GlobalAppService;
    const paths = yield* globalApp.paths;
    filePath = paths.userLandofile;
  }
  if (subcommand === "set") return yield* globalConfigSet(options, filePath);
  if (subcommand === "unset") return yield* globalConfigUnset(options, filePath);
  if (subcommand === "edit") return yield* globalConfigEdit(options, filePath);
  if (subcommand === "validate") return yield* globalConfigValidate(filePath);
  return yield* Effect.fail(
    new LandofileWriteValidationError({
      message: `Unknown \`meta global config\` subcommand: "${subcommand}".`,
      file: filePath,
      issues: [validationIssue([], `Unsupported subcommand: "${subcommand}".`)],
      remediation: "Usage: `lando meta global config [view|set|unset|edit|validate]`.",
    }),
  );
});
